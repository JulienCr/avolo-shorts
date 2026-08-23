import type fs from 'node:fs'
import { z } from 'zod'

import { getDb, listProjects } from '@/server/db'
import { body, ErrorHttp, notFound, json, requestInvalid, route } from '@/server/http'
import { replayDir, resolveSource } from '@/server/paths'
import { createProject } from '@/server/run'
import { DELAY_STAT_MS, statWithDelay } from '@/server/steps/ingest'
import { listElement } from '@/server/views'

/**
 * `GET /api/projects` — la bibliothèque.
 * `POST /api/projects` — ingérer un replay, et lancer son analyse si `launch`
 * le demande.
 */

const CREATION = z.strictObject({
  /** Le nom du fichier dans `REPLAY_DIR`, ou son chemin complet. */
  source: z.string().min(1),
  /**
   * Lancer l'analyse tout de suite. **`false` par défaut**, depuis le 23 août
   * 2026 (retour d'usage, point A.3) : un clic sur la carte d'un replay
   * déclenchait jusque-là 30 à 45 minutes de traitement sans étape
   * intermédiaire. `show-card.tsx` n'envoie pas ce champ ; c'est `ButtonStart`
   * qui lance ensuite le travail, explicitement.
   */
  launch: z.boolean().optional(),
})

export const GET = route('GET /api/projects', async () => {
  return json(listProjects(getDb()).map(listElement))
})

/**
 * **202, et pas 201.** L'ingestion peut prendre plusieurs minutes depuis un
 * Drive lent : ce que la réponse confirme est que le projet est créé, pas que
 * la source est copiée. Quand `launch` vaut `true`, le `plan` dit en plus ce
 * qui va tourner — sur un projet déjà transcrit, il ne contient pas
 * `transcript`. Sans `launch`, le `plan` est vide : rien n'a été demandé.
 */
export const POST = route('POST /api/projects', async (request: Request) => {
  const { source, launch } = await body(request, CREATION)

  // **Appelé pour lui-même, et hors du `try` qui suit** : `replayDir()` lève si
  // `REPLAY_DIR` manque ou est vide, et `resolveSource` l'appelle. Sous le
  // `try`, cette erreur de configuration deviendrait un 400 — on dirait à
  // l'appelant que sa demande est mal formée alors que c'est le serveur qui
  // n'est pas monté. La route du proxy pose déjà la même garde.
  // (relevé par Copilot)
  replayDir()

  // La forme du chemin ensuite : un fichier posé directement dans `REPLAY_DIR`,
  // ni au-dessus ni dans un sous-dossier. C'est la faute de l'appelant, donc 400.
  let sourcePath: string
  try {
    sourcePath = resolveSource(source)
  } catch (cause) {
    throw requestInvalid(cause instanceof Error ? cause.message : String(cause))
  }

  // Puis l'existence. **Ce contrôle-ci évite un projet fantôme** : sans lui, une
  // faute de frappe inscrirait une ligne en base, répondrait 202, et l'échec
  // n'apparaîtrait que cinq secondes plus tard dans un journal que personne ne
  // regarde. Le `lstat` est celui que l'ingestion ferait de toute façon.
  let stat: fs.Stats
  try {
    stat = await statWithDelay(sourcePath, DELAY_STAT_MS)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw notFound(`Aucun replay nommé ${JSON.stringify(source)} dans REPLAY_DIR.`)
    }
    // Ni absent ni lisible : le montage 9p ne répond pas, ou refuse. C'est une
    // panne d'infrastructure qui se répare et se réessaie — 503, pas 500.
    throw new ErrorHttp(
      503,
      'Le dossier des replays ne répond pas. REPLAY_DIR est monté en 9p : il peut être absent, ' +
        "ou monté avec son transport mort dessous. Rouvrir le lecteur côté Windows, ou remonter le partage.",
    )
  }
  if (!stat.isFile()) {
    throw requestInvalid(
      `${JSON.stringify(source)} n'est pas un fichier ordinaire — ni un dossier, ni un lien symbolique.`,
    )
  }

  const { projectId, plan } = await createProject(source, { launchNow: launch === true })
  return json({ projectId, plan }, { status: 202 })
})
