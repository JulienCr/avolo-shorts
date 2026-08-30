import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'

import { GET as serveProxy } from '@/app/api/projects/[id]/proxy/route'
import { encoderProxy } from '@/server/steps/proxy'
import { snapshotEnv } from '../helpers/env'

/**
 * Le proxy est le seul étage où le GPU **fait perdre du temps**, et c'est
 * mesuré : 13,8x en x264 contre 12,8x en NVENC. Le réflexe — « on a une 4090,
 * on encode dessus » — est faux ici, donc il vaut un test.
 *
 * Le reste du fichier couvre le **gestionnaire de route**, que rien ne touchait :
 * `tests/core/range.test.ts` éprouve l'analyse de l'en-tête, et s'arrête là. Or
 * ce qui casse la barre de lecture d'un `<video>` n'est pas seulement le calcul
 * des bornes — c'est aussi un `Accept-Ranges` oublié, un `Content-Length` qui
 * décrit le fichier entier sous un 206, ou un 416 sans la taille réelle. Aucun de
 * ces trois-là n'a de bornes fausses, et aucun ne se voit sans appeler la route.
 */

const restoreEnv = snapshotEnv()
afterEach(() => {
  restoreEnv()
})

describe('encoderProxy', () => {
  it("vaut x264 sur auto, contre le réflexe", () => {
    process.env.FFMPEG_ENCODER = 'auto'
    expect(encoderProxy()).toBe('x264')
  })

  it('vaut x264 quand la variable est absente', () => {
    delete process.env.FFMPEG_ENCODER
    expect(encoderProxy()).toBe('x264')
  })

  it('respecte un choix explicite, même celui qui coûte une minute sur douze', () => {
    process.env.FFMPEG_ENCODER = 'nvenc'
    expect(encoderProxy()).toBe('nvenc')
    process.env.FFMPEG_ENCODER = 'x264'
    expect(encoderProxy()).toBe('x264')
  })

  it('refuse une valeur inconnue', () => {
    process.env.FFMPEG_ENCODER = 'cuda'
    expect(() => encoderProxy()).toThrow(/FFMPEG_ENCODER/)
  })
})

