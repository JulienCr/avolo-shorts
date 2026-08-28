import { describe, expect, it } from 'vitest'

import { readClipView, writeClipView } from '@/components/clip/clip-view'

describe('readClipView', () => {
  it('rend « edition » quand rien n’est demandé', () => {
    expect(readClipView('')).toBe('edition')
  })

  it('lit la vue demandée', () => {
    expect(readClipView('?vue=exports')).toBe('exports')
  })

  it('retombe sur « edition » devant une valeur inconnue', () => {
    expect(readClipView('?vue=montage')).toBe('edition')
  })

  it('accepte un URLSearchParams', () => {
    expect(readClipView(new URLSearchParams('vue=exports'))).toBe('exports')
  })
})

describe('writeClipView', () => {
  it('retire le paramètre pour la vue par défaut', () => {
    expect(writeClipView('?vue=exports&q=a', 'edition')).toBe('?q=a')
  })

  it('rend une chaîne vide quand il ne reste rien', () => {
    expect(writeClipView('?vue=exports', 'edition')).toBe('')
  })

  it('préserve les autres paramètres', () => {
    expect(writeClipView('?q=a', 'exports')).toBe('?q=a&vue=exports')
  })
})
