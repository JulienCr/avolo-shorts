/**
 * La phase d'un projet, et le vocabulaire des étapes.
 *
 * **Le parcours n'appartient pas à l'utilisateur, il appartient au projet.** Le
 * projet est un objet de longue durée dont l'avancement est un fait du serveur
 * — quels artefacts existent, quels clips sont décidés —, pas un souvenir du
 * navigateur. L'humain y entre, en sort, y revient le lendemain.
 *
 * D'où la forme : une fonction pure, calculée à chaque rendu, jamais stockée.
 * La stocker en base créerait une seconde vérité, et c'est elle qui finirait par
 * mentir. D'où aussi l'emplacement : `src/core/`, avec la frontière de pureté
 * qui va avec — ce fichier ne connaît que `@/core/graph` et `@/core/edl`.
 */

import { clipDuration, type ClipStatus, type Segment } from '@/core/edl'
import type { StepName } from '@/core/graph'

/**
 * `exported` compte comme gardé : c'est une décision humaine qui a déjà produit
 * un fichier, pas une proposition en attente. `mergeCandidates` le traite
 * d'ailleurs pareil — il survit à une nouvelle passe de repérage.
 *
 * **La définition vit ici et nulle part ailleurs.** Elle a longtemps vécu dans
 * `src/lib/clip-status.ts`, qui la ré-exporte, et elle en est sortie le jour où
 * `phaseProjet` en a eu besoin : la frontière de pureté interdit à `src/core`
 * d'importer `src/lib`, et la recopier ici aurait rendu deux endroits à un
 * module qui existe précisément parce qu'ils divergeaient.
 */
export function estGarde(status: ClipStatus): boolean {
  return status === 'kept' || status === 'exported'
}

export function estEcarte(status: ClipStatus): boolean {
  return status === 'discarded'
}

/** Ce que la machine a produit. Des artefacts, jamais une activité. */
export type Analyse =
  | 'attente' // les candidats manquent, une exécution tourne
  | 'interrompu' // il manque une étape et rien ne tourne
  | 'echec' // la dernière exécution a échoué
  | 'triable' // candidats présents, proxy absent : on trie, on ne monte pas
  | 'complet' // candidats et proxy présents

/**
 * Ce que l'humain a décidé. **Les quatre valeurs se testent dans cet ordre**, et
 * la première qui répond gagne : les conditions ne sont pas disjointes prises
 * séparément, l'ordre est ce qui les rend exclusives.
 */
export type Travail =
  | 'rien' // la liste est vide
  | 'atrier' // sinon, au moins une proposition reste indécise
  | 'livre' // sinon, au moins un clip gardé, et tous ont un rendu à jour
  | 'trie' // sinon : tout est décidé, il reste à monter ou à exporter

export type Phase = { analyse: Analyse; travail: Travail }

