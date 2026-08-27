/**
 * La frontière entre l'interface et les données. **Le seul fichier qui sait d'où
 * elles viennent.**
 *
 * Il a été écrit contre des fixtures pendant que les routes n'existaient pas, en
 * pariant que le jour où elles arriveraient, seul ce fichier changerait. C'est
 * ce qui s'est passé : les corps sont devenus des `fetch`, les types n'ont pas
 * bougé d'une ligne, et aucun composant n'a été touché.
 *
 * ```
 * GET   /api/sources                        -> SourcesListing
 * GET   /api/sources/thumb?file=<nom>       -> image/jpeg
 * GET   /api/projects                       -> ProjectListItem[]
 * POST  /api/projects        { source, launch? } -> RunPlan  (201/202)
 * GET   /api/projects/:id                   -> ProjectStatus
 * POST  /api/projects/:id/run  { target }   -> RunPlan       (202)
 * POST  /api/projects/:id/stop              -> { stopped }
 * GET   /api/projects/:id/candidates        -> CandidateClip[]
 * GET   /api/clips/:id                      -> ClipDetail
 * PATCH /api/clips/:id       { ClipPatch }  -> PatchClipResult
 * POST  /api/clips/:id/export  { force? }   -> ExportResult
 * GET   /api/settings                       -> Settings
 * PUT   /api/settings        { SettingsPatch } -> Settings
 * GET   /api/llm/availability               -> LlmAvailability
 * GET   /api/publication/availability        -> Record<Platform, PlatformAvailability>
 * POST  /api/clips/:id/publish { platforms, force? } -> { publications: PublicationRow[] }
 * GET   /api/clips/:id/publications         -> { publications: PublicationView[] }
 * GET   /api/planning/pool                  -> { clips: PlanningPoolClip[] }
 * GET   /api/planning/schedule?from=<ms>&to=<ms>      -> { entries: ScheduledEntry[] }
 * POST  /api/planning/schedule { clipIds, scheduledAt } -> { entries: ScheduledEntry[] }
 * POST  /api/planning/unschedule { clipIds } -> { removed: number }
 * ```
 *
 * Les trois `POST` ont vécu sans appelant le temps d'une itération, et la chaîne
 * s'arrêtait là où ils manquaient : pas d'entrée pour créer un projet, pas de
 * relance, et un export qui ne se déclenchait qu'en `curl`.
 *
 * Les champs `string | null` — `CandidateClip.thumbnailUrl`, `proxyUrl`, les URL
 * de `ClipOutputs` — suivent tous la même règle. Le serveur les remplit quand
 * l'artefact est là et rend `null` sinon, jamais une URL morte : un projet créé
 * il y a trois secondes n'a ni proxy ni vignettes, et `null` a un rendu prévu et
 * testé à l'œil. `Source.thumbnailUrl` fait exception et n'est jamais `null` :
 * la source, elle, existe — c'est l'image qui peut manquer au bout, et la route
 * répond alors 404.
 *
 * **Les identifiants sont encodés.** Ceux des projets viennent du nom du fichier
 * d'origine, accents et espaces compris (spec §12), et ceux des clips en
 * héritent : `2026-01-11-méchante_000123456-000234567`. Sans encodage, la
 * moindre espace casserait l'URL.
 */

import type { Clip, ClipStatus, Ratio, Segment } from '@/core/edl'
import type { ClipFraming, FramingSettings, ShotFraming } from '@/core/framing'
import type { StepName } from '@/core/graph'
import type { HookSettings } from '@/core/hook'
import type {
  Platform,
  PlatformAvailability,
  PublicationRow,
  PublicationStatus,
  PublicationView,
} from '@/core/publication'
import type { TranscriptLine, WordCorrection } from '@/lib/editing'

export type { Clip, ClipStatus, Ratio, Segment }

/**
 * Le cadrage, **importé de `@/core/framing` plutôt que redit ici**, pour la même
 * raison que `StepName` l'est du graphe : deux exemplaires d'une même union ne
 * se contraignent pas, et celui qui prend du retard ne fait rien échouer — il
 * affiche seulement quelque chose de faux.
 *
 * `@/core/framing` est pur et sans dépendance ; les composants de clip
 * l'importent déjà pour `cropRect` et `outputSize`.
 */
export type { ClipFraming, ShotFraming }

/**
 * Les réglages `framing`, **importés de `@/core/framing` plutôt que redits
 * ici**, pour la raison qu'`HookSettings` documente juste en dessous : la PR
 * qui ajoute `framingStyle` à `Clip` (issue #180, seconde moitié) a besoin de
 * `FramingSettings` dans `src/core/edl.ts`, donc ce type ne peut pas être
 * authored ici sans que `src/core/**` finisse par importer `lib/api.ts` —
 * exactement le cycle que la frontière de pureté interdit.
 */
export { FRAMING_BOUNDS, FRAMING_SETTINGS_DEFAULTS } from '@/core/framing'
export type { FramingSettings } from '@/core/framing'

/**
 * Le hook, **importé de `@/core/hook` plutôt que redit ici**, pour la même
 * raison que `ClipFraming` l'est de `@/core/framing` deux lignes plus haut :
 * deux exemplaires du même type ne se contraignent pas.
 *
 * **La frontière de pureté impose le sens de cet import.** `src/core/hook.ts`
 * a besoin du type `Clip` (`Pick<Clip, 'hookText' | 'hookStyle'>` dans la
 * signature de `resolveHook`), donc `HookSettings` ne peut pas être défini ici
 * et importé par `core/hook.ts` : `tests/core/purete.test.ts` refuse à
 * `src/core/**` tout import qui ne commence pas par `./`, `@/core/` ou `zod` —
 * y compris un import de type. `HookSettings` est donc authored dans
 * `@/core/hook`, et ce fichier ne fait que le republier pour l'écran des
 * réglages et l'écran de clip, qui l'attendent ici comme le reste des types
 * partagés.
 */
export {
  HOOK_ALIGNMENTS,
  HOOK_BOUNDS,
  HOOK_DEFAULTS,
  HOOK_FONTS,
  HOOK_POSITIONS,
  HOOK_TRANSITIONS,
} from '@/core/hook'
export type { HookSettings } from '@/core/hook'

/**
 * D'où vient le cadrage qu'on publie.
 *
 * **Le champ existe parce que le silence était le vrai risque.** `renders` ne
 * dépend pas d'`analysis` dans le graphe (`src/core/graph.ts`), et c'est
 * délibéré : la dépendance ferait recalculer tous les rendus au premier
 * changement de modèle de détection. Rien ne garantit donc qu'un clip demandant
 * `auto` ait des plans sous la main — et se rabattre sans le dire sur le 9:16
 * centré de l'itération 0 produirait un cadrage plausible et faux, qui ne se
 * voit qu'à l'image, trois minutes d'export plus tard.
 *
 * - `computed` — les plans et les boîtes ont été lus, le ratio et les crops
 *   sortent de `computeFraming` ;
 * - `sans-analyse` — `analysis.json` n'est pas là : l'étape n'a pas tourné sur
 *   ce projet. Le cadrage vaut celui de l'itération 0, `ratio` résolu et le
 *   `cropX` du clip sur toute sa durée ;
 * - `analyse-illisible` — le fichier est là et ne suit pas son contrat, ou
 *   vient d'une autre version. Même repli, autre remède : relancer l'analyse ;
 * - `sans-plans` — l'analyse a été lue et aucun plan ne rencontre les segments
 *   du clip. Même repli, et le cas se produit sur un clip vidé de tous ses mots
 *   ou dont les segments tombent hors de l'étendue analysée.
 *
 * Les trois derniers se disent à l'écran. Le premier n'a rien à dire : c'est le
 * fonctionnement normal.
 */
export type FramingOrigin = 'computed' | 'no-analysis' | 'unreadable-analysis' | 'no-shots'

/**
 * Le cadrage d'un clip, tel que le serveur le publie.
 *
 * **Le ratio et les crops se recalculent sur les segments courants et ne sont
 * pas stockés.** Retirer le passage où un comédien traverse le plateau peut
 * faire retomber un 16:9 en 1:1, donc changer le ratio sous les doigts de celui
 * qui monte. C'est pour ça que `PATCH /api/clips/:id` le renvoie autant que
 * `GET` : sans cela l'écran garderait un ratio périmé jusqu'à la prochaine
 * navigation, et le montage mentirait sur ce que l'export produira.
 */
export type PublishedFraming = ClipFraming & { origin: FramingOrigin }

