'use client'

import { ChevronRight, Film, LoaderCircle, Play, RotateCcw, TriangleAlert, Unplug } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'

import { formatDateSource, formatOctets } from '@/components/sources/textes'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import type { EntréeBibliothèque, ÉtatÉmission } from '@/core/bibliotheque'
import { LIBELLES_ETAPES } from '@/core/parcours'
import type { ProjectListItem, Source } from '@/lib/api'
import { formatDuration } from '@/lib/format'
import { lienProjet } from '@/lib/parcours'
import { cn } from '@/lib/utils'

/** Une entrée de bibliothèque telle que les écrans la manipulent. */
export type Entrée = EntréeBibliothèque<Source, ProjectListItem>

/**
 * Une création de projet, vue par la bibliothèque.
 *
 * Le hook vit dans l'écran — c'est lui qui redirige, parce que ce qu'on fait
 * d'un 202 est une décision de parcours. Ce que les cartes ont besoin de savoir
 * tient en trois choses, et `enCours` porte le **nom** de la source plutôt qu'un
 * booléen : c'est ce qui permet à la carte cliquée d'afficher l'attente et aux
 * autres de se contenter de se taire.
 */
export type Creation = {
  /** Le nom de la source dont la création est en vol, ou `null`. */
  enCours: string | null
  /** Le message **du serveur**, jamais composé depuis une exception. */
  erreur: string | null
  lancer: (source: Source) => void
}

/**
 * La hauteur d'une carte, **écrite une fois et la même dans les cinq états**.
 *
 * Le squelette la reprend telle quelle, ce qui fait que la grille ne saute pas
 * quand les cartes arrivent. Et surtout : **aucun état n'en change**. Une carte
 * qui grandit en gagnant sa barre d'avancement au tour de sondage suivant
 * déplacerait tout ce qui la suit, sous les yeux et sous le curseur — c'est le
 * point 2 de l'issue #56, qui décrivait le même défaut sur la section « Projets »
 * d'alors. La section a disparu ; la hauteur fixe est ce qui empêche le défaut de
 * réapparaître un cran plus bas, dans la grille elle-même.
 *
 * Conséquence assumée : **le message d'échec ne tient pas ici**. La carte dit
 * qu'il y a eu un échec, la vue Émission en donne le texte entier avec le bouton
 * qui le répare. Un message tronqué sur la carte aurait été le pire des trois —
 * il aurait promis une cause en la cachant.
 */
export const HAUTEUR_CARTE = 'h-24'

/** Ce que dit chaque état, en toutes lettres. */
const LIBELLES_ÉTAT: Record<ÉtatÉmission, string> = {
  neuve: 'À analyser',
  analyse: 'Analyse en cours',
  interrompue: 'Analyse interrompue',
  echec: 'Analyse en erreur',
  analysée: 'Analysée',
}

/**
 * La carte d'une émission : **un replay, son état, et un seul geste**.
 *
 * L'écran d'entrée montrait « Projets » puis « Replays », et une émission
 * analysée y apparaissait deux fois. Un projet n'est que l'état de traitement
 * d'un replay : une carte, enrichie de cet état.
 *
 * **Deux éléments pour deux gestes**, comme avant. Une émission jamais analysée
 * porte un bouton, qui déclenche une écriture ; toutes les autres portent un
 * lien, qui navigue vers la vue Émission — son suivi pendant l'analyse, son tri
 * et son montage après. Le bouton n'a pas de `href` à donner tant que le projet
 * n'existe pas, et le lien n'a rien à déclencher.
 *
 * **L'ambre marque ce qui est analysé.** C'est la seule couleur de l'interface,
 * et `globals.css` la réserve à « ce qui est gardé, ce qui est sélectionné, et le
 * rectangle de cadrage » — trois usages qui vivent tous sur d'autres écrans.
 * Ici, rien d'autre ne la porte, donc elle accentue encore : sur dix-huit cartes
 * dont deux ont du travail dessus, c'est exactement la question qu'on se pose en
 * arrivant.
 */