/**
 * La phase d'un projet : deux axes, pas un.
 *
 * L'erreur qui vient d'abord est d'aligner tous les états sur une seule échelle.
 * Elle ne tient pas : un projet peut être entièrement trié alors que son proxy
 * n'est pas fini, et un projet complet peut n'avoir aucune décision prise. Ce
 * que la machine fabrique et ce que l'humain décide avancent séparément.
 *
 * **L'invariant, et il vaut mieux que les préconditions qui suivent : la phase
 * choisit ce que l'écran met en avant, elle ne retire jamais ce qui existe.**
 * Trois relectures ont trouvé trois façons différentes de le violer, ce qui veut
 * dire que le défaut n'est pas dans une valeur mais dans la manière de s'en
 * servir. Le panneau d'avancement remplace la grille **seulement quand la grille
 * serait vide** ; le reste du temps il se replie en bande, et un échec s'affiche
 * en bandeau.
 *
 * Quatre propriétés, chacune payée par une relecture :
 *
 * - **il n'y a pas de valeur `neuf`.** `créerProjet` appelle `lancer` avant de
 *   répondre, et `lancer` pose sa réservation avant son premier `await` : un
 *   projet que le client peut voir a toujours quelque chose qui tourne, ou
 *   quelque chose sur le disque. « Aucun artefact, aucune exécution » ne décrit
 *   pas un projet neuf, mais une exécution morte — donc `interrompu` ;
 * - **`interrompu` et `echec` ne s'appliquent que tant que `candidates` est
 *   absent.** Sans cette précondition ils recouvrent `triable` : une exécution
 *   interrompue pendant l'encodage du proxy cacherait la grille de tri au moment
 *   précis où elle doit remplacer le panneau. Passé ce point, un échec ne décrit
 *   plus ce que l'écran peut faire, il décrit un incident : il s'affiche à côté ;
 * - **`triable` teste la présence de l'artefact, pas son contenu.** C'est le
 *   graphe de l'itération 0, où « à jour » veut dire « le fichier est là ». Un
 *   `candidates.json` vide donne `{ triable, rien }`, et c'est l'axe `Travail`
 *   qui porte le vide. Cette séparation est la raison d'être des deux axes ;
 * - **`{ attente, trie }` est atteignable.** `effacerArtefact`
 *   (`src/server/steps/candidates.ts`) retire `candidates.json` **avant** de
 *   toucher à la base : pendant un repérage forcé, les clips gardés sont
 *   toujours là et toujours montables.
 *
 * Enfin, **elle ne cite que les deux étapes qui changent ce que l'utilisateur
 * peut faire** : `candidates` ouvre le tri, `proxy` ouvre le montage. Les autres
 * ne sont que du temps qui passe. Ce n'est pas le transcript qui ouvre le tri,
 * même s'il le précède : la liste reste vide jusqu'à la fin du repérage. Nommer
 * l'étape qui produit l'artefact qu'on affiche est la seule formulation qui
 * survive à l'ajout d'étapes.
 */
export function phaseProjet(
  steps: Record<StepName, boolean>,
  running: { step: StepName; progress: number } | null,
  erreur: string | null,
  clips: readonly { status: ClipStatus }[],
): Phase {
  return { analyse: analyseProjet(steps, running, erreur), travail: travailProjet(clips) }
}

function analyseProjet(
  steps: Record<StepName, boolean>,
  running: { step: StepName; progress: number } | null,
  erreur: string | null,
): Analyse {
  // `=== true` et non la vérité de la valeur : le relevé arrive du réseau, et
  // une étape que le client ne connaît pas encore y vaut `undefined`.
  if (steps.candidates === true) return steps.proxy === true ? 'complet' : 'triable'

  // **Une exécution en cours l'emporte sur l'échec de la précédente.** `erreur`
  // décrit la dernière exécution *terminée* ; tant qu'une autre tourne, ce que
  // l'écran doit dire est ce qui se passe, pas ce qui s'est passé.
  if (running !== null) return 'attente'
  return erreur !== null ? 'echec' : 'interrompu'
}

function travailProjet(clips: readonly { status: ClipStatus }[]): Travail {
  // **Une cascade ordonnée, et l'ordre fait partie du contrat.** Écrites comme
  // quatre prédicats indépendants, les conditions se recouvrent : une liste vide
  // satisfait aussi « plus aucune proposition en attente », et `livre` mordrait
  // sur `atrier` dès le premier clip gardé rendu alors que d'autres propositions
  // restent indécises.
  if (clips.length === 0) return 'rien'
  if (clips.some((c) => c.status === 'candidate')) return 'atrier'

  // **`livre` exige au moins un clip gardé** : « tous les clips gardés sont
  // exportés » est vrai d'une liste vide, et après avoir tout écarté la phase
  // terminale annonçait un livrable alors qu'aucun MP4 n'existe.
  //
  // Et il se lit sur `status === 'exported'`, sans champ de plus.
  // `écarterRenduPérimé` (`src/server/steps/render.ts`, appelé par le `PATCH`)
  // fait sortir le clip de cet état dès qu'un champ que l'encodage consomme
  // change — segments, ratio, cadrage, sous-titres, marque —, et `sortiesDuClip`
  // rend quatre `null` dès que le statut n'est plus `exported`, effacement des
  // fichiers réussi ou non. La conception a tenu `livre` pour indisponible faute
  // d'un champ de fraîcheur ; la vague de l'export avait déjà satisfait la
  // demande, et ses §2.3 et §9.4 sont amendées depuis.
  const gardes = clips.filter((c) => estGarde(c.status))
  if (gardes.length > 0 && gardes.every((c) => c.status === 'exported')) return 'livre'

  return 'trie'
}

