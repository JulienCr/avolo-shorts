import { open, type FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'

import { parseRange, type ByteRange } from '@/core/range'
import { projectsDir, proxyPath } from '@/server/paths'

/**
 * `GET /api/projects/:id/proxy` — le proxy 960x540, servi en requêtes
 * partielles.
 *
 * Le proxy pèse plus d'un gigaoctet et vit dans `PROJECTS_DIR`, hors de
 * `public/` : Next ne le sert pas tout seul, et il n'en est pas question — un
 * dossier de données n'a pas à devenir un dossier public.
 *
 * Cette route existe surtout pour l'en-tête `Range`. **Sans réponse aux requêtes
 * partielles, la barre de lecture d'un `<video>` ne fonctionne pas** : faute de
 * pouvoir demander un morceau au milieu, le navigateur ne peut pas sauter, et
 * l'éditeur de clip (tâche 13) scrube en permanence.
 *
 * L'analyse de l'en-tête est ailleurs, dans `@/core/range` : c'est du calcul, et
 * c'est là que sont les bugs. Ici il ne reste que ce qui touche au disque.
 */

/** Le proxy est toujours du H.264 en conteneur MP4 (tâche 8). */
const TYPE = 'video/mp4'

/**
 * Les codes d'erreur d'ouverture qui veulent dire « il n'y a pas de proxy ici ».
 *
 * `ENOENT` est le cas normal : tant que l'étape d'encodage n'a pas tourné, le
 * fichier n'existe pas. `ENOTDIR` et `ENAMETOOLONG` disent la même chose sous
 * une autre forme. `EISDIR` couvre les plateformes qui refusent d'ouvrir un
 * dossier — Linux l'accepte, d'où le contrôle `isFile()` plus bas, mais toutes
 * ne le font pas.
 *
 * **Tout le reste est un vrai problème de serveur** et doit remonter en 500 :
 * droits refusés, montage mort, disque en vrac. Les déguiser en 404 ferait
 * chercher le bug du côté du projet manquant, là où il n'y a rien à trouver.
 */
const ABSENCE = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'EISDIR'])

function estUneAbsence(erreur: unknown): boolean {
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
 * Le flux part du `FileHandle` déjà ouvert, et le referme en se terminant. Les
 * deux bouts sont mesurés sur cette machine (Node 22) : après la fin du flux
 * comme après un `cancel()` du consommateur, un `stat()` sur le handle répond
 * `EBADF`. Aucun descripteur ne fuit, ni au bout d'une lecture complète, ni sur
 * un saut dans la timeline.
 *
 * Le `as` est un raccommodage de types, pas un changement de valeur : Node type
 * son `ReadableStream` dans `node:stream/web` et le `lib: ["dom"]` du projet en
 * déclare un autre, alors que c'est le même objet au runtime.
 */
function fluxWeb(fichier: FileHandle, plage?: ByteRange): ReadableStream<Uint8Array> {
  const flux = fichier.createReadStream(plage && { start: plage.start, end: plage.end })
  return Readable.toWeb(flux) as unknown as ReadableStream<Uint8Array>
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params

  // Appelé pour lui-même, et **avant** le `try` qui suit : `projectsDir()` lève
  // si `PROJECTS_DIR` manque ou est vide. Sous le `try`, cette erreur de
  // configuration deviendrait un 404 sur *toutes* les requêtes — un serveur mal
  // monté annonçant tranquillement qu'aucun projet n'existe, ce qui enverrait
  // chercher le bug à l'exact opposé de là où il est. (relevé par Copilot)
  projectsDir()

  let chemin: string
  try {
    chemin = proxyPath(id)
  } catch {
    // Reste donc le seul refus possible ici : celui de `vérifierId`, dans
    // `src/server/paths.ts`. C'est lui qui garde la traversée de répertoire, et
    // il le fait sur la seule chose qui compte, les séparateurs. Un identifiant
    // qui ne peut nommer aucun chemin ne désigne aucun proxy : 404, comme un
    // projet inexistant. Répondre 400 dirait au demandeur que sa syntaxe était
    // presque bonne.
    return new Response(null, { status: 404 })
  }

  // **Ouvrir d'abord, décrire ensuite.** Un `stat` réussit sur un fichier qu'on
  // n'a pas le droit de lire — mesuré : `chmod 000` puis `stat` passe, et c'est
  // `open` qui rend `EACCES`. Avec l'ordre inverse, le refus n'arrivait qu'à la
  // première lecture, c'est-à-dire *après* l'envoi d'un 200 ou d'un 206 : le
  // client recevait un statut de succès suivi d'un corps interrompu, au lieu de
  // l'erreur serveur annoncée. Ouvrir avant de construire la `Response` fait
  // remonter le refus au seul moment où il peut encore changer le statut.
  // Le `stat` porte ensuite sur le handle, donc sur l'inode réellement servi :
  // `Content-Length` ne peut plus décrire un autre fichier que celui qui part.
  // (relevé par Copilot)
  let fichier: FileHandle
  try {
    fichier = await open(chemin, 'r')
  } catch (erreur) {
    if (estUneAbsence(erreur)) return new Response(null, { status: 404 })
    throw erreur
  }

  // Le handle appartient au flux dès qu'il en part, et se referme avec lui. Sur
  // tout chemin qui ne rend pas de flux — 404, 416, exception — il faut le
  // refermer à la main, sans quoi chaque requête laisse un descripteur derrière
  // elle.
  let confié = false
  try {
    const info = await fichier.stat()
    // Un dossier nommé `proxy.mp4` n'est pas une vidéo, et Linux accepte de
    // l'ouvrir (mesuré). Sans ce contrôle, la lecture échouerait plus loin, au
    // milieu d'une réponse déjà commencée.
    if (!info.isFile()) return new Response(null, { status: 404 })
    const taille = info.size

    const enTête = request.headers.get('range')

    // Pas de `Range` : le fichier entier. `Accept-Ranges` est posé quand même,
    // et c'est tout l'intérêt de cette branche — c'est cet en-tête qui annonce
    // au navigateur qu'il *peut* demander des plages. Sans lui, il ne
    // redemandera jamais rien et la barre de lecture restera inerte.
    if (enTête === null) {
      confié = true
      return new Response(fluxWeb(fichier), {
        status: 200,
        headers: {
          'Content-Type': TYPE,
          'Content-Length': String(taille),
          'Accept-Ranges': 'bytes',
        },
      })
    }

    const plage = parseRange(enTête, taille)
    if (plage === null) {
      // 416, et `Content-Range: bytes */<taille>` : la taille réelle est la
      // seule information qui permette au client de reformuler une demande
      // correcte.
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${taille}`,
          'Accept-Ranges': 'bytes',
        },
      })
    }

    confié = true
    return new Response(fluxWeb(fichier, plage), {
      status: 206,
      headers: {
        'Content-Type': TYPE,
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