export function CarteÉmission({ entrée, creation }: { entrée: Entrée; creation: Creation }) {
  const { source, projet, état } = entrée
  const enCreation = source !== null && creation.enCours === source.name
  // **Toutes les cartes, pas seulement celle qu'on vient de cliquer.** Deux
  // créations en vol se disputeraient la redirection : on atterrirait sur celle
  // qui a répondu la dernière, sans que rien ne dise laquelle. Les liens vers un
  // projet existant, eux, restent ouverts — une navigation ne dispute rien, et
  // c'est le seul geste encore utile pendant l'attente.
  const bloquee = creation.enCours !== null

  // **Que des `span`, jamais un `div` ni un `p`.** Le modèle de contenu d'un
  // `button` n'admet que du contenu de phrase, et ce corps-ci sert aussi bien au
  // bouton d'une émission neuve qu'au lien de toutes les autres.
  const corps = (
    <>
      <Vignette source={source} />
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-3 py-2">
        <span data-titre className="truncate text-sm font-medium">{entrée.titre}</span>
        <span className="truncate text-xs text-muted-foreground tabular-nums">
          <Sous entrée={entrée} />
        </span>
        {/* La ligne d'état, **de hauteur fixe dans les cinq cas**. Voir
            `HAUTEUR_CARTE` : c'est ce qui empêche la grille de bouger sous la
            main au tour de sondage suivant. */}
        <span className="mt-0.5 flex h-5 items-center gap-1.5 text-xs font-medium">
          <LigneDÉtat entrée={entrée} enCreation={enCreation} />
        </span>
      </span>
    </>
  )

  const carte = cn(
    'flex w-full items-stretch overflow-hidden rounded-xl border text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
    HAUTEUR_CARTE,
    état === 'analysée'
      ? 'border-stage/50 bg-stage-muted'
      : état === 'echec'
        ? 'border-destructive/40 bg-card'
        : 'bg-card',
  )

  // **L'identifiant du projet vient des deux côtés de la jointure.** Celui du
  // projet quand la liste le porte, celui de la source sinon : entre la réponse
  // de création et le tour de sondage suivant, `marquerSourceAnalysée` a déjà
  // inscrit le `projectId` dans le cache des sources alors que la liste des
  // projets ne connaît encore rien. Ne lire que `projet` laissait alors un
  // bouton de création sur une émission dont l'analyse venait de partir, et le
  // second clic rend un 409 (`ExécutionEnCoursError`).
  const projectId = projet?.id ?? source?.projectId ?? null

  if (projectId !== null) {
    return (
      <Link
        href={lienProjet(projectId)}
        data-etat={état}
        className={cn(carte, état === 'analysée' ? 'hover:brightness-98' : 'hover:bg-muted')}
      >
        {corps}
      </Link>
    )
  }

  // Reste le cas neuf, le seul qui écrive. Une entrée sans projet a forcément une
  // source : `bibliothèque` ne fabrique d'entrée orpheline que depuis un projet.
  return (
    <button
      type="button"
      data-etat={état}
      // **Deux mécanismes, et le partage est celui de la conception §4.4.**
      //
      // La carte qu'on vient de cliquer garde son `aria-disabled` : `disabled`
      // sort du parcours de tabulation, donc il prendrait le focus à celui qui
      // vient d'appuyer sur Entrée, et il faudrait retraverser la page pour
      // revenir à la carte en cas d'échec. Sa raison est écrite dessus, jamais
      // dans une bulle d'aide.
      //
      // Les autres, elles, sortent bel et bien : personne n'a le focus dessus, et
      // « une création tourne ailleurs » ne vaut pas d'être découvert au clavier.
      disabled={bloquee && !enCreation}
      aria-disabled={enCreation || undefined}
      onClick={() => {
        if (bloquee || source === null) return
        creation.lancer(source)
      }}
      className={cn(
        carte,
        'hover:bg-muted disabled:pointer-events-none',
        enCreation ? 'ring-2 ring-ring/40' : 'disabled:opacity-55',
      )}
    >
      {corps}
    </button>
  )
}

/**
 * La deuxième ligne : ce qu'on sait du fichier, ou ce qu'on sait de son absence.
 *
 * Un projet orphelin n'a plus de fichier à décrire — ni taille, ni date — et
 * c'est précisément ce qu'il faut dire. Sa durée, elle, a été sondée à
 * l'ingestion et vit en base : elle survit à la disparition du replay.
 */
function Sous({ entrée }: { entrée: Entrée }) {
  if (entrée.source !== null) {
    return (
      <>
        {formatOctets(entrée.source.sizeBytes)} · {formatDateSource(entrée.source.modifiedAt)}
      </>
    )
  }
  const durée = entrée.projet?.durationSec ?? 0
  return <>Replay introuvable{durée > 0 && <> · {formatDuration(durée)}</>}</>
}

/**
 * Ce que la carte dit de son état, et le geste qu'elle propose.
 *
 * **Chaque état porte une action**, y compris les deux qui décrivent un
 * incident : une analyse interrompue ou échouée s'ouvre sur la vue Émission, où
 * vivent le message du serveur et le bouton de reprise. Un état sans issue est
 * exactement ce que la conception §2.7 interdit.
 */
