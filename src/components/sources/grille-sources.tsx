'use client'

import { TriangleAlert } from 'lucide-react'
import { useEffect } from 'react'

import { LigneMontage } from '@/components/sources/ligne-montage'
import {
  SourceCard,
  SourceCardSquelette,
  type Creation,
} from '@/components/sources/source-card'
import { pluriel } from '@/components/sources/textes'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { SourcesListing } from '@/lib/api'

/**
 * Où l'on avait laissé la grille, **pour la session seulement**.
 *
 * `sessionStorage` et non `localStorage` : la position de défilement décrit un
 * aller-retour en cours, pas une préférence. La retrouver trois jours plus tard,
 * sur une liste de replays qui a changé entre-temps, désignerait une autre carte.
 */
export const CLE_DEFILEMENT = 'bibliotheque:defilement'

/**
 * Le nombre de squelettes posés pendant le chargement.
 *
 * Une pleine largeur d'écran, pas les vingt et une cartes : le squelette dit que
 * quelque chose arrive, il ne promet pas combien.
 */
const SQUELETTES = 8

const GRILLE = 'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4'

/**
 * La grille des replays : **l'entrée du tunnel**.
 *
 * Elle ne va pas chercher ses données — la page les lui donne, avec le geste de
 * création et son état. C'est ce qui permet de la monter dans un test sans
 * client de requêtes ni serveur, et surtout de tenir les cinq états côte à côte
 * dans un seul fichier plutôt que répartis entre un hook et un rendu.
 *
 * **La grille est une liste de liens et de boutons, donc tabulable telle
 * quelle.** Les flèches n'y naviguent pas : vingt et une cartes ne justifient
 * pas un gestionnaire de focus bidimensionnel, et `Tab` y suffit.
 */
export function GrilleSources({
  listing,
  chargement,
  erreur,
  onReessayer,
  creation,
}: {
  listing: SourcesListing | undefined
  chargement: boolean
  /** Le message **du serveur**, ou `null`. */
  erreur: string | null
  onReessayer: () => void
  creation: Creation
}) {
  const sources = listing?.sources ?? []
  const analysées = sources.filter((s) => s.projectId !== null).length
  // Le défilement ne se restaure qu'une fois les cartes là : le poser sur une
  // page de squelettes le poserait sur une hauteur qui n'est pas la bonne.
  useDefilementRetenu(sources.length > 0)

  const résumé =
    sources.length === 0
      ? null
      : [
          pluriel(sources.length, 'replay', 'replays'),
          ...(analysées > 0 ? [pluriel(analysées, 'déjà analysé', 'déjà analysés')] : []),
        ].join(' · ')

  return (
    <section aria-labelledby="titre-replays" className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 id="titre-replays" className="text-sm font-semibold tracking-tight">
          Replays
        </h2>
        {résumé !== null && (
          <p className="text-xs text-muted-foreground tabular-nums">{résumé}</p>
        )}
      </div>

      {/* L'échec d'une création vit au-dessus de la grille, pas dans la carte :
          la carte peut avoir disparu au rechargement qui suit, et le message
          serait parti avec elle. */}
      {creation.erreur !== null && (
        <Alert variant="destructive" className="px-4 py-3">
          <TriangleAlert aria-hidden />
          <AlertTitle className="text-sm">La création n’a pas abouti.</AlertTitle>
          <AlertDescription className="text-xs">{creation.erreur}</AlertDescription>
          {/* Sans quoi une source disparue entre l'affichage et le clic serait
              une impasse : sa carte est toujours là, et la recliquer échouerait
              de la même façon. */}
          <AlertAction>
            <Button variant="outline" size="sm" onClick={onReessayer}>
              Rafraîchir
            </Button>
          </AlertAction>
        </Alert>
      )}

      {erreur !== null ? (
        <Alert variant="destructive" className="px-4 py-3">
          <TriangleAlert aria-hidden />
          <AlertTitle className="text-sm">Les replays n’ont pas pu être listés.</AlertTitle>
          {/* Le message du serveur, tel quel. Un `GET /api/sources` en échec est
              une panne du serveur lui-même — un montage muet, lui, répond 200 et
              se raconte dans la ligne de montage. */}
          <AlertDescription className="text-xs">{erreur}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={onReessayer}>
              Réessayer
            </Button>
          </AlertAction>
        </Alert>
      ) : chargement || listing === undefined ? (
        <ul className={GRILLE}>
          {Array.from({ length: SQUELETTES }, (_, i) => (
            <li key={i}>
              <SourceCardSquelette />
            </li>
          ))}
        </ul>
      ) : sources.length === 0 ? (
        <LigneMontage montage={listing.montage} onReessayer={onReessayer} />
      ) : (
        <ul className={GRILLE}>
          {sources.map((source) => (
            <li key={source.name}>
              <SourceCard source={source} creation={creation} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * La position de défilement, gardée pendant la session.
 *
 * **Le retour d'un projet ne doit rien coûter.** Vingt et une cartes chargées à
 * la demande : revenir en haut à chaque aller-retour ferait redemander ce qui a
 * déjà été vu, et c'est un aller-retour par clip monté.
 *
 * La restauration du navigateur ne suffit pas ici, et c'est pour cela que ce
 * hook existe : elle a lieu avant que la requête ne réponde, sur une page qui ne
 * fait alors que la hauteur de ses squelettes — il n'y a nulle part où
 * descendre, et la position est perdue en silence.
 *
 * L'écriture est directe et non temporisée : `sessionStorage.setItem` sur une
 * chaîne de trois caractères se compte en microsecondes, et une temporisation
 * perdrait la dernière position juste avant la navigation, qui est exactement
 * celle qui compte.
 */
function useDefilementRetenu(pret: boolean) {
  useEffect(() => {
    if (!pret) return
    const garde = lireSession(CLE_DEFILEMENT)
    if (garde === null) return
    const y = Number(garde)
    if (Number.isFinite(y) && y > 0) window.scrollTo(0, y)
  }, [pret])

  // **Et on n'écrit que pendant ce temps-là.** La restauration du navigateur
  // tente l'ancienne position sur une page qui n'a alors que la hauteur de ses
  // squelettes : elle est ramenée vers le haut, et l'événement de défilement
  // qu'elle émet écrasait la position gardée — les cartes arrivaient ensuite sur
  // une valeur rabotée. Même chose quand une erreur remplace la grille : il n'y
  // a rien à retenir d'une page où il n'y a rien à voir. (relevé par Codex)
  useEffect(() => {
    if (!pret) return
    const retenir = () => écrireSession(CLE_DEFILEMENT, String(window.scrollY))
    window.addEventListener('scroll', retenir, { passive: true })
    return () => window.removeEventListener('scroll', retenir)
  }, [pret])
}

/**
 * `sessionStorage` sous garde : il lève quand le navigateur refuse le stockage,
 * et une position de défilement ne vaut pas de faire tomber la page d'entrée.
 */
function lireSession(cle: string): string | null {
  try {
    return sessionStorage.getItem(cle)
  } catch {
    return null
  }
}

function écrireSession(cle: string, valeur: string) {
  try {
    sessionStorage.setItem(cle, valeur)
  } catch {
    // Rien à faire : on repartira du haut.
  }
}
