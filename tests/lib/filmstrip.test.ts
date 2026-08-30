import { describe, expect, it } from 'vitest'

import {
  FILMSTRIP_COUNT_DEFAULT,
  FILMSTRIP_COUNT_MAX,
  FILMSTRIP_COUNT_MIN,
  filmstripCountForBox,
  parseFilmstripCount,
} from '@/lib/filmstrip'

describe('filmstripCountForBox', () => {
  it('choisit le compte qui couvre la boîte à 16:9, sans l’étirer', () => {
    // À 48 px de haut, une vignette 16:9 fait 85,33 px : 1285 px en veut 15.
    expect(filmstripCountForBox(1285, 48)).toBe(15)
    expect(filmstripCountForBox(1920, 48)).toBe(23)
  })

  it('borne au minimum sur une bande étroite', () => {
    expect(filmstripCountForBox(100, 48)).toBe(FILMSTRIP_COUNT_MIN)
  })

  it('borne au maximum sur une bande très large', () => {
    expect(filmstripCountForBox(10_000, 48)).toBe(FILMSTRIP_COUNT_MAX)
  })

  it('rend le défaut sur une boîte pas encore mesurée', () => {
    expect(filmstripCountForBox(0, 0)).toBe(FILMSTRIP_COUNT_DEFAULT)
    expect(filmstripCountForBox(-10, 48)).toBe(FILMSTRIP_COUNT_DEFAULT)
  })
})

describe('parseFilmstripCount', () => {
  it('rend le défaut sans paramètre, ou sur une valeur non entière', () => {
    expect(parseFilmstripCount(null)).toBe(FILMSTRIP_COUNT_DEFAULT)
    expect(parseFilmstripCount('')).toBe(FILMSTRIP_COUNT_DEFAULT)
    expect(parseFilmstripCount('12.5')).toBe(FILMSTRIP_COUNT_DEFAULT)
    expect(parseFilmstripCount('douze')).toBe(FILMSTRIP_COUNT_DEFAULT)
  })

  it('borne un entier hors intervalle plutôt que de le refuser', () => {
    // Un compte non borné serait un tuilage ffmpeg dimensionné par
    // l'appelant — servir la planche au pire rapport reste préférable à ne
    // rien servir du tout.
    expect(parseFilmstripCount('100000')).toBe(FILMSTRIP_COUNT_MAX)
    expect(parseFilmstripCount('-5')).toBe(FILMSTRIP_COUNT_MIN)
  })

  it('accepte un entier valide tel quel', () => {
    expect(parseFilmstripCount('20')).toBe(20)
  })
})
