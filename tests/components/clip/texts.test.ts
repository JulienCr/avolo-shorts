/**
 * Les textes de publication, vus du navigateur.
 *
 * Le panneau d'export propose de **copier** ce que l'export écrit dans le
 * `.txt`. Les deux doivent dire exactement la même chose, sans quoi Julien colle
 * dans Instagram autre chose que ce qu'il a sur le disque — et rien ne le lui
 * dirait. `publicationText` vit dans `src/server/steps/render.ts`, qui ouvre
 * des fichiers et une base : il ne peut pas entrer dans un composant client.
 *
 * Ces tests sont donc le seul lien entre les deux copies. Ils comparent le
 * résultat des deux fonctions sur les cas qui les séparent : titre vide,
 * description vide, mots-dièse en doublon, casse.
 */

import path from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Clip, Ratio } from '@/core/edl'
import { wordsHash, outputNames, publicationText } from '@/components/clip/texts'
import {
  pathsRender,
  publicationText as serverText,
} from '@/server/steps/render'

function clip(fields: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    projectId: 'p1',
    segments: [{ start: 0, end: 20 }],
    ratio: '1:1',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'La chute',
    description: 'Une impro qui part en vrille #impro #avolo',
    status: 'kept',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    ...fields,
  }
}

describe('publicationText', () => {
  it.each([
    ['un clip complet', clip()],
    ['un titre vide', clip({ title: '' })],
    ['une description vide', clip({ description: '' })],
    ['des espaces autour des textes', clip({ title: '  La chute  ', description: ' \n' })],
    ['aucun mot-dièse', clip({ description: 'Rien à signaler' })],
    ['des mots-dièse en doublon', clip({ description: '#Impro #impro #IMPRO #avolo' })],
    ['un mot-dièse dans le titre', clip({ title: 'La chute #avolo', description: '#avolo' })],
    ['des chiffres et des accents', clip({ description: '#saison2 #théâtre #impro_2026' })],
  ])('dit mot pour mot ce que le `.txt` porte — %s', (_scenarios, value) => {
    expect(publicationText(value)).toBe(serverText(value))
  })
})

describe('wordsHash', () => {
  it('garde la première graphie et écarte les doublons de casse', () => {
    expect(wordsHash('#Impro et #impro, puis #Avolo')).toEqual(['#Impro', '#Avolo'])
  })
})

describe('outputNames', () => {
  // **Les deux côtés de la copie doivent lire le même `renderNative`.**
  // `pathsRender` défaut à `true` (fonction pure, neutre par défaut) et
  // `outputNames` à `RENDER_NATIVE` (le réglage réel de l'application) : sans
  // le passer explicitement aux deux, ce test comparerait deux calculs sous
  // deux réglages différents, et une vraie divergence entre les deux copies
  // se cacherait derrière ce décalage plutôt que d'échouer.
  it.each<[Ratio, boolean]>([
    ['9:16', true],
    ['4:5', true],
    ['1:1', true],
    ['16:9', true],
    ['9:16', false],
    ['4:5', false],
    ['1:1', false],
    ['16:9', false],
  ])('nomme les fichiers comme l’export les écrit — %s, natif actif : %s', (ratio, renderNative) => {
    const paths = pathsRender('p1', 'c1', ratio, renderNative)
    expect(outputNames('c1', ratio, renderNative)).toEqual({
      mp4: paths.mp4 === null ? null : path.basename(paths.mp4),
      variant9x16:
        paths.variant9x16 === null ? null : path.basename(paths.variant9x16),
      texts: path.basename(paths.texts),
    })
  })

  it('n’annonce pas de variante quand le ratio est déjà 9:16', () => {
    // Ce n'est pas une sortie manquante : elle n'existera jamais, et le panneau
    // doit le dire ainsi plutôt que de montrer une case vide.
    expect(outputNames('c1', '9:16').variant9x16).toBeNull()
  })
})
