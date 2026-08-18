'use client'

import { Search, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useRef, useState, type RefObject } from 'react'

import { useAnnonceAnalyses } from '@/components/sources/annonce'
import {
  CarteÉmission,
  CarteÉmissionSquelette,
  type Creation,
  type Entrée,
} from '@/components/sources/carte-emission'
import { LigneMontage } from '@/components/sources/ligne-montage'
import { pluriel } from '@/components/sources/textes'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { comptesParFiltre, filtrer, FILTRES, type Filtre } from '@/core/bibliotheque'
import type { ProjectListItem, SourcesListing } from '@/lib/api'

/**
 * Où l'on avait laissé la grille, **pour la session seulement**.
 *
 * `sessionStorage` et non `localStorage` : la position de défilement décrit un
 * aller-retour en cours, pas une préférence. La retrouver trois jours plus tard,
 * sur une bibliothèque qui a changé entre-temps, désignerait une autre carte.
 */
export const CLE_DEFILEMENT = 'bibliotheque:defilement'

/**
 * Le nombre de squelettes posés pendant le chargement.
 *
 * Une pleine largeur d'écran, pas les dix-huit cartes : le squelette dit que
 * quelque chose arrive, il ne promet pas combien.
 */
const SQUELETTES = 8

const GRILLE = 'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4'

/**
 * La bibliothèque : **une carte par émission, et son état de traitement dessus**.
 *
 * L'écran montrait deux sections, « Projets » puis « Replays », et une émission
 * analysée y apparaissait deux fois — une fois par section. Un projet n'est que
 * l'état de traitement d'un replay : les deux listes décrivaient le même objet à
 * deux moments de sa vie, et la vue « Replays » était le bon modèle mental.
 *
 * **La jointure est côté client, et le coût serveur ne bouge pas.** Les deux
 * requêtes existaient déjà. Celle qui aurait été évidente — un
 * `GET /api/projects/:id` par entrée, pour connaître les artefacts présents —
 * reste écartée : elle exécute `relevéPrésence`, qui sonde le montage 9p sous
 * délai de garde, et quatre fils du vivier de libuv suffisent à figer tout ce
 * qui touche au disque dans le serveur, analyse en cours comprise. `bibliothèque`
 * (`@/core/bibliotheque`) fait l'appariement, pur et testable sans DOM.
 *
 * **Elle ne va pas chercher ses données** — l'écran les lui donne, avec le geste
 * de création et son état. C'est ce qui permet de la monter dans un test sans
 * client de requêtes ni serveur, et surtout de tenir les cinq états côte à côte
 * dans un seul fichier plutôt que répartis entre un hook et un rendu.
 *
 * **Le filtre et la recherche restent dans le composant**, pas dans l'URL. La
 * vue du tri, elle, est dans l'URL parce qu'on la quitte pour un clip et qu'un
 * rechargement doit rendre le même écran ; ici la racine est l'endroit d'où l'on
 * part et où l'on revient, et une recherche à demi tapée dans une URL est une URL
 * qu'on ne peut plus partager. Ce qui doit survivre à l'aller-retour est la
 * position de défilement, et elle est en session.
 */
