import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { POINT } from '@/core/shots'
import { messageSafe } from '@/server/errors'
import {
  commandReadable,
  environmentDetection,
  formatSize,
  lireAnalysis,
  runAnalysis,
  SCHEMA_ANALYSIS,
  ANALYSIS_VERSIONS,
} from '@/server/steps/analysis'

/**
 * Ce qui se teste de l'analyse sans GPU, sans ffmpeg et sans vidéo : le contrat
 * du fichier produit, l'environnement qu'on pose au worker, et les refus.
 *
 * Le contrat compte plus que le reste, et pour une raison précise : `analysis.json`
 * est lu par des fonctions pures qu'un autre fichier possède
 * (`src/core/framing.ts`, `src/core/shots.ts`). Un champ qui change de nom ou
 * une boîte en pixels ne casserait rien ici — le cadrage sortirait simplement du
 * cadre, trois étapes plus loin, sans un mot.
 */

const ANALYSIS_VALID = {
  version: 1,
  fps: 2,
  source: { w: 1920, h: 1080 },
  proxy: { w: 960, h: 540 },
  shots: [{ start: 0, end: 12.4 }],
  boxes: [{ t: 0.5, x0: 0.12, x1: 0.31, y0: 0.08, y1: 0.97, score: 0.91 }],
}