/** Une étape, telle que le panneau d'avancement la montre. */
export type ÉtapeDécrite = {
  nom: StepName
  libelle: string
  /**
   * Le coût **mesuré**, en secondes, sur une émission d'1 h 40. `null` quand
   * personne ne l'a mesuré : on n'affiche alors rien plutôt qu'une estimation.
   *
   * **On affiche le coût d'une étape, jamais le temps qu'il reste.** Le coût est
   * une mesure ; le restant est une extrapolation à partir de deux points sur
   * une seule émission, et une estimation fausse coûte plus cher qu'une absence
   * d'estimation.
   */
  coûtSec: number | null
}

/**
 * **Exhaustif** : ajouter une étape au graphe sans venir ici casse le
 * type-check.
 *
 * C'est le correctif de fond d'#39, et il transforme le prochain oubli en erreur
 * de compilation au lieu d'un `aria-label` « undefined en cours ». Le symptôme
 * qui l'a révélé est réel : `analysis` manquait à la table écrite dans un
 * fichier de page, et l'écran affichait un libellé vide pendant toute l'analyse
 * d'un projet neuf.
 */
export const LIBELLES_ETAPES: Record<StepName, string> = {
  proxy: 'Proxy',
  audio: 'Audio',
  transcript: 'Transcription',
  analysis: 'Analyse d’image',
  candidates: 'Repérage',
  renders: 'Rendus',
}

/**
 * Les étapes dans leur ordre d'exécution attendu.
 *
 * **L'ordre n'est pas décoratif** :
 * `CIBLES_INITIALES = ['candidates', 'proxy', 'analysis']` (`src/server/run.ts`)
 * et `planPourCibles` déroule donc audio, transcript, candidats, **puis** proxy,
 * puis l'analyse d'image qui en dépend. Les candidats arrivent avant les images,
 * et c'est ce fait-là — pas une durée — qui fait exister l'état « triable mais
 * pas montable ».
 *
 * **`renders` n'y est pas.** Un rendu se demande par clip
 * (`POST /api/clips/:id/export`), jamais par le graphe : le lanceur refuse
 * `renders` comme cible, et `RunTarget` l'exclut pour la même raison. L'annoncer
 * dans un panneau d'avancement décrirait une étape qui n'y passera jamais.
 *
 * Les coûts viennent de `ROADMAP.md`, mesurés le 18 août 2026 sur
 * `2025-06-15-cqlp.mp4` (4,3 Go, 1 h 39).
 */
export const ÉTAPES: readonly ÉtapeDécrite[] = [
  { nom: 'audio', libelle: LIBELLES_ETAPES.audio, coûtSec: 6 },
  { nom: 'transcript', libelle: LIBELLES_ETAPES.transcript, coûtSec: 101 },
  { nom: 'candidates', libelle: LIBELLES_ETAPES.candidates, coûtSec: 30 },
  { nom: 'proxy', libelle: LIBELLES_ETAPES.proxy, coûtSec: 360 },
  // Livrée par la PR #31 et jamais chronométrée sur une émission entière.
  { nom: 'analysis', libelle: LIBELLES_ETAPES.analysis, coûtSec: null },
]

/**
 * Les trois comptes du fil de tri, et la durée gardée.
 *
 * **Le reste à faire, pas le chemin parcouru.** « 12 à trier » se lit d'un coup
 * d'œil et reste vrai quand on change d'avis ; « 60 % » ne survit pas à un
 * retour en arrière, parce que le dénominateur — le nombre de clips gardés — ne
 * se connaît qu'à la fin de la boucle.
 */
export function compter(clips: readonly { status: ClipStatus; segments: Segment[] }[]): {
  aTrier: number
  gardes: number
  ecartes: number
  dureeGardee: number
} {
  const gardes = clips.filter((c) => estGarde(c.status))
  return {
    aTrier: clips.filter((c) => c.status === 'candidate').length,
    gardes: gardes.length,
    ecartes: clips.filter((c) => estEcarte(c.status)).length,
    dureeGardee: gardes.reduce((total, c) => total + clipDuration(c.segments), 0),
  }
}

