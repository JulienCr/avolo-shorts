import { describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'

/**
 * La frontière de pureté de `src/core/` est une règle ESLint. Une règle se
 * défait sans bruit : un motif retiré « parce qu'il gênait », une mise à jour
 * qui change la sémantique des jokers, et le lint reste vert en ne gardant
 * plus rien. Ce test la vérifie comme on vérifierait n'importe quel code —
 * en lui donnant des entrées et en regardant ce qu'elle rend.
 *
 * C'est la leçon d'OpenShorts, dont le `main.py` importe `torch` au chargement
 * et dont le CI n'a jamais tourné une seule fois (spec §14).
 *
 * `lintText` prend un `filePath` qui n'a pas besoin d'exister sur le disque :
 * il ne sert qu'à choisir les blocs de configuration applicables. Aucune
 * fixture à ranger, et donc aucune fixture à exclure du lint.
 */

const eslint = new ESLint()

async function erreurs(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return result.messages
    .filter((m) => m.severity === 2)
    .map((m) => m.ruleId ?? '(inconnu)')
}

// Ce que `src/core/` ne doit jamais pouvoir importer, et pourquoi chacun est là.
const INTERDITS = [
  ["import fs from 'node:fs'", 'le module natif préfixé'],
  ["import fsp from 'node:fs/promises'", 'un sous-chemin de module natif'],
  ["import { readFile } from 'fs'", 'la forme nue, toujours légale'],
  ["import rf from 'fs/promises'", 'un sous-chemin de la forme nue'],
  ["import { join } from 'path'", 'les chemins sont une affaire de serveur'],
  ["import { spawn } from 'child_process'", 'ffmpeg se lance depuis src/server'],
  ["import os from 'os'", ''],
  ["import { createHash } from 'node:crypto'", ''],
  // Les quatre que la première version de la règle laissait passer, faute
  // d'énumérer les modules natifs autrement qu'à la main (relevé par Codex).
  ["import dns from 'dns'", 'un natif hors de la liste écrite à la main'],
  ["import tls from 'tls'", ''],
  ["import http2 from 'http2'", ''],
  ["import dgram from 'dgram'", ''],
  ["import Database from 'better-sqlite3'", 'le stockage'],
  ["import { GoogleGenAI } from '@google/genai'", 'un SDK réseau'],
  ["import g from '@google/genai/node'", 'et ses sous-chemins'],
  ["import { NextResponse } from 'next/server'", 'le framework'],
  ["import d from 'next/dist/server/x'", 'et ses profondeurs'],
  ["import { useState } from 'react'", "src/core n'est pas de l'interface"],
  ["import { createRoot } from 'react-dom/client'", ''],
  ["import { db } from '@/server/db'", "l'autre côté de la frontière"],
  ["import { p } from '@/server/steps/deep/proxy'", 'même en profondeur'],
  ["import { B } from '@/components/ui/button'", ''],
  ["import { cn } from '@/lib/utils'", ''],
  ["import { u } from '@/hooks/use-clip'", "un dossier qu'aucune liste n'anticipait"],
  // Le même fichier désigné par un chemin relatif. Un motif en `@/server/*`
  // seul ne couvrait que l'alias et laissait passer celui-ci (Copilot).
  ["import { db } from '../server/db'", "l'alias contourné d'un cran"],
  ["import { p } from '../../server/steps/proxy'", 'et de deux'],
  ["import { B } from '../../components/ui/button'", ''],
  ["import type fsType from 'node:fs'", 'y compris en import de type'],
] as const

describe('la frontière de pureté de src/core', () => {
  it.each(INTERDITS)('refuse %s', async (ligne) => {
    const rules = await erreurs(`${ligne}\nexport const x = 1\n`, 'src/core/sonde.ts')
    expect(rules).toContain('no-restricted-imports')
  })

  it("refuse l'import dynamique, que no-restricted-imports ne voit pas", async () => {
    const rules = await erreurs(
      "export async function f() { return import('node:fs') }\n",
      'src/core/sonde.ts',
    )
    expect(rules).toContain('no-restricted-syntax')
  })

  it('refuse require()', async () => {
    const rules = await erreurs("export const os = require('node:os')\n", 'src/core/sonde.ts')
    expect(rules).toContain('no-restricted-syntax')
  })

  it('refuse la lecture de process.env, qui rendrait un calcul irreproductible', async () => {
    const rules = await erreurs('export const bin = process.env.FFMPEG_BIN\n', 'src/core/sonde.ts')
    expect(rules).toContain('no-restricted-globals')
  })

  // Un global n'apparaît dans aucune liste d'imports : sans cette règle, un
  // `fetch` sortait sur le réseau depuis src/core en passant le lint (Codex).
  it.each([
    ['fetch', "export const f = () => fetch('https://exemple.fr')"],
    ['XMLHttpRequest', 'export const f = () => new XMLHttpRequest()'],
    ['WebSocket', "export const f = () => new WebSocket('wss://exemple.fr')"],
    ['window', 'export const f = () => window.innerWidth'],
    ['document', 'export const f = () => document.title'],
  ])('refuse le global %s', async (_nom, code) => {
    const rules = await erreurs(`${code}\n`, 'src/core/sonde.ts')
    expect(rules).toContain('no-restricted-globals')
  })

  it('laisse passer du TypeScript pur', async () => {
    const rules = await erreurs(
      'export const somme = (a: number, b: number): number => a + b\n',
      'src/core/sonde.ts',
    )
    expect(rules).toEqual([])
  })

  // Le pendant du test précédent : une frontière qui interdit trop est aussi
  // cassée qu'une frontière qui n'interdit rien. `captions/retime.ts` a besoin
  // de `../edl`, et un `lib` dans le chemin d'un paquet n'est pas notre `lib`.
  it('laisse passer ce qui reste à l’intérieur de src/core', async () => {
    const rules = await erreurs(
      ["import { normalizeSegments } from '../edl'", 'export const x = normalizeSegments'].join(
        '\n',
      ),
      'src/core/captions/retime.ts',
    )
    expect(rules).toEqual([])
  })

  it('laisse passer @/core, le seul alias qui reste accessible', async () => {
    const rules = await erreurs(
      "import { clipDuration } from '@/core/edl'\nexport const x = clipDuration\n",
      'src/core/captions/retime.ts',
    )
    expect(rules).toEqual([])
  })

  it("laisse passer les sous-chemins de vrais paquets, qu'un glob **/lib/** aurait pris", async () => {
    const rules = await erreurs(
      "import { z } from 'zod/v4'\nexport const x = z\n",
      'src/core/sonde.ts',
    )
    expect(rules).toEqual([])
  })

  // Le contrôle négatif. Sans lui, une règle appliquée au dépôt entier passerait
  // tous les tests ci-dessus tout en rendant `src/server/` inécrivable.
  it("n'entrave pas src/server, dont c'est précisément le métier", async () => {
    const rules = await erreurs(
      [
        "import fs from 'node:fs'",
        "import Database from 'better-sqlite3'",
        'export const p = [fs, Database, process.env.HOME]',
      ].join('\n'),
      'src/server/sonde.ts',
    )
    expect(rules).toEqual([])
  })
})
