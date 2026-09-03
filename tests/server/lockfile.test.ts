import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acquireSlot, lockSince, releaseSlot, sweepDeadSlots, type SlotOptions } from '@/server/lockfile'

/**
 * Verifie la generalisation N-emplacements de la primitive de verrou de
 * fichier (extraite de l'ordonnanceur de publication) : acquisition
 * multi-emplacements, reprise sur pid mort, et le nommage sans index a
 * `slots: 1` dont depend `publish-scheduled`.
 */

let lockDir: string

function deps(overrides: Partial<SlotOptions> = {}): SlotOptions {
  return { lockDir, name: 'test-lock', slots: 2, staleMs: 30 * 60 * 1000, ...overrides }
}

beforeEach(() => {
  lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-lockfile-'))
})

afterEach(() => {
  fs.rmSync(lockDir, { recursive: true, force: true })
})

describe('acquireSlot / releaseSlot', () => {
  it('attribue les emplacements 0 puis 1, puis refuse le troisieme', () => {
    const o = deps()
    const first = acquireSlot(o, Date.now(), () => true)
    const second = acquireSlot(o, Date.now(), () => true)
    const third = acquireSlot(o, Date.now(), () => true)

    expect(first).toMatchObject({ slot: 0 })
    expect(second).toMatchObject({ slot: 1 })
    expect(third).toBeNull()
  })

  it('relacher un emplacement le rend a nouveau disponible', () => {
    const o = deps()
    const first = acquireSlot(o, Date.now(), () => true)
    expect(first).not.toBeNull()
    releaseSlot(o, first!)

    const again = acquireSlot(o, Date.now(), () => true)
    expect(again).toMatchObject({ slot: 0 })
  })

  it('un emplacement perime dont le pid est vivant n’est jamais repris', () => {
    const o = deps({ slots: 1 })
    const file = path.join(lockDir, '.test-lock.lock')
    fs.writeFileSync(file, JSON.stringify({ pid: 424242, since: Date.now() - 31 * 60 * 1000, owner: 'ancien' }))

    const handle = acquireSlot(o, Date.now(), () => true)

    expect(handle).toBeNull()
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ owner: 'ancien' })
  })

  it('un emplacement perime dont le pid est mort est repris apres staleMs', () => {
    const o = deps({ slots: 1 })
    const file = path.join(lockDir, '.test-lock.lock')
    fs.writeFileSync(file, JSON.stringify({ pid: 424242, since: Date.now() - 31 * 60 * 1000, owner: 'ancien' }))

    const handle = acquireSlot(o, Date.now(), () => false)

    expect(handle).toMatchObject({ slot: 0 })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ owner: handle!.owner })
  })

  it('releaseSlot ne supprime rien si le titulaire sur disque a change', () => {
    const o = deps({ slots: 1 })
    const file = path.join(lockDir, '.test-lock.lock')
    const handle = acquireSlot(o, Date.now(), () => true)
    expect(handle).not.toBeNull()
    // Un autre titulaire a repose un verrou frais entretemps : le nôtre ne
    // doit pas l'effacer (relu en revue sur `releaseLock`, meme propriete).
    fs.writeFileSync(file, JSON.stringify({ pid: 1, since: Date.now(), owner: 'quelqu-un-d-autre' }))

    releaseSlot(o, handle!)

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ owner: 'quelqu-un-d-autre' })
  })
})

describe('validation de slots', () => {
  it('rejette un nombre de slots nul, fractionnaire ou infini', () => {
    expect(() => acquireSlot(deps({ slots: 0 }), Date.now(), () => true)).toThrow(RangeError)
    expect(() => acquireSlot(deps({ slots: 1.5 }), Date.now(), () => true)).toThrow(RangeError)
    expect(() => acquireSlot(deps({ slots: Infinity }), Date.now(), () => true)).toThrow(RangeError)
    expect(() => sweepDeadSlots(deps({ slots: 0 }), () => true)).toThrow(RangeError)
  })

  it('rejette un name qui traverse les repertoires', () => {
    expect(() => acquireSlot(deps({ name: '../../../outside' }), Date.now(), () => true)).toThrow(RangeError)
    expect(() => acquireSlot(deps({ name: '' }), Date.now(), () => true)).toThrow(RangeError)
  })
})

describe('sweepDeadSlots', () => {
  it('libere les emplacements a pid mort et laisse les vivants intacts', () => {
    const o = deps({ slots: 2 })
    fs.writeFileSync(path.join(lockDir, '.test-lock.0.lock'), JSON.stringify({ pid: 1, since: Date.now(), owner: 'vivant' }))
    fs.writeFileSync(path.join(lockDir, '.test-lock.1.lock'), JSON.stringify({ pid: 2, since: Date.now(), owner: 'mort' }))

    const freed = sweepDeadSlots(o, (pid) => pid === 1)

    expect(freed).toBe(1)
    expect(fs.existsSync(path.join(lockDir, '.test-lock.0.lock'))).toBe(true)
    expect(fs.existsSync(path.join(lockDir, '.test-lock.1.lock'))).toBe(false)
  })
})

describe('lockSince', () => {
  it('renvoie le since du titulaire quand la charge utile est complete', () => {
    const o = deps({ slots: 1 })
    const since = Date.now() - 1000
    fs.writeFileSync(path.join(lockDir, '.test-lock.lock'), JSON.stringify({ pid: 1, since, owner: 'x' }))

    expect(lockSince(o, 0, Date.now())).toBe(since)
  })

  it('retombe sur le mtime du fichier quand la charge utile est incomplete', () => {
    const o = deps({ slots: 1 })
    const file = path.join(lockDir, '.test-lock.lock')
    fs.writeFileSync(file, '')
    const old = new Date(Date.now() - 60 * 1000)
    fs.utimesSync(file, old, old)

    expect(lockSince(o, 0, Date.now())).toBe(fs.statSync(file).mtimeMs)
  })

  it('renvoie now quand le fichier n’existe pas', () => {
    const o = deps({ slots: 1 })
    const now = Date.now()

    expect(lockSince(o, 0, now)).toBe(now)
  })
})

describe('nommage des fichiers', () => {
  it('slots: 1 produit .<name>.lock sans index', () => {
    const o = deps({ slots: 1, name: 'publish-scheduled' })
    const handle = acquireSlot(o, Date.now(), () => true)

    expect(handle).toMatchObject({ slot: 0 })
    expect(fs.existsSync(path.join(lockDir, '.publish-scheduled.lock'))).toBe(true)
    expect(fs.existsSync(path.join(lockDir, '.publish-scheduled.0.lock'))).toBe(false)
  })
})