// ---------------------------------------------------------------------------
// Ce que l'attente coûte, sur **cette** émission
// ---------------------------------------------------------------------------

/**
 * Une durée annoncée : deux bornes, jamais un point.
 *
 * **La fourchette n'est pas une coquetterie, c'est le fond de la chose.** Chaque
 * étape n'a été chronométrée qu'**une fois**, sur une seule émission, sur une
 * machine dont `CLAUDE.md` documente 40 à 80 % de variance d'une exécution à
 * l'autre — le planificateur de Windows place les vCPU où il veut sur une
 * topologie hybride. Annoncer « 2 min 17 s restantes » affirmerait une précision
 * qu'aucune de ces mesures ne porte ; « environ 2–3 min » dit ce qu'on sait.
 */
export type Fourchette = { basseSec: number; hauteSec: number }

/**
 * Ce qu'on connaît de l'émission au moment d'annoncer une durée. **Les trois
 * champs sont nullables, et chacun l'est pour une raison différente.**
 *
 * - `durationSec` manque tant que l'ingestion n'a pas sondé la source : c'est
 *   l'état d'un projet créé il y a trois secondes, c'est-à-dire exactement le
 *   moment où le panneau d'avancement apparaît ;
 * - `sizeBytes` est ce qui reste alors, puisque la liste des replays l'a mesuré
 *   sans ouvrir le fichier. Il ne sert qu'à **suppléer** la durée, et la
 *   fourchette qui en découle est deux fois plus large — voir `MARGE_SUR_TAILLE` ;
 * - `fenêtres` ne se connaît qu'une fois le transcript découpé, et le repérage
 *   est la seule étape dont le coût s'y indexe plutôt que sur la durée.
 */
export type TailleÉmission = {
  durationSec: number | null
  sizeBytes: number | null
  fenêtres: number | null
}

/**
 * L'émission de référence : `2025-06-15-cqlp.mp4`, 4,3 Go, 1 h 39, mesurée le
 * 18 août 2026 (`ROADMAP.md`, « Ce qui le prouve »).
 *
 * Toutes les constantes qui suivent sont des **rapports** tirés de cette unique
 * mesure. Les écrire ainsi plutôt qu'en secondes est tout l'objet de ce bloc :
 * les cinq `coûtSec` d'`ÉTAPES` annonçaient les mêmes chiffres à une capsule de
 * vingt minutes et à un live de deux heures et demie.
 */
const RÉFÉRENCE = {
  duréeSec: 5940,
  octets: 4_300_000_000,
  /** Les 83 fenêtres de notation de cette émission-là. */
  fenêtres: 83,
} as const

/**
 * Ce qu'une seconde d'émission coûte à chaque étape, en secondes.
 *
 * **`analysis` n'y est pas, et c'est la même abstention qu'`ÉTAPES`** : elle n'a
 * jamais été chronométrée sur une émission entière. Mieux vaut ne rien annoncer
 * qu'annoncer une estimation qui n'est adossée à rien. `renders` non plus — un
 * rendu se demande par clip, jamais par le graphe.
 */
const DÉBITS: Partial<Record<StepName, number>> = {
  // 6 s. La seule étape dont le résultat tienne toujours sous la minute.
  audio: 6 / RÉFÉRENCE.duréeSec,
  // 1 min 41, soit 59x le temps réel.
  transcript: 101 / RÉFÉRENCE.duréeSec,
  // 6 min, soit 16,4x le temps réel. La plus longue, et de loin.
  proxy: 360 / RÉFÉRENCE.duréeSec,
}

/** 30 s de repérage pour 83 fenêtres notées. */
const SEC_PAR_FENÊTRE = 30 / RÉFÉRENCE.fenêtres

/**
 * Combien de fenêtres une seconde d'émission produit, **quand on ne les a pas
 * encore comptées**.
 *
 * Le fenêtrage pose une fenêtre de 90 s tous les 60 s de *transcript*, ce qui
 * donnerait 99 fenêtres pour l'émission de référence ; elle en a 83, parce que
 * la parole n'occupe pas tout le déroulé (spec §7 : l'écart du premier mot au
 * dernier surestime la matière de 19 à 21 %). On prend donc le rapport mesuré,
 * pas le rapport théorique.
 */
