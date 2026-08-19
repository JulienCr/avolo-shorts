import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { POINT } from '@/core/shots'
import { messageSûr } from '@/server/erreurs'
import {
  commandeLisible,
  environnementDétection,
  formatTaille,
  lireAnalyse,
  runAnalysis,
  SCHÉMA_ANALYSE,
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

const ANALYSE_VALIDE = {
  version: 1,
  fps: 2,
  source: { w: 1920, h: 1080 },
  proxy: { w: 960, h: 540 },
  shots: [{ start: 0, end: 12.4 }],
  boxes: [{ t: 0.5, x0: 0.12, x1: 0.31, y0: 0.08, y1: 0.97, score: 0.91 }],
}

describe('SCHÉMA_ANALYSE', () => {
  it('accepte la forme du contrat de l’itération 1', () => {
    expect(SCHÉMA_ANALYSE.safeParse(ANALYSE_VALIDE).success).toBe(true)
  })

  /**
   * **La décision qui compte.** Les boîtes sont en fractions parce que la
   * détection tourne sur le proxy 960x540 et que le rendu croppe l'original
   * 1920x1080 ; des pixels obligeraient chaque appelant à savoir de quelle image
   * ils viennent. Une boîte en pixels ressemble à une boîte valide — mêmes clés,
   * mêmes types —, et seul le domaine la distingue.
   */
  it('refuse une boîte en pixels, qui a la bonne forme et le mauvais domaine', () => {
    const enPixels = {
      ...ANALYSE_VALIDE,
      boxes: [{ t: 0.5, x0: 115, x1: 298, y0: 43, y1: 524, score: 0.91 }],
    }
    expect(SCHÉMA_ANALYSE.safeParse(enPixels).success).toBe(false)
  })

  it('refuse une liste de plans vide', () => {
    // Une émission sans coupe est **un** plan, pas zéro. Zéro laisserait le
    // cadrage sans intervalle où calculer quoi que ce soit.
    expect(SCHÉMA_ANALYSE.safeParse({ ...ANALYSE_VALIDE, shots: [] }).success).toBe(false)
  })

  it('accepte une analyse sans aucune boîte', () => {
    // Le cas inverse est légitime : un projet dont personne n'apparaît jamais à
    // l'image est une analyse valide qui ne trouve rien.
    expect(SCHÉMA_ANALYSE.safeParse({ ...ANALYSE_VALIDE, boxes: [] }).success).toBe(true)
  })

  /**
   * Un plan retourné a la forme d'un plan et le domaine d'un plan : seul
   * l'ordre de ses bornes le trahit. Le cadrage le trierait sans rien y
   * calculer, et son crop sauterait au plan suivant sans un mot.
   */
  it('refuse un plan retourné ou négatif', () => {
    const retourné = { ...ANALYSE_VALIDE, shots: [{ start: 10, end: 5 }] }
    expect(SCHÉMA_ANALYSE.safeParse(retourné).success).toBe(false)

    const vide = { ...ANALYSE_VALIDE, shots: [{ start: 4, end: 4 }] }
    expect(SCHÉMA_ANALYSE.safeParse(vide).success).toBe(false)

    const avantLeDébut = { ...ANALYSE_VALIDE, shots: [{ start: -1, end: 5 }] }
    expect(SCHÉMA_ANALYSE.safeParse(avantLeDébut).success).toBe(false)
  })

  /**
   * Même piège d'un cran plus bas : deux fractions parfaitement dans [0, 1]
   * peuvent décrire une boîte d'aire nulle. Le percentile 90 du cadrage la
   * compterait comme une personne de largeur nulle et refermerait le crop
   * d'autant.
   */
  it('refuse une boîte d’aire nulle ou retournée', () => {
    const plate = {
      ...ANALYSE_VALIDE,
      boxes: [{ t: 1, x0: 0.4, x1: 0.4, y0: 0.1, y1: 0.9, score: 0.9 }],
    }
    expect(SCHÉMA_ANALYSE.safeParse(plate).success).toBe(false)

    const retournée = {
      ...ANALYSE_VALIDE,
      boxes: [{ t: 1, x0: 0.6, x1: 0.2, y0: 0.1, y1: 0.9, score: 0.9 }],
    }
    expect(SCHÉMA_ANALYSE.safeParse(retournée).success).toBe(false)

    const avantLeDébut = {
      ...ANALYSE_VALIDE,
      boxes: [{ t: -0.5, x0: 0.2, x1: 0.6, y0: 0.1, y1: 0.9, score: 0.9 }],
    }
    expect(SCHÉMA_ANALYSE.safeParse(avantLeDébut).success).toBe(false)
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
    const chevauchement = {
      ...ANALYSE_VALIDE,
      shots: [
        { start: 0, end: 15 },
        { start: 10, end: 20 },
      ],
    }
    expect(SCHÉMA_ANALYSE.safeParse(chevauchement).success).toBe(false)

    const désordre = {
      ...ANALYSE_VALIDE,
      shots: [
        { start: 30, end: 40 },
        { start: 0, end: 10 },
      ],
    }
    expect(SCHÉMA_ANALYSE.safeParse(désordre).success).toBe(false)

    // Le message nomme la conséquence, pas la règle : « plans non triés »
    // laisserait chercher pourquoi ça compte.
    const échec = SCHÉMA_ANALYSE.safeParse(chevauchement)
    expect(échec.success ? '' : échec.error.issues[0]?.message).toMatch(/deux fois/)
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
    const trou = {
      ...ANALYSE_VALIDE,
      shots: [
        { start: 0, end: 10 },
        { start: 25, end: 40 },
      ],
    }
    expect(SCHÉMA_ANALYSE.safeParse(trou).success).toBe(false)

    const départTardif = { ...ANALYSE_VALIDE, shots: [{ start: 4, end: 40 }] }
    expect(SCHÉMA_ANALYSE.safeParse(départTardif).success).toBe(false)

    const échec = SCHÉMA_ANALYSE.safeParse(trou)
    expect(échec.success ? '' : échec.error.issues[0]?.message).toMatch(/disparaître/)
  })

  /**
   * La tolérance vaut la granularité de `detect.py`, qui arrondit ses bornes à
   * la milliseconde : un écart d'un millième est un artefact d'arrondi, pas un
   * trou. Un vrai trou se compte en secondes.
   */
  it('tolère l’arrondi à la milliseconde, pas plus', () => {
    const arrondi = {
      ...ANALYSE_VALIDE,
      shots: [
        { start: 0, end: 12.4 },
        { start: 12.401, end: 30 },
      ],
    }
    expect(SCHÉMA_ANALYSE.safeParse(arrondi).success).toBe(true)

    const centième = {
      ...ANALYSE_VALIDE,
      shots: [
        { start: 0, end: 12.4 },
        { start: 12.41, end: 30 },
      ],
    }
    expect(SCHÉMA_ANALYSE.safeParse(centième).success).toBe(false)
  })

  it('accepte des plans qui se touchent, ce que detect.py produit', () => {
    // `plans()` découpe `[0, durée]` à des frontières successives : la fin de
    // l'un **est** le début du suivant. Interdire ça condamnerait toute analyse.
    const collés = {
      ...ANALYSE_VALIDE,
      shots: [
        { start: 0, end: 12.4 },
        { start: 12.4, end: 30 },
        { start: 30, end: 91.2 },
      ],
    }
    expect(SCHÉMA_ANALYSE.safeParse(collés).success).toBe(true)
  })

  it('accepte les deux versions écrites par ce dépôt', () => {
    // La 2 porte les points de pose et le nom des poids ; la 1 est ce que le
    // détecteur écrivait avant le 19 août 2026, et les fichiers déjà sur le
    // disque doivent continuer de se relire sans qu'on relance le GPU.
    for (const version of ANALYSIS_VERSIONS) {
      expect(SCHÉMA_ANALYSE.safeParse({ ...ANALYSE_VALIDE, version }).success).toBe(true)
    }
  })

  it('refuse une version inconnue', () => {
    expect(SCHÉMA_ANALYSE.safeParse({ ...ANALYSE_VALIDE, version: 3 }).success).toBe(false)
    expect(SCHÉMA_ANALYSE.safeParse({ ...ANALYSE_VALIDE, version: 0 }).success).toBe(false)
  })

  it('accepte dix-sept points de pose, et refuse un squelette tronqué', () => {
    // **La longueur est la seule chose qui distingue un squelette d'un tableau
    // de nombres.** Trop court, il se lit sans erreur : `k[3 * i]` rend
    // `undefined`, le tronc en sort vide, et le cadrage retombe sur la boîte
    // corps entier — c'est-à-dire sur le comportement d'avant, sous une
    // étiquette qui affirme le contraire.
    const complete = Array.from({ length: 51 }, (_, i) => (i % 3 === 2 ? 0.9 : 0.5))
    const withKeypoints = {
      ...ANALYSE_VALIDE,
      version: 2 as const,
      keypoints: 'coco17' as const,
      boxes: [{ ...ANALYSE_VALIDE.boxes[0], k: complete }],
    }
    expect(SCHÉMA_ANALYSE.safeParse(withKeypoints).success).toBe(true)
    expect(
      SCHÉMA_ANALYSE.safeParse({
        ...withKeypoints,
        boxes: [{ ...ANALYSE_VALIDE.boxes[0], k: complete.slice(0, 48) }],
      }).success,
    ).toBe(false)
  })

  it('laisse un point de pose sortir du cadre, contrairement à une boîte', () => {
    // Une épaule que le bord de l'image coupe est une information ; une boîte
    // hors cadre ne désigne plus rien. Seule la confiance est bornée.
    const outside = Array.from({ length: 51 }, (_, i) => (i % 3 === 2 ? 0.9 : -0.2))
    expect(
      SCHÉMA_ANALYSE.safeParse({
        ...ANALYSE_VALIDE,
        version: 2 as const,
        boxes: [{ ...ANALYSE_VALIDE.boxes[0], k: outside }],
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
      SCHÉMA_ANALYSE.safeParse({
        ...ANALYSE_VALIDE,
        version: 2 as const,
        boxes: [{ ...ANALYSE_VALIDE.boxes[0], k: points }],
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
    const nul = { ...ANALYSE_VALIDE, proxy: { w: 0, h: 540 } }
    expect(SCHÉMA_ANALYSE.safeParse(nul).success).toBe(false)
  })
})

describe('formatTaille', () => {
  it('écrit ce que detect.py analyse', () => {
    expect(formatTaille(960, 540)).toBe('960x540')
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
    const env = environnementDétection({
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
    const env = environnementDétection({ HOME: '/home/julien', CUDA_VISIBLE_DEVICES: '0' })
    expect(env.HOME).toBe('/home/julien')
    expect(env.CUDA_VISIBLE_DEVICES).toBe('0')
  })

  it('n’invente pas une variable absente', () => {
    expect('TMPDIR' in environnementDétection({ PATH: '/usr/bin' })).toBe(false)
  })
})

describe('lireAnalyse', () => {
  let racine: string

  beforeEach(() => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-analysis-'))
  })

  afterEach(() => {
    fs.rmSync(racine, { recursive: true, force: true })
  })

  it('rend l’analyse validée', () => {
    const fichier = path.join(racine, 'analysis.json')
    fs.writeFileSync(fichier, JSON.stringify(ANALYSE_VALIDE))
    expect(lireAnalyse(fichier).shots).toEqual([{ start: 0, end: 12.4 }])
  })

  /**
   * Le message nomme les champs fautifs. Sans eux, « analysis.json ne suit pas
   * le contrat » envoie ouvrir un fichier d'un mégaoctet à la main.
   */
  it('nomme ce qui cloche plutôt que d’échouer en bloc', () => {
    const fichier = path.join(racine, 'analysis.json')
    fs.writeFileSync(fichier, JSON.stringify({ ...ANALYSE_VALIDE, fps: 0 }))
    expect(() => lireAnalyse(fichier)).toThrow(/fps/)
  })

  it('lève sur un JSON tronqué', () => {
    const fichier = path.join(racine, 'analysis.json')
    fs.writeFileSync(fichier, '{"version": 1, "shots": [')
    expect(() => lireAnalyse(fichier)).toThrow()
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
function monterFauxWorker(racine: string, charge: string): void {
  fs.writeFileSync(path.join(racine, 'projects', 'projet', 'proxy.mp4'), '')

  const ffprobe = path.join(racine, 'ffprobe-ok')
  fs.writeFileSync(
    ffprobe,
    '#!/bin/sh\necho \'{"streams":[{"width":960,"height":540,"r_frame_rate":"30/1"}],' +
      '"format":{"duration":"10"}}\'\n',
    { mode: 0o755 },
  )

  const chargeFichier = path.join(racine, 'charge-du-worker')
  fs.writeFileSync(chargeFichier, charge)
  const python = path.join(racine, 'faux-detect')
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
      `cat ${JSON.stringify(chargeFichier)} > "$out"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  // Le script et les poids ne sont pas ouverts par ce faux worker : seul leur
  // existence est contrôlée, en amont, par `runAnalysis`.
  for (const [nom, variable] of [
    ['detect.py', 'DETECT_WORKER'],
    ['yolo11m.pt', 'DETECT_MODEL'],
  ] as const) {
    const chemin = path.join(racine, nom)
    fs.writeFileSync(chemin, '')
    process.env[variable] = chemin
  }
  process.env.FFPROBE_BIN = ffprobe
  process.env.DETECT_PYTHON = python
}

describe('runAnalysis', () => {
  let racine: string
  const envDépart = { ...process.env }

  beforeEach(() => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-analysis-run-'))
    process.env.PROJECTS_DIR = path.join(racine, 'projects')
    fs.mkdirSync(path.join(racine, 'projects', 'projet'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(racine, { recursive: true, force: true })
    process.env = { ...envDépart }
  })

  it('ne refait rien si analysis.json est déjà là', async () => {
    const attendu = path.join(racine, 'projects', 'projet', 'analysis.json')
    fs.writeFileSync(attendu, JSON.stringify(ANALYSE_VALIDE))

    // Ni proxy ni venv sur le disque : si l'étape allait plus loin que le
    // saut, elle échouerait avant d'atteindre le premier sous-processus.
    const artefact = await runAnalysis({ projectId: 'projet', source: '/absent.mp4' })
    expect(artefact).toEqual({ path: attendu, skipped: true })
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
    fs.writeFileSync(path.join(racine, 'projects', 'projet', 'proxy.mp4'), '')
    process.env.DETECT_PYTHON = path.join(racine, 'pas-de-venv', 'bin', 'python')

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
    fs.writeFileSync(path.join(racine, 'projects', 'projet', 'proxy.mp4'), '')
    process.env.DETECT_PYTHON = '/home/quelquun/dev/avolo-shorts/worker/venv/bin/python'

    const erreur = await runAnalysis({ projectId: 'projet', source: '/absent.mp4' }).catch(
      (cause: unknown) => cause,
    )
    const publié = messageSûr(erreur)
    expect(publié).not.toContain('quelquun')
    expect(publié).toContain('…/python')
    // Le remède survit à l'épuration : c'est lui qui dit quoi faire.
    expect(publié).toContain('setup.sh')
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
    fs.writeFileSync(path.join(racine, 'projects', 'projet', 'proxy.mp4'), '')
    const faux = path.join(racine, 'ffprobe-largeur-nulle')
    fs.writeFileSync(
      faux,
      '#!/bin/sh\necho \'{"streams":[{"width":0,"height":540,"r_frame_rate":"30/1"}],' +
        '"format":{"duration":"10"}}\'\n',
      { mode: 0o755 },
    )
    process.env.FFPROBE_BIN = faux
    // Le venv et les poids doivent exister pour que l'étape aille jusqu'au
    // sondage : ce sont les contrôles d'avant.
    for (const nom of ['python', 'detect.py', 'yolo11m.pt']) {
      const chemin = path.join(racine, nom)
      fs.writeFileSync(chemin, '')
      process.env[
        { python: 'DETECT_PYTHON', 'detect.py': 'DETECT_WORKER', 'yolo11m.pt': 'DETECT_MODEL' }[
          nom
        ] as string
      ] = chemin
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
    fs.writeFileSync(path.join(racine, 'projects', 'projet', 'proxy.mp4'), '')
    // Un `ffprobe` qui ne rend jamais la main : c'est le montage 9p au transport
    // mort, en pire — ici même le délai de garde de deux minutes ne sauve pas
    // l'appelant, seul le signal le fait.
    const faux = path.join(racine, 'ffprobe-qui-pend')
    fs.writeFileSync(faux, '#!/bin/sh\nsleep 300\n', { mode: 0o755 })
    process.env.FFPROBE_BIN = faux
    for (const nom of ['python', 'detect.py', 'yolo11m.pt']) {
      const chemin = path.join(racine, nom)
      fs.writeFileSync(chemin, '')
      process.env[
        { python: 'DETECT_PYTHON', 'detect.py': 'DETECT_WORKER', 'yolo11m.pt': 'DETECT_MODEL' }[
          nom
        ] as string
      ] = chemin
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
    const commande =
      "L'analyse a échoué (code de sortie 3).\n" +
      `Commande : ${commandeLisible('/home/quelquun/dev/avolo-shorts/worker/venv/bin/python', [
        '-u',
        '/home/quelquun/dev/avolo-shorts/worker/detect.py',
        '--model',
        '/home/quelquun/dev/avolo-shorts/worker/models/yolo11m.pt',
      ])}`
    const publié = messageSûr(new Error(commande))
    expect(publié).not.toContain('quelquun')
    expect(publié).toContain('…/detect.py')
    expect(publié).toContain('…/yolo11m.pt')
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
    const commande = `Commande : ${commandeLisible(python, ['-u', '--model', '/x/y.pt'])}`
    expect(messageSûr(new Error(commande))).not.toContain('Mon dossier')

    // Et la forme que Node écrit tout seul, sans guillemets, sur un spawn en
    // échec : celle-là ne se cite pas. `racines()` la couvre quand
    // `DETECT_PYTHON` est posée…
    process.env.DETECT_PYTHON = python
    expect(messageSûr(new Error(`spawn ${python} ENOENT`))).not.toContain('Mon dossier')
  })

  /**
   * …et quand elle ne l'est pas, `racines()` ne connaît rien du venv, puisque le
   * chemin vient alors de `process.cwd()`. C'est pour ce cas-là que le message
   * de démarrage ne reprend **que le code** de l'erreur : le chemin y est déjà,
   * entre guillemets, donc épurable. (relevé par Copilot)
   */
  it('ne remonte que le code d’erreur quand le worker ne démarre pas', async () => {
    const dossier = path.join(racine, 'Mon dossier')
    fs.mkdirSync(dossier, { recursive: true })
    fs.writeFileSync(path.join(racine, 'projects', 'projet', 'proxy.mp4'), '')

    // Un interpréteur qui existe mais n'est pas exécutable : `spawn` échoue à
    // l'exécution, pas au contrôle de présence de l'étape.
    const python = path.join(dossier, 'python')
    fs.writeFileSync(python, '', { mode: 0o644 })
    const script = path.join(dossier, 'detect.py')
    fs.writeFileSync(script, '')
    const modèle = path.join(dossier, 'yolo11m.pt')
    fs.writeFileSync(modèle, '')
    const faux = path.join(racine, 'ffprobe-ok')
    fs.writeFileSync(
      faux,
      '#!/bin/sh\necho \'{"streams":[{"width":960,"height":540,"r_frame_rate":"30/1"}],' +
        '"format":{"duration":"10"}}\'\n',
      { mode: 0o755 },
    )
    process.env.FFPROBE_BIN = faux
    process.env.DETECT_PYTHON = python
    process.env.DETECT_WORKER = script
    process.env.DETECT_MODEL = modèle
    const erreur = await runAnalysis({ projectId: 'projet', source: '/absent.mp4' }).catch(
      (cause: unknown) => cause,
    )
    expect(erreur).toBeInstanceOf(Error)
    expect((erreur as Error).message).toMatch(/EACCES|ENOENT/)
    // Le message composé ne reprend pas la phrase de Node, donc pas son chemin nu.
    expect((erreur as Error).message).not.toContain(`spawn ${python}`)
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
    monterFauxWorker(racine, JSON.stringify({ ...ANALYSE_VALIDE, shots: [] }))

    await expect(runAnalysis({ projectId: 'projet', source: '/absent.mp4' })).rejects.toThrow(
      /contrat de l'itération 1/,
    )

    const projet = path.join(racine, 'projects', 'projet')
    expect(fs.existsSync(path.join(projet, 'analysis.json'))).toBe(false)
    // Et le temporaire ne survit pas non plus : un `.partiel-…` oublié à chaque
    // échec finirait par remplir le dossier du projet.
    expect(fs.readdirSync(projet).filter((n) => n.includes('.partiel-'))).toEqual([])
  })

  /**
   * L'autre moitié du même chemin d'erreur, et celle que la tête du fichier
   * nomme : « un processus tué à la quatrième minute laisserait un JSON tronqué
   * sous le nom définitif ». Un fichier tronqué s'arrête à `JSON.parse`, pas au
   * schéma — donc à une autre ligne, dans une autre exception, sous le même
   * `try`.
   */
  it('ne range pas non plus un JSON tronqué', async () => {
    monterFauxWorker(racine, '{"version": 1, "shots": [')

    await expect(runAnalysis({ projectId: 'projet', source: '/absent.mp4' })).rejects.toThrow()

    const projet = path.join(racine, 'projects', 'projet')
    expect(fs.existsSync(path.join(projet, 'analysis.json'))).toBe(false)
    expect(fs.readdirSync(projet).filter((n) => n.includes('.partiel-'))).toEqual([])
  })

  /**
   * Le pendant, et il n'est pas décoratif : sans lui, un `runAnalysis` qui ne
   * rangerait **jamais** rien passerait le test ci-dessus les yeux fermés.
   */
  it('range analysis.json une fois seulement, quand il est valide', async () => {
    monterFauxWorker(racine, JSON.stringify(ANALYSE_VALIDE))

    const projet = path.join(racine, 'projects', 'projet')
    const artefact = await runAnalysis({ projectId: 'projet', source: '/absent.mp4' })

    expect(artefact).toEqual({ path: path.join(projet, 'analysis.json'), skipped: false })
    expect(lireAnalyse(artefact.path).shots).toEqual([{ start: 0, end: 12.4 }])
    expect(fs.readdirSync(projet).filter((n) => n.includes('.partiel-'))).toEqual([])
  })
})
