import fs from 'node:fs'

import type { Clip } from '@/core/edl'
import { computeFraming, resolveRatio } from '@/core/framing'
import type { ClipFraming } from '@/core/framing'
import type { PersonBox, Shot } from '@/core/shots'
import { isAAbsence } from '@/server/bytes'
import { analysisPath } from '@/server/paths'
import { lireAnalysis, type Analysis } from '@/server/steps/analysis'
import type { PublishedFraming, FramingOrigin } from '@/lib/api'

/**
 * Le cadrage d'un clip, résolu **côté serveur**, une fois pour tous ceux qui en
 * ont besoin.
 *
 * `computeFraming` est pur et prend les plans, les boîtes de personnes et les
 * dimensions de la source. Rien de tout cela ne peut vivre dans le navigateur :
 * `analysis.json` pèse deux à trois méga-octets par projet, et il changerait de
 * mains à chaque affichage d'écran. Le serveur le lit, appelle le calcul, et
 * **publie le résultat** — le ratio et un crop par plan. C'est ce que
 * `GET /api/clips/:id` et `PATCH /api/clips/:id` rendent désormais dans
 * `framing`, et c'est ce que le rendu suit.
 *
 * **Le cadrage n'est pas stocké, il se recalcule sur les segments courants.**
 * Retirer un passage où un comédien traverse le plateau peut faire retomber un
 * 16:9 en 1:1 : c'est voulu (spec §10), et c'est pourquoi le `PATCH` doit rendre
 * le cadrage autant que le `GET`. Un écran qui n'aurait que celui du `GET`
 * afficherait un ratio périmé jusqu'à la prochaine navigation, et le montage
 * mentirait sur ce que l'export produit.
 */

/**
 * Ce que le mode de cadrage vaut aujourd'hui, et pourquoi il est en dur.
 *
 * §3.5 du parcours décrit un mode explicite (`auto` ou `manual`) et une table de
 * dérogations **par plan**, indexée sur l'intervalle source. Rien de cela n'est
 * enregistrable : un clip ne porte qu'un `cropX` unique, en base comme dans
 * `ClipPatch`. C'est la tâche suivante, et elle a sa forme écrite en §9.4.
 *
 * En attendant, le mode est `'auto'` — donc `computeFraming` **ignore
 * entièrement** la table de dérogations, y compris pour le rapport, et
 * `rejectedOverrides` sort toujours vide. Passer `'manual'` avec une table
 * construite depuis `clip.cropX` serait la dérogation globale que §3.5 écarte
 * explicitement : elle effacerait le cadrage des plans qui étaient bons pour
 * réparer celui qui ne l'était pas.
 */
const CROP_MODE = 'auto' as const

/**
 * Le cadrage résolu, plus **d'où il vient**.
 *
 * `origin` est le champ que cette tâche ajoute au contrat, et il existe pour
 * une raison précise : `renders` ne dépend pas d'`analysis` dans le graphe
 * (`src/core/graph.ts`, et c'est délibéré — la dépendance ferait recalculer tous
 * les rendus au premier changement de modèle de détection). Rien ne garantit
 * donc qu'un clip en `auto` ait des plans sous la main, et se rabattre en
 * silence sur un 9:16 centré serait exactement le défaut que ce dépôt combat
 * partout : une faute qui ne se voit qu'à l'image, trois minutes d'export plus
 * tard.
 */
export type ResolvedFraming = PublishedFraming

/**
 * Le repli quand l'analyse manque : le clip tel que l'itération 0 le rendait.
 *
 * Un plan unique qui couvre le clip, portant le ratio épinglé — ou 9:16, la
 * réponse de `resolveRatio` à `'auto'` quand aucune analyse n'a mesuré quoi que
 * ce soit — et le `cropX` réglé à la main.
 */
