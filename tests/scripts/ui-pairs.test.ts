import { describe, expect, it } from 'vitest'

import { decidePortGuard, resolveHostUrl } from '../../scripts/ui/guard'
import { CLIP_SCREEN_PAIRS, SCREEN_PAIRS, verticalOverlap } from '../../scripts/ui/pairs'

describe('verticalOverlap', () => {
  it('rend la hauteur commune de deux rectangles qui se chevauchent', () => {
    expect(verticalOverlap({ top: 0, bottom: 100 }, { top: 50, bottom: 150 })).toBe(50)
  })

  it('rend 0, jamais un négatif, quand les rectangles se touchent seulement au bord', () => {
    expect(verticalOverlap({ top: 0, bottom: 100 }, { top: 100, bottom: 200 })).toBe(0)
  })

  it('rend 0 quand les rectangles sont disjoints', () => {
    expect(verticalOverlap({ top: 0, bottom: 100 }, { top: 200, bottom: 300 })).toBe(0)
  })

  it('rend la hauteur entière du plus petit rectangle quand il est inclus dans l’autre', () => {
    expect(verticalOverlap({ top: 0, bottom: 100 }, { top: 20, bottom: 40 })).toBe(20)
  })
})

describe('SCREEN_PAIRS', () => {
  it('porte les paires de l’écran de clip, chacune nommée et à deux sélecteurs', () => {
    expect(SCREEN_PAIRS.clip).toBe(CLIP_SCREEN_PAIRS)
    expect(CLIP_SCREEN_PAIRS.length).toBeGreaterThan(0)
    for (const pair of CLIP_SCREEN_PAIRS) {
      expect(pair.name.length).toBeGreaterThan(0)
      expect(pair.a.length).toBeGreaterThan(0)
      expect(pair.b.length).toBeGreaterThan(0)
    }
  })
})

describe('SCREEN_PAIRS — les écrans sans garde', () => {
  it('accepte `library` et `project` comme noms d’écran, sans paire à vérifier', () => {
    // `pnpm ui-shot --screen library` fails on an unknown name, so dropping a
    // key would break the command with no test to catch it.
    expect(Object.keys(SCREEN_PAIRS).sort()).toEqual(['clip', 'library', 'project'])
    expect(SCREEN_PAIRS.library).toEqual([])
    expect(SCREEN_PAIRS.project).toEqual([])
  })
})

describe('decidePortGuard', () => {
  it('accepte quand le cwd du process écoutant est la racine du dépôt', () => {
    const decision = decidePortGuard({ procCwd: '/home/julien/dev/avolo-shorts', repoRoot: '/home/julien/dev/avolo-shorts', force: false })
    expect(decision.ok).toBe(true)
  })

  it('refuse et nomme le dossier fautif quand le cwd diffère', () => {
    const decision = decidePortGuard({
      procCwd: '/home/julien/dev/avolo-shorts/.claude/worktrees/other',
      repoRoot: '/home/julien/dev/avolo-shorts/.claude/worktrees/ui-shot',
      force: false,
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.message).toContain('/home/julien/dev/avolo-shorts/.claude/worktrees/other')
    }
  })

  it('accepte malgré le désaccord quand --force est passé', () => {
    const decision = decidePortGuard({ procCwd: '/elsewhere', repoRoot: '/here', force: true })
    expect(decision.ok).toBe(true)
  })
})

describe('resolveHostUrl', () => {
  it('réécrit 127.0.0.1 en localhost', () => {
    const { url, rewritten } = resolveHostUrl('http://127.0.0.1:4041/clips/x')
    expect(url).toBe('http://localhost:4041/clips/x')
    expect(rewritten).toBe(true)
  })

  it('laisse localhost inchangé', () => {
    const { url, rewritten } = resolveHostUrl('http://localhost:4041/clips/x')
    expect(url).toBe('http://localhost:4041/clips/x')
    expect(rewritten).toBe(false)
  })

  it('laisse un autre hôte inchangé', () => {
    const { url, rewritten } = resolveHostUrl('http://example.com/clips/x')
    expect(url).toBe('http://example.com/clips/x')
    expect(rewritten).toBe(false)
  })
})