/**
 * Les étapes du graphe d'analyse (tâche 6), **importées de l'autorité** plutôt
 * que réécrites ici.
 *
 * Cette union a vécu recopiée à la main pendant deux itérations, et les deux
 * exemplaires ne se contraignaient pas : `analysis`, ajoutée au graphe par la
 * PR #31, manquait à celui-ci. Rien n'échouait — ni la compilation, ni les
 * tests —, seul l'écran le disait en affichant un libellé vide et un
 * `aria-label` « undefined en cours » (issue #39).
 *
 * **Importer `@/core/graph` d'ici ne franchit aucune frontière.** La règle de
 * pureté interdit à `src/core` de dépendre du reste du dépôt, pas l'inverse :
 * `tests/core/purete.test.ts` et le bloc `src/core/**` d'`eslint.config.mjs`
 * ne contrôlent que les fichiers de `src/core`. Ce fichier importe déjà
 * `@/core/edl` pour la même raison. Et le type ne coûte rien au paquet du
 * navigateur : `graph.ts` n'a aucune dépendance, et un `import type`
 * s'efface à la compilation.
 */
export type { StepName }

/**
 * Les étapes que le lanceur sait fabriquer.
 *
 * **`renders` n'en est pas**, et le serveur refuse en 400. Un rendu se demande
 * par clip (`exportClip`), parce que c'est par clip qu'on choisit le ratio, le
 * cadrage et les sous-titres. Le graphe garde l'étape parce qu'elle décrit une
 * dépendance réelle ; la nommer ici ferait proposer une cible qui rendrait un
 * plan vide, sans rien dire de pourquoi.
 */
export type RunTarget = Exclude<StepName, 'renders'>

/**
 * Ce que rend une demande d'analyse, création de projet comprise.
 *
 * **202 quand une analyse est lancée**, jamais 201 dans ce cas : ce que la
 * réponse confirme est qu'elle est acceptée et lancée, pas qu'elle est faite.
 * L'avancement se lit ensuite dans `ProjectStatus.running`, et l'échec éventuel
 * dans `ProjectStatus.error`. **Une création sans `launch` (23 août 2026, spec
 * §12) rend 201** — `shot` y est toujours vide, rien n'a démarré.
 */
export type RunPlan = {
  projectId: string
  /**
   * Les étapes qui vont tourner, dépendances remontées. **Un plan vide est une
   * réponse valide et fréquente** : tout était déjà là, il n'y avait rien à
   * faire. C'est là que se lit le saut d'étape — demander `candidates` sur un
   * projet déjà transcrit ne rend que `['candidates']`.
   */
  shot: StepName[]
}

/**
 * Un projet, vu du client.
 *
 * **Pas de `sourcePath`.** Le chemin du fichier existe côté serveur — il est
 * dans la table `projects` (tâche 6) — mais il ne traverse pas cette frontière :
 * aucun écran ne le lit, et le publier ici l'exposerait à tout consommateur de
 * l'API, y compris l'API externe de la spec §5, avec le point de montage et
 * l'organisation interne du Drive partagé dedans. Un type d'API est une
 * promesse : ce qu'il porte finit par sortir.
 */
export type ProjectSummary = {
  id: string
  /** Dérivé du nom de fichier d'origine, jamais d'un hachage (spec §12). */
  title: string
  durationSec: number
  createdAt: string
}

/**
 * Ce que le repérage n'a pas jugé.
 *
 * `null` quand la dernière exécution connue ne décrit aucune notation : elle ne
 * visait pas le repérage, ou elle s'est arrêtée avant de l'atteindre.
 *
 * **Il survit à un redémarrage du serveur**, contrairement à `running`. Le bilan
 * est calculé en mémoire mais écrit dans `status.json`, et rien ne le réécrit
 * tant qu'une nouvelle exécution ne tourne pas : ce qu'on lit après un
 * redémarrage décrit donc la dernière passe de repérage **écrite pour ce
 * projet**, et non une passe de ce processus-ci. C'est le comportement voulu —
 * le décompte qualifie les propositions qu'on a sous les yeux, qui sont elles
 * aussi d'hier. (relevé par Copilot)
 *
 * **Ce n'est pas cosmétique.** Sur `2025-06-15-cqlp`, quatre lots de fenêtres
 * sur onze reviennent `PROHIBITED_CONTENT` de façon reproductible : un tiers du
 * matériau est écarté sans être jugé, en silence. Sans ce champ, on trie
 * vingt-cinq cartes en croyant regarder ce que l'émission a de mieux, alors
 * qu'on regarde ce qu'elle a de mieux **dans les deux tiers qui ont été notés**
 * — et rien n'invite à aller chercher dans le tiers manquant (spec §7.2).
 */
export type SelectionReport = {
  /** Les fenêtres que la passe avait à noter. */
  windows: number
  /** Celles qui portent une note du modèle. */
  scored: number
  /** Les lots refusés par le filtre de sécurité, toutes profondeurs de découpe confondues. */
  rejectedBatches: number
  /** Les lots auxquels le modèle a répondu. */
  answeredBatches: number
  /**
   * La part de l'étendue du transcript couverte par les fenêtres notées, entre
   * 0 et 1. **L'union des intervalles, pas leur somme** : `buildWindows`
   * chevauche deux fenêtres consécutives d'environ 30 s, et le dernier lot est
   * plus court que les autres. Le dénominateur est l'étendue du transcript —
   * premier mot au dernier —, jamais la durée de l'émission : le silence n'est
   * pas de la matière qu'on aurait omis de juger.
   */
  coverage: number
  /**
   * Vrai quand la passe de repérage ne s'est pas terminée : `scored` décrit
   * alors ce qui avait été jugé au moment de l'arrêt.
   *
   * **Le sort de l'étape `candidates`, jamais celui de l'exécution qui la
   * porte** — et surtout pas du bilan seul, qui ne sait pas s'il est fini. Une
   * création vise `['candidates', 'proxy', 'analysis']` : le repérage finit en
   * trente secondes, le proxy tourne six minutes derrière lui, et l'analyse peut
   * échouer ensuite sans rien lui retirer. Un client qui refabriquerait ce
   * drapeau depuis un `error` et un `finishedAt` d'exécution afficherait donc
   * « décompte provisoire » sur un repérage complet — définitivement, si une
   * étape ultérieure tombe. Le serveur a déjà fait la déduction ; il n'y a rien
   * à recalculer ici. (relevé par Copilot)
   */
  partial: boolean
}

/**
 * L'état d'un projet : ce qui est déjà là, et ce qui tourne.
 *
 * `steps` est la **présence de l'artefact**, pas une clé de validité — c'est le
 * graphe de l'itération 0 (spec §4). `running` est `null` quand rien ne tourne,
 * et c'est ce que l'écran de tri interroge toutes les deux secondes tant qu'une
 * analyse est en cours.
 */
