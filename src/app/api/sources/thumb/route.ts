import { readFile } from 'node:fs/promises'

import { notFound, requestInvalid, route } from '@/server/http'
import { replayDir } from '@/server/paths'
import { SourceInvalidError, vignetteSource } from '@/server/source-thumbnails'

/**
 * `GET /api/sources/thumb?file=<nom>` — la vignette d'un replay (spec §12).
 *
 * **Ce `file` vient du client, et c'est un changement de frontière de
 * confiance** que la spec nomme explicitement : la vignette d'un candidat part
 * d'un `projectId` que le serveur contrôle en base, celle-ci part d'un nom que
 * l'appelant écrit. Deux contrôles s'en chargent, et ils ne font pas le même
 * travail — `resolveSource` décide du fichier qu'on **lit**, `sourceVerifyName`
 * du fichier qu'on **écrit** dans le cache. `src/server/vignettes-sources.ts`
 * explique pourquoi l'un ne dispense pas de l'autre.
 *
 * `replayDir()` est appelé pour lui-même et hors du corps, comme dans
 * `GET /api/sources` : un `REPLAY_DIR` absent de l'environnement est une erreur
 * de configuration du serveur, pas une vignette manquante, et la déguiser en 404
 * enverrait chercher un fichier là où il manque une ligne de `.env`.
 */
export const GET = route('GET /api/sources/thumb', async (request: Request) => {
  replayDir()
  const name = new URL(request.url).searchParams.get('file')
  if (name === null || name === '') {
    throw requestInvalid('Paramètre `file` manquant : le nom du replay dans REPLAY_DIR.')
  }

  // **Un nom mal formé est un 400, pas un 500.** C'est la règle de `http.ts`, et
  // elle vaut d'autant plus ici que ce paramètre est la surface que quelqu'un
  // ira sonder en premier : répondre 500 à `?file=../../etc/passwd` accuserait
  // le serveur et inscrirait une trace complète au journal à chaque tentative.
  const file = await vignetteSource(name).catch((cause: unknown) => {
    if (cause instanceof SourceInvalidError) throw requestInvalid(cause.message)
    throw cause
  })
  // Pas d'image à en tirer : le fichier a disparu depuis la liste, ce n'est pas
  // un fichier ordinaire, ou il pèse zéro octet — un enregistrement qui vient de
  // commencer. Aucun des trois n'est une panne, et la carte a son repli.
  if (file === null) throw notFound('Pas de vignette pour cette source.')

  const data = await readFile(file)
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(data.byteLength),
      // Cinq minutes, et pas « immuable ». L'URL porte pourtant la version
      // depuis que `urlVignetteSource` y met la taille et la date, donc un
      // replay réenregistré ne réutilise plus la même : `immutable` serait
      // défendable. Mais ce `v` n'est qu'informatif — le serveur reconstruit la
      // clé depuis son propre relevé, jamais depuis lui —, et une réponse qu'on
      // ne peut plus rattraper ne vaut pas les quelques millisecondes qu'un
      // fichier de 40 ko déjà sur le disque local coûte à resservir.
      'Cache-Control': 'public, max-age=300',
    },
  })
})