function fallback(clip: Clip, origin: Exclude<FramingOrigin, 'computed'>): ResolvedFraming {
  const bounds = clip.segments.reduce<{ start: number; end: number } | null>(
    (acc, s) => (acc === null ? { ...s } : { start: Math.min(acc.start, s.start), end: Math.max(acc.end, s.end) }),
    null,
  )
  // Un plan unique qui couvre le clip, portant le `cropX` réglé à la main.
  //
  // **`source: 'manual'` et non `'default'`**, parce que les deux ne disent pas
  // la même chose et que c'est tout l'intérêt du champ : `'default'` désigne un
  // plan que personne n'a cadré, ni la machine ni l'humain, et c'est celui qu'il
  // faut aller regarder. Ici la valeur vient bien de quelqu'un — du curseur de
  // l'écran de clip, ou de son défaut à 0,5 pour un clip qu'on n'a pas touché.
  // Ce qui manque, c'est la mesure, et `origin` le dit à part.
  const shot: Shot = bounds ?? { start: 0, end: 0 }
  const ratio = resolveRatio(clip.ratio)
  return {
    ratio,
    shots: [
      {
        shot,
        key: Math.round(shot.start * 1000),
        ratio,
        // Les deux positions sont la même : sans plan à distinguer, il n'y a
        // qu'un cadre, et c'est celui que l'humain a réglé.
        cropX: clip.cropX,
        cropXNative: clip.cropX,
        source: 'manual',
      },
    ],
    rejectedOverrides: [],
    origin,
  }
}

/**
 * L'analyse d'un projet, **relue une fois par version du fichier**.
 *
 * `analysis.json` pèse deux à trois méga-octets, et le cadrage se résout à
 * chaque `GET /api/clips/:id`, à chaque `PATCH`, et deux fois par export. Le
 * relire à chaque appel ferait payer l'analyse syntaxique de quelques dizaines
 * de milliers de boîtes pour une réponse qui doit être instantanée.
 *
 * **La clé porte la taille et la date de modification**, pas seulement le
 * chemin : relancer l'analyse réécrit le fichier sous le même nom, et un cache
 * indexé sur le seul chemin servirait les plans d'avant jusqu'au redémarrage du
 * serveur — un cadrage faux, que rien ne signalerait.
 *
 * **Sans éviction, et c'est mesuré plutôt que supposé** : une entrée par projet,
 * trois projets sur cette machine, et le dossier des projets est ce que
 * l'opérateur ingère à la main. Un cache borné coûterait une politique
 * d'éviction à régler pour une table qui ne dépassera pas la dizaine.
 */
type CacheEntry = { key: string; analysis: Analysis | null; origin: FramingOrigin }
const cache = new Map<string, CacheEntry>()

/** Vidé par les tests, qui réécrivent des `analysis.json` en boucle sous le même nom. */
export function forgetAnalyses(): void {
  cache.clear()
}

/**
 * Ce qu'une lecture d'analyse rend : les plans et les boîtes, ou pourquoi il n'y
 * en a pas.
 *
 * **Nommé et exporté parce que la lecture est faillible et le calcul ne l'est
 * pas.** `PATCH /api/clips/:id` a besoin du cadrage *après* avoir écrit en base,
 * et une erreur de système de fichiers à ce moment-là rendrait 500 sur un
 * montage pourtant enregistré : l'écriture optimiste de l'interface remettrait
 * alors l'ancienne version à l'écran pendant que la base porte la nouvelle. La
 * route lit donc l'analyse **avant** d'écrire, et n'appelle après que le calcul,
 * qui ne touche à rien. (relevé par Copilot)
 */
export type FramingSource = { analysis: Analysis | null; origin: FramingOrigin }

/**
 * Lit l'analyse d'un projet. **C'est la seule fonction faillible du module** :
 * elle touche au disque, et relaie une panne au lieu de la maquiller en absence.
 *
 * Nommée `projectAnalysis` et non `lireAnalysis`, qui existe déjà dans
 * `steps/analysis.ts` et fait le travail d'un cran plus bas — celle-ci ajoute le
 * cache, la distinction absence/panne, et l'origine.
 */