describe('SCHÉMA_ANALYSE', () => {
  it('accepte la forme du contrat de l’itération 1', () => {
    expect(SCHEMA_ANALYSIS.safeParse(ANALYSIS_VALID).success).toBe(true)
  })

  /**
   * **La décision qui compte.** Les boîtes sont en fractions parce que la
   * détection tourne sur le proxy 960x540 et que le rendu croppe l'original
   * 1920x1080 ; des pixels obligeraient chaque appelant à savoir de quelle image
   * ils viennent. Une boîte en pixels ressemble à une boîte valide — mêmes clés,
   * mêmes types —, et seul le domaine la distingue.
   */
  it('refuse une boîte en pixels, qui a la bonne forme et le mauvais domaine', () => {
    const inPixels = {
      ...ANALYSIS_VALID,
      boxes: [{ t: 0.5, x0: 115, x1: 298, y0: 43, y1: 524, score: 0.91 }],
    }
    expect(SCHEMA_ANALYSIS.safeParse(inPixels).success).toBe(false)
  })

  it('refuse une liste de plans vide', () => {
    // Une émission sans coupe est **un** plan, pas zéro. Zéro laisserait le
    // cadrage sans intervalle où calculer quoi que ce soit.
    expect(SCHEMA_ANALYSIS.safeParse({ ...ANALYSIS_VALID, shots: [] }).success).toBe(false)
  })

  it('accepte une analyse sans aucune boîte', () => {
    // Le cas inverse est légitime : un projet dont personne n'apparaît jamais à
    // l'image est une analyse valide qui ne trouve rien.
    expect(SCHEMA_ANALYSIS.safeParse({ ...ANALYSIS_VALID, boxes: [] }).success).toBe(true)
  })

  /**
   * Un plan retourné a la forme d'un plan et le domaine d'un plan : seul
   * l'ordre de ses bornes le trahit. Le cadrage le trierait sans rien y
   * calculer, et son crop sauterait au plan suivant sans un mot.
   */
  it('refuse un plan retourné ou négatif', () => {
    const returned = { ...ANALYSIS_VALID, shots: [{ start: 10, end: 5 }] }
    expect(SCHEMA_ANALYSIS.safeParse(returned).success).toBe(false)

    const empty = { ...ANALYSIS_VALID, shots: [{ start: 4, end: 4 }] }
    expect(SCHEMA_ANALYSIS.safeParse(empty).success).toBe(false)

    const beforeStart = { ...ANALYSIS_VALID, shots: [{ start: -1, end: 5 }] }
    expect(SCHEMA_ANALYSIS.safeParse(beforeStart).success).toBe(false)
  })

  /**
   * Même piège d'un cran plus bas : deux fractions parfaitement dans [0, 1]
   * peuvent décrire une boîte d'aire nulle. Le percentile 90 du cadrage la
   * compterait comme une personne de largeur nulle et refermerait le crop
   * d'autant.
   */
  it('refuse une boîte d’aire nulle ou retournée', () => {
    const flat = {
      ...ANALYSIS_VALID,
      boxes: [{ t: 1, x0: 0.4, x1: 0.4, y0: 0.1, y1: 0.9, score: 0.9 }],
    }
    expect(SCHEMA_ANALYSIS.safeParse(flat).success).toBe(false)

    const returned = {
      ...ANALYSIS_VALID,
      boxes: [{ t: 1, x0: 0.6, x1: 0.2, y0: 0.1, y1: 0.9, score: 0.9 }],
    }
    expect(SCHEMA_ANALYSIS.safeParse(returned).success).toBe(false)

    const beforeStart = {
      ...ANALYSIS_VALID,
      boxes: [{ t: -0.5, x0: 0.2, x1: 0.6, y0: 0.1, y1: 0.9, score: 0.9 }],
    }
    expect(SCHEMA_ANALYSIS.safeParse(beforeStart).success).toBe(false)
  })

  /**
   * **L'invariant porte sur la liste, pas sur le plan**, et c'est ce qui le rend
   * facile à manquer : chacun de ces plans est irréprochable pris seul. Deux
   * plans qui se recouvrent font compter deux fois les boîtes de leur zone
   * commune, donc gonflent le total sur lequel `chooseRatio` cherche son seuil
   * de 90 % — le clip sortirait dans un cadre plus large que nécessaire, sans
   * erreur. `detect.py` ne peut pas les produire aujourd'hui ; l'itération 1 va
   * itérer sur le détecteur. (relevé par Aristarque sur la PR du cadrage)
   */
  it('refuse des plans qui se chevauchent ou qui remontent le temps', () => {
    const overlap = {
      ...ANALYSIS_VALID,
      shots: [
        { start: 0, end: 15 },
        { start: 10, end: 20 },
      ],
    }
    expect(SCHEMA_ANALYSIS.safeParse(overlap).success).toBe(false)

    const outOfOrder = {
      ...ANALYSIS_VALID,
      shots: [
        { start: 30, end: 40 },
        { start: 0, end: 10 },
      ],
    }
    expect(SCHEMA_ANALYSIS.safeParse(outOfOrder).success).toBe(false)

    // Le message nomme la conséquence, pas la règle : « plans non triés »
    // laisserait chercher pourquoi ça compte.
    const failure = SCHEMA_ANALYSIS.safeParse(overlap)
    expect(failure.success ? '' : failure.error.issues[0]?.message).toMatch(/deux fois/)
  })

  /**
   * L'autre façon de mentir, symétrique et plus discrète : un trou ne fait pas
   * compter deux fois, il fait **disparaître**. `computeFraming` ignore les
   * boîtes qui n'appartiennent à aucun plan, donc l'intervalle est cadré par
   * défaut — comme si personne n'y était jamais apparu. Même chose pour une
   * liste qui ne commence pas à zéro : le début de l'émission devient un trou.
   * (relevé par Copilot)
   */
  it('refuse un trou entre deux plans, ou un début après zéro', () => {
    const gap = {
      ...ANALYSIS_VALID,
      shots: [
        { start: 0, end: 10 },
        { start: 25, end: 40 },
      ],
    }
    expect(SCHEMA_ANALYSIS.safeParse(gap).success).toBe(false)

    const startLate = { ...ANALYSIS_VALID, shots: [{ start: 4, end: 40 }] }
    expect(SCHEMA_ANALYSIS.safeParse(startLate).success).toBe(false)

    const failure = SCHEMA_ANALYSIS.safeParse(gap)
    expect(failure.success ? '' : failure.error.issues[0]?.message).toMatch(/disparaître/)
  })

  /**
   * La tolérance vaut la granularité de `detect.py`, qui arrondit ses bornes à
   * la milliseconde : un écart d'un millième est un artefact d'arrondi, pas un
   * trou. Un vrai trou se compte en secondes.
   */
  it('tolère l’arrondi à la milliseconde, pas plus', () => {
    const rounded = {
      ...ANALYSIS_VALID,
      shots: [
        { start: 0, end: 12.4 },
        { start: 12.401, end: 30 },
      ],
    }
    expect(SCHEMA_ANALYSIS.safeParse(rounded).success).toBe(true)

    const hundredth = {
      ...ANALYSIS_VALID,
      shots: [
        { start: 0, end: 12.4 },
        { start: 12.41, end: 30 },
      ],
    }
    expect(SCHEMA_ANALYSIS.safeParse(hundredth).success).toBe(false)
  })

  it('accepte des plans qui se touchent, ce que detect.py produit', () => {
    // `plans()` découpe `[0, durée]` à des frontières successives : la fin de
    // l'un **est** le début du suivant. Interdire ça condamnerait toute analyse.
    const attached = {
      ...ANALYSIS_VALID,
      shots: [
        { start: 0, end: 12.4 },
        { start: 12.4, end: 30 },
        { start: 30, end: 91.2 },
      ],
    }
    expect(SCHEMA_ANALYSIS.safeParse(attached).success).toBe(true)
  })

  it('accepte les deux versions écrites par ce dépôt', () => {
    // La 2 porte les points de pose et le nom des poids ; la 1 est ce que le
    // détecteur écrivait avant le 19 août 2026, et les fichiers déjà sur le
    // disque doivent continuer de se relire sans qu'on relance le GPU.
    for (const version of ANALYSIS_VERSIONS) {
      expect(SCHEMA_ANALYSIS.safeParse({ ...ANALYSIS_VALID, version }).success).toBe(true)
    }
  })

  it('refuse une version inconnue', () => {
    expect(SCHEMA_ANALYSIS.safeParse({ ...ANALYSIS_VALID, version: 3 }).success).toBe(false)
    expect(SCHEMA_ANALYSIS.safeParse({ ...ANALYSIS_VALID, version: 0 }).success).toBe(false)
  })

  it('accepte dix-sept points de pose, et refuse un squelette tronqué', () => {
    // **La longueur est la seule chose qui distingue un squelette d'un tableau
    // de nombres.** Trop court, il se lit sans erreur : `k[3 * i]` rend
    // `undefined`, le tronc en sort vide, et le cadrage retombe sur la boîte
    // corps entier — c'est-à-dire sur le comportement d'avant, sous une
    // étiquette qui affirme le contraire.
    const complete = Array.from({ length: 51 }, (_, i) => (i % 3 === 2 ? 0.9 : 0.5))
    const withKeypoints = {
      ...ANALYSIS_VALID,
      version: 2 as const,
      keypoints: 'coco17' as const,
      boxes: [{ ...ANALYSIS_VALID.boxes[0], k: complete }],
    }
    expect(SCHEMA_ANALYSIS.safeParse(withKeypoints).success).toBe(true)
    expect(
      SCHEMA_ANALYSIS.safeParse({
        ...withKeypoints,
        boxes: [{ ...ANALYSIS_VALID.boxes[0], k: complete.slice(0, 48) }],
      }).success,
    ).toBe(false)
  })

  it('laisse un point de pose sortir du cadre, contrairement à une boîte', () => {
    // Une épaule que le bord de l'image coupe est une information ; une boîte
    // hors cadre ne désigne plus rien. Seule la confiance est bornée.
    const outside = Array.from({ length: 51 }, (_, i) => (i % 3 === 2 ? 0.9 : -0.2))
    expect(
      SCHEMA_ANALYSIS.safeParse({
        ...ANALYSIS_VALID,
        version: 2 as const,
        boxes: [{ ...ANALYSIS_VALID.boxes[0], k: outside }],
      }).success,
    ).toBe(true)
  })

  /**
   * **Et la confiance, elle, est bornée** — l'autre moitié de la phrase
   * ci-dessus, qui n'était pas tenue.
   *
   * Le tableau est plat : `z.number()` ne distingue pas une abscisse d'une
   * confiance, donc `-1` et `2` passaient au même titre qu'une coordonnée hors
   * cadre. Ni l'un ni l'autre n'échoue bruyamment ensuite — ils franchissent
   * `torsoMinScore` dans le mauvais sens, un point invisible entre dans le tronc
   * ou un point vu en sort, et le crop se déplace sans que rien ne le dise.
   * (relevé par Copilot)
   */
  it('refuse une confiance de point hors de [0, 1], au rang près', () => {
    const k = (confidence: number): number[] =>
      Array.from({ length: 51 }, (_, i) => (i % 3 === 2 ? confidence : 0.5))
    const accepts = (points: number[]): boolean =>
      SCHEMA_ANALYSIS.safeParse({
        ...ANALYSIS_VALID,
        version: 2 as const,
        boxes: [{ ...ANALYSIS_VALID.boxes[0], k: points }],
      }).success

    expect(accepts(k(0))).toBe(true)
    expect(accepts(k(1))).toBe(true)
    expect(accepts(k(-1))).toBe(false)
    expect(accepts(k(2))).toBe(false)

    // Un seul rang de confiance fautif suffit, et c'est bien le rang qui décide :
    // la même valeur posée sur une abscisse reste acceptée.
    const oneBad = k(0.9)
    oneBad[POINT.LEFT_HIP * 3 + 2] = 1.4
    expect(accepts(oneBad)).toBe(false)
    const onAnX = k(0.9)
    onAnX[POINT.LEFT_HIP * 3] = 1.4
    expect(accepts(onAnX)).toBe(true)
  })

  it('refuse des dimensions de proxy nulles', () => {
    // Elles servent à convertir les fractions en pixels : un zéro donnerait un
    // crop de largeur nulle, que ffmpeg refuse bien plus tard.
    const nullDimensions = { ...ANALYSIS_VALID, proxy: { w: 0, h: 540 } }
    expect(SCHEMA_ANALYSIS.safeParse(nullDimensions).success).toBe(false)
  })
})

