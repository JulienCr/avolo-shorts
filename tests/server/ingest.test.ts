import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  attendreOuRenoncer,
  décisionCopie,
  empreinteSource,
  ingest,
  montageRépond,
  cleanStage,
  statAvecDélai,
  STAGE_TTL_MS,
  vérifierTailleCopiée,
} from '@/server/steps/ingest'
import { StopRequestedError } from '@/server/ffmpeg'

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

/**
 * Le cache de travail : `stage/` et ses bornes.
 *
 * **Il n'est jamais une source de vérité et peut être supprimé sans conséquence
 * fonctionnelle** (retour d'usage §5). Ce que ces tests éprouvent est donc
 * l'inverse de ce qu'on éprouve d'un artefact : non pas qu'une copie survit,
 * mais qu'elle disparaît when il le faut, et qu'elle ne disparaît pas sous les
 * pieds de qui la lit.
 */
describe('cleanStage', () => {
  let root: string
  const previousStage = process.env.STAGE_DIR

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-stage-'))
    process.env.STAGE_DIR = path.join(root, 'stage')
    fs.mkdirSync(process.env.STAGE_DIR, { recursive: true })
  })

  afterEach(() => {
    if (previousStage === undefined) delete process.env.STAGE_DIR
    else process.env.STAGE_DIR = previousStage
    fs.rmSync(root, { recursive: true, force: true })
  })

  /** Une copie de travail, avec l'âge qu'on veut lui donner. */
  function place(nom: string, ageMs: number): string {
    const filePath = path.join(process.env.STAGE_DIR as string, nom)
    fs.writeFileSync(filePath, 'une copie')
    const when = new Date(Date.now() - ageMs)
    fs.utimesSync(filePath, when, when)
    return filePath
  }

  it('retire ce qui a dépassé les huit heures', async () => {
    const stale = place('stale.mp4', STAGE_TTL_MS + 60_000)
    expect(await cleanStage()).toEqual(['stale.mp4'])
    expect(fs.existsSync(stale)).toBe(false)
  })

  it('garde ce qui est encore frais', async () => {
    const fresh = place('fraiche.mp4', STAGE_TTL_MS - 60_000)
    expect(await cleanStage()).toEqual([])
    expect(fs.existsSync(fresh)).toBe(true)
  })

  /**
   * **Ce qu'une exécution est en train de lire est épargné.** Effacer sous un
   * ffmpeg ne le casse pas — le descripteur ouvert survit à l'`unlink` sous
   * Linux — mais l'étape suivante repaierait la copie, et sur une source de
   * 12 Go cela veut dire cinq minutes de Drive.
   */
  it('épargne les copies qu’une exécution utilise', async () => {
    const inUse = place('en-usage.mp4', STAGE_TTL_MS * 2)
    place('autre.mp4', STAGE_TTL_MS * 2)
    expect(await cleanStage({ keep: () => [inUse] })).toEqual(['autre.mp4'])
    expect(fs.existsSync(inUse)).toBe(true)
  })

  /**
   * **La liste est relue à chaque fichier, pas prise en instantané au départ.**
   * Une exécution démarrée pendant le balayage ne recopie rien — sa copie est
   * là, `ingestionNécessaire` l'a constaté — donc rien d'autre ne la
   * signalerait, et le balayage l'effaçait sous ses pieds. (relevé par Codex)
   */
  it('voit une exécution démarrée pendant le balayage', async () => {
    const lateOne = place('lateOne.mp4', STAGE_TTL_MS * 2)
    place('a.mp4', STAGE_TTL_MS * 2)
    place('b.mp4', STAGE_TTL_MS * 2)

    // Rien à épargner au départ ; `lateOne` entre en usage au premier fichier vu.
    let inUse: string[] = []
    let seen = 0
    const removed = await cleanStage({
      keep: () => {
        seen += 1
        if (seen === 1) inUse = [lateOne]
        return inUse
      },
    })

    expect(removed).not.toContain('lateOne.mp4')
    expect(fs.existsSync(lateOne)).toBe(true)
  })

  /** On n'a pas pu savoir : on épargne, plutôt que d'effacer à l'aveugle. */
  it('n’efface rien when la liste des copies en usage est indisponible', async () => {
    place('a.mp4', STAGE_TTL_MS * 2)
    expect(await cleanStage({ keep: () => null })).toEqual([])
  })

  it('ne touche ni aux sous-dossiers ni aux liens', async () => {
    const stage = process.env.STAGE_DIR as string
    const target = place('target.mp4', 0)
    fs.mkdirSync(path.join(stage, 'un-dossier'))
    fs.symlinkSync(target, path.join(stage, 'un-lien.mp4'))
    // Le lien est old au sens de `lstat` — il vient d'être créé, donc frais —
    // mais même vieilli, ce n'est pas un fichier ordinaire.
    const old = new Date(Date.now() - STAGE_TTL_MS * 2)
    fs.lutimesSync(path.join(stage, 'un-lien.mp4'), old, old)
    fs.utimesSync(path.join(stage, 'un-dossier'), old, old)

    expect(await cleanStage()).toEqual([])
    expect(fs.existsSync(target)).toBe(true)
    expect(fs.existsSync(path.join(stage, 'un-dossier'))).toBe(true)
  })

  /**
   * **Best effort veut dire : ne jamais échouer.** Le nettoyage tourne au
   * démarrage du serveur (`src/instrumentation.ts`), où lever ferait échouer
   * `register()` — Next préfixe alors le message de « An error occurred while
   * loading instrumentation hook » et le serveur ne sert plus rien, pour un
   * dossier de cache absent.
   */
  it('ne lève pas when le dossier n’existe pas', async () => {
    process.env.STAGE_DIR = path.join(root, 'jamais-créé')
    await expect(cleanStage()).resolves.toEqual([])
  })

  it('accepte un TTL et une horloge, pour se tester sans attendre huit heures', async () => {
    place('a.mp4', 0)
    expect(await cleanStage({ ttlMs: 0, now: Date.now() + 1_000 })).toEqual(['a.mp4'])
  })
})

