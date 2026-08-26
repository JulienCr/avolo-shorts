/**
 * La carte d'une planche — issue #191, lot 2, invariant 1 rendu
 * irreprésentable : une paire dont les deux côtés sortiraient de deux
 * instants source différents ne peut pas s'écrire, faute de champ pour le
 * second instant.
 *
 * `page.ts` lit l'instant sur la carte, jamais sur une image : aucune
 * légende ne peut donc mentir sur le moment qu'elle montre.
 */

import { shotStartMs } from '@/core/shots'
import type { Shot } from '@/core/shots'
import type { Ratio } from '@/core/edl'
import type { ShotState } from './share'
import type { BoardSpec } from './spec'

export type BoardImage = {
  variantId: string
  variantLabel: string
  dataUri: string
  alt: string
  decision: { ratio: Ratio; split: boolean; cropX: number; canvas: 'vertical' | 'native' }
  // Pas de champ temporel. Volontaire — voir l'en-tête du fichier.
}

export type BoardCard = {
  key: string
  /** Le `BoardCase.id` dont cette carte est un état — voir `page.ts` pour ce que ça débloque. */
  caseId: string
  projectId: string
  shot: Shot
  state: ShotState
  /** Un seul instant, partagé par toutes les images. */
  instant: number
  images: readonly [BoardImage, ...BoardImage[]]
  stake: string
}

/**
 * L'assemblage complet d'une planche : la spécification, les cartes rendues
 * et de quoi répondre à la question de reproductibilité (issue #191 §5) —
 * quel commit, quand.
 */
export type Board = {
  spec: BoardSpec
  cards: readonly BoardCard[]
  commit: string
  generatedAt: string
}

export function buildCard(o: {
  caseId: string
  projectId: string
  shot: Shot
  state: ShotState
  instant: number
  images: BoardImage[]
  stake: string
}): BoardCard {
  if (o.images.length === 0) {
    throw new Error(`buildCard : aucune image pour "${o.projectId}" plan ${o.shot.start}-${o.shot.end}.`)
  }
  const instantMs = Math.round(o.instant * 1000)
  const key = `${o.projectId}@${shotStartMs(o.shot)}#${o.state.state.id}@${instantMs}`
  return {
    key,
    caseId: o.caseId,
    projectId: o.projectId,
    shot: o.shot,
    state: o.state,
    instant: o.instant,
    images: o.images as [BoardImage, ...BoardImage[]],
    stake: o.stake,
  }
}
