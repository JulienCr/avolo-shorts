import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  AUDIO_TIMELINE,
  LOUDNORM,
  METADATA_SCRUB,
  RESAMPLE,
  videoEncodedArgs,
} from '@/core/ffmpeg/encoder'
import type { Ratio } from '@/core/edl'
import type { HookSettings } from '@/core/hook'
import {
  audioArgs,
  blurredVariantArgs,
  proxyArgs,
  renderArgs,
  sourceThumbArgs,
  thumbArgs,
  type FramedSegment,
} from '@/core/ffmpeg/args'

const count = (argv: string[], token: string) => argv.filter((x) => x === token).length

describe('videoEncodedArgs', () => {
  it('porte les réglages x264 mesurés, par palier', () => {
    expect(videoEncodedArgs('x264', 'quality')).toEqual([
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    ])
    expect(videoEncodedArgs('x264', 'fast')).toEqual([
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    ])
  })

  // libx264 conserve le format de la source : une source en 10 bits ou en
  // 4:2:2 sortirait dans un format que les plateformes rejettent, sans
  // avertissement. Les deux encodeurs le posent donc, à tous les paliers.
  it('force yuv420p sur les deux encodeurs, à tous les paliers', () => {
    for (const encoder of ['x264', 'nvenc'] as const) {
      for (const tier of ['quality', 'fast'] as const) {
        const a = videoEncodedArgs(encoder, tier)
        expect(a[a.indexOf('-pix_fmt') + 1]).toBe('yuv420p')
      }
    }
  })

  it('porte les réglages NVENC, avec -pix_fmt yuv420p', () => {
    expect(videoEncodedArgs('nvenc', 'quality')).toEqual([
      '-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr',
      '-cq', '25', '-b:v', '0', '-spatial-aq', '1', '-temporal-aq', '1',
      '-pix_fmt', 'yuv420p',
    ])
    expect(videoEncodedArgs('nvenc', 'fast')).toEqual([
      '-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr',
      '-cq', '25', '-b:v', '0', '-spatial-aq', '1', '-pix_fmt', 'yuv420p',
    ])
  })

  // La table est une constante du module : la rendre telle quelle laisserait
  // n'importe quel appelant la modifier pour tous les suivants.
  it('rend une copie, pas la table elle-même', () => {
    const a = videoEncodedArgs('nvenc', 'quality')
    a.push('-sabotage')
    expect(videoEncodedArgs('nvenc', 'quality')).not.toContain('-sabotage')
  })
})

describe('proxyArgs', () => {
  const base = { src: '/s.mp4', dst: '/p.mp4' }

  it('normalise à 30 fps et 960x540, avec une image clé par seconde', () => {
    const a = proxyArgs({ ...base, encoder: 'x264' })
    expect(a.join(' ')).toContain('-vf fps=30,scale=960:540')
    expect(a.join(' ')).toContain('-g 30')
  })

  it('encode au palier rapide — le proxy sert à scruber, pas à livrer', () => {
    expect(proxyArgs({ ...base, encoder: 'x264' })).toContain('veryfast')
    expect(proxyArgs({ ...base, encoder: 'nvenc' })).toContain('p4')
  })

  it('finit par la destination, et jamais avant', () => {
    const a = proxyArgs({ ...base, encoder: 'x264' })
    expect(a[a.length - 1]).toBe('/p.mp4')
    expect(count(a, '/p.mp4')).toBe(1)
  })

  // Le proxy est servi au navigateur (tâche 11) : le titre de l'émission, la
  // date d'enregistrement et le logiciel de capture n'ont rien à y faire.
  it('efface les métadonnées de la source', () => {
    const a = proxyArgs({ ...base, encoder: 'x264' })
    for (const token of METADATA_SCRUB) expect(a).toContain(token)
  })

  it('garde le son : le montage se fait à l’oreille sur le proxy', () => {
    expect(proxyArgs({ ...base, encoder: 'x264' })).not.toContain('-an')
  })

  // Sans `-map`, ffmpeg choisit seul les flux et peut embarquer ce que la
  // source traîne. `0:v:0` et non `0:v` : une pochette est un second flux
  // vidéo, et partirait dans le proxy servi au navigateur.
  it('ne prend que la première piste vidéo et la première piste audio', () => {
    const a = proxyArgs({ ...base, encoder: 'x264' })
    expect(a.join(' ')).toContain('-map 0:v:0 -map 0:a:0?')
    expect(a).not.toContain('0:v')
  })
})

describe('audioArgs', () => {
  it('sort du 16 kHz mono, ce que WhisperX attend', () => {
    const a = audioArgs({ src: '/s.mp4', dst: '/a.wav' })
    expect(a.join(' ')).toContain('-ar 16000')
    expect(a.join(' ')).toContain('-ac 1')
    expect(a).toContain('-vn')
    expect(a[a.length - 1]).toBe('/a.wav')
  })

  // L'extraction audio ne touche pas à l'image : y mettre le GPU coûterait un
  // décodage vidéo complet pour rien.
  it('ne décode pas la vidéo sur le GPU', () => {
    expect(audioArgs({ src: '/s.mp4', dst: '/a.wav' })).not.toContain('-hwaccel')
  })
})

describe('thumbArgs', () => {
  it('saute avant de décoder, et ne sort qu’une image', () => {
    const a = thumbArgs({ src: '/p.mp4', dst: '/t.jpg', at: 2841.2 })
    // `-ss` **avant** `-i` : sinon ffmpeg décode depuis le début, et une vignette
    // prise à quarante minutes coûte quarante minutes de décodage.
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'))
    expect(a.join(' ')).toContain('-frames:v 1')
    expect(a).toContain('-an')
    expect(a[a.length - 1]).toBe('/t.jpg')
  })

  it('ne demande jamais un instant négatif', () => {
    expect(thumbArgs({ src: '/p.mp4', dst: '/t.jpg', at: -3 })[7]).toBe('0')
  })
})

/**
 * La vignette d'une source, c'est-à-dire **la seule qui se tire de l'original**.
 *
 * Tout l'intérêt du ticket qui l'a demandée (#41) tient dans une option et sa
 * position : `-ss` **avant** `-i` fait chercher dans le conteneur au lieu de
 * décoder depuis le début, ce qui ramène l'extraction à ~2,7 s sur un fichier de
 * 4 à 12 Go posé sur un montage 9p. Après le `-i`, on décoderait plusieurs
 * minutes de vidéo par carte de la grille — et l'issue le dit ainsi : « toute
 * implémentation qui inverse les deux invalide ce ticket ». C'est exactement le
 * genre de chose qu'un réordonnancement bien intentionné casse sans rien casser
 * d'autre, d'où ces tests.
 */
describe('sourceThumbArgs', () => {
  it('cherche dans le conteneur au lieu de décoder depuis le début', () => {
    const a = sourceThumbArgs({ src: '/replays/emission.mp4', dst: '/c/v.jpg', at: 1978.9 })

    const ss = a.indexOf('-ss')
    const i = a.indexOf('-i')
    expect(ss).toBeGreaterThanOrEqual(0)
    expect(ss).toBeLessThan(i)
    // Et l'instant est bien celui demandé, collé à son option : un `-ss` placé
    // avant le `-i` mais suivi d'une autre valeur ne chercherait pas là.
    expect(a[ss + 1]).toBe('1978.9')
    expect(a[i + 1]).toBe('/replays/emission.mp4')
  })

  it('ne sort qu’une image, sans le son', () => {
    const a = sourceThumbArgs({ src: '/s.mp4', dst: '/c/v.jpg', at: 10 })
    expect(a.join(' ')).toContain('-frames:v 1')
    expect(a).toContain('-an')
    // Sans `-update 1`, ffmpeg traite une sortie `.jpg` comme une séquence
    // numérotée et avertit à chaque appel.
    expect(a.join(' ')).toContain('-update 1')
  })

  /**
   * L'original est en 1920x1080 et la carte réserve environ 170 points. Sans
   * réduction, la grille tirerait quelques centaines de kilooctets par carte
   * pour un emplacement qui en affiche le sixième.
   *
   * La virgule de `min(640, iw)` est échappée : à ce niveau de la syntaxe des
   * filtres, elle sépare deux filtres d'une chaîne. Vérifié sur le binaire —
   * `2025-11-09-realisateur` sort en 640x360, 47 ko.
   */
  it('réduit à 640 de large sans agrandir une source plus petite', () => {
    const a = sourceThumbArgs({ src: '/s.mp4', dst: '/c/v.jpg', at: 10 })
    expect(a[a.indexOf('-vf') + 1]).toBe('scale=w=min(640\\,iw):h=-2')
  })

  it('ferme les options avant la destination, qui est positionnelle', () => {
    const a = sourceThumbArgs({ src: '/s.mp4', dst: '/c/-v.jpg', at: 10 })
    expect(a[a.length - 2]).toBe('--')
    expect(a[a.length - 1]).toBe('/c/-v.jpg')
  })

  it('ne demande jamais un instant négatif', () => {
    const a = sourceThumbArgs({ src: '/s.mp4', dst: '/c/v.jpg', at: -3 })
    expect(a[a.indexOf('-ss') + 1]).toBe('0')
  })
})

