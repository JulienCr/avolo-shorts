/**
 * Les textes de publication, vus du navigateur.
 *
 * Le panneau d'export propose de **copier** ce que l'export écrit dans le
 * `.txt`. Les deux doivent dire exactement la même chose, sans quoi Julien colle
 * dans Instagram autre chose que ce qu'il a sur le disque — et rien ne le lui
 * dirait. `texteDePublication` vit dans `src/server/steps/render.ts`, qui ouvre
 * des fichiers et une base : il ne peut pas entrer dans un composant client.
 *
 * Ces tests sont donc le seul lien entre les deux copies. Ils comparent le
 * résultat des deux fonctions sur les cas qui les séparent : titre vide,
 * description vide, mots-dièse en doublon, casse.
 */

import path from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Clip, Ratio } from '@/core/edl'
import { motsDièse, nomsDeSortie, texteDePublication } from '@/components/clip/textes'
import {
  cheminsRendu,
  texteDePublication as texteDuServeur,
} from '@/server/steps/render'

function clip(champs: Partial<Clip> = {}): Clip {
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
    ...champs,
  }
}

describe('texteDePublication', () => {
  it.each([
    ['un clip complet', clip()],
    ['un titre vide', clip({ title: '' })],
    ['une description vide', clip({ description: '' })],
    ['des espaces autour des textes', clip({ title: '  La chute  ', description: ' \n' })],
    ['aucun mot-dièse', clip({ description: 'Rien à signaler' })],
    ['des mots-dièse en doublon', clip({ description: '#Impro #impro #IMPRO #avolo' })],
    ['un mot-dièse dans le titre', clip({ title: 'La chute #avolo', description: '#avolo' })],
    ['des chiffres et des accents', clip({ description: '#saison2 #théâtre #impro_2026' })],
  ])('dit mot pour mot ce que le `.txt` porte — %s', (_cas, valeur) => {
    expect(texteDePublication(valeur)).toBe(texteDuServeur(valeur))
  })
})

describe('motsDièse', () => {
  it('garde la première graphie et écarte les doublons de casse', () => {
    expect(motsDièse('#Impro et #impro, puis #Avolo')).toEqual(['#Impro', '#Avolo'])
  })
})

describe('nomsDeSortie', () => {
  it.each<Ratio>(['9:16', '4:5', '1:1', '16:9'])(
    'nomme les fichiers comme l’export les écrit — %s',
    (ratio) => {
      const chemins = cheminsRendu('p1', 'c1', ratio)
      expect(nomsDeSortie('c1', ratio)).toEqual({
        mp4: path.basename(chemins.mp4),
        variant9x16:
          chemins.variant9x16 === null ? null : path.basename(chemins.variant9x16),
        texts: path.basename(chemins.texts),
      })
    },
  )

  it('n’annonce pas de variante quand le ratio est déjà 9:16', () => {
    // Ce n'est pas une sortie manquante : elle n'existera jamais, et le panneau
    // doit le dire ainsi plutôt que de montrer une case vide.
    expect(nomsDeSortie('c1', '9:16').variant9x16).toBeNull()
  })
})
