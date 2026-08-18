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
    <Alert
      variant={grave ? 'destructive' : 'default'}
      // **`role="alert"` est assertif, et deux de ces trois états ne sont pas des
      // pannes.** La primitive le pose en dur ; un dossier vide interromprait
      // donc la lecture en cours comme le ferait un montage tombé. La conception
      // §4.3 n'admet que trois régions live, et les erreurs sont la seule
      // assertive — le reste est poli. (relevé par Copilot)
      role={grave ? 'alert' : 'status'}
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

/** Le geste qui répare, identique aux deux modes de panne — il vient de `CLAUDE.md`. */
const REPARATION = 'Rouvrir le lecteur côté Windows, ou remonter le partage.'

function diagnostic(montage: SourcesListing['montage']) {
  if (!montage.disponible) {
    // **`fstype` se relève même quand l'accès échoue, et c'est là qu'il sert le
    // plus** — le commentaire de `fstypeDeMontage` (`src/server/sources.ts`) le
    // dit ainsi : « un `ext4` là où on attend un `9p` dit “ce montage n'a pas eu
    // lieu” ». Les deux modes de panne de `CLAUDE.md` se distinguent donc ici, et
    // les annoncer pareil referait l'incident que ce champ existe pour fermer.
    // Le geste, lui, est le même dans les deux cas. (relevé par Copilot)
    if (montage.fstype === MONTAGE_ATTENDU) {
      return {
        grave: true,
        icone: <TriangleAlert aria-hidden />,
        titre: 'Le dossier des replays ne répond pas.',
        detail: `Le partage est bien monté en ${MONTAGE_ATTENDU}, mais son transport est mort dessous — /proc/mounts ne le distingue pas d’un montage sain. ${REPARATION}`,
      }
    }
    return {
      grave: true,
      icone: <TriangleAlert aria-hidden />,
      titre: 'Le dossier des replays n’est pas monté.',
      detail: `${
        montage.fstype === null
          ? 'Aucun montage relevé ne porte REPLAY_DIR'
          : `Le chemin est servi par ${montage.fstype}, pas par le partage ${MONTAGE_ATTENDU} attendu`
      }. ${REPARATION}`,
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
