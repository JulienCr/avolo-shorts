import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  analyzeMarkerTime,
  StopRequestedError,
  pathTemporary,
  chooseEncoder,
  createLog,
  produceArtifact,
  forwardAbort,
  runFfmpeg,
} from '@/server/ffmpeg'

/**
 * Ce qui est testable de `src/server/ffmpeg.ts` sans ffmpeg : la lecture de son
 * flux stderr et le choix de l'encodeur. L'exécution elle-même ne l'est pas, et
 * ce n'est pas grave — c'est exactement pourquoi les argv sont construits dans
 * `src/core/`, où ils sont vérifiés au caractère près.
 */

describe('analyzeMarkerTime', () => {
  it('lit une marque de temps ordinaire', () => {
    expect(analyzeMarkerTime('frame= 240 fps=120 q=28.0 size=1kB time=00:00:08.00 speed=13.8x')).toBe(8)
  })

  it('rend la dernière marque du morceau, pas la première', () => {
    // Un morceau de flux contient plusieurs réécritures : la plus récente fait foi.
    expect(analyzeMarkerTime('time=00:00:01.00\rtime=00:01:00.50\rtime=00:02:03.25')).toBe(123.25)
  })

  it('compose heures, minutes et secondes', () => {
    expect(analyzeMarkerTime('time=01:38:57.00')).toBe(3600 + 38 * 60 + 57)
  })

  it('accepte plus de deux chiffres d heures', () => {
    expect(analyzeMarkerTime('time=100:00:00.00')).toBe(360_000)
  })

  it("rend null sur une marque négative — c'est ce que ffmpeg annonce avant sa première image", () => {
    // `-577014:32:22.77`, soit INT64_MIN divisé par un million. Prise au mot,
    // elle donnerait une barre d'avancement qui commence à moins l'infini.
    expect(analyzeMarkerTime('frame=0 time=-577014:32:22.77 bitrate=N/A')).toBeNull()
  })

  it('une marque négative n annule pas une marque valide qui la suit', () => {
    expect(analyzeMarkerTime('time=-577014:32:22.77\rtime=00:00:04.00')).toBe(4)
  })

  it('rend null sur time=N/A et sur un morceau sans marque', () => {
    expect(analyzeMarkerTime('frame=0 time=N/A bitrate=N/A')).toBeNull()
    expect(analyzeMarkerTime('[libx264 @ 0x55] using cpu capabilities: MMX2 SSE2Fast')).toBeNull()
  })

  it("ne conserve pas d'état entre deux appels", () => {
    // La regex porte le drapeau `g` : un `exec` en boucle sur une constante de
    // module reprendrait à `lastIndex` et raterait la marque du morceau suivant.
    const piece = 'time=00:00:05.00'
    expect(analyzeMarkerTime(piece)).toBe(5)
    expect(analyzeMarkerTime(piece)).toBe(5)
  })
})

