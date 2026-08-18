import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET as vignetteRoute } from '@/app/api/sources/thumb/route'
import { sourceThumbArgs } from '@/core/ffmpeg/args'
import {
  dossierVignettesSources,
  instantVignetteSource,
  REPLI_INSTANT_S,
  urlVignetteSource,
  vignetteSource,
  vignetteSourcePath,
  vérifierNomDeSource,
} from '@/server/vignettes-sources'

/**
 * La vignette d'une source, c'est-à-dire **la seule image que ce produit tire de
 * l'original**, sur un Google Drive monté en 9p.
 *
 * Ce qui se vérifie ici n'est pas qu'une image sorte — il n'y a ni ffmpeg ni
 * vidéo dans le CI — mais les quatre gardes que l'issue #41 réclame, plus les
 * cas limites où chacune se dérobe : un nom qui remonte l'arborescence, un
 * montage qui ne répond pas, une source de zéro octet, un ffmpeg qui rend zéro
 * sans avoir rien écrit, et un cache à moitié posé.
 */

let racine: string
let replays: string
const envDépart = { ...process.env }

beforeEach(() => {
  racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-vignettes-'))
  replays = path.join(racine, 'Replay')
  fs.mkdirSync(replays, { recursive: true })
  process.env.REPLAY_DIR = replays
  process.env.STAGE_DIR = path.join(racine, 'stage')
  process.env.PROJECTS_DIR = path.join(racine, 'projects')
})

afterEach(() => {
  fs.rmSync(racine, { recursive: true, force: true })
  process.env = { ...envDépart }
  vi.restoreAllMocks()
})

function poserVidéo(nom: string, octets = 4_096): string {
  const chemin = path.join(replays, nom)
  fs.writeFileSync(chemin, Buffer.alloc(octets))
  return chemin
}

/** Une extraction qui écrit vraiment quelque chose, sans ffmpeg. */
function extraireOk(journal?: { src: string; dst: string; at: number }[]) {
  return async (o: { src: string; dst: string; at: number }) => {
    journal?.push(o)
    await fs.promises.writeFile(o.dst, 'JPEG')
  }
}

const SONDE_MUETTE = async () => null

describe('vérifierNomDeSource', () => {
  /**
   * **Refuser ce qui permet de sortir du dossier, pas ce qui est exotique.**
   * C'est la forme que `vérifierIdClip` donne au contrôle, et elle n'est pas
   * négociable ici : les replays portent accents et espaces, et les refuser
   * viderait la bibliothèque.
   */
  it('accepte les accents et les espaces, que les replays portent', () => {
    for (const nom of ['2026-01-11-méchante.mp4', 'Retour d’Avignon 2025.MP4', '$RECYCLE.mp4']) {
      expect(vérifierNomDeSource(nom)).toBe(nom)
    }
  })

  it('refuse ce qui sortirait du dossier de cache', () => {
    for (const nom of ['', '.', '..', 'a/b.mp4', '../evasion.mp4', 'a\\b.mp4', 'a\0b.mp4']) {
      expect(() => vérifierNomDeSource(nom)).toThrow(/invalide/)
    }
  })

  /**
   * **Il ne double pas `resolveSource`, il ferme ce qu'elle laisse passer.**
   * `resolveSource('a/../b.mp4')` réussit — le chemin résolu tombe bien dans
   * `REPLAY_DIR`, et c'est correct pour désigner un fichier à lire. Mais la
   * chaîne d'origine, recopiée telle quelle dans un nom de cache, en sortirait.
   * Les deux contrôles regardent deux choses différentes.
   */
  it('refuse un nom que resolveSource accepterait', () => {
    poserVidéo('b.mp4')
    expect(() => vignetteSourcePath('a/../b.mp4', 1, 1)).toThrow(/invalide/)
  })

  it('ne laisse aucun nom refusé produire un chemin hors du cache', () => {
    for (const nom of ['../evasion.mp4', 'a/b.mp4']) {
      expect(() => vignetteSourcePath(nom, 1, 1)).toThrow()
    }
  })
})

