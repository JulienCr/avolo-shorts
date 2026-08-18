import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CAPTION_STYLE } from '@/core/captions/ass'
import type { Clip, Ratio } from '@/core/edl'
import { épurerChemins } from '@/core/erreurs'
import type { Word } from '@/core/transcript'
import { openDb, upsertProject, putClip, getClip } from '@/server/db'
import {
  cheminsRendu,
  collecterMarques,
  écarterRenduPérimé,
  condensatDesPolices,
  écartDeLEmpreinte,
  type CeQuOnIncrusterait,
  type LookDesSousTitres,
  empreinteDuRendu,
  leRenduEstPérimé,
  lesMarquesOntBougé,
  lireEmpreinte,
  marquerExporté,
  motsDièse,
  planifierMarques,
  refaireLesSorties,
  refuserFauteDeMarque,
  renderClip,
  sauterLeRendu,
  sousTitresDuClip,
  texteDePublication,
  VERSION_EMPREINTE,
  renderedFraming,
  renderedShape,
  type RenderedFraming,
  type FormeRendue,
  type MarqueNative,
} from '@/server/steps/render'
import { clipFraming, forgetAnalyses } from '@/server/clip-framing'

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
/**
 * Le dossier de polices de ces tests, **jetable et vide**. Sans lui, le condensat
 * du look dépendrait du `fonts/` du dépôt — peuplé sur la machine de l'opérateur,
 * réduit en CI —, et le verdict de l'empreinte varierait avec la machine.
 */
let polices: string
const envDépart = { ...process.env }

beforeEach(() => {
  racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-render-'))
  replay = path.join(racine, 'Replay')
  stage = path.join(racine, 'stage')
  projets = path.join(racine, 'projects')
  polices = path.join(racine, 'polices-vides')
  for (const d of [replay, stage, projets, polices]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(replay, SOURCE), 'pas vraiment une vidéo')

  process.env.REPLAY_DIR = replay
  process.env.STAGE_DIR = stage
  process.env.PROJECTS_DIR = projets
})