describe('createLog', () => {
  it('recolle une ligne coupée entre deux morceaux', () => {
    const j = createLog()
    j.add('[libx264] mauvaise ')
    j.add('nouvelle\n')
    expect(j.lines()).toEqual(['[libx264] mauvaise nouvelle'])
  })

  it('rend la queue non terminée, celle qui porte souvent le message final', () => {
    const j = createLog()
    j.add('Conversion failed!')
    expect(j.lines()).toEqual(['Conversion failed!'])
  })

  it('replie les lignes de statistiques les unes sur les autres', () => {
    // Sans ce repli, deux heures d'encodage noieraient les avertissements sous
    // des milliers de réécritures de la même ligne.
    const j = createLog(5)
    j.add('[warn] mux overhead\n')
    for (let i = 0; i < 500; i++) j.add(`frame=${i} time=00:00:0${i % 10}.00\r`)
    expect(j.lines()).toEqual(['[warn] mux overhead', 'frame=499 time=00:00:09.00'])
  })

  it("ne replie pas deux lignes de statistiques séparées par un avertissement", () => {
    const j = createLog()
    j.add('frame=1 time=00:00:01.00\r[warn] ici\nframe=2 time=00:00:02.00\r')
    expect(j.lines()).toEqual(['frame=1 time=00:00:01.00', '[warn] ici', 'frame=2 time=00:00:02.00'])
  })

  it('garde les dernières lignes et jette les plus anciennes', () => {
    const j = createLog(3)
    for (let i = 1; i <= 10; i++) j.add(`[warn] ligne ${i}\n`)
    expect(j.lines()).toEqual(['[warn] ligne 8', '[warn] ligne 9', '[warn] ligne 10'])
  })

  it('ignore les lignes vides et rend un texte prêt pour un message d erreur', () => {
    const j = createLog()
    j.add('a\n\n\r\nb\n')
    expect(j.text()).toBe('a\nb')
  })

  it('rend les enregistrements complets, et eux seuls', () => {
    // C'est ce que `runFfmpeg` analyse pour la progression : une marque de temps
    // coupée par la frontière d'un morceau serait perdue des deux côtés si l'on
    // lisait le morceau brut. (relevé par Copilot)
    const j = createLog()
    expect(j.add('frame=1 time=00:0')).toEqual([])
    expect(j.add('0:05.00\rframe=2 time=00:00:06.00')).toEqual(['frame=1 time=00:00:05.00'])
    expect(analyzeMarkerTime(j.add('\r').join('\n'))).toBe(6)
  })

  it('borne la queue : un flux sans fin de ligne ne fait pas gonfler le carnet', () => {
    // Le carnet existe pour ne *pas* tout garder ; il suffirait d'un flux sans
    // séparateur pour qu'il garde tout. C'est la fin qui intéresse.
    const j = createLog()
    for (let i = 0; i < 100; i++) j.add('x'.repeat(1000))
    expect(j.text().length).toBeLessThanOrEqual(8192)
  })
})

describe('chooseEncoder', () => {
  const never = () => {
    throw new Error('la sonde ne doit pas tourner quand la valeur est explicite')
  }

  it('respecte une valeur explicite sans sonder', () => {
    expect(chooseEncoder('x264', never)).toBe('x264')
    expect(chooseEncoder('nvenc', never)).toBe('nvenc')
  })

  it('tolère la casse et les espaces', () => {
    expect(chooseEncoder('  NVENC \n', never)).toBe('nvenc')
  })

  it('sonde sur auto, et sur une variable absente ou vide', () => {
    expect(chooseEncoder('auto', () => true)).toBe('nvenc')
    expect(chooseEncoder('auto', () => false)).toBe('x264')
    expect(chooseEncoder(undefined, () => true)).toBe('nvenc')
    expect(chooseEncoder('   ', () => false)).toBe('x264')
  })

  it('refuse une valeur inconnue au lieu de se rabattre en silence', () => {
    // Un repli discret diviserait la vitesse d'export par 2,3 (4,58x contre
    // 1,97x mesurés) sans que rien ne le signale.
    expect(() => chooseEncoder('nvidia', never)).toThrow(/FFMPEG_ENCODER/)
  })
})

describe('pathTemporary', () => {
  it("garde l'extension, dont ffmpeg déduit son muxeur", () => {
    expect(pathTemporary('/projects/x/proxy.mp4', 42)).toBe('/projects/x/proxy.partiel-42.mp4')
  })

  it('reste dans le dossier de destination, pour que le renommage soit atomique', () => {
    expect(pathTemporary('/a/b/audio.wav', 7)).toBe('/a/b/audio.partiel-7.wav')
  })

  it('accepte un fichier sans extension', () => {
    expect(pathTemporary('/a/b/sortie', 7)).toBe('/a/b/sortie.partiel-7')
  })

  it('donne deux noms distincts à deux écritures du même processus', () => {
    // Rien n'interdit un `Promise.all([buildProxy(x), buildProxy(x)])` : sans
    // ce compteur, les deux ffmpeg écriraient dans le même fichier et le
    // renommage rendrait définitif un MP4 entrelacé.
    expect(pathTemporary('/p/proxy.mp4')).not.toBe(pathTemporary('/p/proxy.mp4'))
  })

  it('reste dans le dossier de destination même sans jeton', () => {
    expect(pathTemporary('/p/proxy.mp4')).toMatch(/^\/p\/proxy\.partiel-\d+-\d+\.mp4$/)
  })
})

