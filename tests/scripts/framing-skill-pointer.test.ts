import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FRAMING_CASES } from '../../scripts/framing/cases'

/**
 * Tient la promesse de la skill `cadrage` § « Mesurer » : les cas de contrôle
 * vivent dans `scripts/framing/cases.ts`, jamais recopiés en prose. Un test
 * qui lit le `SKILL.md` versionné, pas une copie — c'est lui qui tourne en
 * CI, comme `tests/core/purete.test.ts` tient la frontière du cœur.
 *
 * **La recherche se limite à la section « Mesurer »**, pas au fichier entier.
 * Le reste de la skill mentionne légitimement certains de ces instants dans
 * d'autres discussions — `652,5 s` (virgule, pas la table) pour le seuil de
 * frontalité, `2 107 → 2 138 s` pour la campagne du percentile — et balayer le
 * fichier entier y verrait une fausse dérive plutôt que la vraie régression
 * que ce test doit tenir : qu'un timestamp revienne dans la table qu'on vient
 * de retirer.
 */

const SKILL_PATH = path.join(__dirname, '..', '..', '.claude', 'skills', 'cadrage', 'SKILL.md')

function mesurerSection(skill: string): string {
  const start = skill.indexOf('## Mesurer')
  expect(start).toBeGreaterThanOrEqual(0)
  const rest = skill.slice(start + '## Mesurer'.length)
  const nextHeading = rest.indexOf('\n## ')
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading)
}

/**
 * Les deux graphies d'un nombre à quatre chiffres : `2973` et `2 973`. Trois
 * espaces possibles entre les groupes — l'ASCII simple (celui réellement
 * utilisé dans ce fichier, vérifié à l'octet), plus l'insécable et la fine
 * en anticipation d'un futur alignement sur la convention typographique.
 */
function timestampVariants(instant: number): string[] {
  const rounded = String(Math.round(instant))
  if (rounded.length <= 3) return [rounded]
  const head = rounded.slice(0, rounded.length - 3)
  const tail = rounded.slice(rounded.length - 3)
  return [rounded, `${head} ${tail}`, `${head} ${tail}`, `${head} ${tail}`]
}

describe('la skill cadrage pointe vers le registre exécutable', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8')

  it('nomme scripts/framing/cases.ts comme la source des cas de contrôle', () => {
    expect(skill).toContain('scripts/framing/cases.ts')
  })

  it("ne recopie aucun des treize timestamps de FRAMING_CASES dans la section « Mesurer »", () => {
    const section = mesurerSection(skill)
    for (const c of FRAMING_CASES) {
      for (const variant of timestampVariants(c.anchor.instants[0])) {
        expect(section, `« ${variant} » (${c.id}) ne devrait pas être recopié dans « Mesurer »`).not.toContain(
          variant,
        )
      }
    }
  })

  // Garde-fou du test lui-même : si un jour la skill perd sa section
  // « Mesurer », `mesurerSection` rendrait tout le reste du fichier et le
  // test précédent passerait pour la mauvaise raison — vide.
  it('la section « Mesurer » existe et n’est pas vide', () => {
    expect(mesurerSection(skill).trim().length).toBeGreaterThan(0)
  })
})
