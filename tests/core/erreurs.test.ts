import { describe, expect, it } from 'vitest'

import { messageÉpuré, épurerChemins } from '@/core/erreurs'

describe('épurerChemins', () => {
  it('épure la commande complète que runFfmpeg met dans son message', () => {
    const brut = [
      'ffmpeg a échoué (code de sortie 1) — proxy de 2025-06-15-cqlp.',
      'Commande : /home/julien/.local/opt/ffmpeg-nvenc/bin/ffmpeg -i /home/julien/dev/avolo-shorts/stage/2025-06-15-cqlp.mp4',
    ].join('\n')

    const épuré = épurerChemins(brut)
    expect(épuré).not.toContain('/home/julien')
    expect(épuré).toContain('…/ffmpeg')
    expect(épuré).toContain('…/2025-06-15-cqlp.mp4')
    expect(épuré).toContain('ffmpeg a échoué (code de sortie 1)')
  })

  it('épure un chemin entre guillemets, espaces compris', () => {
    const brut =
      'Le dossier des replays ne répond pas (20000 ms sur "/mnt/j/Drive partagés/Avolo/Replay/2025-06-15-cqlp.mp4").'
    const épuré = épurerChemins(brut)
    expect(épuré).toContain('"…/2025-06-15-cqlp.mp4"')
    expect(épuré).not.toContain('Drive partagés')
    expect(épuré).not.toContain('/mnt/j')
  })

  it('épure un chemin Windows', () => {
    expect(épurerChemins(String.raw`ouverture de C:\Users\julie\AppData\x.json`)).toBe(
      'ouverture de …/x.json',
    )
  })

  it('n’abrège pas deux fois un chemin déjà abrégé', () => {
    expect(épurerChemins(épurerChemins('sur /a/b/c.json'))).toBe('sur …/c.json')
  })

  it('laisse intact ce qui n’est pas un chemin absolu', () => {
    const message =
      "GEMINI_API_KEY n'est pas définie. Voir .env.example — REPLAY_DIR pointe le dossier des replays."
    expect(épurerChemins(message)).toBe(message)
  })

  it('laisse intacts les chemins relatifs et les fractions', () => {
    expect(épurerChemins('worker/transcribe.py introuvable, 3/4 étapes faites')).toBe(
      'worker/transcribe.py introuvable, 3/4 étapes faites',
    )
  })

  /**
   * Le cas qui a motivé le paramètre `racines` : `REPLAY_DIR` vaut littéralement
   * `/mnt/j/Drive partagés/…`, et `runFfmpeg` joint son argv par des espaces. La
   * passe générique s'arrête au premier espace, donc elle laissait sortir la
   * queue du chemin — l'organisation interne du Drive partagé, un cran plus
   * loin. (relevé par Codex)
   */
  it('épure un chemin à espaces quand la racine est connue', () => {
    const racine = '/mnt/j/Drive partagés/Avolo/03_LA_SCENE_AVOLO/Replay'
    const brut = `Commande : /usr/bin/ffmpeg -i ${racine}/2025-06-15-cqlp.mp4 -vn`

    expect(épurerChemins(brut, [racine])).toBe(
      'Commande : …/ffmpeg -i …/2025-06-15-cqlp.mp4 -vn',
    )
    // Sans la racine, la queue du chemin survit : c'est exactement ce que le
    // paramètre corrige, et le laisser démontré évite de le croire inutile.
    expect(épurerChemins(brut)).toContain('03_LA_SCENE_AVOLO')
  })

  it('épure le chemin relatif sous une racine, sans le réduire à un nom', () => {
    const racine = '/home/julien/dev/avolo-shorts/projects'
    // Ce qui reste est ce que l'appelant a lui-même nommé : son projet et son
    // clip. L'arborescence de la machine, elle, est partie.
    expect(épurerChemins(`échec sur ${racine}/2025-06-15/renders/c01.mp4`, [racine])).toBe(
      'échec sur …/2025-06-15/renders/c01.mp4',
    )
  })

  it('retire la racine la plus longue en premier', () => {
    // `STAGE_DIR` peut vivre sous `PROJECTS_DIR` : traiter le parent d'abord
    // laisserait l'enfant à moitié épuré.
    const parent = '/data/avolo'
    const enfant = '/data/avolo/stage'
    expect(épurerChemins(`copie vers ${enfant}/x.mp4`, [parent, enfant])).toBe(
      'copie vers …/x.mp4',
    )
  })

  it('rend une chaîne vide inchangée', () => {
    expect(épurerChemins('')).toBe('')
  })

  it('ne mange pas le chemin d’une URL', () => {
    expect(épurerChemins('appel à https://generativelanguage.googleapis.com/v1beta')).toBe(
      'appel à https://generativelanguage.googleapis.com/v1beta',
    )
  })
})

describe('le caviardage des clés', () => {
  /**
   * Le filet couvre désormais la frontière HTTP, pas seulement le journal de
   * `appelerGemini` : le message d'une erreur de repérage traverse `status.json`
   * puis le champ `error` de `GET /api/projects/:id`. (relevé par Aristarque)
   */
  it('retire une clé d’API où qu’elle passe', () => {
    expect(épurerChemins('échec sur https://x/v1?key=AQ.secret-42&alt=json')).toBe(
      'échec sur https://x/v1?key=[caviardé]&alt=json',
    )
    expect(messageÉpuré(new Error('POST /v1?api_key=abc123'))).toContain('api_key=[caviardé]')
    expect(messageÉpuré(new Error('POST /v1?api_key=abc123'))).not.toContain('abc123')
  })
})

