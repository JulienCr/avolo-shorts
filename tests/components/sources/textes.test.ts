/**
 * Les textes de la bibliothèque : une taille, une date, un compte, un message
 * d'erreur.
 *
 * Quatre fonctions minuscules, et chacune ferme un défaut qui ne se voit pas à
 * la relecture : un pluriel faux, une date qui change entre le serveur et le
 * navigateur, une trace d'exception lue à voix haute par une région
 * `role="alert"`.
 */

import { describe, expect, it } from 'vitest'

import { ApiError } from '@/lib/api'
import { formatDateSource, formatOctets, messageServeur, pluriel } from '@/components/sources/textes'

describe('formatOctets', () => {
  it('donne l’ordre de grandeur d’un replay, décimal comme le ROADMAP', () => {
    // Les tailles citées dans `ROADMAP.md` et `CLAUDE.md` — 4,3 Go, 12,7 Go —
    // sont des giga décimaux. Compter en 1024 afficherait « 4,0 Go » pour le
    // fichier que tout le dépôt appelle 4,3 Go.
    expect(formatOctets(4_300_000_000)).toBe('4,3 Go')
    expect(formatOctets(12_700_000_000)).toBe('12,7 Go')
    expect(formatOctets(982_000_000)).toBe('982 Mo')
  })

  it('n’affiche une décimale que là où elle renseigne', () => {
    // Trois chiffres significatifs suffisent : « 982,4 Mo » n'aide personne à
    // reconnaître un replay, et la colonne des tailles cesse de s'aligner.
    expect(formatOctets(1_000)).toBe('1 ko')
    expect(formatOctets(1_500_000)).toBe('1,5 Mo')
  })

  it('promeut la valeur qui arrondit à la borne du multiple suivant', () => {
    // L'arrondi vient **après** le choix du multiple : 999 999 999 octets
    // tombent sur Mo, puis s'arrondissent à 1000, et la carte annonçait
    // « 1000 Mo » — une unité que personne n'écrit, juste sous le seuil du Go.
    // (relevé par Copilot)
    expect(formatOctets(999_999_999)).toBe('1 Go')
    expect(formatOctets(999_999)).toBe('1 Mo')
    // Et la borne exacte, elle, n'a jamais eu de problème : la boucle la passe.
    expect(formatOctets(1_000_000_000)).toBe('1 Go')
  })

  it('compte les octets au singulier tant qu’il n’y en a qu’un', () => {
    expect(formatOctets(1)).toBe('1 octet')
    expect(formatOctets(999)).toBe('999 octets')
  })

  it('rend une taille nulle plutôt que de se casser', () => {
    // La même doctrine que `formatDuration` : une valeur absente ou aberrante
    // affiche zéro, elle ne produit pas « NaN Go ». Un fichier de 0 octet
    // existe réellement — un enregistrement qui vient de commencer.
    expect(formatOctets(0)).toBe('0 octet')
    expect(formatOctets(Number.NaN)).toBe('0 octet')
    expect(formatOctets(-1)).toBe('0 octet')
  })
})

describe('formatDateSource', () => {
  it('lit l’ISO du serveur dans le fuseau de l’émission, pas dans celui du lecteur', () => {
    // **C'est la source d'écart d'hydratation la plus courante en Next.** Le
    // rendu serveur prend le fuseau de `TZ`, le navigateur celui du système :
    // sans fuseau explicite, le même `modifiedAt` produit deux textes et React
    // remplace tout l'arbre. Le fuseau est donc fixé — l'émission est tournée à
    // Paris, et c'est l'heure sous laquelle Julien la reconnaît.
    expect(formatDateSource('2025-06-15T19:04:00.000Z')).toBe('15 juin 2025 à 21:04')
    // Le même instant, écrit avec un décalage : la lecture ne change pas.
    expect(formatDateSource('2025-06-15T21:04:00+02:00')).toBe('15 juin 2025 à 21:04')
  })

  it('le dit plutôt que d’afficher « Invalid Date »', () => {
    expect(formatDateSource('pas une date')).toBe('date inconnue')
    expect(formatDateSource('')).toBe('date inconnue')
  })
})

describe('pluriel', () => {
  it('garde le singulier à zéro, comme le veut le français', () => {
    expect(pluriel(0, 'replay', 'replays')).toBe('0 replay')
    expect(pluriel(1, 'replay', 'replays')).toBe('1 replay')
    expect(pluriel(2, 'replay', 'replays')).toBe('2 replays')
  })
})

describe('messageServeur', () => {
  it('reprend le message du serveur tel quel', () => {
    // Le 503 du Drive muet a son propre texte, écrit côté serveur et déjà épuré
    // de ses chemins absolus. Le réécrire ici en produirait une seconde version,
    // qui vieillirait séparément.
    const serveur = new ApiError(503, 'Le dossier des replays ne répond pas.')
    expect(messageServeur(serveur)).toBe('Le dossier des replays ne répond pas.')
  })

  it('ne laisse jamais une exception se lire à voix haute', () => {
    // La règle qui gouverne les messages d'erreur de cet écran : l'écran affiche
    // le message du serveur, il n'en compose jamais un depuis une exception. Une
    // coupure réseau lève un `TypeError` dont le message dépend du navigateur —
    // et une région `role="alert"` le lirait.
    expect(messageServeur(new TypeError('Failed to fetch'))).toBe(
      'Le serveur n’a pas répondu.',
    )
    expect(messageServeur('quelque chose')).toBe('Le serveur n’a pas répondu.')
  })
})
