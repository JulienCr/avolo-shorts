import { describe, expect, it } from 'vitest'

import { messageÉpuré, épurerChemins } from '@/core/erreurs'
import { PRÉFIXES_DE_RÉFÉRENCE } from '@/server/secrets'

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
   * **Un coffre et une fiche portent couramment des espaces**, et une citation
   * dit où la référence finit. Les deux formes qui existent pour de vrai : `op`
   * cite les siennes entre apostrophes — `could not read secret 'op://c/f/CLÉ'`,
   * diagnostic que `résoudreSecrets` recopie —, et `JSON.stringify` entre
   * guillemets doubles. (relevé par Copilot et par Codex)
   */
  it('caviarde une référence citée, espaces compris', () => {
    const dedans = 'op://Coffre partagé/Avolo Shorts/Clé'
    expect(épurerChemins(`valeur "${dedans}" refusée`)).toBe('valeur "op://…" refusée')
    expect(épurerChemins(`could not read secret '${dedans}'`)).toBe(
      "could not read secret 'op://…'",
    )
    // Le nom d'un coffre peut porter l'autre guillemet — « Coffre d'équipe » —,
    // et seul le délimiteur qui ouvre ferme. (relevé par Copilot)
    expect(épurerChemins(`valeur "op://Coffre d'équipe/Fiche/Clé" refusée`)).toBe(
      'valeur "op://…" refusée',
    )
    // Sans espace, la citation ne sert à rien : la passe nue suffit, quels que
    // soient les chevrons autour.
    expect(épurerChemins('« op://Coffre/Fiche/Clé » est vide')).toBe('« op://… » est vide')
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
    expect(épurerChemins('op://Coffre/Fiche est invalide, voir https://docs.test/a')).toBe(
      'op://… est invalide, voir https://docs.test/a',
    )
    // La contrepartie, laissée démontrée pour qu'on ne la croie pas couverte
    // *par la grammaire* : la queue d'un coffre à espace survit si personne ne
    // cite la référence. Ce qui la referme est ailleurs — `racines()` passe en
    // racine littérale toute référence lue dans l'environnement, et
    // `tests/server/erreurs.test.ts` fige ce chemin-là. (issue #49)
    expect(épurerChemins('lecture de op://Coffre partagé/Fiche/Clé refusée')).toBe(
      'lecture de op://… partagé…/Clé refusée',
    )
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

  /**
   * Le compteur, sans lequel le test qui suit se viderait de sa substance : une
   * liste vide ne fait échouer aucune itération, et `it.each([])` n'exercerait
   * plus rien.
   */
  it('a au moins une forme de référence à exercer', () => {
    expect(PRÉFIXES_DE_RÉFÉRENCE.length).toBeGreaterThan(0)
  })

  /**
   * **Le lien entre les deux moitiés d'une même vérité.**
   *
   * `estRéférence` (`src/server/secrets.ts`) décide seul des formes qu'une
   * variable d'environnement peut prendre ; `src/core/erreurs.ts` décide de ce
   * qui est caviardé. Le second ne peut pas importer le premier — la frontière
   * de pureté l'interdit, et `tests/core/purete.test.ts` la vérifie —, donc la
   * liste des préfixes y est recopiée à la main. Elle l'était déjà, et la
   * dépendance était consignée **en commentaire des deux côtés** : ce qui ne la
   * fait échouer nulle part. Une seconde forme acceptée traversait le
   * caviardage exactement comme `op://` le faisait avant qu'on s'en occupe.
   *
   * Ce test **lit** la liste plutôt que de citer `op://`, et exerce chacun de
   * ses éléments. Un préfixe ajouté à `estRéférence` sans passe correspondante
   * ici fait donc rougir la suite, au lieu de sortir en silence sur un dépôt
   * public. C'est le motif de l'issue #39, appliqué ici (issue #49).
   *
   * Ce qu'il exige de chaque forme est ce que la forme `op://` tient déjà : le
   * coffre, la fiche et le champ partent, le **préfixe reste** — il dit que la
   * variable portait une adresse et non une valeur littérale, seule question
   * qu'on se pose devant un secret qui n'a pas marché —, et la prose autour ne
   * bouge pas.
   */
  it.each([...PRÉFIXES_DE_RÉFÉRENCE])(
    'caviarde tout ce qu’accepte estRéférence : %s',
    (préfixe) => {
      const nu = épurerChemins(`lecture de ${préfixe}Coffre/Fiche/Champ refusée`)
      expect(nu).toBe(`lecture de ${préfixe}… refusée`)

      // Et sous sa forme citée, la seule qui sache porter des espaces.
      const cité = épurerChemins(`valeur "${préfixe}Coffre partagé/Fiche/Champ" refusée`)
      expect(cité).toBe(`valeur "${préfixe}…" refusée`)
    },
  )
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