/**
 * Le cadre d'une entrée, tel que `cropRect` le rend pour une source 1920x1080.
 *
 * Les entrées portent désormais **chacune leur cadre** : un segment qui traverse
 * une frontière de plan se découpe en autant d'entrées que de plans, et le
 * rectangle change avec elles. Ces deux constantes couvrent les deux cas que le
 * graphe distingue — un cadre qui remplit son canevas, et un cadre qui doit être
 * posé sur un fond flouté.
 */
const FRAME_9_X_16 = { w: 608, h: 1080, x: 656, y: 0 }
const FRAME_1_X_1 = { w: 1080, h: 1080, x: 420, y: 0 }

/** Une entrée à décoder : des bornes, un rectangle, un ratio. */
function entry(
  start: number,
  end: number,
  crop = FRAME_9_X_16,
  ratio: Ratio = '9:16',
  split?: FramedSegment['split'],
): FramedSegment {
  return { start, end, crop, ratio, split }
}

/** Les deux cellules d'un plan splitté, en pixels d'une source 1920x1080. */
const SPLIT_CELLS: [{ w: number; h: number; x: number; y: number }, { w: number; h: number; x: number; y: number }] = [
  { w: 900, h: 800, x: 100, y: 50 },
  { w: 900, h: 800, x: 900, y: 100 },
]

/**
 * Le `hookImage` minimal — durée par défaut de 2 s, aucune transition. Les
 * tests de timing (bornage, fondus) font varier `durationMs`/`enter`/`exit`
 * explicitement ; les autres n'ont besoin que d'un objet qui type-checke.
 */
function hookImage(
  overrides: Partial<{
    path: string
    x: number
    y: number
    w: number
    h: number
    durationMs: number
    enter: HookSettings['enter']
    exit: HookSettings['exit']
  }> = {},
): {
  path: string
  x: number
  y: number
  w: number
  h: number
  durationMs: number
  enter: HookSettings['enter']
  exit: HookSettings['exit']
} {
  return {
    path: '/h.png',
    x: 60,
    y: 90,
    w: 200,
    h: 80,
    durationMs: 2_000,
    enter: 'none',
    exit: 'none',
    ...overrides,
  }
}