export type ProjectStatus = {
  project: ProjectSummary
  steps: Record<StepName, boolean>
  running: { step: StepName; progress: number } | null
  /**
   * L'échec de la **dernière exécution terminée**, ou `null` si elle s'est bien
   * passée — et `null` aussi tant que rien n'a jamais tourné.
   *
   * Sans lui, une analyse de quarante minutes qui échoue est indiscernable
   * d'une analyse qui n'a rien trouvé : `running` retombe à `null`, la liste
   * reste vide, et l'écran de tri annonce « aucun candidat ». Le lanceur rend
   * la main bien après la réponse 202, donc c'est le seul chemin par lequel un
   * échec de tâche de fond peut revenir jusqu'à l'écran.
   *
   * Le message est déjà épuré de ses chemins absolus, comme celui d'une réponse
   * d'erreur.
   */
  error: string | null
  /**
   * L'avertissement d'une correction du transcript tolérée, ou `null`.
   *
   * **Distinct d'`error` depuis les issues #137/#140.** Une correction dont le
   * modèle est resté injoignable n'empêche pas le repérage de tourner — le
   * repérage lit un texte non corrigé, mais il a fini —, et le confondre avec
   * `error` faisait dire « analyse en échec » à `finDAnalysis`
   * (`@/components/sources/announce`) sur une analyse qui a réussi. Même
   * contrat qu'`error` : `null` tant qu'une exécution tourne.
   */
  warning: string | null
  /**
   * Ce que le repérage n'a pas jugé, ou `null`.
   *
   * **À lire avec `error`, jamais seul** : le bilan décrit une notation
   * *tentée*. Le serveur a déjà fait ce croisement — c'est ce que porte
   * `partial` —, et l'écran n'a donc pas à le refaire ; il a en revanche à ne
   * pas présenter un décompte partiel comme un résultat.
   */
  selectionReport: SelectionReport | null
  /**
   * Vrai quand la dernière exécution s'est arrêtée parce qu'on le lui a demandé.
   *
   * **Le même champ que celui de `ProjectListItem`, tiré du même relevé.** Deux
   * écrans qui déduiraient la même chose par deux chemins différents finissent
   * par diverger, et celui-ci n'est pas dérivable : un arrêt ne laisse ni
   * `running`, ni `error`, ni artefact particulier.
   *
   * Faux pendant qu'une exécution tourne, comme `error`.
   */
  stopped: boolean
  /**
   * La taille du fichier source en octets, ou `null` tant que l'ingestion ne
   * l'a pas relevée.
   *
   * **Elle est là pour la seule chose qui en dépende** : `stepDurationRange`
   * (`src/core/phase.ts`) s'en sert pour suppléer la durée, qui manque
   * précisément au moment où le panneau d'avancement apparaît — un projet créé
   * il y a trois secondes n'a pas encore été sondé par ffprobe. Sans elle, la
   * branche existe et ne sert jamais, et le panneau se tait pendant la copie,
   * c'est-à-dire pendant l'étape la plus longue sur un fichier de 12 Go.
   *
   * **Sur `ProjectStatus` et non sur `ProjectSummary`** : la bibliothèque n'en
   * fait rien, et `summaryProject` documente qu'il porte quatre champs et pas un
   * de plus. La colonne, elle, est déjà en base.
   */
  sizeBytes: number | null
  /** Une exécution a-t-elle déjà eu lieu ? Distingue `analysis === 'new'` d'`'interrompu'` (spec §12). */
  everRan: boolean
}

/**
 * Un replay du dossier des sources, tel que la bibliothèque le propose.
 *
 * **La vignette est là depuis l'issue #41**, qui a mesuré ce que la vague
 * d'interface avait seulement supposé : médiane ~2,7 s par fichier, une seule
 * fois, parce que le résultat se met en cache. Ce qui rend ce chiffre possible
 * est `-ss` avant `-i` — voir `sourceThumbArgs`. La contradiction que ce
 * commentaire signalait entre la spec §12 et le code est donc close, et dans le
 * sens de la spec.
 */
export type Source = {
  /** Le nom du fichier dans `REPLAY_DIR`, tel que `createProject` l'attend — jamais un chemin. */
  name: string
  sizeBytes: number
  /** ISO 8601. */
  modifiedAt: string
  /**
   * Le projet déjà créé sur cette source, ou `null`. Une source analysée mène à
   * son projet au lieu de relancer une création : `createProject` est idempotent
   * sur ce cas, mais proposer deux chemins vers le même endroit sans le dire
   * fait douter de ce qu'on vient de déclencher.
   */
  projectId: string | null
  /**
   * L'image de la carte, servie par `GET /api/sources/thumb?file=…`.
   *
   * **Jamais `null`, contrairement à celle d'un candidat** (`CandidateClip`),
   * qui dépend d'un proxy pas encore encodé. Ici le fichier existe — la liste
   * vient de le mesurer —, donc l'URL vaut toujours la peine d'être demandée.
   * Ce qui peut manquer est l'image au bout, et la route répond 404 ; la carte
   * a son repli, exactement comme pour un candidat sans proxy.
   */
  thumbnailUrl: string
}

/**
 * Pourquoi le dossier des replays n'a pas pu être lu.
 *
 * **Un code énuméré, jamais un `errno` ni un message du système** : ce dépôt est
 * public, la valeur part sur le réseau, et « permission denied sur /mnt/j/… »
 * publierait un chemin de montage pour ne rien dire de plus. L'écran traduit le
 * code en une phrase et en **un** geste.
 *
 * Sans lui, `disponible: false` recouvrait quatre faits et la ligne de montage
 * devait énumérer les trois gestes possibles (issue #56, point 5). Deux cas le
 * rendaient franchement trompeur : un `REPLAY_DIR` mal orthographié **sous un
 * partage 9p sain** — `missing` le dit maintenant, là où `fstype: '9p'` faisait
 * conclure au transport mort — et un unique fichier aux droits refusés, qui fait
 * basculer tout le dossier et qui dit désormais `denied`.
 *
 * - `missing` — rien à ce chemin. Le cas le plus fréquent, et le plus mal
 *   diagnostiqué : une faute de frappe dans `REPLAY_DIR`.
 * - `denied` — les droits refusent le dossier, ou l'un de ses fichiers.
 * - `silent` — aucune réponse dans le délai de garde. C'est la signature du
 *   partage monté avec son transport mort dessous, que `/proc/mounts` ne
 *   distingue pas d'un partage sain.
 * - `unreadable` — le système de fichiers a rendu autre chose. `EIO`, `ESTALE`,
 *   `ENOTCONN` : les ranger de force dans une des trois autres cases ferait dire
 *   quelque chose de faux plutôt que quelque chose de vague.
 */
export type CauseUnavailable = 'absent' | 'denied' | 'silent' | 'unreadable'

/**
 * Ce que rend `GET /api/sources` : les replays, **et l'état du montage qui les
 * porte**.
 */
export type SourcesListing = {
  sources: Source[]
  /**
   * La ligne de montage. Elle existe pour que l'écran distingue « ce dossier est
   * vide » de « ce montage n'a pas eu lieu » — l'incident réel d'OpenShorts
   * (spec §12) : les deux rendaient la même page.
   */
  editing: {
    /** Faux quand le dossier des replays est absent, ou que son transport est mort. */
    available: boolean
    /** Pourquoi la lecture a échoué, ou `null` quand elle a réussi. */
    cause: CauseUnavailable | null
    /** Le type de système de fichiers relevé, ou `null` quand il n'a pas pu l'être. */
    fstype: string | null
    /** Les entrées du dossier, vidéos ou non. `0` avec `disponible: true` est un dossier vraiment vide. */
    entries: number
  }
}

/**
 * Un projet dans la bibliothèque : son résumé, et **ce que l'écran peut savoir
 * sans rien payer**.
 *
 * « Trois analyses en cours, une en échec » n'est pas dérivable d'un
 * `ProjectSummary`, et la forme évidente — un `GET /api/projects/:id` par projet
 * — est à écarter : elle multiplierait par vingt et un un appel qui exécute
 * `readingPresence`, lequel sonde le montage 9p avec un délai de garde. Quatre
 * fils du vivier de libuv suffisent à figer tout ce qui touche au disque dans le
 * serveur, analyse en cours comprise (spec §3.1).
 *
 * D'où le partage : la liste ne porte que **deux lectures gratuites**, et la
 * présence des artefacts se résout quand on ouvre le projet, là où le sondage se
 * paie de toute façon.
 */
export type ProjectListItem = ProjectSummary & {
  /** Ce qui tourne **dans ce processus**, ou `null`. Une lecture de `Map`. */
  running: { step: StepName; progress: number } | null
  /** L'échec de la dernière exécution terminée. Un petit fichier local. */
  error: string | null
  /**
   * L'avertissement d'une correction du transcript tolérée. Même fichier
   * qu'`error`, dans la même lecture — voir `ProjectStatus.warning`.
   *
   * **Publié pour `finDAnalysis`** (`@/components/sources/announce`), qui n'a
   * pas `steps` et distinguait mal une analyse en échec d'une analyse dont
   * seule la correction est à rattraper avant cette PR (issue #137).
   */
  warning: string | null
  /**
   * Vrai quand la dernière exécution s'est arrêtée parce qu'on le lui a demandé.
   *
   * **Il vient du même `status.json` qu'`error`**, dans la même lecture : la
   * liste ne paie donc toujours que deux relevés, et la décision de §3.1 tient.
   *
   * **Il est publié parce que la bibliothèque n'a pas `steps`.** L'écran de
   * projet déduit « interrompue » de `phaseProject`, qui lit le relevé de
   * présence ; la liste, elle, ne l'a pas — c'est exactement ce que le partage
   * ci-dessus lui refuse. Sans ce champ, une analyse arrêtée après l'ingestion
   * est indiscernable d'une analyse finie : elle ne tourne pas, elle n'a pas
   * d'erreur, et elle a une durée.
   *
   * **Faux pendant qu'une exécution tourne**, pour la raison exacte qui tait
   * `error` : ce qu'on afficherait serait l'arrêt d'avant, et deux écrans qui se
   * contredisent sur le même projet valent moins que pas d'écran du tout.
   */
  stopped: boolean
  /** Même fait que sur `ProjectStatus`, pour `showState` (`src/core/library.ts`). */
  everRan: boolean
}