describe('formatTaille', () => {
  it('écrit ce que detect.py analyse', () => {
    expect(formatSize(960, 540)).toBe('960x540')
  })
})

/**
 * La liste blanche. Le worker de détection n'a besoin de rien télécharger — les
 * poids sont sur le disque, posés par `setup.sh` —, donc il ne reçoit ni cache
 * Hugging Face ni variable de mandataire. Ce sont justement les mandataires qui
 * portent un mot de passe dans leur autorité, et le stderr du worker est capturé
 * puis remonté par `onLog`.
 */
describe('environnementDétection', () => {
  it('ne laisse passer aucun secret, même nommé innocemment', () => {
    const env = environmentDetection({
      PATH: '/usr/bin',
      GEMINI_API_KEY: 'secret',
      DATABASE_URL: 'postgres://u:mdp@hôte/db',
      HTTPS_PROXY: 'http://u:mdp@mandataire:3128',
      HF_TOKEN: 'hf_…',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.GEMINI_API_KEY).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.HF_TOKEN).toBeUndefined()
  })

  /**
   * `HOME` n'est pas là par habitude : sans lui, ultralytics écrit ses réglages
   * dans le dossier de travail du processus, donc à la racine du dépôt.
   */
  it('transmet HOME et les variables du GPU', () => {
    const env = environmentDetection({ HOME: '/home/julien', CUDA_VISIBLE_DEVICES: '0' })
    expect(env.HOME).toBe('/home/julien')
    expect(env.CUDA_VISIBLE_DEVICES).toBe('0')
  })

  it('n’invente pas une variable absente', () => {
    expect('TMPDIR' in environmentDetection({ PATH: '/usr/bin' })).toBe(false)
  })
})

