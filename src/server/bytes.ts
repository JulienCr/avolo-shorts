import { open, type FileHandle } from 'node:fs/promises'
import { ByteLengthQueuingStrategy, ReadableStream as NodeReadableStream } from 'node:stream/web'

import { parseRange, type ByteRange } from '@/core/range'

/**
 * Servir un fichier du disque en **requêtes partielles**.
 *
 * Les artefacts vivent dans `PROJECTS_DIR`, hors de `public/` : Next ne les sert
 * pas tout seul, et il n'en est pas question — un dossier de données n'a pas à
 * devenir un dossier public. Chaque route qui en publie un doit donc pousser les
 * octets elle-même, et c'est toujours la même mécanique.
 *
 * **Sans réponse aux requêtes partielles, la barre de lecture d'un `<video>` ne
 * fonctionne pas** : faute de pouvoir demander un morceau au milieu, le
 * navigateur ne peut pas sauter. C'est vrai du proxy, sur lequel l'éditeur scrube
 * en permanence, et tout autant d'un rendu de trente secondes qu'on relit trois
 * fois avant de le publier.
 *
 * L'analyse de l'en-tête est ailleurs, dans `@/core/range` : c'est du calcul, et
 * c'est là que sont les bugs. Ici il ne reste que ce qui touche au disque.
 */

/**
 * Les codes d'erreur d'ouverture qui veulent dire « il n'y a pas de fichier
 * ici ».
 *
 * `ENOENT` est le cas normal : tant que l'étape n'a pas tourné, le fichier
 * n'existe pas. `ENOTDIR` et `ENAMETOOLONG` disent la même chose sous une autre
 * forme. `EISDIR` couvre les plateformes qui refusent d'ouvrir un dossier —
 * Linux l'accepte, d'où le contrôle `isFile()` plus bas, mais toutes ne le font
 * pas.
 *
 * **Tout le reste est un vrai problème de serveur** et doit remonter : droits
 * refusés, montage mort, disque en vrac. Les déguiser en absence ferait chercher
 * le bug du côté de l'artefact manquant, là où il n'y a rien à trouver.
 */
export const ABSENCE = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'EISDIR'])

export function isAAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code !== undefined && ABSENCE.has(code)
}

/**
 * Un flux de fichier, éventuellement borné, en `ReadableStream` du web.
 *
 * Le pont n'est pas décoratif : un `ReadStream` de Node n'est pas un
 * `ReadableStream`, et la `Response` que Next attend ne connaît que le second.
 * Il doit garder les deux propriétés qui comptent : la contre-pression, sans
 * laquelle un fichier d'un gigaoctet serait tiré en mémoire aussi vite que le
 * disque le rend, et l'annulation — un spectateur qui saute abandonne la requête
 * en cours, et le flux doit se fermer avec elle plutôt que de continuer à lire
 * dans le vide. Le flux part du `FileHandle` déjà ouvert et le referme en se
 * terminant.
 *
 * **Surtout pas `Readable.toWeb`**, qui tenait ce rôle jusqu'à l'issue #75. La
 * cause a été relevée dans une pile, pas déduite : `toWeb` pose un écouteur
 * `'data'` sur le flux Node et **ne le retire jamais**. Son annulation se
 * contente de détruire le flux ; la reprise déjà programmée avant l'abandon
 * s'exécute quand même, vide le tampon accumulé dans un contrôleur désormais
 * fermé, et le premier `enqueue` lève `ERR_INVALID_STATE: Controller is already
 * closed`. La levée sort d'un `emit('data')`, c'est-à-dire d'un endroit qui n'a
 * plus de requête où remonter : c'est une `uncaughtException`.
 *
 * La condition n'a rien d'exotique, c'est celle d'un lecteur vidéo : il faut que
 * le consommateur ait cessé de tirer assez longtemps pour que le flux se mette
 * en pause avec des octets en réserve — ce qui arrive dès que la socket ne draine
 * plus — puis qu'il abandonne. Un abandon dès les en-têtes ou en pleine lecture
 * ne la remplit pas, et c'est pourquoi le défaut se voyait à chaque chargement de
 * l'écran de clip sans jamais se voir sous un `curl`.
 *
 * Le pont passe donc par **l'itérateur asynchrone** du flux, qui ne rend un
 * morceau que quand on lui en demande un : rien ne pousse, donc rien ne peut
 * pousser trop tard. L'annulation appelle `return()` sur l'itérateur, ce qui
 * détruit le flux **et referme le descripteur**. Et si l'annulation tombe
 * pendant un `next()`, l'`enqueue` qui suit lève dans la promesse de `pull`, où
 * la mécanique du `ReadableStream` la recueille — pas dans un `emit`.
 *
 * `ReadableStream.from` ferait presque cela, en une ligne, mais impose une
 * réserve nulle : voir la stratégie plus bas, qui est la raison de l'écrire à la
 * main.
 *
 * L'import vient de `node:stream/web` et non du global : le `lib: ["dom"]` du
 * projet déclare un `ReadableStream` dont le constructeur n'accepte pas ce que
 * Node accepte. Le `as` qui suit est un raccommodage de types, pas un changement
 * de valeur — c'est le même objet au runtime.
 */