/**
 * Un candidat, tel que l'écran de tri l'affiche.
 *
 * `preview` porte les trois premières phrases de l'extrait, préparées côté
 * serveur : les calculer ici obligerait à charger tout le transcript pour
 * afficher vingt-cinq cartes.
 *
 * Il n'y a **pas de champ `duration`** : elle se calcule par
 * `clipDuration(clip.segments)`. La porter ici en ferait une donnée à tenir
 * synchronisée, donc une donnée qui finirait par mentir après une coupe.
 */
export type CandidateClip = Clip & {
  preview: string
  thumbnailUrl: string | null
}

/**
 * Un clip et de quoi le monter.
 *
 * `indexed` couvre l'étendue du clip **plus une marge de contexte** de part et
 * d'autre : sans elle, on ne pourrait qu'enlever, jamais étendre. Les mots hors
 * segments — contexte compris — s'affichent barrés, et c'est la même règle pour
 * les deux, donc un seul cas à écrire.
 *
 * Cette fenêtre se calcule sur l'étendue d'origine du candidat, pas sur
 * `clip.segments` : retirer tous les mots d'un clip laisse une liste vide, et
 * une fenêtre dérivée de cette liste-là n'existerait plus — on perdrait le
 * transcript au moment précis où il faut le relire pour reconstruire le clip.
 * La route la lit dans `candidates.json`, l'artefact que le repérage écrit et
 * que l'édition ne réécrit pas.
 */
export type ClipDetail = {
  clip: Clip
  project: ProjectSummary
  lines: TranscriptLine[]
  proxyUrl: string | null
  /** Ce que l'export a produit, et où le lire. */
  outputs: ClipOutputs
  /**
   * Le cadrage résolu : le ratio de sortie et un crop par plan traversé.
   *
   * **Le serveur le calcule, le navigateur le consomme.** `computeFraming` a
   * besoin des plans, des boîtes de personnes et des dimensions de la source ;
   * `analysis.json` pèse deux à trois méga-octets par projet, et ce n'est pas au
   * navigateur de le charger pour dessiner un rectangle.
   */
  framing: PublishedFraming
}

/**
 * Les sorties d'un clip, en URL.
 *
 * **Jamais de chemin absolu du serveur** : c'est la même règle que pour
 * `ProjectSummary`, et pour la même raison — un type d'API est une promesse, et
 * ce qu'il porte finit par sortir. `POST /api/clips/:id/export` rend des noms de
 * fichiers ; ici ce sont des URL, directement lisibles par un `<video>` ou un
 * `<a>`.
 *
 * **`mp4Due` sépare deux `null` qui ne veulent pas dire la même chose non
 * plus, du côté du natif cette fois.** Le rendu natif est désactivé
 * (`RENDER_NATIVE`, `@/core/render-flags`) sur tout clip dont le ratio résolu
 * n'est pas déjà 9:16 — la variante 9:16 le remplace, personne ne récupère les
 * deux. `mp4Due === false` veut dire « n'existera jamais, la variante est le
 * livrable » ; `mp4Due === true` veut dire « c'est soit le seul livrable (ratio
 * déjà 9:16), soit il reste dû ».
 *
 * **Un clip a une ou deux vidéos**, et `variant9x16Due` dit laquelle des deux
 * situations on regarde quand `variant9x16Url` vaut `null` :
 *
 * - `variant9x16Due === false` — le ratio natif résolu est **déjà** 9:16, la
 *   variante à fond flouté serait le même cadre réencodé une seconde fois. Elle
 *   n'existera jamais, et son absence n'est pas une anomalie : une interface qui
 *   afficherait « rendu manquant » ici le ferait sur le clip le mieux livré de
 *   la bibliothèque ;
 * - `variant9x16Due === true` — elle est due. `null` veut alors dire « pas
 *   encore produite », et c'est un export qui reste à faire.
 *
 * Les deux ne montrent pas le même cadre, et c'est voulu (spec §11) : le natif
 * garde **un seul ratio** pour tout le clip — le plus large que ses plans
 * demandent —, parce qu'une vidéo de feed dont les bandes latérales
 * apparaîtraient et disparaîtraient serait le défaut que le fond flouté existe
 * pour éviter ; la variante 9:16 pose **chaque plan à son propre ratio** sur son
 * canevas vertical.
 */
export type ClipOutputs = {
  /**
   * Le rendu au ratio du clip.
   *
   * **`null` dit « pas de livraison à jour », pas « jamais exporté ».** Trois
   * situations le produisent, et une interface qui les confondrait annoncerait
   * un premier export là où il y en a eu un : le clip n'a jamais été rendu ; une
   * édition a périmé son rendu, qui l'a fait sortir d'`exported` ; ou le fichier
   * manque alors que le clip s'en réclame. Ce champ décrit ce qui est
   * disponible maintenant, jamais l'historique. (relevé par Copilot)
   */
  mp4Url: string | null
  /** Vrai quand le natif est dû — voir `mp4Due` au-dessus du type avant de lire `mp4Url === null`. */
  mp4Due: boolean
  /** La variante 9:16 sur fond flouté. Voir `variant9x16Due` avant de lire ce `null`. */
  variant9x16Url: string | null
  /** Vrai quand la variante 9:16 est **due**, c'est-à-dire quand le ratio natif ne l'est pas. */
  variant9x16Due: boolean
  /** Le `.txt` de publication : titre, description, mots-dièse. */
  textsUrl: string | null
}

/**
 * Ce qui s'édite sur un clip.
 *
 * Ni `id`, ni `projectId`, ni `pass` : ils identifient le clip et sa provenance,
 * ils ne se corrigent pas depuis l'interface. `PATCH /api/clips/:id` les refuse
 * — son schéma est strict — et normalise les segments avant écriture.
 */
export type ClipPatch = Partial<
  Pick<
    Clip,
    | 'segments'
    | 'ratio'
    | 'cropX'
    | 'title'
    | 'description'
    | 'captions'
    | 'branding'
    | 'hookText'
    | 'hookBadge'
    | 'hookStyle'
    | 'framingStyle'
  >
> & {
  /**
   * **`exported` est absent, et c'est délibéré.** Un clip devient exporté parce
   * qu'un MP4 a été produit (`POST /api/clips/:id/export`, tâche 14), jamais
   * parce que quelqu'un l'a écrit. Laisser le client poser ce statut
   * permettrait de marquer comme exporté un clip dont rien n'a été rendu, et
   * `mergeCandidates` le ferait alors survivre à toutes les passes suivantes.
   *
   * La route le refuse aussi : le type ne protège que ce dépôt-ci.
   */
  status?: Exclude<ClipStatus, 'exported'>
}

/**
 * Ce que rend `PATCH /api/clips/:id`.
 *
 * **`applied: false` est un cas nominal, pas un échec.** Il dit « une écriture
 * plus récente a gagné », et la réponse est un 200 : le serveur a fait son
 * travail, il a simplement refusé de remonter le temps. Une interface qui le
 * traiterait comme un échec afficherait « la sauvegarde a échoué » sur le clip
 * le mieux enregistré de la session, et réessaierait une écriture dont on vient
 * d'établir qu'elle est périmée. Le vrai échec, lui, lève une `ApiError`.
 *
 * `clip` porte toujours l'état de la base. Il n'y a donc jamais de relecture à
 * faire derrière, et l'adopter est le bon geste dans les deux cas.
 */