describe('lireAnalyse', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-analysis-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('rend l’analyse validée', () => {
    const file = path.join(root, 'analysis.json')
    fs.writeFileSync(file, JSON.stringify(ANALYSIS_VALID))
    expect(lireAnalysis(file).shots).toEqual([{ start: 0, end: 12.4 }])
  })

  /**
   * Le message nomme les champs fautifs. Sans eux, « analysis.json ne suit pas
   * le contrat » envoie ouvrir un fichier d'un mégaoctet à la main.
   */
  it('nomme ce qui cloche plutôt que d’échouer en bloc', () => {
    const file = path.join(root, 'analysis.json')
    fs.writeFileSync(file, JSON.stringify({ ...ANALYSIS_VALID, fps: 0 }))
    expect(() => lireAnalysis(file)).toThrow(/fps/)
  })

  it('lève sur un JSON tronqué', () => {
    const file = path.join(root, 'analysis.json')
    fs.writeFileSync(file, '{"version": 1, "shots": [')
    expect(() => lireAnalysis(file)).toThrow()
  })
})

/**
 * Monte de quoi faire tourner `runAnalysis` jusqu'au bout sans GPU, sans torch
 * et sans vidéo : un proxy vide, un `ffprobe` qui répond, et un worker qui écrit
 * `charge` là où `--out` le lui dit avant de sortir par 0.
 *
 * **Des faux binaires plutôt que des doublures de modules**, comme le reste de
 * ce fichier : `FFPROBE_BIN` et `DETECT_PYTHON` sont les coutures que le dépôt
 * expose déjà, et aucun test de cette base n'installe de mock. Le worker sort
 * par 0 : c'est le seul cas où la validation d'avant renommage a quelque chose à
 * faire — un worker qui échoue est arrêté bien avant.
 */
