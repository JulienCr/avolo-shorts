import type Database from 'better-sqlite3'

import { isGuard } from '@/core/phase'
import { clipFraming } from '@/server/clip-framing'
import { getClip, putClip } from '@/server/db'
import { generateHook } from '@/server/steps/hook'
import { discardRenderStale, pathsRender, renderedFraming } from '@/server/steps/render'

/**
 * Le rattrapage du hook, quand un candidat devient un clip gardé sans en
 * avoir un.
 *
 * **Le cas courant ne passe pas par ici.** La passe de détail du repérage rend
 * déjà `viral_hook_text` et `viral_hook_badge` dans la même réponse que le
 * titre et la description (`src/core/gemini/prompts.ts`), et
 * `parseDetailResponse` les pose sur le clip : un clip naît donc avec son
 * hook, sans un appel LLM de plus. C'est ainsi que la contrainte « ne pas
 * générer des hooks pour tous les candidats » (`docs/retour-ui-and-next-steps.md`
 * §7) a été tenue, et ce fichier ne la desserre pas.
 *
 * Ce qu'il ferme, c'est le trou qui reste : un modèle qui a omis le champ, une
 * réponse illisible sur cette ligne-là, ou un clip antérieur à la
 * fonctionnalité. Le hook est alors vide au moment précis où quelqu'un décide
 * de monter ce clip — et c'est le moment que §7 désigne, « quand ils entrent
 * dans le workflow de montage ».
 *
 * **Ce n'est pas une étape du graphe, et ça ne doit pas le devenir.**
 * `runCandidates` est la seule étape qui touche aux clips ; `renders` est déjà
 * l'exception documentée (« un rendu se demande par clip, jamais par le
 * graphe », `src/core/graph.ts`). En ajouter une seconde pour un appel de
 * trente secondes ferait de surcroît apparaître le rattrapage comme « une
 * analyse tourne » sur la carte du projet, que `useProjects` sonde toutes les
 * deux secondes.
 *
 * **Ce n'est pas non plus `launch`.** Sa réservation est **par projet** : un
 * rattrapage lèverait `ExecutionInCurrentError` contre une analyse en cours,
 * et réciproquement bloquerait une analyse pendant l'appel. Ce qu'on lui
 * emprunte, en revanche, c'est sa règle 1 — la réservation est prise **avant
 * le premier `await`** — au niveau du clip cette fois.
 */

/**
 * Les clips dont un rattrapage est déjà parti, **dans ce processus**.
 *
 * Même motif que les `inFlight` des `sidecars` de `src/server/run.ts` : une
 * promesse partagée plutôt qu'un drapeau, pour qu'un second appelant obtienne
 * le travail en cours au lieu d'en lancer un deuxième. Une table en mémoire
 * suffit — un redémarrage perd la réservation, et la pire conséquence est un
 * appel de plus sur un clip dont le hook est de toute façon relu avant
 * écriture.
 */
const inFlight = new Map<string, Promise<void>>()

/** Le message d'une erreur, quelle que soit sa forme. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Lance, en tâche de fond, la génération du hook d'un clip fraîchement gardé
 * qui n'en a pas. **Ne lève jamais, n'attend rien, ne bloque rien.**
 *
 * Rend la promesse plutôt que `void`, et c'est un choix de testabilité
 * assumé : l'appelant de production l'ignore (`void scheduleHookBackfill(…)`),
 * un test l'attend au lieu de sonder la base. Elle ne rejette pas — un échec
 * s'y résout après un avertissement.
 */
/**
 * Attend que tous les rattrapages en vol se soient tus. **Une couture de
 * test, et elle est assumée comme telle.**
 *
 * Le point d'appel de production ne l'utilise pas : `PATCH /api/clips/:id`
 * jette délibérément la promesse. Mais un test qui déclenche un rattrapage par
 * la route n'a aucun moyen de savoir quand il s'achève — et un travail qui
 * déborde sur le test suivant y produit une assertion qui passe pour de
 * mauvaises raisons, ce qui est pire qu'un test qui échoue. Attendre un délai
 * arbitraire aurait la même faiblesse, décalée.
 */
export function pendingHookBackfills(): Promise<void> {
  return Promise.all([...inFlight.values()]).then(() => undefined)
}

export function scheduleHookBackfill(db: Database.Database, clipId: string): Promise<void> {
  // **Rien d'asynchrone au-dessus de cette ligne.** La réservation ne ferme la
  // course entre deux `PATCH` rapprochés que si aucun point d'attente ne
  // s'intercale entre la lecture de la table et son écriture. C'est la règle 1
  // de `run.ts`, transposée au clip.
  const already = inFlight.get(clipId)
  if (already !== undefined) return already

  const clip = getClip(db, clipId)
  if (clip === undefined || !isGuard(clip.status) || clip.hookText.trim() !== '') {
    return Promise.resolve()
  }

  const work = (async () => {
    try {
      const { text, badge } = await generateHook(db, clipId)
      // **Le clip est relu juste avant l'écriture**, la même discipline que
      // `POST /api/clips/:id/hook` et pour la même raison : `putClip` remplace
      // la ligne entière, et l'appel tient jusqu'à trente secondes — assez
      // pour qu'un autosave ou un autre onglet se glisse dedans.
      const fresh = getClip(db, clipId)
      // Trois façons de devenir périmé pendant l'appel : le clip a disparu, il
      // a été écarté, ou quelqu'un a saisi un hook à la main. Dans les trois
      // cas la réponse du modèle se jette. **On n'écrase jamais un hook non
      // vide** — c'est ce qui distingue un rattrapage d'une régénération.
      if (fresh === undefined || !isGuard(fresh.status) || fresh.hookText.trim() !== '') return
      // **Périme le rendu exporté, comme le fait déjà `PATCH /api/clips/:id`.**
      // `docs/retour-ui-and-next-steps.md` §7 : « toute modification du hook
      // […] doit invalider les fichiers exportés existants ». Le clip est
      // `kept` au moment où le rattrapage part, mais l'appel LLM tient jusqu'à
      // trente secondes (`TIMEOUT_MS`, `src/server/steps/hook.ts`) : un export
      // déclenché entre-temps peut produire des MP4 sans hook (accroche encore
      // vide, donc non incrustée) avant que ce bloc n'écrive le texte généré.
      // Sans cet appel, le statut resterait `exported` sur des fichiers qui ne
      // montrent pas ce hook-là. (relevé par Copilot)
      const framing = clipFraming(fresh)
      const paths = pathsRender(fresh.projectId, clipId, framing.ratio)
      putClip(db, { ...fresh, hookText: text, hookBadge: badge })
      discardRenderStale(db, clipId, paths, fresh, renderedFraming(framing))
    } catch (cause) {
      // **Le tri ne casse jamais.** Garder un clip est un geste au clavier
      // dans le feed ; il ne peut pas dépendre d'un fournisseur LLM joignable.
      // Un quota dépassé, une clé absente, un modèle qui refuse : rien de tout
      // ça ne doit produire une erreur HTTP, un bandeau, ni un clip modifié.
      // Le bouton « Régénérer » de l'écran Clip reste le recours explicite.
      console.warn(`Rattrapage du hook abandonné pour ${clipId} : ${messageOf(cause)}`)
    }
  })().finally(() => {
    inFlight.delete(clipId)
  })

  inFlight.set(clipId, work)
  return work
}