describe('GET /api/projects/:id/proxy', () => {
  const PROJECT = '2026-01-11-méchante'
  /** Cent octets reconnaissables : chaque tranche dit d'où elle vient. */
  const CONTENT = Buffer.from(
    Array.from({ length: 100 }, (_, i) => 48 + (i % 10)),
  )

  let root: string

  function context(id: string): { params: Promise<{ id: string }> } {
    return { params: Promise.resolve({ id }) }
  }

  function request(id: string, rangeOrHeaders?: string | Record<string, string>): Promise<Response> {
    const headers =
      rangeOrHeaders === undefined
        ? undefined
        : typeof rangeOrHeaders === 'string'
          ? { range: rangeOrHeaders }
          : rangeOrHeaders
    return serveProxy(new Request('http://x', { headers: headers }), context(id))
  }

  function poserProxy(content: Buffer = CONTENT): void {
    fs.mkdirSync(path.join(root, PROJECT), { recursive: true })
    fs.writeFileSync(path.join(root, PROJECT, 'proxy.mp4'), content)
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-proxy-'))
    process.env.PROJECTS_DIR = root
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('sert le fichier entier, et annonce qu’il accepte les plages', async () => {
    poserProxy()
    const response = await request(PROJECT)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-length')).toBe('100')
    // Sans cet en-tête le navigateur ne redemandera jamais de plage, et la barre
    // de lecture reste inerte quelles que soient les bornes qu'on sait calculer.
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await response.arrayBuffer()).equals(CONTENT)).toBe(true)
  })

  it('sert la plage demandée, bornes incluses', async () => {
    poserProxy()
    const response = await request(PROJECT, 'bytes=10-19')

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100')
    // Dix octets, pas neuf : les deux bornes sont inclusives.
    expect(response.headers.get('content-length')).toBe('10')
    const received = Buffer.from(await response.arrayBuffer())
    expect(received.equals(CONTENT.subarray(10, 20))).toBe(true)
  })

  it('sert les derniers octets, la forme dont un lecteur MP4 se sert pour l’index', async () => {
    poserProxy()
    const response = await request(PROJECT, 'bytes=-16')

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 84-99/100')
    expect(Buffer.from(await response.arrayBuffer()).equals(CONTENT.subarray(84))).toBe(true)
  })

  it('borne une plage ouverte sur la taille réelle', async () => {
    poserProxy()
    const response = await request(PROJECT, 'bytes=90-')

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 90-99/100')
  })

  it('rend 416 avec la taille réelle sur une plage insatisfiable', async () => {
    poserProxy()
    const response = await request(PROJECT, 'bytes=500-600')

    expect(response.status).toBe(416)
    // La taille est la seule information qui permette au client de reformuler.
    expect(response.headers.get('content-range')).toBe('bytes */100')
  })

  it('rend 404 tant que l’encodage n’a rien produit', async () => {
    expect((await request(PROJECT)).status).toBe(404)
  })

  it('rend 404 sur un identifiant qui tente de sortir du dossier', async () => {
    // `verifyId` garde la traversée : un identifiant qui ne peut nommer aucun
    // chemin ne désigne aucun proxy.
    expect((await request('../../etc/passwd')).status).toBe(404)
    expect((await request('..')).status).toBe(404)
    expect((await request('')).status).toBe(404)
  })

  it('rend 404 quand `proxy.mp4` est un dossier', async () => {
    // Linux accepte de l'ouvrir : sans le contrôle `isFile()`, la lecture
    // échouerait au milieu d'une réponse déjà commencée.
    fs.mkdirSync(path.join(root, PROJECT, 'proxy.mp4'), { recursive: true })
    expect((await request(PROJECT)).status).toBe(404)
  })

  it('rend 200 sur un fichier vide plutôt que d’inventer une plage', async () => {
    // Un proxy dont l'encodage vient d'être interrompu : aucune plage n'y est
    // satisfiable, mais la requête sans en-tête reste légitime.
    poserProxy(Buffer.alloc(0))
    expect((await request(PROJECT)).status).toBe(200)
    expect((await request(PROJECT, 'bytes=0-9')).status).toBe(416)
  })

  describe('cache', () => {
    it('pose ETag et Last-Modified sur un 200, un 206 et un 416', async () => {
      poserProxy()
      for (const response of [
        await request(PROJECT),
        await request(PROJECT, 'bytes=10-19'),
        await request(PROJECT, 'bytes=500-600'),
      ]) {
        expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/)
        expect(response.headers.get('last-modified')).not.toBeNull()
      }
    })

    it('pose Cache-Control: private, no-cache sur les réponses qui servent le fichier', async () => {
      poserProxy()
      const response = await request(PROJECT)
      expect(response.headers.get('cache-control')).toBe('private, no-cache')
    })

    it('pose Cache-Control: no-store sur les deux 404 d’absence', async () => {
      // Un identifiant qui ne peut nommer aucun chemin — décidé dans la route,
      // avant `serveFile`.
      const invalidId = await request('../../etc/passwd')
      expect(invalidId.status).toBe(404)
      expect(invalidId.headers.get('cache-control')).toBe('no-store')

      // Un fichier pas encore là — décidé par `serveFile`, qui rend `null`.
      // Le proxy arrive environ douze minutes après la création du projet :
      // mettre ce cas nominal en cache serait une panne durable.
      const notYetThere = await request(PROJECT)
      expect(notYetThere.status).toBe(404)
      expect(notYetThere.headers.get('cache-control')).toBe('no-store')
    })

    it('rend 304 sans corps ni Content-Range quand If-None-Match correspond', async () => {
      poserProxy()
      const etagHeader = (await request(PROJECT)).headers.get('etag')!

      const response = await request(PROJECT, { 'if-none-match': etagHeader })
      expect(response.status).toBe(304)
      expect(response.headers.get('content-range')).toBeNull()
      // Aucun corps : donc pas de Content-Length qui en décrirait un.
      expect(response.headers.get('content-length')).toBeNull()
      expect((await response.arrayBuffer()).byteLength).toBe(0)
      expect(response.headers.get('etag')).toBe(etagHeader)
      expect(response.headers.get('last-modified')).not.toBeNull()
    })

    it('rend 200 entier quand If-None-Match ne correspond plus', async () => {
      poserProxy()
      const response = await request(PROJECT, { 'if-none-match': '"une-autre-étiquette"' })
      expect(response.status).toBe(200)
      expect((await response.arrayBuffer()).byteLength).toBe(CONTENT.length)
    })

    it('rend 304 quand If-Modified-Since est postérieur ou égal à Last-Modified', async () => {
      poserProxy()
      const lastModified = (await request(PROJECT)).headers.get('last-modified')!

      const response = await request(PROJECT, { 'if-modified-since': lastModified })
      expect(response.status).toBe(304)
    })

    it('rend 200 entier quand If-Modified-Since est antérieur à Last-Modified', async () => {
      poserProxy()
      const response = await request(PROJECT, { 'if-modified-since': 'Tue, 01 Jan 2000 00:00:00 GMT' })
      expect(response.status).toBe(200)
    })

    it('If-None-Match prime sur If-Modified-Since quand les deux sont présents', async () => {
      poserProxy()
      // Une date qui dirait « non modifié », contredite par une étiquette qui
      // dit le contraire : c'est l'étiquette qui doit trancher (RFC 7232 §3.3).
      const lastModified = (await request(PROJECT)).headers.get('last-modified')!
      const response = await request(PROJECT, {
        'if-none-match': '"une-autre-étiquette"',
        'if-modified-since': lastModified,
      })
      expect(response.status).toBe(200)
    })

    it('sert la plage entière demandée quand If-Range correspond', async () => {
      poserProxy()
      const etagHeader = (await request(PROJECT)).headers.get('etag')!
      const response = await request(PROJECT, { range: 'bytes=10-19', 'if-range': etagHeader })
      expect(response.status).toBe(206)
      expect(response.headers.get('content-range')).toBe('bytes 10-19/100')
    })

    it('rend le fichier entier en 200 quand If-Range ne correspond plus', async () => {
      // C'est le cas qui protège un scrub en cours d'une reconstruction du
      // proxy sous les doigts : le client redemande une plage d'un fichier qui
      // a changé, et sans ce contrôle il recoudrait deux moitiés de vidéos
      // différentes.
      poserProxy()
      const response = await request(PROJECT, {
        range: 'bytes=10-19',
        'if-range': '"une-étiquette-périmée"',
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-range')).toBeNull()
      expect((await response.arrayBuffer()).byteLength).toBe(CONTENT.length)
    })
  })
})