describe('renderArgs', () => {
  const base = {
    src: '/s.mp4',
    dst: '/o.mp4',
    out: { w: 1080, h: 1920 },
    encoder: 'nvenc' as const,
  }

  it('un -ss par entrée, avant le -i correspondant', () => {
    const a = renderArgs({ ...base, segments: [entry(100, 110), entry(200, 215)] })
    expect(count(a, '-i')).toBe(2)
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'))
    expect(a).toContain('100')
    expect(a.join(' ')).toContain('concat=n=2:v=1:a=1')
  })

  // `-hwaccel` est une option d'ENTRÉE : sa portée s'arrête au `-i` qui suit.
  // Posée une seule fois en tête, seule la première entrée décoderait sur le
  // GPU et toutes les suivantes retomberaient sur le chemin logiciel — sans
  // erreur, juste plus lentement.
  it('répète -hwaccel cuda devant chaque couple -ss/-i', () => {
    const a = renderArgs({
      ...base,
      segments: [entry(100, 110), entry(200, 215), entry(300, 302.5)],
    })
    expect(count(a, '-hwaccel')).toBe(3)
    expect(a.join(' ')).toContain(
      '-hwaccel cuda -ss 100 -t 10 -i /s.mp4' +
        ' -hwaccel cuda -ss 200 -t 15 -i /s.mp4' +
        ' -hwaccel cuda -ss 300 -t 2.5 -i /s.mp4',
    )
  })

  it("n'accélère rien au GPU quand l'encodeur est x264", () => {
    const a = renderArgs({ ...base, encoder: 'x264', segments: [entry(0, 10)] })
    expect(a).not.toContain('-hwaccel')
    expect(a).toContain('libx264')
  })

  it('une seule entrée ne passe pas par concat', () => {
    const a = renderArgs({ ...base, segments: [entry(100, 110)] })
    expect(a.join(' ')).not.toContain('concat=')
  })

  // Sans sous-titres ni logo, c'est le `concat` lui-même qui écrit dans [v] :
  // aucune étape ne suit. Le graphe entier tient alors en quatre clauses, et
  // les vérifier toutes exclut une étiquette orpheline ou écrite deux fois.
  it('assemble un graphe complet et sans étape morte, sans ASS ni logo', () => {
    const a = renderArgs({ ...base, segments: [entry(0, 10), entry(20, 30)] })
    const graph = a[a.indexOf('-filter_complex') + 1]
    const crop = 'crop=608:1080:656:0,scale=1080:1920:flags=lanczos,setsar=1'
    expect(graph).toBe(
      `[0:v]${crop}[v0];[1:v]${crop}[v1];` +
        '[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[v][ac];' +
        `[ac]${LOUDNORM},${RESAMPLE},${AUDIO_TIMELINE}[a]`,
    )
  })

  // **Le cœur du cadrage automatique dans le rendu.** Le crop n'est plus unique :
  // chaque entrée porte le sien, et deux entrées adjacentes sont les deux
  // moitiés d'un segment coupé sur une frontière de plan. Les fusionner ferait
  // cadrer la seconde avec le rectangle de la première, sans un mot.
  it('donne à chaque entrée son propre rectangle', () => {
    const a = renderArgs({
      ...base,
      segments: [
        entry(100, 110, { w: 608, h: 1080, x: 0, y: 0 }),
        entry(110, 120, { w: 608, h: 1080, x: 1312, y: 0 }),
      ],
    })
    const graph = a[a.indexOf('-filter_complex') + 1]
    expect(graph).toContain('[0:v]crop=608:1080:0:0,scale=1080:1920:flags=lanczos,setsar=1[v0]')
    expect(graph).toContain('[1:v]crop=608:1080:1312:0,scale=1080:1920:flags=lanczos,setsar=1[v1]')
    // Deux décodeurs, et surtout deux entrées qui se touchent sans fusionner.
    expect(count(a, '-i')).toBe(2)
    expect(a.join(' ')).toContain('-ss 100 -t 10 -i /s.mp4 -hwaccel cuda -ss 110 -t 10 -i /s.mp4')
  })

  it('incruste l’ASS avec fontsdir, filename nommé et non positionnel', () => {
    const a = renderArgs({
      ...base,
      segments: [entry(0, 10)],
      assPath: '/c.ass',
      fontsDir: '/fonts',
    })
    expect(a.join(' ')).toContain("ass=filename='/c.ass':fontsdir='/fonts'")
  })

  it('n’incruste rien quand aucun fichier ASS n’est fourni', () => {
    const a = renderArgs({ ...base, segments: [entry(0, 10)] })
    expect(a.join(' ')).not.toContain('ass=')
  })

  // Sans dossier de polices, libass s'en remet à ceux du système. L'option ne
  // doit alors pas apparaître du tout : `fontsdir=''` le ferait chercher dans
  // un dossier vide et retomber sur une police de secours, en silence.
  it('omet fontsdir quand il n’est pas fourni, au lieu de l’émettre vide', () => {
    const a = renderArgs({ ...base, segments: [entry(0, 10)], assPath: '/c.ass' })
    expect(a.join(' ')).toContain("ass=filename='/c.ass'")
    expect(a.join(' ')).not.toContain('fontsdir')
  })

  // Un chemin porte des caractères que la syntaxe des filtres lit comme des
  // séparateurs. Non échappés, ils coupent le graphe en morceaux et ffmpeg
  // échoue sur un nom de filtre inconnu.
  //
  // **Les formes attendues ci-dessous sont mesurées, pas déduites.** Une valeur
  // de filtre traverse `av_get_token` deux fois, et entre apostrophes la
  // contre-oblique n'échappe rien : `filename='/l\'été/c.ass'` échoue à
  // l'analyse. Les cinq chemins de ces tests ont été posés sur le disque et
  // chargés par libass à travers le binaire du projet.
  it('échappe les deux-points et les contre-obliques du chemin', () => {
    const a = renderArgs({
      ...base,
      segments: [entry(0, 10)],
      assPath: '/2026\\:03/c.ass',
    })
    expect(a.join(' ')).toContain(String.raw`ass=filename='/2026\\\:03/c.ass'`)
  })

  // L'apostrophe est le seul cas qui ne se devine pas : il faut fermer la
  // chaîne, écrire `\'` lui-même doublement échappé, puis la rouvrir.
  it("ferme et rouvre la chaîne autour d'une apostrophe, au lieu de la préfixer", () => {
    const a = renderArgs({
      ...base,
      segments: [entry(0, 10)],
      assPath: "/l'été:2026/c.ass",
    })
    expect(a.join(' ')).toContain(String.raw`ass=filename='/l'\\\''été\:2026/c.ass'`)
    // Le piège de la première version : une apostrophe simplement préfixée
    // ferme la chaîne et casse l'analyse du graphe.
    expect(a.join(' ')).not.toContain(String.raw`/l\'été`)
  })

  // Un chemin qui tenterait de refermer la valeur pour ajouter ses propres
  // filtres. Vérifié sur le binaire : libass charge bien un fichier nommé ainsi,
  // donc la séquence reste une valeur et ne devient jamais du graphe.
  it('un chemin ne peut pas rouvrir le graphe de filtres', () => {
    const a = renderArgs({
      ...base,
      segments: [entry(0, 10)],
      assPath: "/zz/'];exit[v];a='/c.ass",
    })
    const graph = a[a.indexOf('-filter_complex') + 1]
    expect(graph).toContain(String.raw`ass=filename='/zz/'\\\''];exit[v];a='\\\''/c.ass'`)
    // Le graphe reste celui qu'on a écrit : une seule incrustation, une seule
    // normalisation, et c'est toujours notre dernière étape qui rend [v].
    expect(graph.match(/ass=filename=/g)).toHaveLength(1)
    expect(graph.match(/loudnorm=/g)).toHaveLength(1)
    expect(graph.endsWith('[v]')).toBe(true)
  })

  it('NVENC ne reçoit jamais -hwaccel_output_format cuda', () => {
    const a = renderArgs({ ...base, segments: [entry(0, 10)] })
    expect(a).not.toContain('-hwaccel_output_format')
    expect(a).toContain('h264_nvenc')
  })

  // `-af` sur un flux issu de `-map [a]` fait échouer ffmpeg :
  // « Simple and complex filtering cannot be used together for the same
  // stream ». La normalisation appartient donc au graphe.
  it('normalise le son dans le graphe, jamais par -af', () => {
    const a = renderArgs({ ...base, segments: [entry(0, 10)] })
    expect(a).not.toContain('-af')
    expect(a).not.toContain('-filter:a')
    expect(a.join(' ')).toContain(LOUDNORM)
  })

  // `loudnorm` en passe unique sort à 192 kHz, et ffmpeg redescend alors au
  // plus haut taux que l'AAC accepte : mesuré, une source à 44,1 kHz ressortait
  // en 96 kHz. Le rééchantillonnage doit suivre la normalisation, pas la
  // précéder.
  // Les deux cas, parce que la chaîne audio n'a pas la même entrée : `0:a`
  // pour une entrée seule, la sortie `ac` du concat pour plusieurs.
  it.each([
    ['une entrée', [entry(0, 10)]],
    ['plusieurs entrées', [entry(0, 10), entry(20, 30)]],
  ])('fixe le taux de sortie derrière loudnorm — %s', (_name, segments) => {
    const a = renderArgs({ ...base, segments })
    const graph = a[a.indexOf('-filter_complex') + 1]
    expect(graph).toContain(`${LOUDNORM},${RESAMPLE},${AUDIO_TIMELINE}`)
    expect(RESAMPLE).toContain('48000')
  })

  // **La branche audio finit par `asetpts`, et c'est `concat` qui l'exige.**
  // Avec `a=1` il rend des trames qui partagent un horodatage ; le muxeur mov
  // les décale d'un tick chacune et les trois premières secondes déraillent.
  // Mesuré sur neuf rendus à plusieurs morceaux, aucun à un seul (issue #212).
  it.each([
    ['une entrée', [entry(0, 10)]],
    ['plusieurs entrées', [entry(0, 10), entry(20, 30)]],
  ])('réétiquette les horodatages du son en fin de branche — %s', (_name, segments) => {
    const a = renderArgs({ ...base, segments })
    const graph = a[a.indexOf('-filter_complex') + 1]
    expect(graph).toContain(`${RESAMPLE},${AUDIO_TIMELINE}[a]`)
  })

  // Une jonction de `concat` laisse un trou d'image que le mode par défaut
  // propage : sept morceaux donnaient quatre écarts de 33 ms, dix-neuf en
  // donnaient onze. Une seule fois, et en sortie — c'est une option de sortie.
  it('impose une cadence constante à la sortie', () => {
    const a = renderArgs({ ...base, segments: [entry(0, 10), entry(20, 30)] })
    expect(a.filter((x) => x === '-fps_mode')).toHaveLength(1)
    expect(a[a.indexOf('-fps_mode') + 1]).toBe('cfr')
    expect(a.indexOf('-fps_mode')).toBeGreaterThan(a.indexOf('-filter_complex'))
  })

  it('cadre au rectangle demandé puis met à l’échelle de sortie', () => {
    const a = renderArgs({ ...base, segments: [entry(0, 10)] })
    expect(a.join(' ')).toContain('crop=608:1080:656:0')
    expect(a.join(' ')).toContain('scale=1080:1920:flags=lanczos')
    expect(a.join(' ')).toContain('setsar=1')
  })

  // **Le natif ne compose jamais sur un fond flouté**, et c'est structurel : ses
  // entrées portent toutes le ratio du canevas — un seul pour tout le clip, le
  // plus large des plans —, donc le cadre le remplit. Un fond visible dans le
  // fichier du feed serait le défaut que ce choix existe pour éviter.
  it('ne fabrique aucun fond flouté quand le cadre remplit le canevas', () => {
    const a = renderArgs({ ...base, segments: [entry(0, 10), entry(20, 30)] })
    const graph = a[a.indexOf('-filter_complex') + 1]
    expect(graph).not.toContain('gblur')
    expect(graph).not.toContain('split=2')
  })

  it('mappe toujours [v] et [a], quelles que soient les options', () => {
    for (const options of [
      {},
      { assPath: '/c.ass' },
      { assPath: '/c.ass', fontsDir: '/f' },
      { logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }] },
      {
        assPath: '/c.ass',
        logos: [
          { path: '/a.png', x: 40, y: 250, w: 300, h: 90 },
          { path: '/b.png', x: 700, y: 250, w: 200, h: 90 },
        ],
      },
    ]) {
      for (const segments of [[entry(0, 10)], [entry(0, 10), entry(20, 30)]]) {
        const a = renderArgs({ ...base, ...options, segments })
        const graph = a[a.indexOf('-filter_complex') + 1]
        expect(graph).toContain('[v]')
        expect(graph).toContain('[a]')
        expect(a.join(' ')).toContain('-map [v] -map [a]')
      }
    }
  })

  // L'ordre compte et les étiquettes seules ne le disent pas : un logo posé
  // **avant** l'incrustation passerait sous les sous-titres et disparaîtrait
  // au premier carton qui monte assez haut.
  it('pose les logos par-dessus les sous-titres, et non dessous', () => {
    const a = renderArgs({
      ...base,
      segments: [entry(0, 10)],
      assPath: '/c.ass',
      logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
    })
    const graph = a[a.indexOf('-filter_complex') + 1]
    // L'incrustation rend l'étiquette que la superposition consomme.
    expect(graph).toContain("[v0]ass=filename='/c.ass'[vf0]")
    expect(graph).toContain('[vf0][lg0]overlay=x=40:y=250[v]')
  })

  // **L'ordre verrouillé : sous-titres → hook → marques**, comparé à la
  // chaîne exacte des trois étiquettes, comme les autres tests d'ordre de ce
  // fichier. Le hook s'incruste désormais en `overlay`, comme les logos — pas
  // de `scale=` préalable puisque le PNG arrive déjà à sa taille finale.
  it('incruste le hook APRÈS les sous-titres et AVANT les marques', () => {
    const a = renderArgs({
      ...base,
      segments: [entry(0, 10)],
      assPath: '/c.ass',
      hookImage: hookImage(),
      logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
    })
    const graph = a[a.indexOf('-filter_complex') + 1]
    expect(graph).toContain("[v0]ass=filename='/c.ass'[vf0]")
    // L'entrée `[1:v]` est le PNG du hook : la 0 est le segment, le hook suit,
    // les logos viennent après (voir le test des entrées ffmpeg plus bas).
    // `enable=` porte la borne temporelle — voir le describe dédié plus bas.
    expect(graph).toContain(
      "[vf0][1:v]overlay=x=60:y=90:enable='between(t,0,2)':shortest=1[vf1]",
    )
    // La marque est masquée pendant tout le hook (exit: 'none' par défaut,
    // donc apparition sèche à durationSec) — voir « les marques attendent la
    // fin du hook » plus bas pour le contrat complet.
    expect(graph).toContain("[vf1][lg0]overlay=x=40:y=250:enable='gte(t,2)'[v]")
  })

  // **Le cas qui casse en silence : le hook SANS sous-titres.** C'est alors
  // le hook qui doit écrire l'étiquette que le premier `overlay` attend — un
  // `chain()` mal compté laisserait ce cas produire une étiquette absente du
  // graphe, une erreur ffmpeg loin de la ligne qui la cause.
  it('incruste le hook seul (sans sous-titres) avant les marques', () => {
    const a = renderArgs({
      ...base,
      segments: [entry(0, 10)],
      hookImage: hookImage(),
      logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
    })
    const graph = a[a.indexOf('-filter_complex') + 1]
    expect(graph).toContain("[v0][1:v]overlay=x=60:y=90:enable='between(t,0,2)':shortest=1[vf0]")
    expect(graph).toContain("[vf0][lg0]overlay=x=40:y=250:enable='gte(t,2)'[v]")
  })

  // **Le PNG du hook prend une entrée à lui seul, entre les segments et les
  // logos** — sans ce décalage, un logo pointerait vers l'entrée du hook.
  it('décale les entrées des logos d’un cran quand un hook est présent', () => {
    const a = renderArgs({
      ...base,
      segments: [entry(0, 10)],
      hookImage: hookImage({ x: 0, y: 0, w: 100, h: 40 }),
      logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
    })
    const graph = a[a.indexOf('-filter_complex') + 1]
    // Segment = entrée 0, hook = entrée 1, logo = entrée 2.
    expect(graph).toContain('[2:v]scale=300:90[lg0]')
    const inputs = a.join(' ')
    expect(inputs).toContain('-i /h.png')
    expect(inputs).toContain('-i /logo.png')
    expect(inputs.indexOf('-i /h.png')).toBeLessThan(inputs.indexOf('-i /logo.png'))
  })

  // Les quatre combinaisons avec/sans sous-titres × avec/sans hook produisent
  // toutes un graphe valide, étiquette terminale `[v]` comprise — y compris
  // sur plusieurs segments, où `chain()` part de l'étiquette de concaténation
  // plutôt que de celle d'une entrée unique.
  it.each([
    ['ni sous-titres ni hook', {}],
    ['sous-titres seuls', { assPath: '/c.ass' }],
    ['hook seul', { hookImage: hookImage({ x: 0, y: 0, w: 100, h: 40 }) }],
    ['les deux', { assPath: '/c.ass', hookImage: hookImage({ x: 0, y: 0, w: 100, h: 40 }) }],
  ])('%s : produit un graphe valide, terminé par [v]/[a]', (_name, options) => {
    for (const segments of [[entry(0, 10)], [entry(0, 10), entry(20, 30)]]) {
      const a = renderArgs({ ...base, ...options, segments })
      const graph = a[a.indexOf('-filter_complex') + 1]
      expect(graph).toContain('[v]')
      expect(graph).toContain('[a]')
      expect(a.join(' ')).toContain('-map [v] -map [a]')
    }
  })

  // **Le contrat temporel du hook** (PR #117, seconde manche) : le PNG en
  // `overlay` ne porte plus lui-même de durée — `durationMs`/`enter`/`exit`
  // doivent donc se retrouver dans le graphe, comme l'ancien document ASS
  // (`hook-ass.ts`, supprimé) les portait par sa ligne `Dialogue` et sa
  // balise `\fad`. Un test de graphe par égalité de chaîne dit que le filtre
  // est écrit, pas que l'image s'éteint réellement à l'exécution — voir
  // `tmp/hook-proof/` pour la preuve à l'image.
  describe('le contrat temporel du hook', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it("borne l'incrustation à durationMs par enable='between(t,0,…)'", () => {
      const a = renderArgs({
        ...base,
        segments: [entry(0, 10)],
        hookImage: hookImage({ durationMs: 3_500 }),
      })
      const graph = a[a.indexOf('-filter_complex') + 1]
      expect(graph).toContain("overlay=x=60:y=90:enable='between(t,0,3.5)':shortest=1")
    })

    // `-loop 1` : sans lui, l'entrée du PNG ne décode qu'une seule image, que
    // `fade` ne peut animer — voir la doc de ce bloc dans `args.ts`.
    // `-framerate 30` fixe le débit de cette boucle, indépendant de la source.
    it('boucle le PNG du hook, et seulement lui', () => {
      const a = renderArgs({
        ...base,
        segments: [entry(0, 10)],
        hookImage: hookImage(),
        logos: [{ path: '/logo.png', x: 0, y: 0, w: 10, h: 10 }],
      })
      const inputs = a.join(' ')
      expect(inputs).toContain('-loop 1 -framerate 30 -i /h.png')
      expect(inputs).not.toContain('-loop 1 -framerate 30 -i /logo.png')
      expect(inputs).not.toContain('-loop 1 -i /s.mp4')
    })

    it('ne pose aucun filtre de fondu quand enter et exit valent none', () => {
      const a = renderArgs({
        ...base,
        segments: [entry(0, 10)],
        hookImage: hookImage({ enter: 'none', exit: 'none' }),
      })
      const graph = a[a.indexOf('-filter_complex') + 1]
      expect(graph).not.toContain('format=rgba')
      expect(graph).not.toContain('fade=')
      // Sans fondu, l'overlay lit directement l'entrée brute du hook.
      expect(graph).toContain("[1:v]overlay=x=60:y=90:enable='between(t,0,2)':shortest=1")
    })

    it("pose un fondu d'entrée sur le flux brut du hook quand enter vaut fade", () => {
      const a = renderArgs({
        ...base,
        segments: [entry(0, 10)],
        hookImage: hookImage({ enter: 'fade', exit: 'none', durationMs: 2_000 }),
      })
      const graph = a[a.indexOf('-filter_complex') + 1]
      expect(graph).toContain('[1:v]format=rgba,fade=t=in:st=0:d=0.3:alpha=1[hk]')
      expect(graph).toContain("[hk]overlay=x=60:y=90:enable='between(t,0,2)':shortest=1")
      expect(graph).not.toContain('fade=t=out')
    })

    it('pose un fondu de sortie qui finit avant durationMs quand exit vaut fade', () => {
      const a = renderArgs({
        ...base,
        segments: [entry(0, 10)],
        hookImage: hookImage({ enter: 'none', exit: 'fade', durationMs: 2_000 }),
      })
      const graph = a[a.indexOf('-filter_complex') + 1]
      // 2 s de durée, 0,3 s de fondu : le fondu commence à 1,7 s et finit pile
      // à 2 s, l'instant où `enable=` éteint déjà l'incrustation.
      expect(graph).toContain('[1:v]format=rgba,fade=t=out:st=1.7:d=0.3:alpha=1[hk]')
      expect(graph).not.toContain('fade=t=in')
    })

    it('pose les deux fondus, dans le même filtre, quand les deux valent fade', () => {
      const a = renderArgs({
        ...base,
        segments: [entry(0, 10)],
        hookImage: hookImage({ enter: 'fade', exit: 'fade', durationMs: 2_000 }),
      })
      const graph = a[a.indexOf('-filter_complex') + 1]
      expect(graph).toContain(
        '[1:v]format=rgba,fade=t=in:st=0:d=0.3:alpha=1,fade=t=out:st=1.7:d=0.3:alpha=1[hk]',
      )
    })

    // **Bornage au plancher de durée** (200 ms, `HOOK_BOUNDS.durationMs.min`) :
    // deux fondus de 300 ms se chevaucheraient sur toute la durée et le hook
    // n'atteindrait jamais son opacité normale. Chaque fondu se borne donc à
    // la moitié de `durationMs` — 100 ms ici, pas 300.
    it('borne chaque fondu à la moitié de durationMs, au plancher', () => {
      const a = renderArgs({
        ...base,
        segments: [entry(0, 10)],
        hookImage: hookImage({ enter: 'fade', exit: 'fade', durationMs: 200 }),
      })
      const graph = a[a.indexOf('-filter_complex') + 1]
      expect(graph).toContain(
        '[1:v]format=rgba,fade=t=in:st=0:d=0.1:alpha=1,fade=t=out:st=0.1:d=0.1:alpha=1[hk]',
      )
    })

    // `glitch`/`scanline` ne sont pas implémentées (remis à plus tard par le
    // propriétaire) : elles se comportent comme `none` — aucun filtre de
    // fondu — mais avertissent, pour ne pas laisser croire en silence qu'une
    // transition a été appliquée.
    it.each(['glitch', 'scanline'] as const)(
      "traite %s comme none : aucun fondu, mais un avertissement",
      (transition) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const a = renderArgs({
          ...base,
          segments: [entry(0, 10)],
          hookImage: hookImage({ enter: transition, exit: 'none' }),
        })
        const graph = a[a.indexOf('-filter_complex') + 1]
        expect(graph).not.toContain('format=rgba')
        expect(graph).not.toContain('fade=')
        expect(warn).toHaveBeenCalledTimes(1)
        expect(String(warn.mock.calls[0]?.[0])).toContain(transition)
      },
    )
  })

  // **Les marques attendent la fin du hook.** Pendant que le hook occupe
  // l'écran, une marque posée dessous serait invisible, une marque posée
  // dessus le recouvrirait : ni l'un ni l'autre n'a de sens. `logoAppearSec`
  // reprend tel quel le fondu de sortie du hook (`hookFadeOutMs`) — la marque
  // apparaît exactement quand le hook commence à s'effacer, et finit
  // d'apparaître pile à l'instant où `enable=` du hook l'éteint : même
  // rythme, jamais un rythme indépendant qui déraperait de quelques images.
  describe('les marques attendent la fin du hook', () => {
    it("masque la marque jusqu'à durationSec quand le hook n'a pas de fondu de sortie", () => {
      const a = renderArgs({
        ...base,
        segments: [entry(0, 10)],
        hookImage: hookImage({ exit: 'none', durationMs: 3_000 }),
        logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
      })
      const graph = a[a.indexOf('-filter_complex') + 1]
      // Pas de fondu de sortie sur le hook -> pas de fondu sur la marque non
      // plus, seulement une apparition sèche au même instant.
      expect(graph).not.toContain('fade=t=in')
      expect(graph).toContain("overlay=x=40:y=250:enable='gte(t,3)'[v]")
    })

    it('fait apparaître la marque en fondu, synchronisé sur le fondu de sortie du hook', () => {
      const a = renderArgs({
        ...base,
        segments: [entry(0, 10)],
        hookImage: hookImage({ exit: 'fade', durationMs: 2_000 }),
        logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
      })
      const graph = a[a.indexOf('-filter_complex') + 1]
      // Le hook s'efface entre 1,7 s et 2 s (fondu de 0,3 s) : la marque suit
      // exactement le même intervalle.
      expect(graph).toContain('[2:v]scale=300:90,format=rgba,fade=t=in:st=1.7:d=0.3:alpha=1[lg0]')
      // `:shortest=1` : la marque est bouclée (voir le test dédié plus bas),
      // donc infinie — sans lui, ce rendu ne se terminerait jamais, comme le
      // hook.
      expect(graph).toContain("overlay=x=40:y=250:enable='gte(t,1.7)':shortest=1[v]")
    })

    // **Le piège du hook, retrouvé sur les marques.** `fade=` a besoin d'un
    // flux dont les images continuent d'arriver au fil du temps pour animer
    // quoi que ce soit (voir la doc de `-loop 1 -framerate 30` sur l'entrée du
    // hook, plus haut) — un logo décodé une seule fois, sans boucle, ne
    // fournit qu'UNE image à `fade`, évaluée à son PTS d'origine (~0), donc
    // transparente puisque avant `st`. `overlay` répète ensuite cette image
    // figée pour tout le reste du clip (`eof_action=repeat` par défaut) : la
    // marque ne redevient JAMAIS visible, quelle que soit `enable=`.
    // Reproduit à l'image sur un vrai export avant ce test.
    it("boucle l'entrée d'une marque quand elle porte un fondu, comme le hook", () => {
      const a = renderArgs({
        ...base,
        segments: [entry(0, 10)],
        hookImage: hookImage({ exit: 'fade', durationMs: 2_000 }),
        logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
      })
      const inputs = a.join(' ')
      expect(inputs).toContain('-loop 1 -framerate 30 -i /logo.png')
    })

    // Sans fondu à porter — pas de hook, ou un hook dont l'`exit` ne fond pas
    // — une marque garde son entrée non bouclée : une seule image décodée
    // suffit, `overlay` la répète telle quelle.
    it("ne boucle pas l'entrée d'une marque sans fondu à porter", () => {
      const sansHook = renderArgs({
        ...base,
        segments: [entry(0, 10)],
        logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
      })
      expect(sansHook.join(' ')).not.toContain('-loop 1 -framerate 30 -i /logo.png')

      const hookSansFondu = renderArgs({
        ...base,
        segments: [entry(0, 10)],
        hookImage: hookImage({ exit: 'none' }),
        logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
      })
      expect(hookSansFondu.join(' ')).not.toContain('-loop 1 -framerate 30 -i /logo.png')
    })

    it("laisse les marques visibles dès la première image quand il n'y a pas de hook", () => {
      const a = renderArgs({
        ...base,
        segments: [entry(0, 10)],
        logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
      })
      const graph = a[a.indexOf('-filter_complex') + 1]
      expect(graph).toContain('overlay=x=40:y=250[v]')
      expect(graph).not.toContain('enable=')
    })

    it('synchronise toutes les marques sur le même instant', () => {
      const a = renderArgs({
        ...base,
        segments: [entry(0, 10)],
        hookImage: hookImage({ exit: 'fade', durationMs: 2_000 }),
        logos: [
          { path: '/logo.png', x: 40, y: 250, w: 300, h: 90 },
          { path: '/twitch.png', x: 700, y: 260, w: 200, h: 60 },
        ],
      })
      const graph = a[a.indexOf('-filter_complex') + 1]
      expect(graph.match(/fade=t=in:st=1\.7:d=0\.3:alpha=1/g)).toHaveLength(2)
      expect(graph.match(/enable='gte\(t,1\.7\)'/g)).toHaveLength(2)
    })
  })

  it('enchaîne les logos dans l’ordre reçu', () => {
    const a = renderArgs({
      ...base,
      segments: [entry(0, 10)],
      logos: [
        { path: '/a.png', x: 10, y: 20, w: 100, h: 50 },
        { path: '/b.png', x: 30, y: 40, w: 200, h: 60 },
      ],
    })
    const graph = a[a.indexOf('-filter_complex') + 1]
    expect(graph).toContain('[v0][lg0]overlay=x=10:y=20[vf0]')
    expect(graph).toContain('[vf0][lg1]overlay=x=30:y=40[v]')
  })

  // TypeScript garantit `number` à la compilation et rien à l'exécution. Ces
  // valeurs entrent directement dans le graphe : une chaîne forcée par un cast
  // y écrirait ce qu'elle veut.
  it.each([
    [
      'segments[0].crop.x',
      { segments: [entry(0, 10, { w: 608, h: 1080, x: Number.NaN, y: 0 })] },
    ],
    ['out.w', { segments: [entry(0, 10)], out: { w: Number.POSITIVE_INFINITY, h: 1920 } }],
    [
      'logos[0].x',
      {
        segments: [entry(0, 10)],
        logos: [{ path: '/l.png', x: Number.NaN, y: 0, w: 10, h: 10 }],
      },
    ],
    [
      'logos[0].w',
      {
        segments: [entry(0, 10)],
        logos: [{ path: '/l.png', x: 0, y: 0, w: Number.NaN, h: 10 }],
      },
    ],
  ])('refuse %s non fini plutôt que de l’écrire dans le graphe', (what, override) => {
    expect(() => renderArgs({ ...base, ...override })).toThrow(
      new RegExp(what.replace(/[[\]./]/g, '\\$&')),
    )
  })

  it('ajoute une entrée par logo, sans -hwaccel — une image ne se décode pas au GPU', () => {
    const a = renderArgs({
      ...base,
      segments: [entry(0, 10)],
      logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
    })
    expect(count(a, '-i')).toBe(2)
    expect(count(a, '-hwaccel')).toBe(1)
    expect(a).toContain('/logo.png')
    expect(a.join(' ')).toContain('scale=300:90')
    expect(a.join(' ')).toContain('overlay=x=40:y=250')
  })

  it('efface les métadonnées et place l’index en tête du fichier', () => {
    const a = renderArgs({ ...base, segments: [entry(0, 10)] })
    for (const token of METADATA_SCRUB) expect(a).toContain(token)
    expect(a.join(' ')).toContain('-movflags +faststart')
    expect(a[a.length - 1]).toBe('/o.mp4')
  })

  it('durée = fin - début, et jamais la fin brute', () => {
    const a = renderArgs({ ...base, segments: [entry(2841.2, 2856.9)] })
    expect(a.join(' ')).toContain('-ss 2841.2 -t 15.7')
    expect(a).not.toContain('2856.9')
  })

  // **Une entrée vide ouvre un décodeur qui ne rend aucune image**, et décale
  // d'autant les sous-titres, qui sont calés sur la somme des durées demandées.
  // Elle est refusée plutôt que jetée : `renderArgs` ne normalise plus, puisque
  // deux entrées adjacentes portent deux cadres différents, donc ce qui arrive
  // ici est déjà canonique et une anomalie est une erreur de l'appelant.
  it.each([
    ['vide', entry(200, 200)],
    ['inversée', entry(300, 290)],
  ])('refuse une entrée %s au lieu de la jeter en silence', (_name, bad) => {
    expect(() => renderArgs({ ...base, segments: [entry(100, 110), bad] })).toThrow(
      /segments\[1\]/,
    )
  })

  // **Les entrées ne se fusionnent plus, et c'est le point.** Deux entrées qui
  // se touchent sont les deux moitiés d'un segment coupé sur une frontière de
  // plan : les fusionner ferait cadrer la seconde avec le rectangle de la
  // première, sans erreur et sans trace.
  it('ne fusionne pas deux entrées qui se touchent', () => {
    const a = renderArgs({
      ...base,
      segments: [
        entry(100, 110, { w: 608, h: 1080, x: 0, y: 0 }),
        entry(110, 120, { w: 608, h: 1080, x: 1312, y: 0 }),
      ],
    })
    expect(count(a, '-i')).toBe(2)
    expect(a.join(' ')).toContain('-ss 100 -t 10')
    expect(a.join(' ')).toContain('-ss 110 -t 10')
  })

  // Le recalage des sous-titres additionne les durées des entrées dans leur
  // ordre. Deux entrées qui se chevauchent feraient afficher les bons mots au
  // mauvais moment sur tout ce qui suit — et aucun test de durée ne le verrait,
  // puisque la somme, elle, ne change pas.
  it('refuse deux entrées qui se chevauchent', () => {
    expect(() =>
      renderArgs({ ...base, segments: [entry(100, 120), entry(110, 130)] }),
    ).toThrow(/segments\[1\]/)
  })

  it('refuse de construire un rendu sans une seule entrée', () => {
    expect(() => renderArgs({ ...base, segments: [] })).toThrow()
  })

  // Le pire des deux : une comparaison `end > start` est fausse dès qu'une borne
  // vaut NaN, donc une normalisation ferait disparaître l'entrée sans un mot et
  // un clip de trois en rendrait deux. Une borne infinie, elle, ressortirait en
  // `-t Infinity`.
  it.each([
    ['NaN au début', entry(Number.NaN, 20)],
    ['NaN à la fin', entry(10, Number.NaN)],
    ['fin infinie', entry(10, Number.POSITIVE_INFINITY)],
  ])('refuse une borne non finie (%s) au lieu de perdre l’entrée', (_name, bad) => {
    expect(() =>
      renderArgs({ ...base, segments: [entry(0, 10), bad, entry(30, 40)] }),
    ).toThrow(/segments\[1\]/)
  })

  // Le message doit nommer la valeur reçue : `JSON.stringify` rend `null` pour
  // NaN comme pour les infinis, et désignerait donc une valeur que l'appelant
  // n'a jamais passée.
  it('nomme la valeur fautive dans le message', () => {
    expect(() => renderArgs({ ...base, segments: [entry(Number.NaN, 10)] })).toThrow(/NaN/)
    expect(() =>
      renderArgs({ ...base, segments: [entry(0, Number.POSITIVE_INFINITY)] }),
    ).toThrow(/Infinity/)
  })
})

