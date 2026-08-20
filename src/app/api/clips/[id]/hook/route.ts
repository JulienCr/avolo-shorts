import { getClip, getDb, putClip } from '@/server/db'
import { notFound, json, route } from '@/server/http'
import { generateHookText } from '@/server/steps/hook'

/**
 * `POST /api/clips/:id/hook` — régénère le hook du clip et l'écrit.
 *
 * **Premier et seul appelant de `generateHookText`.** Rien d'automatique ne
 * mène ici : c'est le bouton « Régénérer » de l'écran Clip, et lui seul.
 *
 * **Le clip est relu juste avant l'écriture, pas avant l'appel au modèle.**
 * `putClip` remplace la ligne entière — ce n'est pas un merge partiel — et
 * l'appel réseau tient jusqu'à trente secondes (`TIMEOUT_MS`,
 * `src/server/steps/hook.ts`). Écrire sur l'instantané pris avant l'appel
 * effacerait silencieusement tout ce que l'autosave, une écriture directe de
 * champ, ou un autre onglet auraient posé sur ce clip pendant l'attente. La
 * relecture ici et l'écriture qui suit n'ont aucun point d'attente entre
 * elles : la fenêtre qui reste est celle, synchrone, que `PATCH
 * /api/clips/:id` accepte déjà pour toute écriture sans jeton `seq`.
 * (relevé en review interne)
 */
export const POST = route(
  'POST /api/clips/:id/hook',
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const db = getDb()
    const clip = getClip(db, id)
    if (clip === undefined) throw notFound(`Clip inconnu : ${id}`)

    const hookText = await generateHookText(db, id)

    const fresh = getClip(db, id) ?? clip
    putClip(db, { ...fresh, hookText })
    const written = getClip(db, id) ?? { ...fresh, hookText }
    return json({ clip: written })
  },
)
