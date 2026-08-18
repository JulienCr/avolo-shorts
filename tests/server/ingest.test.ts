import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  attendreOuRenoncer,
  décisionCopie,
  empreinteSource,
  montageRépond,
  statAvecDélai,
  vérifierTailleCopiée,
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

  it('distingue un dossier d un fichier — c est ce que resolveSource ne fait pas', async () => {
    // `resolveSource` valide la forme du chemin ; ni l'existence ni le type.
    // C'est `ingest` qui refuse ce qui n'est pas un fichier ordinaire, et il le
    // décide sur ce `isFile()`. (relevé par Aristarque)
    const dossier = tmp()
    expect((await statAvecDélai(dossier, 5_000)).isFile()).toBe(false)
  })

  it('décrit le lien, pas sa cible : un lien symbolique n est pas un fichier', async () => {
    // `resolveSource` valide la forme du chemin avec `path.resolve`, qui ne suit
    // pas les liens. Un lien posé dans REPLAY_DIR et pointant ailleurs passerait
    // donc son contrôle de dossier parent ; c'est le `lstat` qui ferme la porte,
    // et c'est pour cela que ce n'est pas un `stat`. (relevé par Aristarque)
    const dossier = tmp()
    const cible = path.join(dossier, 'ailleurs.mp4')
    fs.writeFileSync(cible, 'une vraie vidéo, mais pas à sa place')
    const lien = path.join(dossier, 'replay.mp4')
    fs.symlinkSync(cible, lien)

    const stat = await statAvecDélai(lien, 5_000)
    expect(stat.isSymbolicLink()).toBe(true)
    expect(stat.isFile()).toBe(false)
  })

  it('remonte l absence sans attendre le délai', async () => {
    const dossier = tmp()
    await expect(statAvecDélai(path.join(dossier, 'absent.mp4'), 5_000)).rejects.toThrow(/ENOENT/)
  })

})

describe('vérifierTailleCopiée', () => {
  it('laisse passer une copie de la taille annoncée', () => {
    expect(() => vérifierTailleCopiée(4_577_070_123, 4_577_070_123, '/s.mp4')).not.toThrow()
  })

  it('refuse une copie plus courte que la source', () => {
    // Une fin de fichier propre n'est pas une preuve de complétude : si la
    // source rétrécit pendant la copie, `pipeline` s'achève sans erreur et le
    // renommage rendrait le fichier tronqué définitif. (relevé par Copilot)
    expect(() => vérifierTailleCopiée(1_000, 4_577_070_123, '/s.mp4')).toThrow(/au lieu de/)
  })

  it('refuse aussi une copie plus longue : la source a bougé dans les deux cas', () => {
    expect(() => vérifierTailleCopiée(5_000, 4_000, '/s.mp4')).toThrow(/a changé de taille/)
  })
})

describe('montageRépond', () => {
  const racines: string[] = []
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-montage-'))
    racines.push(d)
    return d
  }

  afterEach(() => {
    for (const d of racines.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('répond vrai sur un dossier vivant', async () => {
    await expect(montageRépond(tmp(), 5_000)).resolves.toBe(true)
  })

  it("répond vrai sur un chemin absent : une erreur **est** une réponse", async () => {
    // C'est toute la distinction que `/proc/mounts` ne fait pas. Un montage
    // absent rend `ENOENT` en une microseconde et la suite se déroule
    // normalement — c'est le montage au transport mort, qui ne rend rien du
    // tout, qu'il faut attraper.
    await expect(montageRépond(path.join(tmp(), 'absent'), 5_000)).resolves.toBe(true)
  })

  it('répond faux quand rien ne vient dans le temps imparti', async () => {
    // Minuterie factice, et avancée **avant** de rendre la main à la boucle : le
    // `stat` n'a alors pas encore pu revenir, donc la garde gagne à coup sûr.
    // Un simple délai de zéro sur un fichier local serait une course, et les
    // courses en test se perdent un jour sur dix.
    vi.useFakeTimers()
    try {
      const promesse = montageRépond(tmp(), 5_000)
      vi.advanceTimersByTime(5_000)
      await expect(promesse).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
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