function streamWeb(file: FileHandle, range?: ByteRange): ReadableStream<Uint8Array> {
  const stream = file.createReadStream(range && { start: range.start, end: range.end })
  const source = stream[Symbol.asyncIterator]()
  return new NodeReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await source.next()
        if (done === true) controller.close()
        else controller.enqueue(value)
      },
      async cancel() {
        await source.return?.()
      },
    },
    // La même réserve que le flux Node, et pas zéro : c'est ce que `toWeb`
    // faisait, et ça décide d'une chose qui ne se voit pas ici. Une réserve non
    // nulle fait tirer un premier morceau dès la construction, donc **un fichier
    // plus petit que le tampon se lit et se referme même si personne ne lit le
    // corps** — le cas d'un `.txt` de publication qu'une route interroge pour
    // son seul statut. À zéro, rien ne se passe tant qu'on ne tire pas, et le
    // descripteur attend le ramasse-miettes.
    new ByteLengthQueuingStrategy({ highWaterMark: stream.readableHighWaterMark }),
  ) as unknown as ReadableStream<Uint8Array>
}

/**
 * Les validateurs HTTP (`ETag`, `Last-Modified`) dérivés du `stat` du handle
 * ouvert — jamais d'un `stat` séparé : voir le commentaire sur « ouvrir
 * d'abord, décrire ensuite » plus bas, qui vaut ici aussi et pour la même
 * raison. `info.mtimeMs` existait déjà à cet endroit, simplement inutilisé.
 *
 * L'`ETag` combine la taille et l'horodatage : un ré-export qui change l'un ou
 * l'autre change l'étiquette, ce qui est le but — un scrub en cours ne doit
 * jamais laisser croire qu'un octet appartient encore à l'ancienne version du
 * fichier. C'est un validateur **fort** (pas de préfixe `W/`) : les requêtes
 * partielles ne peuvent s'appuyer que sur un validateur fort, et `If-Range`
 * plus bas en a besoin pour décider d'honorer une plage (RFC 7233 §3.2).
 */
function computeValidators(size: number, mtimeMs: number): { etag: string; lastModified: string } {
  const truncatedMtimeMs = Math.trunc(mtimeMs)
  return {
    etag: `"${size.toString(16)}-${truncatedMtimeMs.toString(16)}"`,
    lastModified: new Date(truncatedMtimeMs).toUTCString(),
  }
}

/** Une étiquette sans son préfixe `W/`, pour une comparaison faible. */
function stripWeakPrefix(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag
}

/** `If-None-Match` accepte `*`, une étiquette seule, ou une liste séparée par des virgules. */
function ifNoneMatchSatisfied(header: string, etag: string): boolean {
  if (header.trim() === '*') return true
  return header
    .split(',')
    .map((tag) => tag.trim())
    .some((tag) => stripWeakPrefix(tag) === etag)
}

/** `Last-Modified` n'a qu'une résolution à la seconde : comparer à la même échelle. */
function ifModifiedSinceSatisfied(header: string, mtimeMs: number): boolean {
  const since = Date.parse(header)
  if (Number.isNaN(since)) return false
  return Math.floor(mtimeMs / 1000) * 1000 <= since
}

