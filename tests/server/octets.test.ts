import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GET as serveProxy } from '@/app/api/projects/[id]/proxy/route'
import { servirFichier } from '@/server/octets'

/**
 * Servir des octets, et surtout **arrêter d'en servir quand le client s'en va**.
 *
 * L'abandon d'une requête `Range` est le cas normal d'un lecteur vidéo, pas un
 * cas limite : `<video>` ouvre une plage, la referme dès qu'il a ses
 * métadonnées, en rouvre une autre, et recommence à chaque saut de la tête de
 * lecture. Le proxy d'une émission pèse près d'un gigaoctet ; il n'est jamais lu
 * jusqu'au bout.
 *
 * `tests/server/proxy.test.ts` couvre déjà les statuts et les en-têtes de la
 * route du proxy. Ce fichier-ci éprouve l'autre moitié : ce qui arrive au flux et
 * au descripteur de fichier une fois la réponse partie.
 */

/** Un fichier de deux mégaoctets : de quoi remplir les tampons et se faire mettre en pause. */
const SIZE = 2 * 1024 * 1024

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Les levées `uncaughtException` pendant `work`.
 *
 * Les écouteurs en place — celui de Vitest, celui de Node — sont retirés le
 * temps de la mesure puis remis : sans ça, la levée que ce fichier provoque
 * exprès ferait échouer la suite entière au lieu de l'assertion qui l'attend.
 */
async function uncaughtDuring(work: () => Promise<void>): Promise<unknown[]> {
  const previous = process.listeners('uncaughtException')
  process.removeAllListeners('uncaughtException')
  const caught: unknown[] = []
  const collect = (error: unknown): void => {
    caught.push(error)
  }
  process.on('uncaughtException', collect)
  try {
    await work()
    // La levée arrive au tick qui suit l'annulation, pas pendant : laisser passer.
    await delay(100)
  } finally {
    process.off('uncaughtException', collect)
    for (const listener of previous) process.on('uncaughtException', listener)
  }
  return caught
}

/**
 * Un client qui abandonne au milieu d'une réponse, **comme Next le fait**.
 *
 * `pipeToNodeResponse` pousse le corps vers la réponse Node, et une écriture qui
 * ne passe plus attend l'événement `drain`. C'est le moment que ce montage
 * reproduit : le puits se fige, le flux de fichier a donc le temps de remplir son
 * tampon et de se mettre en pause, puis le signal avorte, puis l'attente se
 * dénoue. Next fait exactement cet ordre-là : son `AbortController` est branché
 * sur `close` de la réponse avant le résolveur de `drain`.
 *
 * **Un signal d'abord, un délai ensuite, et le délai ne s'enlève pas.** Le
 * risque relevé était juste : sous un délai seul, une machine chargée abandonne
 * avant que le puits se soit figé, le scénario n'est pas atteint, rien ne lève et
 * le test passe à vide en annonçant une couverture qu'il n'a pas. `stallReached`
 * supprime ce cas-là.
 *
 * Mais le remède complet — n'attendre que le signal — a été essayé et **mesuré
 * inopérant** : sur le code défectueux, l'abandon déclenché à l'instant du
 * figement ne lève jamais (0 sur 8, quelle que soit l'écriture où l'on fige),
 * là où un simple `setTimeout(0)` derrière le signal lève 5 fois sur 5. La raison
 * est dans la nature du défaut : il faut que la lecture disque **en vol** se soit
 * achevée et que le flux se soit rangé en pause avec son tampon plein, et cet
 * achèvement-là n'a aucun observable depuis ici. Le délai couvre ce que le signal
 * ne peut pas couvrir, et il est large pour la même raison.
 *
 * L'assertion finale refuse le cas où le puits ne se serait jamais figé.
 * (relevé par Aristarque)
 */
async function abortMidStream(body: ReadableStream<Uint8Array>): Promise<void> {
  let release = (): void => {}
  const stalled = new Promise<void>((resolve) => {
    release = resolve
  })
  let markStalled = (): void => {}
  const stallReached = new Promise<void>((resolve) => {
    markStalled = resolve
  })

  const controller = new AbortController()
  let written = 0
  const sink = new WritableStream<Uint8Array>({
    write() {
      written += 1
      if (written === 1) return undefined
      markStalled()
      return stalled
    },
  })

  const piped = body.pipeTo(sink, { signal: controller.signal }).catch(() => {})
  await stallReached
  await delay(50)

  controller.abort(new Error('le client est parti'))
  release()
  await piped

  expect(written).toBeGreaterThanOrEqual(2)
}

