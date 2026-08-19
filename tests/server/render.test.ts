import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CAPTION_STYLE } from '@/core/captions/ass'
import type { Clip, Ratio } from '@/core/edl'
import { cleanPaths } from '@/core/errors'
import type { Word } from '@/core/transcript'
import { openDb, upsertProject, putClip, getClip } from '@/server/db'
import {
  pathsRender,
  collectMarkers,
  discardRenderStale,
  fontsDigest,
  lFingerprintGap,
  type ObservedBurnIn,
  type CaptionsLook,
  renderFingerprint,
  renderEstStale,
  markersHaveMoved,
  lireFingerprint,
  markExported,
  wordsHash,
  scheduleMarkers,
  redoOutputs,
  markerRejectFaute,
  renderClip,
  sauterRender,
  clipUnderTitles,
  publicationText,
  VERSION_FINGERPRINT,
  renderedFraming,
  renderedShape,
  type RenderedFraming,
  type ShapeRendered,
  type MarkerNative,
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

let root: string
let replay: string
let stage: string
let projects: string
/**
 * Le dossier de polices de ces tests, **jetable et vide**. Sans lui, le condensat
 * du look dépendrait du `fonts/` du dépôt — peuplé sur la machine de l'opérateur,
 * réduit en CI —, et le verdict de l'empreinte varierait avec la machine.
 */
let fonts: string
const envStart = { ...process.env }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-render-'))
  replay = path.join(root, 'Replay')
  stage = path.join(root, 'stage')
  projects = path.join(root, 'projects')
  fonts = path.join(root, 'polices-vides')
  for (const d of [replay, stage, projects, fonts]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(replay, SOURCE), 'pas vraiment une vidéo')

  process.env.REPLAY_DIR = replay
  process.env.STAGE_DIR = stage
  process.env.PROJECTS_DIR = projects
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  process.env = { ...envStart }
  // **Le cache d'analyses se vide entre deux tests.** Il est indexé sur le
  // chemin, la taille et la date du fichier ; chaque test refabrique son
  // `PROJECTS_DIR` sous un nom neuf, mais un test qui poserait deux
  // `analysis.json` de suite au même endroit relirait sinon le premier.
  forgetAnalyses()
})

function clip(overrides: Partial<Clip> = {}): Clip {
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
    ...overrides,
  }
}

/**
 * Des marques, dans la forme que `collecterMarques` rendrait.
 *
 * `contenu` dérive du nom par défaut : deux appels avec les mêmes noms rendent
 * les mêmes marques, et il suffit de passer un contenu explicite pour simuler
 * un fichier remplacé sous le même nom.
 */
