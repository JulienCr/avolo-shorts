'use client'

import { EcranParametres } from '@/components/parametres/ecran-parametres'

/**
 * La route `/parametres`, réduite à ce qu'une route doit faire.
 *
 * Tout est dans `EcranParametres`. Cette route n'a pas de `params` à résoudre,
 * donc pas de limite de Suspense à poser — mais la séparation reste, parce que
 * c'est elle qui rend l'écran montable en test : `use(params)` ne se résout pas
 * sous jsdom, et une règle qui souffre une exception n'en est plus une.
 */
export default function PageDeParametres() {
  return <EcranParametres />
}
