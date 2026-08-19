import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'

import { GET as servirProxy } from '@/app/api/projects/[id]/proxy/route'
import { encodeurProxy } from '@/server/steps/proxy'

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

const envDépart = { ...process.env }
afterEach(() => {
  process.env = { ...envDépart }
})

describe('encodeurProxy', () => {
  it("vaut x264 sur auto, contre le réflexe", () => {
    process.env.FFMPEG_ENCODER = 'auto'
    expect(encodeurProxy()).toBe('x264')
  })

  it('vaut x264 quand la variable est absente', () => {
    delete process.env.FFMPEG_ENCODER
    expect(encodeurProxy()).toBe('x264')
  })

  it('respecte un choix explicite, même celui qui coûte une minute sur douze', () => {
    process.env.FFMPEG_ENCODER = 'nvenc'
    expect(encodeurProxy()).toBe('nvenc')
    process.env.FFMPEG_ENCODER = 'x264'
    expect(encodeurProxy()).toBe('x264')
  })

  it('refuse une valeur inconnue', () => {
    process.env.FFMPEG_ENCODER = 'cuda'
    expect(() => encodeurProxy()).toThrow(/FFMPEG_ENCODER/)
  })
})

describe('GET /api/projects/:id/proxy', () => {
  const PROJET = '2026-01-11-méchante'
  /** Cent octets reconnaissables : chaque tranche dit d'où elle vient. */
  const CONTENU = Buffer.from(
    Array.from({ length: 100 }, (_, i) => 48 + (i % 10)),
  )

  let racine: string

  function contexte(id: string): { params: Promise<{ id: string }> } {
    return { params: Promise.resolve({ id }) }
  }

  function demander(id: string, range?: string): Promise<Response> {
    const entêtes = range === undefined ? undefined : { range }
    return servirProxy(new Request('http://x', { headers: entêtes }), contexte(id))
  }

  function demanderAvec(id: string, entêtes: Record<string, string>): Promise<Response> {
    return servirProxy(new Request('http://x', { headers: entêtes }), contexte(id))
  }

  function poserProxy(contenu: Buffer = CONTENU): void {
    fs.mkdirSync(path.join(racine, PROJET), { recursive: true })
    fs.writeFileSync(path.join(racine, PROJET, 'proxy.mp4'), contenu)
  }

  beforeEach(() => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-proxy-'))
    process.env.PROJECTS_DIR = racine
  })

  afterEach(() => {
    fs.rmSync(racine, { recursive: true, force: true })
  })

  it('sert le fichier entier, et annonce qu’il accepte les plages', async () => {
    poserProxy()
    const réponse = await demander(PROJET)

    expect(réponse.status).toBe(200)
    expect(réponse.headers.get('content-type')).toBe('video/mp4')
    expect(réponse.headers.get('content-length')).toBe('100')
    // Sans cet en-tête le navigateur ne redemandera jamais de plage, et la barre
    // de lecture reste inerte quelles que soient les bornes qu'on sait calculer.
    expect(réponse.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await réponse.arrayBuffer()).equals(CONTENU)).toBe(true)
  })

  it('sert la plage demandée, bornes incluses', async () => {
    poserProxy()
    const réponse = await demander(PROJET, 'bytes=10-19')

    expect(réponse.status).toBe(206)
    expect(réponse.headers.get('content-range')).toBe('bytes 10-19/100')
    // Dix octets, pas neuf : les deux bornes sont inclusives.
    expect(réponse.headers.get('content-length')).toBe('10')
    const reçu = Buffer.from(await réponse.arrayBuffer())
    expect(reçu.equals(CONTENU.subarray(10, 20))).toBe(true)
  })

  it('sert les derniers octets, la forme dont un lecteur MP4 se sert pour l’index', async () => {
    poserProxy()
    const réponse = await demander(PROJET, 'bytes=-16')

    expect(réponse.status).toBe(206)
    expect(réponse.headers.get('content-range')).toBe('bytes 84-99/100')
    expect(Buffer.from(await réponse.arrayBuffer()).equals(CONTENU.subarray(84))).toBe(true)
  })

  it('borne une plage ouverte sur la taille réelle', async () => {
    poserProxy()
    const réponse = await demander(PROJET, 'bytes=90-')

    expect(réponse.status).toBe(206)
    expect(réponse.headers.get('content-range')).toBe('bytes 90-99/100')
  })

  it('rend 416 avec la taille réelle sur une plage insatisfiable', async () => {
    poserProxy()
    const réponse = await demander(PROJET, 'bytes=500-600')

    expect(réponse.status).toBe(416)
    // La taille est la seule information qui permette au client de reformuler.
    expect(réponse.headers.get('content-range')).toBe('bytes */100')
  })

  it('rend 404 tant que l’encodage n’a rien produit', async () => {
    expect((await demander(PROJET)).status).toBe(404)
  })

  it('rend 404 sur un identifiant qui tente de sortir du dossier', async () => {
    // `vérifierId` garde la traversée : un identifiant qui ne peut nommer aucun
    // chemin ne désigne aucun proxy.
    expect((await demander('../../etc/passwd')).status).toBe(404)
    expect((await demander('..')).status).toBe(404)
    expect((await demander('')).status).toBe(404)
  })

  it('rend 404 quand `proxy.mp4` est un dossier', async () => {
    // Linux accepte de l'ouvrir : sans le contrôle `isFile()`, la lecture
    // échouerait au milieu d'une réponse déjà commencée.
    fs.mkdirSync(path.join(racine, PROJET, 'proxy.mp4'), { recursive: true })
    expect((await demander(PROJET)).status).toBe(404)
  })

  it('rend 200 sur un fichier vide plutôt que d’inventer une plage', async () => {
    // Un proxy dont l'encodage vient d'être interrompu : aucune plage n'y est
    // satisfiable, mais la requête sans en-tête reste légitime.
    poserProxy(Buffer.alloc(0))
    expect((await demander(PROJET)).status).toBe(200)
    expect((await demander(PROJET, 'bytes=0-9')).status).toBe(416)
  })

  describe('cache', () => {
    it('pose ETag et Last-Modified sur un 200, un 206 et un 416', async () => {
      poserProxy()
      for (const réponse of [
        await demander(PROJET),
        await demander(PROJET, 'bytes=10-19'),
        await demander(PROJET, 'bytes=500-600'),
      ]) {
        expect(réponse.headers.get('etag')).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/)
        expect(réponse.headers.get('last-modified')).not.toBeNull()
      }
    })

    it('pose Cache-Control: private, no-cache sur les réponses qui servent le fichier', async () => {
      poserProxy()
      const réponse = await demander(PROJET)
      expect(réponse.headers.get('cache-control')).toBe('private, no-cache')
    })

    it('pose Cache-Control: no-store sur les deux 404 d’absence', async () => {
      // Un identifiant qui ne peut nommer aucun chemin — décidé dans la route,
      // avant `servirFichier`.
      const idInvalide = await demander('../../etc/passwd')
      expect(idInvalide.status).toBe(404)
      expect(idInvalide.headers.get('cache-control')).toBe('no-store')

      // Un fichier pas encore là — décidé par `servirFichier`, qui rend `null`.
      // Le proxy arrive environ douze minutes après la création du projet :
      // mettre ce cas nominal en cache serait une panne durable.
      const pasEncore = await demander(PROJET)
      expect(pasEncore.status).toBe(404)
      expect(pasEncore.headers.get('cache-control')).toBe('no-store')
    })

    it('rend 304 sans corps ni Content-Range quand If-None-Match correspond', async () => {
      poserProxy()
      const étiquette = (await demander(PROJET)).headers.get('etag')!

      const réponse = await demanderAvec(PROJET, { 'if-none-match': étiquette })
      expect(réponse.status).toBe(304)
      expect(réponse.headers.get('content-range')).toBeNull()
      // Aucun corps : donc pas de Content-Length qui en décrirait un.
      expect(réponse.headers.get('content-length')).toBeNull()
      expect((await réponse.arrayBuffer()).byteLength).toBe(0)
      expect(réponse.headers.get('etag')).toBe(étiquette)
      expect(réponse.headers.get('last-modified')).not.toBeNull()
    })

    it('rend 200 entier quand If-None-Match ne correspond plus', async () => {
      poserProxy()
      const réponse = await demanderAvec(PROJET, { 'if-none-match': '"une-autre-étiquette"' })
      expect(réponse.status).toBe(200)
      expect((await réponse.arrayBuffer()).byteLength).toBe(CONTENU.length)
    })

    it('rend 304 quand If-Modified-Since est postérieur ou égal à Last-Modified', async () => {
      poserProxy()
      const dernièreModif = (await demander(PROJET)).headers.get('last-modified')!

      const réponse = await demanderAvec(PROJET, { 'if-modified-since': dernièreModif })
      expect(réponse.status).toBe(304)
    })

    it('rend 200 entier quand If-Modified-Since est antérieur à Last-Modified', async () => {
      poserProxy()
      const réponse = await demanderAvec(PROJET, { 'if-modified-since': 'Tue, 01 Jan 2000 00:00:00 GMT' })
      expect(réponse.status).toBe(200)
    })

    it('If-None-Match prime sur If-Modified-Since quand les deux sont présents', async () => {
      poserProxy()
      // Une date qui dirait « non modifié », contredite par une étiquette qui
      // dit le contraire : c'est l'étiquette qui doit trancher (RFC 7232 §3.3).
      const dernièreModif = (await demander(PROJET)).headers.get('last-modified')!
      const réponse = await demanderAvec(PROJET, {
        'if-none-match': '"une-autre-étiquette"',
        'if-modified-since': dernièreModif,
      })
      expect(réponse.status).toBe(200)
    })

    it('sert la plage entière demandée quand If-Range correspond', async () => {
      poserProxy()
      const étiquette = (await demander(PROJET)).headers.get('etag')!
      const réponse = await demanderAvec(PROJET, { range: 'bytes=10-19', 'if-range': étiquette })
      expect(réponse.status).toBe(206)
      expect(réponse.headers.get('content-range')).toBe('bytes 10-19/100')
    })

    it('rend le fichier entier en 200 quand If-Range ne correspond plus', async () => {
      // C'est le cas qui protège un scrub en cours d'une reconstruction du
      // proxy sous les doigts : le client redemande une plage d'un fichier qui
      // a changé, et sans ce contrôle il recoudrait deux moitiés de vidéos
      // différentes.
      poserProxy()
      const réponse = await demanderAvec(PROJET, {
        range: 'bytes=10-19',
        'if-range': '"une-étiquette-périmée"',
      })
      expect(réponse.status).toBe(200)
      expect(réponse.headers.get('content-range')).toBeNull()
      expect((await réponse.arrayBuffer()).byteLength).toBe(CONTENU.length)
    })
  })
})
