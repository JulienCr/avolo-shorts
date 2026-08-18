'use client'

import { ChevronRight, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'

import { pluriel } from '@/components/sources/textes'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { LIBELLES_ETAPES } from '@/core/parcours'
import type { ProjectListItem, StepName } from '@/lib/api'
import { formatDuration } from '@/lib/format'
import { lienProjet } from '@/lib/parcours'

/** Le nombre de squelettes posés le temps que la liste arrive. */
const SQUELETTES = 3

/**
 * Les projets en cours, **et l'état de chacun**.
 *
 * C'est ce qui rend supportable de lancer une analyse puis d'aller trier un
 * autre projet : sans cette section, la seule façon de savoir où en est une
 * analyse de neuf minutes est de rester devant son écran.
 *
 * **Elle ne demande rien de plus au serveur que ce qui est gratuit.** La forme
 * évidente — un `GET /api/projects/:id` par projet — multiplierait par vingt et
 * un un appel qui exécute `relevéPrésence`, lequel sonde le montage 9p avec un
 * délai de garde ; quatre fils du vivier de libuv suffisent à figer tout ce qui
 * touche au disque dans le serveur, analyse en cours comprise. `ProjectListItem`
 * ne porte donc que `running` (une lecture de `Map`) et `error` (un petit
 * fichier local). La présence des artefacts se résout quand on ouvre le projet,
 * là où le sondage se paie de toute façon.
 *
 * **Et elle disparaît quand elle n'a rien à dire.** Un titre « Projets » au
 * dessus d'un vide occuperait le haut de l'écran d'entrée pour ne rien
 * apprendre ; la grille des replays prend alors toute la place, ce qui est
 * exactement le geste utile quand aucun projet n'existe.
 */
export function ListeProjets({
  projets,
  chargement,
  erreur,
  onReessayer,
}: {
  projets: ProjectListItem[] | undefined
  chargement: boolean
  /** Le message **du serveur**, ou `null`. */
  erreur: string | null
  onReessayer: () => void
}) {
  const annonce = useAnnonceAnalyses(projets)

  if (erreur !== null) {
    return (
      <Alert variant="destructive" className="px-4 py-3">
        <TriangleAlert aria-hidden />
        <AlertTitle className="text-sm">Les projets n’ont pas pu être listés.</AlertTitle>
        {/* Sans cet état, une API en panne rend exactement la même page qu'une
            bibliothèque vide, et on cherche des projets perdus. */}
        <AlertDescription className="text-xs">{erreur}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={onReessayer}>
            Réessayer
          </Button>
        </AlertAction>
      </Alert>
    )
  }

  if (chargement || projets === undefined) {
    return (
      <Section resume={null}>
        <ul className="flex flex-col gap-2">
          {Array.from({ length: SQUELETTES }, (_, i) => (
            <li key={i}>
              <Skeleton className="h-16 w-full rounded-xl" />
            </li>
          ))}
        </ul>
      </Section>
    )
  }

  if (projets.length === 0) return null

  const enCours = projets.filter((p) => p.running !== null).length
  const enEchec = projets.filter((p) => p.error !== null).length
  const resume = [
    pluriel(projets.length, 'émission', 'émissions'),
    ...(enCours > 0 ? [pluriel(enCours, 'analyse en cours', 'analyses en cours')] : []),
    // « en échec » ne prend pas de marque de pluriel : deux projets sont en
    // échec, pas « en échecs ».
    ...(enEchec > 0 ? [`${enEchec} en échec`] : []),
  ].join(' · ')

  return (
    <Section resume={resume}>
      {/* **Une seule région, et elle n'annonce que les changements d'étape.**
          L'écran sonde toutes les deux secondes : une région live sur le
          pourcentage produirait une annonce toutes les deux secondes pendant
          neuf minutes. `role="status"` vaut `aria-live="polite"`. */}
      <p role="status" className="sr-only">
        {annonce}
      </p>

      <ul className="flex flex-col gap-2">
        {projets.map((projet) => (
          <li key={projet.id}>
            <LigneProjet projet={projet} />
          </li>
        ))}
      </ul>
    </Section>
  )
}

function Section({ resume, children }: { resume: string | null; children: ReactNode }) {
  return (
    <section aria-labelledby="titre-projets" className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 id="titre-projets" className="text-sm font-semibold tracking-tight">
          Projets
        </h2>
        {resume !== null && (
          <p className="text-xs text-muted-foreground tabular-nums">{resume}</p>
        )}
      </div>
      {children}
    </section>
  )
}

function LigneProjet({ projet }: { projet: ProjectListItem }) {
  return (
    <Link
      href={lienProjet(projet.id)}
      className="flex min-h-16 w-full flex-col justify-center gap-1.5 rounded-xl border bg-card px-4 py-2.5 transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{projet.title}</p>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {formatDuration(projet.durationSec)}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </div>

      {/* **Ce qui tourne l'emporte sur ce qui a échoué**, comme dans
          `analyseProjet` : `error` décrit la dernière exécution *terminée*, et
          tant qu'une autre tourne, ce qu'il faut dire est ce qui se passe. */}
      {projet.running !== null ? (
        <Avancement running={projet.running} />
      ) : projet.error !== null ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {/* Le message du serveur, déjà épuré de ses chemins absolus. C'est le
              seul chemin par lequel l'échec d'une tâche de fond revient jusqu'à
              l'écran : le lanceur rend la main bien après la réponse 202.

              **Il va à la ligne, il ne se coupe pas.** La cause utile est au bout
              de la phrase, et une ligne tronquée n'a aucun moyen de la révéler —
              afficher le message du serveur puis en cacher la moitié serait la
              même chose que ne pas l'afficher. La rangée grandit, ce que `min-h`
              permet déjà. (relevé par Copilot) */}
          <span className="wrap-anywhere">{projet.error}</span>
        </p>
      ) : null}
    </Link>
  )
}

