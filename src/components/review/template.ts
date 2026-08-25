/**
 * Le modèle de l'écran de tri : ce que les composants lisent, et qui ne dépend
 * ni du DOM ni du réseau.
 *
 * Il vit à côté des composants qui s'en servent, pas dans `src/core/` : il
 * connaît `@/lib/api` — donc une forme de réponse HTTP — et il compose des
 * phrases d'interface. Ce qui est en revanche vrai partout — la définition de
 * « gardé », les comptes du fil de tri, la phase — est dans `@/core/phase`
 * et n'est pas recopié ici.
 */

import type { ClipStatus } from '@/core/edl'
import type { StepName } from '@/core/graph'
import { isDiscarded, isGuard, type Phase } from '@/core/phase'
import type { SelectionReport } from '@/lib/api'

/**
 * Les trois vues du tri.
 *
 * `atrier`, `gardes`, `ecartes` et le paramètre `?vue=` sont un contrat gelé :
 * un signet garde l'ancienne valeur, et `viewSinceUrl` retombe
 * **silencieusement** sur `atrier` — traduire casserait ce signet sans qu'aucun
 * test ni log ne le dise. Verrouillé par `tests/components/review/template.test.ts`,
 * `tests/components/review/project-screen.test.tsx` et
 * `tests/components/show/transcript-panel.test.tsx`.
 */
export type View = 'atrier' | 'gardes' | 'ecartes'

export const VIEWS: readonly { value: View; label: string }[] = [
  { value: 'atrier', label: 'À trier' },
  { value: 'gardes', label: 'Gardés' },
  { value: 'ecartes', label: 'Écartés' },
]

/**
 * La vue nommée par l'URL, ou celle par défaut.
 *
 * **La vue active vit dans l'URL** (`?vue=gardes`) parce qu'un rechargement doit
 * rendre le même écran. La position de défilement et le focus, eux, restent en
 * session : une position de défilement dans une URL est une URL qu'on ne peut
 * plus partager.
 *
 * Tout ce qui n'est pas l'une des trois retombe sur « à trier » : une URL se
 * recopie et se bricole, et une valeur inconnue doit rendre un écran plutôt
 * qu'une page vide.
 */
export function viewSinceUrl(value: string | null): View {
  return VIEWS.some((v) => v.value === value) ? (value as View) : 'atrier'
}

/** Le clip appartient-il à cette vue ? */
export function belongs(status: ClipStatus, view: View): boolean {
  if (view === 'gardes') return isGuard(status)
  if (view === 'ecartes') return isDiscarded(status)
  return status === 'candidate'
}

/**
 * Les identifiants d'une vue, **dans l'ordre reçu**.
 *
 * L'ordre des candidats est celui du repérage, qui suit l'émission. Le
 * réordonner ferait perdre le fil de ce qu'on vient de voir.
 *
 * Des identifiants et non des clips : c'est cette liste que l'écran fige au
 * changement de vue pour qu'une carte décidée ne bouge pas sous la main, et une
 * liste de clips figée porterait aussi des statuts périmés.
 */
export function idsForView(
  clips: readonly { id: string; status: ClipStatus }[],
  view: View,
): string[] {
  return clips.filter((c) => belongs(c.status, view)).map((c) => c.id)
}

/**
 * Ce que l'écran dit de ce que le repérage n'a pas jugé.
 *
 * **Ce n'est pas décoratif** (spec §7.2). Sur `2025-06-15-cqlp`, quatre lots sur
 * onze reviennent refusés par le filtre de sécurité de Gemini : un tiers du
 * matériau est écarté **sans être jugé, en silence**. Sans ce mot à l'écran, on
 * trie vingt-cinq cartes en croyant regarder ce que l'émission a de mieux, alors
 * qu'on regarde ce qu'elle a de mieux dans les deux tiers qui ont été notés.
 *
 * Trois règles portent cette fonction :
 *
 * - **on dit ce qu'on a mesuré.** Le serveur compte des **lots**, et « sept lots
 *   sur onze » ne font 64 % de rien : les fenêtres se chevauchent d'environ 30 s
 *   et le dernier lot est plus court. `coverage` est la vraie mesure — l'union
 *   des fenêtres notées rapportée à l'étendue du transcript —, donc c'est elle
 *   qui porte la phrase ; les lots ne viennent qu'en explication ;
 * - **ça ne porte pas de fausse action.** `buildWindows` et le découpage en lots
 *   sont déterministes, et le serveur traite le refus comme reproductible : une
 *   seconde passe soumettrait exactement les mêmes charges pour se faire refuser
 *   pareil. On énonce la perte, on ne feint pas de la réparer ;
 * - **`provisional` vient du serveur**, qui le calcule sur le sort de l'étape
 *   `candidates` et non sur celui de l'exécution qui la porte. Le refabriquer
 *   depuis `error` marquerait provisoire un repérage complet dès qu'une étape
 *   ultérieure tombe.
 */
export type DetectionWord = {
  /** Vrai quand une part du matériau n'a pas été jugée. */
  loss: boolean
  /** Vrai quand la passe ne s'est pas terminée : le décompte est provisoire. */
  provisional: boolean
  /** La phrase principale, celle qui vit à côté du compte. */
  phrase: string
  /** Ce qui la cause, ou `null` quand rien de plus n'est su. */
  detail: string | null
}

