import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Clip } from '@/core/edl'
import { openDb, upsertProject, putClip, getClip } from '@/server/db'
import {
  cheminsRendu,
  collecterMarques,
  motsDièse,
  planifierMarques,
  renderClip,
  sauterLeRendu,
  texteDePublication,
  type MarqueNative,
} from '@/server/steps/render'

/**
 * Ce que le rendu a de testable sans GPU, sans ffmpeg et sans vidéo : le choix
 * des sorties selon le ratio, la décision de saut, le nom des fichiers, la
 * doctrine de placement des marques, et le texte de publication.
 *
 * **Ce qui ne s'y teste pas, et c'est normal** : que les sous-titres suivent la
 * parole après une coupe interne. Cela ne se voit qu'à l'œil, sur un vrai rendu,
 * et c'est la vérification manuelle de la tâche 14.
 */

const SOURCE = '2025-06-15-cqlp.mp4'
const ID = '2025-06-15-cqlp'

let racine: string
let replay: string
let stage: string
let projets: string
const envDépart = { ...process.env }

beforeEach(() => {
  racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-render-'))
  replay = path.join(racine, 'Replay')
  stage = path.join(racine, 'stage')
  projets = path.join(racine, 'projects')
  for (const d of [replay, stage, projets]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(replay, SOURCE), 'pas vraiment une vidéo')

  process.env.REPLAY_DIR = replay
  process.env.STAGE_DIR = stage
  process.env.PROJECTS_DIR = projets
})

afterEach(() => {
  fs.rmSync(racine, { recursive: true, force: true })
  process.env = { ...envDépart }
})

function clip(surcharges: Partial<Clip> = {}): Clip {
  return {
    id: 'clip_0001',
    projectId: ID,
    segments: [
      { start: 100, end: 115.7 },
      { start: 130, end: 140 },
      { start: 200, end: 212 },
    ],
    ratio: '1:1',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'Une vanne qui tient',
    description: 'La chute arrive au bon moment. #impro #avolo',
    status: 'kept',
    pass: 1,
    ...surcharges,
  }
}

describe('cheminsRendu', () => {
  it('nomme les sorties depuis le dossier de rendus du projet', () => {
    const c = cheminsRendu(ID, 'clip_0001', '1:1')
    expect(c.mp4).toBe(path.join(projets, ID, 'renders', 'clip_0001.mp4'))
    expect(c.variant9x16).toBe(path.join(projets, ID, 'renders', 'clip_0001-9x16.mp4'))
    expect(c.texts).toBe(path.join(projets, ID, 'renders', 'clip_0001.txt'))
    expect(c.ass).toBe(path.join(projets, ID, 'renders', 'clip_0001.ass'))
  })

  it("ne demande pas de variante quand le clip est déjà en 9:16", () => {
    expect(cheminsRendu(ID, 'clip_0001', '9:16').variant9x16).toBeNull()
  })

  it('en demande une pour chacun des trois autres ratios (spec §11)', () => {
    for (const ratio of ['4:5', '1:1', '16:9'] as const) {
      expect(cheminsRendu(ID, 'clip_0001', ratio).variant9x16).not.toBeNull()
    }
  })
})

describe('sauterLeRendu', () => {
  const chemins = cheminsRendu.bind(null, ID, 'clip_0001')

  it('saute quand les trois sorties sont là', () => {
    const c = chemins('1:1')
    expect(sauterLeRendu(c, () => true)).toBe(true)
  })

  it("ne saute pas quand il manque le .txt, même si le MP4 est là", () => {
    const c = chemins('1:1')
    expect(sauterLeRendu(c, (chemin) => chemin !== c.texts)).toBe(false)
  })

  it('ne saute pas quand il manque la variante', () => {
    const c = chemins('1:1')
    expect(sauterLeRendu(c, (chemin) => chemin !== c.variant9x16)).toBe(false)
  })

  it("n'attend pas de variante en 9:16", () => {
    const c = chemins('9:16')
    // Rien d'autre que le MP4 et le texte n'existe : la variante n'est pas due.
    expect(sauterLeRendu(c, (chemin) => chemin === c.mp4 || chemin === c.texts)).toBe(true)
  })

  it('ne saute jamais sous `force`', () => {
    expect(sauterLeRendu(chemins('1:1'), () => true, true)).toBe(false)
  })

  it("ignore le .ass, qui est un intermédiaire et non une sortie", () => {
    const c = chemins('9:16')
    expect(sauterLeRendu(c, (chemin) => chemin !== c.ass)).toBe(true)
  })
})

/**
 * La doctrine de `branding.py:63-70`, reprise comme raisonnement (spec §15).
 * Chacun de ces tests fige une décision qui a coûté une mesure là-bas.
 */
