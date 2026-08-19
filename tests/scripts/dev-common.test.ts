import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chargerEnv } from '../../scripts/dev-common'
import { estReference } from '@/server/secrets'

/**
 * Le piège que ce fichier fige.
 *
 * Le `.env` est relu **après** le lancement du processus — c'est le rôle même de
 * `chargerEnv`. Si ce chargement écrasait une variable déjà posée dans
 * l'environnement, deux choses casseraient d'un coup : le
 * `FFMPEG_ENCODER=x264 pnpm tsx …` qui sert à comparer deux encodeurs sans
 * toucher au fichier, et toute conception qui injecterait un secret résolu avant
 * le lancement (`op run`, par exemple). Le second échouerait en silence, par un
 * 401 du fournisseur d'API.
 *
 * Mesuré le 18 août 2026 sur Node 22.22.1 : `process.loadEnvFile` n'écrase pas.
 * Le test le tient pour les versions suivantes.
 */

const envStart = { ...process.env }
let folder: string

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-env-'))
  // **Aucun test n'appelle `op`.** La garantie ne tient pas au hasard : on
  // retire de l'environnement hérité tout ce qui ressemblerait à une adresse de
  // secret, faute de quoi un shell qui en exporterait une ferait sortir la
  // suite de tests sur le réseau — et sur une approbation biométrique.
  for (const name of Object.keys(process.env)) {
    if (estReference(process.env[name])) delete process.env[name]
  }
})

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true })
  process.env = { ...envStart }
})

describe('chargerEnv', () => {
  it("pose les variables que l'environnement n'a pas", async () => {
    const file = path.join(folder, '.env')
    fs.writeFileSync(file, 'AVOLO_TEST_ABSENTE=du-fichier\n')
    delete process.env.AVOLO_TEST_ABSENTE

    await chargerEnv(file)
    expect(process.env.AVOLO_TEST_ABSENTE).toBe('du-fichier')
  })

  it("n'écrase pas une variable déjà posée dans l'environnement", async () => {
    const file = path.join(folder, '.env')
    fs.writeFileSync(file, 'AVOLO_TEST_POSÉE=du-fichier\n')
    process.env.AVOLO_TEST_POSÉE = 'de-la-ligne-de-commande'

    await chargerEnv(file)
    expect(process.env.AVOLO_TEST_POSÉE).toBe('de-la-ligne-de-commande')
  })

  it("tolère un fichier absent : les valeurs par défaut de paths.ts suffisent", async () => {
    await expect(chargerEnv(path.join(folder, 'jamais-écrit'))).resolves.toBeUndefined()
  })

  it("refuse un .env illisible, qui n'est pas une absence", async () => {
    // Un dossier à la place du fichier donne `EISDIR`. L'avaler ferait échouer
    // le script trois appels plus loin sur « REPLAY_DIR n'est pas définie »,
    // qui est un diagnostic faux. (relevé par Copilot)
    const inFolder = path.join(folder, 'env-dossier')
    fs.mkdirSync(inFolder)
    await expect(chargerEnv(inFolder)).rejects.toThrow()
  })
})