export type PatchClipResult = {
  /**
   * Faux dès qu'**un** champ de ce patch a été écarté parce qu'un geste plus
   * récent l'avait déjà touché. Les autres champs du même patch, eux, sont
   * écrits : l'ordre se compare champ par champ, parce que deux patches
   * partiels qui ne se recouvrent pas ne se contredisent sur rien.
   *
   * **Un appelant qui tient un état local doit s'y remettre d'accord**, et pas
   * seulement mettre son cache à jour. L'écran de clip garde ses segments, son
   * ratio et son crop dans un store séparé, et son enregistrement différé
   * compare cet état à `clip` : sans réconciliation, il verrait à nouveau un
   * écart, renverrait l'intention qu'on vient de refuser — avec un jeton neuf,
   * donc gagnant — et l'ordre qu'on a payé ne servirait à rien. Ignorer ce
   * booléen ne perd pas de données, il annule la garantie. (relevé par Copilot)
   */
  applied: boolean
  clip: Clip
  /**
   * Les sorties **après** cette écriture.
   *
   * Elles voyagent avec la réponse parce qu'un `PATCH` peut les faire
   * disparaître : remonter un clip déjà exporté écarte les MP4, qui décrivaient
   * le montage d'avant. Sans ce champ, un cache tenu par écriture optimiste
   * garderait l'URL d'un rendu qui n'existe plus, et le lecteur vidéo pointerait
   * sur un 404 jusqu'au prochain rechargement.
   */
  outputs: ClipOutputs
  /**
   * Le cadrage **après** cette écriture.
   *
   * Il voyage avec la réponse pour la même raison que les sorties, et le cas est
   * plus courant qu'elles : le ratio et les crops se recalculent sur les
   * segments, donc retirer un passage peut les changer sans qu'aucun geste de
   * cadrage n'ait été fait. Sans ce champ, l'écran garderait le ratio d'avant la
   * coupe jusqu'à la prochaine navigation, et le rectangle qu'il dessine ne
   * serait plus celui que ffmpeg découpera.
   */
  framing: PublishedFraming
  /**
   * Le plus grand jeton d'ordre que la base retient pour ce clip.
   *
   * `patchClip` le pose lui-même comme plancher : les jetons viennent de
   * l'horloge du navigateur, et une horloge remise en arrière produirait des
   * numéros inférieurs à ce que le serveur a déjà appliqué — donc des écritures
   * refusées jusqu'à ce que l'horloge rattrape. Une réponse suffit à recaler.
   */
  seq: number
}

/**
 * Ce que rend `POST /api/clips/:id/export`.
 *
 * **Des noms de fichiers, pas des URL.** Publier les chemins absolus du serveur
 * exposerait l'arborescence de la machine ; le nom suffit à reconnaître ce qui a
 * été produit. Pour *lire* les fichiers, c'est `ClipOutputs` que rend
 * `GET /api/clips/:id` — donc, après un export, une invalidation du clip.
 */
export type ExportResult = {
  /**
   * Le clip relu **après** le rendu : c'est `renderClip` qui pose le statut
   * `exported`, jamais un `PATCH`.
   *
   * **Facultatif, et ce n'est pas une précaution de style.** Le rendu dure de dix
   * secondes à une minute, et une passe de repérage qui se termine pendant ce
   * temps réécrit le jeu de clips du projet : `renderClip` prévoit explicitement
   * que le clip ait disparu à la relecture. La route sérialise alors un corps
   * sans ce champ. Le typer comme toujours présent ferait lire `clip.status` sur
   * `undefined` au retour d'un export par ailleurs réussi. (relevé par Copilot)
   */
  clip?: Clip
  /**
   * Le rendu au ratio natif du clip.
   *
   * `null` quand le rendu natif est désactivé (`RENDER_NATIVE`) ET qu'une
   * variante 9:16 le remplace — voir `RenderResult.mp4` côté serveur. Sur un
   * clip déjà en 9:16, il reste toujours produit : c'est alors l'unique
   * livrable. (relevé par Copilot)
   */
  mp4: string | null
  /** La variante 9:16 sur fond flouté, ou `null` quand le ratio natif est déjà 9:16. */
  variant9x16: string | null
  /** Le `.txt` : titre, description, mots-dièse. */
  texts: string
  /**
   * Vrai quand toutes les sorties étaient déjà là et que `force` ne les visait
   * pas. **C'est un cas nominal**, et le plus fréquent quand on rouvre un clip
   * déjà exporté : rien n'a été refait, tout est en place. Le traiter comme une
   * erreur ferait passer un export réussi pour un échec.
   */
  skipped: boolean
}

/**
 * L'échec d'un appel, avec le code que le serveur a rendu.
 *
 * Le code n'est pas décoratif — il porte les trois natures d'échec que la
 * tâche 9 distingue : 422 quand le fournisseur refuse le matériel (rien à
 * réessayer), 503 quand un service est en panne (tout à réessayer), 500 quand
 * c'est un défaut du programme.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Le message d'échec, tel que le serveur l'a formulé.
 *
 * Les routes rendent `{ error }` ; une page d'erreur de Next, un mandataire ou
 * une coupure ne rendent pas de JSON du tout. Le repli sur le code HTTP existe
 * pour ce cas — sans lui, l'échec serait avalé par une exception d'analyse
 * dans le gestionnaire d'erreur lui-même.
 */
async function failure(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`.trim()
  try {
    const body: unknown = await response.json()
    const text = (body as { error?: unknown } | null)?.error
    if (typeof text === 'string' && text !== '') message = text
  } catch {
    // Corps vide ou non JSON : le code suffit.
  }
  return new ApiError(response.status, message)
}

async function lire<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as T
}

/**
 * Un `POST` avec un corps JSON. Pas de `keepalive` ici, contrairement à
 * `patchClip` : ces trois-là se déclenchent sur un geste explicite dont on
 * attend la réponse à l'écran, pas dans le dos d'une page qui se ferme.
 */
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as T
}

export function listProjects(): Promise<ProjectListItem[]> {
  return lire<ProjectListItem[]>('/api/projects')
}

export function getProject(projectId: string): Promise<ProjectStatus> {
  return lire<ProjectStatus>(`/api/projects/${encodeURIComponent(projectId)}`)
}

/**
 * Les replays disponibles, et l'état du montage qui les porte.
 *
 * **Un échec du montage n'est pas un échec de la requête** : la réponse est un
 * 200 dont `montage.disponible` vaut faux. C'est ce qui permet à l'écran de dire
 * « le dossier des replays n'est pas monté » et le geste qui le répare, au lieu
 * d'afficher une erreur qui ne distingue rien.
 */
export function listSources(): Promise<SourcesListing> {
  return lire<SourcesListing>('/api/sources')
}

/**
 * Ingère un replay, sans lancer son analyse — `launch` n'est pas envoyé,
 * donc reste au défaut `false` du serveur (spec §12).
 *
 * @param source Le nom du fichier dans `REPLAY_DIR`, jamais un chemin absolu.
 */
export function createProject(source: string): Promise<RunPlan> {
  return post<RunPlan>('/api/projects', { source })
}

/**
 * Recalcule jusqu'à une ou plusieurs cibles : le serveur remonte les
 * dépendances, refait ce qui manque, et s'arrête là.
 *
 * **Une cible nomme un résultat à atteindre, pas une étape à refaire**, et
 * c'est pourquoi la forme à plusieurs cibles existe. Viser `candidates` seul ne
 * construit jamais le proxy : rien n'en dépend dans le graphe — le transcript
 * lit le WAV, pas la vidéo. Le bouton de reprise laisserait alors le projet
 * dans l'impasse dont il devait le sortir. Voir `RESUME_TARGETS`.
 *
 * La forme à une cible reste valide, et c'est délibéré : elle couvre le cas le
 * plus fréquent — relancer le repérage — sans obliger chaque appelant à écrire
 * un tableau d'un élément.
 *
 * `force` refait une étape dont l'artefact est pourtant présent — `true` vaut
 * « les cibles », ce qui couvre le cas courant : relancer le repérage pour
 * obtenir d'autres propositions sans avoir changé un paramètre.
 */
export function runProject(
  projectId: string,
  targets: RunTarget | readonly RunTarget[],
  force?: boolean | readonly RunTarget[],
): Promise<RunPlan> {
  return post<RunPlan>(`/api/projects/${encodeURIComponent(projectId)}/run`, {
    target: targets,
    force,
  })
}

/**
 * Les cibles d'une reprise : les mêmes que celles d'une création.
 *
 * Recopiées ici plutôt qu'importées : `TARGETS_INITIAL` vit dans
 * `src/server/run.ts`, et l'importer ferait entrer du code serveur dans le
 * paquet du navigateur. La duplication est délibérée et un test la garde.
 */
export const RESUME_TARGETS: readonly RunTarget[] = ['candidates', 'proxy', 'analysis']

export function listCandidates(projectId: string): Promise<CandidateClip[]> {
  return lire<CandidateClip[]>(`/api/projects/${encodeURIComponent(projectId)}/candidates`)
}

export function getClip(clipId: string): Promise<ClipDetail> {
  return lire<ClipDetail>(`/api/clips/${encodeURIComponent(clipId)}`)
}

/**
 * **`keepalive: true`, et c'est tout l'intérêt de cette fonction.**
 *
 * L'écran de clip vide son enregistrement différé sur `pagehide`, c'est-à-dire
 * au moment où le navigateur s'apprête à abandonner la page. Une requête
 * ordinaire lancée là est tuée avec elle : la dernière modification avant une
 * fermeture d'onglet se perdrait — le défaut même que ce vidage existe pour
 * éviter. Avec `keepalive`, le navigateur la mène à terme après la page.
 *
 * La contrepartie est une limite de 64 kio sur le corps, largement au-dessus de
 * ce qu'un patch transporte : une poignée de segments et trois champs de texte.
 *
 * **`seq` date l'intention, pas l'envoi.** C'est un argument à part et non un
 * champ de `ClipPatch` : rien de ce qu'il porte ne s'édite sur un clip, il ne
 * fait que voyager avec. L'appelant qui l'omet renonce à l'ordre — le serveur
 * écrit alors sans rien comparer, ce qui est le bon comportement pour un script
 * dont les écritures ne se chevauchent pas.
 */
export async function patchClip(
  clipId: string,
  patch: ClipPatch,
  seq?: number,
): Promise<PatchClipResult> {
  const response = await fetch(`/api/clips/${encodeURIComponent(clipId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    // `undefined` ne survit pas à `JSON.stringify` : sans jeton, le corps est
    // exactement celui d'avant.
    body: JSON.stringify({ ...patch, seq }),
    keepalive: true,
  })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as PatchClipResult
}

