import { readFile } from 'node:fs/promises'

import { introuvable, requêteInvalide, route } from '@/server/http'
import { replayDir } from '@/server/paths'
import { vignetteSource } from '@/server/vignettes-sources'

/**
 * `GET /api/sources/thumb?file=<nom>` — la vignette d'un replay (spec §12).
 *
 * **Ce `file` vient du client, et c'est un changement de frontière de
 * confiance** que la spec nomme explicitement : la vignette d'un candidat part
 * d'un `projectId` que le serveur contrôle en base, celle-ci part d'un nom que
 * l'appelant écrit. Deux contrôles s'en chargent, et ils ne font pas le même
 * travail — `resolveSource` décide du fichier qu'on **lit**, `vérifierNomDeSource`
 * du fichier qu'on **écrit** dans le cache. `src/server/vignettes-sources.ts`
 * explique pourquoi l'un ne dispense pas de l'autre.
 *
 * `replayDir()` est appelé pour lui-même et hors du corps, comme dans
 * `GET /api/sources` : un `REPLAY_DIR` absent de l'environnement est une erreur
 * de configuration du serveur, pas une vignette manquante, et la déguiser en 404
 * enverrait chercher un fichier là où il manque une ligne de `.env`.
 */
export const GET = route('GET /api/sources/thumb', async (requête: Request) => {
  replayDir()
  const nom = new URL(requête.url).searchParams.get('file')
  if (nom === null || nom === '') {
    throw requêteInvalide('Paramètre `file` manquant : le nom du replay dans REPLAY_DIR.')
  }

  const fichier = await vignetteSource(nom)
  // Pas d'image à en tirer : le fichier a disparu depuis la liste, ce n'est pas
  // un fichier ordinaire, ou il pèse zéro octet — un enregistrement qui vient de
  // commencer. Aucun des trois n'est une panne, et la carte a son repli.
  if (fichier === null) throw introuvable('Pas de vignette pour cette source.')

  const données = await readFile(fichier)
  return new Response(new Uint8Array(données), {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(données.byteLength),
      // Cinq minutes, et surtout pas « immuable » : la clé du cache disque porte
      // la taille et la date de modification, l'URL non. Un replay réenregistré
      // sous le même nom change donc d'image sans changer d'URL, et une réponse
      // immuable montrerait l'ancienne jusqu'à la fin de la session.
      'Cache-Control': 'public, max-age=300',
    },
  })
})
