import { getClip, getDb, putClip } from '@/server/db'
import { notFound, json, route } from '@/server/http'
import { generateHookText } from '@/server/steps/hook'

/**
 * `POST /api/clips/:id/hook` — régénère le hook du clip et l'écrit.
 *
 * **Premier et seul appelant de `generateHookText`.** Rien d'automatique ne
 * mène ici : c'est le bouton « Régénérer » de l'écran Clip, et lui seul.
 */
export const POST = route(
  'POST /api/clips/:id/hook',
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const db = getDb()
    const clip = getClip(db, id)
    if (clip === undefined) throw notFound(`Clip inconnu : ${id}`)

    const hookText = await generateHookText(db, id)

    putClip(db, { ...clip, hookText })
    const written = getClip(db, id) ?? { ...clip, hookText }
    return json({ clip: written })
  },
)
