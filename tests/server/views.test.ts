import { describe, expect, it } from 'vitest'

import type { Project } from '@/server/db'
import { summaryProject } from '@/server/views'

/**
 * Le titre affiché vient du **nom de fichier**, pas de l'identifiant.
 *
 * Les deux étaient la même chaîne tant que l'identifiant recopiait le nom ;
 * depuis qu'il en déplie les accents, ils divergent — et c'est le fichier qui
 * fait foi, parce que c'est lui que quelqu'un a nommé. Sans ça, la carte de la
 * bibliothèque (qui dérive du nom, `buildLibrary`) et l'écran de projet (qui
 * dérive d'ici) afficheraient deux titres pour la même émission.
 */
function project(id: string, sourcePath: string): Project {
  return {
    id,
    sourcePath,
    stagedPath: null,
    durationSec: null,
    sizeBytes: null,
    mtimeMs: null,
    createdAt: Date.UTC(2026, 0, 11),
  }
}

describe('summaryProject', () => {
  it('garde l’accent du nom de fichier dans le titre', () => {
    const summary = summaryProject(
      project('2026-01-11-mechante', '/mnt/j/Replay/2026-01-11-méchante.mp4'),
    )
    expect(summary.id).toBe('2026-01-11-mechante')
    expect(summary.title).toBe('méchante — 11 janvier 2026')
  })

  it('donne le même titre qu’avant sur un nom sans accent', () => {
    const summary = summaryProject(
      project('2026-03-08-caro-mdlm', '/mnt/j/Replay/2026-03-08-caro-mdlm.mp4'),
    )
    expect(summary.title).toBe('caro mdlm — 8 mars 2026')
  })

  it('n’expose ni le chemin de la source ni celui de la copie de travail', () => {
    const summary = summaryProject(project('x', '/mnt/j/Replay/x.mp4'))
    expect(Object.keys(summary).sort()).toEqual(['createdAt', 'durationSec', 'id', 'title'])
  })
})
