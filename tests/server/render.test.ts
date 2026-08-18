import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CAPTION_STYLE } from '@/core/captions/ass'
import type { Clip } from '@/core/edl'
import type { Word } from '@/core/transcript'
import { openDb, upsertProject, putClip, getClip } from '@/server/db'
import {
  cheminsRendu,
  collecterMarques,
  leRenduEstPérimé,
  marquerExporté,
  motsDièse,
  planifierMarques,
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

    marquerExporté(db, c.id, c)

    const relu = getClip(db, c.id)
    expect(relu?.status).toBe('exported')
    expect(relu?.title).toBe('Retitré')
  })

  it("laisse le clip non exporté si le montage a bougé pendant l'encodage", () => {
    // La suite du même défaut : les fichiers décrivent l'EDL d'avant, donc
    // annoncer « exporté » ferait publier un cadre déjà corrigé.
    const { db, c } = préparer()
    putClip(db, { ...c, segments: [{ start: 0, end: 5 }] })

    marquerExporté(db, c.id, c)

    expect(getClip(db, c.id)?.status).toBe('kept')
  })

  it('ne ressuscite pas un clip supprimé pendant le rendu', () => {
    const { db, c } = préparer()
    db.prepare('DELETE FROM clips WHERE id = ?').run(c.id)
    marquerExporté(db, c.id, c)
    expect(getClip(db, c.id)).toBeUndefined()
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

  it("rétrograde un clip déjà exporté dont le montage a bougé", () => {
    const { db, c } = préparer({ status: 'exported' })
    putClip(db, { ...c, status: 'exported', cropX: 0.1 })

    marquerExporté(db, c.id, c)

    expect(getClip(db, c.id)?.status).toBe('kept')
  })

  it("ne touche pas à un clip écarté dont le montage a bougé", () => {
    const { db, c } = préparer({ status: 'discarded' })
    putClip(db, { ...c, status: 'discarded', cropX: 0.1 })

    marquerExporté(db, c.id, c)

    expect(getClip(db, c.id)?.status).toBe('discarded')
  })

  it("dit quoi faire quand la copie de travail a disparu", async () => {
    const { db, c } = préparer()
    // Rien dans `stage/` : `stagedPath` est transitoire par contrat.
    await expect(renderClip(c.id, { db })).rejects.toThrow(/copie de travail/)
  })
})
