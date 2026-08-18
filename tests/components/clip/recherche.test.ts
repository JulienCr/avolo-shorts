/**
 * La recherche dans le transcript.
 *
 * `Ctrl+F` remplace celui du navigateur, que la virtualisation neutralise : une
 * émission fait vingt mille mots et la surface n'en rend qu'une trentaine à la
 * fois. Sans cette recherche-ci, il n'y en a aucune.
 */

import { describe, expect, it } from 'vitest'

import { chercher, normaliser } from '@/components/clip/recherche'

const mots = 'le théâtre brûle ce soir le Théâtre'.split(' ').map((word) => ({ word }))

describe('normaliser', () => {
  it('ignore la casse et les accents', () => {
    // On tape « theatre » sans accent quand on cherche vite.
    expect(normaliser('Théâtre')).toBe('theatre')
  })
})

describe('chercher', () => {
  it('trouve un mot que le transcript entoure d’espaces', () => {
    // `lireTranscript` transmet les mots de WhisperX tels quels. Le décalage
    // était noté avant d'ajouter la forme brute : l'occurrence commençait donc
    // un caractère plus loin que le mot, et se faisait écarter.
    // (relevé par Copilot)
    expect(chercher([{ word: 'le' }, { word: ' salut ' }], 'salut')).toEqual([1])
  })

  it('ignore un mot qui n’est que du blanc', () => {
    expect(chercher([{ word: '  ' }, { word: 'salut' }], 'salut')).toEqual([1])
  })

  it('rend l’index de chaque mot qui commence une occurrence', () => {
    expect(chercher(mots, 'theatre')).toEqual([1, 6])
  })

  it('trouve une suite de mots', () => {
    // La ponctuation et les espaces sont ceux du transcript : la requête
    // s'apparie sur le texte tel qu'il se lit.
    expect(chercher(mots, 'brûle ce soir')).toEqual([2])
  })

  it('ne rend rien sur une requête vide', () => {
    expect(chercher(mots, '   ')).toEqual([])
  })

  it('ne rend rien quand le texte ne contient pas la requête', () => {
    expect(chercher(mots, 'incendie')).toEqual([])
  })

  it('n’apparie pas au milieu d’un mot', () => {
    // Sinon « le » renvoie « brûle », et la navigation saute sur des mots que
    // personne ne cherchait.
    expect(chercher(mots, 'le')).toEqual([0, 5])
  })
})
