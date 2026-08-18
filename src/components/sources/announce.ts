'use client'

import { useState } from 'react'

import { LIBELLES_ETAPES } from '@/core/parcours'
import type { ProjectListItem, StepName } from '@/lib/api'

/**
 * Ce qui se dit à voix haute d'une bibliothèque qui travaille : **les changements
 * d'étape, et la fin**.
 *
 * **Une annonce par changement d'étape, plus une à la fin** — donc autant que le
 * graphe a d'étapes observables, et pas un compte figé : `ÉTAPES` en porte cinq
 * depuis que la PR #31 y a ajouté `analysis`, et la prochaine itération en
 * ajoutera. Ce qui compte est l'ordre de grandeur : une poignée sur toute
 * l'analyse, contre une toutes les deux secondes pendant neuf minutes si le
 * pourcentage y passait. (relevé par Copilot)
 *
 * La comparaison porte sur l'étape et non sur la progression : deux tours de
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
 * motif documenté par React pour l'état qui se recale sur ses props.
 *
 * **Et la comparaison porte sur une signature, jamais sur l'identité du
 * tableau.** TanStack Query partage ses structures et rend donc la même
 * référence tant que rien ne change ; mais un appelant qui écrirait
 * `projects={data ?? []}` fabriquerait un tableau neuf à chaque rendu, et la
 * comparaison par identité boucherait indéfiniment. Une chaîne dérivée ne peut
 * pas se tromper là-dessus.
 *
 * Ce module a suivi la disparition de la section « Projets » : il vivait dans
 * `liste-projets.tsx`, et c'est la bibliothèque unifiée qui le monte désormais.
 */
type Memory = {
  /** Ce qui a produit l'annonce en cours : l'étape et l'échec de chaque projet. */
  signature: string
  steps: Map<string, StepName>
  message: string
}

export function useAnalysisAnnouncement(
  projects: readonly ProjectListItem[] | undefined,
): string {
  const [memory, setMemory] = useState<Memory>(() => ({
    signature: '',
    steps: new Map(),
    message: '',
  }))

  const signature = sign(projects)
  if (signature !== memory.signature) setMemory(announce(memory, projects, signature))

  return memory.message
}

/**
 * Ce dont l'annonce dépend, et rien d'autre : l'étape en cours de chaque projet
 * et le fait qu'il ait échoué. La progression n'y est pas — c'est ce qui fait
 * qu'un tour de sondage sur un pourcentage qui avance ne dit rien.
 */
function sign(projects: readonly ProjectListItem[] | undefined): string {
  return (projects ?? [])
    .map((p) => `${p.id}\u0000${p.running?.step ?? ''}\u0000${p.error !== null}`)
    .join('\u0001')
}

/** Pure : l'annonce d'avant, l'état d'après, et ce qu'il faut en dire. */
function announce(
  memory: Memory,
  projects: readonly ProjectListItem[] | undefined,
  signature: string,
): Memory {
  const steps = new Map<string, StepName>()
  for (const p of projects ?? []) {
    if (p.running !== null) steps.set(p.id, p.running.step)
  }

  const messages: string[] = []
  for (const p of projects ?? []) {
    const before = memory.steps.get(p.id)
    const now = steps.get(p.id)
    if (now !== undefined && now !== before) {
      messages.push(`${p.title} : ${LIBELLES_ETAPES[now]}.`)
    } else if (now === undefined && before !== undefined) {
      messages.push(`${p.title} : ${p.error !== null ? 'analyse en échec' : 'analyse terminée'}.`)
    }
  }

  // Rien de neuf : on garde la chaîne d'avant plutôt que d'écrire une chaîne
  // vide, qui serait une modification du DOM — donc, pour certains lecteurs
  // d'écran, une annonce de plus.
  return {
    signature,
    steps,
    message: messages.length > 0 ? messages.join(' ') : memory.message,
  }
}
