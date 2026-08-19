import { describe, expect, it } from 'vitest'

import { messageCleaned, cleanPaths } from '@/core/errors'
import { REFERENCE_PREFIXES } from '@/server/secrets'

describe('cleanPaths', () => {
  it('épure la commande complète que runFfmpeg met dans son message', () => {
    const raw = [
      'ffmpeg a échoué (code de sortie 1) — proxy de 2025-06-15-cqlp.',
      'Commande : /home/julien/.local/opt/ffmpeg-nvenc/bin/ffmpeg -i /home/julien/dev/avolo-shorts/stage/2025-06-15-cqlp.mp4',
    ].join('\n')

    const cleaned = cleanPaths(raw)
    expect(cleaned).not.toContain('/home/julien')
    expect(cleaned).toContain('…/ffmpeg')
    expect(cleaned).toContain('…/2025-06-15-cqlp.mp4')
    expect(cleaned).toContain('ffmpeg a échoué (code de sortie 1)')
  })

  it('épure un chemin entre guillemets, espaces compris', () => {
    const raw =
      'Le dossier des replays ne répond pas (20000 ms sur "/mnt/j/Drive partagés/Avolo/Replay/2025-06-15-cqlp.mp4").'
    const cleaned = cleanPaths(raw)
    expect(cleaned).toContain('"…/2025-06-15-cqlp.mp4"')
    expect(cleaned).not.toContain('Drive partagés')
    expect(cleaned).not.toContain('/mnt/j')
  })

  it('épure un chemin Windows', () => {
    expect(cleanPaths(String.raw`ouverture de C:\Users\julie\AppData\x.json`)).toBe(
      'ouverture de …/x.json',
    )
  })

  it('n’abrège pas deux fois un chemin déjà abrégé', () => {
    expect(cleanPaths(cleanPaths('sur /a/b/c.json'))).toBe('sur …/c.json')
  })

  it('laisse intact ce qui n’est pas un chemin absolu', () => {
    const message =
      "GEMINI_API_KEY n'est pas définie. Voir .env.example — REPLAY_DIR pointe le dossier des replays."
    expect(cleanPaths(message)).toBe(message)
  })

  it('laisse intacts les chemins relatifs et les fractions', () => {
    expect(cleanPaths('worker/transcribe.py introuvable, 3/4 étapes faites')).toBe(
      'worker/transcribe.py introuvable, 3/4 étapes faites',
    )
  })

  /**
   * Le cas qui a motivé le paramètre `roots` : `REPLAY_DIR` vaut littéralement
   * `/mnt/j/Drive partagés/…`, et `runFfmpeg` joint son argv par des espaces. La
   * passe générique s'arrête au premier espace, donc elle laissait sortir la
   * queue du chemin — l'organisation interne du Drive partagé, un cran plus
   * loin. (relevé par Codex)
   */
  it('épure un chemin à espaces quand la racine est connue', () => {
    const root = '/mnt/j/Drive partagés/Avolo/03_LA_SCENE_AVOLO/Replay'
    const raw = `Commande : /usr/bin/ffmpeg -i ${root}/2025-06-15-cqlp.mp4 -vn`

    expect(cleanPaths(raw, [root])).toBe(
      'Commande : …/ffmpeg -i …/2025-06-15-cqlp.mp4 -vn',
    )
    // Sans la racine, la queue du chemin survit : c'est exactement ce que le
    // paramètre corrige, et le laisser démontré évite de le croire inutile.
    expect(cleanPaths(raw)).toContain('03_LA_SCENE_AVOLO')
  })

  it('épure le chemin relatif sous une racine, sans le réduire à un nom', () => {
    const root = '/home/julien/dev/avolo-shorts/projects'
    // Ce qui reste est ce que l'appelant a lui-même nommé : son projet et son
    // clip. L'arborescence de la machine, elle, est partie.
    expect(cleanPaths(`échec sur ${root}/2025-06-15/renders/c01.mp4`, [root])).toBe(
      'échec sur …/2025-06-15/renders/c01.mp4',
    )
  })

  it('retire la racine la plus longue en premier', () => {
    // `STAGE_DIR` peut vivre sous `PROJECTS_DIR` : traiter le parent d'abord
    // laisserait l'enfant à moitié épuré.
    const parent = '/data/avolo'
    const child = '/data/avolo/stage'
    expect(cleanPaths(`copie vers ${child}/x.mp4`, [parent, child])).toBe(
      'copie vers …/x.mp4',
    )
  })

  it('rend une chaîne vide inchangée', () => {
    expect(cleanPaths('')).toBe('')
  })

  it('ne mange pas le chemin d’une URL', () => {
    expect(cleanPaths('appel à https://generativelanguage.googleapis.com/v1beta')).toBe(
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
    expect(cleanPaths('échec sur https://x/v1?key=AQ.secret-42&alt=json')).toBe(
      'échec sur https://x/v1?key=[caviardé]&alt=json',
    )
    expect(messageCleaned(new Error('POST /v1?api_key=abc123'))).toContain('api_key=[caviardé]')
    expect(messageCleaned(new Error('POST /v1?api_key=abc123'))).not.toContain('abc123')
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
      cleanPaths(
        'GEMINI_API_KEY : impossible de lire op://Personal/Avolo-Shorts/GEMINI_API_KEY.',
      ),
    ).toBe('GEMINI_API_KEY : impossible de lire op://….')
  })

  it('caviarde chaque référence d’une chaîne, champ ou pas, et le chemin à côté', () => {
    expect(
      cleanPaths('op://Coffre/Fiche/Champ et op://Coffre/Fiche sur /var/tmp/x.wav'),
    ).toBe('op://… et op://… sur …/x.wav')
  })

  /**
   * **Un coffre et une fiche portent couramment des espaces**, et une citation
   * dit où la référence finit. Les deux formes qui existent pour de vrai : `op`
   * cite les siennes entre apostrophes — `could not read secret 'op://c/f/CLÉ'`,
   * diagnostic que `résoudreSecrets` recopie —, et `JSON.stringify` entre
   * guillemets doubles. (relevé par Copilot et par Codex)
   */
  it('caviarde une référence citée, espaces compris', () => {
    const inside = 'op://Coffre partagé/Avolo Shorts/Clé'
    expect(cleanPaths(`valeur "${inside}" refusée`)).toBe('valeur "op://…" refusée')
    expect(cleanPaths(`could not read secret '${inside}'`)).toBe(
      "could not read secret 'op://…'",
    )
    // Le nom d'un coffre peut porter l'autre guillemet — « Coffre d'équipe » —,
    // et seul le délimiteur qui ouvre ferme. (relevé par Copilot)
    expect(cleanPaths(`valeur "op://Coffre d'équipe/Fiche/Clé" refusée`)).toBe(
      'valeur "op://…" refusée',
    )
    // Sans espace, la citation ne sert à rien : la passe nue suffit, quels que
    // soient les chevrons autour.
    expect(cleanPaths('« op://Coffre/Fiche/Clé » est vide')).toBe('« op://… » est vide')
  })

  /**
   * **Hors citation, la référence s'arrête au premier espace** — même limite
   * qu'un chemin nu, et pour la même raison : rien ne dit où elle finit. Une
   * grammaire qui traversait les espaces sans citation a été essayée, et elle
   * coûtait plus qu'elle ne rapportait : sur une référence sans champ, le
   * deuxième segment avalait la prose jusqu'à la barre oblique suivante — celle
   * d'une URL de remède, typiquement —, et le message perdait le diagnostic
   * *et* le remède. Un caviardage qui rend l'erreur inutile finit par sauter.
   * (relevé par Copilot)
   */
  it('s’arrête au premier espace, plutôt que de manger la phrase', () => {
    expect(cleanPaths('op://Coffre/Fiche est invalide, voir https://docs.test/a')).toBe(
      'op://… est invalide, voir https://docs.test/a',
    )
    // La contrepartie, laissée démontrée pour qu'on ne la croie pas couverte
    // *par la grammaire* : la queue d'un coffre à espace survit si personne ne
    // cite la référence. Ce qui la referme est ailleurs — `messageSûr` retire
    // toute référence lue dans l'environnement par sa forme complète, avant
    // d'en arriver ici, et `tests/server/erreurs.test.ts` fige ce chemin-là.
    // (issue #49)
    expect(cleanPaths('lecture de op://Coffre partagé/Fiche/Clé refusée')).toBe(
      'lecture de op://… partagé…/Clé refusée',
    )
  })

  /**
   * Ce qui suit la référence n'est pas à elle. La fiche et le coffre s'étendent
   * au-delà d'un espace, le champ non : lui laisser la même liberté ferait
   * manger la phrase entière à la moindre barre oblique plus loin.
   */
  it('ne déborde pas sur la phrase qui suit', () => {
    expect(cleanPaths('op://Coffre/Fiche/Champ. Voir /var/tmp/x.wav')).toBe(
      'op://…. Voir …/x.wav',
    )
  })

  it('laisse intact ce qui ne nomme déjà rien', () => {
    // Le préfixe seul, entouré ou pas — il ne nomme ni coffre, ni fiche, ni
    // champ, donc il n'y a rien à en retirer (relevé par Copilot et Aristarque)
    // — et la forme que `exigerSecret` cite en toutes lettres.
    expect(cleanPaths('une adresse commence par op://')).toBe('une adresse commence par op://')
    expect(cleanPaths('valeur "op://" refusée')).toBe('valeur "op://" refusée')
    const message =
      'GEMINI_API_KEY vaut encore une adresse 1Password (op://…), donc la résolution a été défaite.'
    expect(cleanPaths(message)).toBe(message)
  })

  it('ne laisse pas passer une référence collée à un tiret', () => {
    // Le contexte de gauche ne protège qu'un mot entier — un schéma comme
    // `desktop://` —, et un tiret n'est pas un mot : ce qui suit reste une
    // référence, donc part.
    expect(cleanPaths('--référence=-op://Coffre/Fiche/Champ')).toBe('--référence=-op://…')
  })

  it('ne prend pas une URL pour une référence', () => {
    // Le remède d'un `op` introuvable, mot pour mot : il cite une URL de
    // documentation et le mot « op », et il doit rester lisible.
    const message =
      'La commande « op » est introuvable. Installer 1Password CLI ' +
      '(https://developer.1password.com/docs/cli/get-started/), poser OP_BIN sur son chemin.'
    expect(cleanPaths(message)).toBe(message)
    expect(cleanPaths('le schéma desktop://hote reste entier')).toBe(
      'le schéma desktop://hote reste entier',
    )
  })

  /**
   * Les passes d'`cleanPaths` se suivent, et une passe ajoutée peut défaire le
   * travail des autres. Les trois formes dans la même chaîne fixent leur ordre.
   */
  it('cohabite avec l’épuration des chemins et le caviardage des clés', () => {
    expect(
      cleanPaths(
        'échec /home/julien/dev/x.mp4 sur https://x/v1?key=AQ.secret-42 avec op://Coffre/Fiche/Champ',
      ),
    ).toBe('échec …/x.mp4 sur https://x/v1?key=[caviardé] avec op://…')
  })

  it('ne caviarde pas deux fois une référence déjà caviardée', () => {
    const a = cleanPaths('lecture de op://Coffre/Fiche/Champ')
    expect(cleanPaths(a)).toBe(a)
  })

  /**
   * Le compteur, sans lequel le test qui suit se viderait de sa substance : une
   * liste vide ne fait échouer aucune itération, et `it.each([])` n'exercerait
   * plus rien.
   */
  it('a au moins une forme de référence à exercer', () => {
    expect(REFERENCE_PREFIXES.length).toBeGreaterThan(0)
  })

  /**
   * **Le lien entre les deux moitiés d'une même vérité.**
   *
   * `isReference` (`src/server/secrets.ts`) décide seul des formes qu'une
   * variable d'environnement peut prendre ; `src/core/erreurs.ts` décide de ce
   * qui est caviardé. Le second ne peut pas importer le premier — la frontière
   * de pureté l'interdit, et `tests/core/purete.test.ts` la vérifie —, donc la
   * liste des préfixes y est recopiée à la main. Elle l'était déjà, et la
   * dépendance était consignée **en commentaire des deux côtés** : ce qui ne la
   * fait échouer nulle part. Une seconde forme acceptée traversait le
   * caviardage exactement comme `op://` le faisait avant qu'on s'en occupe.
   *
   * Ce test **lit** la liste plutôt que de citer `op://`, et exerce chacun de
   * ses éléments. Un préfixe ajouté à `isReference` sans passe correspondante
   * ici fait donc rougir la suite, au lieu de sortir en silence sur un dépôt
   * public. C'est le motif de l'issue #39, appliqué ici (issue #49).
   *
   * Ce qu'il exige de chaque forme est ce que la forme `op://` tient déjà : le
   * coffre, la fiche et le champ partent, le **préfixe reste** — il dit que la
   * variable portait une adresse et non une valeur littérale, seule question
   * qu'on se pose devant un secret qui n'a pas marché —, et la prose autour ne
   * bouge pas.
   */
  it.each([...REFERENCE_PREFIXES])(
    'caviarde tout ce qu’accepte estRéférence : %s',
    (prefix) => {
      const bare = cleanPaths(`lecture de ${prefix}Coffre/Fiche/Champ refusée`)
      expect(bare).toBe(`lecture de ${prefix}… refusée`)

      // Et sous sa forme citée, la seule qui sache porter des espaces.
      const cited = cleanPaths(`valeur "${prefix}Coffre partagé/Fiche/Champ" refusée`)
      expect(cited).toBe(`valeur "${prefix}…" refusée`)
    },
  )
})

describe('messageCleaned', () => {
  it('lit le message d’une Error', () => {
    expect(messageCleaned(new Error('échec sur /var/tmp/x.wav'))).toBe('échec sur …/x.wav')
  })

  it('rend en texte ce qui n’est pas une Error', () => {
    expect(messageCleaned('boum')).toBe('boum')
    expect(messageCleaned(42)).toBe('42')
  })
})
