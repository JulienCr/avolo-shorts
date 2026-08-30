import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { snapshotEnv } from './env'

describe('snapshotEnv', () => {
  let folder: string

  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-env-helper-'))
  })

  afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true })
  })

  it('supprime une variable ajoutée après le cliché et restaure une variable modifiée', () => {
    process.env.AVOLO_TEST_HELPER_PREEXISTING = 'avant'
    const restore = snapshotEnv()

    process.env.AVOLO_TEST_HELPER_PREEXISTING = 'modifie'
    process.env.AVOLO_TEST_HELPER_NOUVELLE = 'ajoutee'

    restore()

    expect(process.env.AVOLO_TEST_HELPER_PREEXISTING).toBe('avant')
    expect(process.env.AVOLO_TEST_HELPER_NOUVELLE).toBeUndefined()

    delete process.env.AVOLO_TEST_HELPER_PREEXISTING
  })

  /**
   * Le test que la contrainte du contrat exige : il échoue si `restore` revient
   * à `process.env = { ...start }`, puisqu'une telle réassignation casse
   * silencieusement `process.loadEnvFile` pour le reste du process.
   */
  it("laisse process.loadEnvFile fonctionner apres restauration", () => {
    const restore = snapshotEnv()
    process.env.AVOLO_TEST_HELPER_DRIFT = 'perturbation'
    restore()

    const file = path.join(folder, '.env')
    delete process.env.AVOLO_TEST_HELPER_LOADFILE
    fs.writeFileSync(file, 'AVOLO_TEST_HELPER_LOADFILE=du-fichier\n')

    process.loadEnvFile(file)

    expect(process.env.AVOLO_TEST_HELPER_LOADFILE).toBe('du-fichier')
    delete process.env.AVOLO_TEST_HELPER_LOADFILE
  })
})