const FENÊTRES_PAR_SECONDE = RÉFÉRENCE.fenêtres / RÉFÉRENCE.duréeSec

/** Le débit vidéo de l'émission de référence, pour suppléer une durée absente. */
const OCTETS_PAR_SECONDE = RÉFÉRENCE.octets / RÉFÉRENCE.duréeSec

/**
 * La demi-largeur de la fourchette, en part de l'estimation.
 *
 * **Ce n'est pas un intervalle de confiance** — une mesure unique n'en permet
 * aucun. C'est un refus de la fausse précision, calibré sur ce qu'on sait de la
 * dispersion : `CLAUDE.md` établit qu'un écart de moins de 10 % n'est pas
 * mesurable sur cette machine, et que la variance d'une exécution à l'autre
 * monte à 40 à 80 %.
 */
const MARGE = 0.25

/**
 * La même, quand la durée elle-même est déduite de la taille du fichier.
 *
 * Le débit d'encodage des replays n'a jamais été relevé sur plus d'un fichier :
 * une source plus ou moins compressée que la référence décalerait la durée
 * déduite d'autant, et la fourchette doit le porter.
 */
const MARGE_SUR_TAILLE = 0.5

/** La durée exploitable, et si elle a fallu la déduire de la taille. */
function duréeEstimée(taille: TailleÉmission): { sec: number; déduite: boolean } | null {
  if (taille.durationSec !== null && Number.isFinite(taille.durationSec) && taille.durationSec > 0) {
    return { sec: taille.durationSec, déduite: false }
  }
  if (taille.sizeBytes !== null && Number.isFinite(taille.sizeBytes) && taille.sizeBytes > 0) {
    return { sec: taille.sizeBytes / OCTETS_PAR_SECONDE, déduite: true }
  }
  return null
}

function encadrer(sec: number, marge: number): Fourchette {
  return { basseSec: Math.max(0, sec * (1 - marge)), hauteSec: sec * (1 + marge) }
}

/**
 * Ce qu'une étape va coûter sur cette émission-ci, ou `null` si on n'en sait
 * rien.
 *
 * **Additive : `ÉTAPES` et ses `coûtSec` restent** le temps que l'écran bascule.
 * Les deux tables ne divergeront pas longtemps — celle-ci les remplace — mais
 * les retirer d'un même mouvement casserait le panneau d'avancement, qui vit
 * dans une autre livraison.
 *
 * `null` a trois causes, et elles se valent toutes les trois pour l'appelant :
 * l'étape n'a jamais été chronométrée (`analysis`), elle ne passe pas par le
 * graphe (`renders`), ou l'émission n'a encore livré ni durée ni taille. Dans
 * les trois cas on n'affiche rien, ce qui est la règle déjà posée par
 * `ÉtapeDécrite.coûtSec`.
 */
export function fourchetteDÉtape(étape: StepName, taille: TailleÉmission): Fourchette | null {
  const durée = duréeEstimée(taille)

  if (étape === 'candidates') {
    // **Le repérage se compte en fenêtres, pas en minutes.** Un décompte réel
    // est plus juste que n'importe quelle extrapolation depuis la durée : deux
    // émissions de même longueur n'ont pas la même quantité de parole, et c'est
    // la parole qui fait les fenêtres.
    const compte =
      taille.fenêtres !== null && Number.isFinite(taille.fenêtres) && taille.fenêtres > 0
        ? { valeur: taille.fenêtres, marge: MARGE }
        : durée === null
          ? null
          : {
              valeur: durée.sec * FENÊTRES_PAR_SECONDE,
              marge: durée.déduite ? MARGE_SUR_TAILLE : MARGE,
            }
    return compte === null ? null : encadrer(compte.valeur * SEC_PAR_FENÊTRE, compte.marge)
  }

  const débit = DÉBITS[étape]
  if (débit === undefined || durée === null) return null
  return encadrer(durée.sec * débit, durée.déduite ? MARGE_SUR_TAILLE : MARGE)
}