function LigneDÉtat({ entrée, enCreation }: { entrée: Entrée; enCreation: boolean }) {
  const { projet, état } = entrée

  if (état === 'analyse' && projet?.running != null) {
    // La barre plutôt que le badge : c'est la seule information qui bouge, et
    // c'est ce qu'on vient regarder. Le pourcentage se voit, il ne s'annonce pas
    // — la région live de la grille parle aux changements d'étape seulement.
    const part = Math.round(Math.min(1, Math.max(0, projet.running.progress)) * 100)
    const libelle = LIBELLES_ETAPES[projet.running.step]
    return (
      <Progress
        value={part}
        locale="fr-FR"
        aria-label={`${libelle} en cours`}
        className="w-full gap-x-2 gap-y-0.5"
      >
        <span className="text-xs font-normal text-muted-foreground">{libelle}</span>
        <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">
          {part} %
        </span>
      </Progress>
    )
  }

  if (état === 'analyse') {
    // Le projet existe et rien ne tourne encore de ce que la liste sache : c'est
    // la fenêtre entre la réponse de création et le premier relevé.
    return (
      <>
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        <span>{LIBELLES_ÉTAT.analyse}</span>
      </>
    )
  }

  if (état === 'echec' || état === 'interrompue') {
    const Icône = état === 'echec' ? TriangleAlert : RotateCcw
    return (
      <>
        <Icône
          className={cn('size-3.5 shrink-0', état === 'echec' && 'text-destructive')}
          aria-hidden
        />
        <span className={cn('truncate', état === 'echec' && 'text-destructive')}>
          {LIBELLES_ÉTAT[état]}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
          Reprendre
          <ChevronRight className="size-3.5" aria-hidden />
        </span>
      </>
    )
  }

  if (état === 'analysée') {
    return (
      <>
        <Badge className="border-stage/40 bg-stage/20 text-stage-foreground">
          {LIBELLES_ÉTAT.analysée}
        </Badge>
        {entrée.source === null && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Unplug className="size-3.5" aria-hidden />
            Orpheline
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
          Ouvrir
          <ChevronRight className="size-3.5" aria-hidden />
        </span>
      </>
    )
  }

  if (enCreation) {
    return (
      <>
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        <span>Lancement de l’analyse…</span>
      </>
    )
  }

  return (
    <>
      <Play className="size-3.5" aria-hidden />
      <span>Lancer l’analyse</span>
    </>
  )
}

/**
 * La vignette d'un replay, **dans une case dont la taille ne dépend pas d'elle**.
 *
 * C'est la seule chose qui compte ici. L'image arrive plusieurs secondes après
 * la carte — elle se tire de l'original, sur le 9p —, et une case qui prendrait
 * ses dimensions ferait sauter la grille au moment où l'œil s'y pose.
 *
 * **`loading="lazy"`, et c'est tout le dispositif de chargement au défilement**
 * que la spec §12 demande. Le navigateur ne demande que ce qui approche du
 * champ. Un observateur d'intersection écrit à la main ferait la même chose en
 * moins bien.
 *
 * **Le repli sert trois fois** : avant l'image, à sa place si elle n'arrive
 * jamais, et pour une entrée orpheline — dont le fichier n'existe plus, donc
 * dont aucune URL ne rendrait rien.
 */
function Vignette({ source }: { source: Source | null }) {
  // **L'URL qui a échoué, pas un booléen.** L'échec appartient à l'image, pas à
  // la position dans la grille : React réutilise un composant d'une carte à
  // l'autre quand la liste se réordonne — un filtre suffit —, et un booléen
  // resterait alors posé sur la source suivante, qui n'aurait jamais sa chance.
  //
  // **Et l'URL porte la version du fichier**, ce qui rend cette comparaison
  // utile plutôt que décorative : sans elle, l'URL d'une source serait
  // éternelle, et un replay réenregistré depuis l'échec ne serait jamais
  // redemandé.
  const [échouée, setÉchouée] = useState<string | null>(null)

  return (
    <span
      data-slot="vignette"
      aria-hidden
      className="relative flex aspect-video h-full shrink-0 items-center justify-center overflow-hidden border-r bg-muted/50 text-muted-foreground/40"
    >
      <Film className="size-5" />
      {source !== null && échouée !== source.thumbnailUrl && (
        // Même raison que dans `candidate-card.tsx` pour l'exception de lint :
        // la vignette sort d'une route locale à une taille déjà fixée (640 de
        // large), `next/image` n'aurait rien à optimiser, et le faire passer par
        // `/_next/image` ajouterait un second décodage par carte.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={source.thumbnailUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setÉchouée(source.thumbnailUrl)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  )
}

/**
 * Le squelette d'une carte, **aux dimensions finales**.
 *
 * C'est tout son intérêt : une grille qui se remplit de cartes plus hautes que
 * ses squelettes fait sauter la page au moment où l'œil s'y pose.
 */
export function CarteÉmissionSquelette() {
  return <Skeleton className={cn('w-full rounded-xl', HAUTEUR_CARTE)} />
}
