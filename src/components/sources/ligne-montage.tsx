'use client'

import { FolderOpen, Inbox, TriangleAlert } from 'lucide-react'

import { pluriel } from '@/components/sources/textes'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { CauseIndisponible, SourcesListing } from '@/lib/api'

/**
 * La ligne de montage : **ce qui distingue six vides que rien d'autre ne
 * distingue**.
 *
 * C'est un incident réel d'OpenShorts (spec §12) : « le dossier des replays est
 * vide » et « le dossier des replays n'existe pas » rendaient la même page, donc
 * on cherchait des fichiers manquants pendant que le partage était tombé.
 * `SourcesListing.montage` existe pour ça, et l'écran serait fautif de ne pas
 * s'en servir.
 *
 * Deux vides viennent en prime et ne coûtent rien. `entrées` compte **toutes**
 * les entrées du dossier, vidéos ou non : un dossier qui en porte trois sans
 * qu'aucune ne soit une vidéo n'est pas vide, il est mal rempli, et le dire
 * épargne de remonter un partage qui fonctionne. Et `cause` dit **laquelle** des
 * quatre façons d'échouer a eu lieu (issue #56, point 5) : quatre états là où
 * l'écran devait auparavant énumérer les trois gestes possibles.
 *
 * **Chaque état porte son geste.** Le pire cas du parcours — montage absent et
 * aucun projet — est la seule chose que la page affiche alors ; s'il ne portait
 * qu'un constat, la bibliothèque serait une impasse.
 */
export function LigneMontage({
  montage,
  onReessayer,
}: {
  montage: SourcesListing['montage']
  onReessayer: () => void
}) {
  const { titre, detail, icone, grave } = diagnostic(montage)

  return (
    <Alert
      variant={grave ? 'destructive' : 'default'}
      // **`role="alert"` est assertif, et deux de ces trois états ne sont pas des
      // pannes.** La primitive le pose en dur ; un dossier vide interromprait
      // donc la lecture en cours comme le ferait un montage tombé.
      //
      // Mais il ne devient pas poli pour autant : la conception §4.3 admet
      // **trois** régions live — l'avancement, les erreurs, le résultat d'un
      // export — et « pas une de plus ». Un dossier vide n'est aucune des trois,
      // et il se lit en arrivant sur la page comme s'y lit la grille elle-même,
      // qu'on n'annonce pas davantage. `undefined` retire l'attribut : la
      // primitive pose son `role` avant l'étalement des props.
      // (relevé par Copilot, qui avait d'abord suggéré `status`)
      role={grave ? 'alert' : undefined}
      className="px-4 py-3"
    >
      {icone}
      <AlertTitle className="text-sm">{titre}</AlertTitle>
      <AlertDescription className="text-xs">{detail}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={onReessayer}>
          Réessayer
        </Button>
      </AlertAction>
    </Alert>
  )
}

/**
 * Le système de fichiers du partage, tel que `CLAUDE.md` le décrit et que le 503
 * de `POST /api/projects` le nomme déjà à l'utilisateur. Il n'est pas deviné
 * ici : c'est la même valeur, écrite au même endroit du produit.
 */
const MONTAGE_ATTENDU = '9p'

/** Le geste qui répare un partage tombé — il vient de `CLAUDE.md`. */
const REPARATION = 'Rouvrir le lecteur côté Windows, ou remonter le partage.'

/**
 * Ce que l'écran dit de chaque cause, **une phrase et un geste**.
 *
 * **C'est le remède du point 5 de l'issue #56, et il se voit surtout à ce qui a
 * disparu.** Tant que `disponible: false` recouvrait quatre causes, ce bloc
 * devait les énumérer : « le chemin est peut-être absent ou refusé — ou le
 * partage a perdu son transport… vérifier REPLAY_DIR et ses droits ; s'ils sont
 * bons, rouvrir le lecteur ». Trois gestes ordonnés du moins cher au plus cher,
 * honnêtes, et trois fois trop longs. Le serveur savait lequel des trois
 * s'appliquait et le jetait (`releverAvecGarde`) ; il le dit maintenant.
 *
 * **`absent` est celui qui valait le déplacement.** Un `REPLAY_DIR` mal
 * orthographié sous un partage 9p parfaitement sain rendait `fstype: '9p'` avec
 * la lecture en échec — le diagnostic le plus trompeur possible, puisqu'il
 * désigne le partage alors que le partage va bien. C'est une faute de frappe, et
 * l'écran le dit en toutes lettres.
 */
