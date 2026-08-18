'use client'

import { Film } from 'lucide-react'
import type { RefObject } from 'react'

/**
 * Le proxy de l'émission, lu dans la vue Émission.
 *
 * **Ce n'est pas `ClipPlayer`, et ce n'en est pas une variante.** Celui-là saute
 * les passages retirés (`playbackAction`, `src/lib/editing.ts`) : c'est ce qui
 * fait qu'un clip se prévisualise tel qu'il sortira. Ici on regarde l'émission
 * entière, trous compris — c'est même tout l'intérêt de l'écran : voir ce qui
 * *n'a pas* été extrait. Un lecteur qui sauterait ne pourrait pas le montrer.
 *
 * **Les contrôles sont ceux du navigateur.** Lecture, pause, barre de lecture,
 * volume, plein écran, raccourcis clavier et étiquettes traduites : tout est là,
 * accessible, et rien à tenir d'accord avec l'état d'un `<video>` qu'un
 * `timeupdate` fait bouger trente fois par seconde. La seule chose que le
 * navigateur ne sait pas faire est ce que la bande de couverture ajoute juste en
 * dessous, et c'est là que le travail se justifie.
 *
 * **Le scrub ne demande rien au serveur.** `GET /api/projects/:id/proxy` répond
 * déjà aux requêtes partielles (`src/core/range.ts`) : sans cela, un `<video>`
 * ne peut pas sauter et la barre de lecture reste inerte.
 */
export function ShowPlayer({
  projectId,
  proxyReady,
  video,
  onTime,
}: {
  projectId: string
  /**
   * Le proxy est-il encodé ?
   *
   * Il arrive six minutes après le lancement sur une émission d'1 h 40, et le
   * tri s'ouvre bien avant. L'absence se dit avec **ce qui la lèvera** : une
   * attente dont on connaît la cause est une attente supportable.
   */
  proxyReady: boolean
  video: RefObject<HTMLVideoElement | null>
  /** L'instant courant, en secondes. La bande de couverture s'en sert. */
  onTime: (seconds: number) => void
}) {
  if (!proxyReady) {
    return (
      <div
        data-testid="proxy-absent"
        className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/40 px-6 text-center"
      >
        <Film className="size-6 text-muted-foreground/50" aria-hidden />
        <p className="text-sm text-muted-foreground">
          Les images arrivent avec le proxy, en cours d’encodage.
        </p>
      </div>
    )
  }

  return (
    <video
      ref={video}
      data-testid="lecteur-emission"
      // **`preload="metadata"` et non `auto`.** Le proxy pèse plus d'un
      // gigaoctet et cet écran s'ouvre à chaque retour de clip : tirer la vidéo
      // entière à chaque visite coûterait la bande passante du disque pour un
      // écran où l'on ne lit pas toujours. Les métadonnées suffisent à ce que la
      // barre de lecture connaisse la durée et sache sauter.
      preload="metadata"
      controls
      src={`/api/projects/${encodeURIComponent(projectId)}/proxy`}
      onTimeUpdate={(e) => onTime(e.currentTarget.currentTime)}
      // Un saut à la souris dans la barre du navigateur doit bouger la tête de
      // lecture de la bande, et `timeupdate` ne se déclenche pas toujours à
      // l'arrêt : `seeked` ferme le cas.
      onSeeked={(e) => onTime(e.currentTarget.currentTime)}
      className="aspect-video w-full rounded-xl border bg-black"
    />
  )
}