/**
 * Rend un clip. **Synchrone, et long : de dix secondes à une minute.**
 *
 * C'est la seule fonction de ce fichier qui fasse attendre. L'analyse dure trois
 * quarts d'heure et passe par un lanceur qu'on interroge ; un export mesure
 * quelques dizaines de secondes — 4,58x le temps réel en NVENC, pour un clip qui
 * en dure vingt à quarante — et la réponse arrive quand les fichiers sont sur le
 * disque. Un bouton muet pendant tout ce temps passe pour cassé : l'attente est
 * à montrer, pas à absorber.
 *
 * **Le ré-export est un cas nominal.** Sans `force`, un clip dont toutes les
 * sorties sont déjà là rend `skipped: true` et rien n'est refait. C'est la
 * réponse la plus fréquente dès qu'on rouvre un clip exporté, et elle veut dire
 * « tout est en place » — pas « ça n'a pas marché ».
 */
export function exportClip(clipId: string, force?: boolean): Promise<ExportResult> {
  return post<ExportResult>(`/api/clips/${encodeURIComponent(clipId)}/export`, { force })
}

/**
 * Régénère le hook du clip par le modèle, et l'écrit — `POST /api/clips/:id/hook`.
 *
 * Aucun corps à envoyer : le contexte (titre, description, transcript du
 * clip) se construit côté serveur, à partir de ce que le clip porte déjà.
 * Rend le clip **tel qu'écrit**, `hookText` inclus — c'est ce que
 * `useRegenerateHook` (`@/lib/queries`) pose dans le cache, à la place d'un
 * second aller-retour pour relire ce qu'on vient de recevoir.
 */
export function postRegenerateHook(clipId: string): Promise<{ clip: Clip }> {
  return post<{ clip: Clip }>(`/api/clips/${encodeURIComponent(clipId)}/hook`, {})
}

// ---------------------------------------------------------------------------
// Les réglages, et l'arrêt d'une analyse
// ---------------------------------------------------------------------------

/**
 * Ce qui dimensionne le repérage (spec §7, « Combien on en garde »).
 *
 * **Les cinq champs sont ceux de `SelectionDimensions`** (`src/core/transcript.ts`),
 * et un test tient les deux formes ensemble dans les deux sens : ce type est une
 * promesse d'API, celui-là est l'argument d'un calcul pur, et ils ne peuvent pas
 * diverger sans qu'un réglage cesse d'être lu.
 *
 * **Les noms de champs sont anglais depuis la migration de la table
 * `settings`** (`src/server/db.ts`, `migrateSelectionSettingKeys`) : ils sont
 * **persistés** sous des clés `selection.<champ>`, et une base ouverte avant
 * cette migration porte encore les anciens noms français — la migration les
 * réécrit à l'ouverture, en conservant leur valeur.
 *
 * **Les défauts ne sont pas recopiés ici.** `fetchSettings` rend les réglages
 * *effectifs* — la base complétée par les défauts —, donc l'écran affiche ce qui
 * s'applique vraiment plutôt qu'une copie de constantes qui vieillirait à part.
 */
export type SelectionSettings = {
  /** Une proposition attendue par tranche de tant de minutes de parole. */
  minutesPerClip: number
  /** Combien de fenêtres sont examinées pour chaque clip demandé. */
  windowsPerClip: number
  /** Plancher absolu de clips, pour que les sources courtes sortent de la zone morte. */
  minimumClips: number
  /** Plancher absolu de fenêtres examinées. */
  minimumWindows: number
  /** Plafond absolu de clips. `0` veut dire « aucun ». */
  maximumClips: number
}

/**
 * Tous les réglages, par famille.
 *
 * **Une famille et pas un objet plat**, alors qu'il n'y en a qu'une aujourd'hui :
 * les clés sont stockées préfixées depuis la PR #64, en prévoyant explicitement
 * que d'autres suivent — l'intelligence artificielle par usage et les défauts du
 * hook (retour d'usage §6.1 et §6.3). Aplatir maintenant ferait renommer chaque
 * clé le jour où la deuxième arrive.
 */
/**
 * Les trois fournisseurs de modèles de langage que l'application sait choisir
 * par usage (retour d'usage §6.1).
 *
 * **Un seul endroit les énumère**, ici : `LLM_PROVIDERS` en est la forme
 * exécutable — pour un `<select>`, une validation — et `LlmProvider` la forme
 * typée. Les deux se dérivent l'une de l'autre pour ne pas diverger.
 */
export const LLM_PROVIDERS = ['gemini', 'openai', 'ollama'] as const
export type LlmProvider = (typeof LLM_PROVIDERS)[number]

/**
 * Le fournisseur et le modèle de chaque usage de langage, plus l'adresse d'un
 * serveur Ollama.
 *
 * **Plat, comme `SelectionSettings`, et pour la même raison** : la clé stockée
 * est `${famille}.${nom}` sur deux niveaux, donc une forme imbriquée
 * demanderait une traduction que personne ne tiendrait à jour.
 *
 * `selection` désigne ici l'usage « repérage », comme le label `area:selection`
 * du dépôt — à ne pas confondre avec `Settings.selection`, qui porte les
 * dimensions du repérage. Les deux cohabitent déjà dans le vocabulaire du
 * projet.
 *
 * **Les trois sont branchés.** `selection*` alimente le repérage, `hook*` la
 * génération du hook (`POST /api/clips/:id/hook`), `correction*` la
 * correction automatique du transcript — appliquée d'office pendant
 * l'analyse depuis le 23 août 2026 (`case 'correction'`, `src/server/run.ts`),
 * plus par un appel client dédié — dernier des trois, retour d'usage §6.1.
 */
export type AiSettings = {
  selectionProvider: LlmProvider
  selectionModel: string
  correctionProvider: LlmProvider
  correctionModel: string
  hookProvider: LlmProvider
  hookModel: string
  /** Vide = résoudre la passerelle WSL à l'exécution. */
  ollamaBaseUrl: string
}

/**
 * Le défaut de `copySourceLocally`, partagé entre le registre serveur
 * (`INGESTION_FIELD_SHAPES`, `src/server/db.ts`) et l'écran de réglages
 * (`IngestionSection`), comme `DEFAULT_SELECTION_DIMENSIONS` l'est pour
 * `SelectionSection`.
 *
 * **Une seule source, pas deux qui doivent rester d'accord.** Si le défaut
 * changeait sans passer par cette constante, le bouton « Revenir au défaut »
 * écrirait une valeur périmée et sa visibilité mentirait sur ce qui a
 * effectivement changé.
 */
export const DEFAULT_COPY_SOURCE_LOCALLY = true

/**
 * Ce qui décide de la façon dont une source est amenée jusqu'à ffmpeg.
 *
 * **Un seul champ, et il gouverne toute la chaîne** — le proxy, l'audio, le
 * relevé des dimensions et l'export d'un clip. Un réglage qui ne vaudrait que
 * pour l'analyse laisserait l'export recopier douze gigaoctets dans le dos de
 * quelqu'un qui vient précisément de dire qu'il n'en voulait pas.
 */