describe('le caviardage des références de secret', () => {
  /**
   * Une référence n'est pas une valeur : la lire ne donne accès à rien. Mais elle
   * nomme le coffre, la fiche et le champ, et une erreur servie par l'API se lit
   * dans un navigateur ou une capture d'écran. Ce qui reste lisible est le nom de
   * la variable — il est dans `.env.example`, donc public, et c'est lui qui dit
   * quoi aller regarder.
   */
  it('retire le coffre, la fiche et le champ, et garde la phrase entière', () => {
    expect(
      épurerChemins(
        'GEMINI_API_KEY : impossible de lire op://Personal/Avolo-Shorts/GEMINI_API_KEY.',
      ),
    ).toBe('GEMINI_API_KEY : impossible de lire op://….')
  })

  it('caviarde chaque référence d’une chaîne, champ ou pas, et le chemin à côté', () => {
    expect(
      épurerChemins('op://Coffre/Fiche/Champ et op://Coffre/Fiche sur /var/tmp/x.wav'),
    ).toBe('op://… et op://… sur …/x.wav')
  })

  /**
   * Un coffre et une fiche portent couramment des espaces, et la référence les
   * traverse : sa grammaire dit où elle finit, là où un chemin nu doit s'arrêter
   * au premier espace faute de le savoir. (relevé par Codex)
   */
  it('caviarde une référence dont le coffre et la fiche portent des espaces', () => {
    expect(épurerChemins('lecture de op://Coffre partagé/Avolo Shorts/Clé refusée')).toBe(
      'lecture de op://… refusée',
    )
  })

  /**
   * Aucun délimiteur n'est nécessaire, et c'est ce qui compte : `op` cite ses
   * propres références entre apostrophes — `could not read secret 'op://c/f/CLÉ'`
   * —, et ce diagnostic-là remonte dans le message de `résoudreSecrets`.
   * (relevé par Copilot)
   */
  it('caviarde une référence quel que soit ce qui l’entoure', () => {
    const dedans = 'op://Coffre partagé/Avolo Shorts/Clé'
    expect(épurerChemins(`valeur "${dedans}" refusée`)).toBe('valeur "op://…" refusée')
    expect(épurerChemins(`could not read secret '${dedans}'`)).toBe(
      "could not read secret 'op://…'",
    )
    expect(épurerChemins(`« ${dedans} » est vide`)).toBe('« op://… » est vide')
    expect(épurerChemins(`la réf est ${dedans}, dit-il`)).toBe('la réf est op://…, dit-il')
  })

  /**
   * Ce qui suit la référence n'est pas à elle. La fiche et le coffre s'étendent
   * au-delà d'un espace, le champ non : lui laisser la même liberté ferait
   * manger la phrase entière à la moindre barre oblique plus loin.
   */
  it('ne déborde pas sur la phrase qui suit', () => {
    expect(épurerChemins('op://Coffre/Fiche/Champ. Voir /var/tmp/x.wav')).toBe(
      'op://…. Voir …/x.wav',
    )
  })

  it('laisse intact ce qui ne nomme déjà rien', () => {
    // Le préfixe seul, entouré ou pas — il ne nomme ni coffre, ni fiche, ni
    // champ, donc il n'y a rien à en retirer (relevé par Copilot et Aristarque)
    // — et la forme que `exigerSecret` cite en toutes lettres.
    expect(épurerChemins('une adresse commence par op://')).toBe('une adresse commence par op://')
    expect(épurerChemins('valeur "op://" refusée')).toBe('valeur "op://" refusée')
    const message =
      'GEMINI_API_KEY vaut encore une adresse 1Password (op://…), donc la résolution a été défaite.'
    expect(épurerChemins(message)).toBe(message)
  })

  it('ne laisse pas passer une référence collée à un tiret', () => {
    // Le contexte de gauche ne protège qu'un mot entier — un schéma comme
    // `desktop://` —, et un tiret n'est pas un mot : ce qui suit reste une
    // référence, donc part.
    expect(épurerChemins('--référence=-op://Coffre/Fiche/Champ')).toBe('--référence=-op://…')
  })

  it('ne prend pas une URL pour une référence', () => {
    // Le remède d'un `op` introuvable, mot pour mot : il cite une URL de
    // documentation et le mot « op », et il doit rester lisible.
    const message =
      'La commande « op » est introuvable. Installer 1Password CLI ' +
      '(https://developer.1password.com/docs/cli/get-started/), poser OP_BIN sur son chemin.'
    expect(épurerChemins(message)).toBe(message)
    expect(épurerChemins('le schéma desktop://hote reste entier')).toBe(
      'le schéma desktop://hote reste entier',
    )
  })

  /**
   * Les passes d'`épurerChemins` se suivent, et une passe ajoutée peut défaire le
   * travail des autres. Les trois formes dans la même chaîne fixent leur ordre.
   */
  it('cohabite avec l’épuration des chemins et le caviardage des clés', () => {
    expect(
      épurerChemins(
        'échec /home/julien/dev/x.mp4 sur https://x/v1?key=AQ.secret-42 avec op://Coffre/Fiche/Champ',
      ),
    ).toBe('échec …/x.mp4 sur https://x/v1?key=[caviardé] avec op://…')
  })

  it('ne caviarde pas deux fois une référence déjà caviardée', () => {
    const une = épurerChemins('lecture de op://Coffre/Fiche/Champ')
    expect(épurerChemins(une)).toBe(une)
  })
})

describe('messageÉpuré', () => {
  it('lit le message d’une Error', () => {
    expect(messageÉpuré(new Error('échec sur /var/tmp/x.wav'))).toBe('échec sur …/x.wav')
  })

  it('rend en texte ce qui n’est pas une Error', () => {
    expect(messageÉpuré('boum')).toBe('boum')
    expect(messageÉpuré(42)).toBe('42')
  })
})
