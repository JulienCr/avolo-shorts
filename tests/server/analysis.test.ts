import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  environnementDétection,
  formatTaille,
  lireAnalyse,
  runAnalysis,
  SCHÉMA_ANALYSE,
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

  it('refuse une version inconnue', () => {
    expect(SCHÉMA_ANALYSE.safeParse({ ...ANALYSE_VALIDE, version: 2 }).success).toBe(false)
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
})
