'use client'

import { Film } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { clipDuration } from '@/core/edl'
import type { CandidateClip } from '@/lib/api'
import { LIBELLES_STATUT } from '@/lib/clip-status'
import { formatDuration } from '@/lib/format'
import { lienClip } from '@/lib/parcours'
import { cn } from '@/lib/utils'

/**
 * La fresque : tous les clips gardés de l'émission, en une bande.
 *
 * **Ce qu'elle remplace n'est pas « Clip précédent / Clip suivant », c'est leur
 * cécité.** Les deux boutons font avancer sans jamais dire où l'on est ni ce
 * qu'il reste : on monte le quatrième clip d'une émission qui en a douze sans
 * qu'aucune surface ne le montre. Un rang écrit en toutes lettres — « clip 4 sur
 * 12 » — le dit, une bande de vignettes le fait voir, et les deux boutons
 * restent parce qu'ils portent une règle que la bande n'exprime pas :
 * `clipSuivant` saute les écartés, donc « le clip suivant à monter » n'est pas
 * toujours « celui d'à côté ».
 *
 * **Aucune requête de plus.** L'écran de clip interroge déjà `useCandidats` pour
 * son rang, et la liste porte `thumbnailUrl` : la bande se sert de ce qui est
 * déjà là.
 *
 * **Le clip courant n'est pas un lien.** Un lien vers l'écran où l'on est n'est
 * pas une navigation et volerait un arrêt de tabulation — c'est la règle que le
 * fil d'Ariane applique déjà à son dernier cran (`app-bar.tsx`). Il porte
 * `aria-current="page"`, qui est ce qu'un lecteur d'écran attend.
 */
export function ClipStrip({
  clips,
  currentId,
}: {
  /** Les clips **gardés** du projet, dans l'ordre du replay. */
  clips: readonly CandidateClip[]
  currentId: string
}) {
  const currentItem = useRef<HTMLLIElement>(null)

  // Le clip courant sous les yeux à l'ouverture. Sur une émission à douze clips,
  // le quatrième est hors du champ visible dès le départ, et une bande qui
  // s'ouvre sur le premier fait croire qu'on édite celui-là.
  //
  // L'appel est optionnel parce que jsdom n'implémente pas `scrollIntoView` :
  // une garde ici vaut mieux qu'un bouchon dans chaque fichier de test.
  useEffect(() => {
    currentItem.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' })
  }, [currentId])

  if (clips.length === 0) return null

  return (
    <nav aria-label="Les clips gardés de l’émission" className="min-w-0 flex-1">
      <ol className="flex items-stretch gap-2 overflow-x-auto px-4 py-2">
        {clips.map((clip, index) => {
          const isCurrent = clip.id === currentId
          const card = (
            <Thumbnail clip={clip} rank={index + 1} total={clips.length} current={isCurrent} />
          )
          return (
            <li key={clip.id} ref={isCurrent ? currentItem : undefined} className="shrink-0">
              {isCurrent ? (
                <span aria-current="page" className="block rounded-lg ring-2 ring-stage">
                  {card}
                </span>
              ) : (
                <Link
                  href={lienClip(clip.id)}
                  className="block rounded-lg ring-1 ring-border transition-colors outline-none hover:ring-foreground/30 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {card}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * Une vignette : l'image, le rang, le titre court, l'état.
 *
 * Le rang est dit au complet dans le texte accessible — « clip 4 sur 12 » — et
 * abrégé à l'œil. Un lecteur d'écran qui n'entendrait que « 4 » ne saurait pas
 * de quoi c'est le quatrième ; une bande de douze vignettes, elle, n'a pas la
 * place de répéter « sur 12 » douze fois.
 */
function Thumbnail({
  clip,
  rank,
  total,
  current,
}: {
  clip: CandidateClip
  rank: number
  total: number
  current: boolean
}) {
  // L'URL dont l'image n'est pas arrivée. Retenue plutôt qu'un booléen : la
  // bande change de clips au fil de la navigation, et un drapeau garderait le
  // repli d'une vignette pour la suivante.
  const [failed, setFailed] = useState<string | null>(null)
  const duration = clipDuration(clip.segments)
  const hasImage = clip.thumbnailUrl !== null && failed !== clip.thumbnailUrl

  return (
    <span className="flex w-36 flex-col gap-1 p-1">
      <span
        aria-hidden
        className={cn(
          'relative flex aspect-video w-full items-center justify-center overflow-hidden rounded bg-zinc-950 text-zinc-700',
          !current && 'opacity-80',
        )}
      >
        <Film className="size-4" />
        {hasImage && (
          // Même exception de lint qu'ailleurs dans le dépôt : la vignette sort
          // d'une route locale à une taille déjà fixée, `next/image` n'aurait
          // rien à optimiser, et passer par `/_next/image` ajouterait un second
          // décodage par vignette — ici multiplié par le nombre de clips gardés.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={clip.thumbnailUrl ?? ''}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailed(clip.thumbnailUrl)}
            className="absolute inset-0 size-full object-cover"
          />
        )}
        <span className="absolute right-1 bottom-1 rounded bg-black/60 px-1 font-mono text-xs text-white tabular-nums">
          {formatDuration(duration)}
        </span>
      </span>

      <span className="flex items-baseline gap-1.5 text-[0.75rem]">
        <span className="font-mono text-muted-foreground tabular-nums">
          <span className="sr-only">
            clip {rank} sur {total},{' '}
          </span>
          <span aria-hidden>{rank}</span>
        </span>
        <span className={cn('truncate', current ? 'font-medium' : 'text-muted-foreground')}>
          {clip.title || 'sans titre'}
        </span>
      </span>

      <span
        className={cn(
          'text-[0.75rem] capitalize',
          clip.status === 'exported' ? 'text-stage' : 'text-muted-foreground',
        )}
      >
        {LIBELLES_STATUT[clip.status]}
      </span>
    </span>
  )
}