export type IngestionSettings = {
  /**
   * Copier la source dans `stage/` avant de l'exploiter. **Coché par défaut.**
   *
   * Vrai : on paie une recopie — 45 s pour 4,3 Go depuis le Drive — puis toutes
   * les étapes lisent un fichier local. Faux : rien n'est dupliqué, et chaque
   * étape relit l'original. Le §5 du retour d'usage mesure que l'extraction
   * audio y devient « extrêmement lente » quand l'original est hors du système
   * de fichiers de WSL ; elle ne l'est pas quand il est déjà sur un disque
   * rapide, et c'est le cas que ce réglage existe pour servir.
   *
   * **Il gouverne la fabrication d'une copie, pas son usage** : une copie déjà
   * présente dans `stage/` continue de servir, parce que la lire est strictement
   * plus rapide et ne coûte rien. Décocher n'efface rien — le TTL de huit heures
   * s'en charge.
   */
  copySourceLocally: boolean
}

/**
 * Le connecteur choisi pour une plateforme, ou `auto` pour laisser l'ordre de
 * priorité du registre décider (`adapterFor`, `src/server/publication/index.ts`).
 *
 * **Dupliqué à dessein plutôt qu'importé** d'`AdapterId`
 * (`src/server/publication/adapter.ts`) : ce module est client-safe, ce
 * module serveur ne l'est pas — même motif que `DEFAULT_MODEL` dans
 * `ai-section.tsx`.
 */
export type PublicationPreference = 'auto' | 'meta' | 'upload-post' | 'tiktok'

/** Le défaut de toute préférence `publication.<plateforme>` — jamais un autre littéral `'auto'` récrit à côté. */
export const DEFAULT_PUBLICATION_PREFERENCE: PublicationPreference = 'auto'

/**
 * Les choix admis par plateforme. Chaque champ ne porte que les connecteurs
 * qui la couvrent réellement — TikTok direct existe désormais (spec §2.3) et
 * rejoint Meta et Upload Post dans ce tableau.
 *
 * `as const satisfies` plutôt qu'une annotation `Record<Platform, …>` : ça
 * garde chaque tableau à ses littéraux, ce qui permet à `PublicationSettings`
 * de dériver un type par champ plutôt que l'union des quatre.
 */
export const PUBLICATION_ADAPTER_CHOICES = {
  instagram: ['auto', 'meta', 'upload-post'],
  facebook: ['auto', 'meta', 'upload-post'],
  tiktok: ['auto', 'tiktok', 'upload-post'],
  youtube: ['auto', 'upload-post'],
} as const satisfies Record<Platform, readonly PublicationPreference[]>

/**
 * Quel connecteur porte chaque plateforme — un champ par plateforme, `auto`
 * par défaut. Le défaut reproduit l'ordre de priorité du registre à
 * l'identique : Meta avant Upload Post sur Instagram et Facebook, gratuit et
 * cent publications par 24 h contre dix par mois (`CLAUDE.md`, issue #146).
 *
 * **Chaque champ dérive de `PUBLICATION_ADAPTER_CHOICES`**, pas de
 * `PublicationPreference` en entier : un patch `{ youtube: 'meta' }` — que
 * l'API refuse à l'exécution, faute d'adaptateur Meta sur YouTube — est
 * désormais rejeté au typage aussi.
 */
export type PublicationSettings = {
  [P in Platform]: (typeof PUBLICATION_ADAPTER_CHOICES)[P][number]
} & {
  /** Jusqu'à quatre `HH:MM` séparés par des virgules, du plus récemment employé au plus ancien. */
  scheduleHours: string
  /** L'ordonnanceur publie-t-il ? La tâche planifiée tourne quand même et n'écrit rien si c'est faux. */
  autoPublish: boolean
}

/** Le défaut de `publication.scheduleHours` — jamais un autre littéral `'19:00'` récrit à côté. */
export const DEFAULT_SCHEDULE_HOURS = '19:00'

export type Settings = {
  selection: SelectionSettings
  ai: AiSettings
  ingestion: IngestionSettings
  hook: HookSettings
  publication: PublicationSettings
  framing: FramingSettings
}

/** Un patch : les familles et les champs qu'on veut changer, pas les autres. */
export type SettingsPatch = {
  selection?: Partial<SelectionSettings>
  ai?: Partial<AiSettings>
  ingestion?: Partial<IngestionSettings>
  hook?: Partial<HookSettings>
  publication?: Partial<PublicationSettings>
  framing?: Partial<FramingSettings>
}

/**
 * Les réglages effectifs : ce que porte la base, complété par les défauts.
 *
 * C'est la seule source de vérité côté écran. Recopier `DEFAULT_SELECTION_DIMENSIONS`
 * dans un composant ferait afficher le défaut du code là où la base porte autre
 * chose, et personne ne verrait la différence avant le premier repérage.
 */
export function fetchSettings(): Promise<Settings> {
  return lire<Settings>('/api/settings')
}

/**
 * Applique un patch partiel et rend les réglages **résultants**.
 *
 * `PUT` et non `PATCH` : la sémantique est bien celle d'une fusion, mais la
 * route ne porte aucun jeton d'ordre — contrairement à `patchClip`, dont le
 * `seq` existe parce que deux écritures d'un même clip peuvent se doubler. Ici
 * la dernière écriture gagne, ce qui est le comportement voulu d'un formulaire
 * de réglages.
 *
 * **Une clé inconnue et une valeur hors bornes sont des 400**, pas des
 * enregistrements silencieux. Une clé mal orthographiée ne serait jamais relue,
 * et l'écran jurerait avoir enregistré.
 *
 * **Changer un réglage ne recalcule rien** (retour d'usage §6.1) : un recalcul
 * reste une action explicite, `runProject`.
 */
export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  const response = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as Settings
}

/**
 * Arrête l'analyse en cours sur un projet. **Idempotent.**
 *
 * `stopped: false` n'est pas un échec : c'est ce qu'on obtient quand rien ne
 * tournait — parce que l'analyse venait de finir, ou parce qu'un redémarrage du
 * serveur a emporté l'exécution avec lui. Le bouton peut donc se cliquer deux
 * fois sans que l'écran ait à décider lequel des deux clics comptait.
 *
 * **Ce n'est pas une pause.** Le travail en cours est tué ; ce qui est déjà sur
 * le disque reste, et la reprise (`runProject`) repart à la première étape
 * manquante. Un `status.json` d'arrêt ne porte pas d'erreur : un arrêt demandé
 * n'est pas une panne, et l'écran ne doit pas l'afficher comme telle.
 */
