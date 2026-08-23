import { clipFraming } from '@/server/clip-framing'
import { getClip, getDb, putClip } from '@/server/db'
import { notFound, json, route } from '@/server/http'
import { generateHook } from '@/server/steps/hook'
import { discardRenderStale, pathsRender, renderedFraming } from '@/server/steps/render'

/**
 * `POST /api/clips/:id/hook` — régénère le hook du clip **et son badge**, et
 * les écrit.
 *
 * **Les deux ensemble, y compris quand le badge revient vide.** « Régénérer »
 * remplace la paire : garder l'ancienne pastille au-dessus d'une accroche
 * neuve lui accolerait un sur-titre écrit pour un texte qui n'est plus là.
 *
 * **Seul appelant HTTP.** C'est le bouton « Régénérer » de l'écran Clip, et
 * lui seul ; le rattrapage automatique appelle `generateHook` directement,
 * sans passer par cette route (`src/server/steps/hook-backfill.ts`).
 *
 * **Autorisée sur n'importe quel statut, candidat compris.** La règle « pas
 * de hooks en masse pour tous les candidats » (retour d'usage §7) visait la
 * génération automatique — `src/server/steps/hook-backfill.ts`, qui reste
 * bornée à la transition `candidate → kept`. Un clic explicite sur un clip
 * précis est un appel délibéré et unique ; le restreindre aux clips gardés
 * (23 août 2026) désactivait le bouton sur un candidat sans raison technique.
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
 *
 * **Périme le rendu exporté, comme le fait déjà `PATCH /api/clips/:id`.**
 * `docs/retour-ui-and-next-steps.md` §7 : « toute modification du hook […]
 * doit invalider les fichiers exportés existants ». Cette route accepte un
 * clip `exported` sans passer par le `PATCH` — régénérer le hook d'un clip
 * déjà livré laissait donc le statut à `exported` et ses MP4 en place alors
 * qu'ils ne montrent plus ce texte-là, la vague de l'empreinte (§48) restant
 * aveugle à une écriture qui ne passe pas par elle. (relevé par Copilot)
 *
 * **L'invalidation peut échouer sans laisser le statut mentir.** Un `rmSync`
 * qui lève pour une autre raison qu'une absence (`force: true` couvre déjà
 * celle-là) intervient après que le nouveau hook a été écrit ; sans le même
 * rattrapage que `PATCH` — rabattre `exported` à `kept` — le clip resterait
 * livré sur des fichiers que rien n'a pu écarter. (relevé par Copilot)
 */
export const POST = route(
  'POST /api/clips/:id/hook',
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const db = getDb()
    const clip = getClip(db, id)
    if (clip === undefined) throw notFound(`Clip inconnu : ${id}`)

    const { text, badge } = await generateHook(db, id, { signal: request.signal })

    const fresh = getClip(db, id) ?? clip
    // Le cadrage se lit sur l'état d'avant l'écriture : ni `hookText` ni
    // `hookBadge` ne le changent, mais `discardRenderStale` en a besoin pour
    // retrouver les chemins des sorties à écarter.
    const framing = clipFraming(fresh)
    const paths = pathsRender(fresh.projectId, id, framing.ratio)
    putClip(db, { ...fresh, hookText: text, hookBadge: badge })
    try {
      discardRenderStale(db, id, paths, fresh, renderedFraming(framing))
    } catch (cause) {
      console.warn(`Sorties non mises à jour pour ${id} :`, cause)
      const toDay = getClip(db, id)
      if (toDay !== undefined && toDay.status === 'exported') {
        putClip(db, { ...toDay, status: 'kept' })
      }
    }
    const written = getClip(db, id) ?? { ...fresh, hookText: text, hookBadge: badge }
    return json({ clip: written })
  },
)