export function GrilleBibliotheque({
  entrées,
  projets,
  montage,
  chargement,
  erreur,
  erreurProjets,
  onReessayer,
  creation,
}: {
  entrées: readonly Entrée[]
  /**
   * La liste brute des projets, pour la région live seulement.
   *
   * Elle ne sert pas au rendu — les cartes lisent `entrées` —, mais l'annonce
   * porte sur les changements d'étape, donc sur les projets et non sur les
   * replays : un projet orphelin qui reprend son analyse doit s'entendre comme
   * les autres.
   */
  projets: readonly ProjectListItem[] | undefined
  /** L'état du montage qui porte les replays, ou `undefined` tant qu'on ne sait pas. */
  montage: SourcesListing['montage'] | undefined
  chargement: boolean
  /** Le message **du serveur** pour `GET /api/sources`, ou `null`. */
  erreur: string | null
  /** Le message **du serveur** pour `GET /api/projects`, ou `null`. */
  erreurProjets: string | null
  onReessayer: () => void
  creation: Creation
}) {
  const [filtre, setFiltre] = useState<Filtre>('tous')
  const [recherche, setRecherche] = useState('')
  const champ = useId()
  const annonce = useAnnonceAnalyses(projets)

  const comptes = comptesParFiltre(entrées)
  const visibles = filtrer(entrées, filtre, recherche)

  // Le défilement ne se restaure qu'une fois les cartes là : le poser sur une
  // page de squelettes le poserait sur une hauteur qui n'est pas la bonne.
  const grille = useRef<HTMLElement>(null)
  useDefilementRetenu(grille, entrées.length > 0)

  const résumé =
    entrées.length === 0
      ? null
      : [
          pluriel(entrées.length, 'émission', 'émissions'),
          ...(comptes.analysees > 0
            ? [pluriel(comptes.analysees, 'analysée', 'analysées')]
            : []),
        ].join(' · ')

  return (
    <section ref={grille} aria-labelledby="titre-bibliotheque" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="titre-bibliotheque" className="text-sm font-semibold tracking-tight">
          Émissions
        </h2>
        {résumé !== null && (
          <p className="text-xs text-muted-foreground tabular-nums">{résumé}</p>
        )}
      </div>

      {/* **Une seule région, et elle n'annonce que les changements d'étape.**
          L'écran sonde toutes les deux secondes : une région live sur le
          pourcentage produirait une annonce toutes les deux secondes pendant
          neuf minutes. `role="status"` vaut `aria-live="polite"`. */}
      <p role="status" className="sr-only">
        {annonce}
      </p>

      {/* **L'échec d'une création vit au-dessus de la grille, pas dans la carte :**
          la carte peut avoir disparu au rechargement qui suit — ou sous un
          filtre —, et le message serait parti avec elle. */}
      {creation.erreur !== null && (
        <Alert variant="destructive" className="px-4 py-3">
          <TriangleAlert aria-hidden />
          <AlertTitle className="text-sm">L’analyse n’a pas pu être lancée.</AlertTitle>
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

      {/* **Trois origines d'erreur, et aucune n'efface les autres.** La liste des
          replays est en panne, la liste des projets l'est, ou une création a
          échoué. Sans la deuxième, une API de projets en panne rendait
          exactement la même page qu'une bibliothèque où rien n'est analysé —
          dix-huit cartes « À analyser » sur des émissions déjà traitées, ce qui
          invite à relancer une analyse de neuf minutes pour rien. */}
      {erreurProjets !== null && (
        <Alert variant="destructive" className="px-4 py-3">
          <TriangleAlert aria-hidden />
          <AlertTitle className="text-sm">
            L’état des analyses n’a pas pu être lu. Les cartes ci-dessous peuvent
            annoncer « À analyser » à tort.
          </AlertTitle>
          <AlertDescription className="text-xs">{erreurProjets}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={onReessayer}>
              Réessayer
            </Button>
          </AlertAction>
        </Alert>
      )}

      {erreur !== null ? (
        <Alert variant="destructive" className="px-4 py-3">
          <TriangleAlert aria-hidden />
          <AlertTitle className="text-sm">Les émissions n’ont pas pu être listées.</AlertTitle>
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
      ) : chargement ? (
        <ul className={GRILLE}>
          {Array.from({ length: SQUELETTES }, (_, i) => (
            <li key={i}>
              <CarteÉmissionSquelette />
            </li>
          ))}
        </ul>
      ) : entrées.length === 0 && montage !== undefined ? (
        // Le vide de la bibliothèque **est** celui du dossier des replays : sans
        // fichier et sans projet, il n'y a rien à montrer et une seule question
        // à poser — le montage a-t-il eu lieu ? La cause vient du serveur, qui
        // seul sait si le chemin était absent, refusé, muet ou illisible.
        <LigneMontage montage={montage} onReessayer={onReessayer} />
      ) : (
        <Tabs value={filtre} onValueChange={(valeur) => setFiltre(valeur as Filtre)}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              {FILTRES.map(({ valeur, libelle }) => (
                <TabsTrigger key={valeur} value={valeur} className="px-2.5">
                  {libelle}
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {comptes[valeur]}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>

            <div className="relative">
              {/* Le libellé est hors écran : la boîte porte déjà son
                  pictogramme et son texte d'invite, et une étiquette visible
                  au-dessus d'un champ de recherche unique n'apprend rien à
                  l'œil — mais elle reste indispensable à qui n'a que la voix. */}
              <label htmlFor={champ} className="sr-only">
                Chercher une émission par son titre
              </label>
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id={champ}
                type="search"
                value={recherche}
                onChange={(e) => setRecherche(e.target.value)}
                placeholder="Chercher une émission"
                className="h-8 w-56 pl-8 text-xs"
              />
            </div>
          </div>

          <TabsContent value={filtre} className="mt-3">
            {visibles.length === 0 ? (
              <Vide filtre={filtre} recherche={recherche} onEffacer={() => setRecherche('')} />
            ) : (
              <ul className={GRILLE}>
                {visibles.map((entrée) => (
                  <li key={entrée.clé}>
                    <CarteÉmission entrée={entrée} creation={creation} />
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      )}
    </section>
  )
}

/**
 * Le vide d'un filtre, **qui n'est pas le vide de la bibliothèque**.
 *
 * Les confondre serait un défaut de diagnostic : « aucune émission en erreur »
 * est une bonne nouvelle, « le dossier des replays n'est pas monté » en est une
 * mauvaise, et les deux rendaient la même page grise. Le second est traité plus
 * haut, par la ligne de montage.
 *
 * Une recherche sans résultat porte son geste — effacer —, parce qu'un filtre
 * qui ne rend rien et une boîte de recherche pleine trois lignes plus haut se
 * lisent mal ensemble.
 */
function Vide({
  filtre,
  recherche,
  onEffacer,
}: {
  filtre: Filtre
  recherche: string
  onEffacer: () => void
}) {
  const libelle = FILTRES.find((f) => f.valeur === filtre)?.libelle ?? ''

  if (recherche.trim() !== '') {
    return (
      <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed px-4 py-6">
        <p className="text-sm">
          Aucune émission ne porte « {recherche} »{filtre !== 'tous' && <> sous « {libelle} »</>}.
        </p>
        <Button variant="outline" size="sm" onClick={onEffacer}>
          Effacer la recherche
        </Button>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-dashed px-4 py-6">
      <p className="text-sm text-muted-foreground">
        {filtre === 'aanalyser'
          ? 'Toutes les émissions du dossier ont été analysées.'
          : filtre === 'encours'
            ? 'Aucune analyse ne tourne en ce moment.'
            : filtre === 'analysees'
              ? 'Aucune émission n’est encore analysée.'
              : filtre === 'erreurs'
                ? 'Aucune analyse n’a échoué ni été interrompue.'
                : 'Aucune émission.'}
      </p>
    </div>
  )
}

/**
 * La position de défilement, gardée pendant la session.
 *
 * **Le retour d'une émission ne doit rien coûter.** Dix-huit cartes chargées à
 * la demande : revenir en haut à chaque aller-retour ferait redemander ce qui a
 * déjà été vu, et c'est un aller-retour par clip monté.
 *
 * La restauration du navigateur ne suffit pas ici, et c'est pour cela que ce
 * hook existe : elle a lieu avant que la requête ne réponde, sur une page qui ne
 * fait alors que la hauteur de ses squelettes — il n'y a nulle part où
 * descendre, et la position est perdue en silence.
 *
 * **La position est relative au haut de la grille, jamais à la page.** Ce qui la
 * précède — le résumé, les bandeaux d'erreur — change de hauteur entre le départ
 * et le retour, et une position absolue retomberait alors une rangée trop haut.
 *
 * **Ce que la bibliothèque unifiée règle, et qui était le point 2 de l'issue
 * #56.** Le cas ouvert était « une rangée qui change de hauteur *après* la
 * restauration » : la section des projets, au-dessus de la grille, faisait
 * pousser une barre d'avancement au tour de sondage suivant. Cette section a
 * disparu, et les cartes de la grille tiennent désormais la **même hauteur dans
 * les cinq états** (voir `HAUTEUR_CARTE`) — barre d'avancement comprise. Rien ne
 * grandit donc plus après coup, et l'ancrage suffit.
 *
 * L'écriture est directe et non temporisée : `sessionStorage.setItem` sur une
 * chaîne de trois caractères se compte en microsecondes, et une temporisation
 * perdrait la dernière position juste avant la navigation, qui est exactement
 * celle qui compte.
 */
function useDefilementRetenu(grille: RefObject<HTMLElement | null>, pret: boolean) {
  useEffect(() => {
    if (!pret) return
    const haut = hautDeLaGrille(grille)
    if (haut === null) return
    const garde = lireSession(CLE_DEFILEMENT)
    if (garde === null) return
    const décalage = Number(garde)
    if (Number.isFinite(décalage)) window.scrollTo(0, Math.max(0, haut + décalage))
  }, [grille, pret])

  // **Et on n'écrit que pendant ce temps-là.** La restauration du navigateur
  // tente l'ancienne position sur une page qui n'a alors que la hauteur de ses
  // squelettes : elle est ramenée vers le haut, et l'événement de défilement
  // qu'elle émet écrasait la position gardée — les cartes arrivaient ensuite sur
  // une valeur rabotée. Même chose quand une erreur remplace la grille : il n'y
  // a rien à retenir d'une page où il n'y a rien à voir.
  useEffect(() => {
    if (!pret) return
    const retenir = () => {
      const haut = hautDeLaGrille(grille)
      if (haut !== null) écrireSession(CLE_DEFILEMENT, String(window.scrollY - haut))
    }
    window.addEventListener('scroll', retenir, { passive: true })
    return () => window.removeEventListener('scroll', retenir)
  }, [grille, pret])
}

/**
 * Le haut de la grille **dans le document**, ou `null` si elle n'est pas rendue.
 *
 * `getBoundingClientRect().top` est relatif à la fenêtre : additionner le
 * défilement courant le ramène à une position de document, la seule qui soit
 * comparable d'une visite à l'autre.
 */
function hautDeLaGrille(grille: RefObject<HTMLElement | null>): number | null {
  const élément = grille.current
  return élément === null ? null : élément.getBoundingClientRect().top + window.scrollY
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
