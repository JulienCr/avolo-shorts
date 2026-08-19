import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  waitOrAbandon,
  cleanStage,
  decisionCopy,
  fingerprintSource,
  ensureLocalCopy,
  holdStagedCopy,
  ingest,
  editingResponds,
  statWithDelay,
  STAGE_TTL_MS,
  verifySizeCopied,
} from '@/server/steps/ingest'
import { StopRequestedError } from '@/server/ffmpeg'

/**
 * Ce qui se teste de l'ingestion sans le Drive : la décision de recopier et la
 * forme de l'empreinte. La copie elle-même se vérifie sur une vraie source, où
 * elle prend deux minutes pour 4,3 Gio.
 */

describe('decisionCopy', () => {
  const source = { sizeBytes: 4_577_070_123 }

  it('copie quand rien n est là', () => {
    expect(decisionCopy({ source, copy: null })).toBe('copier')
  })

  it('garde une copie de la même taille — 12 Go sur du 9p ne se repaient pas', () => {
    expect(decisionCopy({ source, copy: { sizeBytes: 4_577_070_123 } })).toBe('garder')
  })

  it('recopie une copie tronquée', () => {
    expect(decisionCopy({ source, copy: { sizeBytes: 1_000 } })).toBe('copier')
  })

  it('force recopie même une copie complète', () => {
    expect(decisionCopy({ source, copy: { sizeBytes: 4_577_070_123 }, force: true })).toBe(
      'copier',
    )
  })

  it('un fichier vide des deux côtés reste une copie valide', () => {
    expect(decisionCopy({ source: { sizeBytes: 0 }, copy: { sizeBytes: 0 } })).toBe('garder')
  })
})

describe('fingerprintSource', () => {
  it('relève taille, date de modification et durée — pas de hash', () => {
    // Digérer 12 Go à chaque lancement coûterait plus cher que l'étape qu'on
    // cherche à éviter (spec §5).
    expect(fingerprintSource({ size: 4_577_070_123, mtimeMs: 1_766_265_593_000 }, 5936.995333)).toEqual(
      { sizeBytes: 4_577_070_123, mtimeMs: 1_766_265_593_000, durationSec: 5936.995333 },
    )
  })

  it('tronque la date en entier : la colonne SQLite en est un', () => {
    expect(fingerprintSource({ size: 1, mtimeMs: 1_766_265_593_123.456 }, null).mtimeMs).toBe(
      1_766_265_593_123,
    )
  })

  it('accepte une durée inconnue, un fichier restant copiable sans elle', () => {
    expect(fingerprintSource({ size: 1, mtimeMs: 0 }, null).durationSec).toBeNull()
  })
})