describe('blurredVariantArgs', () => {
  // Un plan en 1:1 : le cas qui a fait naître #22, et celui que la variante
  // existe pour porter sur TikTok (spec §2 — 48 % du temps tient jusqu'au 1:1,
  // contre 24 à 33 % en 9:16).
  const base = {
    src: '/s.mp4',
    dst: '/o-9x16.mp4',
    segments: [entry(0, 10, FRAME_1_X_1, '1:1' as Ratio)],
    out: { w: 1080, h: 1080 },
    encoder: 'nvenc' as const,
  }

  const graph = (a: string[]) => a[a.indexOf('-filter_complex') + 1]

  it('sort en 1080x1920', () => {
    const a = blurredVariantArgs(base)
    expect(a.join(' ')).toContain('scale=1080:1920:force_original_aspect_ratio=increase')
    expect(a.join(' ')).toContain('crop=1080:1920')
  })

  // Le contenu est **déjà cropé** : il se pose pleine largeur et centré, pas au
  // ratio 0,42 d'OpenShorts, qui visait du 16:9 brut. Un 1:1 occupe alors 56,3 %
  // de la hauteur et un 4:5 70,3 %, contre 31,6 % pour un 16:9 en letterbox.
  it('pose le contenu pleine largeur et centré, pas à 42 % de la hauteur', () => {
    const a = blurredVariantArgs(base).join(' ')
    expect(a).toContain('scale=1080:1080:flags=lanczos')
    expect(a).toContain('overlay=x=0:y=(H-h)/2')
    expect(a).not.toContain('0.42')
  })

  it('floute le fond', () => {
    expect(blurredVariantArgs(base).join(' ')).toContain('gblur=sigma=12')
  })

  // **Le même mécanisme que `renderArgs` — `buildRender` est partagé —, mais
  // pas le même `hookImage`.** Contrairement à l'ancien document ASS, écrit
  // une fois en unités de script et incrusté à l'identique sur les deux
  // canevas, le PNG et son placement sont mesurés en pixels : c'est
  // `renderClip` qui doit passer un `hookImage` propre à CE canevas, pas
  // cette fonction qui le partagerait à tort.
  it('incruste le hookImage de cette sortie, en overlay comme les logos', () => {
    const g = graph(
      blurredVariantArgs({ ...base, hookImage: hookImage({ x: 30, y: 40, w: 200, h: 80 }) }),
    )
    expect(g).toContain('[1:v]overlay=x=30:y=40')
  })

  // `buildRender` est partagé avec `renderArgs`, mais rien ne garantit que la
  // variante reçoive le même traitement temporel sans un test qui le vérifie
  // ICI : le piège documenté par le contrat de la seconde manche (« les deux
  // sorties ») est précisément qu'un correctif posé côté natif passe à côté
  // de la variante 9:16. Relevé par Aristarque, PR #117, passe 4.
  it("borne aussi la variante à durationMs et pose shortest=1, comme renderArgs", () => {
    const g = graph(
      blurredVariantArgs({
        ...base,
        hookImage: hookImage({ x: 30, y: 40, w: 200, h: 80, durationMs: 3500 }),
      }),
    )
    expect(g).toContain("overlay=x=30:y=40:enable='between(t,0,3.5)':shortest=1")
  })

  // Même garde que ci-dessus, pour l'attente des marques sur la fin du hook :
  // `buildRender` est partagé, mais rien ne garantit que la variante suive
  // sans un test qui le vérifie ICI.
  it('fait aussi attendre les marques de cette sortie, comme renderArgs', () => {
    const g = graph(
      blurredVariantArgs({
        ...base,
        hookImage: hookImage({ x: 30, y: 40, w: 200, h: 80, exit: 'fade', durationMs: 2_000 }),
        logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
      }),
    )
    expect(g).toContain('format=rgba,fade=t=in:st=1.7:d=0.3:alpha=1')
    expect(g).toContain("overlay=x=40:y=250:enable='gte(t,1.7)'")
  })

  // **La hauteur occupée suit le ratio du plan**, et c'est la table de la
  // conception : un 9:16 remplit, un 4:5 occupe 1350 des 1920, un 1:1 1080, un
  // 16:9 608. Elle se calcule sur le **ratio nominal** et jamais sur le
  // rectangle de crop : `cropRect` arrondit au pair, donc un 9:16 sort en
  // 608x1080 et la hauteur déduite de ce rapport tomberait à 1918 — deux pixels
  // de fond flouté en haut et en bas d'un cadre qui devait remplir.
  it.each([
    ['4:5', { w: 864, h: 1080, x: 528, y: 0 }, 1350],
    ['1:1', FRAME_1_X_1, 1080],
    ['16:9', { w: 1920, h: 1080, x: 0, y: 0 }, 608],
  ])('pose un plan %s sur %s pixels de haut', (ratio, crop, hauteur) => {
    const g = graph(blurredVariantArgs({ ...base, segments: [entry(0, 10, crop, ratio as Ratio)] }))
    expect(g).toContain(`scale=1080:${hauteur}:flags=lanczos`)
  })

  // **Le cas qui n'a pas de fond**, et il ne doit pas en fabriquer un : un plan
  // déjà en 9:16 remplit le canevas, et le composer quand même ferait payer un
  // `gblur` sur une image que rien ne montre.
  it('ne fabrique pas de fond pour un plan déjà en 9:16', () => {
    const g = graph(blurredVariantArgs({ ...base, segments: [entry(0, 10)] }))
    expect(g).toBe(
      '[0:v]crop=608:1080:656:0,scale=1080:1920:flags=lanczos,setsar=1[v];' +
        `[0:a]${LOUDNORM},${RESAMPLE},${AUDIO_TIMELINE}[a]`,
    )
  })

  // **Le ratio varie par plan, et c'est ce que la variante apporte.** Un plan
  // serré remplit, un plan large est posé sur son fond : le saut tombe sur une
  // coupe, donc il ne se voit pas. Un ratio unique pour tout le clip écraserait
  // le plan serré sous le plus large.
  it('compose chaque plan à son propre ratio, avant la concaténation', () => {
    const g = graph(
      blurredVariantArgs({
        ...base,
        segments: [
          entry(0, 10),
          entry(10, 20, { w: 1920, h: 1080, x: 0, y: 0 }, '16:9'),
        ],
      }),
    )
    expect(g).toBe(
      '[0:v]crop=608:1080:656:0,scale=1080:1920:flags=lanczos,setsar=1[v0];' +
        '[1:v]crop=1920:1080:0:0,setsar=1[c1];' +
        '[c1]split=2[bga1][fga1];' +
        '[bga1]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=12[bg1];' +
        '[fga1]scale=1080:608:flags=lanczos[fg1];' +
        '[bg1][fg1]overlay=x=0:y=(H-h)/2,setsar=1[v1];' +
        '[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[v][ac];' +
        `[ac]${LOUDNORM},${RESAMPLE},${AUDIO_TIMELINE}[a]`,
    )
  })

  // **Le test du ticket #22, et le seul qui compte vraiment ici.** La variante
  // partait du rendu natif déjà incrusté : son fond était un agrandissement du
  // clip fini, cartons compris, et `gblur=sigma=12` n'efface pas des lettres de
  // 40 px cerclées d'un contour de 8 — vérifié à l'image, le carton restait
  // pleinement lisible, le jaune du mot actif compris.
  //
  // La parade n'est pas de monter le sigma, c'est de tirer le fond d'un contenu
  // qui n'a jamais porté de texte : le `split` est **avant** l'incrustation, et
  // celle-ci a lieu sur le canevas composé, donc après.
  it("ne laisse ni sous-titre ni marque atteindre le fond flouté", () => {
    const g = graph(
      blurredVariantArgs({
        ...base,
        assPath: '/c.ass',
        logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
      }),
    )
    // Le fond part de la sortie du `split`, et va au flou sans rien croiser.
    expect(g).toContain(
      '[bga0]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=12[bg0]',
    )
    // L'incrustation, elle, arrive après la composition, sur le canevas entier.
    expect(g).toContain('[bg0][fg0]overlay=x=0:y=(H-h)/2,setsar=1[v0]')
    expect(g).toContain("[v0]ass=filename='/c.ass'[vf0]")
    expect(g).toContain('[vf0][lg0]overlay=x=40:y=250[v]')
    // Une seule incrustation et une seule marque dans tout le graphe : rien
    // n'est appliqué deux fois, donc rien ne peut l'être au fond.
    expect(g.match(/ass=filename=/g)).toHaveLength(1)
    expect(g.match(/overlay=x=40:y=250/g)).toHaveLength(1)
  })

  // **Le texte s'incruste à l'échelle du canevas, jamais dans l'image avant sa
  // mise à l'échelle.** L'ordre inverse le réduisait avec elle : un 16:9 posé
  // dans un 9:16 s'y retrouvait à 31,6 % de sa taille, illisible — et avec un
  // ratio qui varie par plan, il aurait changé de taille à chaque coupe.
  it('incruste les sous-titres après la composition, pas avant', () => {
    const g = graph(blurredVariantArgs({ ...base, assPath: '/c.ass' }))
    expect(g.indexOf('overlay=x=0:y=(H-h)/2')).toBeLessThan(g.indexOf('ass=filename='))
    // Et surtout : plus aucune mise à l'échelle ne suit l'incrustation.
    expect(g.slice(g.indexOf('ass=filename='))).not.toContain('scale=')
  })

  // Le corollaire, et ce qui rend le tout correct **par construction** plutôt
  // que par réglage : la variante se rend depuis la source, comme le natif, au
  // lieu de recycler le MP4 natif.
  it('part de la source et de ses segments, jamais du rendu natif', () => {
    const a = blurredVariantArgs({
      ...base,
      segments: [
        entry(100, 110, FRAME_1_X_1, '1:1'),
        entry(200, 215, FRAME_1_X_1, '1:1'),
      ],
    })
    expect(count(a, '-i')).toBe(2)
    expect(a.join(' ')).toContain(
      '-hwaccel cuda -ss 100 -t 10 -i /s.mp4 -hwaccel cuda -ss 200 -t 15 -i /s.mp4',
    )
    expect(a.join(' ')).toContain('concat=n=2:v=1:a=1')
  })

  // Le graphe entier, sur le cas le plus simple : une entrée, pas de marque.
  // Le vérifier en entier exclut une étiquette orpheline ou écrite deux fois.
  it('assemble un graphe complet et sans étape morte', () => {
    expect(graph(blurredVariantArgs({ ...base, assPath: '/c.ass' }))).toBe(
      '[0:v]crop=1080:1080:420:0,setsar=1[c0];' +
        '[c0]split=2[bga0][fga0];' +
        '[bga0]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=12[bg0];' +
        '[fga0]scale=1080:1080:flags=lanczos[fg0];' +
        '[bg0][fg0]overlay=x=0:y=(H-h)/2,setsar=1[v0];' +
        `[0:a]${LOUDNORM},${RESAMPLE},${AUDIO_TIMELINE}[a];` +
        "[v0]ass=filename='/c.ass'[v]",
    )
  })

  // **La jonction que personne ne regarde : chaque entrée est composée AVANT le
  // `concat`.** C'est ce que `concat` exige — des flux de même taille — et le
  // cas à une entrée ne le dit pas, alors qu'un clip monté est la règle et non
  // l'exception : c'est la décision fondatrice du projet, un clip est une liste
  // de segments. Le graphe entier, plutôt qu'un comptage de `-i`, est ce qui
  // interdit une étiquette orpheline entre les deux. (relevé par Aristarque)
  it('assemble le graphe de la variante sur un clip à deux entrées', () => {
    expect(
      graph(
        blurredVariantArgs({
          ...base,
          segments: [
            entry(100, 110, FRAME_1_X_1, '1:1'),
            entry(200, 215, FRAME_1_X_1, '1:1'),
          ],
          assPath: '/c.ass',
        }),
      ),
    ).toBe(
      '[0:v]crop=1080:1080:420:0,setsar=1[c0];' +
        '[c0]split=2[bga0][fga0];' +
        '[bga0]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=12[bg0];' +
        '[fga0]scale=1080:1080:flags=lanczos[fg0];' +
        '[bg0][fg0]overlay=x=0:y=(H-h)/2,setsar=1[v0];' +
        '[1:v]crop=1080:1080:420:0,setsar=1[c1];' +
        '[c1]split=2[bga1][fga1];' +
        '[bga1]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=12[bg1];' +
        '[fga1]scale=1080:1080:flags=lanczos[fg1];' +
        '[bg1][fg1]overlay=x=0:y=(H-h)/2,setsar=1[v1];' +
        '[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[vc][ac];' +
        `[ac]${LOUDNORM},${RESAMPLE},${AUDIO_TIMELINE}[a];` +
        "[vc]ass=filename='/c.ass'[v]",
    )
  })

  // Le même graphe **sans sous-titre ni marque**, parce que c'est le cas limite
  // d'`enchaîner` : aucune étape ne suit, donc c'est la composition elle-même
  // qui doit écrire dans l'étiquette terminale au lieu d'un `v0` que plus
  // personne ne lirait. Un clip sans sous-titres est un réglage de l'interface,
  // pas une curiosité. (relevé par Aristarque)
  it("assemble le graphe de la variante d'un clip sans sous-titres", () => {
    expect(graph(blurredVariantArgs(base))).toBe(
      '[0:v]crop=1080:1080:420:0,setsar=1[c0];' +
        '[c0]split=2[bga0][fga0];' +
        '[bga0]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=12[bg0];' +
        '[fga0]scale=1080:1080:flags=lanczos[fg0];' +
        '[bg0][fg0]overlay=x=0:y=(H-h)/2,setsar=1[v];' +
        `[0:a]${LOUDNORM},${RESAMPLE},${AUDIO_TIMELINE}[a]`,
    )
  })

  // Le son ne peut plus être recopié du natif — la variante ne le lit plus. Il
  // est normalisé **une fois**, depuis la source, exactement comme celui du
  // natif : c'est le même traitement sur le même PCM, donc aucune compression
  // en cascade.
  it('normalise le son depuis la source, une seule fois', () => {
    const a = blurredVariantArgs(base)
    expect(a.join(' ')).not.toContain('-c:a copy')
    expect(graph(a).match(/loudnorm=/g)).toHaveLength(1)
    expect(a.join(' ')).toContain(`${LOUDNORM},${RESAMPLE},${AUDIO_TIMELINE}`)
    expect(a.join(' ')).toContain('-c:a aac')
  })

  it('ne demande pas non plus -hwaccel_output_format', () => {
    expect(blurredVariantArgs(base)).not.toContain('-hwaccel_output_format')
  })

  it('finit par la destination', () => {
    const a = blurredVariantArgs(base)
    expect(a[a.length - 1]).toBe('/o-9x16.mp4')
  })

  // La variante est publiée sur les réseaux : c'est le fichier qui doit le
  // moins traîner les métadonnées de la source.
  it('efface les métadonnées de la source', () => {
    const a = blurredVariantArgs(base)
    for (const token of METADATA_SCRUB) expect(a).toContain(token)
  })

  // Les gardes de `renderArgs` valent pour la variante : c'est le même
  // constructeur, et une borne perdue y coûterait le même segment muet.
  it('refuse une borne non finie, comme le rendu natif', () => {
    expect(() =>
      blurredVariantArgs({ ...base, segments: [entry(Number.NaN, 10, FRAME_1_X_1, '1:1')] }),
    ).toThrow(/segments\[0\]/)
    expect(() => blurredVariantArgs({ ...base, segments: [] })).toThrow()
  })

  // **Une entrée splittée devient `split` → deux `crop`/`scale` → `vstack`**,
  // et non un crop unique sur fond flouté : c'est la forme que le contrat fixe,
  // et le seul moyen pour un plan à deux personnes de sortir en deux cellules.
  describe('une entrée splittée', () => {
    it('produit un split, deux crop/scale et un vstack, jamais de fond', () => {
      const g = graph(
        blurredVariantArgs({
          ...base,
          segments: [entry(0, 10, FRAME_1_X_1, '1:1', SPLIT_CELLS)],
        }),
      )
      expect(g).toContain('split=2')
      expect((g.match(/crop=/g) ?? []).length).toBe(2)
      expect((g.match(/scale=1080:960/g) ?? []).length).toBe(2)
      expect(g).toContain('vstack=inputs=2')
      expect(g).not.toContain('gblur')
      expect(g).not.toContain('force_original_aspect_ratio')
    })

    it('cadre chaque cellule sur son propre rectangle', () => {
      const g = graph(
        blurredVariantArgs({
          ...base,
          segments: [entry(0, 10, FRAME_1_X_1, '1:1', SPLIT_CELLS)],
        }),
      )
      expect(g).toContain('crop=900:800:100:50')
      expect(g).toContain('crop=900:800:900:100')
    })

    it('sort la même taille de canevas que le natif — 1080x1920', () => {
      const a = blurredVariantArgs({
        ...base,
        segments: [entry(0, 10, FRAME_1_X_1, '1:1', SPLIT_CELLS)],
      })
      // `vstack` de deux cellules 1080x960 remplit exactement le canevas
      // vertical : pas de `scale=1080:1920` séparé après l'empilement.
      expect(a.join(' ')).not.toContain('scale=1080:1920')
    })
  })
})