export function stopAnalysis(projectId: string): Promise<{ stopped: boolean }> {
  return post<{ stopped: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/stop`, {})
}

// ---------------------------------------------------------------------------
// Le transcript de l'émission (vue Émission, §2.3)
// ---------------------------------------------------------------------------

/**
 * Le transcript entier, pas la fenêtre de 120 s que `ClipDetail.lines` porte
 * autour d'un clip. Une route à part : `GET /api/projects/:id/candidates` ne
 * sert pas ces ~20 000 mots-là, et n'a aucune raison de commencer.
 *
 * Rend une liste vide, jamais une erreur, quand le projet n'a pas encore de
 * transcript — c'est l'état normal entre l'ingestion et la transcription.
 */
export function getTranscript(projectId: string): Promise<TranscriptLine[]> {
  return lire<TranscriptLine[]>(`/api/projects/${encodeURIComponent(projectId)}/transcript`)
}

/** Une correction manuelle, adressée à une phrase précise du transcript. */
export type TranscriptCorrectionRequest = WordCorrection & { lineId: string }

/**
 * Ce que rend une correction acceptée : la phrase telle qu'écrite sur le
 * disque, et les clips que son empan recouvre.
 *
 * **`clipsTouched` existe pour rendre une conséquence explicite** (§2.3) :
 * corriger un mot dans une phrase déjà montée ne périme pas son rendu — le
 * mécanisme d'empreinte ne compare pas encore le texte —, donc rien n'avertit
 * ailleurs qu'un export déjà fait porte encore l'ancien sous-titre. Nommer les
 * clips ici, au moment même de la correction, est ce que cette réponse peut
 * faire sans une seconde mécanique d'invalidation.
 */
export type TranscriptCorrectionResult = {
  line: TranscriptLine
  clipsTouched: { id: string; title: string }[]
}

/**
 * Corrige une phrase du transcript. **La forme est un empan de mots
 * remplacé par un autre, jamais du texte libre** — `CLAUDE.md`, tableau des
 * décisions à ne pas défaire : « la correction renvoie des substitutions
 * indexées, pas du texte ». Voir `WordCorrection` (`src/lib/editing.ts`) pour
 * ce que l'empan décide des timings.
 *
 * **409 quand le texte a changé sous les yeux** (`expected` ne correspond
 * plus) : ce n'est pas un échec à réessayer tel quel, c'est le transcript
 * qu'il faut relire d'abord.
 */
export function correctTranscript(
  projectId: string,
  correction: TranscriptCorrectionRequest,
): Promise<TranscriptCorrectionResult> {
  return post<TranscriptCorrectionResult>(
    `/api/projects/${encodeURIComponent(projectId)}/transcript`,
    correction,
  )
}

/**
 * Une substitution appliquée par la correction automatique — l'historique de
 * relecture (spec §9, correction du 23 août 2026). La correction s'applique
 * désormais d'office pendant l'analyse ; ce que l'écran offre après coup,
 * c'est de voir et de défaire, plus de proposer.
 */
export type CorrectionEntry = {
  /** Unique pour la durée de vie du journal (`correction.json`), à passer tel quel à `undoCorrection`. */
  id: string
  lineId: string
  from: number
  expected: string[]
  replacement: string
  /** Le début du mot corrigé, en secondes. */
  timecode: number
}

/**
 * L'historique des corrections déjà appliquées — `GET
 * /api/projects/:id/transcript/correction`.
 * @returns Une liste vide, jamais une erreur, tant que la correction n'a pas
 * encore tourné sur ce projet.
 */
export function getCorrectionHistory(projectId: string): Promise<CorrectionEntry[]> {
  return lire<CorrectionEntry[]>(`/api/projects/${encodeURIComponent(projectId)}/transcript/correction`)
}

/** Ce que rend `undoCorrection` : le journal après retrait, et les clips touchés par le mot rétabli. */
export type UndoCorrectionResult = {
  entries: CorrectionEntry[]
  clipsTouched: { id: string; title: string }[]
}

/**
 * Défait une substitution du journal — `POST
 * /api/projects/:id/transcript/correction/undo`. L'inverse, par le même
 * chemin d'écriture que la correction manuelle, mêmes gardes.
 *
 * **409 pendant une exécution**, comme `correctTranscript` : une
 * retranscription en cours écraserait le sidecar derrière un défaire qui
 * vient de s'annoncer réussi.
 */
export function undoCorrection(projectId: string, id: string): Promise<UndoCorrectionResult> {
  return post<UndoCorrectionResult>(
    `/api/projects/${encodeURIComponent(projectId)}/transcript/correction/undo`,
    { id },
  )
}

/**
 * Retire une entrée de l'historique sans toucher au transcript — `POST
 * /api/projects/:id/transcript/correction/remove`.
 *
 * **Le rattrapage de dernier recours** (issues #134, #138), à côté de
 * `undoCorrection` plutôt qu'à sa place : une entrée dont l'ancre est devenue
 * périmée ne se défait plus jamais, et resterait sinon affichée sans qu'on
 * puisse s'en débarrasser. Ce geste n'écrit que sur le journal.
 */
export function removeCorrectionEntry(projectId: string, id: string): Promise<{ entries: CorrectionEntry[] }> {
  return post<{ entries: CorrectionEntry[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/transcript/correction/remove`,
    { id },
  )
}

// ---------------------------------------------------------------------------
// La disponibilité des fournisseurs de langage
// ---------------------------------------------------------------------------

/**
 * Ce que sait dire le serveur d'un fournisseur, sans jamais renvoyer le
 * secret lui-même.
 *
 * **Gemini et OpenAI portent une clé, Ollama non** — c'est un serveur local,
 * pas un compte. `available` vaut donc toujours `true` pour Ollama : rien à
 * vérifier ici, l'échec éventuel est celui de la passerelle ou du serveur, pas
 * d'une clé absente, et il se découvre à l'appel comme n'importe quelle panne
 * réseau.
 */
export type LlmProviderAvailability = { available: boolean; reason: string | null }

export type LlmAvailability = Record<LlmProvider, LlmProviderAvailability>

/**
 * La disponibilité des trois fournisseurs, **pour la dire avant d'en avoir
 * besoin** (retour d'usage §6.1 : « le dire dans l'écran, pas au milieu d'un
 * repérage »).
 *
 * Une seule requête pour les trois : l'écran des réglages les affiche
 * ensemble, et une clé absente ne coûte rien à vérifier — c'est justement
 * l'inverse d'un appel réseau au fournisseur.
 */
export function fetchLlmAvailability(): Promise<LlmAvailability> {
  return lire<LlmAvailability>('/api/llm/availability')
}

// ---------------------------------------------------------------------------
// La publication
// ---------------------------------------------------------------------------

/**
 * Une ligne de `publications` telle que le serveur la rend — importée de
 * `@/core/publication` plutôt que redite, pour la même raison que
 * `ClipFraming`/`HookSettings` ci-dessus. (relevé par Aristarque)
 */
export type { PublicationRow }

/** Quelle plateforme est branchée aujourd'hui — `GET /api/publication/availability`. */
export function fetchPublicationAvailability(): Promise<Record<Platform, PlatformAvailability>> {
  return lire<Record<Platform, PlatformAvailability>>('/api/publication/availability')
}

/**
 * Lance une publication — `POST /api/clips/:id/publish`. Rend aussitôt les
 * lignes `in_progress` ; le résultat définitif s'écrit plus tard, lu par
 * `getPublications`.
 */
export function publishClip(
  clipId: string,
  platforms: readonly Platform[],
  force?: boolean,
): Promise<{ publications: PublicationRow[] }> {
  return post<{ publications: PublicationRow[] }>(`/api/clips/${encodeURIComponent(clipId)}/publish`, {
    platforms,
    force,
  })
}

/** L'état de chaque publication d'un clip — `GET /api/clips/:id/publications`. */
export function getPublications(clipId: string): Promise<{ publications: PublicationView[] }> {
  return lire<{ publications: PublicationView[] }>(`/api/clips/${encodeURIComponent(clipId)}/publications`)
}

// ---------------------------------------------------------------------------
// Le planning (spec du 26 août 2026)
// ---------------------------------------------------------------------------

/** Un clip du vivier : exporté, à jour, pas encore programmé. */
export type PlanningPoolClip = {
  clipId: string
  projectId: string
  title: string
  /** La durée du montage, en secondes. */
  duration: number
  /** La vignette tirée du proxy, `null` quand le proxy manque. */
  thumbnailUrl: string | null
  description: string
  /** Ce que l'export a produit, et où le lire. */
  outputs: ClipOutputs
  /** Ce qui est déjà parti, par plateforme. */
  statuses: Partial<Record<Platform, PublicationStatus>>
}

/** Une échéance posée, telle que le calendrier la lit. */
export type ScheduledEntry = {
  clipId: string
  projectId: string
  title: string
  /** L'échéance, en ms depuis l'époque. */
  scheduledAt: number
  statuses: Partial<Record<Platform, PublicationStatus>>
  /** Le rendu sur le disque ne correspond plus au montage courant. */
  stale: boolean
}

/** Les clips exportés, à jour, pas encore programmés — `GET /api/planning/pool`. */
export function listPlanningPool(): Promise<PlanningPoolClip[]> {
  return lire<{ clips: PlanningPoolClip[] }>('/api/planning/pool').then((r) => r.clips)
}

/** Le calendrier entre deux bornes (ms, `to` exclu) — `GET /api/planning/schedule`. */
export function listPlanningSchedule(from: number, to: number): Promise<ScheduledEntry[]> {
  return lire<{ entries: ScheduledEntry[] }>(`/api/planning/schedule?from=${from}&to=${to}`).then(
    (r) => r.entries,
  )
}

/** Pose une échéance sur les quatre plateformes de chaque clip — `POST /api/planning/schedule`. */
export function schedulePublication(
  clipIds: readonly string[],
  scheduledAt: number,
): Promise<ScheduledEntry[]> {
  return post<{ entries: ScheduledEntry[] }>('/api/planning/schedule', { clipIds, scheduledAt }).then(
    (r) => r.entries,
  )
}

/** Retire une échéance encore `planned` — `POST /api/planning/unschedule`. */
export function unschedulePublication(clipIds: readonly string[]): Promise<number> {
  return post<{ removed: number }>('/api/planning/unschedule', { clipIds }).then((r) => r.removed)
}
