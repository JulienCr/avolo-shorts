'use client'

import { EcranBibliotheque } from '@/components/sources/ecran-bibliotheque'

/**
 * La route `/`, réduite à ce qu'une route doit faire.
 *
 * Tout est dans `EcranBibliotheque`. La séparation vient d'ailleurs — `use(params)`
 * ne se résout pas sous jsdom, et les écrans de projet et de clip ont dû en
 * sortir pour être montables en test —, mais elle vaut d'être tenue partout : une
 * règle qui souffre une exception n'en est plus une, et l'extraction avait révélé
 * trois défauts au premier montage de l'écran de projet.
 */
export default function PageDeBibliotheque() {
  return <EcranBibliotheque />
}
