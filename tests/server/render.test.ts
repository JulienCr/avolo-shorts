import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CAPTION_STYLE } from '@/core/captions/ass'
import type { Clip } from '@/core/edl'
import { épurerChemins } from '@/core/erreurs'
import type { Word } from '@/core/transcript'
import { openDb, upsertProject, putClip, getClip } from '@/server/db'
import {
  cheminsRendu,
  collecterMarques,
  écarterRenduPérimé,
  leRenduEstPérimé,
  marquerExporté,
  motsDièse,
  planifierMarques,
  refaireLesSorties,
  refuserFauteDeMarque,
  renderClip,
  sauterLeRendu,
  sousTitresDuClip,
  texteDePublication,
  type MarqueNative,
} from '@/server/steps/render'

/**
 * Ce que le rendu a de testable sans GPU, sans ffmpeg et sans vidéo : le choix
 * des sorties selon le ratio, la décision de saut, le nom des fichiers, la
 * doctrine de placement des marques, et le texte de publication.
 *
 * **Le recalage après une coupe interne s'y teste**, et c'est le point le plus
 * important du fichier : `sousTitresDuClip` plus bas vérifie sur deux segments
 * distants que le premier mot du second tombe à la durée du premier, et pas à son
 * heure dans l'émission.
 *
 * **Ce qui ne s'y teste pas, et c'est normal** : que libass incruste bien ce
 * document sur l'image, au bon endroit et à la bonne heure. Cela ne se voit qu'à
 * l'œil, sur un vrai rendu, et c'est la vérification manuelle de la tâche 14.
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

  it("refuse un identifiant de clip qui sortirait du dossier du projet", () => {
    // `clipId` arrive du réseau : `POST /api/clips/:id/export` le prend dans
    // l'URL, et `putClip` ne valide ni son format ni son contenu.
    for (const mauvais of ['../evade', 'a/b', 'a\\b', '', '.', '..', 'a\0b']) {
      expect(() => cheminsRendu(ID, mauvais, '1:1')).toThrow(/Identifiant de clip invalide/)
    }
  })

  it('accepte les accents et les espaces, comme les noms de replays', () => {
    expect(() => cheminsRendu(ID, 'clip été 01', '1:1')).not.toThrow()
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
 * L'autre décision de `renderClip`, et la seule que `sauterLeRendu` ne prend pas :
 * une fois qu'il faut faire quelque chose, faut-il rallumer ffmpeg, et sur quoi.
 *
 * **C'est ici que se teste le corollaire du correctif de #22.** La variante ne
 * dérive plus du MP4 natif, donc refaire l'une sans l'autre les tirerait de deux
 * instantanés du clip différents, et rien en aval ne le verrait. Ces cas-là
 * n'atteignent jamais ffmpeg, qui n'existe ni en CI ni dans ce fichier : les
 * isoler en fonction pure est ce qui les rend vérifiables.
 * (relevé par Codex et Copilot)
 */