describe('vignetteSourcePath', () => {
  /**
   * La clé porte le nom, la taille et la date — jamais l'empreinte de source du
   * graphe (§5), qui ajoute la durée ffprobe et imposerait un aller distant
   * avant de savoir s'il y a quelque chose à calculer.
   */
  it('change quand le fichier est remplacé, pas quand il ne l’est pas', () => {
    const a = vignetteSourcePath('e.mp4', 4_096, 1_700_000_000_000)
    expect(vignetteSourcePath('e.mp4', 4_096, 1_700_000_000_000)).toBe(a)
    expect(vignetteSourcePath('e.mp4', 4_097, 1_700_000_000_000)).not.toBe(a)
    expect(vignetteSourcePath('e.mp4', 4_096, 1_700_000_000_001)).not.toBe(a)
  })

  /**
   * `mtimeMs` est un flottant, et deux relevés du même fichier peuvent en rendre
   * deux écritures décimales différentes. Sans troncature, la clé changerait
   * sans que le fichier ait bougé et chaque visite recalculerait la vignette.
   */
  it('tronque la date, qui arrive en flottant', () => {
    expect(vignetteSourcePath('e.mp4', 1, 1_700_000_000_000.7)).toBe(
      vignetteSourcePath('e.mp4', 1, 1_700_000_000_000),
    )
  })

  it('reste dans le dossier de cache, hors de tout projet', () => {
    const p = vignetteSourcePath('e.mp4', 1, 2)
    expect(path.dirname(p)).toBe(dossierVignettesSources())
    expect(p.endsWith('.jpg')).toBe(true)
  })

  it('ne mélange pas deux sources qui ne diffèrent que par leur extension', () => {
    expect(vignetteSourcePath('show.mp4', 1, 2)).not.toBe(vignetteSourcePath('show.mov', 1, 2))
  })
})

describe('instantVignetteSource', () => {
  /**
   * **Jamais zéro.** Les lives ouvrent tous sur le même carton « ON ARRIVE
   * VITE », présent sur les trois émissions mesurées (spec §12) : une image
   * précoce donnerait vingt et une vignettes identiques, c'est-à-dire vingt et
   * une vignettes inutiles.
   */
  it('prend l’image au tiers de la durée', () => {
    expect(instantVignetteSource(5_936)).toBeCloseTo(5_936 / 3)
  })

  it('ne rend jamais zéro, même sans durée exploitable', () => {
    for (const durée of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(instantVignetteSource(durée)).toBe(REPLI_INSTANT_S)
    }
  })
})

describe('urlVignetteSource', () => {
  it('encode le nom, qui porte accents, espaces et parfois pire', () => {
    expect(urlVignetteSource('2026-01-11-méchante.mp4')).toBe(
      '/api/sources/thumb?file=2026-01-11-m%C3%A9chante.mp4',
    )
    expect(urlVignetteSource('a&b.mp4')).toContain('a%26b.mp4')
  })
})