function selonLaCause(cause: CauseIndisponible, fstype: string | null): {
  titre: string
  detail: string
} {
  switch (cause) {
    case 'absent':
      return {
        titre: 'Le dossier des replays n’existe pas à ce chemin.',
        detail:
          fstype === MONTAGE_ATTENDU
            ? `Le partage ${MONTAGE_ATTENDU} répond : c’est donc le chemin qui est faux. Vérifier REPLAY_DIR.`
            : `${relevé(fstype)} Vérifier REPLAY_DIR, puis le partage : ${abaisser(REPARATION)}`,
      }
    case 'refusé':
      return {
        titre: 'La lecture du dossier des replays est refusée.',
        // **Le dossier, ou l'un de ses fichiers**, et la nuance n'est pas de la
        // prudence : un seul `lstat` refusé fait basculer tout le dossier
        // (`releverLeDossier`, et c'était le second cas mesuré de l'issue #56).
        // Envoyer regarder les seuls droits du dossier ferait chercher là où il
        // n'y a rien à voir.
        detail:
          'Les droits refusent le dossier, ou l’un des fichiers qu’il contient. Vérifier les droits sur REPLAY_DIR et sur son contenu.',
      }
    case 'muet':
      return {
        titre: 'Le dossier des replays ne répond pas.',
        detail: `Le partage est monté mais n’a rien rendu dans le temps imparti : son transport est mort dessous, et /proc/mounts ne le distingue pas d’un partage sain. ${REPARATION}`,
      }
    case 'illisible':
      return {
        titre: 'Le dossier des replays n’a pas pu être lu.',
        detail: `Le système de fichiers a rendu une erreur que le serveur ne sait pas nommer. ${relevé(fstype)} ${REPARATION}`,
      }
  }
}

function diagnostic(montage: SourcesListing['montage']) {
  if (montage.cause !== null) {
    return {
      grave: true,
      icone: <TriangleAlert aria-hidden />,
      ...selonLaCause(montage.cause, montage.fstype),
    }
  }

  // **`disponible: false` sans cause ne peut pas arriver**, et le dire ici plutôt
  // que de l'affirmer dans un type revient au même pour deux lignes : le serveur
  // pose les deux ensemble. Si jamais l'un survivait sans l'autre, `illisible`
  // est la seule case qui ne mente pas.
  if (!montage.disponible) {
    return {
      grave: true,
      icone: <TriangleAlert aria-hidden />,
      ...selonLaCause('illisible', montage.fstype),
    }
  }

  if (montage.entrées > 0) {
    return {
      grave: false,
      icone: <FolderOpen aria-hidden />,
      titre: 'Aucune vidéo dans le dossier des replays.',
      detail: `${relevé(montage.fstype)} Il contient ${pluriel(
        montage.entrées,
        'entrée',
        'entrées',
      )}, mais aucune ne porte une extension de vidéo.`,
    }
  }

  return {
    grave: false,
    icone: <Inbox aria-hidden />,
    titre: 'Le dossier des replays est vide.',
    detail: `${relevé(montage.fstype)} Il n’y a rien dedans.`,
  }
}

/** Une phrase mise en incise : sa majuscule tombe. */
function abaisser(phrase: string): string {
  return `${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}`
}

/**
 * Ce que le relevé dit du chemin, **y compris quand il répond**.
 *
 * **Un accès qui réussit ne prouve pas que le partage est là.** Un point de
 * montage resté vide sur la racine locale se liste très bien : `readdir`
 * réussit, `disponible` vaut vrai, et le dossier passe pour sain alors que le
 * partage n'est nulle part. Le `fstype` est le seul signal qui le dise, et
 * l'écran l'affichait comme une confirmation — « il est bien monté (ext4) ».
 * (relevé par Codex)
 *
 * **Il énonce le relevé, il ne rend pas de verdict**, et c'est délibéré : rien
 * n'interdit de pointer `REPLAY_DIR` sur un dossier local en développement, et
 * déclarer « non monté » un dossier qui fonctionne serait une fausse alerte. Le
 * fait suffit — celui qui lit sait ce qu'il a monté.
 */
function relevé(fstype: string | null): string {
  if (fstype === MONTAGE_ATTENDU) return `Le partage ${MONTAGE_ATTENDU} répond.`
  if (fstype === null) {
    return `Aucun montage relevé ne porte ce chemin : le partage ${MONTAGE_ATTENDU} attendu n’est pas là.`
  }
  return `Système de fichiers relevé : ${fstype} — le partage ${MONTAGE_ATTENDU} attendu n’est pas là.`
}