/**
 * L'ingestion elle-même, sur une source minuscule et sans Drive.
 *
 * `probeDuration` ne lève jamais — un ffprobe absent rend un sondage vide —,
 * donc ces tests tournent sans binaire.
 */
describe('ingest', () => {
  let root: string
  const before = { replay: process.env.REPLAY_DIR, stage: process.env.STAGE_DIR }

  /** Assez gros pour que la copie dure plus qu'un `stat`. */
  const BYTES = 16 * 1024 * 1024
  const NAME = '2025-06-15-cqlp.mp4'

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-ingest-'))
    process.env.REPLAY_DIR = path.join(root, 'replays')
    process.env.STAGE_DIR = path.join(root, 'stage')
    fs.mkdirSync(process.env.REPLAY_DIR, { recursive: true })
    fs.writeFileSync(path.join(process.env.REPLAY_DIR, NAME), Buffer.alloc(BYTES, 7))
  })

  afterEach(() => {
    for (const [key, value] of [
      ['REPLAY_DIR', before.replay],
      ['STAGE_DIR', before.stage],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('copie en gardant le nom du fichier d’origine', async () => {
    const ingestion = await ingest(NAME, { db: null })
    expect(path.basename(ingestion.stagedPath)).toBe(NAME)
    expect(fs.statSync(ingestion.stagedPath).size).toBe(BYTES)
    expect(ingestion.copied).toBe(true)
  })

  /**
   * **Deux traitements ne copient pas la même source deux fois.** Le cas n'est
   * pas théorique : `enCours` interdit deux exécutions du même projet, mais rien
   * n'interdit à `dev-ingest` de tourner à côté du serveur. Sans verrou, les
   * deux `pipeline` se disputent la bande passante d'un montage à 97 Mo/s et le
   * second renommage écrase le premier fichier pendant qu'une étape le lit.
   *
   * L'assertion porte sur l'invariant — *au plus une* copie — et non sur le
   * filePath emprunté : si la première finit before que la second ne décide, c'est
   * le contrôle de taille qui l'arrête, et c'est aussi bien. Sans verrou et avec
   * recouvrement, en revanche, les deux copient et le test tombe.
   */
  it('ne copie pas deux fois la même source en parallèle', async () => {
    let copyCount = 0
    const track = () => {
      copyCount += 1
    }
    const [a, b] = await Promise.all([
      ingest(NAME, { db: null, onProgress: track }),
      ingest(NAME, { db: null, onProgress: track }),
    ])
    // Une seule des deux a écrit ; l'autre a attendu ou constaté la copie.
    expect([a.copied, b.copied].filter(Boolean).length).toBeLessThanOrEqual(1)
    expect(fs.statSync(a.stagedPath).size).toBe(BYTES)
    // Et rien de partiel ne traîne : `stage/` porte des fichiers de plusieurs
    // gigaoctets, un moignon n'y serait ramassé par personne.
    expect(fs.readdirSync(path.dirname(a.stagedPath))).toEqual([NAME])
    expect(copyCount).toBeGreaterThan(0)
  })

  /**
   * **La seule chose du dépôt qui s'annule vraiment.** Ailleurs on cesse
   * d'attendre un appel système qui continue derrière ; `pipeline` ferme les
   * deux flux et rend la main pour de bon. C'est ce qui permet d'arrêter une
   * analyse pendant les cinq minutes de copie depuis le Drive.
   */
  it('s’interrompt en cours de copie, sans laisser de moignon', async () => {
    const controller = new AbortController()
    const promise = ingest(NAME, {
      db: null,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })
    await expect(promise).rejects.toThrow(StopRequestedError)
    // Ni la copie définitive, ni son temporaire.
    expect(fs.readdirSync(path.join(root, 'stage'))).toEqual([])
  })

  it('ne recopie pas une copie de la bonne taille', async () => {
    await ingest(NAME, { db: null })
    const second = await ingest(NAME, { db: null })
    expect(second.copied).toBe(false)
  })
})
