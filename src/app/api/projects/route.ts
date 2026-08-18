import type fs from 'node:fs'
import { z } from 'zod'

import { getDb, listProjects } from '@/server/db'
import { corps, ErreurHttp, introuvable, json, requêteInvalide, route } from '@/server/http'
import { resolveSource } from '@/server/paths'
import { créerProjet } from '@/server/run'
import { DÉLAI_STAT_MS, statAvecDélai } from '@/server/steps/ingest'
import { résuméProjet } from '@/server/vues'

/**
 * `GET /api/projects` — la bibliothèque.
 * `POST /api/projects` — ingérer un replay et lancer son analyse.
 */

const CRÉATION = z.strictObject({
  /** Le nom du fichier dans `REPLAY_DIR`, ou son chemin complet. */
  source: z.string().min(1),
})

export const GET = route('GET /api/projects', async () => {
  return json(listProjects(getDb()).map(résuméProjet))
})

/**
 * **202, et pas 201.** L'analyse dure 30 à 45 minutes : ce que la réponse
 * confirme est qu'elle est acceptée et lancée, pas qu'elle est faite. Le `plan`
 * dit ce qui va tourner — sur un projet déjà transcrit, il ne contient pas
 * `transcript`, et c'est là que ça se lit.
 */
export const POST = route('POST /api/projects', async (requête: Request) => {
  const { source } = await corps(requête, CRÉATION)

  // La forme du chemin d'abord : un fichier posé directement dans `REPLAY_DIR`,
  // ni au-dessus ni dans un sous-dossier. C'est la faute de l'appelant, donc 400.
  let sourcePath: string
  try {
    sourcePath = resolveSource(source)
  } catch (cause) {
    throw requêteInvalide(cause instanceof Error ? cause.message : String(cause))
  }

  // Puis l'existence. **Ce contrôle-ci évite un projet fantôme** : sans lui, une
  // faute de frappe inscrirait une ligne en base, répondrait 202, et l'échec
  // n'apparaîtrait que cinq secondes plus tard dans un journal que personne ne
  // regarde. Le `lstat` est celui que l'ingestion ferait de toute façon.
  let stat: fs.Stats
  try {
    stat = await statAvecDélai(sourcePath, DÉLAI_STAT_MS)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw introuvable(`Aucun replay nommé ${JSON.stringify(source)} dans REPLAY_DIR.`)
    }
    // Ni absent ni lisible : le montage 9p ne répond pas, ou refuse. C'est une
    // panne d'infrastructure qui se répare et se réessaie — 503, pas 500.
    throw new ErreurHttp(
      503,
      'Le dossier des replays ne répond pas. REPLAY_DIR est monté en 9p : il peut être absent, ' +
        "ou monté avec son transport mort dessous. Rouvrir le lecteur côté Windows, ou remonter le partage.",
    )
  }
  if (!stat.isFile()) {
    throw requêteInvalide(
      `${JSON.stringify(source)} n'est pas un fichier ordinaire — ni un dossier, ni un lien symbolique.`,
    )
  }

  const { projectId, plan } = await créerProjet(source)
  return json({ projectId, plan }, { status: 202 })
})