describe('planifierMarques', () => {
  const logo = (nativeW: number, nativeH: number): MarqueNative => ({
    path: '/marques/logo.png',
    nativeW,
    nativeH,
    largeurRatio: 0.22,
    bord: 'gauche',
  })
  const mention = (nativeW: number, nativeH: number): MarqueNative => ({
    path: '/marques/twitch.png',
    nativeW,
    nativeH,
    largeurRatio: 0.16,
    bord: 'droite',
  })

  it('ne pose rien quand le dossier des marques est vide', () => {
    expect(planifierMarques(1080, 1920, [])).toEqual([])
  })

  it("épingle le bord SUPÉRIEUR de la bande à 13 %, pas son centre", () => {
    // Le cas mesuré chez openshorts : un logo 3:1 ancré par son centre à 0,13
    // remettait son bord supérieur à 0,109, soit sous la barre d'onglets de
    // TikTok. Épinglé par le haut, il reste à 0,13 quel que soit son format.
    for (const forme of [logo(3, 1), logo(1, 1), logo(1, 2)]) {
      const [placé] = planifierMarques(1080, 1920, [forme])
      expect(placé.y).toBe(Math.round(1920 * 0.13))
    }
  })

  it('plafonne la hauteur à 6 % par marque, et non par bande', () => {
    // Un logo carré à 22 % de largeur ferait 22 % de la hauteur d'un 1:1. La
    // mention, elle, tient déjà : elle ne doit pas rétrécir avec lui.
    const placés = planifierMarques(1080, 1080, [logo(1, 1), mention(4, 1)])
    const [carré, large] = placés
    expect(carré.h).toBeLessThanOrEqual(1080 * 0.06)
    // La mention garde sa largeur nominale : 16 % de 1080, arrondi au pair.
    expect(large.w).toBe(172)
  })

  it('centre les marques les unes sur les autres sous ce bord supérieur', () => {
    const [carré, large] = planifierMarques(1080, 1920, [logo(1, 1), mention(4, 1)])
    const centre = (m: { y: number; h: number }): number => m.y + m.h / 2
    expect(Math.abs(centre(carré) - centre(large))).toBeLessThanOrEqual(1)
    const plusHaute = carré.h >= large.h ? carré : large
    expect(plusHaute.y).toBe(Math.round(1920 * 0.13))
  })

  it('respecte la marge de 5 % des deux côtés', () => {
    const [gauche, droite] = planifierMarques(1080, 1920, [logo(3, 1), mention(4, 1)])
    const marge = Math.round(1080 * 0.05)
    expect(gauche.x).toBe(marge)
    expect(droite.x + droite.w).toBe(1080 - marge)
  })

  it("ne mord ni sur le haut de l'écran ni sur les sous-titres", () => {
    // Les sous-titres tiennent le bas : `MARGE_BASSE` vaut 43 sur `PlayResY: 288`,
    // donc le bloc de cartons commence vers 59 % de la hauteur. La bande doit
    // rester entre le chrome de la plateforme (12 %) et cette limite, sur les
    // quatre formats de sortie.
    const formats = [
      { w: 1080, h: 1920 },
      { w: 1080, h: 1350 },
      { w: 1080, h: 1080 },
      { w: 1920, h: 1080 },
    ]
    for (const { w, h } of formats) {
      for (const marques of [[logo(3, 1), mention(4, 1)], [logo(1, 1)], [mention(1, 3)]]) {
        for (const placé of planifierMarques(w, h, marques)) {
          expect(placé.y).toBeGreaterThanOrEqual(h * 0.12)
          expect(placé.y + placé.h).toBeLessThan(h * 0.59)
          expect(placé.x).toBeGreaterThanOrEqual(0)
          expect(placé.x + placé.w).toBeLessThanOrEqual(w)
        }
      }
    }
  })

  it('rend des dimensions paires', () => {
    for (const placé of planifierMarques(1080, 1920, [logo(7, 3), mention(13, 5)])) {
      expect(placé.w % 2).toBe(0)
      expect(placé.h % 2).toBe(0)
    }
  })

  it('remonte une très petite marque au plancher de lisibilité', () => {
    // 22 % de 200 pixels font 44, illisible sur un téléphone. Le plancher est à
    // 80 — sous réserve de tenir entre les marges.
    const [placé] = planifierMarques(200, 356, [logo(4, 1)])
    expect(placé.w).toBe(80)
  })
})