describe('refaireLesSorties', () => {
  const chemins = cheminsRendu.bind(null, ID, 'clip_0001')

  it('ne rallume pas ffmpeg quand les deux MP4 sont là', () => {
    expect(refaireLesSorties(chemins('1:1'), () => true)).toBe(false)
  })

  it("laisse le .txt seul se réécrire, sans réencoder une image", () => {
    const c = chemins('1:1')
    expect(refaireLesSorties(c, (chemin) => chemin !== c.texts)).toBe(false)
  })

  it('refait le natif quand seule la variante manque', () => {
    // Le cas qui compte : le natif est là, mais il porte peut-être le montage
    // d'un passage précédent. Le garder pendant qu'on rend la variante depuis
    // l'instantané d'aujourd'hui livrerait deux fichiers montrant deux cadres.
    const c = chemins('1:1')
    expect(refaireLesSorties(c, (chemin) => chemin !== c.variant9x16)).toBe(true)
  })

  it('refait la variante quand seul le natif manque', () => {
    const c = chemins('1:1')
    expect(refaireLesSorties(c, (chemin) => chemin !== c.mp4)).toBe(true)
  })

  it("n'attend pas de variante en 9:16", () => {
    const c = chemins('9:16')
    expect(refaireLesSorties(c, (chemin) => chemin === c.mp4)).toBe(false)
  })

  it('réencode toujours sous `force`', () => {
    expect(refaireLesSorties(chemins('1:1'), () => true, true)).toBe(true)
  })

  it("ignore le .ass, qui se réécrit à chaque passage", () => {
    const c = chemins('1:1')
    expect(refaireLesSorties(c, (chemin) => chemin !== c.ass)).toBe(false)
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

/**
 * L'enchaînement des sous-titres, qui est **le seul endroit de cette étape où
 * l'on peut se tromper sans rien casser de mesurable**. `retimeWords` est testé
 * pour lui-même ailleurs ; ce qui se teste ici, c'est qu'il soit bien appelé, et
 * que le preset traverse jusqu'au découpage.
 */
describe('sousTitresDuClip', () => {
  const mots: Word[] = [
    { word: 'un', start: 10.0, end: 10.4 },
    { word: 'deux', start: 10.5, end: 11.0 },
    // Dans la coupe interne : ce mot ne doit apparaître nulle part.
    { word: 'coupé', start: 50.0, end: 50.5 },
    { word: 'trois', start: 100.0, end: 100.4 },
    { word: 'quatre', start: 100.5, end: 101.0 },
  ]
  const segments = [
    { start: 10, end: 15 },
    { start: 100, end: 105 },
  ]

  it('recale les mots sur la timeline du clip, pas sur celle de la source', () => {
    const ass = sousTitresDuClip(mots, segments, DEFAULT_CAPTION_STYLE)
    expect(ass).not.toBeNull()
    // Le premier segment dure 5 s, donc le premier mot du second segment tombe à
    // 5,00 s dans le clip — et surtout pas à 1:40, son heure dans l'émission.
    expect(ass).toContain('0:00:05.00')
    expect(ass).not.toContain('0:01:40')
    // Le premier mot du clip est à l'origine.
    expect(ass).toContain('Dialogue: 0,0:00:00.00')
  })

  it('laisse tomber les mots pris dans une coupe interne', () => {
    expect(sousTitresDuClip(mots, segments, DEFAULT_CAPTION_STYLE)).not.toContain('COUPÉ')
  })

  it('passe maxChars et maxDuration du preset au découpage', () => {
    // `renderAss` ne lit pas ces deux réglages : si l'enchaînement ne les
    // transmet pas lui-même à `splitIntoCards`, un preset personnalisé garde le
    // découpage par défaut, en silence.
    const serré = { ...DEFAULT_CAPTION_STYLE, maxChars: 3 }
    const large = { ...DEFAULT_CAPTION_STYLE, maxChars: 200, maxDuration: 60 }
    // Un carton donne un événement par mot, tous porteurs du même texte à la
    // surbrillance près : compter les textes distincts compte les cartons.
    const cartons = (ass: string | null): number =>
      new Set(
        (ass ?? '')
          .split('\n')
          .filter((l) => l.startsWith('Dialogue:'))
          .map((l) => l.slice(l.lastIndexOf(',,') + 2).replace(/\{[^}]*\}/g, '')),
      ).size
    expect(cartons(sousTitresDuClip(mots, segments, serré))).toBeGreaterThan(
      cartons(sousTitresDuClip(mots, segments, large)),
    )
  })

  it("rend null quand aucun mot ne tombe dans les segments", () => {
    expect(sousTitresDuClip(mots, [{ start: 500, end: 510 }], DEFAULT_CAPTION_STYLE)).toBeNull()
  })
})

describe('leRenduEstPérimé', () => {
  it('est faux quand rien de ce qui va à l’image n’a bougé', () => {
    expect(leRenduEstPérimé(clip(), clip())).toBe(false)
  })

  it("ignore le titre et la description, qui ne vont que dans le .txt", () => {
    expect(leRenduEstPérimé(clip(), clip({ title: 'Autre', description: 'Autre' }))).toBe(false)
  })

  it("ignore le statut et le numéro de passe", () => {
    expect(leRenduEstPérimé(clip(), clip({ status: 'exported', pass: 9 }))).toBe(false)
  })

  it('voit chacun des cinq champs qui vont à l’image', () => {
    const cas: Partial<Clip>[] = [
      { segments: [{ start: 0, end: 5 }] },
      { ratio: '4:5' },
      { cropX: 0.2 },
      { captions: false },
      { branding: false },
    ]
    for (const surcharge of cas) {
      expect(leRenduEstPérimé(clip(), clip(surcharge))).toBe(true)
    }
  })

  it('voit un segment déplacé, à nombre de segments égal', () => {
    const bougé = clip().segments.map((s, i) => (i === 1 ? { start: s.start, end: s.end + 1 } : s))
    expect(leRenduEstPérimé(clip(), clip({ segments: bougé }))).toBe(true)
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
 * La porte des marques, ouverte par #37 : `collecterMarques` rend une liste vide
 * sur un dossier vide, et le rendu partait alors sans un mot. Ce qui suit fige la
 * règle qui remplace ce silence — **le clip demande, le dossier répond, et
 * l'export refuse quand la réponse est vide**.
 *
 * `refuserFauteDeMarque` est pur, et c'est ce qui rend testable le cas limite qui
 * compte : une marque sur deux. Il ne s'atteint pas par `collecterMarques`, qui a
 * besoin de ffprobe sur un vrai PNG — ni la CI ni ce fichier n'en ont.
 */
describe('refuserFauteDeMarque', () => {
  const marque = (fichier: string): MarqueNative => ({
    path: `/marques/${fichier}`,
    nativeW: 1000,
    nativeH: 250,
    largeurRatio: 0.22,
    bord: 'gauche',
  })

  it("refuse quand le clip demande des marques et qu'il n'y en a aucune", () => {
    expect(refuserFauteDeMarque(true, [])).toBe(true)
  })

  it("laisse passer le clip qui n'en demande pas, dossier vide compris", () => {
    expect(refuserFauteDeMarque(false, [])).toBe(false)
  })

  it("laisse passer quand une seule des deux marques est là", () => {
    // Le cas limite, et le seul qui ne se déduit pas de l'intitulé de l'issue.
    // `assets/brand/README.md` tient qu'un logo sans mention, ou l'inverse, sont
    // deux installations légitimes : rien ne distingue « l'opérateur n'a qu'un
    // logo » de « twitch.png a disparu ». Refuser là interdirait une
    // configuration soutenue pour rattraper une dégradation indécidable. Zéro,
    // lui, est sans ambiguïté : la marque a été demandée, aucune n'est posée.
    expect(refuserFauteDeMarque(true, [marque('logo.png')])).toBe(false)
    expect(refuserFauteDeMarque(true, [marque('twitch.png')])).toBe(false)
  })

  it('laisse passer quand les deux sont là', () => {
    expect(refuserFauteDeMarque(true, [marque('logo.png'), marque('twitch.png')])).toBe(false)
  })
})

/**
 * La même règle vue depuis l'export, c'est-à-dire depuis l'endroit où elle coûte
 * quelque chose : `POST /api/clips/:id/export` est synchrone et dure de dix
 * secondes à une minute. Le refus doit tomber **avant** l'encodage, et sans
 * publier l'arborescence de la machine.
 */
describe('renderClip, la porte des marques', () => {
  function préparer(surcharges: Partial<Clip> = {}): {
    db: ReturnType<typeof openDb>
    c: Clip
    brandDir: string
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
    // **La copie de travail est là, exprès.** Sans elle, le refus tomberait sur
    // elle et ces tests ne prouveraient rien des marques.
    fs.writeFileSync(path.join(stage, SOURCE), 'pas vraiment une vidéo')
    const c = clip(surcharges)
    putClip(db, c)
    // Jetable et vide, comme un `assets/brand/` fraîchement cloné : le dépôt
    // n'en porte que le README, et la CI encore moins.
    const brandDir = path.join(racine, 'brand-vide')
    fs.mkdirSync(brandDir, { recursive: true })
    return { db, c, brandDir }
  }

  /** Le message du refus, et l'assurance qu'il y en a bien eu un. */
  async function refus(promesse: Promise<unknown>): Promise<string> {
    try {
      await promesse
    } catch (erreur) {
      return erreur instanceof Error ? erreur.message : String(erreur)
    }
    throw new Error("l'export n'a pas refusé")
  }

  it("refuse un clip qui demande des marques quand le dossier n'en porte aucune", async () => {
    const { db, c, brandDir } = préparer()
    await expect(renderClip(c.id, { db, brandDir })).rejects.toThrow(/logo\.png/)
  })

  it("refuse pareillement quand le dossier des marques n'existe pas", async () => {
    // `collecterMarques` ne distingue pas les deux, et il n'y a rien à
    // distinguer : la marque a été demandée, aucune n'est posée. La piste 3 de
    // l'issue butait là — `assets/brand/` est de toute façon toujours présent,
    // son README étant versionné.
    const { db, c } = préparer()
    await expect(
      renderClip(c.id, { db, brandDir: path.join(racine, 'nulle-part') }),
    ).rejects.toThrow(/logo\.png/)
  })

  it('nomme les deux issues : déposer une marque, ou couper le branding', async () => {
    const { db, c, brandDir } = préparer()
    const message = await refus(renderClip(c.id, { db, brandDir }))
    expect(message).toMatch(/assets\/brand\//)
    expect(message).toMatch(/branding/)
  })

  it("refuse avant d'encoder : aucune sortie n'est posée sur le disque", async () => {
    // Ce que l'issue demande noir sur blanc : pas de MP4 muet. Le `.ass` absent
    // dit en plus que le refus précède la lecture du transcript, qui vit sur le
    // Drive en 9p et coûte un aller-retour.
    const { db, c, brandDir } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    await expect(renderClip(c.id, { db, brandDir })).rejects.toThrow(/marques/)
    for (const chemin of [
      attendus.mp4,
      attendus.variant9x16 as string,
      attendus.texts,
      attendus.ass,
    ]) {
      expect(fs.existsSync(chemin)).toBe(false)
    }
  })

  it('ne publie aucun chemin absolu dans son refus', async () => {
    // Le message part dans le corps d'une réponse HTTP. La mesure est celle du
    // dépôt : épuré, il doit être identique à lui-même.
    const { db, c, brandDir } = préparer()
    const message = await refus(renderClip(c.id, { db, brandDir }))
    expect(message).toMatch(/logo\.png/)
    expect(épurerChemins(message)).toBe(message)
  })

  it("laisse passer un clip qui ne demande pas de marques", async () => {
    // Il ne va pas jusqu'au bout — ni transcript ni ffmpeg ici — et c'est ce qui
    // rend l'assertion nette : il échoue plus loin, sur autre chose.
    const { db, c, brandDir } = préparer({ branding: false })
    const message = await refus(renderClip(c.id, { db, brandDir }))
    expect(message).not.toMatch(/marque/i)
  })

  it('ne refuse pas un clip déjà rendu, qui ne produit rien de neuf', async () => {
    // Le saut n'encode pas : refuser là ferait échouer une relance qui se
    // contente de réécrire un `.txt`, sans rien changer aux fichiers livrés. La
    // contrepartie est connue — un clip exporté sans marque avant ce correctif
    // saute pour toujours — et son remède est `force`.
    const { db, c, brandDir } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    for (const chemin of [attendus.mp4, attendus.variant9x16 as string, attendus.texts]) {
      fs.mkdirSync(path.dirname(chemin), { recursive: true })
      fs.writeFileSync(chemin, '')
    }
    const résultat = await renderClip(c.id, { db, brandDir })
    expect(résultat.skipped).toBe(true)
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

  it("réécrit le .txt même quand il saute, sans réencoder", async () => {
    // Corriger une faute dans la description puis relancer l'export ne doit pas
    // exiger un --force qui réencoderait trois minutes de vidéo pour rien.
    const { db, c } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    poser([attendus.mp4, attendus.variant9x16 as string, attendus.texts])
    const avant = fs.statSync(attendus.variant9x16 as string).mtimeMs
    putClip(db, { ...c, description: 'Corrigée après coup. #impro' })

    const résultat = await renderClip(c.id, { db })

    expect(résultat.skipped).toBe(true)
    expect(fs.readFileSync(attendus.texts, 'utf8')).toContain('Corrigée après coup.')
    // Rien n'a été réencodé : la variante n'a pas été touchée.
    expect(fs.statSync(attendus.variant9x16 as string).mtimeMs).toBe(avant)
  })

  it("efface la variante d'un ratio abandonné même quand il saute", async () => {
    const { db, c } = préparer({ ratio: '9:16' })
    const attendus = cheminsRendu(ID, c.id, '9:16')
    const périmée = path.join(projets, ID, 'renders', `${c.id}-9x16.mp4`)
    poser([attendus.mp4, attendus.texts, périmée])

    const résultat = await renderClip(c.id, { db })

    expect(résultat.skipped).toBe(true)
    expect(fs.existsSync(périmée)).toBe(false)
  })

  it("répare le statut même quand il saute", async () => {
    // Un processus arrêté entre l'écriture du .txt et la mise à jour du statut
    // laisse toutes les sorties en place : sans cette réparation, chaque relance
    // sauterait et le clip resterait en « kept » pour toujours.
    const { db, c } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    poser([attendus.mp4, attendus.variant9x16 as string, attendus.texts])

    await renderClip(c.id, { db })
    expect(getClip(db, c.id)?.status).toBe('exported')
  })

  it("écrit le .txt manquant sans relire le transcript ni rappeler ffmpeg", async () => {
    // La reprise d'un passage interrompu juste après l'encodage. Aucun transcript
    // n'existe dans ce dossier de replays jetable : si l'étape allait le lire,
    // `lireTranscript` lèverait. C'est ce qui rend ce test concluant.
    const { db, c } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    poser([attendus.mp4, attendus.variant9x16 as string])

    const résultat = await renderClip(c.id, { db })
    expect(résultat.skipped).toBe(false)
    expect(fs.readFileSync(attendus.texts, 'utf8')).toContain('Titre : Une vanne qui tient')
    expect(getClip(db, c.id)?.status).toBe('exported')
  })

  it("efface la variante d'un ratio abandonné", async () => {
    // Le clip est repassé en 9:16, donc plus de variante due — mais celle du 1:1
    // d'avant est encore là, à ressembler à une livraison à jour.
    const { db, c } = préparer({ ratio: '9:16' })
    const attendus = cheminsRendu(ID, c.id, '9:16')
    const périmée = path.join(projets, ID, 'renders', `${c.id}-9x16.mp4`)
    poser([attendus.mp4, périmée])

    const résultat = await renderClip(c.id, { db })
    expect(résultat.variant9x16).toBeNull()
    expect(fs.existsSync(périmée)).toBe(false)
  })

  it("n'écrase pas un texte corrigé pendant l'export", () => {
    // Le défaut relevé par Codex : `renderClip` tient un clip lu avant son
    // premier `await`, et un export dure des minutes. Réécrire cet instantané
    // pour changer une colonne rendrait au clip son titre d'avant.
    const { db, c } = préparer()
    putClip(db, { ...c, title: 'Retitré' })

    marquerExporté(db, c.id, c.status)

    const relu = getClip(db, c.id)
    expect(relu?.status).toBe('exported')
    expect(relu?.title).toBe('Retitré')
  })

  it('ne ressuscite pas un clip supprimé pendant le rendu', () => {
    const { db, c } = préparer()
    db.prepare('DELETE FROM clips WHERE id = ?').run(c.id)
    marquerExporté(db, c.id, c.status)
    expect(getClip(db, c.id)).toBeUndefined()
  })

  it("conserve toute décision de statut prise pendant l'encodage", () => {
    // `discarded` n'est pas le seul cas : rappuyer sur « Gardé » ramène le clip
    // à `candidate` (`src/lib/clip-status.ts`). C'est l'écart de statut qui
    // compte, pas sa valeur. (relevé par Copilot)
    for (const décidé of ['discarded', 'candidate'] as const) {
      const { db, c } = préparer()
      putClip(db, { ...c, status: décidé })

      marquerExporté(db, c.id, c.status)

      expect(getClip(db, c.id)?.status).toBe(décidé)
      db.close()
    }
  })

  it("écarte les fichiers d'un rendu que le montage a rendu caduc", () => {
    // Refuser le statut ne suffisait pas : les MP4 restaient là, donc l'export
    // suivant sautait et annonçait « exporté » sur le montage d'avant. On retire
    // ce qu'on sait faux. (relevé par Copilot)
    const { db, c } = préparer({ status: 'exported' })
    const chemins = cheminsRendu(ID, c.id, '1:1')
    poser([chemins.mp4, chemins.variant9x16 as string, chemins.texts])
    putClip(db, { ...c, status: 'exported', segments: [{ start: 0, end: 5 }] })

    expect(écarterRenduPérimé(db, c.id, chemins, c)).toBe(true)

    expect(fs.existsSync(chemins.mp4)).toBe(false)
    expect(fs.existsSync(chemins.variant9x16 as string)).toBe(false)
    expect(fs.existsSync(chemins.texts)).toBe(false)
    // Plus rien sur le disque ne justifie « exporté ».
    expect(getClip(db, c.id)?.status).toBe('kept')
  })

  it("ne touche à rien quand le montage n'a pas bougé", () => {
    const { db, c } = préparer()
    const chemins = cheminsRendu(ID, c.id, '1:1')
    poser([chemins.mp4, chemins.variant9x16 as string, chemins.texts])

    expect(écarterRenduPérimé(db, c.id, chemins, c)).toBe(false)
    expect(fs.existsSync(chemins.mp4)).toBe(true)
  })

  it('refuse un clip inconnu', async () => {
    const { db } = préparer()
    await expect(renderClip('clip_inexistant', { db })).rejects.toThrow(/Clip inconnu/)
  })

  it("refuse un clip sans segment, plutôt que de rendre un fichier vide", async () => {
    const { db, c } = préparer({ segments: [] })
    await expect(renderClip(c.id, { db })).rejects.toThrow(/aucun segment/)
  })

  it("refuse un clip vidé après un premier export, au lieu de sauter dessus", async () => {
    // L'édition autorise de vider un clip, et ses anciens fichiers sont encore
    // là : sans validation avant la décision de saut, il ressortirait
    // `skipped: true` et marqué exporté. (relevé par Copilot)
    const { db, c } = préparer({ segments: [] })
    const attendus = cheminsRendu(ID, c.id, '1:1')
    poser([attendus.mp4, attendus.variant9x16 as string, attendus.texts])

    await expect(renderClip(c.id, { db })).rejects.toThrow(/aucun segment/)
    expect(getClip(db, c.id)?.status).toBe('kept')
  })

  it("dit quoi faire quand la copie de travail a disparu", async () => {
    const { db, c } = préparer()
    // Rien dans `stage/` : `stagedPath` est transitoire par contrat.
    await expect(renderClip(c.id, { db })).rejects.toThrow(/copie de travail/)
  })

  // **La variante réclame la source, même quand le natif est déjà là**, et c'est
  // le correctif de #22 vu depuis cette fonction : elle ne dérive plus du MP4
  // natif, donc son fond ne peut plus en hériter les sous-titres. Avant, ce cas
  // sautait la préparation et lançait ffmpeg sur le natif ; il exige maintenant
  // la copie de travail, et le dit.
  it("réclame la source quand seule la variante manque", async () => {
    const { db, c } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    poser([attendus.mp4, attendus.texts])

    await expect(renderClip(c.id, { db })).rejects.toThrow(/copie de travail/)
  })
})