afterEach(() => {
  fs.rmSync(racine, { recursive: true, force: true })
  process.env = { ...envDépart }
  // **Le cache d'analyses se vide entre deux tests.** Il est indexé sur le
  // chemin, la taille et la date du fichier ; chaque test refabrique son
  // `PROJECTS_DIR` sous un nom neuf, mais un test qui poserait deux
  // `analysis.json` de suite au même endroit relirait sinon le premier.
  forgetAnalyses()
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

/**
 * Des marques, dans la forme que `collecterMarques` rendrait.
 *
 * `contenu` dérive du nom par défaut : deux appels avec les mêmes noms rendent
 * les mêmes marques, et il suffit de passer un contenu explicite pour simuler
 * un fichier remplacé sous le même nom.
 */
function marquesNommées(
  noms: readonly string[],
  contenu: (nom: string) => string = (nom) => `contenu-de-${nom}`,
): MarqueNative[] {
  return noms.map((nom) => ({
    path: path.join('/nulle-part', nom),
    nativeW: 1000,
    nativeH: 996,
    largeurRatio: 0.22,
    bord: 'gauche' as const,
    contenu: contenu(nom),
  }))
}

/**
 * Le cadrage **réellement résolu** de ce clip, comme `renderClip` le calcule.
 *
 * Aucun de ces tests ne pose d'`analysis.json`, donc `clipFraming` se rabat
 * sur le réglage manuel : un plan unique qui couvre le clip, au ratio résolu et
 * au `cropX` du clip. Passer par la vraie fonction plutôt que par un littéral
 * est ce qui fait que les tests de `marquerExporté` et d'`écarterRenduPérimé`
 * comparent bien ce que la production compare.
 */
function cadrageDe(c: Clip): RenderedFraming {
  return renderedFraming(clipFraming(c))
}

/**
 * Le cadrage d'un clip, dans la forme réduite que l'empreinte retient.
 *
 * Un plan unique qui couvre le clip de référence, en 1:1 centré. C'est le cas
 * le plus simple, et celui qui laisse chaque test surcharger ce qu'il mesure.
 */
function cadrage(surcharges: Partial<RenderedFraming> = {}): RenderedFraming {
  return {
    ratio: '1:1',
    shots: [{ start: 0, end: 20, ratio: '1:1', cropX: 0.5, cropXNative: 0.5 }],
    ...surcharges,
  }
}

/**
 * Un clip et son cadrage, tels que `leRenduEstPérimé` les compare.
 *
 * Le cadrage n'est pas un champ du clip : il se recalcule sur ses segments, et
 * c'est justement pour cela qu'il entre dans l'empreinte — une redétection des
 * plans peut déplacer tous les crops sans qu'aucun champ du clip ne bouge.
 */
function forme(c: Clip = clip(), cad: RenderedFraming = cadrage()): FormeRendue {
  return renderedShape(c, cad)
}

/**
 * `empreinteDuRendu` avec le preset par défaut, celui de tous ces tests-ci.
 * Le condensat du preset n'entre dans l'empreinte que si un document a été
 * incrusté — d'où le troisième paramètre.
 */
function empreinteAvec(
  c: Clip,
  marques: readonly MarqueNative[],
  incrustés = true,
  cad: RenderedFraming = cadrage(),
): ReturnType<typeof empreinteDuRendu> {
  return empreinteDuRendu(forme(c, cad), marques, { incrustés, look: look() })
}

/** Le look de référence : le preset par défaut, sur le dossier de polices vide. */
function look(): LookDesSousTitres {
  return { style: DEFAULT_CAPTION_STYLE, polices: condensatDesPolices(polices) }
}

/** Ce que l'appelant a sondé de ce qu'on incrusterait : rien, sauf mention. */
function observé(surcharges: Partial<CeQuOnIncrusterait> = {}): CeQuOnIncrusterait {
  return { marques: null, look: null, ...surcharges }
}

/**
 * L'empreinte qu'un rendu réussi aurait laissée à côté de ses sorties.
 *
 * Elle passe par `empreinteDuRendu` plutôt que par un littéral : un champ ajouté
 * au format doit casser ces tests, pas les laisser poser un fichier que la
 * lecture refuserait en silence.
 */
function poserEmpreinte(
  c: Clip,
  ratio: Ratio,
  marques: readonly string[] = [],
  sousTitres = c.captions,
): void {
  const chemin = cheminsRendu(ID, c.id, ratio).empreinte
  fs.mkdirSync(path.dirname(chemin), { recursive: true })
  // **Le cadrage résolu, et non un littéral** : c'est celui que `renderClip`
  // recalcule à chaque passage, donc le seul qui puisse faire dire à l'empreinte
  // qu'elle décrit encore le clip.
  fs.writeFileSync(
    chemin,
    JSON.stringify(empreinteAvec(c, marquesNommées(marques), sousTitres, cadrageDe(c))),
  )
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

  it('saute quand les trois sorties sont là et que l’empreinte les décrit', () => {
    const c = chemins('1:1')
    expect(sauterLeRendu(c, () => true, true)).toBe(true)
  })

  it("ne saute pas quand il manque le .txt, même si le MP4 est là", () => {
    const c = chemins('1:1')
    expect(sauterLeRendu(c, (chemin) => chemin !== c.texts, true)).toBe(false)
  })

  it('ne saute pas quand il manque la variante', () => {
    const c = chemins('1:1')
    expect(sauterLeRendu(c, (chemin) => chemin !== c.variant9x16, true)).toBe(false)
  })

  it("n'attend pas de variante en 9:16", () => {
    const c = chemins('9:16')
    // Rien d'autre que le MP4 et le texte n'existe : la variante n'est pas due.
    expect(sauterLeRendu(c, (chemin) => chemin === c.mp4 || chemin === c.texts, true)).toBe(true)
  })

  it('ne saute jamais sous `force`', () => {
    expect(sauterLeRendu(chemins('1:1'), () => true, true, true)).toBe(false)
  })

  it("ignore le .ass, qui est un intermédiaire et non une sortie", () => {
    const c = chemins('9:16')
    expect(sauterLeRendu(c, (chemin) => chemin !== c.ass, true)).toBe(true)
  })

  /**
   * **Le deuxième point de #48.** Trois `existsSync` disaient « complet », donc
   * « à jour ». Un jeu de fichiers laissé par un montage abandonné, ou produit
   * sous une recette antérieure, les satisfaisait aussi bien qu'une livraison.
   */
  it("ne saute pas quand l'empreinte ne décrit pas le clip, fichiers complets", () => {
    expect(sauterLeRendu(chemins('1:1'), () => true, false)).toBe(false)
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
    expect(refaireLesSorties(chemins('1:1'), () => true, true)).toBe(false)
  })

  it("laisse le .txt seul se réécrire, sans réencoder une image", () => {
    const c = chemins('1:1')
    expect(refaireLesSorties(c, (chemin) => chemin !== c.texts, true)).toBe(false)
  })

  it('refait le natif quand seule la variante manque', () => {
    // Le cas qui compte : le natif est là, mais il porte peut-être le montage
    // d'un passage précédent. Le garder pendant qu'on rend la variante depuis
    // l'instantané d'aujourd'hui livrerait deux fichiers montrant deux cadres.
    const c = chemins('1:1')
    expect(refaireLesSorties(c, (chemin) => chemin !== c.variant9x16, true)).toBe(true)
  })

  it('refait la variante quand seul le natif manque', () => {
    const c = chemins('1:1')
    expect(refaireLesSorties(c, (chemin) => chemin !== c.mp4, true)).toBe(true)
  })

  it("n'attend pas de variante en 9:16", () => {
    const c = chemins('9:16')
    expect(refaireLesSorties(c, (chemin) => chemin === c.mp4, true)).toBe(false)
  })

  it('réencode toujours sous `force`', () => {
    expect(refaireLesSorties(chemins('1:1'), () => true, true, true)).toBe(true)
  })

  it("ignore le .ass, qui se réécrit à chaque passage", () => {
    const c = chemins('1:1')
    expect(refaireLesSorties(c, (chemin) => chemin !== c.ass, true)).toBe(false)
  })

  /**
   * Sans cette ligne, le correctif de `sauterLeRendu` ne ferait que déplacer le
   * mensonge : un jeu de MP4 complet mais périmé sauterait l'encodage pour n'y
   * réécrire que le `.txt`, et repartirait `exported`.
   */
  it("rallume ffmpeg quand l'empreinte ne décrit pas le clip, fichiers complets", () => {
    expect(refaireLesSorties(chemins('1:1'), () => true, false)).toBe(true)
  })
})

/**
 * L'empreinte elle-même : ce qu'elle porte, ce qu'elle refuse, et où elle vit.
 *
 * Tout ce qui décide y est pur — l'appelant a lu le disque — donc rien de ce
 * bloc ne demande ffmpeg, ce qui est la condition pour que la CI le voie.
 */
describe("l'empreinte de rendu", () => {
  it("se range à côté des sorties, sous un nom qui ne dépend pas du ratio", () => {
    // Un clip repassé de 1:1 à 9:16 doit retrouver — pour l'écarter — celle
    // qu'il a écrite avant, ce que le nom de la variante ne permet pas.
    const attendu = path.join(projets, ID, 'renders', 'clip_0001.rendu.json')
    for (const ratio of ['9:16', '4:5', '1:1', '16:9'] as const) {
      expect(cheminsRendu(ID, 'clip_0001', ratio).empreinte).toBe(attendu)
    }
  })

  it('porte les champs du clip, le cadrage résolu, la version et ce qui a été incrusté', () => {
    const e = empreinteAvec(clip(), marquesNommées(['twitch.png', 'logo.png']))
    expect(e).toEqual({
      version: VERSION_EMPREINTE,
      segments: clip().segments,
      captions: true,
      branding: true,
      // **Le cadrage résolu, pas `clip.ratio` ni `clip.cropX`.** Ceux-là ne
      // décrivent plus l'image : le ratio effectif est celui que le calcul
      // choisit — par plan pour la variante, le plus large pour le natif — et
      // le crop se calcule par plan. La clé est en anglais comme tout ce que
      // cette PR ajoute ; `marques` et `sousTitres`, plus anciennes, attendent
      // le balayage de #73.
      framing: cadrage(),
      // Triées : l'ordre de lecture d'un dossier n'a rien à dire.
      marques: [
        { nom: 'logo.png', contenu: 'contenu-de-logo.png' },
        { nom: 'twitch.png', contenu: 'contenu-de-twitch.png' },
      ],
      // Le condensat du preset, et non un booléen : il dit avec quel look.
      sousTitres: e.sousTitres,
    })
  })

  it("consigne l'absence de sous-titres sur un clip qui en demandait", () => {
    // Un clip dont aucun mot ne tombe dans les segments se rend sans, en le
    // journalisant. L'empreinte dit ce qui a été incrusté, pas ce qui était
    // demandé — les deux champs sont là et ils divergent.
    const e = empreinteAvec(clip({ captions: true }), [], false)
    expect(e.captions).toBe(true)
    expect(e.sousTitres).toBeNull()
  })

  describe('écartDeLEmpreinte', () => {
    const marques = marquesNommées(['logo.png'])
    const àCôté = (surcharges: Partial<Clip> = {}): ReturnType<typeof empreinteDuRendu> =>
      empreinteAvec(clip(surcharges), marques)

    it('ne trouve rien à redire quand tout concorde', () => {
      expect(écartDeLEmpreinte(àCôté(), forme(), observé({ marques }))).toBeNull()
    })

    it("dit « absente » sur un rendu qui n'en a pas — les trois du 18 août", () => {
      expect(écartDeLEmpreinte(null, forme(), observé({ marques }))).toBe('absente')
    })

    it('dit « recette » sur une version qui n’est plus la nôtre', () => {
      const vieille = { ...àCôté(), version: VERSION_EMPREINTE - 1 }
      expect(écartDeLEmpreinte(vieille, forme(), observé({ marques }))).toBe('recette')
    })

    it('dit « montage » sur chacun des champs qui vont à l’image', () => {
      const cas: Partial<Clip>[] = [
        { segments: [{ start: 0, end: 5 }] },
        { captions: false },
        { branding: false },
      ]
      for (const surcharge of cas) {
        expect(écartDeLEmpreinte(àCôté(), forme(clip(surcharge)), observé({ marques }))).toBe(
          'montage',
        )
      }
    })

    // **Le cadrage aussi, et c'est ce qui manquait.** Il ne vit pas dans le
    // clip : il se recalcule sur ses segments et sur `analysis.json`. Une
    // redétection des plans déplace donc tous les crops sans qu'aucun champ du
    // clip ne bouge, et sans ce champ l'empreinte déclarerait à jour un rendu
    // qui ne montre plus ce que la chaîne montrerait.
    it('dit « montage » quand le cadrage résolu a bougé', () => {
      const cas: Partial<RenderedFraming>[] = [
        { ratio: '4:5' },
        { shots: [{ start: 0, end: 20, ratio: '1:1', cropX: 0.2, cropXNative: 0.5 }] },
        { shots: [{ start: 0, end: 20, ratio: '1:1', cropX: 0.5, cropXNative: 0.2 }] },
        { shots: [{ start: 0, end: 20, ratio: '4:5', cropX: 0.5, cropXNative: 0.5 }] },
        { shots: [{ start: 0, end: 12, ratio: '1:1', cropX: 0.5, cropXNative: 0.5 }] },
        {
          shots: [
            { start: 0, end: 10, ratio: '1:1', cropX: 0.5, cropXNative: 0.5 },
            { start: 10, end: 20, ratio: '1:1', cropX: 0.5, cropXNative: 0.5 },
          ],
        },
      ]
      for (const surcharge of cas) {
        expect(
          écartDeLEmpreinte(àCôté(), forme(clip(), cadrage(surcharge)), observé({ marques })),
        ).toBe('montage')
      }
    })

    // **Deux tableaux de crops identiques ne sont jamais le même objet.**
    // Comparés par référence, chaque appel périmerait le rendu : l'export
    // réencoderait à chaque passage, et `skipped` ne serait plus jamais vrai.
    it('ne périme rien sur un cadrage identique mais reconstruit', () => {
      expect(
        écartDeLEmpreinte(àCôté(), forme(clip(), cadrage()), observé({ marques })),
      ).toBeNull()
    })

    it("ignore le titre, la description et le statut, qui ne vont pas à l'image", () => {
      const indifférents: Partial<Clip>[] = [
        { title: 'Autre chose' },
        { description: 'Autre chose' },
        { status: 'exported' },
        { pass: 9 },
        // `ratio` et `cropX` du clip n'y sont plus : ils ne décrivent plus
        // l'image, c'est `cadrage` qui porte ce que ffmpeg a découpé. Un ratio
        // épinglé sur la valeur que le calcul avait déjà choisie ne change rien.
        { ratio: '9:16' },
        { cropX: 0.2 },
      ]
      for (const surcharge of indifférents) {
        expect(écartDeLEmpreinte(àCôté(), forme(clip(surcharge)), observé({ marques }))).toBeNull()
      }
    })

    it('dit « marques » quand une marque a été déposée depuis le rendu', () => {
      const deux = marquesNommées(['logo.png', 'twitch.png'])
      expect(écartDeLEmpreinte(àCôté(), forme(), observé({ marques: deux }))).toBe('marques')
    })

    it('dit « marques » quand une marque a été retirée du dossier', () => {
      const empreinte = empreinteAvec(clip(), marquesNommées(['logo.png', 'twitch.png']))
      expect(écartDeLEmpreinte(empreinte, forme(), observé({ marques }))).toBe('marques')
    })

    /**
     * **Le seul appelant qui ne sonde pas le dossier**, et c'est un arbitrage de
     * coût : `GET /api/clips/:id` se sert à chaque affichage de carte et ne
     * lance pas deux ffprobe pour cela. C'est la même fonction, avec un critère
     * de moins — jamais un second avis sur la même question.
     */
    /**
     * **`OptionsRendu.style` change l'image et n'entrait pas dans l'empreinte.**
     * Un rendu forcé avec un preset personnalisé, puis un appel avec le preset
     * par défaut, sautait en déclarant à jour une vidéo produite avec l'autre
     * style. (relevé par Copilot)
     */
    it('dit « style » quand le preset des sous-titres a changé', () => {
      const incrusté = empreinteAvec(clip(), marques)
      const autre = { ...look(), style: { ...DEFAULT_CAPTION_STYLE, fontSize: 52 } }
      expect(écartDeLEmpreinte(incrusté, forme(), observé({ look: autre }))).toBe('style')
      expect(écartDeLEmpreinte(incrusté, forme(), observé({ look: look() }))).toBeNull()
    })

    it("ignore l'ordre des clés du preset, qui ne change pas une image", () => {
      // `JSON.stringify` suit l'ordre d'insertion : sans tri, réordonner le
      // littéral de `DEFAULT_CAPTION_STYLE` périmerait tous les rendus du disque.
      const réordonné = Object.fromEntries(
        Object.entries(DEFAULT_CAPTION_STYLE).reverse(),
      ) as typeof DEFAULT_CAPTION_STYLE
      expect(
        écartDeLEmpreinte(
          empreinteAvec(clip(), marques),
          forme(),
          observé({ look: { ...look(), style: réordonné } }),
        ),
      ).toBeNull()
    })

    it("ne juge pas du preset quand aucun sous-titre n'a été incrusté", () => {
      // Le preset n'a alors rien décrit de l'image : le comparer périmerait au
      // premier réglage de police un clip qui n'en porte pas.
      const sansSousTitres = empreinteAvec(clip({ captions: false }), marques, false)
      const autre = { ...look(), style: { ...DEFAULT_CAPTION_STYLE, fontSize: 12 } }
      expect(
        écartDeLEmpreinte(
          sansSousTitres,
          forme(clip({ captions: false })),
          observé({ look: autre }),
        ),
      ).toBeNull()
    })

    it('ne juge pas du preset quand on ne le lui donne pas', () => {
      const incrusté = empreinteAvec(clip(), marques)
      expect(écartDeLEmpreinte(incrusté, forme(), observé())).toBeNull()
    })

    it('ne juge pas des marques quand on ne les lui donne pas', () => {
      const empreinte = empreinteAvec(clip(), marquesNommées(['logo.png', 'twitch.png']))
      expect(écartDeLEmpreinte(empreinte, forme(), observé())).toBeNull()
      // Le reste continue de compter.
      expect(
        écartDeLEmpreinte(empreinte, forme(clip(), cadrage({ ratio: '4:5' })), observé()),
      ).toBe('montage')
    })
  })

  describe('lesMarquesOntBougé', () => {
    it("ne périme rien quand le dossier est vide et que le clip en demandait", () => {
      // Les deux PNG ont vraiment disparu d'`assets/brand/` le 18 août. Un clip
      // qui demande des marques dont aucune n'est exploitable ne peut pas se
      // rendre (#37) : périmer son rendu changerait une livraison correcte en
      // export qui refuse.
      const empreinte = empreinteAvec(clip(), marquesNommées(['logo.png']))
      expect(lesMarquesOntBougé(empreinte, [], true)).toBe(false)
    })

    it('périme quand le clip ne demandait pas de marque et qu’il en reste une', () => {
      // Le dossier vide n'excuse que le clip qui en demande. Ici l'empreinte
      // porte une marque incrustée alors que plus rien ne devrait l'être.
      const empreinte = empreinteAvec(clip({ branding: false }), marquesNommées(['logo.png']))
      expect(lesMarquesOntBougé(empreinte, [], false)).toBe(true)
    })

    it("compare sans tenir compte de l'ordre", () => {
      const empreinte = {
        ...empreinteAvec(clip(), []),
        marques: [
          { nom: 'twitch.png', contenu: 'contenu-de-twitch.png' },
          { nom: 'logo.png', contenu: 'contenu-de-logo.png' },
        ],
      }
      expect(lesMarquesOntBougé(empreinte, marquesNommées(['logo.png', 'twitch.png']), true)).toBe(
        false,
      )
    })

    /**
     * **Le nom ne suffit pas.** Les deux marques portent des noms fixes, et la
     * façon normale d'en changer est de remplacer le fichier sous le même nom.
     * Une empreinte réduite aux noms verrait « rien n'a bougé » là où tout a
     * changé, et l'export continuerait de livrer l'ancienne image.
     * (relevé par Codex)
     */
    it('périme un logo remplacé sous le même nom', () => {
      const empreinte = empreinteAvec(clip(), marquesNommées(['logo.png']))
      const remplacé = marquesNommées(['logo.png'], () => 'une tout autre image')
      expect(lesMarquesOntBougé(empreinte, remplacé, true)).toBe(true)
    })
  })

  /**
   * Le condensat du dossier de polices, isolé : c'est lui qui distingue un rendu
   * incrusté avec Anton d'un rendu incrusté avec le repli de fontconfig, et deux
   * versions d'Anton l'une de l'autre. (relevé par Copilot et par Codex)
   */
  describe('condensatDesPolices', () => {
    const poser = (nom: string, contenu: string): void => {
      fs.writeFileSync(path.join(polices, nom), contenu)
    }

    it("confond un dossier vide et un dossier absent, qui rendent la même image", () => {
      // Les deux mènent au même repli fontconfig. Les distinguer périmerait un
      // rendu sur la seule création d'un dossier vide.
      expect(condensatDesPolices(polices)).toBe(condensatDesPolices(path.join(racine, 'jamais')))
    })

    it('change quand une police arrive', () => {
      const vide = condensatDesPolices(polices)
      poser('Anton-Regular.ttf', 'pas vraiment une police')
      expect(condensatDesPolices(polices)).not.toBe(vide)
    })

    it("change quand une police est remplacée sous le même nom", () => {
      poser('Anton-Regular.ttf', 'la version d’hier')
      const avant = condensatDesPolices(polices)
      poser('Anton-Regular.ttf', 'la version d’aujourd’hui')
      expect(condensatDesPolices(polices)).not.toBe(avant)
    })

    it("ne bouge pas pour un fichier que libass ne chargera pas", () => {
      poser('Anton-Regular.ttf', 'pas vraiment une police')
      const avant = condensatDesPolices(polices)
      poser('README.md', 'où trouver Anton')
      expect(condensatDesPolices(polices)).toBe(avant)
    })

    it("ne dépend pas de l'ordre de lecture du dossier", () => {
      poser('a.ttf', 'une')
      poser('b.otf', 'deux')
      const attendu = condensatDesPolices(polices)
      fs.rmSync(path.join(polices, 'a.ttf'))
      poser('a.ttf', 'une')
      expect(condensatDesPolices(polices)).toBe(attendu)
    })
  })

  describe('lireEmpreinte', () => {
    const chemin = (): string => cheminsRendu(ID, 'clip_0001', '1:1').empreinte

    it("rend null sur un fichier absent, et c'est le cas normal", () => {
      expect(lireEmpreinte(chemin())).toBeNull()
    })

    it('relit ce que `empreinteDuRendu` a écrit', () => {
      const c = clip()
      poserEmpreinte(c, '1:1', ['logo.png'])
      // `poserEmpreinte` écrit le cadrage **résolu** : le relire suppose de le
      // recalculer de la même façon, sinon on compare deux cadrages différents.
      expect(lireEmpreinte(chemin())).toEqual(
        empreinteAvec(c, marquesNommées(['logo.png']), c.captions, cadrageDe(c)),
      )
    })

    it("rend null sur un JSON tronqué — un processus tué en pleine écriture", () => {
      fs.mkdirSync(path.dirname(chemin()), { recursive: true })
      fs.writeFileSync(chemin(), '{"version": 1, "segm')
      expect(lireEmpreinte(chemin())).toBeNull()
    })

    it('rend null sur un fichier bien formé mais qui n’est pas une empreinte', () => {
      fs.mkdirSync(path.dirname(chemin()), { recursive: true })
      fs.writeFileSync(chemin(), JSON.stringify({ version: VERSION_EMPREINTE }))
      expect(lireEmpreinte(chemin())).toBeNull()
    })

    /**
     * **Une empreinte d'une recette antérieure n'est pas « illisible ».**
     *
     * Elle n'a pas les champs d'aujourd'hui — celles de la version 1 ne portent
     * pas le cadrage —, donc la passer au schéma la ferait refuser et le journal
     * dirait « illisible » d'un fichier parfaitement formé. Le remède est le
     * même, refaire le rendu ; le message, lui, enverrait chercher une
     * corruption qui n'existe pas. C'est `version` qui tranche, avant le schéma.
     */
    it('rend null sur une empreinte de la version d’avant, sans crier à la corruption', () => {
      const avertissements: unknown[][] = []
      const espion = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
        avertissements.push(a)
      })
      fs.mkdirSync(path.dirname(chemin()), { recursive: true })
      fs.writeFileSync(
        chemin(),
        JSON.stringify({
          version: VERSION_EMPREINTE - 1,
          segments: clip().segments,
          ratio: '1:1',
          cropX: 0.5,
          captions: true,
          branding: true,
          marques: [],
          sousTitres: null,
        }),
      )
      expect(lireEmpreinte(chemin())).toBeNull()
      expect(String(avertissements[0]?.[0])).toMatch(/version 1/)
      expect(String(avertissements[0]?.[0])).not.toMatch(/illisible/)
      espion.mockRestore()
    })

    it("garde un champ inconnu sans s'en offusquer : c'est `version` qui tranche", () => {
      // Une version ultérieure ajoutera des champs. Refuser d'analyser dirait
      // « illisible » d'un fichier parfaitement formé, alors que le seul verdict
      // qui vaille est celui de `version`.
      const c = clip()
      const brut = { ...empreinteAvec(c, []), venuDuFutur: 42 }
      fs.mkdirSync(path.dirname(chemin()), { recursive: true })
      fs.writeFileSync(chemin(), JSON.stringify(brut))
      expect(lireEmpreinte(chemin())?.version).toBe(VERSION_EMPREINTE)
    })

    it("ne publie aucun chemin absolu dans ce qu'il journalise", () => {
      // Le journal d'un `GET` finit sous les yeux de qui lit les traces, et le
      // chemin porte l'arborescence de la machine.
      const messages: string[] = []
      const avant = console.warn
      console.warn = (...args: unknown[]) => void messages.push(args.join(' '))
      try {
        fs.mkdirSync(path.dirname(chemin()), { recursive: true })
        fs.writeFileSync(chemin(), 'pas du json')
        lireEmpreinte(chemin())
      } finally {
        console.warn = avant
      }
      expect(messages.length).toBe(1)
      expect(messages[0]).toContain('clip_0001.rendu.json')
      expect(messages[0]).not.toContain(projets)
    })
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
    contenu: 'peu importe : le placement ne lit pas le contenu',
  })
  const mention = (nativeW: number, nativeH: number): MarqueNative => ({
    path: '/marques/twitch.png',
    nativeW,
    nativeH,
    largeurRatio: 0.16,
    bord: 'droite',
    contenu: 'peu importe : le placement ne lit pas le contenu',
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
    expect(leRenduEstPérimé(forme(), forme())).toBe(false)
  })

  it("ignore le titre et la description, qui ne vont que dans le .txt", () => {
    expect(leRenduEstPérimé(forme(), forme(clip({ title: 'Autre', description: 'Autre' })))).toBe(
      false,
    )
  })

  it("ignore le statut et le numéro de passe", () => {
    expect(leRenduEstPérimé(forme(), forme(clip({ status: 'exported', pass: 9 })))).toBe(false)
  })

  // `ratio` et `cropX` du clip sont sortis de la comparaison quand le cadrage
  // automatique est entré en service : ils ne décrivent plus l'image. Les garder
  // ferait réencoder pour rien un clip qu'on épingle sur le ratio que le calcul
  // avait déjà choisi.
  it("ignore le ratio demandé et le cropX du clip, que l'encodage ne lit plus", () => {
    expect(leRenduEstPérimé(forme(), forme(clip({ ratio: '4:5', cropX: 0.2 })))).toBe(false)
  })

  it('voit chacun des champs du clip qui vont à l’image', () => {
    const cas: Partial<Clip>[] = [
      { segments: [{ start: 0, end: 5 }] },
      { captions: false },
      { branding: false },
    ]
    for (const surcharge of cas) {
      expect(leRenduEstPérimé(forme(), forme(clip(surcharge)))).toBe(true)
    }
  })

  // **La comparaison du cadrage est profonde**, comme celle des segments : deux
  // tableaux de crops identiques ne sont jamais le même objet, et un `!==` par
  // référence périmerait le rendu à chaque appel.
  it('compare le cadrage en profondeur, pas par référence', () => {
    expect(leRenduEstPérimé(forme(clip(), cadrage()), forme(clip(), cadrage()))).toBe(false)
  })

  it('voit chacune des composantes du cadrage résolu', () => {
    const cas: Partial<RenderedFraming>[] = [
      { ratio: '4:5' },
      { shots: [{ start: 0, end: 20, ratio: '4:5', cropX: 0.5, cropXNative: 0.5 }] },
      { shots: [{ start: 0, end: 20, ratio: '1:1', cropX: 0.3, cropXNative: 0.5 }] },
      { shots: [{ start: 0, end: 20, ratio: '1:1', cropX: 0.5, cropXNative: 0.3 }] },
      { shots: [{ start: 1, end: 20, ratio: '1:1', cropX: 0.5, cropXNative: 0.5 }] },
      { shots: [] },
    ]
    for (const surcharge of cas) {
      expect(leRenduEstPérimé(forme(), forme(clip(), cadrage(surcharge)))).toBe(true)
    }
  })

  it('voit un segment déplacé, à nombre de segments égal', () => {
    const bougé = clip().segments.map((s, i) => (i === 1 ? { start: s.start, end: s.end + 1 } : s))
    expect(leRenduEstPérimé(forme(), forme(clip({ segments: bougé })))).toBe(true)
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
    contenu: 'peu importe : la porte ne lit pas le contenu',
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
    await expect(renderClip(c.id, { db, brandDir, fontsDir: polices })).rejects.toThrow(/logo\.png/)
  })

  it("refuse pareillement quand le dossier des marques n'existe pas", async () => {
    // `collecterMarques` ne distingue pas les deux, et il n'y a rien à
    // distinguer : la marque a été demandée, aucune n'est posée. La piste 3 de
    // l'issue butait là — `assets/brand/` est de toute façon toujours présent,
    // son README étant versionné.
    const { db, c } = préparer()
    await expect(
      renderClip(c.id, { db, brandDir: path.join(racine, 'nulle-part'), fontsDir: polices }),
    ).rejects.toThrow(/logo\.png/)
  })

  it('nomme les deux issues : déposer une marque, ou couper le branding', async () => {
    const { db, c, brandDir } = préparer()
    const message = await refus(renderClip(c.id, { db, brandDir, fontsDir: polices }))
    expect(message).toMatch(/assets\/brand\//)
    expect(message).toMatch(/branding/)
  })

  it("refuse avant d'encoder : aucune sortie n'est posée sur le disque", async () => {
    // Ce que l'issue demande noir sur blanc : pas de MP4 muet. Le `.ass` absent
    // dit en plus que le refus précède la lecture du transcript, qui vit sur le
    // Drive en 9p et coûte un aller-retour.
    const { db, c, brandDir } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    await expect(renderClip(c.id, { db, brandDir, fontsDir: polices })).rejects.toThrow(/marques/)
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
    const message = await refus(renderClip(c.id, { db, brandDir, fontsDir: polices }))
    expect(message).toMatch(/logo\.png/)
    expect(épurerChemins(message)).toBe(message)
  })

  it("laisse passer un clip qui ne demande pas de marques", async () => {
    // Il ne va pas jusqu'au bout — ni transcript ni ffmpeg ici — et c'est ce qui
    // rend l'assertion nette : il échoue plus loin, sur autre chose.
    const { db, c, brandDir } = préparer({ branding: false })
    const message = await refus(renderClip(c.id, { db, brandDir, fontsDir: polices }))
    expect(message).not.toMatch(/marque/i)
  })

  it('ne refuse pas un clip déjà rendu, qui ne produit rien de neuf', async () => {
    // Le saut n'encode pas : refuser là ferait échouer une relance qui se
    // contente de réécrire un `.txt`, sans rien changer aux fichiers livrés.
    const { db, c, brandDir } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    for (const chemin of [attendus.mp4, attendus.variant9x16 as string, attendus.texts]) {
      fs.mkdirSync(path.dirname(chemin), { recursive: true })
      fs.writeFileSync(chemin, '')
    }
    poserEmpreinte(c, '1:1')
    const résultat = await renderClip(c.id, { db, brandDir, fontsDir: polices })
    expect(résultat.skipped).toBe(true)
  })

  /**
   * **Ce que #48 change à la contrepartie de #37.** Un clip exporté sans marque
   * avant #37 n'a pas d'empreinte : il ne saute plus, donc il atteint la porte,
   * qui refuse en disant quoi faire. Avant, il sautait pour toujours et son seul
   * remède était un `force` qu'il fallait avoir lu un commentaire pour connaître.
   */
  it("refuse un rendu sans empreinte quand le dossier n'a plus de marque", async () => {
    const { db, c, brandDir } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    for (const chemin of [attendus.mp4, attendus.variant9x16 as string, attendus.texts]) {
      fs.mkdirSync(path.dirname(chemin), { recursive: true })
      fs.writeFileSync(chemin, '')
    }

    await expect(renderClip(c.id, { db, brandDir, fontsDir: polices })).rejects.toThrow(/logo\.png/)
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
    const c = clip(surcharges)
    putClip(db, c)
    // **Jetable et vide, jamais celui du dépôt.** `renderClip` sonde le dossier
    // des marques avant même la décision de saut, pour comparer l'empreinte :
    // sans ce chemin explicite il lirait `assets/brand/`, qui porte les deux PNG
    // sur la machine de l'opérateur et rien du tout en CI. Le verdict de
    // l'empreinte dépendrait alors de la machine.
    const brandDir = path.join(racine, 'brand-saut')
    fs.mkdirSync(brandDir, { recursive: true })
    return { db, c, brandDir }
  }

  function poser(chemins: string[]): void {
    for (const chemin of chemins) {
      fs.mkdirSync(path.dirname(chemin), { recursive: true })
      fs.writeFileSync(chemin, '')
    }
  }

  it('rend les trois chemins et saute quand tout est là', async () => {
    const { db, c, brandDir } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    poser([attendus.mp4, attendus.variant9x16 as string, attendus.texts])
    poserEmpreinte(c, '1:1')

    const résultat = await renderClip(c.id, { db, brandDir, fontsDir: polices })
    expect(résultat).toEqual({
      mp4: attendus.mp4,
      variant9x16: attendus.variant9x16,
      texts: attendus.texts,
      skipped: true,
    })
  })

  it("rabat 'auto' sur 9:16, donc sans variante (itération 0)", async () => {
    const { db, c, brandDir } = préparer({ ratio: 'auto' })
    const attendus = cheminsRendu(ID, c.id, '9:16')
    poser([attendus.mp4, attendus.texts])
    poserEmpreinte(c, '9:16')

    const résultat = await renderClip(c.id, { db, brandDir, fontsDir: polices })
    expect(résultat.skipped).toBe(true)
    expect(résultat.variant9x16).toBeNull()
  })

  it("réécrit le .txt même quand il saute, sans réencoder", async () => {
    // Corriger une faute dans la description puis relancer l'export ne doit pas
    // exiger un --force qui réencoderait trois minutes de vidéo pour rien.
    const { db, c, brandDir } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    poser([attendus.mp4, attendus.variant9x16 as string, attendus.texts])
    poserEmpreinte(c, '1:1')
    const avant = fs.statSync(attendus.variant9x16 as string).mtimeMs
    putClip(db, { ...c, description: 'Corrigée après coup. #impro' })

    const résultat = await renderClip(c.id, { db, brandDir, fontsDir: polices })

    expect(résultat.skipped).toBe(true)
    expect(fs.readFileSync(attendus.texts, 'utf8')).toContain('Corrigée après coup.')
    // Rien n'a été réencodé : la variante n'a pas été touchée.
    expect(fs.statSync(attendus.variant9x16 as string).mtimeMs).toBe(avant)
  })

  it("efface la variante d'un ratio abandonné même quand il saute", async () => {
    const { db, c, brandDir } = préparer({ ratio: '9:16' })
    const attendus = cheminsRendu(ID, c.id, '9:16')
    const périmée = path.join(projets, ID, 'renders', `${c.id}-9x16.mp4`)
    poser([attendus.mp4, attendus.texts, périmée])
    poserEmpreinte(c, '9:16')

    const résultat = await renderClip(c.id, { db, brandDir, fontsDir: polices })

    expect(résultat.skipped).toBe(true)
    expect(fs.existsSync(périmée)).toBe(false)
  })

  it("répare le statut même quand il saute", async () => {
    // Un processus arrêté entre l'écriture du .txt et la mise à jour du statut
    // laisse toutes les sorties en place : sans cette réparation, chaque relance
    // sauterait et le clip resterait en « kept » pour toujours.
    const { db, c, brandDir } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    poser([attendus.mp4, attendus.variant9x16 as string, attendus.texts])
    poserEmpreinte(c, '1:1')

    await renderClip(c.id, { db, brandDir, fontsDir: polices })
    expect(getClip(db, c.id)?.status).toBe('exported')
  })

  it("écrit le .txt manquant sans relire le transcript ni rappeler ffmpeg", async () => {
    // La reprise d'un passage interrompu juste après l'encodage. Aucun transcript
    // n'existe dans ce dossier de replays jetable : si l'étape allait le lire,
    // `lireTranscript` lèverait. C'est ce qui rend ce test concluant.
    const { db, c, brandDir } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    poser([attendus.mp4, attendus.variant9x16 as string])
    poserEmpreinte(c, '1:1')

    const résultat = await renderClip(c.id, { db, brandDir, fontsDir: polices })
    expect(résultat.skipped).toBe(false)
    expect(fs.readFileSync(attendus.texts, 'utf8')).toContain('Titre : Une vanne qui tient')
    expect(getClip(db, c.id)?.status).toBe('exported')
  })

  it("efface la variante d'un ratio abandonné", async () => {
    // Le clip est repassé en 9:16, donc plus de variante due — mais celle du 1:1
    // d'avant est encore là, à ressembler à une livraison à jour.
    const { db, c, brandDir } = préparer({ ratio: '9:16' })
    const attendus = cheminsRendu(ID, c.id, '9:16')
    const périmée = path.join(projets, ID, 'renders', `${c.id}-9x16.mp4`)
    poser([attendus.mp4, périmée])
    poserEmpreinte(c, '9:16')

    const résultat = await renderClip(c.id, { db, brandDir, fontsDir: polices })
    expect(résultat.variant9x16).toBeNull()
    expect(fs.existsSync(périmée)).toBe(false)
  })

  it("n'écrase pas un texte corrigé pendant l'export", () => {
    // Le défaut relevé par Codex : `renderClip` tient un clip lu avant son
    // premier `await`, et un export dure des minutes. Réécrire cet instantané
    // pour changer une colonne rendrait au clip son titre d'avant.
    const { db, c } = préparer()
    putClip(db, { ...c, title: 'Retitré' })

    marquerExporté(db, c.id, c, cadrageDe(c))

    const relu = getClip(db, c.id)
    expect(relu?.status).toBe('exported')
    expect(relu?.title).toBe('Retitré')
  })

  it('ne ressuscite pas un clip supprimé pendant le rendu', () => {
    const { db, c } = préparer()
    db.prepare('DELETE FROM clips WHERE id = ?').run(c.id)
    marquerExporté(db, c.id, c, cadrageDe(c))
    expect(getClip(db, c.id)).toBeUndefined()
  })

  it("conserve toute décision de statut prise pendant l'encodage", () => {
    // `discarded` n'est pas le seul cas : rappuyer sur « Gardé » ramène le clip
    // à `candidate` (`src/lib/clip-status.ts`). C'est l'écart de statut qui
    // compte, pas sa valeur. (relevé par Copilot)
    for (const décidé of ['discarded', 'candidate'] as const) {
      const { db, c } = préparer()
      putClip(db, { ...c, status: décidé })

      marquerExporté(db, c.id, c, cadrageDe(c))

      expect(getClip(db, c.id)?.status).toBe(décidé)
      db.close()
    }
  })

  /**
   * **Le premier point de #48, et le plus grave.** L'écart de statut ne couvre
   * pas le montage : retirer un passage, déplacer une borne ou changer le ratio
   * laisse un clip `kept` en `kept`. `marquerExporté` posait alors `exported`
   * sur des fichiers décrivant le montage d'avant, `sortiesDuClip` publiait
   * leurs URL, et l'interface les affichait comme la livraison du jour.
   *
   * Ses deux appelants passent aussi par `écarterRenduPérimé` une ligne plus
   * haut. Ce test ne dit donc pas qu'un chemin est ouvert : il dit que la
   * garantie appartient à cette fonction, qui est exportée, plutôt qu'à l'ordre
   * de ses appels.
   */
  it("refuse « exported » quand le montage a bougé pendant l'export", () => {
    const { db, c } = préparer()
    putClip(db, { ...c, segments: [{ start: 100, end: 104 }] })

    marquerExporté(db, c.id, c, cadrageDe(c))

    expect(getClip(db, c.id)?.status).toBe('kept')
  })

  // `ratio` et `cropX` y figurent encore, et pour une raison qui a changé : ils
  // ne sont plus comparés en tant que champs du clip, mais ils décident du
  // cadrage résolu tant qu'aucune analyse n'a tourné — c'est le repli de
  // `clipFraming`, et c'est le cas de tous ces tests.
  it('refuse pareillement sur chacun des champs qui vont à l’image', () => {
    const cas: Partial<Clip>[] = [
      { segments: [{ start: 0, end: 5 }] },
      { ratio: '9:16' },
      { cropX: 0.2 },
      { captions: false },
      { branding: false },
    ]
    for (const surcharge of cas) {
      const { db, c } = préparer()
      putClip(db, { ...c, ...surcharge })

      marquerExporté(db, c.id, c, cadrageDe(c))

      expect(getClip(db, c.id)?.status).toBe('kept')
      db.close()
    }
  })

  it("pose « exported » quand rien de ce qui va à l'image n'a bougé", () => {
    // Le cas nominal reste nominal : seul le texte a changé.
    const { db, c } = préparer()
    putClip(db, { ...c, description: 'Corrigée.' })

    marquerExporté(db, c.id, c, cadrageDe(c))

    expect(getClip(db, c.id)?.status).toBe('exported')
  })

  it("écarte les fichiers d'un rendu que le montage a rendu caduc", () => {
    // Refuser le statut ne suffisait pas : les MP4 restaient là, donc l'export
    // suivant sautait et annonçait « exporté » sur le montage d'avant. On retire
    // ce qu'on sait faux. (relevé par Copilot)
    const { db, c } = préparer({ status: 'exported' })
    const chemins = cheminsRendu(ID, c.id, '1:1')
    poser([chemins.mp4, chemins.variant9x16 as string, chemins.texts])
    poserEmpreinte(c, '1:1')
    putClip(db, { ...c, status: 'exported', segments: [{ start: 0, end: 5 }] })

    expect(écarterRenduPérimé(db, c.id, chemins, c, cadrageDe(c))).toBe(true)

    expect(fs.existsSync(chemins.mp4)).toBe(false)
    expect(fs.existsSync(chemins.variant9x16 as string)).toBe(false)
    expect(fs.existsSync(chemins.texts)).toBe(false)
    // **L'empreinte part avec eux**, et elle part la première : la laisser
    // certifierait des fichiers absents, et un effacement à moitié réussi
    // ferait sauter l'export suivant sur une livraison amputée.
    expect(fs.existsSync(chemins.empreinte)).toBe(false)
    // Plus rien sur le disque ne justifie « exporté ».
    expect(getClip(db, c.id)?.status).toBe('kept')
  })

  it("ne touche à rien quand le montage n'a pas bougé", () => {
    const { db, c } = préparer()
    const chemins = cheminsRendu(ID, c.id, '1:1')
    poser([chemins.mp4, chemins.variant9x16 as string, chemins.texts])
    poserEmpreinte(c, '1:1')

    expect(écarterRenduPérimé(db, c.id, chemins, c, cadrageDe(c))).toBe(false)
    expect(fs.existsSync(chemins.mp4)).toBe(true)
    expect(fs.existsSync(chemins.empreinte)).toBe(true)
  })

  /**
   * **Le résolveur du cadrage relu est injectable, et ce n'est pas du confort.**
   *
   * `clipFraming` lit `analysis.json`, donc peut lever. Appelée depuis
   * `PATCH /api/clips/:id`, cette fonction s'exécute *après* l'écriture en base,
   * et le rattrapage de la route redescend alors un clip `exported` à `kept` :
   * une panne passagère de système de fichiers ferait disparaître les sorties
   * d'un rendu parfaitement valide, sur une simple correction de titre. La route
   * passe donc un résolveur bâti sur l'analyse lue avant d'écrire.
   * (relevé par Codex)
   */
  it('utilise le résolveur qu’on lui donne plutôt que de relire l’analyse', () => {
    const { db, c } = préparer()
    const chemins = cheminsRendu(ID, c.id, '1:1')
    poser([chemins.mp4, chemins.variant9x16 as string, chemins.texts])
    poserEmpreinte(c, '1:1')

    let appels = 0
    const résolveur = (clip: Clip): RenderedFraming => {
      appels += 1
      return cadrageDe(clip)
    }
    expect(écarterRenduPérimé(db, c.id, chemins, c, cadrageDe(c), résolveur)).toBe(false)
    expect(appels).toBe(1)

    // Et un résolveur qui rend un autre cadrage périme, sans qu'aucun champ du
    // clip n'ait bougé : c'est bien lui qui décide, pas une relecture cachée.
    expect(
      écarterRenduPérimé(db, c.id, chemins, c, cadrageDe(c), () => cadrage({ ratio: '4:5' })),
    ).toBe(true)
    expect(fs.existsSync(chemins.mp4)).toBe(false)
  })

  it('refuse un clip inconnu', async () => {
    const { db, brandDir } = préparer()
    await expect(renderClip('clip_inexistant', { db, brandDir, fontsDir: polices })).rejects.toThrow(/Clip inconnu/)
  })

  it("refuse un clip sans segment, plutôt que de rendre un fichier vide", async () => {
    const { db, c, brandDir } = préparer({ segments: [] })
    await expect(renderClip(c.id, { db, brandDir, fontsDir: polices })).rejects.toThrow(/aucun segment/)
  })

  it("refuse un clip vidé après un premier export, au lieu de sauter dessus", async () => {
    // L'édition autorise de vider un clip, et ses anciens fichiers sont encore
    // là : sans validation avant la décision de saut, il ressortirait
    // `skipped: true` et marqué exporté. (relevé par Copilot)
    const { db, c, brandDir } = préparer({ segments: [] })
    const attendus = cheminsRendu(ID, c.id, '1:1')
    poser([attendus.mp4, attendus.variant9x16 as string, attendus.texts])

    await expect(renderClip(c.id, { db, brandDir, fontsDir: polices })).rejects.toThrow(/aucun segment/)
    expect(getClip(db, c.id)?.status).toBe('kept')
  })

  it("dit quoi faire quand la copie de travail a disparu", async () => {
    const { db, c, brandDir } = préparer()
    // Rien dans `stage/` : `stagedPath` est transitoire par contrat.
    await expect(renderClip(c.id, { db, brandDir, fontsDir: polices })).rejects.toThrow(/copie de travail/)
  })

  // **La variante réclame la source, même quand le natif est déjà là**, et c'est
  // le correctif de #22 vu depuis cette fonction : elle ne dérive plus du MP4
  // natif, donc son fond ne peut plus en hériter les sous-titres. Avant, ce cas
  // sautait la préparation et lançait ffmpeg sur le natif ; il exige maintenant
  // la copie de travail, et le dit.
  it("réclame la source quand seule la variante manque", async () => {
    const { db, c, brandDir } = préparer()
    const attendus = cheminsRendu(ID, c.id, '1:1')
    poser([attendus.mp4, attendus.texts])
    poserEmpreinte(c, '1:1')

    await expect(renderClip(c.id, { db, brandDir, fontsDir: polices })).rejects.toThrow(/copie de travail/)
  })
})
