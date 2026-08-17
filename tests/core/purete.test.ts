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

// Les trois règles qui portent la frontière, et les seules que ce fichier
// regarde. Les contrôles négatifs demandent leur *absence* plutôt qu'un relevé
// vide : sinon la première règle de style ajoutée au dépôt ferait échouer ce
// test dans la PR de quelqu'un d'autre, pour une raison sans rapport.
const RÈGLES_DE_PURETÉ = [
  'no-restricted-imports',
  'no-restricted-syntax',
  'no-restricted-globals',
]

async function erreurs(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return result.messages
    .filter((m) => m.severity === 2)
    .map((m) => m.ruleId ?? '(inconnu)')
}

async function erreursDePureté(code: string, filePath: string): Promise<string[]> {
  return (await erreurs(code, filePath)).filter((r) => RÈGLES_DE_PURETÉ.includes(r))
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
  // Tous installés, tous adossés à React, et tous absents d'une liste noire
  // qui ne nommait que `react` et `react-dom` (Copilot).
  ["import { create } from 'zustand'", 'un paquet React que la liste noire ratait'],
  ["import { Button } from '@base-ui/react'", ''],
  ["import { useQuery } from '@tanstack/react-query'", ''],
  ["import { useVirtualizer } from '@tanstack/react-virtual'", ''],
  ["import { Play } from 'lucide-react'", ''],
  ["import cva from 'class-variance-authority'", ''],
  // Le même fichier désigné par un chemin relatif. Un motif en `@/server/*`
  // seul ne couvrait que l'alias et laissait passer celui-ci (Copilot).
  ["import { db } from '../server/db'", "l'alias contourné d'un cran"],
  ["import { p } from '../../server/steps/proxy'", 'et de deux'],
  ["import { B } from '../../components/ui/button'", ''],
  // Chemins non normalisés : les deux désignent `src/server/db`, mais l'un
  // commence par `@/core/` et l'autre par `./`, donc aucun des motifs de couche
  // ne les voyait (Copilot).
  ["import { db } from '@/core/../server/db'", 'la traversée cachée sous un préfixe permis'],
  ["import { db } from './../server/db'", 'et sous un `./` de façade'],
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
    // Les portes dérobées : `no-restricted-globals` ne contrôle que
    // l'identifiant nu, donc `globalThis.fetch` passait la liste entière.
    ['globalThis.fetch', "export const f = () => globalThis.fetch('https://exemple.fr')"],
    ['globalThis.process', 'export const f = () => globalThis.process.env.FFMPEG_BIN'],
  ])('refuse le global %s', async (_nom, code) => {
    const rules = await erreurs(`${code}\n`, 'src/core/sonde.ts')
    expect(rules).toContain('no-restricted-globals')
  })

  // La frontière est déclarée par une liste d'extensions. `tsconfig.json`
  // inclut les `.mts` et le dépôt en utilise un : un `src/core/x.mts` échappait
  // entièrement aux règles (Copilot).
  it.each(['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs'])(
    "s'applique aussi aux fichiers .%s",
    async (ext) => {
      const rules = await erreurs(
        "import fs from 'node:fs'\nexport const x = fs\n",
        `src/core/sonde.${ext}`,
      )
      expect(rules).toContain('no-restricted-imports')
    },
  )

  // Les contrôles négatifs. Une frontière qui interdit tout passerait chacun
  // des tests ci-dessus tout en rendant le projet inécrivable : sans ce qui
  // suit, ils ne prouvent rien.
  it('laisse passer du TypeScript pur', async () => {
    const rules = await erreursDePureté(
      'export const somme = (a: number, b: number): number => a + b\n',
      'src/core/sonde.ts',
    )
    expect(rules).toEqual([])
  })

  // `captions/retime.ts` aura besoin de `../edl` : un `..` n'est pas en soi une
  // sortie de `src/core`.
  it('laisse passer ce qui reste à l’intérieur de src/core', async () => {
    const rules = await erreursDePureté(
      ["import { normalizeSegments } from '../edl'", 'export const x = normalizeSegments'].join(
        '\n',
      ),
      'src/core/captions/retime.ts',
    )
    expect(rules).toEqual([])
  })

  // `../../edl` contient bien la sous-chaîne `/../`, mais tous ses `..` sont en
  // tête : c'est un chemin normalisé, et depuis `src/core/a/b/` il reste dans
  // `src/core`. Le motif anti-traversée ne doit pas s'y tromper.
  it('laisse passer une remontée profonde mais normalisée', async () => {
    const rules = await erreursDePureté(
      "import { clipDuration } from '../../edl'\nexport const x = clipDuration\n",
      'src/core/captions/ass/rendu.ts',
    )
    expect(rules).toEqual([])
  })

  it('laisse passer @/core, le seul alias qui reste accessible', async () => {
    const rules = await erreursDePureté(
      "import { clipDuration } from '@/core/edl'\nexport const x = clipDuration\n",
      'src/core/captions/retime.ts',
    )
    expect(rules).toEqual([])
  })

  // La seule dépendance que la liste blanche laisse entrer, et ses sous-chemins.
  // Un `lib` dans le chemin d'un paquet n'est pas notre `src/lib`.
  it.each(["import { z } from 'zod'", "import { z } from 'zod/v4'"])(
    'laisse passer %s, la seule dépendance autorisée',
    async (ligne) => {
      const rules = await erreursDePureté(`${ligne}\nexport const x = z\n`, 'src/core/sonde.ts')
      expect(rules).toEqual([])
    },
  )

  // Le plus important des quatre : sans lui, une règle appliquée au dépôt entier
  // passerait tous les tests ci-dessus tout en rendant `src/server/` inécrivable.
  it("n'entrave pas src/server, dont c'est précisément le métier", async () => {
    const rules = await erreursDePureté(
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
