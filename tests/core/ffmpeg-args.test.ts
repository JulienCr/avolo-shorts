import { describe, it, expect } from 'vitest'
import { LOUDNORM, METADATA_SCRUB, RESAMPLE, videoEncodeArgs } from '@/core/ffmpeg/encoder'
import { audioArgs, blurredVariantArgs, proxyArgs, renderArgs, thumbArgs } from '@/core/ffmpeg/args'

const compte = (argv: string[], jeton: string) => argv.filter((x) => x === jeton).length

describe('videoEncodeArgs', () => {
  it('porte les réglages x264 mesurés, par palier', () => {
    expect(videoEncodeArgs('x264', 'quality')).toEqual([
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    ])
    expect(videoEncodeArgs('x264', 'fast')).toEqual([
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    ])
  })

  // libx264 conserve le format de la source : une source en 10 bits ou en
  // 4:2:2 sortirait dans un format que les plateformes rejettent, sans
  // avertissement. Les deux encodeurs le posent donc, à tous les paliers.
  it('force yuv420p sur les deux encodeurs, à tous les paliers', () => {
    for (const encodeur of ['x264', 'nvenc'] as const) {
      for (const palier of ['quality', 'fast'] as const) {
        const a = videoEncodeArgs(encodeur, palier)
        expect(a[a.indexOf('-pix_fmt') + 1]).toBe('yuv420p')
      }
    }
  })

  it('porte les réglages NVENC, avec -pix_fmt yuv420p', () => {
    expect(videoEncodeArgs('nvenc', 'quality')).toEqual([
      '-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr',
      '-cq', '25', '-b:v', '0', '-spatial-aq', '1', '-temporal-aq', '1',
      '-pix_fmt', 'yuv420p',
    ])
    expect(videoEncodeArgs('nvenc', 'fast')).toEqual([
      '-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr',
      '-cq', '25', '-b:v', '0', '-spatial-aq', '1', '-pix_fmt', 'yuv420p',
    ])
  })

  // La table est une constante du module : la rendre telle quelle laisserait
  // n'importe quel appelant la modifier pour tous les suivants.
  it('rend une copie, pas la table elle-même', () => {
    const a = videoEncodeArgs('nvenc', 'quality')
    a.push('-sabotage')
    expect(videoEncodeArgs('nvenc', 'quality')).not.toContain('-sabotage')
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
    expect(compte(a, '/p.mp4')).toBe(1)
  })

  // Le proxy est servi au navigateur (tâche 11) : le titre de l'émission, la
  // date d'enregistrement et le logiciel de capture n'ont rien à y faire.
  it('efface les métadonnées de la source', () => {
    const a = proxyArgs({ ...base, encoder: 'x264' })
    for (const jeton of METADATA_SCRUB) expect(a).toContain(jeton)
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

describe('renderArgs', () => {
  const base = {
    src: '/s.mp4',
    dst: '/o.mp4',
    crop: { w: 608, h: 1080, x: 656, y: 0 },
    out: { w: 1080, h: 1920 },
    encoder: 'nvenc' as const,
  }

  it('un -ss par segment, avant le -i correspondant', () => {
    const a = renderArgs({
      ...base,
      segments: [
        { start: 100, end: 110 },
        { start: 200, end: 215 },
      ],
    })
    expect(compte(a, '-i')).toBe(2)
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'))
    expect(a).toContain('100')
    expect(a.join(' ')).toContain('concat=n=2:v=1:a=1')
  })

  // `-hwaccel` est une option d'ENTRÉE : sa portée s'arrête au `-i` qui suit.
  // Posée une seule fois en tête, seul le premier segment décoderait sur le
  // GPU et tous les suivants retomberaient sur le chemin logiciel — sans
  // erreur, juste plus lentement.
  it('répète -hwaccel cuda devant chaque couple -ss/-i', () => {
    const a = renderArgs({
      ...base,
      segments: [
        { start: 100, end: 110 },
        { start: 200, end: 215 },
        { start: 300, end: 302.5 },
      ],
    })
    expect(compte(a, '-hwaccel')).toBe(3)
    expect(a.join(' ')).toContain(
      '-hwaccel cuda -ss 100 -t 10 -i /s.mp4' +
        ' -hwaccel cuda -ss 200 -t 15 -i /s.mp4' +
        ' -hwaccel cuda -ss 300 -t 2.5 -i /s.mp4',
    )
  })

  it("n'accélère rien au GPU quand l'encodeur est x264", () => {
    const a = renderArgs({
      ...base,
      encoder: 'x264',
      segments: [{ start: 0, end: 10 }],
    })
    expect(a).not.toContain('-hwaccel')
    expect(a).toContain('libx264')
  })

  it('un seul segment ne passe pas par concat', () => {
    const a = renderArgs({ ...base, segments: [{ start: 100, end: 110 }] })
    expect(a.join(' ')).not.toContain('concat=')
  })

  // Sans sous-titres ni logo, c'est le `concat` lui-même qui écrit dans [v] :
  // aucune étape ne suit. Le graphe entier tient alors en quatre clauses, et
  // les vérifier toutes exclut une étiquette orpheline ou écrite deux fois.
  it('assemble un graphe complet et sans étape morte, sans ASS ni logo', () => {
    const a = renderArgs({
      ...base,
      segments: [
        { start: 0, end: 10 },
        { start: 20, end: 30 },
      ],
    })
    const graphe = a[a.indexOf('-filter_complex') + 1]
    const crop = 'crop=608:1080:656:0,scale=1080:1920:flags=lanczos,setsar=1'
    expect(graphe).toBe(
      `[0:v]${crop}[v0];[1:v]${crop}[v1];` +
        '[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[v][ac];' +
        `[ac]${LOUDNORM},${RESAMPLE}[a]`,
    )
  })

  it('incruste l’ASS avec fontsdir, filename nommé et non positionnel', () => {
    const a = renderArgs({
      ...base,
      segments: [{ start: 0, end: 10 }],
      assPath: '/c.ass',
      fontsDir: '/fonts',
    })
    expect(a.join(' ')).toContain("ass=filename='/c.ass':fontsdir='/fonts'")
  })

  it('n’incruste rien quand aucun fichier ASS n’est fourni', () => {
    const a = renderArgs({ ...base, segments: [{ start: 0, end: 10 }] })
    expect(a.join(' ')).not.toContain('ass=')
  })

  // Sans dossier de polices, libass s'en remet à ceux du système. L'option ne
  // doit alors pas apparaître du tout : `fontsdir=''` le ferait chercher dans
  // un dossier vide et retomber sur une police de secours, en silence.
  it('omet fontsdir quand il n’est pas fourni, au lieu de l’émettre vide', () => {
    const a = renderArgs({ ...base, segments: [{ start: 0, end: 10 }], assPath: '/c.ass' })
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
      segments: [{ start: 0, end: 10 }],
      assPath: '/2026\\:03/c.ass',
    })
    expect(a.join(' ')).toContain(String.raw`ass=filename='/2026\\\:03/c.ass'`)
  })

  // L'apostrophe est le seul cas qui ne se devine pas : il faut fermer la
  // chaîne, écrire `\'` lui-même doublement échappé, puis la rouvrir.
  it("ferme et rouvre la chaîne autour d'une apostrophe, au lieu de la préfixer", () => {
    const a = renderArgs({
      ...base,
      segments: [{ start: 0, end: 10 }],
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
      segments: [{ start: 0, end: 10 }],
      assPath: "/zz/'];exit[v];a='/c.ass",
    })
    const graphe = a[a.indexOf('-filter_complex') + 1]
    expect(graphe).toContain(String.raw`ass=filename='/zz/'\\\''];exit[v];a='\\\''/c.ass'`)
    // Le graphe reste celui qu'on a écrit : une seule incrustation, une seule
    // normalisation, et c'est toujours notre dernière étape qui rend [v].
    expect(graphe.match(/ass=filename=/g)).toHaveLength(1)
    expect(graphe.match(/loudnorm=/g)).toHaveLength(1)
    expect(graphe.endsWith('[v]')).toBe(true)
  })

  it('NVENC ne reçoit jamais -hwaccel_output_format cuda', () => {
    const a = renderArgs({ ...base, segments: [{ start: 0, end: 10 }] })
    expect(a).not.toContain('-hwaccel_output_format')
    expect(a).toContain('h264_nvenc')
  })

  // `-af` sur un flux issu de `-map [a]` fait échouer ffmpeg :
  // « Simple and complex filtering cannot be used together for the same
  // stream ». La normalisation appartient donc au graphe.
  it('normalise le son dans le graphe, jamais par -af', () => {
    const a = renderArgs({ ...base, segments: [{ start: 0, end: 10 }] })
    expect(a).not.toContain('-af')
    expect(a).not.toContain('-filter:a')
    expect(a.join(' ')).toContain(LOUDNORM)
  })

  // `loudnorm` en passe unique sort à 192 kHz, et ffmpeg redescend alors au
  // plus haut taux que l'AAC accepte : mesuré, une source à 44,1 kHz ressortait
  // en 96 kHz. Le rééchantillonnage doit suivre la normalisation, pas la
  // précéder.
  // Les deux cas, parce que la chaîne audio n'a pas la même entrée : `0:a`
  // pour un segment seul, la sortie `ac` du concat pour plusieurs.
  it.each([
    ['un segment', [{ start: 0, end: 10 }]],
    [
      'plusieurs segments',
      [
        { start: 0, end: 10 },
        { start: 20, end: 30 },
      ],
    ],
  ])('fixe le taux de sortie derrière loudnorm — %s', (_nom, segments) => {
    const a = renderArgs({ ...base, segments })
    const graphe = a[a.indexOf('-filter_complex') + 1]
    expect(graphe).toContain(`${LOUDNORM},${RESAMPLE}`)
    expect(RESAMPLE).toContain('48000')
  })

  it('cadre au rectangle demandé puis met à l’échelle de sortie', () => {
    const a = renderArgs({ ...base, segments: [{ start: 0, end: 10 }] })
    expect(a.join(' ')).toContain('crop=608:1080:656:0')
    expect(a.join(' ')).toContain('scale=1080:1920:flags=lanczos')
    expect(a.join(' ')).toContain('setsar=1')
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
      for (const segments of [[{ start: 0, end: 10 }], [{ start: 0, end: 10 }, { start: 20, end: 30 }]]) {
        const a = renderArgs({ ...base, ...options, segments })
        const graphe = a[a.indexOf('-filter_complex') + 1]
        expect(graphe).toContain('[v]')
        expect(graphe).toContain('[a]')
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
      segments: [{ start: 0, end: 10 }],
      assPath: '/c.ass',
      logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
    })
    const graphe = a[a.indexOf('-filter_complex') + 1]
    // L'incrustation rend l'étiquette que la superposition consomme.
    expect(graphe).toContain("[vd]ass=filename='/c.ass'[vf0]")
    expect(graphe).toContain('[vf0][lg0]overlay=x=40:y=250[v]')
  })

  it('enchaîne les logos dans l’ordre reçu', () => {
    const a = renderArgs({
      ...base,
      segments: [{ start: 0, end: 10 }],
      logos: [
        { path: '/a.png', x: 10, y: 20, w: 100, h: 50 },
        { path: '/b.png', x: 30, y: 40, w: 200, h: 60 },
      ],
    })
    const graphe = a[a.indexOf('-filter_complex') + 1]
    expect(graphe).toContain('[vd][lg0]overlay=x=10:y=20[vf0]')
    expect(graphe).toContain('[vf0][lg1]overlay=x=30:y=40[v]')
  })

  // TypeScript garantit `number` à la compilation et rien à l'exécution. Ces
  // valeurs entrent directement dans le graphe : une chaîne forcée par un cast
  // y écrirait ce qu'elle veut.
  it.each([
    ['crop.x', { crop: { w: 608, h: 1080, x: Number.NaN, y: 0 } }],
    ['out.w', { out: { w: Number.POSITIVE_INFINITY, h: 1920 } }],
    ['logos[0].x', { logos: [{ path: '/l.png', x: Number.NaN, y: 0, w: 10, h: 10 }] }],
    ['logos[0].w', { logos: [{ path: '/l.png', x: 0, y: 0, w: Number.NaN, h: 10 }] }],
  ])('refuse %s non fini plutôt que de l’écrire dans le graphe', (quoi, surcharge) => {
    expect(() =>
      renderArgs({ ...base, segments: [{ start: 0, end: 10 }], ...surcharge }),
    ).toThrow(new RegExp(quoi.replace(/[[\]./]/g, '\\$&')))
  })

  it('ajoute une entrée par logo, sans -hwaccel — une image ne se décode pas au GPU', () => {
    const a = renderArgs({
      ...base,
      segments: [{ start: 0, end: 10 }],
      logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
    })
    expect(compte(a, '-i')).toBe(2)
    expect(compte(a, '-hwaccel')).toBe(1)
    expect(a).toContain('/logo.png')
    expect(a.join(' ')).toContain('scale=300:90')
    expect(a.join(' ')).toContain('overlay=x=40:y=250')
  })

  it('efface les métadonnées et place l’index en tête du fichier', () => {
    const a = renderArgs({ ...base, segments: [{ start: 0, end: 10 }] })
    for (const jeton of METADATA_SCRUB) expect(a).toContain(jeton)
    expect(a.join(' ')).toContain('-movflags +faststart')
    expect(a[a.length - 1]).toBe('/o.mp4')
  })

  it('durée = fin - début, et jamais la fin brute', () => {
    const a = renderArgs({ ...base, segments: [{ start: 2841.2, end: 2856.9 }] })
    expect(a.join(' ')).toContain('-ss 2841.2 -t 15.7')
    expect(a).not.toContain('2856.9')
  })

  it('jette les segments vides ou inversés au lieu d’ouvrir un décodeur pour rien', () => {
    const a = renderArgs({
      ...base,
      segments: [
        { start: 100, end: 110 },
        { start: 200, end: 200 },
        { start: 300, end: 290 },
      ],
    })
    expect(compte(a, '-i')).toBe(1)
    expect(a.join(' ')).not.toContain('concat=')
  })

  it('fusionne deux segments qui se touchent — un décodeur de moins', () => {
    const a = renderArgs({
      ...base,
      segments: [
        { start: 100, end: 110 },
        { start: 110, end: 120 },
      ],
    })
    expect(compte(a, '-i')).toBe(1)
    expect(a.join(' ')).toContain('-ss 100 -t 20')
  })

  it('refuse de construire un rendu sans un seul segment', () => {
    expect(() => renderArgs({ ...base, segments: [] })).toThrow()
  })

  // Le pire des deux : `normalizeSegments` garde un segment si `end > start`,
  // comparaison fausse dès qu'une borne vaut NaN — le segment disparaissait
  // donc sans un mot, et un clip de trois segments en rendait deux. Une borne
  // infinie, elle, ressortait en `-t Infinity`.
  it.each([
    ['NaN au début', { start: Number.NaN, end: 20 }],
    ['NaN à la fin', { start: 10, end: Number.NaN }],
    ['fin infinie', { start: 10, end: Number.POSITIVE_INFINITY }],
  ])('refuse une borne non finie (%s) au lieu de perdre le segment', (_nom, mauvais) => {
    expect(() =>
      renderArgs({ ...base, segments: [{ start: 0, end: 10 }, mauvais, { start: 30, end: 40 }] }),
    ).toThrow(/segments\[1\]/)
  })

  // Le message doit nommer la valeur reçue : `JSON.stringify` rend `null` pour
  // NaN comme pour les infinis, et désignerait donc une valeur que l'appelant
  // n'a jamais passée.
  it('nomme la valeur fautive dans le message', () => {
    expect(() =>
      renderArgs({ ...base, segments: [{ start: Number.NaN, end: 10 }] }),
    ).toThrow(/NaN/)
    expect(() =>
      renderArgs({ ...base, segments: [{ start: 0, end: Number.POSITIVE_INFINITY }] }),
    ).toThrow(/Infinity/)
  })
})

describe('blurredVariantArgs', () => {
  // Un clip 1:1 : le cas qui a fait naître #22, et celui que la variante existe
  // pour porter sur TikTok (spec §2 — 48 % du temps tient jusqu'au 1:1, contre
  // 24 à 33 % en 9:16).
  const base = {
    src: '/s.mp4',
    dst: '/o-9x16.mp4',
    segments: [{ start: 0, end: 10 }],
    crop: { w: 1080, h: 1080, x: 420, y: 0 },
    out: { w: 1080, h: 1080 },
    encoder: 'nvenc' as const,
  }

  const graphe = (a: string[]) => a[a.indexOf('-filter_complex') + 1]

  it('sort en 1080x1920', () => {
    const a = blurredVariantArgs(base)
    expect(a.join(' ')).toContain('scale=1080:1920:force_original_aspect_ratio=increase')
    expect(a.join(' ')).toContain('crop=1080:1920')
  })

  // Le contenu est **déjà cropé** : il se pose pleine largeur et centré, pas au
  // ratio 0,42 d'OpenShorts, qui visait du 16:9 brut. Un 1:1 occupe alors 56 %
  // de la hauteur et un 4:5 70 %, contre 32 % pour un 16:9 en letterbox.
  it('pose le contenu pleine largeur et centré, pas à 42 % de la hauteur', () => {
    const a = blurredVariantArgs(base).join(' ')
    expect(a).toContain('scale=1080:-2')
    expect(a).toContain('overlay=x=0:y=(H-h)/2')
    expect(a).not.toContain('0.42')
  })

  it('floute le fond', () => {
    expect(blurredVariantArgs(base).join(' ')).toContain('gblur=sigma=12')
  })

  // **Le test du ticket #22, et le seul qui compte vraiment ici.** La variante
  // partait du rendu natif déjà incrusté : son fond était un agrandissement du
  // clip fini, cartons compris, et `gblur=sigma=12` n'efface pas des lettres de
  // 40 px cerclées d'un contour de 8 — vérifié à l'image, le carton restait
  // pleinement lisible, le jaune du mot actif compris.
  //
  // La parade n'est pas de monter le sigma, c'est de tirer le fond d'un contenu
  // qui n'a jamais porté de texte : le `split` est **avant** l'incrustation.
  it("ne laisse ni sous-titre ni marque atteindre le fond flouté", () => {
    const g = graphe(
      blurredVariantArgs({
        ...base,
        assPath: '/c.ass',
        logos: [{ path: '/logo.png', x: 40, y: 250, w: 300, h: 90 }],
      }),
    )
    // Le fond part de la sortie du `split`, et va au flou sans rien croiser.
    expect(g).toContain(
      '[bga]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=12[bg]',
    )
    // L'incrustation, elle, ne touche que l'autre branche.
    expect(g).toContain("[fga]ass=filename='/c.ass'[vf0]")
    expect(g).toContain('[vf0][lg0]overlay=x=40:y=250[vf1]')
    // Une seule incrustation et une seule marque dans tout le graphe : rien
    // n'est appliqué deux fois, donc rien ne peut l'être au fond.
    expect(g.match(/ass=filename=/g)).toHaveLength(1)
    expect(g.match(/overlay=x=40:y=250/g)).toHaveLength(1)
  })

  // Le corollaire du précédent, et ce qui le rend correct **par construction**
  // plutôt que par réglage : la variante se rend depuis la source, comme le
  // natif, au lieu de recycler le MP4 natif.
  it('part de la source et de ses segments, jamais du rendu natif', () => {
    const a = blurredVariantArgs({
      ...base,
      segments: [
        { start: 100, end: 110 },
        { start: 200, end: 215 },
      ],
    })
    expect(compte(a, '-i')).toBe(2)
    expect(a.join(' ')).toContain(
      '-hwaccel cuda -ss 100 -t 10 -i /s.mp4 -hwaccel cuda -ss 200 -t 15 -i /s.mp4',
    )
    expect(a.join(' ')).toContain('concat=n=2:v=1:a=1')
  })

  // Les deux sorties doivent montrer le même cadre : c'est le même rectangle,
  // la même mise à l'échelle, le même contenu — seule la mise en page diffère.
  it('cadre exactement comme le rendu natif', () => {
    const commun = 'crop=1080:1080:420:0,scale=1080:1080:flags=lanczos,setsar=1'
    expect(graphe(blurredVariantArgs(base))).toContain(commun)
    expect(graphe(renderArgs({ ...base, dst: '/o.mp4' }))).toContain(commun)
  })

  // Le graphe entier, sur le cas le plus simple : un segment, pas de marque.
  // Le vérifier en entier exclut une étiquette orpheline ou écrite deux fois.
  it('assemble un graphe complet et sans étape morte', () => {
    expect(graphe(blurredVariantArgs({ ...base, assPath: '/c.ass' }))).toBe(
      '[0:v]crop=1080:1080:420:0,scale=1080:1080:flags=lanczos,setsar=1[vd];' +
        `[0:a]${LOUDNORM},${RESAMPLE}[a];` +
        '[vd]split=2[bga][fga];' +
        '[bga]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=12[bg];' +
        "[fga]ass=filename='/c.ass'[vf0];" +
        '[vf0]scale=1080:-2[fg];' +
        '[bg][fg]overlay=x=0:y=(H-h)/2,setsar=1[v]',
    )
  })

  // **La jonction que personne ne regarde : `concat` écrit `[vc]`, le `split`
  // le consomme.** Le cas à un segment sort de `[vd]` et ne dit donc rien de
  // celui-ci, alors qu'un clip monté est la règle et non l'exception — c'est la
  // décision fondatrice du projet, un clip est une liste de segments. Le graphe
  // entier, plutôt qu'un comptage de `-i`, est ce qui interdit une étiquette
  // orpheline entre les deux. (relevé par Aristarque)
  it('assemble le graphe de la variante sur un clip à deux segments', () => {
    expect(
      graphe(
        blurredVariantArgs({
          ...base,
          segments: [
            { start: 100, end: 110 },
            { start: 200, end: 215 },
          ],
          assPath: '/c.ass',
        }),
      ),
    ).toBe(
      '[0:v]crop=1080:1080:420:0,scale=1080:1080:flags=lanczos,setsar=1[v0];' +
        '[1:v]crop=1080:1080:420:0,scale=1080:1080:flags=lanczos,setsar=1[v1];' +
        '[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[vc][ac];' +
        `[ac]${LOUDNORM},${RESAMPLE}[a];` +
        '[vc]split=2[bga][fga];' +
        '[bga]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=12[bg];' +
        "[fga]ass=filename='/c.ass'[vf0];" +
        '[vf0]scale=1080:-2[fg];' +
        '[bg][fg]overlay=x=0:y=(H-h)/2,setsar=1[v]',
    )
  })

  // Le même graphe **sans sous-titre ni marque**, parce que l'avant-plan n'y
  // porte alors qu'une seule étape et que c'est le cas limite d'`enchaîner` :
  // la première étape est aussi la dernière, donc elle doit écrire directement
  // dans l'étiquette terminale au lieu d'un `vf0` que plus personne ne lirait.
  // Un clip sans sous-titres est un réglage de l'interface, pas une curiosité.
  // (relevé par Aristarque)
  it("assemble le graphe de la variante d'un clip sans sous-titres", () => {
    expect(graphe(blurredVariantArgs(base))).toBe(
      '[0:v]crop=1080:1080:420:0,scale=1080:1080:flags=lanczos,setsar=1[vd];' +
        `[0:a]${LOUDNORM},${RESAMPLE}[a];` +
        '[vd]split=2[bga][fga];' +
        '[bga]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=12[bg];' +
        '[fga]scale=1080:-2[fg];' +
        '[bg][fg]overlay=x=0:y=(H-h)/2,setsar=1[v]',
    )
  })

  // Le son ne peut plus être recopié du natif — la variante ne le lit plus. Il
  // est normalisé **une fois**, depuis la source, exactement comme celui du
  // natif : c'est le même traitement sur le même PCM, donc aucune compression
  // en cascade.
  it('normalise le son depuis la source, une seule fois', () => {
    const a = blurredVariantArgs(base)
    expect(a.join(' ')).not.toContain('-c:a copy')
    expect(graphe(a).match(/loudnorm=/g)).toHaveLength(1)
    expect(a.join(' ')).toContain(`${LOUDNORM},${RESAMPLE}`)
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
    for (const jeton of METADATA_SCRUB) expect(a).toContain(jeton)
  })

  // Les gardes de `renderArgs` valent pour la variante : c'est le même
  // constructeur, et une borne perdue y coûterait le même segment muet.
  it('refuse une borne non finie, comme le rendu natif', () => {
    expect(() =>
      blurredVariantArgs({ ...base, segments: [{ start: Number.NaN, end: 10 }] }),
    ).toThrow(/segments\[0\]/)
    expect(() => blurredVariantArgs({ ...base, segments: [] })).toThrow()
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
        segments: [{ start: 0, end: 10 }],
        crop: { w: 608, h: 1080, x: 656, y: 0 },
        out: { w: 1080, h: 1920 },
        encoder: 'nvenc',
      }),
    ],
    [
      'blurredVariantArgs',
      blurredVariantArgs({
        src: '/s.mp4',
        dst: '/-o-9x16.mp4',
        segments: [{ start: 0, end: 10 }],
        crop: { w: 1080, h: 1080, x: 420, y: 0 },
        out: { w: 1080, h: 1080 },
        encoder: 'nvenc',
      }),
    ],
  ])('%s la pose', (_nom, a) => {
    expect(a[a.length - 2]).toBe('--')
    expect(compte(a, '--')).toBe(1)
  })
})