function markersNamed(
  names: readonly string[],
  content: (name: string) => string = (name) => `contenu-de-${name}`,
): MarkerNative[] {
  return names.map((name) => ({
    path: path.join('/nulle-part', name),
    nativeW: 1000,
    nativeH: 996,
    largeurRatio: 0.22,
    bord: 'gauche' as const,
    contenu: content(name),
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
function framingFor(c: Clip): RenderedFraming {
  return renderedFraming(clipFraming(c))
}

/**
 * Le cadrage d'un clip, dans la forme réduite que l'empreinte retient.
 *
 * Un plan unique qui couvre le clip de référence, en 1:1 centré. C'est le cas
 * le plus simple, et celui qui laisse chaque test surcharger ce qu'il mesure.
 */
function framing(overrides: Partial<RenderedFraming> = {}): RenderedFraming {
  return {
    ratio: '1:1',
    shots: [{ start: 0, end: 20, ratio: '1:1', cropX: 0.5, cropXNative: 0.5 }],
    ...overrides,
  }
}

/**
 * Un clip et son cadrage, tels que `leRenduEstPérimé` les compare.
 *
 * Le cadrage n'est pas un champ du clip : il se recalcule sur ses segments, et
 * c'est justement pour cela qu'il entre dans l'empreinte — une redétection des
 * plans peut déplacer tous les crops sans qu'aucun champ du clip ne bouge.
 */
function shape(c: Clip = clip(), cad: RenderedFraming = framing()): ShapeRendered {
  return renderedShape(c, cad)
}

/**
 * `empreinteDuRendu` avec le preset par défaut, celui de tous ces tests-ci.
 * Le condensat du preset n'entre dans l'empreinte que si un document a été
 * incrusté — d'où le troisième paramètre.
 */
function fingerprintWith(
  c: Clip,
  markers: readonly MarkerNative[],
  burnedIn = true,
  cad: RenderedFraming = framing(),
): ReturnType<typeof renderFingerprint> {
  return renderFingerprint(shape(c, cad), markers, { burnedIn, look: look(), text: null })
}

/** Le look de référence : le preset par défaut, sur le dossier de polices vide. */
function look(): CaptionsLook {
  return { style: DEFAULT_CAPTION_STYLE, fonts: fontsDigest(fonts) }
}

/** Ce que l'appelant a sondé de ce qu'on incrusterait : rien, sauf mention. */
function observed(overrides: Partial<ObservedBurnIn> = {}): ObservedBurnIn {
  return { markers: null, look: null, text: undefined, ...overrides }
}

/**
 * L'empreinte qu'un rendu réussi aurait laissée à côté de ses sorties.
 *
 * Elle passe par `empreinteDuRendu` plutôt que par un littéral : un champ ajouté
 * au format doit casser ces tests, pas les laisser poser un fichier que la
 * lecture refuserait en silence.
 */
function poserFingerprint(
  c: Clip,
  ratio: Ratio,
  markers: readonly string[] = [],
  underTitles = c.captions,
): void {
  const path = pathsRender(ID, c.id, ratio).fingerprint
  fs.mkdirSync(path.dirname(path), { recursive: true })
  // **Le cadrage résolu, et non un littéral** : c'est celui que `renderClip`
  // recalcule à chaque passage, donc le seul qui puisse faire dire à l'empreinte
  // qu'elle décrit encore le clip.
  fs.writeFileSync(
    path,
    JSON.stringify(fingerprintWith(c, markersNamed(markers), underTitles, framingFor(c))),
  )
}

describe('cheminsRendu', () => {
  it('nomme les sorties depuis le dossier de rendus du projet', () => {
    const c = pathsRender(ID, 'clip_0001', '1:1')
    expect(c.mp4).toBe(path.join(projects, ID, 'renders', 'clip_0001.mp4'))
    expect(c.variant9x16).toBe(path.join(projects, ID, 'renders', 'clip_0001-9x16.mp4'))
    expect(c.texts).toBe(path.join(projects, ID, 'renders', 'clip_0001.txt'))
    expect(c.ass).toBe(path.join(projects, ID, 'renders', 'clip_0001.ass'))
  })

  it("ne demande pas de variante quand le clip est déjà en 9:16", () => {
    expect(pathsRender(ID, 'clip_0001', '9:16').variant9x16).toBeNull()
  })

  it('en demande une pour chacun des trois autres ratios (spec §11)', () => {
    for (const ratio of ['4:5', '1:1', '16:9'] as const) {
      expect(pathsRender(ID, 'clip_0001', ratio).variant9x16).not.toBeNull()
    }
  })

  it("refuse un identifiant de clip qui sortirait du dossier du projet", () => {
    // `clipId` arrive du réseau : `POST /api/clips/:id/export` le prend dans
    // l'URL, et `putClip` ne valide ni son format ni son contenu.
    for (const bad of ['../evade', 'a/b', 'a\\b', '', '.', '..', 'a\0b']) {
      expect(() => pathsRender(ID, bad, '1:1')).toThrow(/Identifiant de clip invalide/)
    }
  })

  it('accepte les accents et les espaces, comme les noms de replays', () => {
    expect(() => pathsRender(ID, 'clip été 01', '1:1')).not.toThrow()
  })
})

describe('sauterLeRendu', () => {
  const paths = pathsRender.bind(null, ID, 'clip_0001')

  it('saute quand les trois sorties sont là et que l’empreinte les décrit', () => {
    const c = paths('1:1')
    expect(sauterRender(c, () => true, true)).toBe(true)
  })

  it("ne saute pas quand il manque le .txt, même si le MP4 est là", () => {
    const c = paths('1:1')
    expect(sauterRender(c, (path) => path !== c.texts, true)).toBe(false)
  })

  it('ne saute pas quand il manque la variante', () => {
    const c = paths('1:1')
    expect(sauterRender(c, (path) => path !== c.variant9x16, true)).toBe(false)
  })

  it("n'attend pas de variante en 9:16", () => {
    const c = paths('9:16')
    // Rien d'autre que le MP4 et le texte n'existe : la variante n'est pas due.
    expect(sauterRender(c, (path) => path === c.mp4 || path === c.texts, true)).toBe(true)
  })

  it('ne saute jamais sous `force`', () => {
    expect(sauterRender(paths('1:1'), () => true, true, true)).toBe(false)
  })

  it("ignore le .ass, qui est un intermédiaire et non une sortie", () => {
    const c = paths('9:16')
    expect(sauterRender(c, (path) => path !== c.ass, true)).toBe(true)
  })

  /**
   * **Le deuxième point de #48.** Trois `existsSync` disaient « complet », donc
   * « à jour ». Un jeu de fichiers laissé par un montage abandonné, ou produit
   * sous une recette antérieure, les satisfaisait aussi bien qu'une livraison.
   */
  it("ne saute pas quand l'empreinte ne décrit pas le clip, fichiers complets", () => {
    expect(sauterRender(paths('1:1'), () => true, false)).toBe(false)
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
  const paths = pathsRender.bind(null, ID, 'clip_0001')

  it('ne rallume pas ffmpeg quand les deux MP4 sont là', () => {
    expect(redoOutputs(paths('1:1'), () => true, true)).toBe(false)
  })

  it("laisse le .txt seul se réécrire, sans réencoder une image", () => {
    const c = paths('1:1')
    expect(redoOutputs(c, (path) => path !== c.texts, true)).toBe(false)
  })

  it('refait le natif quand seule la variante manque', () => {
    // Le cas qui compte : le natif est là, mais il porte peut-être le montage
    // d'un passage précédent. Le garder pendant qu'on rend la variante depuis
    // l'instantané d'aujourd'hui livrerait deux fichiers montrant deux cadres.
    const c = paths('1:1')
    expect(redoOutputs(c, (path) => path !== c.variant9x16, true)).toBe(true)
  })

  it('refait la variante quand seul le natif manque', () => {
    const c = paths('1:1')
    expect(redoOutputs(c, (path) => path !== c.mp4, true)).toBe(true)
  })

  it("n'attend pas de variante en 9:16", () => {
    const c = paths('9:16')
    expect(redoOutputs(c, (path) => path === c.mp4, true)).toBe(false)
  })

  it('réencode toujours sous `force`', () => {
    expect(redoOutputs(paths('1:1'), () => true, true, true)).toBe(true)
  })

  it("ignore le .ass, qui se réécrit à chaque passage", () => {
    const c = paths('1:1')
    expect(redoOutputs(c, (path) => path !== c.ass, true)).toBe(false)
  })

  /**
   * Sans cette ligne, le correctif de `sauterLeRendu` ne ferait que déplacer le
   * mensonge : un jeu de MP4 complet mais périmé sauterait l'encodage pour n'y
   * réécrire que le `.txt`, et repartirait `exported`.
   */
  it("rallume ffmpeg quand l'empreinte ne décrit pas le clip, fichiers complets", () => {
    expect(redoOutputs(paths('1:1'), () => true, false)).toBe(true)
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
    const expected = path.join(projects, ID, 'renders', 'clip_0001.rendu.json')
    for (const ratio of ['9:16', '4:5', '1:1', '16:9'] as const) {
      expect(pathsRender(ID, 'clip_0001', ratio).fingerprint).toBe(expected)
    }
  })

  it('porte les champs du clip, le cadrage résolu, la version et ce qui a été incrusté', () => {
    const e = fingerprintWith(clip(), markersNamed(['twitch.png', 'logo.png']))
    expect(e).toEqual({
      version: VERSION_FINGERPRINT,
      segments: clip().segments,
      captions: true,
      branding: true,
      // **Le cadrage résolu, pas `clip.ratio` ni `clip.cropX`.** Ceux-là ne
      // décrivent plus l'image : le ratio effectif est celui que le calcul
      // choisit — par plan pour la variante, le plus large pour le natif — et
      // le crop se calcule par plan.
      framing: framing(),
      // Triées : l'ordre de lecture d'un dossier n'a rien à dire.
      marks: [
        { name: 'logo.png', content: 'contenu-de-logo.png' },
        { name: 'twitch.png', content: 'contenu-de-twitch.png' },
      ],
      // Le condensat du preset, et non un booléen : il dit avec quel look.
      captionsLook: e.captionsLook,
      // Le condensat de ce qui a été réellement incrusté (#87) — `null` ici :
      // `empreinteAvec` fixe `texte: null`, et ces tests-ci ne portent pas sur
      // le contenu du transcript.
      captionsContent: null,
    })
  })

  it("consigne l'absence de sous-titres sur un clip qui en demandait", () => {
    // Un clip dont aucun mot ne tombe dans les segments se rend sans, en le
    // journalisant. L'empreinte dit ce qui a été incrusté, pas ce qui était
    // demandé — les deux champs sont là et ils divergent.
    const e = fingerprintWith(clip({ captions: true }), [], false)
    expect(e.captions).toBe(true)
    expect(e.captionsLook).toBeNull()
  })

  describe('écartDeLEmpreinte', () => {
    const markers = markersNamed(['logo.png'])
    const toSide = (overrides: Partial<Clip> = {}): ReturnType<typeof renderFingerprint> =>
      fingerprintWith(clip(overrides), markers)

    it('ne trouve rien à redire quand tout concorde', () => {
      expect(lFingerprintGap(toSide(), shape(), observed({ markers }))).toBeNull()
    })

    it("dit « absente » sur un rendu qui n'en a pas — les trois du 18 août", () => {
      expect(lFingerprintGap(null, shape(), observed({ markers }))).toBe('absente')
    })

    it('dit « recette » sur une version qui n’est plus la nôtre', () => {
      const old = { ...toSide(), version: VERSION_FINGERPRINT - 1 }
      expect(lFingerprintGap(old, shape(), observed({ markers }))).toBe('recette')
    })

    it('dit « montage » sur chacun des champs qui vont à l’image', () => {
      const scenarios: Partial<Clip>[] = [
        { segments: [{ start: 0, end: 5 }] },
        { captions: false },
        { branding: false },
      ]
      for (const override of scenarios) {
        expect(lFingerprintGap(toSide(), shape(clip(override)), observed({ markers }))).toBe(
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
      const scenarios: Partial<RenderedFraming>[] = [
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
      for (const override of scenarios) {
        expect(
          lFingerprintGap(toSide(), shape(clip(), framing(override)), observed({ markers })),
        ).toBe('montage')
      }
    })

    // **Deux tableaux de crops identiques ne sont jamais le même objet.**
    // Comparés par référence, chaque appel périmerait le rendu : l'export
    // réencoderait à chaque passage, et `skipped` ne serait plus jamais vrai.
    it('ne périme rien sur un cadrage identique mais reconstruit', () => {
      expect(
        lFingerprintGap(toSide(), shape(clip(), framing()), observed({ markers })),
      ).toBeNull()
    })

    it("ignore le titre, la description et le statut, qui ne vont pas à l'image", () => {
      const indifferent: Partial<Clip>[] = [
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
      for (const override of indifferent) {
        expect(lFingerprintGap(toSide(), shape(clip(override)), observed({ markers }))).toBeNull()
      }
    })

    it('dit « marques » quand une marque a été déposée depuis le rendu', () => {
      const two = markersNamed(['logo.png', 'twitch.png'])
      expect(lFingerprintGap(toSide(), shape(), observed({ markers: two }))).toBe('marques')
    })

    it('dit « marques » quand une marque a été retirée du dossier', () => {
      const fingerprint = fingerprintWith(clip(), markersNamed(['logo.png', 'twitch.png']))
      expect(lFingerprintGap(fingerprint, shape(), observed({ markers }))).toBe('marques')
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
      const burnedIn = fingerprintWith(clip(), markers)
      const other = { ...look(), style: { ...DEFAULT_CAPTION_STYLE, fontSize: 52 } }
      expect(lFingerprintGap(burnedIn, shape(), observed({ look: other }))).toBe('style')
      expect(lFingerprintGap(burnedIn, shape(), observed({ look: look() }))).toBeNull()
    })

    it("ignore l'ordre des clés du preset, qui ne change pas une image", () => {
      // `JSON.stringify` suit l'ordre d'insertion : sans tri, réordonner le
      // littéral de `DEFAULT_CAPTION_STYLE` périmerait tous les rendus du disque.
      const reordered = Object.fromEntries(
        Object.entries(DEFAULT_CAPTION_STYLE).reverse(),
      ) as typeof DEFAULT_CAPTION_STYLE
      expect(
        lFingerprintGap(
          fingerprintWith(clip(), markers),
          shape(),
          observed({ look: { ...look(), style: reordered } }),
        ),
      ).toBeNull()
    })

    it("ne juge pas du preset quand aucun sous-titre n'a été incrusté", () => {
      // Le preset n'a alors rien décrit de l'image : le comparer périmerait au
      // premier réglage de police un clip qui n'en porte pas.
      const withoutUnderTitles = fingerprintWith(clip({ captions: false }), markers, false)
      const other = { ...look(), style: { ...DEFAULT_CAPTION_STYLE, fontSize: 12 } }
      expect(
        lFingerprintGap(
          withoutUnderTitles,
          shape(clip({ captions: false })),
          observed({ look: other }),
        ),
      ).toBeNull()
    })

    it('ne juge pas du preset quand on ne le lui donne pas', () => {
      const burnedIn = fingerprintWith(clip(), markers)
      expect(lFingerprintGap(burnedIn, shape(), observed())).toBeNull()
    })

    it('ne juge pas des marques quand on ne les lui donne pas', () => {
      const fingerprint = fingerprintWith(clip(), markersNamed(['logo.png', 'twitch.png']))
      expect(lFingerprintGap(fingerprint, shape(), observed())).toBeNull()
      // Le reste continue de compter.
      expect(
        lFingerprintGap(fingerprint, shape(clip(), framing({ ratio: '4:5' })), observed()),
      ).toBe('montage')
    })
  })

  describe('lesMarquesOntBougé', () => {
    it("ne périme rien quand le dossier est vide et que le clip en demandait", () => {
      // Les deux PNG ont vraiment disparu d'`assets/brand/` le 18 août. Un clip
      // qui demande des marques dont aucune n'est exploitable ne peut pas se
      // rendre (#37) : périmer son rendu changerait une livraison correcte en
      // export qui refuse.
      const fingerprint = fingerprintWith(clip(), markersNamed(['logo.png']))
      expect(markersHaveMoved(fingerprint, [], true)).toBe(false)
    })

    it('périme quand le clip ne demandait pas de marque et qu’il en reste une', () => {
      // Le dossier vide n'excuse que le clip qui en demande. Ici l'empreinte
      // porte une marque incrustée alors que plus rien ne devrait l'être.
      const fingerprint = fingerprintWith(clip({ branding: false }), markersNamed(['logo.png']))
      expect(markersHaveMoved(fingerprint, [], false)).toBe(true)
    })

    it("compare sans tenir compte de l'ordre", () => {
      const fingerprint = {
        ...fingerprintWith(clip(), []),
        marks: [
          { name: 'twitch.png', content: 'contenu-de-twitch.png' },
          { name: 'logo.png', content: 'contenu-de-logo.png' },
        ],
      }
      expect(markersHaveMoved(fingerprint, markersNamed(['logo.png', 'twitch.png']), true)).toBe(
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
      const fingerprint = fingerprintWith(clip(), markersNamed(['logo.png']))
      const replaced = markersNamed(['logo.png'], () => 'une tout autre image')
      expect(markersHaveMoved(fingerprint, replaced, true)).toBe(true)
    })
  })

  /**
   * Le condensat du dossier de polices, isolé : c'est lui qui distingue un rendu
   * incrusté avec Anton d'un rendu incrusté avec le repli de fontconfig, et deux
   * versions d'Anton l'une de l'autre. (relevé par Copilot et par Codex)
   */
  describe('condensatDesPolices', () => {
    const poser = (name: string, content: string): void => {
      fs.writeFileSync(path.join(fonts, name), content)
    }

    it("confond un dossier vide et un dossier absent, qui rendent la même image", () => {
      // Les deux mènent au même repli fontconfig. Les distinguer périmerait un
      // rendu sur la seule création d'un dossier vide.
      expect(fontsDigest(fonts)).toBe(fontsDigest(path.join(root, 'jamais')))
    })

    it('change quand une police arrive', () => {
      const empty = fontsDigest(fonts)
      poser('Anton-Regular.ttf', 'pas vraiment une police')
      expect(fontsDigest(fonts)).not.toBe(empty)
    })

    it("change quand une police est remplacée sous le même nom", () => {
      poser('Anton-Regular.ttf', 'la version d’hier')
      const before = fontsDigest(fonts)
      poser('Anton-Regular.ttf', 'la version d’aujourd’hui')
      expect(fontsDigest(fonts)).not.toBe(before)
    })

    it("ne bouge pas pour un fichier que libass ne chargera pas", () => {
      poser('Anton-Regular.ttf', 'pas vraiment une police')
      const before = fontsDigest(fonts)
      poser('README.md', 'où trouver Anton')
      expect(fontsDigest(fonts)).toBe(before)
    })

    it("ne dépend pas de l'ordre de lecture du dossier", () => {
      poser('a.ttf', 'une')
      poser('b.otf', 'deux')
      const expected = fontsDigest(fonts)
      fs.rmSync(path.join(fonts, 'a.ttf'))
      poser('a.ttf', 'une')
      expect(fontsDigest(fonts)).toBe(expected)
    })
  })

  describe('lireEmpreinte', () => {
    const path = (): string => pathsRender(ID, 'clip_0001', '1:1').fingerprint

    it("rend null sur un fichier absent, et c'est le cas normal", () => {
      expect(lireFingerprint(path())).toBeNull()
    })

    it('relit ce que `empreinteDuRendu` a écrit', () => {
      const c = clip()
      poserFingerprint(c, '1:1', ['logo.png'])
      // `poserEmpreinte` écrit le cadrage **résolu** : le relire suppose de le
      // recalculer de la même façon, sinon on compare deux cadrages différents.
      expect(lireFingerprint(path())).toEqual(
        fingerprintWith(c, markersNamed(['logo.png']), c.captions, framingFor(c)),
      )
    })

    it("rend null sur un JSON tronqué — un processus tué en pleine écriture", () => {
      fs.mkdirSync(path.dirname(path()), { recursive: true })
      fs.writeFileSync(path(), '{"version": 1, "segm')
      expect(lireFingerprint(path())).toBeNull()
    })

    it('rend null sur un fichier bien formé mais qui n’est pas une empreinte', () => {
      fs.mkdirSync(path.dirname(path()), { recursive: true })
      fs.writeFileSync(path(), JSON.stringify({ version: VERSION_FINGERPRINT }))
      expect(lireFingerprint(path())).toBeNull()
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
      const warnings: unknown[][] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
        warnings.push(a)
      })
      fs.mkdirSync(path.dirname(path()), { recursive: true })
      fs.writeFileSync(
        path(),
        JSON.stringify({
          version: VERSION_FINGERPRINT - 1,
          segments: clip().segments,
          ratio: '1:1',
          cropX: 0.5,
          captions: true,
          branding: true,
          marques: [],
          sousTitres: null,
        }),
      )
      expect(lireFingerprint(path())).toBeNull()
      expect(String(warnings[0]?.[0])).toMatch(
        new RegExp(`version ${VERSION_FINGERPRINT - 1}`),
      )
      expect(String(warnings[0]?.[0])).not.toMatch(/illisible/)
      spy.mockRestore()
    })

    /**
     * **Le cas concret de l'issue #73.** `VERSION_EMPREINTE` est passée de 3 à 4
     * avec la traduction des clés persistées (`marques` → `marks`, `sousTitres`
     * → `captionsLook`) : une empreinte réellement laissée par la recette
     * d'avant porte encore ces deux noms français, et ce test l'écrit telle
     * quelle plutôt que par `VERSION_EMPREINTE - 1`, pour que la preuve ne
     * dépende pas de la valeur courante de la constante. `lireEmpreinte` doit
     * la périmer sans lever — la version tranche avant que le nouveau schéma ne
     * la voie — exactement comme les trois rendus déjà sur le disque au moment
     * de cette PR (aucun n'a de marque incrustée, voir `ROADMAP.md`).
     */
    it('périme proprement une empreinte en version 3, sans lever', () => {
      const warnings: unknown[][] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
        warnings.push(a)
      })
      fs.mkdirSync(path.dirname(path()), { recursive: true })
      fs.writeFileSync(
        path(),
        JSON.stringify({
          version: 3,
          segments: clip().segments,
          captions: true,
          branding: true,
          framing: framing(),
          marques: [{ nom: 'logo.png', contenu: 'contenu-de-logo.png' }],
          sousTitres: 'un-condensat',
          captionsContent: 'un-autre-condensat',
        }),
      )
      expect(() => lireFingerprint(path())).not.toThrow()
      expect(lireFingerprint(path())).toBeNull()
      // **La distinction qui compte** (voir le commentaire de `lireEmpreinte`) :
      // une recette antérieure n'est pas un fichier illisible. Si
      // `VERSION_EMPREINTE` n'avait pas été montée à 4 avec cette traduction, la
      // version stockée matcherait encore la version courante, le fichier
      // passerait au schéma — qui ne connaît plus `marques`/`sousTitres` — et le
      // message basculerait sur « illisible », le mauvais diagnostic.
      expect(String(warnings[0]?.[0])).toMatch(/version 3/)
      expect(String(warnings[0]?.[0])).not.toMatch(/illisible/)
      spy.mockRestore()
    })

    it("garde un champ inconnu sans s'en offusquer : c'est `version` qui tranche", () => {
      // Une version ultérieure ajoutera des champs. Refuser d'analyser dirait
      // « illisible » d'un fichier parfaitement formé, alors que le seul verdict
      // qui vaille est celui de `version`.
      const c = clip()
      const raw = { ...fingerprintWith(c, []), venuDuFutur: 42 }
      fs.mkdirSync(path.dirname(path()), { recursive: true })
      fs.writeFileSync(path(), JSON.stringify(raw))
      expect(lireFingerprint(path())?.version).toBe(VERSION_FINGERPRINT)
    })

    it("ne publie aucun chemin absolu dans ce qu'il journalise", () => {
      // Le journal d'un `GET` finit sous les yeux de qui lit les traces, et le
      // chemin porte l'arborescence de la machine.
      const messages: string[] = []
      const before = console.warn
      console.warn = (...args: unknown[]) => void messages.push(args.join(' '))
      try {
        fs.mkdirSync(path.dirname(path()), { recursive: true })
        fs.writeFileSync(path(), 'pas du json')
        lireFingerprint(path())
      } finally {
        console.warn = before
      }
      expect(messages.length).toBe(1)
      expect(messages[0]).toContain('clip_0001.rendu.json')
      expect(messages[0]).not.toContain(projects)
    })
  })
})

/**
 * La doctrine de `branding.py:63-70`, reprise comme raisonnement (spec §15).
 * Chacun de ces tests fige une décision qui a coûté une mesure là-bas.
 */
describe('planifierMarques', () => {
  const logo = (nativeW: number, nativeH: number): MarkerNative => ({
    path: '/marques/logo.png',
    nativeW,
    nativeH,
    widthRatio: 0.22,
    edge: 'gauche',
    content: 'peu importe : le placement ne lit pas le contenu',
  })
  const mention = (nativeW: number, nativeH: number): MarkerNative => ({
    path: '/marques/twitch.png',
    nativeW,
    nativeH,
    widthRatio: 0.16,
    edge: 'droite',
    content: 'peu importe : le placement ne lit pas le contenu',
  })

  it('ne pose rien quand le dossier des marques est vide', () => {
    expect(scheduleMarkers(1080, 1920, [])).toEqual([])
  })

  it("épingle le bord SUPÉRIEUR de la bande à 13 %, pas son centre", () => {
    // Le cas mesuré chez openshorts : un logo 3:1 ancré par son centre à 0,13
    // remettait son bord supérieur à 0,109, soit sous la barre d'onglets de
    // TikTok. Épinglé par le haut, il reste à 0,13 quel que soit son format.
    for (const shape of [logo(3, 1), logo(1, 1), logo(1, 2)]) {
      const [place] = scheduleMarkers(1080, 1920, [shape])
      expect(place.y).toBe(Math.round(1920 * 0.13))
    }
  })

  it('plafonne la hauteur à 6 % par marque, et non par bande', () => {
    // Un logo carré à 22 % de largeur ferait 22 % de la hauteur d'un 1:1. La
    // mention, elle, tient déjà : elle ne doit pas rétrécir avec lui.
    const placed = scheduleMarkers(1080, 1080, [logo(1, 1), mention(4, 1)])
    const [square, wide] = placed
    expect(square.h).toBeLessThanOrEqual(1080 * 0.06)
    // La mention garde sa largeur nominale : 16 % de 1080, arrondi au pair.
    expect(wide.w).toBe(172)
  })

  it('centre les marques les unes sur les autres sous ce bord supérieur', () => {
    const [square, wide] = scheduleMarkers(1080, 1920, [logo(1, 1), mention(4, 1)])
    const center = (m: { y: number; h: number }): number => m.y + m.h / 2
    expect(Math.abs(center(square) - center(wide))).toBeLessThanOrEqual(1)
    const moreHigh = square.h >= wide.h ? square : wide
    expect(moreHigh.y).toBe(Math.round(1920 * 0.13))
  })

  it('respecte la marge de 5 % des deux côtés', () => {
    const [left, right] = scheduleMarkers(1080, 1920, [logo(3, 1), mention(4, 1)])
    const margin = Math.round(1080 * 0.05)
    expect(left.x).toBe(margin)
    expect(right.x + right.w).toBe(1080 - margin)
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
      for (const markers of [[logo(3, 1), mention(4, 1)], [logo(1, 1)], [mention(1, 3)]]) {
        for (const place of scheduleMarkers(w, h, markers)) {
          expect(place.y).toBeGreaterThanOrEqual(h * 0.12)
          expect(place.y + place.h).toBeLessThan(h * 0.59)
          expect(place.x).toBeGreaterThanOrEqual(0)
          expect(place.x + place.w).toBeLessThanOrEqual(w)
        }
      }
    }
  })

  it('rend des dimensions paires', () => {
    for (const place of scheduleMarkers(1080, 1920, [logo(7, 3), mention(13, 5)])) {
      expect(place.w % 2).toBe(0)
      expect(place.h % 2).toBe(0)
    }
  })

  it('remonte une très petite marque au plancher de lisibilité', () => {
    // 22 % de 200 pixels font 44, illisible sur un téléphone. Le plancher est à
    // 80 — sous réserve de tenir entre les marges.
    const [place] = scheduleMarkers(200, 356, [logo(4, 1)])
    expect(place.w).toBe(80)
  })
})

/**
 * L'enchaînement des sous-titres, qui est **le seul endroit de cette étape où
 * l'on peut se tromper sans rien casser de mesurable**. `retimeWords` est testé
 * pour lui-même ailleurs ; ce qui se teste ici, c'est qu'il soit bien appelé, et
 * que le preset traverse jusqu'au découpage.
 */
describe('sousTitresDuClip', () => {
  const words: Word[] = [
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
    const ass = clipUnderTitles(words, segments, DEFAULT_CAPTION_STYLE)
    expect(ass).not.toBeNull()
    // Le premier segment dure 5 s, donc le premier mot du second segment tombe à
    // 5,00 s dans le clip — et surtout pas à 1:40, son heure dans l'émission.
    expect(ass).toContain('0:00:05.00')
    expect(ass).not.toContain('0:01:40')
    // Le premier mot du clip est à l'origine.
    expect(ass).toContain('Dialogue: 0,0:00:00.00')
  })

  it('laisse tomber les mots pris dans une coupe interne', () => {
    expect(clipUnderTitles(words, segments, DEFAULT_CAPTION_STYLE)).not.toContain('COUPÉ')
  })

  it('passe maxChars et maxDuration du preset au découpage', () => {
    // `renderAss` ne lit pas ces deux réglages : si l'enchaînement ne les
    // transmet pas lui-même à `splitIntoCards`, un preset personnalisé garde le
    // découpage par défaut, en silence.
    const tight = { ...DEFAULT_CAPTION_STYLE, maxChars: 3 }
    const wide = { ...DEFAULT_CAPTION_STYLE, maxChars: 200, maxDuration: 60 }
    // Un carton donne un événement par mot, tous porteurs du même texte à la
    // surbrillance près : compter les textes distincts compte les cartons.
    const cards = (ass: string | null): number =>
      new Set(
        (ass ?? '')
          .split('\n')
          .filter((l) => l.startsWith('Dialogue:'))
          .map((l) => l.slice(l.lastIndexOf(',,') + 2).replace(/\{[^}]*\}/g, '')),
      ).size
    expect(cards(clipUnderTitles(words, segments, tight))).toBeGreaterThan(
      cards(clipUnderTitles(words, segments, wide)),
    )
  })

  it("rend null quand aucun mot ne tombe dans les segments", () => {
    expect(clipUnderTitles(words, [{ start: 500, end: 510 }], DEFAULT_CAPTION_STYLE)).toBeNull()
  })
})

describe('leRenduEstPérimé', () => {
  it('est faux quand rien de ce qui va à l’image n’a bougé', () => {
    expect(renderEstStale(shape(), shape())).toBe(false)
  })

  it("ignore le titre et la description, qui ne vont que dans le .txt", () => {
    expect(renderEstStale(shape(), shape(clip({ title: 'Autre', description: 'Autre' })))).toBe(
      false,
    )
  })

  it("ignore le statut et le numéro de passe", () => {
    expect(renderEstStale(shape(), shape(clip({ status: 'exported', pass: 9 })))).toBe(false)
  })

  // `ratio` et `cropX` du clip sont sortis de la comparaison quand le cadrage
  // automatique est entré en service : ils ne décrivent plus l'image. Les garder
  // ferait réencoder pour rien un clip qu'on épingle sur le ratio que le calcul
  // avait déjà choisi.
  it("ignore le ratio demandé et le cropX du clip, que l'encodage ne lit plus", () => {
    expect(renderEstStale(shape(), shape(clip({ ratio: '4:5', cropX: 0.2 })))).toBe(false)
  })

  it('voit chacun des champs du clip qui vont à l’image', () => {
    const scenarios: Partial<Clip>[] = [
      { segments: [{ start: 0, end: 5 }] },
      { captions: false },
      { branding: false },
    ]
    for (const override of scenarios) {
      expect(renderEstStale(shape(), shape(clip(override)))).toBe(true)
    }
  })

  // **La comparaison du cadrage est profonde**, comme celle des segments : deux
  // tableaux de crops identiques ne sont jamais le même objet, et un `!==` par
  // référence périmerait le rendu à chaque appel.
  it('compare le cadrage en profondeur, pas par référence', () => {
    expect(renderEstStale(shape(clip(), framing()), shape(clip(), framing()))).toBe(false)
  })

  it('voit chacune des composantes du cadrage résolu', () => {
    const scenarios: Partial<RenderedFraming>[] = [
      { ratio: '4:5' },
      { shots: [{ start: 0, end: 20, ratio: '4:5', cropX: 0.5, cropXNative: 0.5 }] },
      { shots: [{ start: 0, end: 20, ratio: '1:1', cropX: 0.3, cropXNative: 0.5 }] },
      { shots: [{ start: 0, end: 20, ratio: '1:1', cropX: 0.5, cropXNative: 0.3 }] },
      { shots: [{ start: 1, end: 20, ratio: '1:1', cropX: 0.5, cropXNative: 0.5 }] },
      { shots: [] },
    ]
    for (const override of scenarios) {
      expect(renderEstStale(shape(), shape(clip(), framing(override)))).toBe(true)
    }
  })

  it('voit un segment déplacé, à nombre de segments égal', () => {
    const moved = clip().segments.map((s, i) => (i === 1 ? { start: s.start, end: s.end + 1 } : s))
    expect(renderEstStale(shape(), shape(clip({ segments: moved })))).toBe(true)
  })
})

describe('motsDièse', () => {
  it('les extrait dans leur ordre, sans doublon de casse', () => {
    expect(wordsHash('#Impro et #impro, puis #avolo')).toEqual(['#Impro', '#avolo'])
  })

  it('accepte les accents et les chiffres', () => {
    expect(wordsHash('#théâtre #scene2026 #a_b')).toEqual(['#théâtre', '#scene2026', '#a_b'])
  })

  it('rend une liste vide quand il n’y en a pas', () => {
    expect(wordsHash('rien à signaler')).toEqual([])
  })
})

describe('texteDePublication', () => {
  it('porte les trois sections, dans l’ordre où on les colle', () => {
    const text = publicationText(clip())
    expect(text).toContain('Titre : Une vanne qui tient')
    expect(text).toContain('La chute arrive au bon moment. #impro #avolo')
    expect(text).toContain('Mots-dièse : #impro #avolo')
  })

  it('laisse les mots-dièse dans la description, qui se colle telle quelle', () => {
    const lines = publicationText(clip()).split('\n')
    expect(lines[lines.indexOf('Description :') + 1]).toContain('#impro')
  })

  it('reste lisible sur un clip sans titre ni description', () => {
    const text = publicationText(clip({ title: '  ', description: '' }))
    expect(text).toContain('Titre : (sans titre)')
    expect(text).toContain('(sans description)')
    expect(text).toContain('Mots-dièse : (aucun)')
  })
})

describe('collecterMarques', () => {
  it("rend une liste vide sur un dossier absent — on rend sans marque", async () => {
    await expect(collectMarkers(path.join(root, 'nulle-part'))).resolves.toEqual([])
  })

  it('rend une liste vide sur un dossier vide', async () => {
    const empty = path.join(root, 'brand')
    fs.mkdirSync(empty)
    await expect(collectMarkers(empty)).resolves.toEqual([])
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
  const marker = (file: string): MarkerNative => ({
    path: `/marques/${file}`,
    nativeW: 1000,
    nativeH: 250,
    widthRatio: 0.22,
    edge: 'gauche',
    content: 'peu importe : la porte ne lit pas le contenu',
  })

  it("refuse quand le clip demande des marques et qu'il n'y en a aucune", () => {
    expect(markerRejectFaute(true, [])).toBe(true)
  })

  it("laisse passer le clip qui n'en demande pas, dossier vide compris", () => {
    expect(markerRejectFaute(false, [])).toBe(false)
  })

  it("laisse passer quand une seule des deux marques est là", () => {
    // Le cas limite, et le seul qui ne se déduit pas de l'intitulé de l'issue.
    // `assets/brand/README.md` tient qu'un logo sans mention, ou l'inverse, sont
    // deux installations légitimes : rien ne distingue « l'opérateur n'a qu'un
    // logo » de « twitch.png a disparu ». Refuser là interdirait une
    // configuration soutenue pour rattraper une dégradation indécidable. Zéro,
    // lui, est sans ambiguïté : la marque a été demandée, aucune n'est posée.
    expect(markerRejectFaute(true, [marker('logo.png')])).toBe(false)
    expect(markerRejectFaute(true, [marker('twitch.png')])).toBe(false)
  })

  it('laisse passer quand les deux sont là', () => {
    expect(markerRejectFaute(true, [marker('logo.png'), marker('twitch.png')])).toBe(false)
  })
})

/**
 * La même règle vue depuis l'export, c'est-à-dire depuis l'endroit où elle coûte
 * quelque chose : `POST /api/clips/:id/export` est synchrone et dure de dix
 * secondes à une minute. Le refus doit tomber **avant** l'encodage, et sans
 * publier l'arborescence de la machine.
 */
describe('renderClip, la porte des marques', () => {
  function prepare(overrides: Partial<Clip> = {}): {
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
    // **Sans sous-titres**, pour la même raison qu'au describe du saut : un clip
    // qui en demande ferait lire le transcript avant la porte des marques (#87),
    // et aucun n'existe dans ce dossier de replays jetable.
    const c = clip({ captions: false, ...overrides })
    putClip(db, c)
    // Jetable et vide, comme un `assets/brand/` fraîchement cloné : le dépôt
    // n'en porte que le README, et la CI encore moins.
    const brandDir = path.join(root, 'brand-vide')
    fs.mkdirSync(brandDir, { recursive: true })
    return { db, c, brandDir }
  }

  /** Le message du refus, et l'assurance qu'il y en a bien eu un. */
  async function rejection(promise: Promise<unknown>): Promise<string> {
    try {
      await promise
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error("l'export n'a pas refusé")
  }

  it("refuse un clip qui demande des marques quand le dossier n'en porte aucune", async () => {
    const { db, c, brandDir } = prepare()
    await expect(renderClip(c.id, { db, brandDir, fontsDir: fonts })).rejects.toThrow(/logo\.png/)
  })

  it("refuse pareillement quand le dossier des marques n'existe pas", async () => {
    // `collecterMarques` ne distingue pas les deux, et il n'y a rien à
    // distinguer : la marque a été demandée, aucune n'est posée. La piste 3 de
    // l'issue butait là — `assets/brand/` est de toute façon toujours présent,
    // son README étant versionné.
    const { db, c } = prepare()
    await expect(
      renderClip(c.id, { db, brandDir: path.join(root, 'nulle-part'), fontsDir: fonts }),
    ).rejects.toThrow(/logo\.png/)
  })

  it('nomme les deux issues : déposer une marque, ou couper le branding', async () => {
    const { db, c, brandDir } = prepare()
    const message = await rejection(renderClip(c.id, { db, brandDir, fontsDir: fonts }))
    expect(message).toMatch(/assets\/brand\//)
    expect(message).toMatch(/branding/)
  })

  it("refuse avant d'encoder : aucune sortie n'est posée sur le disque", async () => {
    // Ce que l'issue demande noir sur blanc : pas de MP4 muet. Le `.ass` absent
    // dit en plus que le refus précède la lecture du transcript, qui vit sur le
    // Drive en 9p et coûte un aller-retour.
    const { db, c, brandDir } = prepare()
    const expected = pathsRender(ID, c.id, '1:1')
    await expect(renderClip(c.id, { db, brandDir, fontsDir: fonts })).rejects.toThrow(/marques/)
    for (const path of [
      expected.mp4,
      expected.variant9x16 as string,
      expected.texts,
      expected.ass,
    ]) {
      expect(fs.existsSync(path)).toBe(false)
    }
  })

  it('ne publie aucun chemin absolu dans son refus', async () => {
    // Le message part dans le corps d'une réponse HTTP. La mesure est celle du
    // dépôt : épuré, il doit être identique à lui-même.
    const { db, c, brandDir } = prepare()
    const message = await rejection(renderClip(c.id, { db, brandDir, fontsDir: fonts }))
    expect(message).toMatch(/logo\.png/)
    expect(cleanPaths(message)).toBe(message)
  })

  it("laisse passer un clip qui ne demande pas de marques", async () => {
    // Il ne va pas jusqu'au bout — ni transcript ni ffmpeg ici — et c'est ce qui
    // rend l'assertion nette : il échoue plus loin, sur autre chose.
    const { db, c, brandDir } = prepare({ branding: false })
    const message = await rejection(renderClip(c.id, { db, brandDir, fontsDir: fonts }))
    expect(message).not.toMatch(/marque/i)
  })

  it('ne refuse pas un clip déjà rendu, qui ne produit rien de neuf', async () => {
    // Le saut n'encode pas : refuser là ferait échouer une relance qui se
    // contente de réécrire un `.txt`, sans rien changer aux fichiers livrés.
    const { db, c, brandDir } = prepare()
    const expected = pathsRender(ID, c.id, '1:1')
    for (const path of [expected.mp4, expected.variant9x16 as string, expected.texts]) {
      fs.mkdirSync(path.dirname(path), { recursive: true })
      fs.writeFileSync(path, '')
    }
    poserFingerprint(c, '1:1')
    const result = await renderClip(c.id, { db, brandDir, fontsDir: fonts })
    expect(result.skipped).toBe(true)
  })

  /**
   * **Ce que #48 change à la contrepartie de #37.** Un clip exporté sans marque
   * avant #37 n'a pas d'empreinte : il ne saute plus, donc il atteint la porte,
   * qui refuse en disant quoi faire. Avant, il sautait pour toujours et son seul
   * remède était un `force` qu'il fallait avoir lu un commentaire pour connaître.
   */
  it("refuse un rendu sans empreinte quand le dossier n'a plus de marque", async () => {
    const { db, c, brandDir } = prepare()
    const expected = pathsRender(ID, c.id, '1:1')
    for (const path of [expected.mp4, expected.variant9x16 as string, expected.texts]) {
      fs.mkdirSync(path.dirname(path), { recursive: true })
      fs.writeFileSync(path, '')
    }

    await expect(renderClip(c.id, { db, brandDir, fontsDir: fonts })).rejects.toThrow(/logo\.png/)
  })
})

/**
 * L'enchaînement lui-même, par le seul chemin qui ne demande ni ffmpeg ni
 * vidéo : celui du saut. Il traverse pourtant tout ce qui décide — lecture du
 * clip et du projet, résolution du ratio, nom des fichiers, décision de saut.
 */
describe('renderClip, chemin du saut', () => {
  function prepare(overrides: Partial<Clip> = {}): {
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
    // **Sans sous-titres par défaut.** Ce describe ne traverse jamais que le
    // chemin du saut, sans mocker ffmpeg : un clip qui en demande ferait lire le
    // transcript avant la décision de saut (#87), et aucun n'existe dans ce
    // dossier de replays jetable. Les tests qui portent sur les sous-titres
    // vivent dans `tests/server/empreinte.test.ts`, qui pose un vrai transcript.
    const c = clip({ captions: false, ...overrides })
    putClip(db, c)
    // **Jetable et vide, jamais celui du dépôt.** `renderClip` sonde le dossier
    // des marques avant même la décision de saut, pour comparer l'empreinte :
    // sans ce chemin explicite il lirait `assets/brand/`, qui porte les deux PNG
    // sur la machine de l'opérateur et rien du tout en CI. Le verdict de
    // l'empreinte dépendrait alors de la machine.
    const brandDir = path.join(root, 'brand-saut')
    fs.mkdirSync(brandDir, { recursive: true })
    return { db, c, brandDir }
  }

  function poser(paths: string[]): void {
    for (const path of paths) {
      fs.mkdirSync(path.dirname(path), { recursive: true })
      fs.writeFileSync(path, '')
    }
  }

  it('rend les trois chemins et saute quand tout est là', async () => {
    const { db, c, brandDir } = prepare()
    const expected = pathsRender(ID, c.id, '1:1')
    poser([expected.mp4, expected.variant9x16 as string, expected.texts])
    poserFingerprint(c, '1:1')

    const result = await renderClip(c.id, { db, brandDir, fontsDir: fonts })
    expect(result).toEqual({
      mp4: expected.mp4,
      variant9x16: expected.variant9x16,
      texts: expected.texts,
      skipped: true,
    })
  })

  it("rabat 'auto' sur 9:16, donc sans variante (itération 0)", async () => {
    const { db, c, brandDir } = prepare({ ratio: 'auto' })
    const expected = pathsRender(ID, c.id, '9:16')
    poser([expected.mp4, expected.texts])
    poserFingerprint(c, '9:16')

    const result = await renderClip(c.id, { db, brandDir, fontsDir: fonts })
    expect(result.skipped).toBe(true)
    expect(result.variant9x16).toBeNull()
  })

  it("réécrit le .txt même quand il saute, sans réencoder", async () => {
    // Corriger une faute dans la description puis relancer l'export ne doit pas
    // exiger un --force qui réencoderait trois minutes de vidéo pour rien.
    const { db, c, brandDir } = prepare()
    const expected = pathsRender(ID, c.id, '1:1')
    poser([expected.mp4, expected.variant9x16 as string, expected.texts])
    poserFingerprint(c, '1:1')
    const before = fs.statSync(expected.variant9x16 as string).mtimeMs
    putClip(db, { ...c, description: 'Corrigée après coup. #impro' })

    const result = await renderClip(c.id, { db, brandDir, fontsDir: fonts })

    expect(result.skipped).toBe(true)
    expect(fs.readFileSync(expected.texts, 'utf8')).toContain('Corrigée après coup.')
    // Rien n'a été réencodé : la variante n'a pas été touchée.
    expect(fs.statSync(expected.variant9x16 as string).mtimeMs).toBe(before)
  })

  it("efface la variante d'un ratio abandonné même quand il saute", async () => {
    const { db, c, brandDir } = prepare({ ratio: '9:16' })
    const expected = pathsRender(ID, c.id, '9:16')
    const stale = path.join(projects, ID, 'renders', `${c.id}-9x16.mp4`)
    poser([expected.mp4, expected.texts, stale])
    poserFingerprint(c, '9:16')

    const result = await renderClip(c.id, { db, brandDir, fontsDir: fonts })

    expect(result.skipped).toBe(true)
    expect(fs.existsSync(stale)).toBe(false)
  })

  it("répare le statut même quand il saute", async () => {
    // Un processus arrêté entre l'écriture du .txt et la mise à jour du statut
    // laisse toutes les sorties en place : sans cette réparation, chaque relance
    // sauterait et le clip resterait en « kept » pour toujours.
    const { db, c, brandDir } = prepare()
    const expected = pathsRender(ID, c.id, '1:1')
    poser([expected.mp4, expected.variant9x16 as string, expected.texts])
    poserFingerprint(c, '1:1')

    await renderClip(c.id, { db, brandDir, fontsDir: fonts })
    expect(getClip(db, c.id)?.status).toBe('exported')
  })

  it("écrit le .txt manquant sans relire le transcript ni rappeler ffmpeg", async () => {
    // La reprise d'un passage interrompu juste après l'encodage. Aucun transcript
    // n'existe dans ce dossier de replays jetable, et ce clip ne demande pas de
    // sous-titres (`captions: false`, le défaut de ce `préparer` depuis #87) :
    // si l'étape allait lire le transcript malgré tout, `currentCaptionsDocument`
    // lèverait. C'est ce qui rend ce test concluant — **sur ce cas**. Un clip
    // qui demande des sous-titres, lui, lit désormais le transcript même sur ce
    // chemin : #87 ne peut pas savoir si le texte a changé sans ça, et c'est
    // `tests/server/empreinte.test.ts` qui couvre cette lecture-là, transcript
    // posé pour de vrai.
    const { db, c, brandDir } = prepare()
    const expected = pathsRender(ID, c.id, '1:1')
    poser([expected.mp4, expected.variant9x16 as string])
    poserFingerprint(c, '1:1')

    const result = await renderClip(c.id, { db, brandDir, fontsDir: fonts })
    expect(result.skipped).toBe(false)
    expect(fs.readFileSync(expected.texts, 'utf8')).toContain('Titre : Une vanne qui tient')
    expect(getClip(db, c.id)?.status).toBe('exported')
  })

  it("efface la variante d'un ratio abandonné", async () => {
    // Le clip est repassé en 9:16, donc plus de variante due — mais celle du 1:1
    // d'avant est encore là, à ressembler à une livraison à jour.
    const { db, c, brandDir } = prepare({ ratio: '9:16' })
    const expected = pathsRender(ID, c.id, '9:16')
    const stale = path.join(projects, ID, 'renders', `${c.id}-9x16.mp4`)
    poser([expected.mp4, stale])
    poserFingerprint(c, '9:16')

    const result = await renderClip(c.id, { db, brandDir, fontsDir: fonts })
    expect(result.variant9x16).toBeNull()
    expect(fs.existsSync(stale)).toBe(false)
  })

  it("n'écrase pas un texte corrigé pendant l'export", () => {
    // Le défaut relevé par Codex : `renderClip` tient un clip lu avant son
    // premier `await`, et un export dure des minutes. Réécrire cet instantané
    // pour changer une colonne rendrait au clip son titre d'avant.
    const { db, c } = prepare()
    putClip(db, { ...c, title: 'Retitré' })

    markExported(db, c.id, c, framingFor(c))

    const reread = getClip(db, c.id)
    expect(reread?.status).toBe('exported')
    expect(reread?.title).toBe('Retitré')
  })

  it('ne ressuscite pas un clip supprimé pendant le rendu', () => {
    const { db, c } = prepare()
    db.prepare('DELETE FROM clips WHERE id = ?').run(c.id)
    markExported(db, c.id, c, framingFor(c))
    expect(getClip(db, c.id)).toBeUndefined()
  })

  it("conserve toute décision de statut prise pendant l'encodage", () => {
    // `discarded` n'est pas le seul cas : rappuyer sur « Gardé » ramène le clip
    // à `candidate` (`src/lib/clip-status.ts`). C'est l'écart de statut qui
    // compte, pas sa valeur. (relevé par Copilot)
    for (const decided of ['discarded', 'candidate'] as const) {
      const { db, c } = prepare()
      putClip(db, { ...c, status: decided })

      markExported(db, c.id, c, framingFor(c))

      expect(getClip(db, c.id)?.status).toBe(decided)
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
    const { db, c } = prepare()
    putClip(db, { ...c, segments: [{ start: 100, end: 104 }] })

    markExported(db, c.id, c, framingFor(c))

    expect(getClip(db, c.id)?.status).toBe('kept')
  })

  // `ratio` et `cropX` y figurent encore, et pour une raison qui a changé : ils
  // ne sont plus comparés en tant que champs du clip, mais ils décident du
  // cadrage résolu tant qu'aucune analyse n'a tourné — c'est le repli de
  // `clipFraming`, et c'est le cas de tous ces tests.
  it('refuse pareillement sur chacun des champs qui vont à l’image', () => {
    const scenarios: Partial<Clip>[] = [
      { segments: [{ start: 0, end: 5 }] },
      { ratio: '9:16' },
      { cropX: 0.2 },
      { captions: false },
      { branding: false },
    ]
    for (const override of scenarios) {
      // **`captions: true` en base ici**, pour que le cas `{ captions: false }`
      // représente un vrai changement — le défaut de `préparer` est `false`
      // depuis #87, et partir de là rendrait ce cas-ci un no-op qui ne prouve
      // plus rien.
      const { db, c } = prepare({ captions: true })
      putClip(db, { ...c, ...override })

      markExported(db, c.id, c, framingFor(c))

      expect(getClip(db, c.id)?.status).toBe('kept')
      db.close()
    }
  })

  it("pose « exported » quand rien de ce qui va à l'image n'a bougé", () => {
    // Le cas nominal reste nominal : seul le texte a changé.
    const { db, c } = prepare()
    putClip(db, { ...c, description: 'Corrigée.' })

    markExported(db, c.id, c, framingFor(c))

    expect(getClip(db, c.id)?.status).toBe('exported')
  })

  it("écarte les fichiers d'un rendu que le montage a rendu caduc", () => {
    // Refuser le statut ne suffisait pas : les MP4 restaient là, donc l'export
    // suivant sautait et annonçait « exporté » sur le montage d'avant. On retire
    // ce qu'on sait faux. (relevé par Copilot)
    const { db, c } = prepare({ status: 'exported' })
    const paths = pathsRender(ID, c.id, '1:1')
    poser([paths.mp4, paths.variant9x16 as string, paths.texts])
    poserFingerprint(c, '1:1')
    putClip(db, { ...c, status: 'exported', segments: [{ start: 0, end: 5 }] })

    expect(discardRenderStale(db, c.id, paths, c, framingFor(c))).toBe(true)

    expect(fs.existsSync(paths.mp4)).toBe(false)
    expect(fs.existsSync(paths.variant9x16 as string)).toBe(false)
    expect(fs.existsSync(paths.texts)).toBe(false)
    // **L'empreinte part avec eux**, et elle part la première : la laisser
    // certifierait des fichiers absents, et un effacement à moitié réussi
    // ferait sauter l'export suivant sur une livraison amputée.
    expect(fs.existsSync(paths.fingerprint)).toBe(false)
    // Plus rien sur le disque ne justifie « exporté ».
    expect(getClip(db, c.id)?.status).toBe('kept')
  })

  it("ne touche à rien quand le montage n'a pas bougé", () => {
    const { db, c } = prepare()
    const paths = pathsRender(ID, c.id, '1:1')
    poser([paths.mp4, paths.variant9x16 as string, paths.texts])
    poserFingerprint(c, '1:1')

    expect(discardRenderStale(db, c.id, paths, c, framingFor(c))).toBe(false)
    expect(fs.existsSync(paths.mp4)).toBe(true)
    expect(fs.existsSync(paths.fingerprint)).toBe(true)
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
    const { db, c } = prepare()
    const paths = pathsRender(ID, c.id, '1:1')
    poser([paths.mp4, paths.variant9x16 as string, paths.texts])
    poserFingerprint(c, '1:1')

    let calls = 0
    const resolver = (clip: Clip): RenderedFraming => {
      calls += 1
      return framingFor(clip)
    }
    expect(discardRenderStale(db, c.id, paths, c, framingFor(c), resolver)).toBe(false)
    expect(calls).toBe(1)

    // Et un résolveur qui rend un autre cadrage périme, sans qu'aucun champ du
    // clip n'ait bougé : c'est bien lui qui décide, pas une relecture cachée.
    expect(
      discardRenderStale(db, c.id, paths, c, framingFor(c), () => framing({ ratio: '4:5' })),
    ).toBe(true)
    expect(fs.existsSync(paths.mp4)).toBe(false)
  })

  it('refuse un clip inconnu', async () => {
    const { db, brandDir } = prepare()
    await expect(renderClip('clip_inexistant', { db, brandDir, fontsDir: fonts })).rejects.toThrow(/Clip inconnu/)
  })

  it("refuse un clip sans segment, plutôt que de rendre un fichier vide", async () => {
    const { db, c, brandDir } = prepare({ segments: [] })
    await expect(renderClip(c.id, { db, brandDir, fontsDir: fonts })).rejects.toThrow(/aucun segment/)
  })

  it("refuse un clip vidé après un premier export, au lieu de sauter dessus", async () => {
    // L'édition autorise de vider un clip, et ses anciens fichiers sont encore
    // là : sans validation avant la décision de saut, il ressortirait
    // `skipped: true` et marqué exporté. (relevé par Copilot)
    const { db, c, brandDir } = prepare({ segments: [] })
    const expected = pathsRender(ID, c.id, '1:1')
    poser([expected.mp4, expected.variant9x16 as string, expected.texts])

    await expect(renderClip(c.id, { db, brandDir, fontsDir: fonts })).rejects.toThrow(/aucun segment/)
    expect(getClip(db, c.id)?.status).toBe('kept')
  })

  /** Le message d'un refus, ou la chaîne vide si l'appel a réussi. */
  async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
    return promise.then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
  }

  /**
   * **La copie de travail se répare, elle ne se réclame plus.** Ce test disait
   * l'inverse : le rendu levait en prescrivant une réingestion que rien dans
   * l'application ne savait déclencher — `CIBLES_LANÇABLES` ne l'expose pas, et
   * un projet dont tous les artefacts existent planifie un plan vide. Le seul
   * remède était un script dans un terminal, ce que le critère de réussite de la
   * conception exclut. Et le TTL de huit heures en aurait fait le cas normal.
   * (issue #76)
   */
  it('reconstitue la copie de travail quand elle a disparu', async () => {
    const { db, c, brandDir } = prepare()
    const copy = path.join(stage, SOURCE)
    expect(fs.existsSync(copy)).toBe(false)

    // Le rendu échoue plus loin — ce dossier de marques est vide, exprès — mais
    // il ne doit plus échouer *ici*, et la copie doit être revenue.
    const message = await rejectionMessage(renderClip(c.id, { db, brandDir, fontsDir: fonts }))
    expect(message).not.toMatch(/copie de travail/)
    expect(fs.existsSync(copy)).toBe(true)
    expect(fs.readFileSync(copy, 'utf8')).toBe('pas vraiment une vidéo')
  })

  /**
   * **Le dernier recours reste, pour ce qu'il est vraiment.** L'original absent
   * du dossier des replays n'est pas un cache à reconstituer : c'est une source
   * disparue, et le message doit le dire plutôt que de rendre un `ENOENT` nu.
   */
  it('dit quoi faire quand l’original a disparu du dossier des replays', async () => {
    const { db, c, brandDir } = prepare()
    fs.rmSync(path.join(replay, SOURCE), { force: true })

    const message = await rejectionMessage(renderClip(c.id, { db, brandDir, fontsDir: fonts }))
    expect(message).toMatch(/copie de travail/)
    expect(message).toMatch(/original/)
    // Le chemin complet porte l'arborescence du Drive : seul le nom traverse.
    expect(message).not.toContain(root)
  })

  // **La variante réclame la source, même quand le natif est déjà là**, et c'est
  // le correctif de #22 vu depuis cette fonction : elle ne dérive plus du MP4
  // natif, donc son fond ne peut plus en hériter les sous-titres. Avant, ce cas
  // sautait la préparation et lançait ffmpeg sur le natif ; il exige maintenant
  // la copie de travail — et va la chercher si elle n'est pas là (issue #76).
  it('réclame la source quand seule la variante manque, et la reconstitue', async () => {
    const { db, c, brandDir } = prepare()
    const expected = pathsRender(ID, c.id, '1:1')
    poser([expected.mp4, expected.texts])
    poserFingerprint(c, '1:1')
    const copy = path.join(stage, SOURCE)
    expect(fs.existsSync(copy)).toBe(false)

    // Le rendu ne saute pas : il lui manque la variante. Il va donc chercher la
    // source, et c'est ce qu'on vérifie — l'échec qui suit vient des marques.
    const message = await rejectionMessage(renderClip(c.id, { db, brandDir, fontsDir: fonts }))
    expect(message).not.toMatch(/copie de travail/)
    expect(fs.existsSync(copy)).toBe(true)
  })
})
