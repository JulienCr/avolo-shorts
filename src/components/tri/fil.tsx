'use client'

import { Keyboard } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import type { ClipStatus } from '@/core/edl'
import { compter } from '@/core/parcours'
import type { BilanRepérage, CandidateClip } from '@/lib/api'
import { basculerStatut, type Decision } from '@/lib/clip-status'
import { formatDuration } from '@/lib/format'
import type { Suite } from '@/lib/parcours'
import { CandidateCard } from '@/components/tri/candidate-card'
import { FinDeBoucle } from '@/components/tri/fin-de-boucle'
import {
  accord,
  appartient,
  idsPourVue,
  motDuRepérage,
  VUES,
  type Vue,
} from '@/components/tri/modele'
import { useRaccourcisTri } from '@/components/tri/raccourcis'
import { lireSessionTri, écrireSessionTri } from '@/components/tri/session'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * Le fil de tri : vingt-cinq à trente cartes, deux décisions par carte, chacune
 * réversible.
 *
 * **C'est une boucle, et une boucle a ses instruments** (spec §2.5). Trois
 * propriétés portent tout le reste, et chacune se paie à chaque itération :
 *
 * - **le clavier**, parce que sur trente items l'aller-retour vers la souris
 *   devient le coût dominant. `G` et `E` **avancent** — décider sans avancer
 *   oblige à un geste sur deux — et `U` revient sur la décision précédente
 *   **et sur sa carte**, sinon on corrige à l'aveugle ;
 * - **rien ne bouge sous la main.** Une carte décidée reste à sa place, marquée.
 *   Écarter faisait disparaître la carte et refluer toute la grille : la
 *   suivante n'était plus ni sous l'œil ni sous le curseur. Le compactage se
 *   fait **au changement de vue**, jamais au moment du clic ;
 * - **le reste à faire, pas le chemin parcouru.** « 12 à trier » se lit d'un
 *   coup d'œil et reste vrai quand on change d'avis ; un pourcentage ne survit
 *   pas à un retour en arrière, faute d'un dénominateur connu avant la fin.
 *
 * Il ne va pas chercher ses données : la page les lui passe. C'est ce qui le
 * rend montable dans un test sans serveur ni cache, et c'est là que vivent les
 * trois comportements dont une régression serait silencieuse.
 */