function mountFakeWorker(root: string, load: string): void {
  fs.writeFileSync(path.join(root, 'projects', 'projet', 'proxy.mp4'), '')

  const ffprobe = path.join(root, 'ffprobe-ok')
  fs.writeFileSync(
    ffprobe,
    '#!/bin/sh\necho \'{"streams":[{"width":960,"height":540,"r_frame_rate":"30/1"}],' +
      '"format":{"duration":"10"}}\'\n',
    { mode: 0o755 },
  )

  const loadFile = path.join(root, 'charge-du-worker')
  fs.writeFileSync(loadFile, load)
  const python = path.join(root, 'faux-detect')
  // `--out` se relit dans `$@` : le worker ne connaît pas le nom du temporaire,
  // que `cheminTemporaire` tire du PID et d'un compteur.
  fs.writeFileSync(
    python,
    [
      '#!/bin/sh',
      'out=""',
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = "--out" ]; then out="$2"; fi',
      '  shift',
      'done',
      `cat ${JSON.stringify(loadFile)} > "$out"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  // Le script et les poids ne sont pas ouverts par ce faux worker : seul leur
  // existence est contrôlée, en amont, par `runAnalysis`.
  for (const [name, variable] of [
    ['detect.py', 'DETECT_WORKER'],
    ['yolo11m.pt', 'DETECT_MODEL'],
  ] as const) {
    const filePath = path.join(root, name)
    fs.writeFileSync(filePath, '')
    process.env[variable] = filePath
  }
  process.env.FFPROBE_BIN = ffprobe
  process.env.DETECT_PYTHON = python
}

describe('runAnalysis', () => {
  let root: string
  const envStart = { ...process.env }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-analysis-run-'))
    process.env.PROJECTS_DIR = path.join(root, 'projects')
    fs.mkdirSync(path.join(root, 'projects', 'projet'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    process.env = { ...envStart }
  })

  it('ne refait rien si analysis.json est déjà là', async () => {
    const expected = path.join(root, 'projects', 'projet', 'analysis.json')
    fs.writeFileSync(expected, JSON.stringify(ANALYSIS_VALID))

    // Ni proxy ni venv sur le disque : si l'étape allait plus loin que le
    // saut, elle échouerait avant d'atteindre le premier sous-processus.
    const artifact = await runAnalysis({ projectId: 'projet', source: '/absent.mp4' })
    expect(artifact).toEqual({ path: expected, skipped: true })
  })

  /**
   * Le graphe garantit l'ordre, mais un appel direct — un script, un test, une
   * route future — peut l'ignorer. Le message dit quoi faire plutôt que de
   * laisser ffprobe échouer sur un fichier absent.
   */
  it('refuse de tourner sans proxy, et le dit', async () => {
    await expect(runAnalysis({ projectId: 'projet', source: '/absent.mp4' })).rejects.toThrow(
      /proxy/i,
    )
  })

  it('refuse un interpréteur de détection absent, en renvoyant à setup.sh', async () => {
    fs.writeFileSync(path.join(root, 'projects', 'projet', 'proxy.mp4'), '')
    process.env.DETECT_PYTHON = path.join(root, 'pas-de-venv', 'bin', 'python')

    await expect(runAnalysis({ projectId: 'projet', source: '/absent.mp4' })).rejects.toThrow(
      /setup\.sh/,
    )
  })

  /**
   * **Les messages de cette étape nomment des chemins absolus, et c'est voulu** :
   * ils sont écrits pour un journal de serveur. Ce qui compte est qu'aucun ne
   * traverse `messageSûr` en gardant l'arborescence de la machine — le champ
   * `error` de `status.json` ressort tel quel dans `GET /api/projects/:id`.
   *
   * Ces deux cas figent la propriété pour les trois chemins que l'itération 1
   * ajoute (`DETECT_PYTHON`, `DETECT_WORKER`, `DETECT_MODEL`), sous leurs deux
   * formes : entre guillemets pour les refus d'ouverture, et nu au milieu d'une
   * ligne de commande pour l'échec du worker. (relevé par Aristarque)
   */
  it('n’expose pas l’arborescence de la machine quand un chemin manque', async () => {
    fs.writeFileSync(path.join(root, 'projects', 'projet', 'proxy.mp4'), '')
    process.env.DETECT_PYTHON = '/home/quelquun/dev/avolo-shorts/worker/venv/bin/python'

    const error = await runAnalysis({ projectId: 'projet', source: '/absent.mp4' }).catch(
      (cause: unknown) => cause,
    )
    const published = messageSafe(error)
    expect(published).not.toContain('quelquun')
    expect(published).toContain('…/python')
    // Le remède survit à l'épuration : c'est lui qui dit quoi faire.
    expect(published).toContain('setup.sh')
  })

  /**
   * **Une dimension nulle ne s'arrête jamais toute seule.** `detect.py` en tire
   * `octets = 0`, et `read(0)` rend zéro octet sans jamais être « plus court que
   * demandé » : la boucle de décodage produirait des images vides sans fin. Pas
   * d'erreur, pas de sortie, une VRAM qui reste prise. D'où le refus ici, au
   * même titre qu'une dimension absente. (relevé par Copilot)
   *
   * Éprouvé par un faux `ffprobe` plutôt que par un mock : `FFPROBE_BIN` est la
   * couture que le dépôt expose déjà, et aucun test de cette base n'installe de
   * doublure de module.
   */
  it('refuse une dimension nulle, qui ferait tourner le worker sans fin', async () => {
    fs.writeFileSync(path.join(root, 'projects', 'projet', 'proxy.mp4'), '')
    const fake = path.join(root, 'ffprobe-largeur-nulle')
    fs.writeFileSync(
      fake,
      '#!/bin/sh\necho \'{"streams":[{"width":0,"height":540,"r_frame_rate":"30/1"}],' +
        '"format":{"duration":"10"}}\'\n',
      { mode: 0o755 },
    )
    process.env.FFPROBE_BIN = fake
    // Le venv et les poids doivent exister pour que l'étape aille jusqu'au
    // sondage : ce sont les contrôles d'avant.
    for (const name of ['python', 'detect.py', 'yolo11m.pt']) {
      const filePath = path.join(root, name)
      fs.writeFileSync(filePath, '')
      process.env[
        { python: 'DETECT_PYTHON', 'detect.py': 'DETECT_WORKER', 'yolo11m.pt': 'DETECT_MODEL' }[
          name
        ] as string
      ] = filePath
    }

    await expect(runAnalysis({ projectId: 'projet', source: '/absent.mp4' })).rejects.toThrow(
      /nulles/,
    )
  })

  /**
   * **L'arrêt coupe aussi les sondages, et il se dit comme un arrêt.** Les deux
   * `ffprobe` précèdent le worker, leur délai de garde vaut deux minutes, et le
   * second peut lire l'original sur le montage 9p : sans le signal, un arrêt
   * demandé là laissait le processus et `running` actifs jusqu'à ce délai.
   *
   * Et sans le contrôle qui suit chaque sondage, il ressortait en « ffprobe n'a
   * rien su dire du proxy — le refaire avec un run --force », qui envoie
   * réencoder six minutes de vidéo parfaitement valide. (relevé par Copilot)
   */
  it('rend un arrêt demandé pendant les sondages, pas un proxy illisible', async () => {
    fs.writeFileSync(path.join(root, 'projects', 'projet', 'proxy.mp4'), '')
    // Un `ffprobe` qui ne rend jamais la main : c'est le montage 9p au transport
    // mort, en pire — ici même le délai de garde de deux minutes ne sauve pas
    // l'appelant, seul le signal le fait.
    const fake = path.join(root, 'ffprobe-qui-pend')
    fs.writeFileSync(fake, '#!/bin/sh\nsleep 300\n', { mode: 0o755 })
    process.env.FFPROBE_BIN = fake
    for (const name of ['python', 'detect.py', 'yolo11m.pt']) {
      const filePath = path.join(root, name)
      fs.writeFileSync(filePath, '')
      process.env[
        { python: 'DETECT_PYTHON', 'detect.py': 'DETECT_WORKER', 'yolo11m.pt': 'DETECT_MODEL' }[
          name
        ] as string
      ] = filePath
    }

    const controller = new AbortController()
    const promise = runAnalysis({
      projectId: 'projet',
      source: '/absent.mp4',
      signal: controller.signal,
    })
    // Laisser le premier sondage partir, puis couper.
    await new Promise((r) => setTimeout(r, 50))
    controller.abort()

    await expect(promise).rejects.toThrow(/Arrêt demandé/)
  })

  it('n’expose pas la ligne de commande du worker en échec', () => {
    const command =
      "L'analyse a échoué (code de sortie 3).\n" +
      `Commande : ${commandReadable('/home/quelquun/dev/avolo-shorts/worker/venv/bin/python', [
        '-u',
        '/home/quelquun/dev/avolo-shorts/worker/detect.py',
        '--model',
        '/home/quelquun/dev/avolo-shorts/worker/models/yolo11m.pt',
      ])}`
    const published = messageSafe(new Error(command))
    expect(published).not.toContain('quelquun')
    expect(published).toContain('…/detect.py')
    expect(published).toContain('…/yolo11m.pt')
  })

  /**
   * **Le cas qui reste quand le dépôt est cloné sous un dossier à espace.** La
   * passe sur les chemins nus d'`épurerChemins` s'arrête à la première espace,
   * faute de savoir où le chemin finit : sans guillemets, la queue de
   * l'arborescence part dans `status.json`. C'est pour ce cas-là que les
   * arguments à espace sont cités, et c'est aussi pour lui que `racines()`
   * connaît maintenant les trois `DETECT_*`. (relevé par Copilot)
   */
  it('n’expose pas un chemin qui contient une espace', () => {
    const python = '/home/jean/Mon dossier/avolo-shorts/worker/venv/bin/python'
    const command = `Commande : ${commandReadable(python, ['-u', '--model', '/x/y.pt'])}`
    expect(messageSafe(new Error(command))).not.toContain('Mon dossier')

    // Et la forme que Node écrit tout seul, sans guillemets, sur un spawn en
    // échec : celle-là ne se cite pas. `racines()` la couvre quand
    // `DETECT_PYTHON` est posée…
    process.env.DETECT_PYTHON = python
    expect(messageSafe(new Error(`spawn ${python} ENOENT`))).not.toContain('Mon dossier')
  })

  /**
   * …et quand elle ne l'est pas, `racines()` ne connaît rien du venv, puisque le
   * chemin vient alors de `process.cwd()`. C'est pour ce cas-là que le message
   * de démarrage ne reprend **que le code** de l'erreur : le chemin y est déjà,
   * entre guillemets, donc épurable. (relevé par Copilot)
   */
  it('ne remonte que le code d’erreur quand le worker ne démarre pas', async () => {
    const folder = path.join(root, 'Mon dossier')
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(root, 'projects', 'projet', 'proxy.mp4'), '')

    // Un interpréteur qui existe mais n'est pas exécutable : `spawn` échoue à
    // l'exécution, pas au contrôle de présence de l'étape.
    const python = path.join(folder, 'python')
    fs.writeFileSync(python, '', { mode: 0o644 })
    const script = path.join(folder, 'detect.py')
    fs.writeFileSync(script, '')
    const template = path.join(folder, 'yolo11m.pt')
    fs.writeFileSync(template, '')
    const fake = path.join(root, 'ffprobe-ok')
    fs.writeFileSync(
      fake,
      '#!/bin/sh\necho \'{"streams":[{"width":960,"height":540,"r_frame_rate":"30/1"}],' +
        '"format":{"duration":"10"}}\'\n',
      { mode: 0o755 },
    )
    process.env.FFPROBE_BIN = fake
    process.env.DETECT_PYTHON = python
    process.env.DETECT_WORKER = script
    process.env.DETECT_MODEL = template
    const error = await runAnalysis({ projectId: 'projet', source: '/absent.mp4' }).catch(
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/EACCES|ENOENT/)
    // Le message composé ne reprend pas la phrase de Node, donc pas son chemin nu.
    expect((error as Error).message).not.toContain(`spawn ${python}`)
  })

  /**
   * **La propriété que la tête de ce fichier annonce, et que rien ne tenait.**
   *
   * `analysis.json` est relu et validé *avant* d'être renommé à sa place
   * définitive. C'est ce qui empêche un artefact hors contrat de devenir
   * l'artefact officiel — et le graphe de présence ne regarde que l'existence du
   * fichier : une fois posé sous le nom définitif, un JSON malformé est sauté à
   * toutes les relances suivantes, et le cadrage échoue trois étapes plus loin
   * sans que personne ne sache d'où ça vient.
   *
   * Le test tient l'ordre des deux lignes, pas le refus : `lireAnalyse` a déjà
   * ses propres cas plus haut. Ce qui compte ici est **ce qui reste sur le
   * disque** après l'échec. Inverser validation et renommage laisse `analysis.json`
   * en place et rend ce test rouge ; c'est la seule façon de prouver qu'il
   * mesure l'ordre.
   *
   * Le worker est un script shell : ce qu'on éprouve est la mécanique de
   * `runAnalysis`, pas YOLO. Il écrit ce qu'on lui a préparé à l'endroit que
   * `--out` désigne, et sort par 0 — exactement le cas dangereux, celui d'un
   * worker qui se croit content.
   */
  it('ne range pas sous le nom définitif un analysis.json hors contrat', async () => {
    // Un JSON qui *parse* et qui ment : zéro plan. Un fichier tronqué serait le
    // cas facile — celui-ci a la bonne forme et pas le bon contenu, donc il
    // franchit `JSON.parse` et ne s'arrête qu'au schéma.
    mountFakeWorker(root, JSON.stringify({ ...ANALYSIS_VALID, shots: [] }))

    await expect(runAnalysis({ projectId: 'projet', source: '/absent.mp4' })).rejects.toThrow(
      /contrat de l'itération 1/,
    )

    const project = path.join(root, 'projects', 'projet')
    expect(fs.existsSync(path.join(project, 'analysis.json'))).toBe(false)
    // Et le temporaire ne survit pas non plus : un `.partiel-…` oublié à chaque
    // échec finirait par remplir le dossier du projet.
    expect(fs.readdirSync(project).filter((n) => n.includes('.partiel-'))).toEqual([])
  })

  /**
   * L'autre moitié du même chemin d'erreur, et celle que la tête du fichier
   * nomme : « un processus tué à la quatrième minute laisserait un JSON tronqué
   * sous le nom définitif ». Un fichier tronqué s'arrête à `JSON.parse`, pas au
   * schéma — donc à une autre ligne, dans une autre exception, sous le même
   * `try`.
   */
  it('ne range pas non plus un JSON tronqué', async () => {
    mountFakeWorker(root, '{"version": 1, "shots": [')

    await expect(runAnalysis({ projectId: 'projet', source: '/absent.mp4' })).rejects.toThrow()

    const project = path.join(root, 'projects', 'projet')
    expect(fs.existsSync(path.join(project, 'analysis.json'))).toBe(false)
    expect(fs.readdirSync(project).filter((n) => n.includes('.partiel-'))).toEqual([])
  })

  /**
   * Le pendant, et il n'est pas décoratif : sans lui, un `runAnalysis` qui ne
   * rangerait **jamais** rien passerait le test ci-dessus les yeux fermés.
   */
  it('range analysis.json une fois seulement, quand il est valide', async () => {
    mountFakeWorker(root, JSON.stringify(ANALYSIS_VALID))

    const project = path.join(root, 'projects', 'projet')
    const artifact = await runAnalysis({ projectId: 'projet', source: '/absent.mp4' })

    expect(artifact).toEqual({ path: path.join(project, 'analysis.json'), skipped: false })
    expect(lireAnalysis(artifact.path).shots).toEqual([{ start: 0, end: 12.4 }])
    expect(fs.readdirSync(project).filter((n) => n.includes('.partiel-'))).toEqual([])
  })
})