describe('produceArtifact — la décision de sauter', () => {
  const roots: string[] = []
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-ffmpeg-'))
    roots.push(d)
    return d
  }

  afterEach(() => {
    for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  // Le drapeau : `args` n'est appelé que si l'étape doit vraiment tourner. Il
  // lève, donc le seul fait qu'il soit appelé se voit — et aucun test ici
  // n'atteint ffmpeg.
  const never = () => {
    throw new Error("l'étape ne devait pas tourner")
  }

  it("ne lance rien quand l'artefact est déjà là", async () => {
    const folder = tmp()
    const dst = path.join(folder, 'proxy.mp4')
    fs.writeFileSync(dst, 'un proxy')
    await expect(produceArtifact({ dst, args: never })).resolves.toEqual({
      path: dst,
      skipped: true,
    })
  })

  it('force court-circuite la présence', async () => {
    const folder = tmp()
    const dst = path.join(folder, 'proxy.mp4')
    fs.writeFileSync(dst, 'un proxy')
    await expect(produceArtifact({ dst, force: true, args: never })).rejects.toThrow(
      /ne devait pas tourner/,
    )
  })

  it("lance l'étape quand l'artefact manque, et ne laisse pas de moignon", async () => {
    const folder = tmp()
    const dst = path.join(folder, 'sous-dossier', 'proxy.mp4')
    await expect(produceArtifact({ dst, args: never })).rejects.toThrow(/ne devait pas tourner/)
    // Le dossier a bien été créé, et rien de partiel n'y traîne.
    expect(fs.readdirSync(path.dirname(dst))).toEqual([])
  })
})

/**
 * **Le seul morceau de `runFfmpeg` qui s'éprouve sans ffmpeg**, parce qu'il ne
 * dépend pas du binaire : le délai de garde s'exerce sur n'importe quel
 * processus, et `sleep` en est un qui ne rend pas la main.
 *
 * Il existe pour la vignette d'une source, qui lit **l'original sur le montage
 * 9p** (issue #41). Le Drive décroche de deux façons que `/proc/mounts` ne
 * distingue pas, et un ffmpeg qui pend dessus ne rend jamais la main : ni le
 * processus, ni la requête HTTP qui l'attend. Renoncer sans tuer laisserait un
 * processus par vignette demandée pendant que le partage est tombé.
 */
describe('runFfmpeg, le délai de garde', () => {
  let folder: string

  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-garde-'))
  })

  afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true })
  })

  it('rend la main sans attendre, et le dit', async () => {
    const start = Date.now()
    await expect(
      runFfmpeg(['30'], { bin: 'sleep', timeoutMs: 60, what: 'vignette de source e.mp4' }),
    ).rejects.toThrow(/n'a pas répondu en 60 ms — vignette de source e\.mp4/)
    // Il rend la main tout de suite, sans attendre que le processus veuille bien
    // mourir : sur un montage mort, il part en sommeil non interruptible et
    // `close` peut n'arriver que bien plus tard.
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  /**
   * **Et il tue vraiment.** Rendre la main sans tuer laisserait un processus par
   * vignette demandée pendant que le partage est tombé — c'est là toute la
   * différence avec le reste du dépôt, où l'on se contente de cesser d'attendre
   * un appel système, faute de pouvoir l'annuler.
   *
   * On l'observe par sa conséquence : un `sh` qui écrirait un fichier après le
   * délai ne l'écrit jamais.
   */
  it('tue vraiment le processus, il ne le laisse pas finir dans son coin', async () => {
    const witness = path.join(folder, 'survivant.txt')

    await expect(
      runFfmpeg(['-c', `sleep 0.4; echo vivant > ${witness}`], { bin: 'sh', timeoutMs: 60 }),
    ).rejects.toThrow(/n'a pas répondu/)

    await new Promise((r) => setTimeout(r, 500))
    expect(fs.existsSync(witness)).toBe(false)
  })

  /**
   * **Le défaut reste « ne jamais renoncer »**, et c'est le bon : un proxy prend
   * six minutes, un export jusqu'à une minute, et une borne posée par mégarde
   * les ferait échouer le jour où la machine est chargée. Sans `timeoutMs`, la
   * minuterie ne doit donc pas exister du tout.
   */
  it('ne borne rien quand personne ne le demande', async () => {
    await expect(runFfmpeg(['0.05'], { bin: 'sleep' })).resolves.toBeUndefined()
  })

  it('laisse passer un processus plus rapide que son délai', async () => {
    await expect(runFfmpeg(['0.05'], { bin: 'sleep', timeoutMs: 5_000 })).resolves.toBeUndefined()
  })
})

/**
 * L'arrêt d'une analyse, vu du plus bas étage : un processus fils qu'il faut
 * vraiment tuer.
 *
 * **C'est la moitié qui manquait au parcours.** L'interface pouvait déjà cesser
 * d'afficher une progression ; ce qui n'existait pas, c'est la mort du travail
 * derrière. Une pause qui laisse tourner ffmpeg n'est pas une pause (retour
 * d'usage §11) : le proxy garde douze cœurs pendant six minutes et la
 * transcription garde le GPU.
 *
 * Comme le délai de garde plus haut, ces tests n'ont pas besoin de ffmpeg — ils
 * s'exercent sur `sleep` et sur `sh`, qui sont des processus comme les autres.
 */
describe('propagerArrêt', () => {
  let folder: string

  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-arret-'))
  })

  afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true })
  })

  /** La fin du processus, avec le signal qui l'a emporté. */
  function waitForExit(proc: ReturnType<typeof spawn>): Promise<NodeJS.Signals | null> {
    return new Promise((resolve) => proc.on('close', (_code, signal) => resolve(signal)))
  }

  it('envoie un SIGTERM, qui suffit à un processus ordinaire', async () => {
    const proc = spawn('sleep', ['30'])
    const controller = new AbortController()
    const detach = forwardAbort(proc, controller.signal)
    const fin = waitForExit(proc)
    controller.abort()
    expect(await fin).toBe('SIGTERM')
    detach()
  })

  /**
   * **Et un SIGKILL derrière, parce que le SIGTERM ne suffit pas toujours.**
   * WhisperX doit rendre le modèle et la VRAM, et CTranslate2 y met plusieurs
   * secondes ; un worker qui traînerait tiendrait le GPU pendant que la reprise
   * essaie de démarrer à côté de lui. Le processus de ce test-ci ignore
   * franchement le SIGTERM, ce qu'un worker occupé fait de fait.
   */
  it('tue pour de bon celui qui ignore le SIGTERM', async () => {
    // **On attend que le fils annonce qu'il est prêt.** Un `abort()` posé dans
    // la foulée du `spawn` arrive avant que le processus n'ait installé son
    // gestionnaire, et le signal l'emporte alors par son comportement par
    // défaut : le test passerait en n'éprouvant rien du tout.
    const proc = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => {}); console.log('prêt'); setTimeout(() => {}, 5000)",
    ])
    await new Promise((ready) => proc.stdout?.once('data', ready))

    const controller = new AbortController()
    const detach = forwardAbort(proc, controller.signal, 80)
    const fin = waitForExit(proc)
    controller.abort()
    expect(await fin).toBe('SIGKILL')
    detach()
  })

  /**
   * **Le signal peut déjà avoir été levé.** Un arrêt demandé pendant qu'une
   * étape se prépare — le `mkdir` de `produceArtifact`, les deux `ffprobe` de
   * l'analyse — laisserait sinon partir un processus que plus personne
   * n'attend, seul, jusqu'au bout.
   */
  it('tue un processus lancé après coup sur un signal déjà levé', async () => {
    const controller = new AbortController()
    controller.abort()
    const proc = spawn('sleep', ['30'])
    const fin = waitForExit(proc)
    forwardAbort(proc, controller.signal)()
    expect(await fin).toBe('SIGTERM')
  })

  it('ne fait rien du tout sans signal, et son débranchement est sûr', async () => {
    const proc = spawn('sleep', ['0.05'])
    const detach = forwardAbort(proc, undefined)
    expect(await waitForExit(proc)).toBeNull()
    expect(() => {
      detach()
      detach()
    }).not.toThrow()
  })

  /**
   * Le débranchement retire l'écouteur : sans lui, chaque étape d'une exécution
   * laisserait un écouteur de plus sur le même signal, et la minuterie du
   * SIGKILL tiendrait la boucle d'événements en vie après le processus qu'elle
   * visait.
   */
  it('ne laisse pas d’écouteur derrière lui', async () => {
    const controller = new AbortController()
    const proc = spawn('sleep', ['0.05'])
    const detach = forwardAbort(proc, controller.signal)
    await waitForExit(proc)
    detach()
    // `abort()` après coup ne doit plus rien déclencher : le second `kill` sur
    // un processus mort est de toute façon attrapé, et rien ne doit lever.
    expect(() => controller.abort()).not.toThrow()
  })
})

