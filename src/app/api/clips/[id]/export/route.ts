import path from 'node:path'
import { z } from 'zod'

import { getClip, getDb } from '@/server/db'
import { body, notFound, json, route } from '@/server/http'
import { renderClip } from '@/server/steps/render'

/**
 * `POST /api/clips/:id/export` — rendre un clip.
 *
 * **Synchrone, contrairement à l'analyse.** Un export mesure quelques dizaines
 * de secondes — 4,58x le temps réel en NVENC sur cette machine, pour un clip qui
 * dure vingt à quarante secondes —, là où une analyse dure trois quarts d'heure.
 * Le lanceur de `run.ts` existe pour ce qu'aucune requête ne peut porter ; s'en
 * servir ici ajouterait un état à interroger pour économiser dix secondes
 * d'attente.
 *
 * **La réponse ne porte que des noms de fichiers.** `RenderResult` rend des
 * chemins absolus — c'est ce dont le serveur a besoin —, et les publier
 * exposerait l'arborescence de la machine, exactement comme le ferait un message
 * d'erreur non épuré. Le nom suffit à retrouver le fichier dans le dossier de
 * rendus du projet, qui est la seule chose que l'appelant ait à savoir.
 *
 * Le statut du clip passe à `exported` **dans `renderClip`**, une fois les
 * fichiers sur le disque — jamais depuis un `PATCH`, que la route d'édition
 * refuse pour cette raison précise.
 */

const REQUEST = z.strictObject({
  /** Refaire les rendus même s'ils sont déjà là. */
  force: z.boolean().optional(),
})

export const POST = route(
  'POST /api/clips/:id/export',
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const { force } = await body(request, REQUEST)

    const db = getDb()
    if (getClip(db, id) === undefined) throw notFound(`Clip inconnu : ${id}`)

    const result = await renderClip(id, { db, force })

    return json({
      // Relu après le rendu : c'est `renderClip` qui pose `exported`, et
      // l'appelant a besoin du clip tel qu'il est maintenant.
      clip: getClip(db, id),
      mp4: path.basename(result.mp4),
      variant9x16: result.variant9x16 === null ? null : path.basename(result.variant9x16),
      texts: path.basename(result.texts),
      skipped: result.skipped,
    })
  },
)