/** Les descripteurs ouverts par ce processus. Linux seulement, comme la CI. */
function openDescriptors(): number {
  return fs.readdirSync('/proc/self/fd').length
}

describe('servir des octets', () => {
  // L'accent est **volontaire** et repris de `tests/server/proxy.test.ts` : une
  // émission s'appelle comme elle s'appelle, et le nom du projet traverse
  // `proxyPath` puis `vérifierId` avant de nommer un chemin. Un identifiant ASCII
  // ici ne dirait rien de ce cas-là. (relevé par Aristarque)
  const PROJECT = '2026-01-11-méchante'
  let root: string
  let filePath: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-octets-'))
    process.env.PROJECTS_DIR = root
    fs.mkdirSync(path.join(root, PROJECT), { recursive: true })
    filePath = path.join(root, PROJECT, 'proxy.mp4')
    fs.writeFileSync(filePath, Buffer.alloc(SIZE, 7))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function serve(range?: string): Promise<Response | null> {
    const headers = range === undefined ? undefined : { range }
    return servirFichier(new Request('http://x', { headers }), filePath, {
      'Content-Type': 'video/mp4',
    })
  }

  it('rend le fichier entier, en annonçant qu’il accepte les plages', async () => {
    const response = await serve()
    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-length')).toBe(String(SIZE))
    expect(response?.headers.get('accept-ranges')).toBe('bytes')
    expect((await response!.arrayBuffer()).byteLength).toBe(SIZE)
  })

  it('rend la plage demandée, bornes incluses', async () => {
    const response = await serve('bytes=10-19')
    expect(response?.status).toBe(206)
    expect(response?.headers.get('content-range')).toBe(`bytes 10-19/${SIZE}`)
    expect(response?.headers.get('content-length')).toBe('10')
    expect((await response!.arrayBuffer()).byteLength).toBe(10)
  })

  it('rend 416 avec la taille réelle, et les en-têtes de l’appelant', async () => {
    const response = await serve('bytes=99999999-')
    expect(response?.status).toBe(416)
    expect(response?.headers.get('content-range')).toBe(`bytes */${SIZE}`)
    expect(response?.headers.get('content-type')).toBe('video/mp4')
  })

  it('rend null quand le fichier n’est pas là, et quand c’en est un dossier', async () => {
    fs.rmSync(filePath)
    expect(await serve()).toBeNull()
    fs.mkdirSync(filePath)
    expect(await serve()).toBeNull()
  })

  it('ne lève rien quand une requête de plage est abandonnée en cours', async () => {
    const raised = await uncaughtDuring(async () => {
      for (let i = 0; i < 5; i++) {
        const response = await serve(`bytes=0-${SIZE - 1}`)
        await abortMidStream(response!.body!)
      }
    })
    expect(raised).toEqual([])
  })

  it('ne lève rien quand la route du proxy est abandonnée en cours', async () => {
    const raised = await uncaughtDuring(async () => {
      for (let i = 0; i < 5; i++) {
        const response = await serveProxy(
          new Request('http://x', { headers: { range: 'bytes=0-' } }),
          { params: Promise.resolve({ id: PROJECT }) },
        )
        await abortMidStream(response.body!)
      }
    })
    expect(raised).toEqual([])
  })

  it('ne laisse aucun descripteur derrière une série d’abandons', async () => {
    // Une première passe pour que tout ce qui s'ouvre une fois pour toutes le
    // soit déjà : c'est la *croissance* qui dit la fuite, pas le compte.
    await uncaughtDuring(async () => {
      const response = await serve(`bytes=0-${SIZE - 1}`)
      await abortMidStream(response!.body!)
    })

    const before = openDescriptors()
    await uncaughtDuring(async () => {
      for (let i = 0; i < 20; i++) {
        const response = await serve(`bytes=0-${SIZE - 1}`)
        await abortMidStream(response!.body!)
      }
    })
    expect(openDescriptors()).toBeLessThanOrEqual(before)
  })

  it('ne laisse aucun descripteur derrière un 416, une absence ou un dossier', async () => {
    const before = openDescriptors()
    for (let i = 0; i < 20; i++) {
      expect((await serve('bytes=99999999-'))?.status).toBe(416)
    }
    fs.rmSync(filePath)
    for (let i = 0; i < 20; i++) expect(await serve()).toBeNull()
    fs.mkdirSync(filePath)
    for (let i = 0; i < 20; i++) expect(await serve()).toBeNull()
    expect(openDescriptors()).toBeLessThanOrEqual(before)
  })

  it('referme le descripteur d’un petit fichier dont le corps n’est jamais lu', async () => {
    // Une route qui ne regarde que le statut laisse le corps intact, et personne
    // ne l'annulera jamais. La réserve non nulle de la stratégie fait tirer un
    // premier morceau dès la construction : un fichier plus petit que le tampon
    // part en entier, le flux se termine, le descripteur se referme. Avec une
    // réserve nulle — ce que donne `ReadableStream.from` — il attendrait le
    // ramasse-miettes, et Node en avertit déjà (`DEP0137`).
    const small = path.join(root, PROJECT, 'publication.txt')
    fs.writeFileSync(small, 'de quoi tenir dans un tampon')
    const before = openDescriptors()
    for (let i = 0; i < 20; i++) {
      const response = await servirFichier(new Request('http://x'), small, {
        'Content-Type': 'text/plain; charset=utf-8',
      })
      expect(response?.status).toBe(200)
    }
    await delay(100)
    expect(openDescriptors()).toBeLessThanOrEqual(before)
  })

  it('referme le descripteur au bout d’une lecture complète', async () => {
    const before = openDescriptors()
    for (let i = 0; i < 20; i++) {
      const response = await serve(`bytes=0-${SIZE - 1}`)
      expect((await response!.arrayBuffer()).byteLength).toBe(SIZE)
    }
    await delay(50)
    expect(openDescriptors()).toBeLessThanOrEqual(before)
  })

  describe('validateurs de cache', () => {
    function serveWith(headers: Record<string, string>): Promise<Response | null> {
      return servirFichier(new Request('http://x', { headers }), filePath, {
        'Content-Type': 'video/mp4',
      })
    }

    /**
     * L'en-tête d'une réponse au fichier entier, **sans en garder le corps
     * ouvert** : `cancel()` referme le descripteur sans tirer les deux
     * mégaoctets, alors qu'un corps jamais lu attendrait le ramasse-miettes
     * comme documenté plus haut sur le petit fichier.
     */
    async function headerOf(name: string): Promise<string> {
      const response = (await serve())!
      const value = response.headers.get(name)!
      await response.body?.cancel()
      return value
    }

    it('rend une étiquette différente quand le fichier est remplacé', async () => {
      const first = await headerOf('etag')
      // `writeFileSync` change la taille et l'horodatage de modification :
      // l'étiquette, dérivée des deux, doit changer avec eux.
      fs.writeFileSync(filePath, Buffer.alloc(SIZE + 1, 9))
      const second = await headerOf('etag')
      expect(second).not.toBe(first)
    })

    it('ne laisse aucun descripteur derrière une série de 304', async () => {
      const etagHeader = await headerOf('etag')
      const before = openDescriptors()
      for (let i = 0; i < 20; i++) {
        const response = await serveWith({ 'if-none-match': etagHeader })
        expect(response?.status).toBe(304)
      }
      expect(openDescriptors()).toBeLessThanOrEqual(before)
    })

    it('referme le descripteur d’un If-Range périmé servi en entier', async () => {
      const before = openDescriptors()
      for (let i = 0; i < 20; i++) {
        const response = await serveWith({
          range: 'bytes=0-9',
          'if-range': '"une-étiquette-périmée"',
        })
        expect(response?.status).toBe(200)
        expect((await response!.arrayBuffer()).byteLength).toBe(SIZE)
      }
      await delay(50)
      expect(openDescriptors()).toBeLessThanOrEqual(before)
    })

    it('rend 304 sans If-None-Match, via If-Modified-Since seul', async () => {
      const lastModified = await headerOf('last-modified')
      const response = await serveWith({ 'if-modified-since': lastModified })
      expect(response?.status).toBe(304)
    })

    it('ignore If-Modified-Since quand If-None-Match ne correspond pas', async () => {
      const lastModified = await headerOf('last-modified')
      const response = await serveWith({
        'if-none-match': '"pas-la-bonne-étiquette"',
        'if-modified-since': lastModified,
      })
      expect(response?.status).toBe(200)
    })

    it('rend 304 sans corps quand If-None-Match matche malgré un Range (RFC 9110 §13.2.2)', async () => {
      const etagHeader = await headerOf('etag')
      const response = await serveWith({ range: 'bytes=0-9', 'if-none-match': etagHeader })
      expect(response?.status).toBe(304)
      expect(response?.headers.get('content-range')).toBeNull()
      expect((await response!.arrayBuffer()).byteLength).toBe(0)
    })
  })
})