/**
 * `true` quand la requête peut se contenter d'un 304, `Range` ou pas.
 *
 * `If-None-Match` prime sur `If-Modified-Since` quand les deux sont présents
 * (RFC 7232 §3.3) : un client qui envoie les deux a un `ETag` en cache, plus
 * précis qu'une date à la seconde, et c'est lui qui doit trancher.
 *
 * **Ce contrôle passe avant toute décision sur `Range`** (RFC 9110 §13.2.2) :
 * un GET conditionnel qui matche répond 304 même si la requête porte une
 * plage — `If-Range` ne le remplace pas, il ne joue que quand ce contrôle-ci
 * a déjà laissé passer.
 */
function notModified(request: Request, etag: string, mtimeMs: number): boolean {
  const ifNoneMatch = request.headers.get('if-none-match')
  if (ifNoneMatch !== null) return ifNoneMatchSatisfied(ifNoneMatch, etag)
  const ifModifiedSince = request.headers.get('if-modified-since')
  if (ifModifiedSince !== null) return ifModifiedSinceSatisfied(ifModifiedSince, mtimeMs)
  return false
}

/**
 * `true` quand `If-Range` autorise à servir la plage demandée plutôt que le
 * fichier entier.
 *
 * Une étiquette faible (`W/"..."`) échoue toujours : seule une comparaison
 * forte est valide pour une plage (RFC 7233 §3.2). Une date se compare à la
 * seconde près, la résolution de `Last-Modified` — ni avant, ni après.
 */
function ifRangeSatisfied(header: string, etag: string, mtimeMs: number): boolean {
  const trimmed = header.trim()
  if (trimmed.startsWith('W/')) return false
  if (trimmed.startsWith('"')) return trimmed === etag
  const since = Date.parse(trimmed)
  if (Number.isNaN(since)) return false
  return Math.floor(mtimeMs / 1000) * 1000 === since
}

/**
 * La réponse qui porte `path`, ou **`null` quand le fichier n'est pas là**.
 *
 * `null` plutôt qu'un 404 tout fait : l'absence se raconte différemment selon la
 * route — « pas encore de proxy », « ce clip n'a pas encore été exporté » — et
 * seul l'appelant sait laquelle. Il n'y a que le 416 qui soit décidé ici, parce
 * qu'il porte la taille réelle du fichier, que l'appelant n'a pas.
 *
 * `headers` passe le `Content-Type` et ce que la route veut y ajouter ;
 * `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag` et `Last-Modified`
 * sont posés ici, puisqu'ils décrivent les octets et non la ressource.
 *
 * **Le partage des rôles, et pourquoi il ne peut pas être autrement.** Cette
 * fonction possède les validateurs et tout le traitement conditionnel
 * (`If-None-Match`, `If-Modified-Since`, `If-Range`) : ils se calculent à
 * partir du `stat` du handle ouvert, qui ne peut vivre qu'ici (même raison que
 * le commentaire « ouvrir d'abord, décrire ensuite » plus bas). La route, elle,
 * possède son `Cache-Control` — c'est une décision de politique de cache propre
 * à ce qu'elle sert, pas quelque chose que cette fonction générique pourrait
 * deviner — et le passe par `headers` comme le `Content-Type`.
 */