describe('statWithDelay', () => {
  const roots: string[] = []
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-ingest-'))
    roots.push(d)
    return d
  }

  afterEach(() => {
    for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('rend le stat d un fichier qui répond', async () => {
    const folder = tmp()
    const file = path.join(folder, 'replay.mp4')
    fs.writeFileSync(file, 'douze octets')
    const stat = await statWithDelay(file, 5_000)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBe(12)
  })

  it('distingue un dossier d un fichier — c est ce que resolveSource ne fait pas', async () => {
    // `resolveSource` valide la forme du chemin ; ni l'existence ni le type.
    // C'est `ingest` qui refuse ce qui n'est pas un fichier ordinaire, et il le
    // décide sur ce `isFile()`. (relevé par Aristarque)
    const folder = tmp()
    expect((await statWithDelay(folder, 5_000)).isFile()).toBe(false)
  })

  it('décrit le lien, pas sa cible : un lien symbolique n est pas un fichier', async () => {
    // `resolveSource` valide la forme du chemin avec `path.resolve`, qui ne suit
    // pas les liens. Un lien posé dans REPLAY_DIR et pointant ailleurs passerait
    // donc son contrôle de dossier parent ; c'est le `lstat` qui ferme la porte,
    // et c'est pour cela que ce n'est pas un `stat`. (relevé par Aristarque)
    const folder = tmp()
    const target = path.join(folder, 'ailleurs.mp4')
    fs.writeFileSync(target, 'une vraie vidéo, mais pas à sa place')
    const link = path.join(folder, 'replay.mp4')
    fs.symlinkSync(target, link)

    const stat = await statWithDelay(link, 5_000)
    expect(stat.isSymbolicLink()).toBe(true)
    expect(stat.isFile()).toBe(false)
  })

  it('remonte l absence sans attendre le délai', async () => {
    const folder = tmp()
    await expect(statWithDelay(path.join(folder, 'absent.mp4'), 5_000)).rejects.toThrow(/ENOENT/)
  })

})

describe('verifySizeCopied', () => {
  it('laisse passer une copie de la taille annoncée', () => {
    expect(() => verifySizeCopied(4_577_070_123, 4_577_070_123, '/s.mp4')).not.toThrow()
  })

  it('refuse une copie plus courte que la source', () => {
    // Une fin de fichier propre n'est pas une preuve de complétude : si la
    // source rétrécit pendant la copie, `pipeline` s'achève sans erreur et le
    // renommage rendrait le fichier tronqué définitif. (relevé par Copilot)
    expect(() => verifySizeCopied(1_000, 4_577_070_123, '/s.mp4')).toThrow(/au lieu de/)
  })

  it('refuse aussi une copie plus longue : la source a bougé dans les deux cas', () => {
    expect(() => verifySizeCopied(5_000, 4_000, '/s.mp4')).toThrow(/a changé de taille/)
  })
})

describe('editingResponds', () => {
  const roots: string[] = []
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-montage-'))
    roots.push(d)
    return d
  }

  afterEach(() => {
    for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('répond vrai sur un dossier vivant', async () => {
    await expect(editingResponds(tmp(), 5_000)).resolves.toBe(true)
  })

  it("répond vrai sur un chemin absent : une erreur **est** une réponse", async () => {
    // C'est toute la distinction que `/proc/mounts` ne fait pas. Un montage
    // absent rend `ENOENT` en une microseconde et la suite se déroule
    // normalement — c'est le montage au transport mort, qui ne rend rien du
    // tout, qu'il faut attraper.
    await expect(editingResponds(path.join(tmp(), 'absent'), 5_000)).resolves.toBe(true)
  })

  it('répond faux quand rien ne vient dans le temps imparti', async () => {
    // Minuterie factice, et avancée **avant** de rendre la main à la boucle : le
    // `stat` n'a alors pas encore pu revenir, donc la garde gagne à coup sûr.
    // Un simple délai de zéro sur un fichier local serait une course, et les
    // courses en test se perdent un jour sur dix.
    vi.useFakeTimers()
    try {
      const promise = editingResponds(tmp(), 5_000)
      vi.advanceTimersByTime(5_000)
      await expect(promise).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('waitOrAbandon', () => {
  it('rend le résultat quand le travail arrive à temps', async () => {
    await expect(waitOrAbandon(Promise.resolve(42), 5_000, 'jamais')).resolves.toBe(42)
  })

  it('renonce sur un travail qui ne revient pas, avec un message qui dit quoi faire', async () => {
    // Une promesse qui ne se règle jamais, c'est exactement un `fs.stat` sur un
    // montage 9p dont le transport est mort : l'appel part dans le vivier de
    // fils de libuv et n'en revient pas. On ne peut pas l'interrompre, seulement
    // cesser de l'attendre.
    const never = new Promise<never>(() => {})
    await expect(waitOrAbandon(never, 5, 'le montage ne répond pas')).rejects.toThrow(
      /ne répond pas/,
    )
  })

  it('laisse remonter l échec du travail plutôt que le message de garde', async () => {
    await expect(
      waitOrAbandon(Promise.reject(new Error('ENOENT')), 5_000, 'garde'),
    ).rejects.toThrow(/ENOENT/)
  })

  it("n'abandonne pas de rejet non traité derrière lui", async () => {
    // Sans le `catch` posé sur le travail, un échec arrivant *après* le délai
    // couperait le processus entier.
    const late = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('tard')), 20))
    await expect(waitOrAbandon(late, 1, 'garde')).rejects.toThrow(/garde/)
    await new Promise((r) => setTimeout(r, 40))
  })
})

/**
 * Le cache de travail : `stage/` et ses bornes.
 *
 * **Il n'est jamais une source de vérité et peut être supprimé sans conséquence
 * fonctionnelle** (retour d'usage §5). Ce que ces tests éprouvent est donc
 * l'inverse de ce qu'on éprouve d'un artefact : non pas qu'une copie survit,
 * mais qu'elle disparaît quand il le faut, et qu'elle ne disparaît pas sous les
 * pieds de qui la lit.
 */
describe('nettoyerStage', () => {
  let root: string
  const oldStage = process.env.STAGE_DIR

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-stage-'))
    process.env.STAGE_DIR = path.join(root, 'stage')
    fs.mkdirSync(process.env.STAGE_DIR, { recursive: true })
  })

  afterEach(() => {
    if (oldStage === undefined) delete process.env.STAGE_DIR
    else process.env.STAGE_DIR = oldStage
    fs.rmSync(root, { recursive: true, force: true })
  })

  /** Une copie de travail, avec l'âge qu'on veut lui donner. */
  function poser(name: string, ageMs: number): string {
    const filePath = path.join(process.env.STAGE_DIR as string, name)
    fs.writeFileSync(filePath, 'une copie')
    const when = new Date(Date.now() - ageMs)
    fs.utimesSync(filePath, when, when)
    return filePath
  }

  it('retire ce qui a dépassé les huit heures', async () => {
    const old = poser('vieille.mp4', STAGE_TTL_MS + 60_000)
    expect(await cleanStage()).toEqual(['vieille.mp4'])
    expect(fs.existsSync(old)).toBe(false)
  })

  it('garde ce qui est encore frais', async () => {
    const fresh = poser('fraiche.mp4', STAGE_TTL_MS - 60_000)
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
    const inUsage = poser('en-usage.mp4', STAGE_TTL_MS * 2)
    poser('autre.mp4', STAGE_TTL_MS * 2)
    expect(await cleanStage({ keep: () => [inUsage] })).toEqual(['autre.mp4'])
    expect(fs.existsSync(inUsage)).toBe(true)
  })

  /**
   * **La liste est relue à chaque fichier, pas prise en instantané au départ.**
   * Une exécution démarrée pendant le balayage ne recopie rien — sa copie est
   * là, `ingestionNecessary` l'a constaté — donc rien d'autre ne la
   * signalerait, et le balayage l'effaçait sous ses pieds. (relevé par Codex)
   */
  it('voit une exécution démarrée pendant le balayage', async () => {
    const late = poser('tardive.mp4', STAGE_TTL_MS * 2)
    poser('a.mp4', STAGE_TTL_MS * 2)
    poser('b.mp4', STAGE_TTL_MS * 2)

    // Rien à épargner au départ ; `late` entre en usage au premier fichier vu.
    let inUsage: string[] = []
    let seen = 0
    const removed = await cleanStage({
      keep: () => {
        seen += 1
        if (seen === 1) inUsage = [late]
        return inUsage
      },
    })

    expect(removed).not.toContain('tardive.mp4')
    expect(fs.existsSync(late)).toBe(true)
  })

  /** On n'a pas pu savoir : on épargne, plutôt que d'effacer à l'aveugle. */
  it('n’efface rien quand la liste des copies en usage est indisponible', async () => {
    poser('a.mp4', STAGE_TTL_MS * 2)
    expect(await cleanStage({ keep: () => null })).toEqual([])
  })

  /**
   * **Le dernier contrôle est postérieur au sondage du fichier, pas antérieur.**
   * Relire `keep` avant le `lstat` ne suffisait pas : l'`await` qui les sépare
   * rend la main, et une exécution démarrée là constatait sa copie présente puis
   * la perdait. Ce test l'exerce par le seul moyen observable — une liste qui
   * change entre les deux appels. (relevé par Copilot)
   */
  it('relit la liste après avoir sondé le fichier, pas seulement avant', async () => {
    const target = poser('a.mp4', STAGE_TTL_MS * 2)
    let calls = 0
    const removed = await cleanStage({
      keep: () => {
        calls += 1
        // Rien à épargner au premier appel, la cible au second : sans le
        // contrôle d'après-sondage, le fichier serait effacé.
        return calls === 1 ? [] : [target]
      },
    })
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(removed).toEqual([])
    expect(fs.existsSync(target)).toBe(true)
  })

  /**
   * **Une copie qu'un traitement tient ouverte est épargnée.** `copiesInFlight`
   * ne couvre qu'une copie en train de s'écrire ; un export, lui, lit la sienne
   * pendant tout l'encodage sans plus rien qui la signale, et le TTL s'applique
   * à elle comme aux autres. (relevé par Copilot)
   */
  it('épargne une copie qu’un traitement tient ouverte', async () => {
    const held = poser('tenue.mp4', STAGE_TTL_MS * 2)
    const release = holdStagedCopy(held)

    expect(await cleanStage()).toEqual([])
    expect(fs.existsSync(held)).toBe(true)

    release()
    expect(await cleanStage()).toEqual(['tenue.mp4'])
  })

  /**
   * **Un compteur, pas un ensemble.** Deux exports simultanés sur des clips de
   * la même émission tiennent la même copie, et le premier à finir ne doit pas
   * la libérer sous le second.
   */
  it('ne relâche qu’au dernier des tenants, et une seule fois par tenant', async () => {
    const held = poser('tenue.mp4', STAGE_TTL_MS * 2)
    const first = holdStagedCopy(held)
    const second = holdStagedCopy(held)

    first()
    // Un relâchement idempotent : appelé deux fois, il ne décompte qu'une.
    first()
    expect(await cleanStage()).toEqual([])
    expect(fs.existsSync(held)).toBe(true)

    second()
    expect(await cleanStage()).toEqual(['tenue.mp4'])
  })

  /** Même chose quand elle lève : le nettoyage ne s'arrête pas, il s'abstient. */
  it('n’échoue pas quand la liste des copies en usage lève', async () => {
    const surviving = poser('a.mp4', STAGE_TTL_MS * 2)
    await expect(
      cleanStage({
        keep: () => {
          throw new Error('la base est refermée')
        },
      }),
    ).resolves.toEqual([])
    expect(fs.existsSync(surviving)).toBe(true)
  })

  it('ne touche ni aux sous-dossiers ni aux liens', async () => {
    const stage = process.env.STAGE_DIR as string
    const target = poser('cible.mp4', 0)
    fs.mkdirSync(path.join(stage, 'un-dossier'))
    fs.symlinkSync(target, path.join(stage, 'a-link.mp4'))
    // Le lien est vieux au sens de `lstat` — il vient d'être créé, donc frais —
    // mais même vieilli, ce n'est pas un fichier ordinaire.
    const old = new Date(Date.now() - STAGE_TTL_MS * 2)
    fs.lutimesSync(path.join(stage, 'a-link.mp4'), old, old)
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
  it('ne lève pas quand le dossier n’existe pas', async () => {
    process.env.STAGE_DIR = path.join(root, 'jamais-créé')
    await expect(cleanStage()).resolves.toEqual([])
  })

  it('accepte un TTL et une horloge, pour se tester sans attendre huit heures', async () => {
    poser('a.mp4', 0)
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
  const OCTETS = 16 * 1024 * 1024
  const NAME = '2025-06-15-cqlp.mp4'

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-ingest-'))
    process.env.REPLAY_DIR = path.join(root, 'replays')
    process.env.STAGE_DIR = path.join(root, 'stage')
    fs.mkdirSync(process.env.REPLAY_DIR, { recursive: true })
    fs.writeFileSync(path.join(process.env.REPLAY_DIR, NAME), Buffer.alloc(OCTETS, 7))
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
    expect(fs.statSync(ingestion.stagedPath).size).toBe(OCTETS)
    expect(ingestion.copied).toBe(true)
  })

  /**
   * **Deux traitements ne copient pas la même source deux fois.** Le cas n'est
   * pas théorique : `inCurrent` interdit deux exécutions du même projet, mais rien
   * n'interdit à `dev-ingest` de tourner à côté du serveur. Sans verrou, les
   * deux `pipeline` se disputent la bande passante d'un montage à 97 Mo/s et le
   * second renommage écrase le premier fichier pendant qu'une étape le lit.
   *
   * L'assertion porte sur l'invariant — *au plus une* copie — et non sur le
   * chemin emprunté : si la première finit avant que la seconde ne décide, c'est
   * le contrôle de taille qui l'arrête, et c'est aussi bien. Sans verrou et avec
   * recouvrement, en revanche, les deux copient et le test tombe.
   */
  it('ne copie pas deux fois la même source en parallèle', async () => {
    let copiesInCurrent = 0
    const track = () => {
      copiesInCurrent += 1
    }
    const [a, b] = await Promise.all([
      ingest(NAME, { db: null, onProgress: track }),
      ingest(NAME, { db: null, onProgress: track }),
    ])
    // Une seule des deux a écrit ; l'autre a attendu ou constaté la copie.
    expect([a.copied, b.copied].filter(Boolean).length).toBeLessThanOrEqual(1)
    expect(fs.statSync(a.stagedPath).size).toBe(OCTETS)
    // Et rien de partiel ne traîne : `stage/` porte des fichiers de plusieurs
    // gigaoctets, un moignon n'y serait ramassé par personne.
    expect(fs.readdirSync(path.dirname(a.stagedPath))).toEqual([NAME])
    expect(copiesInCurrent).toBeGreaterThan(0)
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

/**
 * La copie de travail, **reconstituée là où elle manque**.
 *
 * C'est la propriété que le §5 du retour d'usage exige du cache — « peut être
 * supprimé sans conséquence fonctionnelle » — et que le code ne tenait pas : le
 * rendu levait en prescrivant une réingestion que rien dans l'application ne
 * savait déclencher. Le TTL de huit heures en aurait fait le cas normal.
 * (issue #76)
 */
describe('ensureLocalCopy', () => {
  let root: string
  const before = { replay: process.env.REPLAY_DIR, stage: process.env.STAGE_DIR }
  const NAME = '2025-06-15-cqlp.mp4'
  const ID = '2025-06-15-cqlp'
  let source: string
  let destination: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-repare-'))
    process.env.REPLAY_DIR = path.join(root, 'replays')
    process.env.STAGE_DIR = path.join(root, 'stage')
    fs.mkdirSync(process.env.REPLAY_DIR, { recursive: true })
    fs.mkdirSync(process.env.STAGE_DIR, { recursive: true })
    source = path.join(process.env.REPLAY_DIR, NAME)
    destination = path.join(process.env.STAGE_DIR, NAME)
    fs.writeFileSync(source, Buffer.alloc(4 * 1024 * 1024, 3))
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

  const project = () => ({ id: ID, sourcePath: source, stagedPath: destination })

  it('rend la copie telle quelle quand elle est là', async () => {
    fs.writeFileSync(destination, 'déjà copiée')
    expect(await ensureLocalCopy(project(), { db: null })).toBe(destination)
    // Rien n'a été récrit : c'est le cas courant, il ne doit rien coûter.
    expect(fs.readFileSync(destination, 'utf8')).toBe('déjà copiée')
  })

  it('la reconstitue quand elle manque', async () => {
    expect(fs.existsSync(destination)).toBe(false)
    expect(await ensureLocalCopy(project(), { db: null })).toBe(destination)
    expect(fs.statSync(destination).size).toBe(4 * 1024 * 1024)
  })

  /**
   * **Deux exports lancés coup sur coup sur la même émission n'en font qu'une.**
   * Sans le verrou, ce sont deux copies de 12 Go qui se disputent la bande
   * passante d'un montage à 97 Mo/s.
   */
  it('ne déclenche pas deux copies pour deux appels simultanés', async () => {
    const [a, b] = await Promise.all([
      ensureLocalCopy(project(), { db: null }),
      ensureLocalCopy(project(), { db: null }),
    ])
    expect(a).toBe(destination)
    expect(b).toBe(destination)
    expect(fs.statSync(destination).size).toBe(4 * 1024 * 1024)
    // **L'invariant observable : une seule écriture est allée au bout.** Le
    // verrou lui-même est celui de `copyOnce`, éprouvé plus haut sur `ingest` ;
    // ce qui se vérifie ici est que ce chemin-ci y passe bien — sans lui, deux
    // temporaires cohabiteraient et le second renommage écraserait le premier.
    expect(fs.readdirSync(path.dirname(destination))).toEqual([NAME])
  })

  /**
   * Le dernier recours reste : l'original disparu du dossier des replays n'est
   * pas un cache à reconstituer, et le message le dit sans rendre un `ENOENT` nu
   * ni l'arborescence du Drive.
   */
  it('dit quoi faire quand l’original a disparu', async () => {
    fs.rmSync(source, { force: true })
    const message = await ensureLocalCopy(project(), { db: null }).then(
      () => '',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
    expect(message).toMatch(/copie de travail/)
    expect(message).toMatch(/original/)
    expect(message).not.toContain(root)
  })
})