describe('vignetteSource', () => {
  it('extrait l’image et la range dans le cache', async () => {
    poserVidéo('e.mp4')
    const appels: { src: string; dst: string; at: number }[] = []

    const chemin = await vignetteSource('e.mp4', {
      sonder: async () => 5_936,
      extraire: extraireOk(appels),
    })

    expect(chemin).not.toBeNull()
    expect(path.dirname(chemin as string)).toBe(dossierVignettesSources())
    expect(fs.readFileSync(chemin as string, 'utf8')).toBe('JPEG')
    expect(appels).toHaveLength(1)
    expect(appels[0].at).toBeCloseTo(5_936 / 3)
  })

  it('ne relance rien quand la vignette est déjà là', async () => {
    poserVidéo('e.mp4')
    const extraire = vi.fn(extraireOk())
    const options = { sonder: async () => 60, extraire }

    const premier = await vignetteSource('e.mp4', options)
    const second = await vignetteSource('e.mp4', options)

    expect(second).toBe(premier)
    expect(extraire).toHaveBeenCalledTimes(1)
  })

  /**
   * La clé de cache est ce qui rend cette invalidation gratuite : un replay
   * réenregistré sous le même nom change de taille ou de date, donc de clé.
   */
  it('recalcule quand le fichier a été remplacé', async () => {
    poserVidéo('e.mp4', 4_096)
    const extraire = vi.fn(extraireOk())
    await vignetteSource('e.mp4', { sonder: async () => 60, extraire })

    poserVidéo('e.mp4', 8_192)
    await vignetteSource('e.mp4', { sonder: async () => 60, extraire })

    expect(extraire).toHaveBeenCalledTimes(2)
  })

  /**
   * **`-ss` avant `-i` jusque dans l'appel réel.** `sourceThumbArgs` le
   * garantit, mais rien ne garantissait que ce module l'appelle plutôt que de
   * bricoler son propre argv — et c'est la contrainte dont l'issue #41 dit que
   * l'inverser invalide le ticket.
   */
  it('passe par l’argv qui cherche avant de décoder', async () => {
    poserVidéo('e.mp4')
    const appels: { src: string; dst: string; at: number }[] = []
    await vignetteSource('e.mp4', { sonder: async () => 900, extraire: extraireOk(appels) })

    const argv = sourceThumbArgs(appels[0])
    expect(argv.indexOf('-ss')).toBeLessThan(argv.indexOf('-i'))
  })

  /**
   * **Ce que le nom temporaire existe pour empêcher.** Un ffmpeg interrompu
   * laisserait sinon un JPEG tronqué sous le nom définitif, et la visite
   * suivante le servirait sans jamais le refaire — la même famille de défaut que
   * `produireArtefact` ferme pour le proxy.
   */
  it('ne laisse aucun moignon derrière une extraction en échec', async () => {
    poserVidéo('e.mp4')

    await expect(
      vignetteSource('e.mp4', {
        sonder: async () => 60,
        extraire: async (o) => {
          await fs.promises.writeFile(o.dst, 'moitié')
          throw new Error('ffmpeg a échoué (code de sortie 1)')
        },
      }),
    ).rejects.toThrow(/ffmpeg/)

    expect(fs.readdirSync(dossierVignettesSources())).toEqual([])
  })

  /**
   * **Un code de sortie nul ne prouve pas qu'un fichier est sorti.** Un `-ss`
   * au-delà de la fin du conteneur fait sortir ffmpeg proprement sans avoir rien
   * écrit ; publier ce néant mettrait dans le cache une image qui n'existe pas,
   * et le `rename` accuserait un `ENOENT` venu de nulle part.
   */
  it('refuse de publier quand ffmpeg rend zéro sans écrire de fichier', async () => {
    poserVidéo('e.mp4')

    await expect(
      vignetteSource('e.mp4', { sonder: async () => 60, extraire: async () => {} }),
    ).rejects.toThrow(/aucune image/)
    expect(fs.readdirSync(dossierVignettesSources())).toEqual([])
  })

  it('refuse de publier un fichier vide, qui se sert encore plus mal', async () => {
    poserVidéo('e.mp4')

    await expect(
      vignetteSource('e.mp4', {
        sonder: async () => 60,
        extraire: async (o) => {
          await fs.promises.writeFile(o.dst, '')
        },
      }),
    ).rejects.toThrow(/aucune image/)
    expect(fs.readdirSync(dossierVignettesSources())).toEqual([])
  })

  /**
   * Zéro octet est une valeur réelle — celle d'un enregistrement qui vient de
   * commencer, ce que `formatOctets` documente déjà. Il n'y a rien à en tirer,
   * et il n'y a pas non plus de raison d'aller le demander à ffmpeg sur le 9p.
   */
  it('ne lance rien sur une source de zéro octet', async () => {
    poserVidéo('vide.mp4', 0)
    const extraire = vi.fn(extraireOk())

    expect(await vignetteSource('vide.mp4', { sonder: SONDE_MUETTE, extraire })).toBeNull()
    expect(extraire).not.toHaveBeenCalled()
  })

  it('rend null sur une source disparue depuis la liste', async () => {
    const extraire = vi.fn(extraireOk())
    expect(await vignetteSource('jamais-vue.mp4', { sonder: SONDE_MUETTE, extraire })).toBeNull()
    expect(extraire).not.toHaveBeenCalled()
  })

  /**
   * `lstat` et non `stat`, comme l'ingestion : un lien de `REPLAY_DIR` pointant
   * sur `/etc/shadow` passerait le contrôle de dossier parent de
   * `resolveSource`, que `path.resolve` fait sans suivre les liens. `stat` le
   * déclarerait fichier et ffmpeg irait le lire.
   */
  it('refuse un lien symbolique, que l’ingestion refuse déjà', async () => {
    const dehors = path.join(racine, 'dehors.mp4')
    fs.writeFileSync(dehors, Buffer.alloc(4_096))
    fs.symlinkSync(dehors, path.join(replays, 'lien.mp4'))
    const extraire = vi.fn(extraireOk())

    expect(await vignetteSource('lien.mp4', { sonder: SONDE_MUETTE, extraire })).toBeNull()
    expect(extraire).not.toHaveBeenCalled()
  })

  it('refuse une source hors de REPLAY_DIR', async () => {
    await expect(vignetteSource('../dehors.mp4')).rejects.toThrow()
    await expect(vignetteSource('a/b.mp4')).rejects.toThrow(/invalide/)
  })

  /**
   * **Le mode d'échec que l'issue #41 nomme.** Monté avec son transport mort
   * dessous, le Drive ne répond rien et suspend l'appelant sans limite : les
   * bits de permission répondent oui, `/proc/mounts` ne dit rien, et seul un
   * accès réel sous délai de garde tranche. Un ffmpeg lancé après lui pendrait
   * pour toujours — on ne le lance donc pas.
   */
  it('renonce sur un montage muet plutôt que de lancer ffmpeg dessus', async () => {
    poserVidéo('e.mp4')
    const extraire = vi.fn(extraireOk())
    const lstat = vi.spyOn(fs.promises, 'lstat').mockImplementation(() => new Promise(() => {}))

    await expect(
      vignetteSource('e.mp4', { timeoutMs: 20, sonder: SONDE_MUETTE, extraire }),
    ).rejects.toThrow(/ne répond pas/)
    expect(extraire).not.toHaveBeenCalled()
    lstat.mockRestore()
  })

  /**
   * **Un accès au 9p à la fois, tout le serveur confondu.** Renoncer n'est pas
   * annuler : un `lstat` abandonné garde son fil du vivier de libuv, qui en
   * compte quatre. Six vignettes demandées de front — la limite de connexions
   * d'un navigateur — les prendraient tous et figeraient tout ce qui touche au
   * disque dans le serveur, analyse en cours comprise. C'est la règle que
   * `sources.ts` énonce en tête, et elle vaut ici pour la même raison.
   */
  it('sérialise les accès au Drive, même demandés de front', async () => {
    for (const nom of ['a.mp4', 'b.mp4', 'c.mp4']) poserVidéo(nom)
    let enCours = 0
    let simultanéMax = 0

    const extraire = async (o: { dst: string }) => {
      enCours += 1
      simultanéMax = Math.max(simultanéMax, enCours)
      await new Promise((r) => setTimeout(r, 5))
      await fs.promises.writeFile(o.dst, 'JPEG')
      enCours -= 1
    }

    await Promise.all(
      ['a.mp4', 'b.mp4', 'c.mp4'].map((n) =>
        vignetteSource(n, { sonder: async () => 60, extraire }),
      ),
    )

    expect(simultanéMax).toBe(1)
  })

  /**
   * Un échec ne doit pas boucher la file. C'est ce que le `then` à deux branches
   * de `enFile` garantit : sans lui, la première extraction en échec laisserait
   * une promesse rejetée en tête de chaîne et plus aucune vignette ne partirait
   * de la session.
   */
  it('ne bloque pas la file sur un échec', async () => {
    poserVidéo('cassée.mp4')
    poserVidéo('bonne.mp4')

    await expect(
      vignetteSource('cassée.mp4', {
        sonder: async () => 60,
        extraire: async () => {
          throw new Error('ffmpeg a échoué (code de sortie 1)')
        },
      }),
    ).rejects.toThrow(/ffmpeg/)

    const chemin = await vignetteSource('bonne.mp4', {
      sonder: async () => 60,
      extraire: extraireOk(),
    })
    expect(chemin).not.toBeNull()
  })
})