export async function serveFile(
  request: Request,
  path: string,
  headers: Record<string, string>,
): Promise<Response | null> {
  // **Ouvrir d'abord, décrire ensuite.** Un `stat` réussit sur un fichier qu'on
  // n'a pas le droit de lire — mesuré : `chmod 000` puis `stat` passe, et c'est
  // `open` qui rend `EACCES`. Avec l'ordre inverse, le refus n'arriverait qu'à
  // la première lecture, c'est-à-dire *après* l'envoi d'un 200 ou d'un 206 : le
  // client recevrait un statut de succès suivi d'un corps interrompu. Le `stat`
  // porte ensuite sur le handle, donc sur l'inode réellement servi :
  // `Content-Length` ne peut pas décrire un autre fichier que celui qui part.
  let file: FileHandle
  try {
    file = await open(path, 'r')
  } catch (error) {
    if (isAAbsence(error)) return null
    throw error
  }

  // Le handle appartient au flux dès qu'il en part, et se referme avec lui. Sur
  // tout chemin qui ne rend pas de flux — absence, 416, exception — il faut le
  // refermer à la main, sans quoi chaque requête laisse un descripteur derrière
  // elle.
  let delegated = false
  try {
    const info = await file.stat()
    // Un dossier nommé `proxy.mp4` n'est pas une vidéo, et Linux accepte de
    // l'ouvrir (mesuré). Sans ce contrôle, la lecture échouerait plus loin, au
    // milieu d'une réponse déjà commencée.
    if (!info.isFile()) return null
    const size = info.size
    const { etag, lastModified } = computeValidators(size, info.mtimeMs)
    const headersWithValidators = { ...headers, ETag: etag, 'Last-Modified': lastModified }

    const inHead = request.headers.get('range')

    // **Le conditionnel prime sur `Range`** (RFC 9110 §13.2.2) : une requête
    // qui porte à la fois un validateur et `Range` reste un GET conditionnel,
    // et un `If-None-Match`/`If-Modified-Since` qui matche répond 304 sans
    // corps, quelle que soit la présence d'une plage. `If-Range` ne joue
    // qu'ensuite, pour décider si la plage demandée peut être honorée.
    if (notModified(request, etag, info.mtimeMs)) {
      // Sans corps, donc sans `Content-Length` qui le décrirait : rien à
      // envoyer, seulement les validateurs qui ont permis de le dire.
      return new Response(null, { status: 304, headers: headersWithValidators })
    }

    // Pas de `Range` : le fichier entier.
    if (inHead === null) {
      // `Accept-Ranges` est posé quand même, et c'est tout l'intérêt de cette
      // branche — c'est cet en-tête qui annonce au navigateur qu'il *peut*
      // demander des plages. Sans lui, il ne redemandera jamais rien et la
      // barre de lecture restera inerte.
      delegated = true
      return new Response(streamWeb(file), {
        status: 200,
        headers: { ...headersWithValidators, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
      })
    }

    // `If-Range` protège un scrub en cours d'une reconstruction du proxy sous
    // les doigts : le client redemande une plage d'un fichier qui a changé
    // depuis sa dernière requête, et sans ce contrôle il recoudrait deux
    // moitiés de vidéos différentes. Le validateur périmé retombe donc sur le
    // fichier entier, exactement comme en l'absence de `Range`.
    const ifRange = request.headers.get('if-range')
    if (ifRange !== null && !ifRangeSatisfied(ifRange, etag, info.mtimeMs)) {
      delegated = true
      return new Response(streamWeb(file), {
        status: 200,
        headers: { ...headersWithValidators, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
      })
    }

    const range = parseRange(inHead, size)
    if (range === null) {
      // 416, et `Content-Range: bytes */<taille>` : la taille réelle est la
      // seule information qui permette au client de reformuler une demande
      // correcte.
      //
      // **Les en-têtes de l'appelant valent ici aussi.** Un 416 est cacheable
      // par heuristique : sans le `Cache-Control` de la route, un refus calculé
      // sur l'ancienne taille peut survivre à un ré-export qui remplace le
      // fichier sous la même URL, et bloquer une demande devenue légitime.
      // (relevé par Copilot et Aristarque) Avec le `no-cache` que pose la route
      // du proxy, ce 416 cesse justement d'être cacheable par heuristique — ce
      // que ce commentaire cherchait déjà à obtenir, désormais garanti plutôt
      // qu'espéré.
      return new Response(null, {
        status: 416,
        headers: { ...headersWithValidators, 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
      })
    }

    delegated = true
    return new Response(streamWeb(file, range), {
      status: 206,
      headers: {
        ...headersWithValidators,
        // Les deux bornes sont inclusives : `bytes=0-1023` fait 1024 octets.
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Accept-Ranges': 'bytes',
      },
    })
  } finally {
    if (!delegated) await file.close()
  }
}