export function FilDeTri({
  projectId,
  clips,
  vue,
  onVue,
  proxyPret,
  bilan,
  suite,
  onStatut,
  entete,
}: {
  projectId: string
  clips: readonly CandidateClip[]
  vue: Vue
  onVue: (vue: Vue) => void
  /** Le proxy est-il là ? Il commande les vignettes et l'ouverture du montage. */
  proxyPret: boolean
  /** Ce que le repérage n'a pas jugé, ou `null`. Voir `motDuRepérage`. */
  bilan: BilanRepérage | null
  /**
   * L'issue de la phase, calculée par la page.
   *
   * Elle arrive en propriété plutôt que d'être calculée ici : `suite` a besoin
   * de la phase, donc du relevé d'artefacts et de l'exécution en cours, que ce
   * composant n'a aucune raison de connaître. C'est la fin de boucle qui la
   * consomme — c'est le seul endroit où l'on sait enfin de quoi la liste est
   * faite.
   */
  suite: Suite
  onStatut: (clipId: string, status: Exclude<ClipStatus, 'exported'>) => void
  /** Ce que la page pose en bout de ligne d'en-tête — la relance, notamment. */
  entete?: ReactNode
}) {
  const compte = compter(clips)
  const mot = motDuRepérage(bilan)

  const visibles = useVueFigée(clips, vue)
  const grille = useRef<HTMLDivElement>(null)

  const [selection, setSelection] = useState<string | null>(null)
  const [aide, setAide] = useState(false)
  // La pile d'annulation : le statut d'avant, et sur quelle carte le rendre.
  const [pile, setPile] = useState<{ clipId: string; avant: ClipStatus }[]>([])

  // La carte sur laquelle le clavier travaille. Elle se déduit plutôt qu'elle ne
  // se stocke : une sélection gardée dans l'état survivrait à la disparition de
  // sa carte — au changement de vue, ou après un repérage forcé — et le clavier
  // travaillerait sur un identifiant que plus rien n'affiche.
  const courant = visibles.some((c) => c.id === selection) ? selection : (visibles[0]?.id ?? null)

  // **Aucun `useCallback` ici, et c'est délibéré.** Ces gestes ferment sur la
  // liste, la vue et la sélection : leurs tableaux de dépendances seraient longs,
  // faux un jour, et sans bénéfice — `useRaccourcisTri` garde les derniers
  // derrière une référence, donc rien ne se réabonne au changement d'identité, et
  // le compilateur de React mémorise ce qui vaut de l'être.
  function élément(clipId: string | null): HTMLElement | null {
    if (clipId === null) return null
    const cartes = grille.current?.querySelectorAll<HTMLElement>('[data-clip]') ?? []
    // Une comparaison d'attribut plutôt qu'un sélecteur : les identifiants de
    // clip héritent du nom de fichier d'origine, accents et espaces compris, et
    // il n'y a pas trente cartes à parcourir.
    for (const carte of cartes) if (carte.getAttribute('data-clip') === clipId) return carte
    return null
  }

  function focaliser(clipId: string | null) {
    setSelection(clipId)
    const carte = élément(clipId)
    if (carte === null) return
    carte.focus()
    // `scrollIntoView` n'existe pas sous jsdom, et le focus suffit dans un
    // navigateur pour les cartes déjà visibles.
    if (typeof carte.scrollIntoView === 'function') carte.scrollIntoView({ block: 'nearest' })
  }

  function deplacer(pas: number) {
    if (visibles.length === 0) return
    const depuis = visibles.findIndex((c) => c.id === courant)
    // **Sans rebouclage, aux deux bouts.** Reboucler ferait repasser
    // indéfiniment sur des cartes déjà vues sans que rien ne dise qu'on a fait
    // le tour — le même choix que `clipSuivant`.
    const vers = Math.max(0, Math.min(visibles.length - 1, (depuis < 0 ? 0 : depuis) + pas))
    focaliser(visibles[vers]?.id ?? null)
  }

  function empiler(clip: CandidateClip) {
    setPile((p) => [...p, { clipId: clip.id, avant: clip.status }])
  }

  function decider(decision: Decision) {
    const clip = visibles.find((c) => c.id === courant)
    if (clip === undefined) return
    empiler(clip)
    onStatut(clip.id, basculerStatut(clip.status, decision))
    deplacer(1)
  }

  function defaire() {
    const dernière = pile.at(-1)
    if (dernière === undefined) return
    // **Rien ne se défait hors de vue.** Reprendre une décision sur une carte
    // que la vue courante n'affiche pas changerait l'état sans que rien ne bouge
    // à l'écran — c'est la pire des corrections, celle qu'on ne voit pas, et
    // c'est exactement ce que `U` existe pour éviter puisqu'il ramène sur la
    // carte. La pile n'est pas vidée pour autant : revenir là où la carte est
    // rend le geste, et sa cible.
    if (élément(dernière.clipId) === null) return
    setPile((p) => p.slice(0, -1))
    // **`exported` ne se réécrit pas.** Le serveur refuse ce statut en `PATCH` —
    // un clip devient exporté parce qu'un MP4 a été produit, jamais parce que
    // quelqu'un l'a écrit — et le rendu a de toute façon été écarté par la
    // décision qu'on défait. `kept` est le maximum honnête.
    onStatut(dernière.clipId, dernière.avant === 'exported' ? 'kept' : dernière.avant)
    focaliser(dernière.clipId)
  }

  function ouvrir() {
    // Le lien de la carte, pas le routeur : une seule navigation, celle que le
    // clic emprunte déjà.
    élément(courant)?.querySelector<HTMLAnchorElement>('a[data-ouvrir]')?.click()
  }

  useRaccourcisTri({
    precedent: () => deplacer(-1),
    suivant: () => deplacer(1),
    garder: () => decider('kept'),
    ecarter: () => decider('discarded'),
    ouvrir,
    defaire,
    aide: () => setAide(true),
  })

  useSessionDeTri(projectId, courant, focaliser)

  const fini = clips.length > 0 && compte.aTrier === 0 && vue === 'atrier'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
        <h1 className="text-lg font-semibold tracking-tight">Propositions</h1>

        <p data-testid="comptes" className="text-sm text-muted-foreground">
          <span className="font-mono tabular-nums">{compte.aTrier}</span> à trier ·{' '}
          <span className="text-stage-foreground">
            {accord(compte.gardes, 'clip gardé', 'clips gardés')}
          </span>{' '}
          · <span className="font-mono tabular-nums">{formatDuration(compte.dureeGardee)}</span> au
          total
        </p>

        <div className="ml-auto flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setAide(true)}
                  aria-label="Les raccourcis du tri"
                />
              }
            >
              <Keyboard aria-hidden />
            </TooltipTrigger>
            <TooltipContent>Les raccourcis · ?</TooltipContent>
          </Tooltip>
          {entete}
        </div>
      </div>

      {/* **Ça reste à l'écran.** Ni notification, ni bandeau qu'on referme : ce
          que le repérage n'a pas jugé est une propriété permanente de cette
          liste, au même titre que son nombre d'éléments, et ça vit à côté du
          compte. Une information qui change la confiance qu'on accorde à un
          écran ne peut pas s'afficher trois secondes. */}
      {mot !== null && (
        <p
          data-testid="reperage"
          className={
            mot.perte
              ? 'rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm'
              : 'text-sm text-muted-foreground'
          }
        >
          <span className="font-medium">{mot.phrase}</span>
          {mot.detail !== null && <span className="block text-muted-foreground">{mot.detail}</span>}
          {mot.provisoire && (
            <span className="block text-muted-foreground">
              Décompte provisoire : la passe de repérage ne s’est pas terminée.
            </span>
          )}
        </p>
      )}

      <Tabs value={vue} onValueChange={(valeur) => onVue(valeur as Vue)}>
        <TabsList>
          {VUES.map(({ valeur, libelle }) => (
            <TabsTrigger key={valeur} value={valeur}>
              {libelle}
              <Badge variant="outline" className="ml-1 font-mono text-xs tabular-nums">
                {valeur === 'atrier'
                  ? compte.aTrier
                  : valeur === 'gardes'
                    ? compte.gardes
                    : compte.ecartes}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {clips.length === 0 && (
        <Vide
          titre="Aucune proposition pour le moment."
          detail="Le repérage n’a rien rendu, ou il n’a pas encore tourné."
        />
      )}

      {/* **La fin s'ajoute, elle ne remplace pas.** La dernière décision fait
          tomber le compteur à zéro : annoncer la fin *à la place* de la grille
          escamoterait vingt-cinq cartes sous la main au moment précis où l'on
          vient de décider — et `U`, qui ramène sur la carte de la décision
          défaite, n'aurait plus de carte où revenir. Les cartes restent donc en
          place, marquées, jusqu'au changement de vue qui les compacte. */}
      {fini && (
        <FinDeBoucle
          projectId={projectId}
          clips={clips}
          dureeGardee={compte.dureeGardee}
          suite={suite}
        />
      )}

      {clips.length > 0 && visibles.length === 0 && !fini && (
        <Vide titre={LIBELLES_VIDE[vue].titre} detail={LIBELLES_VIDE[vue].detail} />
      )}

      {visibles.length > 0 && (
        <div
          ref={grille}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
        >
          {visibles.map((clip) => (
            <CandidateCard
              key={clip.id}
              clip={clip}
              proxyPret={proxyPret}
              selectionne={clip.id === courant}
              onSelection={() => setSelection(clip.id)}
              // **Le focus revient à la carte après un clic.** Il resterait
              // sinon sur le bouton, que la garde des raccourcis écarte comme
              // tout `button` : plus une seule touche ne répondrait, sans
              // message et sans retour visible — la carte garderait son anneau
              // de sélection, donc l'écran affirmerait le contraire. Or la
              // souris pour décider puis le clavier pour enchaîner est le mode
              // d'usage attendu, pas un cas tordu. Un focus posé par programme
              // ne déclenche pas `:focus-visible` : rien ne bouge à l'œil.
              onGarder={() => {
                empiler(clip)
                onStatut(clip.id, basculerStatut(clip.status, 'kept'))
                focaliser(clip.id)
              }}
              onEcarter={() => {
                empiler(clip)
                onStatut(clip.id, basculerStatut(clip.status, 'discarded'))
                focaliser(clip.id)
              }}
            />
          ))}
        </div>
      )}

      <AideClavier ouvert={aide} onOuvert={setAide} />
    </div>
  )
}

const LIBELLES_VIDE: Record<Vue, { titre: string; detail: string }> = {
  atrier: {
    titre: 'Tout est trié.',
    detail: 'Les propositions décidées se retrouvent dans les deux autres vues.',
  },
  gardes: {
    titre: 'Aucun clip gardé.',
    detail: 'Les clips gardés se montent depuis leur carte.',
  },
  ecartes: { titre: 'Aucun clip écarté.', detail: 'Rien n’a encore été mis de côté.' },
}

function Vide({ titre, detail }: { titre: string; detail: string }) {
  return (
    <div className="rounded-xl border border-dashed px-6 py-14 text-center">
      <p className="text-sm font-medium">{titre}</p>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </div>
  )
}

/**
 * La liste affichée, **figée jusqu'au prochain changement de vue**.
 *
 * C'est la mécanique de « rien ne bouge sous la main » : une carte décidée reste
 * à sa place, marquée, et la grille ne reflue pas sous le curseur. Le compactage
 * se fait au changement de vue, et à ce moment-là seulement.
 *
 * **Elle ne fige que l'appartenance, pas les données.** Le jeu d'identifiants
 * est recalculé dès qu'un clip apparaît ou disparaît — une passe de repérage qui
 * se termine pendant qu'on trie ajoute des cartes, et les cacher jusqu'au
 * prochain changement de vue serait un vide inexplicable. Les statuts, eux,
 * viennent toujours de la liste vivante : ce sont les cartes qui se marquent,
 * pas la liste qui se réordonne.
 */
function useVueFigée(clips: readonly CandidateClip[], vue: Vue): CandidateClip[] {
  // Le séparateur est un octet nul, et non une espace : les identifiants de clip
  // héritent du nom de fichier d'origine, espaces comprises, et deux listes
  // différentes pourraient sinon produire la même chaîne — auquel cas la vue ne
  // se rafraîchirait pas.
  const identités = clips.map((c) => c.id).join('\u0000')
  const [figé, setFigé] = useState(() => ({ vue, identités, ids: idsPourVue(clips, vue) }))

  // Un ajustement d'état pendant le rendu, et non un effet : React rejoue le
  // rendu avant de peindre, donc la grille ne s'affiche jamais dans son état
  // d'avant. Un `useEffect` produirait une image intermédiaire à chaque
  // changement de vue.
  if (figé.vue !== vue || figé.identités !== identités) {
    setFigé({
      vue,
      identités,
      // **Un changement de vue recalcule ; une arrivée de clips complète.**
      // Refiger depuis zéro sur un simple changement d'identifiants escamotait
      // les cartes décidées — et le déclencheur est le bouton posé dans
      // l'en-tête juste au-dessus : un repérage forcé conserve les décisions
      // humaines **et** ajoute des candidats, donc le jeu d'identifiants change
      // au moment précis où l'on vient de trier.
      ids:
        figé.vue !== vue
          ? idsPourVue(clips, vue)
          : clips
              .filter((c) => figé.ids.includes(c.id) || appartient(c.status, vue))
              .map((c) => c.id),
    })
  }

  const parId = new Map(clips.map((c) => [c.id, c]))
  return figé.ids.flatMap((id) => {
    const clip = parId.get(id)
    return clip === undefined ? [] : [clip]
  })
}

/**
 * Ce qu'un aller-retour vers un clip doit retrouver.
 *
 * **Le focus revient sur la carte d'où l'on est parti.** Sans cela le clavier
 * repart du haut de la page à chaque aller-retour, soit quatre fois par
 * émission. C'est l'écran de tri qui le porte : celui de clip n'en sait rien, il
 * ne fait que naviguer par un lien.
 */
function useSessionDeTri(
  projectId: string,
  courant: string | null,
  focaliser: (clipId: string | null) => void,
) {
  const poser = useRef(focaliser)
  useEffect(() => {
    poser.current = focaliser
  })

  useEffect(() => {
    // **Lu au montage seulement** : après quoi c'est la sélection en cours qui
    // fait foi, et relire la session ferait sauter en arrière.
    const { carte, defilement } = lireSessionTri(projectId)
    // Le défilement d'abord, le focus ensuite : une carte retrouvée place la vue
    // plus précisément qu'une position en pixels, et son `scrollIntoView`
    // l'emporte alors. Une carte que la vue courante n'affiche plus — gardée
    // alors qu'on revient sur « à trier » — laisse la position, qui est ce qui
    // reste de vrai.
    if (defilement > 0) window.scrollTo(0, defilement)
    if (carte !== null) poser.current(carte)
  }, [projectId])

  useEffect(() => {
    if (courant !== null) écrireSessionTri(projectId, { carte: courant })
  }, [projectId, courant])

  useEffect(() => {
    // **Étranglé à quatre écritures par seconde.** Un événement de défilement
    // part à chaque image ; sérialiser la session soixante fois par seconde
    // pour une valeur qu'on ne relit qu'au retour serait payer un travail
    // continu pour un geste rare.
    let planifié = 0
    function surDéfilement() {
      if (planifié !== 0) return
      planifié = window.setTimeout(() => {
        planifié = 0
        écrireSessionTri(projectId, { defilement: window.scrollY })
      }, 250)
    }
    window.addEventListener('scroll', surDéfilement, { passive: true })
    return () => {
      window.removeEventListener('scroll', surDéfilement)
      if (planifié !== 0) window.clearTimeout(planifié)
    }
  }, [projectId])
}

/**
 * La liste des raccourcis.
 *
 * **Elle existe parce que le reste existe** : sept raccourcis qui ne se
 * découvrent que dans un attribut `title` sont sept raccourcis que personne
 * n'utilise.
 */
function AideClavier({
  ouvert,
  onOuvert,
}: {
  ouvert: boolean
  onOuvert: (ouvert: boolean) => void
}) {
  return (
    <Dialog open={ouvert} onOpenChange={onOuvert}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Les raccourcis du tri</DialogTitle>
          <DialogDescription>
            Toutes ces touches sont directes en AZERTY : un raccourci à deux mains
            n’économise rien sur un geste répété trente fois.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
          {RACCOURCIS.map(([touche, effet]) => (
            <div key={touche} className="contents">
              <dt className="font-mono text-xs text-muted-foreground">{touche}</dt>
              <dd>{effet}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}

const RACCOURCIS: readonly [string, string][] = [
  ['J / K', 'carte suivante, précédente'],
  ['Flèches', 'idem'],
  ['G', 'garder, et avancer d’une carte'],
  ['E', 'écarter, et avancer d’une carte'],
  ['Entrée', 'ouvrir le clip'],
  ['U', 'défaire la dernière décision, et revenir sur sa carte'],
  ['?', 'cette liste'],
]
