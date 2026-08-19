import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET as vignetteRoute } from '@/app/api/sources/thumb/route'
import { pathTemporary } from '@/server/ffmpeg'
import { messageSafe } from '@/server/errors'
import { sourceThumbArgs } from '@/core/ffmpeg/args'
import {
  folderVignettesSources,
  momentVignetteSource,
  FALLBACK_MOMENT_S,
  rearmCircuitBreaker,
  urlVignetteSource,
  vignetteSource,
  vignetteSourcePath,
  sourceVerifyName,
} from '@/server/source-thumbnails'

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

let root: string
let replays: string
const envStart = { ...process.env }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-vignettes-'))
  replays = path.join(root, 'Replay')
  fs.mkdirSync(replays, { recursive: true })
  process.env.REPLAY_DIR = replays
  process.env.STAGE_DIR = path.join(root, 'stage')
  process.env.PROJECTS_DIR = path.join(root, 'projects')
  // Le disjoncteur est global au module, donc au fichier de test : un
  // renoncement dans un cas condamnerait le suivant pendant une minute.
  rearmCircuitBreaker()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  process.env = { ...envStart }
  vi.restoreAllMocks()
})

function poserVideo(name: string, octets = 4_096): string {
  const filePath = filePath.join(replays, name)
  fs.writeFileSync(filePath, Buffer.alloc(octets))
  return filePath
}

/** Une extraction qui écrit vraiment quelque chose, sans ffmpeg. */
function extractOk(log?: { src: string; dst: string; at: number }[]) {
  return async (o: { src: string; dst: string; at: number }) => {
    log?.push(o)
    await fs.promises.writeFile(o.dst, 'JPEG')
  }
}

const PROBE_MUTE = async () => null

