'use client'

import { SettingsScreen } from '@/components/settings/settings-screen'

/**
 * La route `/settings`, réduite à ce qu'une route doit faire.
 *
 * Tout est dans `SettingsScreen`. Cette route n'a pas de `params` à résoudre,
 * donc pas de limite de Suspense à poser — mais la séparation reste, parce que
 * c'est elle qui rend l'écran montable en test : `use(params)` ne se résout pas
 * sous jsdom, et une règle qui souffre une exception n'en est plus une.
 */
export default function SettingsPage() {
  return <SettingsScreen />
}
