'use client'

import { FolderOpen, Inbox, TriangleAlert } from 'lucide-react'

import { pluriel } from '@/components/sources/textes'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { SourcesListing } from '@/lib/api'

/**
 * La ligne de montage : **ce qui distingue trois vides que rien d'autre ne
 * distingue**.
 *
 * C'est un incident réel d'OpenShorts (spec §12) : « le dossier des replays est
 * vide » et « le dossier des replays n'existe pas » rendaient la même page, donc
 * on cherchait des fichiers manquants pendant que le partage était tombé.
 * `SourcesListing.montage` existe pour ça, et l'écran serait fautif de ne pas
 * s'en servir.
 *
 * Le troisième vient en prime et ne coûte rien : `entrées` compte **toutes** les
 * entrées du dossier, vidéos ou non. Un dossier qui en porte trois sans qu'aucune
 * ne soit une vidéo n'est pas vide, il est mal rempli — et le dire épargne de
 * remonter un partage qui fonctionne.
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
    <Alert variant={grave ? 'destructive' : 'default'} className="px-4 py-3">
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

function diagnostic(montage: SourcesListing['montage']) {
  if (!montage.disponible) {
    return {
      grave: true,
      icone: <TriangleAlert aria-hidden />,
      titre: 'Le dossier des replays n’est pas monté.',
      // Le geste vient de `CLAUDE.md`, et il est formulé comme le 503 de
      // `POST /api/projects` : une seule voix pour un seul incident.
      detail:
        'REPLAY_DIR est monté en 9p : il peut être absent, ou monté avec son transport mort dessous. ' +
        'Rouvrir le lecteur côté Windows, ou remonter le partage.',
    }
  }

  if (montage.entrées > 0) {
    return {
      grave: false,
      icone: <FolderOpen aria-hidden />,
      titre: 'Aucune vidéo dans le dossier des replays.',
      detail: `Le dossier est monté${suffixeFstype(montage.fstype)} et contient ${pluriel(
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
    // **Le `fstype` est la preuve.** Sans lui, « vide » et « absent » se lisent
    // de la même façon, et on repart chercher lequel des deux on regarde.
    detail: `Il est bien monté${suffixeFstype(montage.fstype)} — il n’y a simplement rien dedans.`,
  }
}

/** `null` quand le relevé n'a pas abouti : on n'affiche alors pas de parenthèse vide. */
function suffixeFstype(fstype: string | null): string {
  return fstype === null ? '' : ` (${fstype})`
}
