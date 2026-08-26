/**
 * Le format d'entrée d'une planche de comparaison — issue #191, lot 2.
 *
 * Une planche décrit des **variantes de cadrage**, jamais des instants : une
 * variante est une décision (réglages ou options) et un canevas de sortie,
 * rien de temporel. C'est `card.ts` qui attache l'instant, un par carte,
 * partagé par toutes les images de cette carte — voir son en-tête pour la
 * raison.
 */

import type { FramingOptions, FramingSettings } from '@/core/framing'

/**
 * Une colonne de la planche : soit les six réglages persistés (`FramingSettings`,
 * ce que la production peut réellement appliquer), soit des `FramingOptions`
 * arbitraires accompagnées de `why` — parce qu'un déplacement de `margin`,
 * `sideTrim` ou `torso` ne passe pas par la conversion de production, et la
 * planche doit le dire d'elle-même plutôt que de laisser croire à un réglage
 * livrable.
 */
export type FramingVariant =
  | {
      id: string
      label: string
      kind: 'settings'
      settings: Partial<FramingSettings>
      output?: 'vertical' | 'native'
    }
  | {
      id: string
      label: string
      kind: 'options'
      options: Partial<FramingOptions>
      why: string
      output?: 'vertical' | 'native'
    }

export type BoardCase = {
  id: string
  projectId: string
  /** Désigne le plan ; ce n'est PAS l'instant rendu — voir `share.ts`. */
  at: number
  clipId: string | null
  /** Français : ce que le cas éprouve, affiché sur la carte. */
  stake: string
  known?: { call: 'keep' | 'drop' | 'unsure'; on: string; by: string; note?: string }
}

export type BoardSection = {
  title: string
  lede?: string
  /** Prose libre ou tableau, injecté verbatim par l'appelant. */
  html?: string
  cases?: readonly BoardCase[]
}

export type BoardSpec = {
  /** Le suffixe de la clé `localStorage`. */
  id: string
  title: string
  eyebrow: string
  lede: string
  callout?: { title: string; body: string }
  variants: readonly [FramingVariant, ...FramingVariant[]]
  sections: readonly BoardSection[]
  classifier: string
  settled: readonly (readonly [string, string])[]
}

function fail(where: string, why: string): never {
  throw new Error(`validateSpec : ${where} — ${why}`)
}

/**
 * Vérifie la forme d'une `BoardSpec` ; ne répare jamais, seulement lève.
 */
export function validateSpec(spec: BoardSpec): void {
  if (!spec.id) fail('id', 'vide')
  if (!spec.title) fail('title', 'vide')
  if (!spec.eyebrow) fail('eyebrow', 'vide')
  if (!spec.lede) fail('lede', 'vide')
  if (!spec.classifier) fail('classifier', 'vide')

  if (spec.variants.length === 0) fail('variants', 'aucune variante')
  const variantIds = new Set<string>()
  for (const v of spec.variants) {
    if (!v.id) fail('variants[].id', 'vide')
    if (variantIds.has(v.id)) fail('variants[].id', `doublon "${v.id}"`)
    variantIds.add(v.id)
    if (!v.label) fail(`variants["${v.id}"].label`, 'vide')
    if (v.kind === 'options' && !v.why) {
      fail(`variants["${v.id}"].why`, 'requis quand kind vaut "options"')
    }
  }

  if (spec.sections.length === 0) fail('sections', 'aucune section')
  const caseIds = new Set<string>()
  for (const section of spec.sections) {
    if (!section.title) fail('sections[].title', 'vide')
    for (const c of section.cases ?? []) {
      if (!c.id) fail('sections[].cases[].id', 'vide')
      if (caseIds.has(c.id)) fail('sections[].cases[].id', `doublon "${c.id}"`)
      caseIds.add(c.id)
      if (!c.projectId) fail(`cases["${c.id}"].projectId`, 'vide')
      if (!Number.isFinite(c.at)) fail(`cases["${c.id}"].at`, 'non fini')
      if (!c.stake) fail(`cases["${c.id}"].stake`, 'vide')
    }
  }

  for (const [label, text] of spec.settled) {
    if (!label || !text) fail('settled[]', 'un couple [label, texte] est vide')
  }
}
