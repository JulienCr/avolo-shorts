import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GET as servirProxy } from '@/app/api/projects/[id]/proxy/route'
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
  const collect = (erreur: unknown): void => {
    caught.push(erreur)
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
 * reproduit : le puits se fige après le premier morceau — le flux de fichier a
 * donc le temps de remplir son tampon et de se mettre en pause —, puis le signal
 * avorte, puis l'attente se dénoue. Next fait exactement cet ordre-là : son
 * `AbortController` est branché sur `close` de la réponse avant le résolveur de
 * `drain`.
 */
async function abortMidStream(corps: ReadableStream<Uint8Array>): Promise<void> {
  let release = (): void => {}
  const stalled = new Promise<void>((resolve) => {
    release = resolve
  })
  const controller = new AbortController()
  let written = 0
  const sink = new WritableStream<Uint8Array>({
    write() {
      written += 1
      return written === 1 ? undefined : stalled
    },
  })
  const piped = corps.pipeTo(sink, { signal: controller.signal }).catch(() => {})
  await delay(30)
  controller.abort(new Error('le client est parti'))
  release()
  await piped
}

/** Les descripteurs ouverts par ce processus. Linux seulement, comme la CI. */
function openDescriptors(): number {
  return fs.readdirSync('/proc/self/fd').length
}

describe('servir des octets', () => {
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
        const response = await servirProxy(
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
})
