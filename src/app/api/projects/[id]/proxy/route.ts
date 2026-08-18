import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'

import { parseRange, type ByteRange } from '@/core/range'
import { proxyPath } from '@/server/paths'

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
 * Le `as` est un raccommodage de types, pas un changement de valeur : Node type
 * son `ReadableStream` dans `node:stream/web` et le `lib: ["dom"]` du projet en
 * déclare un autre, alors que c'est le même objet au runtime.
 */
function fluxWeb(chemin: string, plage?: ByteRange): ReadableStream<Uint8Array> {
  const flux = createReadStream(chemin, plage && { start: plage.start, end: plage.end })
  return Readable.toWeb(flux) as unknown as ReadableStream<Uint8Array>
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params

  let chemin: string
  try {
    chemin = proxyPath(id)
  } catch {
    // `proxyPath` refuse un identifiant qui sortirait de `PROJECTS_DIR` — c'est
    // lui qui garde la traversée de répertoire, et il le fait sur la seule chose
    // qui compte, les séparateurs. Un identifiant qui ne peut nommer aucun
    // chemin ne désigne aucun proxy : 404, comme un projet inexistant. Répondre
    // 400 dirait au demandeur que sa syntaxe était presque bonne.
    return new Response(null, { status: 404 })
  }

  let taille: number
  try {
    const info = await stat(chemin)
    // Un dossier nommé `proxy.mp4` n'est pas une vidéo. `createReadStream`
    // échouerait plus loin, au milieu d'une réponse déjà commencée.
    if (!info.isFile()) return new Response(null, { status: 404 })
    taille = info.size
  } catch (erreur) {
    // **Seule l'absence donne 404**, et c'est le cas normal : tant que l'étape
    // d'encodage n'a pas tourné, le proxy n'existe pas. Tout le reste — droits
    // refusés, montage mort, disque en vrac — est un vrai problème de serveur,
    // et le déguiser en 404 ferait chercher le bug du côté du projet manquant.
    const code = (erreur as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG') {
      return new Response(null, { status: 404 })
    }
    throw erreur
  }

  const enTête = request.headers.get('range')

  // Pas de `Range` : le fichier entier. `Accept-Ranges` est posé quand même, et
  // c'est tout l'intérêt de cette branche — c'est cet en-tête qui annonce au
  // navigateur qu'il *peut* demander des plages. Sans lui, il ne redemandera
  // jamais rien et la barre de lecture restera inerte.
  if (enTête === null) {
    return new Response(fluxWeb(chemin), {
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
    // 416, et `Content-Range: bytes */<taille>` : la taille réelle est la seule
    // information qui permette au client de reformuler une demande correcte.
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${taille}`,
        'Accept-Ranges': 'bytes',
      },
    })
  }

  return new Response(fluxWeb(chemin, plage), {
    status: 206,
    headers: {
      'Content-Type': TYPE,
      // Les deux bornes sont inclusives : `bytes=0-1023` fait 1024 octets.
      'Content-Length': String(plage.end - plage.start + 1),
      'Content-Range': `bytes ${plage.start}-${plage.end}/${taille}`,
      'Accept-Ranges': 'bytes',
    },
  })
}