describe('motsDièse', () => {
  it('les extrait dans leur ordre, sans doublon de casse', () => {
    expect(motsDièse('#Impro et #impro, puis #avolo')).toEqual(['#Impro', '#avolo'])
  })

  it('accepte les accents et les chiffres', () => {
    expect(motsDièse('#théâtre #scene2026 #a_b')).toEqual(['#théâtre', '#scene2026', '#a_b'])
  })

  it('rend une liste vide quand il n’y en a pas', () => {
    expect(motsDièse('rien à signaler')).toEqual([])
  })
})

describe('texteDePublication', () => {
  it('porte les trois sections, dans l’ordre où on les colle', () => {
    const texte = texteDePublication(clip())
    expect(texte).toContain('Titre : Une vanne qui tient')
    expect(texte).toContain('La chute arrive au bon moment. #impro #avolo')
    expect(texte).toContain('Mots-dièse : #impro #avolo')
  })

  it('laisse les mots-dièse dans la description, qui se colle telle quelle', () => {
    const lignes = texteDePublication(clip()).split('\n')
    expect(lignes[lignes.indexOf('Description :') + 1]).toContain('#impro')
  })

  it('reste lisible sur un clip sans titre ni description', () => {
    const texte = texteDePublication(clip({ title: '  ', description: '' }))
    expect(texte).toContain('Titre : (sans titre)')
    expect(texte).toContain('(sans description)')
    expect(texte).toContain('Mots-dièse : (aucun)')
  })
})

describe('collecterMarques', () => {
  it("rend une liste vide sur un dossier absent — on rend sans marque", async () => {
    await expect(collecterMarques(path.join(racine, 'nulle-part'))).resolves.toEqual([])
  })

  it('rend une liste vide sur un dossier vide', async () => {
    const vide = path.join(racine, 'brand')
    fs.mkdirSync(vide)
    await expect(collecterMarques(vide)).resolves.toEqual([])
  })
})

/**
 * L'enchaînement lui-même, par le seul chemin qui ne demande ni ffmpeg ni
 * vidéo : celui du saut. Il traverse pourtant tout ce qui décide — lecture du
 * clip et du projet, résolution du ratio, nom des fichiers, décision de saut.
 */
describe('renderClip, chemin du saut', () => {
  function préparer(surcharges: Partial<Clip> = {}): {
    db: ReturnType<typeof openDb>
    c: Clip
  } {
    const db = openDb(':memory:')
    upsertProject(db, {
      id: ID,
      sourcePath: path.join(replay, SOURCE),
      stagedPath: path.join(stage, SOURCE),
      durationSec: 5936,
      sizeBytes: 1,
      mtimeMs: 1,
      createdAt: 1,
    })
    const c = clip(surcharges)
    putClip(db, c)
    return { db, c }
  }

  function poser(chemins: string[]): void {
    for (const chemin of chemins) {
      fs.mkdirSync(path.dirname(chemin), { recursive: true })
      fs.writeFileSync(chemin, '')
    }
  }

  it('rend les trois chemins et saute quand tout est là', async () => {
    const { db, c } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    poser([attendus.mp4, attendus.variant9x16 as string, attendus.texts])

    const résultat = await renderClip(c.id, { db })
    expect(résultat).toEqual({
      mp4: attendus.mp4,
      variant9x16: attendus.variant9x16,
      texts: attendus.texts,
      skipped: true,
    })
  })

  it("rabat 'auto' sur 9:16, donc sans variante (itération 0)", async () => {
    const { db, c } = préparer({ ratio: 'auto' })
    const attendus = cheminsRendu(ID, c.id, '9:16')
    poser([attendus.mp4, attendus.texts])

    const résultat = await renderClip(c.id, { db })
    expect(résultat.skipped).toBe(true)
    expect(résultat.variant9x16).toBeNull()
  })

  it("ne touche pas au statut du clip quand il saute", async () => {
    const { db, c } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    poser([attendus.mp4, attendus.variant9x16 as string, attendus.texts])

    await renderClip(c.id, { db })
    expect(getClip(db, c.id)?.status).toBe('kept')
  })

  it('refuse un clip inconnu', async () => {
    const { db } = préparer()
    await expect(renderClip('clip_inexistant', { db })).rejects.toThrow(/Clip inconnu/)
  })

  it("refuse un clip sans segment, plutôt que de rendre un fichier vide", async () => {
    const { db, c } = préparer({ segments: [] })
    await expect(renderClip(c.id, { db })).rejects.toThrow(/aucun segment/)
  })

  it("dit quoi faire quand la copie de travail a disparu", async () => {
    const { db, c } = préparer()
    // Rien dans `stage/` : `stagedPath` est transitoire par contrat.
    await expect(renderClip(c.id, { db })).rejects.toThrow(/copie de travail/)
  })
})
