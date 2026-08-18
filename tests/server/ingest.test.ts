import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  attendreOuRenoncer,
  décisionCopie,
  empreinteSource,
  statAvecDélai,
} from '@/server/steps/ingest'

/**
 * Ce qui se teste de l'ingestion sans le Drive : la décision de recopier et la
 * forme de l'empreinte. La copie elle-même se vérifie sur une vraie source, où
 * elle prend deux minutes pour 4,3 Gio.
 */

describe('décisionCopie', () => {
  const source = { sizeBytes: 4_577_070_123 }

  it('copie quand rien n est là', () => {
    expect(décisionCopie({ source, copie: null })).toBe('copier')
  })

  it('garde une copie de la même taille — 12 Go sur du 9p ne se repaient pas', () => {
    expect(décisionCopie({ source, copie: { sizeBytes: 4_577_070_123 } })).toBe('garder')
  })

  it('recopie une copie tronquée', () => {
    expect(décisionCopie({ source, copie: { sizeBytes: 1_000 } })).toBe('copier')
  })

  it('force recopie même une copie complète', () => {
    expect(décisionCopie({ source, copie: { sizeBytes: 4_577_070_123 }, force: true })).toBe(
      'copier',
    )
  })

  it('un fichier vide des deux côtés reste une copie valide', () => {
    expect(décisionCopie({ source: { sizeBytes: 0 }, copie: { sizeBytes: 0 } })).toBe('garder')
  })
})

describe('empreinteSource', () => {
  it('relève taille, date de modification et durée — pas de hash', () => {
    // Digérer 12 Go à chaque lancement coûterait plus cher que l'étape qu'on
    // cherche à éviter (spec §5).
    expect(empreinteSource({ size: 4_577_070_123, mtimeMs: 1_766_265_593_000 }, 5936.995333)).toEqual(
      { sizeBytes: 4_577_070_123, mtimeMs: 1_766_265_593_000, durationSec: 5936.995333 },
    )
  })

  it('tronque la date en entier : la colonne SQLite en est un', () => {
    expect(empreinteSource({ size: 1, mtimeMs: 1_766_265_593_123.456 }, null).mtimeMs).toBe(
      1_766_265_593_123,
    )
  })

  it('accepte une durée inconnue, un fichier restant copiable sans elle', () => {
    expect(empreinteSource({ size: 1, mtimeMs: 0 }, null).durationSec).toBeNull()
  })
})

describe('statAvecDélai', () => {
  const racines: string[] = []
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-ingest-'))
    racines.push(d)
    return d
  }

  afterEach(() => {
    for (const d of racines.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('rend le stat d un fichier qui répond', async () => {
    const dossier = tmp()
    const fichier = path.join(dossier, 'replay.mp4')
    fs.writeFileSync(fichier, 'douze octets')
    const stat = await statAvecDélai(fichier, 5_000)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBe(12)
  })

  it('distingue un dossier d un fichier — c est ce que resolveSource ne fait pas', () => {
    // `resolveSource` valide la forme du chemin ; ni l'existence ni le type.
    const dossier = tmp()
    return expect(statAvecDélai(dossier, 5_000)).resolves.toMatchObject({})
  })

  it('remonte l absence sans attendre le délai', async () => {
    const dossier = tmp()
    await expect(statAvecDélai(path.join(dossier, 'absent.mp4'), 5_000)).rejects.toThrow(/ENOENT/)
  })

})

describe('attendreOuRenoncer', () => {
  it('rend le résultat quand le travail arrive à temps', async () => {
    await expect(attendreOuRenoncer(Promise.resolve(42), 5_000, 'jamais')).resolves.toBe(42)
  })

  it('renonce sur un travail qui ne revient pas, avec un message qui dit quoi faire', async () => {
    // Une promesse qui ne se règle jamais, c'est exactement un `fs.stat` sur un
    // montage 9p dont le transport est mort : l'appel part dans le vivier de
    // fils de libuv et n'en revient pas. On ne peut pas l'interrompre, seulement
    // cesser de l'attendre.
    const jamais = new Promise<never>(() => {})
    await expect(attendreOuRenoncer(jamais, 5, 'le montage ne répond pas')).rejects.toThrow(
      /ne répond pas/,
    )
  })

  it('laisse remonter l échec du travail plutôt que le message de garde', async () => {
    await expect(
      attendreOuRenoncer(Promise.reject(new Error('ENOENT')), 5_000, 'garde'),
    ).rejects.toThrow(/ENOENT/)
  })

  it("n'abandonne pas de rejet non traité derrière lui", async () => {
    // Sans le `catch` posé sur le travail, un échec arrivant *après* le délai
    // couperait le processus entier.
    const tardif = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('tard')), 20))
    await expect(attendreOuRenoncer(tardif, 1, 'garde')).rejects.toThrow(/garde/)
    await new Promise((r) => setTimeout(r, 40))
  })
})