describe('vérifierNomDeSource', () => {
  /**
   * **Refuser ce qui permet de sortir du dossier, pas ce qui est exotique.**
   * C'est la forme que `vérifierIdClip` donne au contrôle, et elle n'est pas
   * négociable ici : les replays portent accents et espaces, et les refuser
   * viderait la bibliothèque.
   */
  it('accepte les accents et les espaces, que les replays portent', () => {
    for (const name of ['2026-01-11-méchante.mp4', 'Retour d’Avignon 2025.MP4', '$RECYCLE.mp4']) {
      expect(sourceVerifyName(name)).toBe(name)
    }
  })

  it('refuse ce qui sortirait du dossier de cache', () => {
    for (const name of ['', '.', '..', 'a/b.mp4', '../evasion.mp4', 'a\\b.mp4', 'a\0b.mp4']) {
      expect(() => sourceVerifyName(name)).toThrow(/invalide/)
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
    poserVideo('b.mp4')
    expect(() => vignetteSourcePath('a/../b.mp4', 1, 1)).toThrow(/invalide/)
  })

  it('ne laisse aucun nom refusé produire un chemin hors du cache', () => {
    for (const name of ['../evasion.mp4', 'a/b.mp4']) {
      expect(() => vignetteSourcePath(name, 1, 1)).toThrow()
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
    expect(path.dirname(p)).toBe(folderVignettesSources())
    expect(p.endsWith('.jpg')).toBe(true)
  })

  it('ne mélange pas deux sources qui ne diffèrent que par leur extension', () => {
    expect(vignetteSourcePath('show.mp4', 1, 2)).not.toBe(vignetteSourcePath('show.mov', 1, 2))
  })

  /**
   * **`NAME_MAX` vaut 255 octets, et un replay peut les atteindre** : c'est un
   * nom de fichier parfaitement lisible. Recopié tel quel dans le nom de cache,
   * puis rallongé de la taille, de la date, de l'extension et — le temps de
   * l'écriture — du suffixe de `cheminTemporaire`, il faisait échouer la
   * vignette en `ENAMETOOLONG` sur une source que rien n'empêchait de lire.
   * (relevé par Copilot)
   *
   * La marge vise le nom **temporaire**, qui est le plus long des deux.
   */
  it('tient sous NAME_MAX même sur un nom de source à la limite', () => {
    const long = `${'é'.repeat(120)}.mp4`
    expect(Buffer.byteLength(long, 'utf8')).toBeGreaterThan(200)

    const destination = vignetteSourcePath(long, 12_764_514_775, 1_773_591_620_922)
    const temporary = pathTemporary(destination)
    expect(Buffer.byteLength(path.basename(destination), 'utf8')).toBeLessThan(255)
    expect(Buffer.byteLength(path.basename(temporary), 'utf8')).toBeLessThan(255)
  })

  /**
   * Le préfixe lisible est tronqué, donc deux noms longs peuvent le partager.
   * C'est l'empreinte qui porte l'identité, pas ce qu'on en montre — sinon deux
   * émissions se disputeraient une vignette.
   */
  it('ne confond pas deux noms longs qui partagent leur préfixe', () => {
    const a = `${'a'.repeat(200)}-un.mp4`
    const b = `${'a'.repeat(200)}-deux.mp4`
    expect(vignetteSourcePath(a, 1, 2)).not.toBe(vignetteSourcePath(b, 1, 2))
  })

  /** Un `ls` du cache doit encore dire de quel replay il s'agit. */
  it('garde le nom lisible quand il tient', () => {
    expect(path.basename(vignetteSourcePath('2026-01-11-méchante.mp4', 1, 2))).toContain(
      '2026-01-11-méchante.mp4',
    )
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
    expect(momentVignetteSource(5_936)).toBeCloseTo(5_936 / 3)
  })

  it('ne rend jamais zéro, même sans durée exploitable', () => {
    for (const duration of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(momentVignetteSource(duration)).toBe(FALLBACK_MOMENT_S)
    }
  })
})

describe('urlVignetteSource', () => {
  it('encode le nom, qui porte accents, espaces et parfois pire', () => {
    expect(urlVignetteSource('2026-01-11-méchante.mp4', 7, 8)).toContain(
      'file=2026-01-11-m%C3%A9chante.mp4',
    )
    expect(urlVignetteSource('a&b.mp4', 7, 8)).toContain('file=a%26b.mp4')
  })

  /**
   * **Sans version, l'URL d'une source est éternelle** — et la carte, qui retient
   * l'URL dont l'image a échoué, ne redemanderait jamais celle d'un replay
   * réenregistré depuis. Le navigateur, lui, garderait la sienne en cache.
   * (relevé par Copilot)
   */
  it('change quand le fichier change, et pas autrement', () => {
    const a = urlVignetteSource('e.mp4', 4_096, 1_700_000_000_000)
    expect(urlVignetteSource('e.mp4', 4_096, 1_700_000_000_000)).toBe(a)
    expect(urlVignetteSource('e.mp4', 8_192, 1_700_000_000_000)).not.toBe(a)
    expect(urlVignetteSource('e.mp4', 4_096, 1_700_000_000_001)).not.toBe(a)
  })
})

describe('vignetteSource', () => {
  it('extrait l’image et la range dans le cache', async () => {
    poserVideo('e.mp4')
    const calls: { src: string; dst: string; at: number }[] = []

    const path = await vignetteSource('e.mp4', {
      probe: async () => 5_936,
      extract: extractOk(calls),
    })

    expect(path).not.toBeNull()
    expect(path.dirname(path as string)).toBe(folderVignettesSources())
    expect(fs.readFileSync(path as string, 'utf8')).toBe('JPEG')
    expect(calls).toHaveLength(1)
    expect(calls[0].at).toBeCloseTo(5_936 / 3)
  })

  it('ne relance rien quand la vignette est déjà là', async () => {
    poserVideo('e.mp4')
    const extract = vi.fn(extractOk())
    const options = { sonder: async () => 60, extract }

    const first = await vignetteSource('e.mp4', options)
    const second = await vignetteSource('e.mp4', options)

    expect(second).toBe(first)
    expect(extract).toHaveBeenCalledTimes(1)
  })

  /**
   * La clé de cache est ce qui rend cette invalidation gratuite : un replay
   * réenregistré sous le même nom change de taille ou de date, donc de clé.
   */
  it('recalcule quand le fichier a été remplacé', async () => {
    poserVideo('e.mp4', 4_096)
    const extract = vi.fn(extractOk())
    await vignetteSource('e.mp4', { probe: async () => 60, extract })

    poserVideo('e.mp4', 8_192)
    await vignetteSource('e.mp4', { probe: async () => 60, extract })

    expect(extract).toHaveBeenCalledTimes(2)
  })

  /**
   * **`-ss` avant `-i` jusque dans l'appel réel.** `sourceThumbArgs` le
   * garantit, mais rien ne garantissait que ce module l'appelle plutôt que de
   * bricoler son propre argv — et c'est la contrainte dont l'issue #41 dit que
   * l'inverser invalide le ticket.
   */
  it('passe par l’argv qui cherche avant de décoder', async () => {
    poserVideo('e.mp4')
    const calls: { src: string; dst: string; at: number }[] = []
    await vignetteSource('e.mp4', { probe: async () => 900, extract: extractOk(calls) })

    const argv = sourceThumbArgs(calls[0])
    expect(argv.indexOf('-ss')).toBeLessThan(argv.indexOf('-i'))
  })

  /**
   * **Ce que le nom temporaire existe pour empêcher.** Un ffmpeg interrompu
   * laisserait sinon un JPEG tronqué sous le nom définitif, et la visite
   * suivante le servirait sans jamais le refaire — la même famille de défaut que
   * `produireArtefact` ferme pour le proxy.
   */
  it('ne laisse aucun moignon derrière une extraction en échec', async () => {
    poserVideo('e.mp4')

    await expect(
      vignetteSource('e.mp4', {
        probe: async () => 60,
        extract: async (o) => {
          await fs.promises.writeFile(o.dst, 'moitié')
          throw new Error('ffmpeg a échoué (code de sortie 1)')
        },
      }),
    ).rejects.toThrow(/ffmpeg/)

    expect(fs.readdirSync(folderVignettesSources())).toEqual([])
  })

  /**
   * **Un code de sortie nul ne prouve pas qu'un fichier est sorti.** Un `-ss`
   * au-delà de la fin du conteneur fait sortir ffmpeg proprement sans avoir rien
   * écrit ; publier ce néant mettrait dans le cache une image qui n'existe pas,
   * et le `rename` accuserait un `ENOENT` venu de nulle part.
   */
  it('refuse de publier quand ffmpeg rend zéro sans écrire de fichier', async () => {
    poserVideo('e.mp4')

    await expect(
      vignetteSource('e.mp4', { probe: async () => 60, extract: async () => {} }),
    ).rejects.toThrow(/aucune image/)
    expect(fs.readdirSync(folderVignettesSources())).toEqual([])
  })

  it('refuse de publier un fichier vide, qui se sert encore plus mal', async () => {
    poserVideo('e.mp4')

    await expect(
      vignetteSource('e.mp4', {
        probe: async () => 60,
        extract: async (o) => {
          await fs.promises.writeFile(o.dst, '')
        },
      }),
    ).rejects.toThrow(/aucune image/)
    expect(fs.readdirSync(folderVignettesSources())).toEqual([])
  })

  /**
   * Zéro octet est une valeur réelle — celle d'un enregistrement qui vient de
   * commencer, ce que `formatOctets` documente déjà. Il n'y a rien à en tirer,
   * et il n'y a pas non plus de raison d'aller le demander à ffmpeg sur le 9p.
   */
  it('ne lance rien sur une source de zéro octet', async () => {
    poserVideo('vide.mp4', 0)
    const extract = vi.fn(extractOk())

    expect(await vignetteSource('vide.mp4', { probe: PROBE_MUTE, extract })).toBeNull()
    expect(extract).not.toHaveBeenCalled()
  })

  it('rend null sur une source disparue depuis la liste', async () => {
    const extract = vi.fn(extractOk())
    expect(await vignetteSource('jamais-vue.mp4', { probe: PROBE_MUTE, extract })).toBeNull()
    expect(extract).not.toHaveBeenCalled()
  })

  /**
   * `lstat` et non `stat`, comme l'ingestion : un lien de `REPLAY_DIR` pointant
   * sur `/etc/shadow` passerait le contrôle de dossier parent de
   * `resolveSource`, que `path.resolve` fait sans suivre les liens. `stat` le
   * déclarerait fichier et ffmpeg irait le lire.
   */
  it('refuse un lien symbolique, que l’ingestion refuse déjà', async () => {
    const outside = path.join(root, 'dehors.mp4')
    fs.writeFileSync(outside, Buffer.alloc(4_096))
    fs.symlinkSync(outside, path.join(replays, 'lien.mp4'))
    const extract = vi.fn(extractOk())

    expect(await vignetteSource('lien.mp4', { probe: PROBE_MUTE, extract })).toBeNull()
    expect(extract).not.toHaveBeenCalled()
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
    poserVideo('e.mp4')
    const extract = vi.fn(extractOk())
    const lstat = vi.spyOn(fs.promises, 'lstat').mockImplementation(() => new Promise(() => {}))

    await expect(
      vignetteSource('e.mp4', { timeoutMs: 20, probe: PROBE_MUTE, extract }),
    ).rejects.toThrow(/ne répond pas/)
    expect(extract).not.toHaveBeenCalled()
    lstat.mockRestore()
  })

  /**
   * **Sérialiser ne suffit pas, et c'est le piège que Codex a relevé.** La file
   * borne les départs simultanés, pas l'accumulation : le premier accès renonce
   * au bout du délai, la file avance, et le suivant part sur le même montage
   * mort et s'y bloque à son tour. Un `lstat` abandonné garde son fil du vivier
   * de libuv, qui en compte quatre — quatre requêtes suffisent donc à figer tout
   * ce qui touche au disque dans le serveur, il leur faut seulement un peu plus
   * de temps.
   *
   * Ce qui se vérifie ici est donc un compte : **un seul `lstat` parti**, pas
   * dix-huit.
   */
  it('ne relance pas un accès par requête après un premier renoncement', async () => {
    for (const name of ['a.mp4', 'b.mp4', 'c.mp4']) poserVideo(name)
    let left = 0
    const lstat = vi.spyOn(fs.promises, 'lstat').mockImplementation(() => {
      left += 1
      return new Promise(() => {})
    })

    const requests = ['a.mp4', 'b.mp4', 'c.mp4'].map((n) =>
      vignetteSource(n, { timeoutMs: 20, probe: PROBE_MUTE, extract: extractOk() }).catch(
        (c: unknown) => c,
      ),
    )
    const results = await Promise.all(requests)
    lstat.mockRestore()

    expect(left).toBe(1)
    for (const r of results) expect((r as Error).message).toMatch(/ne répond pas/)
  })

  /**
   * **Une durée fixe ne fermait pas le cas, elle le retardait.** À chaque
   * expiration, la requête suivante repartait sur le montage mort et y laissait
   * un fil de plus : quatre intervalles, et le vivier de libuv était épuisé
   * comme si le disjoncteur n'existait pas. La condition n'est donc pas une
   * durée mais l'appel lui-même — tant qu'il n'a rien rendu, on n'en lance pas
   * un second, quel que soit le temps écoulé. (relevé par Codex)
   */
  it('reste ouvert tant que l’accès abandonné n’est pas revenu', async () => {
    poserVideo('a.mp4')
    poserVideo('b.mp4')
    let left = 0
    let release: (() => void) | null = null
    const lstat = vi.spyOn(fs.promises, 'lstat').mockImplementation(() => {
      left += 1
      return new Promise((resolve) => {
        release = () => resolve(fs.lstatSync(path.join(replays, 'a.mp4')))
      })
    })

    await expect(vignetteSource('a.mp4', { timeoutMs: 20 })).rejects.toThrow(/ne répond pas/)
    expect(left).toBe(1)

    // Autant de temps qu'on veut : rien ne rouvre le passage tant que le premier
    // `lstat` occupe son fil.
    await new Promise((r) => setTimeout(r, 60))
    await expect(vignetteSource('b.mp4', { timeoutMs: 20 })).rejects.toThrow(/ne répond pas/)
    expect(left).toBe(1)

    // Et il se rouvre tout seul quand l'appel se règle enfin.
    ;(release as unknown as () => void)()
    await new Promise((r) => setTimeout(r, 0))
    lstat.mockRestore()

    const path = await vignetteSource('a.mp4', { probe: async () => 60, extract: extractOk() })
    expect(path).not.toBeNull()
  })

  /**
   * **La sonde de durée a son propre délai, et elle a droit à sa fermeture.**
   * `probe` s'arrête sur le `timeout` d'`execFile`, qui envoie un signal puis
   * attend la sortie du processus : entre les deux il y a un intervalle court et
   * parfaitement normal. Une garde extérieure calée sur la même échéance le
   * gagnait systématiquement — elle ouvrait le disjoncteur et faisait tomber les
   * vignettes voisines, là où la sonde allait rendre `null` et laisser jouer
   * l'instant de repli. (relevé par Codex)
   */
  it('laisse la sonde de durée finir de se fermer avant de conclure', async () => {
    poserVideo('lente.mp4')
    const calls: { src: string; dst: string; at: number }[] = []

    // Une sonde qui rend `null` un peu après son propre délai, comme le fait un
    // ffprobe qu'on vient de signaler.
    const path = await vignetteSource('lente.mp4', {
      timeoutMs: 40,
      probe: () => new Promise((r) => setTimeout(() => r(null), 55)),
      extract: extractOk(calls),
    })

    expect(path).not.toBeNull()
    expect(calls[0].at).toBe(FALLBACK_MOMENT_S)
  })

  it('rouvre le passage une fois le disjoncteur réarmé', async () => {
    poserVideo('e.mp4')
    const lstat = vi.spyOn(fs.promises, 'lstat').mockImplementation(() => new Promise(() => {}))
    await expect(
      vignetteSource('e.mp4', { timeoutMs: 20, probe: PROBE_MUTE }),
    ).rejects.toThrow(/ne répond pas/)
    lstat.mockRestore()

    rearmCircuitBreaker()
    const path = await vignetteSource('e.mp4', {
      probe: async () => 60,
      extract: extractOk(),
    })
    expect(path).not.toBeNull()
  })

  /**
   * **Le délai d'`execFile` ne se déclenche pas sur un processus qui ne sort
   * pas.** Il envoie un signal puis attend la sortie du fils pour rendre la
   * main ; un ffprobe en sommeil non interruptible sur un 9p mort ne sort
   * jamais, donc `probe` ne se règle jamais — et la file entière restait bloquée
   * pour de bon, y compris pour des sources que rien n'empêchait de servir.
   * (relevé par Codex)
   */
  it('renonce sur une sonde de durée qui ne revient pas, sans boucher la file', async () => {
    poserVideo('lente.mp4')
    poserVideo('bonne.mp4')

    await expect(
      vignetteSource('lente.mp4', {
        timeoutMs: 20,
        probe: () => new Promise(() => {}),
        extract: extractOk(),
      }),
    ).rejects.toThrow(/ne répond pas/)

    rearmCircuitBreaker()
    const path = await vignetteSource('bonne.mp4', {
      probe: async () => 60,
      extract: extractOk(),
    })
    expect(path).not.toBeNull()
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
    for (const name of ['a.mp4', 'b.mp4', 'c.mp4']) poserVideo(name)
    let inCurrent = 0
    let concurrentMax = 0

    const extract = async (o: { dst: string }) => {
      inCurrent += 1
      concurrentMax = Math.max(concurrentMax, inCurrent)
      await new Promise((r) => setTimeout(r, 5))
      await fs.promises.writeFile(o.dst, 'JPEG')
      inCurrent -= 1
    }

    await Promise.all(
      ['a.mp4', 'b.mp4', 'c.mp4'].map((n) =>
        vignetteSource(n, { probe: async () => 60, extract }),
      ),
    )

    expect(concurrentMax).toBe(1)
  })

  /**
   * Un échec ne doit pas boucher la file. C'est ce que le `then` à deux branches
   * de `enFile` garantit : sans lui, la première extraction en échec laisserait
   * une promesse rejetée en tête de chaîne et plus aucune vignette ne partirait
   * de la session.
   */
  it('ne bloque pas la file sur un échec', async () => {
    poserVideo('cassée.mp4')
    poserVideo('bonne.mp4')

    await expect(
      vignetteSource('cassée.mp4', {
        probe: async () => 60,
        extract: async () => {
          throw new Error('ffmpeg a échoué (code de sortie 1)')
        },
      }),
    ).rejects.toThrow(/ffmpeg/)

    const path = await vignetteSource('bonne.mp4', {
      probe: async () => 60,
      extract: extractOk(),
    })
    expect(path).not.toBeNull()
  })
})

/** Le contexte que Next passe à une route sans paramètre de chemin. */
function request(query: string): Request {
  return new Request(`http://localhost:4005/api/sources/thumb${query}`)
}

describe('GET /api/sources/thumb', () => {
  it('sert le JPEG du cache', async () => {
    poserVideo('e.mp4')
    await vignetteSource('e.mp4', { probe: async () => 60, extract: extractOk() })

    const response = await vignetteRoute(request('?file=e.mp4'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/jpeg')
    // Courte, et surtout pas « immuable » : la clé du cache disque porte la
    // taille et la date, l'URL non. Un replay réenregistré sous le même nom
    // changerait d'image sans changer d'URL.
    expect(response.headers.get('Cache-Control')).toContain('max-age=')
    expect(response.headers.get('Cache-Control')).not.toContain('immutable')
  })

  it('refuse une demande sans nom', async () => {
    expect((await vignetteRoute(request(''))).status).toBe(400)
    expect((await vignetteRoute(request('?file='))).status).toBe(400)
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
    const attempts = [
      '?file=../../etc/passwd',
      '?file=..%2F..%2Fetc%2Fpasswd',
      '?file=a/b.mp4',
      '?file=.',
      '?file=..',
      '?file=..%5Cwindows',
    ]
    for (const query of attempts) {
      const response = await vignetteRoute(request(query))
      // **400 et non 500** : c'est l'appelant qui a mal formé sa demande, et
      // c'est la surface que quelqu'un ira sonder en premier. Un 500 accuserait
      // le serveur et inscrirait une trace complète au journal à chaque essai.
      expect(response.status, query).toBe(400)
    }
  })

  /**
   * **Un `%2F` doublement encodé n'est pas une évasion, c'est un nom de fichier
   * exotique** — et le contrôle refuse ce qui sort du dossier, pas ce qui est
   * exotique. Il n'existe pas, donc 404, ce qui est exactement ce que la route
   * répond de n'importe quel nom qui n'est pas là.
   */
  it('traite un nom bizarre mais confiné comme un nom, pas comme une attaque', async () => {
    const response = await vignetteRoute(request('?file=..%252F..%252Fetc%252Fpasswd'))
    expect(response.status).toBe(404)
  })

  it('rend 404 sur une source qui n’existe pas', async () => {
    expect((await vignetteRoute(request('?file=jamais-vue.mp4'))).status).toBe(404)
  })

  /**
   * **Le cas où le caviardage se casse le nez**, et le seul qui compte
   * vraiment ici : `REPLAY_DIR` vaut littéralement `/mnt/j/Drive partagés/…`, et
   * un chemin nu se coupe au premier espace. `statAvecDélai` écrit le chemin
   * complet dans son message — il est destiné à un journal de serveur — et c'est
   * `messageSûr`, qui connaît les racines de la machine, qui l'en retire avant
   * la réponse. Ce dépôt est public.
   */
  it('ne publie pas le point de montage quand le partage ne répond pas', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const withSpaces = path.join(root, 'Drive partagés', 'Replay')
    fs.mkdirSync(withSpaces, { recursive: true })
    fs.writeFileSync(path.join(withSpaces, 'e.mp4'), Buffer.alloc(4_096))
    process.env.REPLAY_DIR = withSpaces
    const lstat = vi.spyOn(fs.promises, 'lstat').mockImplementation(() => new Promise(() => {}))

    // Le délai de garde par défaut est de vingt secondes ; on passe par le
    // module plutôt que par la route pour ne pas faire attendre la suite, et on
    // vérifie le message que la route rendrait.
    const error = await vignetteSource('e.mp4', { timeoutMs: 20 }).catch((c: unknown) => c)
    lstat.mockRestore()

    expect(messageSafe(error)).not.toContain(withSpaces)
    expect(messageSafe(error)).not.toContain(root)
    expect(messageSafe(error)).toContain('REPLAY_DIR')
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
      const text = await (await vignetteRoute(request(query))).text()
      expect(text).not.toContain(root)
      expect(text).not.toContain(replays)
      expect(text).not.toContain(os.tmpdir())
    }
  })
})