/**
 * L'avancement d'une étape.
 *
 * Le pourcentage se voit, il ne s'annonce pas : `aria-valuenow` se met à jour en
 * silence, et c'est la région live de la section qui parle, aux changements
 * d'étape seulement.
 *
 * **`locale` est fixée.** Sans elle, `aria-valuetext` est formaté dans la locale
 * d'exécution — celle de Node au rendu serveur, celle du navigateur ensuite —,
 * et les deux ne s'accordent pas toujours sur l'espace qui précède le signe
 * pour cent.
 */
function Avancement({ running }: { running: { step: StepName; progress: number } }) {
  const pourcent = Math.round(Math.min(1, Math.max(0, running.progress)) * 100)
  const libelle = LIBELLES_ETAPES[running.step]

  return (
    <Progress
      value={pourcent}
      locale="fr-FR"
      aria-label={`${libelle} en cours`}
      className="gap-x-2 gap-y-1"
    >
      <span className="text-xs text-muted-foreground">{libelle}</span>
      <span className="ml-auto text-xs text-muted-foreground tabular-nums">{pourcent} %</span>
    </Progress>
  )
}

/**
 * Ce qui se dit à voix haute : **les changements d'étape, et la fin**.
 *
 * Quatre annonces sur toute une analyse, au lieu de deux cent soixante-dix. La
 * comparaison porte sur l'étape et non sur la progression : deux tours de
 * sondage qui ne font qu'avancer un pourcentage produisent exactement la même
 * chaîne, React ne touche pas au DOM, et le lecteur d'écran se tait.
 *
 * **La fin est ce qu'on attend pour revenir**, et c'est la seule chose qu'un
 * onglet laissé ouvert sur la bibliothèque peut apprendre à quelqu'un qui n'est
 * plus devant. Elle se distingue d'un échec par `error`, qui décrit alors
 * l'exécution qui vient de se terminer.
 *
 * **L'ajustement se fait pendant le rendu, pas dans un effet.** Un effet qui
 * appelle `setState` déclenche un rendu en cascade — la règle
 * `react-hooks/set-state-in-effect` le refuse — et surtout il annoncerait *après*
 * que la barre a bougé, alors que les deux décrivent le même instant. C'est le
 * motif documenté par React pour l'état qui se recale sur ses props : on compare,
 * on met à jour, React relance le rendu avant de valider quoi que ce soit.
 *
 * **Et la comparaison porte sur une signature, jamais sur l'identité du
 * tableau.** TanStack Query partage ses structures et rend donc la même
 * référence tant que rien ne change ; mais un appelant qui écrirait
 * `projets={data ?? []}` fabriquerait un tableau neuf à chaque rendu, et la
 * comparaison par identité boucherait indéfiniment. Une chaîne dérivée ne peut
 * pas se tromper là-dessus.
 */
type Mémoire = {
  /** Ce qui a produit l'annonce en cours : l'étape et l'échec de chaque projet. */
  signature: string
  étapes: Map<string, StepName>
  annonce: string
}

function useAnnonceAnalyses(projets: ProjectListItem[] | undefined): string {
  const [mémoire, setMémoire] = useState<Mémoire>(() => ({
    signature: '',
    étapes: new Map(),
    annonce: '',
  }))

  const signature = signer(projets)
  if (signature !== mémoire.signature) setMémoire(annoncer(mémoire, projets, signature))

  return mémoire.annonce
}

/**
 * Ce dont l'annonce dépend, et rien d'autre : l'étape en cours de chaque projet
 * et le fait qu'il ait échoué. La progression n'y est pas — c'est ce qui fait
 * qu'un tour de sondage sur un pourcentage qui avance ne dit rien.
 */
function signer(projets: ProjectListItem[] | undefined): string {
  return (projets ?? [])
    .map((p) => `${p.id}\u0000${p.running?.step ?? ''}\u0000${p.error !== null}`)
    .join('\u0001')
}

/** Pure : l'annonce d'avant, l'état d'après, et ce qu'il faut en dire. */
function annoncer(
  mémoire: Mémoire,
  projets: ProjectListItem[] | undefined,
  signature: string,
): Mémoire {
  const étapes = new Map<string, StepName>()
  for (const p of projets ?? []) {
    if (p.running !== null) étapes.set(p.id, p.running.step)
  }

  const messages: string[] = []
  for (const p of projets ?? []) {
    const avant = mémoire.étapes.get(p.id)
    const maintenant = étapes.get(p.id)
    if (maintenant !== undefined && maintenant !== avant) {
      messages.push(`${p.title} : ${LIBELLES_ETAPES[maintenant]}.`)
    } else if (maintenant === undefined && avant !== undefined) {
      messages.push(`${p.title} : ${p.error !== null ? 'analyse en échec' : 'analyse terminée'}.`)
    }
  }

  // Rien de neuf : on garde la chaîne d'avant plutôt que d'écrire une chaîne
  // vide, qui serait une modification du DOM — donc, pour certains lecteurs
  // d'écran, une annonce de plus.
  return {
    signature,
    étapes,
    annonce: messages.length > 0 ? messages.join(' ') : mémoire.annonce,
  }
}