/** Le contexte que Next passe à une route sans paramètre de chemin. */
function requête(query: string): Request {
  return new Request(`http://localhost:4005/api/sources/thumb${query}`)
}

describe('GET /api/sources/thumb', () => {
  it('sert le JPEG du cache', async () => {
    poserVidéo('e.mp4')
    await vignetteSource('e.mp4', { sonder: async () => 60, extraire: extraireOk() })

    const réponse = await vignetteRoute(requête('?file=e.mp4'))
    expect(réponse.status).toBe(200)
    expect(réponse.headers.get('Content-Type')).toBe('image/jpeg')
    // Courte, et surtout pas « immuable » : la clé du cache disque porte la
    // taille et la date, l'URL non. Un replay réenregistré sous le même nom
    // changerait d'image sans changer d'URL.
    expect(réponse.headers.get('Cache-Control')).toContain('max-age=')
    expect(réponse.headers.get('Cache-Control')).not.toContain('immutable')
  })

  it('refuse une demande sans nom', async () => {
    expect((await vignetteRoute(requête(''))).status).toBe(400)
    expect((await vignetteRoute(requête('?file='))).status).toBe(400)
  })

  /**
   * Le cas pour lequel la spec §12 parle d'un « changement de frontière de
   * confiance » : la vignette d'un candidat part d'un `projectId` que le serveur
   * contrôle en base, celle-ci part d'un nom que l'appelant écrit.
   */
  it('ne laisse pas un nom remonter l’arborescence', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Les deux écritures de la même tentative : la forme nue, et celle où les
    // séparateurs sont percent-encodés — c'est `searchParams` qui les décode, et
    // le contrôle a lieu après lui.
    const tentatives = [
      '?file=../../etc/passwd',
      '?file=..%2F..%2Fetc%2Fpasswd',
      '?file=a/b.mp4',
      '?file=.',
      '?file=..',
      '?file=..%5Cwindows',
    ]
    for (const query of tentatives) {
      const réponse = await vignetteRoute(requête(query))
      // **400 et non 500** : c'est l'appelant qui a mal formé sa demande, et
      // c'est la surface que quelqu'un ira sonder en premier. Un 500 accuserait
      // le serveur et inscrirait une trace complète au journal à chaque essai.
      expect(réponse.status, query).toBe(400)
    }
  })

  /**
   * **Un `%2F` doublement encodé n'est pas une évasion, c'est un nom de fichier
   * exotique** — et le contrôle refuse ce qui sort du dossier, pas ce qui est
   * exotique. Il n'existe pas, donc 404, ce qui est exactement ce que la route
   * répond de n'importe quel nom qui n'est pas là.
   */
  it('traite un nom bizarre mais confiné comme un nom, pas comme une attaque', async () => {
    const réponse = await vignetteRoute(requête('?file=..%252F..%252Fetc%252Fpasswd'))
    expect(réponse.status).toBe(404)
  })

  it('rend 404 sur une source qui n’existe pas', async () => {
    expect((await vignetteRoute(requête('?file=jamais-vue.mp4'))).status).toBe(404)
  })

  /**
   * **Aucun chemin du serveur ne sort d'ici.** `route()` épure les messages,
   * mais un message composé sans y penser peut en recopier un ; ce dépôt est
   * public et le point de montage du Drive partagé n'a rien à faire dans une
   * réponse HTTP. Le message de `resolveSource` nomme d'ailleurs la variable
   * `REPLAY_DIR` et non sa valeur, précisément pour cette raison.
   */
  it('ne publie aucun chemin du serveur dans ses erreurs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    for (const query of ['?file=..%2F..%2Fetc%2Fpasswd', '?file=jamais-vue.mp4', '?file=']) {
      const texte = await (await vignetteRoute(requête(query))).text()
      expect(texte).not.toContain(racine)
      expect(texte).not.toContain(replays)
      expect(texte).not.toContain(os.tmpdir())
    }
  })
})