/**
 * Le groupe de processus : l'opt-in que seule l'analyse d'image utilise.
 *
 * `detached: true` fait du parent le meneur d'un groupe qui lui est propre ;
 * ses propres enfants Unix héritent de ce groupe tant qu'ils ne s'en
 * détachent pas eux-mêmes. `killGroup: true` vise ce groupe entier (`-pid`)
 * plutôt que le seul PID du parent : c'est ce qui atteint l'ffmpeg qu'un
 * worker Python a lancé, sans que rien d'autre ne le sache.
 */
describe('forwardAbort, le groupe de processus', () => {
  /** Un « worker » détaché qui lance lui-même un `sleep` et annonce son PID. */
  function spawnWorkerWithChild(): ReturnType<typeof spawn> {
    return spawn(
      process.execPath,
      [
        '-e',
        "const { spawn } = require('child_process');" +
          "const child = spawn('sleep', ['30']);" +
          "console.log(child.pid);" +
          "setTimeout(() => {}, 30000)",
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
  }

  /** Le PID annoncé sur la première ligne de stdout. */
  function firstPid(proc: ReturnType<typeof spawn>): Promise<number> {
    return new Promise((resolve) => {
      proc.stdout?.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())))
    })
  }

  /** Sonde un PID par un signal 0, jusqu'à ce qu'il réponde ESRCH ou expire. */
  async function untilGone(pid: number, timeoutMs = 2000): Promise<void> {
    const start = Date.now()
    for (;;) {
      try {
        process.kill(pid, 0)
      } catch {
        return
      }
      if (Date.now() - start > timeoutMs) throw new Error(`pid ${pid} toujours vivant`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it("tue l'enfant du worker quand l'appelant vise le groupe", async () => {
    const proc = spawnWorkerWithChild()
    const childPid = await firstPid(proc)
    const controller = new AbortController()
    const detach = forwardAbort(proc, controller.signal, undefined, { killGroup: true })
    controller.abort()
    await untilGone(childPid)
    detach()
  })

  /**
   * Le pendant, et il épingle le critère 2 : un appelant qui n'opte pas — la
   * forme des trois autres appels de `forwardAbort` — ne change rien à son
   * comportement. Même worker détaché, même enfant : sans l'option, il survit.
   */
  it("laisse l'enfant du worker en vie quand l'appelant n'opte pas", async () => {
    const proc = spawnWorkerWithChild()
    const childPid = await firstPid(proc)
    const controller = new AbortController()
    forwardAbort(proc, controller.signal)
    controller.abort()
    await new Promise((r) => setTimeout(r, 300))
    expect(() => process.kill(childPid, 0)).not.toThrow()
    // Nettoyage : cet enfant ne meurt jamais tout seul dans ce test.
    process.kill(childPid, 'SIGKILL')
  })
})

describe('runFfmpeg, l’arrêt demandé', () => {
  let folder: string

  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-arret-ff-'))
  })

  afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true })
  })

  /**
   * **Un arrêt demandé n'est pas un échec de ffmpeg.** Le processus meurt bien
   * d'un SIGTERM, et le message que `close` écrirait sans ce contrôle — « ffmpeg
   * a échoué (tué par SIGTERM) » — est exact et trompeur : il finirait dans
   * `status.json`, puis dans le champ `error` de `GET /api/projects/:id`,
   * c'est-à-dire sur la seule surface qui dise à quelqu'un ce qui s'est passé.
   */
  it('rejette un arrêt, pas un échec', async () => {
    const controller = new AbortController()
    const promise = runFfmpeg(['30'], {
      bin: 'sleep',
      signal: controller.signal,
      what: 'proxy de cqlp',
    })
    controller.abort()
    await expect(promise).rejects.toThrow(StopRequestedError)
    await expect(promise).rejects.toThrow(/Arrêt demandé — proxy de cqlp/)
  })

  it('ne lance même pas le processus quand l’arrêt est déjà demandé', async () => {
    const witness = path.join(folder, 'lance.txt')
    const controller = new AbortController()
    controller.abort()
    await expect(
      runFfmpeg(['-c', `echo parti > ${witness}`], { bin: 'sh', signal: controller.signal }),
    ).rejects.toThrow(StopRequestedError)
    await new Promise((r) => setTimeout(r, 100))
    expect(fs.existsSync(witness)).toBe(false)
  })

  /**
   * **Ce qui rend l'arrêt sûr** : l'écriture passe par un nom temporaire, effacé
   * quand elle échoue. Sans cela, un encodage tué à la cinquième minute
   * laisserait un MP4 tronqué sous le nom définitif, et `readingPresence` le
   * prendrait pour un artefact valide — la reprise sauterait l'étape, et le
   * projet porterait un proxy amputé que personne ne verrait.
   */
  it('ne laisse ni artefact ni moignon derrière un encodage tué', async () => {
    const dst = path.join(folder, 'proxy.mp4')
    const controller = new AbortController()
    process.env.FFMPEG_BIN = 'sh'
    try {
      const promise = produceArtifact({
        dst,
        signal: controller.signal,
        what: 'proxy de cqlp',
        args: (temporary) => ['-c', `sleep 5; echo tronqué > ${temporary}`],
      })
      controller.abort()
      await expect(promise).rejects.toThrow(StopRequestedError)
    } finally {
      delete process.env.FFMPEG_BIN
    }
    expect(fs.existsSync(dst)).toBe(false)
    expect(fs.readdirSync(folder)).toEqual([])
  })

  it('laisse passer un processus qui finit avant l’arrêt', async () => {
    const controller = new AbortController()
    await expect(
      runFfmpeg(['0.05'], { bin: 'sleep', signal: controller.signal }),
    ).resolves.toBeUndefined()
    // Et un arrêt demandé après coup n'a plus rien à couper.
    expect(() => controller.abort()).not.toThrow()
  })
})
