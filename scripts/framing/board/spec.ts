/**
 * Le format d'entrée d'une planche de comparaison — issue #191, lot 2.
 *
 * Une planche décrit des **variantes de cadrage**, jamais des instants : une
 * variante est une décision (réglages ou options) et un canevas de sortie,
 * rien de temporel. C'est `card.ts` qui attache l'instant, un par carte,
 * partagé par toutes les images de cette carte — voir son en-tête pour la
 * raison.
 */

import { RATIOS, type FramingOptions, type FramingSettings } from '@/core/framing'
import type { Ratio } from '@/core/edl'

/**
 * Une colonne de la planche : soit les six réglages persistés (`FramingSettings`),
 * soit des `FramingOptions` arbitraires accompagnées de `why` — l'échappatoire
 * pour ce que la conversion de production ne couvre pas.
 *
 * `kind: 'options'` porte aussi `ratio`/`cropMode`/`cropX`, les trois champs de
 * `FramingRequest` hors `FramingOptions` (replis d'un split rejeté, #190).
 * `cropX` est un nombre, ou une table par `BoardCase.id` quand la bonne
 * position varie selon le cas — jamais par `shotStartMs`, que `resolveVariant`
 * résout seul. Voir `scripts/framing/crop-x.ts` pour dériver ces valeurs.
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
      /** Ratio épinglé pour toute la variante ; absent laisse `computeFraming` choisir (`'auto'`). */
      ratio?: Ratio
      /** `'manual'` exige `cropX` ; absent vaut `'auto'`. */
      cropMode?: 'auto' | 'manual'
      /**
       * Fraction de largeur dans `[0, 1]`. Un nombre s'applique à tous les cas de
       * la planche ; une table par `BoardCase.id` couvre le cas où la bonne
       * position varie d'un cas à l'autre.
       */
      cropX?: number | Readonly<Record<string, number>>
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

  if (spec.variants.length === 0) fail('variants', 'aucune variante')
  const variantIds = new Set<string>()
  for (const v of spec.variants) {
    if (!v.id) fail('variants[].id', 'vide')
    if (variantIds.has(v.id)) fail('variants[].id', `doublon "${v.id}"`)
    variantIds.add(v.id)
    if (!v.label) fail(`variants["${v.id}"].label`, 'vide')
    if (v.kind === 'options') {
      if (!v.why) fail(`variants["${v.id}"].why`, 'requis quand kind vaut "options"')
      if (v.ratio !== undefined && !(v.ratio in RATIOS)) {
        fail(`variants["${v.id}"].ratio`, `inconnu "${v.ratio}"`)
      }
      if (v.cropMode === 'manual' && v.cropX === undefined) {
        fail(`variants["${v.id}"].cropX`, 'requis quand cropMode vaut "manual"')
      }
      if (typeof v.cropX === 'number') {
        if (!Number.isFinite(v.cropX) || v.cropX < 0 || v.cropX > 1) {
          fail(`variants["${v.id}"].cropX`, `hors de [0, 1] : ${v.cropX}`)
        }
      } else if (v.cropX !== undefined) {
        for (const [caseId, x] of Object.entries(v.cropX)) {
          if (!Number.isFinite(x) || x < 0 || x > 1) {
            fail(`variants["${v.id}"].cropX["${caseId}"]`, `hors de [0, 1] : ${x}`)
          }
        }
        // Une table de crop n'a de sens qu'exhaustive : un cas de la planche
        // sans entrée basculerait en silence sur un crop `undefined`, donc en
        // mode automatique malgré `cropMode: 'manual'`.
        if (v.cropMode === 'manual') {
          for (const caseId of caseIds) {
            if (!(caseId in v.cropX)) {
              fail(`variants["${v.id}"].cropX`, `aucune entrée pour le cas "${caseId}"`)
            }
          }
        }
      }
    }
  }

  for (const [label, text] of spec.settled) {
    if (!label || !text) fail('settled[]', 'un couple [label, texte] est vide')
  }
}
