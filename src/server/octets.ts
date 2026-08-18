import { open, type FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'

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

export function estUneAbsence(erreur: unknown): boolean {
  const code = (erreur as NodeJS.ErrnoException).code
  return code !== undefined && ABSENCE.has(code)
}

/**
 * Un flux de fichier, éventuellement borné, en `ReadableStream` du web.
 *
 * Le pont n'est pas décoratif : un `ReadStream` de Node n'est pas un
 * `ReadableStream`, et la `Response` que Next attend ne connaît que le second.
 * `Readable.toWeb` fait la conversion **en gardant les deux propriétés qui
 * comptent** : la contre-pression, sans laquelle un fichier d'un gigaoctet
 * serait tiré en mémoire aussi vite que le disque le rend, et l'annulation — un
 * spectateur qui saute abandonne la requête en cours, et le flux de fichier doit
 * se fermer avec elle plutôt que de continuer à lire dans le vide.
 *
 * Le flux part du `FileHandle` déjà ouvert et le referme en se terminant.
 *
 * Le `as` est un raccommodage de types, pas un changement de valeur : Node type
 * son `ReadableStream` dans `node:stream/web` et le `lib: ["dom"]` du projet en
 * déclare un autre, alors que c'est le même objet au runtime.
 */
function fluxWeb(fichier: FileHandle, plage?: ByteRange): ReadableStream<Uint8Array> {
  const flux = fichier.createReadStream(plage && { start: plage.start, end: plage.end })
  return Readable.toWeb(flux) as unknown as ReadableStream<Uint8Array>
}

/**
 * La réponse qui porte `chemin`, ou **`null` quand le fichier n'est pas là**.
 *
 * `null` plutôt qu'un 404 tout fait : l'absence se raconte différemment selon la
 * route — « pas encore de proxy », « ce clip n'a pas encore été exporté » — et
 * seul l'appelant sait laquelle. Il n'y a que le 416 qui soit décidé ici, parce
 * qu'il porte la taille réelle du fichier, que l'appelant n'a pas.
 *
 * `entêtes` passe le `Content-Type` et ce que la route veut y ajouter ;
 * `Content-Length`, `Content-Range` et `Accept-Ranges` sont posés ici, puisqu'ils
 * décrivent les octets et non la ressource.
 */
export async function servirFichier(
  requête: Request,
  chemin: string,
  entêtes: Record<string, string>,
): Promise<Response | null> {
  // **Ouvrir d'abord, décrire ensuite.** Un `stat` réussit sur un fichier qu'on
  // n'a pas le droit de lire — mesuré : `chmod 000` puis `stat` passe, et c'est
  // `open` qui rend `EACCES`. Avec l'ordre inverse, le refus n'arriverait qu'à
  // la première lecture, c'est-à-dire *après* l'envoi d'un 200 ou d'un 206 : le
  // client recevrait un statut de succès suivi d'un corps interrompu. Le `stat`
  // porte ensuite sur le handle, donc sur l'inode réellement servi :
  // `Content-Length` ne peut pas décrire un autre fichier que celui qui part.
  let fichier: FileHandle
  try {
    fichier = await open(chemin, 'r')
  } catch (erreur) {
    if (estUneAbsence(erreur)) return null
    throw erreur
  }

  // Le handle appartient au flux dès qu'il en part, et se referme avec lui. Sur
  // tout chemin qui ne rend pas de flux — absence, 416, exception — il faut le
  // refermer à la main, sans quoi chaque requête laisse un descripteur derrière
  // elle.
  let confié = false
  try {
    const info = await fichier.stat()
    // Un dossier nommé `proxy.mp4` n'est pas une vidéo, et Linux accepte de
    // l'ouvrir (mesuré). Sans ce contrôle, la lecture échouerait plus loin, au
    // milieu d'une réponse déjà commencée.
    if (!info.isFile()) return null
    const taille = info.size

    const enTête = requête.headers.get('range')

    // Pas de `Range` : le fichier entier. `Accept-Ranges` est posé quand même,
    // et c'est tout l'intérêt de cette branche — c'est cet en-tête qui annonce
    // au navigateur qu'il *peut* demander des plages. Sans lui, il ne
    // redemandera jamais rien et la barre de lecture restera inerte.
    if (enTête === null) {
      confié = true
      return new Response(fluxWeb(fichier), {
        status: 200,
        headers: { ...entêtes, 'Content-Length': String(taille), 'Accept-Ranges': 'bytes' },
      })
    }

    const plage = parseRange(enTête, taille)
    if (plage === null) {
      // 416, et `Content-Range: bytes */<taille>` : la taille réelle est la
      // seule information qui permette au client de reformuler une demande
      // correcte.
      //
      // **Les en-têtes de l'appelant valent ici aussi.** Un 416 est cacheable
      // par heuristique : sans le `Cache-Control` de la route, un refus calculé
      // sur l'ancienne taille peut survivre à un ré-export qui remplace le
      // fichier sous la même URL, et bloquer une demande devenue légitime.
      // (relevé par Copilot et Aristarque)
      return new Response(null, {
        status: 416,
        headers: { ...entêtes, 'Content-Range': `bytes */${taille}`, 'Accept-Ranges': 'bytes' },
      })
    }

    confié = true
    return new Response(fluxWeb(fichier, plage), {
      status: 206,
      headers: {
        ...entêtes,
        // Les deux bornes sont inclusives : `bytes=0-1023` fait 1024 octets.
        'Content-Length': String(plage.end - plage.start + 1),
        'Content-Range': `bytes ${plage.start}-${plage.end}/${taille}`,
        'Accept-Ranges': 'bytes',
      },
    })
  } finally {
    if (!confié) await fichier.close()
  }
}