export function detectionWord(summary: SelectionReport | null): DetectionWord | null {
  if (summary === null) return null

  const provisional = summary.partial

  // Aucune fenêtre à noter : un transcript vide, ou une passe qui n'a rien eu à
  // soumettre. Pas de dénominateur, donc pas de pourcentage.
  if (summary.windows <= 0) {
    return { loss: false, provisional, phrase: 'Le repérage n’avait aucune fenêtre à noter.', detail: null }
  }

  // **Sur les fenêtres, jamais sur les lots refusés.** Le second terme a vécu
  // ici et c'était un défaut (issue #57) : depuis que le repérage recoupe les
  // lots refusés par le filtre de sécurité et les resoumet un à un — le cas
  // *normal*, livré par la PR #30 —, `scored === windows` avec `rejectedBatches > 0`
  // est la situation courante. L'écran annonçait alors une perte qui n'existe
  // pas, dans une phrase qui se contredit : « n'a jugé que 100 % … 83 fenêtres
  // sur 83 ». Un lot refusé et jamais rattrapé tombe déjà dans ce prédicat,
  // puisqu'il laisse des fenêtres non notées ; les lots ne viennent qu'en
  // explication, comme le dit le docblock plus haut.
  const loss = summary.scored < summary.windows
  if (!loss) {
    return {
      loss: false,
      provisional,
      phrase:
        summary.windows === 1
          ? 'Le repérage a noté la fenêtre de l’émission.'
          : `Le repérage a noté les ${summary.windows} fenêtres de l’émission.`,
      detail: null,
    }
  }

  // **Arrondi vers le bas.** Au plus proche, 99,6 % s'affiche « 100 % » et
  // dément la perte que la même phrase annonce deux mots plus loin. Vers le bas,
  // 100 % ne sort que d'une couverture exacte — ce qui arrive : deux fenêtres
  // voisines se chevauchant, celle du milieu peut manquer sans laisser de trou.
  const part = Math.max(0, Math.min(100, Math.floor((summary.coverage || 0) * 100)))

  const batches = summary.rejectedBatches + summary.answeredBatches
  const detail =
    summary.rejectedBatches > 0
      ? `${summary.rejectedBatches === 1 ? '1 lot de fenêtres' : `${summary.rejectedBatches} lots de fenêtres`} sur ${batches} ${
          summary.rejectedBatches === 1 ? 'a été refusé' : 'ont été refusés'
        } par le filtre de sécurité du modèle. Le découpage est déterministe : une nouvelle passe soumettrait les mêmes lots et obtiendrait le même refus.`
      : null

  return {
    loss: true,
    provisional,
    phrase: `Le repérage n’a jugé que ${part} % de ce qui se dit dans l’émission : ${summary.scored} ${
      summary.scored === 1 ? 'fenêtre' : 'fenêtres'
    } sur ${summary.windows}.`,
    detail,
  }
}

/**
 * Un compte et son nom, accordés.
 *
 * Le français accorde au singulier jusqu'à un exclu compris : « 0 clip gardé »,
 * « 1 clip gardé », « 2 clips gardés ». La règle est écrite ici parce que
 * l'écran de tri l'applique à quatre comptes qui bougent à chaque décision, et
 * qu'un `n > 1 ? 's' : ''` recopié quatre fois finit par en oublier un.
 */
export function agreement(n: number, singular: string, plural: string): string {
  return `${n} ${n <= 1 ? singular : plural}`
}

/**
 * Où va le panneau d'avancement, et s'il y va.
 *
 * **C'est l'invariant de la spec §2.3, écrit une fois** : la phase choisit ce
 * que l'écran met en avant, elle ne retire jamais ce qui existe. Trois
 * relectures successives ont trouvé trois façons différentes de le violer, ce
 * qui veut dire que le défaut n'est pas dans une valeur de phase mais dans la
 * manière de s'en servir — d'où une fonction, plutôt qu'une condition recopiée
 * dans un fichier de page.
 *
 * - `'panneau'` : il occupe la page. **Seulement quand la grille serait vide**,
 *   et seulement s'il reste quelque chose à fabriquer. C'est le régime 1 des
 *   trois premières minutes, et c'est aussi là que se pose le bouton de reprise
 *   quand l'exécution est morte ;
 * - `'bande'` : il se replie dans la barre d'application. Dès qu'il y a quelque
 *   chose à trier, la grille passe devant — les six minutes d'encodage du proxy
 *   sont six minutes pendant lesquelles on travaille déjà ;
 * - `'rien'` : plus rien ne tourne et la grille se suffit. Le cas
 *   `{ interrompu, trie }` tombe ici : un repérage forcé perdu par un
 *   redémarrage laisse les clips gardés en base, et un panneau d'attente
 *   mangerait le travail qu'on vient de faire. La reprise, elle, reste offerte
 *   à côté de la liste — c'est une surface propre de l'écran, pas une
 *   conséquence de la phase.
 */
export type Layout = 'panel' | 'strip' | 'none'

export function layoutProgress(
  phase: Phase,
  running: { step: StepName; progress: number } | null,
  gridEmpty: boolean,
): Layout {
  if (gridEmpty && phase.analysis !== 'complete') return 'panel'
  // Sans exécution, une bande ne montrerait la progression de rien.
  return running === null ? 'none' : 'strip'
}
