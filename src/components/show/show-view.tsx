'use client'

import { useRef, useState } from 'react'

import { CoverageTimeline } from '@/components/show/coverage-timeline'
import { ShowPlayer } from '@/components/show/player'
import { estGarde } from '@/lib/clip-status'
import type { CandidateClip } from '@/lib/api'

/**
 * La vue Émission : **le proxy, et ce qu'on en a tiré**.
 *
 * L'écran de projet n'était qu'un écran de tri. Une fois l'analyse terminée,
 * c'est aussi l'endroit depuis lequel on comprend tout ce qui a été produit à
 * partir de l'émission — d'où ces deux surfaces, posées au-dessus de la grille :
 * le replay lui-même, et la bande qui dit où sont les clips gardés.
 *
 * **Les deux ne partagent qu'un nombre**, l'instant courant. Le lecteur le
 * publie, la bande le dessine et peut le déplacer. Rien d'autre ne circule : ni
 * état de lecture, ni file de commandes, ni horloge. C'est ce qui fait que la
 * bande se monte seule dans un test, sans `<video>` — jsdom n'en implémente ni
 * `play()` ni le décodage.
 *
 * **Elle se replie quand il n'y a rien à montrer.** Pendant les trois premières
 * minutes, le panneau d'avancement occupe la page et cette vue n'existe pas ;
 * c'est l'écran de projet qui en décide, pas elle.
 */
export function ShowView({
  projectId,
  durationSec,
  proxyReady,
  clips,
  clipsKnown = true,
  onOpenClip,
}: {
  projectId: string
  /** La durée de l'émission, sondée à l'ingestion. */
  durationSec: number
  proxyReady: boolean
  /** Tous les candidats. La bande ne garde que les gardés. */
  clips: readonly CandidateClip[]
  /** Faux quand `GET /candidates` a échoué sans rien laisser en cache. */
  clipsKnown?: boolean
  /** Le départ vers un clip, pour que l'écran pose sa marque de retour. */
  onOpenClip?: (clipId: string) => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [time, setTime] = useState(0)

  // `estGarde` et non `status === 'kept'` : un clip exporté est une décision
  // humaine qui a déjà produit un fichier, et c'est justement celui qu'on veut
  // voir sur la bande.
  const kept = clips.filter((c) => estGarde(c.status))

  /**
   * Déplacer la lecture.
   *
   * **`null` quand il n'y a pas de proxy** : la bande reste alors une carte de
   * l'émission — elle dit où sont les clips — mais elle ne promet pas un
   * déplacement qui n'aurait rien à déplacer. Un curseur qui change de forme sur
   * une surface inerte est la façon la plus sûre de faire cliquer trois fois.
   */
  const seek = proxyReady
    ? (seconds: number) => {
        const element = video.current
        if (element !== null) element.currentTime = seconds
        // L'état local suit tout de suite : `seeked` peut mettre plusieurs
        // centaines de millisecondes sur un fichier d'un gigaoctet, et la tête
        // de lecture doit répondre au clic, pas à la fin du saut.
        setTime(seconds)
      }
    : null

  return (
    <section aria-labelledby="titre-emission" className="flex flex-col gap-3">
      <h2 id="titre-emission" className="sr-only">
        L’émission
      </h2>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        <ShowPlayer
          projectId={projectId}
          proxyReady={proxyReady}
          video={video}
          onTime={setTime}
        />
        <CoverageTimeline
          clips={kept}
          clipsKnown={clipsKnown}
          durationSec={durationSec}
          time={time}
          onSeek={seek}
          onOpenClip={onOpenClip}
        />
      </div>
    </section>
  )
}