export function projectAnalysis(projectId: string): FramingSource {
  const file = analysisPath(projectId)
  let info: fs.Stats
  try {
    info = fs.statSync(file)
  } catch (error) {
    // **Seule une absence vaut « pas d'analyse ».** Un refus de droits ou un
    // montage mort n'est pas « l'analyse n'a pas tourné » : les confondre ferait
    // annoncer un projet sans plans à un serveur en panne, et enverrait chercher
    // le défaut à l'exact opposé de là où il est. C'est la même distinction que
    // `clipOutputs` fait sur les mêmes codes.
    if (isAAbsence(error)) return { analysis: null, origin: 'no-analysis' }
    throw error
  }

  const key = `${info.size}:${info.mtimeMs}`
  const cached = cache.get(file)
  if (cached?.key === key) return { analysis: cached.analysis, origin: cached.origin }

  let entry: CacheEntry
  try {
    entry = { key, analysis: lireAnalysis(file), origin: 'computed' }
  } catch (cause) {
    // **Une panne du système de fichiers traverse, elle ne devient pas un
    // « illisible ».**
    //
    // `statSync` a réussi juste au-dessus, et ça ne veut pas dire que le fichier
    // s'ouvre : `src/server/bytes.ts` documente le cas d'un `chmod 000`, où
    // `stat` répond et `open` refuse. `lireAnalyse` lit puis analyse, donc son
    // `readFileSync` peut lever `EACCES` ou `EIO` — et les avaler ici ferait
    // cadrer tout un projet à la main sur une panne de montage, avec un journal
    // qui dit « illisible » d'un fichier parfaitement valide. Le sens de la
    // panne irait alors vers le silence, ce qui est exactement l'inverse de ce
    // que cette PR construit. (relevé par Copilot)
    //
    // Le repli est réservé à ce qu'il décrit : un JSON tronqué, un schéma qui ne
    // colle pas, une version inconnue. Ceux-là n'ont pas de `code` — les erreurs
    // système de Node en ont toujours un.
    if (typeof (cause as { code?: unknown } | null)?.code === 'string') throw cause

    // Le message porte le détail du schéma et le nom du fichier ; il va au
    // journal, jamais à la réponse. L'écran, lui, reçoit `analyse-illisible`.
    console.warn(
      `Analyse illisible pour le projet ${projectId} : ${cause instanceof Error ? cause.message : String(cause)} ` +
        `Le cadrage automatique se rabat sur le réglage manuel du clip.`,
    )
    entry = { key, analysis: null, origin: 'unreadable-analysis' }
  }
  cache.set(file, entry)
  return { analysis: entry.analysis, origin: entry.origin }
}

/**
 * Le cadrage de ce clip : le ratio, un crop par plan, et d'où tout cela vient.
 *
 * **Sur les segments du clip qu'on lui passe**, jamais sur ceux qu'il porte en
 * base : le `PATCH` a besoin du cadrage d'avant l'écriture pour savoir quels
 * fichiers écarter, et de celui d'après pour le publier.
 */
export function clipFraming(clip: Clip): ResolvedFraming {
  return framingWith(clip, projectAnalysis(clip.projectId))
}

/**
 * Le même cadrage, sur une analyse **déjà lue**. Pure : aucun accès au disque,
 * donc rien qui puisse lever.
 *
 * C'est la moitié que `PATCH /api/clips/:id` appelle après avoir écrit en base —
 * voir `FramingSource` pour ce que la séparation protège.
 */
export function framingWith(clip: Clip, source: FramingSource): ResolvedFraming {
  const { analysis, origin } = source
  if (analysis === null) return fallback(clip, origin === 'computed' ? 'no-analysis' : origin)

  const shots: Shot[] = analysis.shots
  const people: PersonBox[] = analysis.boxes
  const framing: ClipFraming = computeFraming({
    segments: clip.segments,
    shots,
    people,
    srcW: analysis.source.w,
    srcH: analysis.source.h,
    ratio: clip.ratio,
    cropMode: CROP_MODE,
  })

  // **Un clip dont aucun segment ne rencontre un plan n'a rien à cadrer.** Le
  // cas est atteignable : des segments hors de l'étendue analysée, ou un clip
  // vidé de tous ses mots. `computeFraming` rend alors une liste de plans vide,
  // et un rendu sans crop du tout ne veut rien dire — on se rabat, et on le dit.
  if (framing.shots.length === 0) return fallback(clip, 'no-shots')

  return { ...framing, origin: 'computed' }
}
