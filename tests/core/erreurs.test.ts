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

  it('ne mange pas le chemin d’une URL', () => {
    expect(épurerChemins('appel à https://generativelanguage.googleapis.com/v1beta')).toBe(
      'appel à https://generativelanguage.googleapis.com/v1beta',
    )
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