// Le fichier de sortie est positionnel : un chemin commençant par `-` serait lu
// comme une option. Mesuré sur le binaire : sans `--`, ffmpeg échoue sur
// « Unrecognized option 'sortie.mp4' » ; avec, il écrit le fichier. Sur un
// chemin absolu, `--` ne change rien.
describe('la garde `--` devant la destination', () => {
  it.each([
    ['proxyArgs', proxyArgs({ src: '/s.mp4', dst: '/-p.mp4', encoder: 'x264' })],
    ['audioArgs', audioArgs({ src: '/s.mp4', dst: '/-a.wav' })],
    [
      'renderArgs',
      renderArgs({
        src: '/s.mp4',
        dst: '/-o.mp4',
        segments: [entry(0, 10)],
        out: { w: 1080, h: 1920 },
        encoder: 'nvenc',
      }),
    ],
    [
      'blurredVariantArgs',
      blurredVariantArgs({
        src: '/s.mp4',
        dst: '/-o-9x16.mp4',
        segments: [entry(0, 10, FRAME_1_X_1, '1:1')],
        out: { w: 1080, h: 1080 },
        encoder: 'nvenc',
      }),
    ],
  ])('%s la pose', (_name, a) => {
    expect(a[a.length - 2]).toBe('--')
    expect(count(a, '--')).toBe(1)
  })
})
