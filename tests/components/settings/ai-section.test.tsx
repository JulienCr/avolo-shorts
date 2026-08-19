// @vitest-environment jsdom

/**
 * `AiSection` : le fournisseur et le modèle des trois usages, plus l'adresse
 * Ollama — retour d'usage §6.1.
 *
 * **Ce qui distingue cette section de `HookSection`, et que ces tests
 * tiennent** : `correction` et `hook` restent des champs **actifs** — ils
 * s'écrivent, contrairement au hook — mais portent un bandeau qui dit que
 * rien ne les lit encore. Le repérage, lui, n'a pas ce bandeau.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { AiSection } from '@/components/settings/ai-section'
import type { AiSettings, LlmAvailability } from '@/lib/api'

afterEach(() => {
  cleanup()
})

const VALUES: AiSettings = {
  selectionProvider: 'gemini',
  selectionModel: 'gemini-3.1-flash-lite',
  correctionProvider: 'gemini',
  correctionModel: 'gemini-3.1-flash-lite',
  hookProvider: 'gemini',
  hookModel: 'gemini-3.1-flash-lite',
  ollamaBaseUrl: '',
}

const AVAILABLE: LlmAvailability = {
  gemini: { available: true, reason: null },
  openai: { available: true, reason: null },
  ollama: { available: true, reason: null },
}

it('affiche les trois usages, un seul sans bandeau « pas encore câblé »', () => {
  render(
    <AiSection values={VALUES} availability={AVAILABLE} onChange={() => {}} />,
  )

  expect(screen.getByText('Repérage')).toBeTruthy()
  expect(screen.getByText('Correction du transcript')).toBeTruthy()
  expect(screen.getByText('Hook')).toBeTruthy()

  // Deux bandeaux « pas encore câblé », un seul par usage non branché.
  expect(screen.getAllByText(/rien ne le lit/)).toHaveLength(2)
})

it('affiche le modèle réglé de chaque usage, pas un nom technique', () => {
  render(
    <AiSection
      values={{ ...VALUES, correctionModel: 'gpt-4.1-mini' }}
      availability={AVAILABLE}
      onChange={() => {}}
    />,
  )
  const models = screen.getAllByDisplayValue('gemini-3.1-flash-lite')
  expect(models).toHaveLength(2) // repérage et hook
  expect(screen.getByDisplayValue('gpt-4.1-mini')).toBeTruthy()
})

it('signale un fournisseur sans clé, sans jamais afficher la clé elle-même', () => {
  const availability: LlmAvailability = {
    ...AVAILABLE,
    gemini: { available: false, reason: 'GEMINI_API_KEY n’est pas définie.' },
  }
  render(<AiSection values={VALUES} availability={availability} onChange={() => {}} />)

  // Trois usages sur Gemini par défaut : l'alerte apparaît trois fois.
  expect(screen.getAllByText(/n’a pas de clé configurée/)).toHaveLength(3)
  expect(screen.getAllByText(/GEMINI_API_KEY n’est pas définie/)).toHaveLength(3)
})

it('ne signale rien tant que la disponibilité n’a pas fini de se charger', () => {
  render(<AiSection values={VALUES} availability={undefined} onChange={() => {}} />)
  expect(screen.queryByText(/n’a pas de clé configurée/)).toBeNull()
})

it('écrit le modèle saisi en quittant le champ, jamais à la frappe', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(<AiSection values={VALUES} availability={AVAILABLE} onChange={onChange} />)

  const [selectionField] = screen.getAllByDisplayValue('gemini-3.1-flash-lite')
  await user.clear(selectionField)
  await user.type(selectionField, 'gemini-2.5-flash')
  expect(onChange).not.toHaveBeenCalled()

  await user.tab()
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({ selectionModel: 'gemini-2.5-flash' }),
  )
})

it('choisit un fournisseur sans toucher au modèle', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(<AiSection values={VALUES} availability={AVAILABLE} onChange={onChange} />)

  const [selectionTrigger] = screen.getAllByRole('combobox')
  await user.click(selectionTrigger)
  const options = await screen.findAllByRole('option', { name: 'OpenAI' })
  await user.click(options[0])

  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({ selectionProvider: 'openai' }),
  )
  expect(onChange).not.toHaveBeenCalledWith(
    expect.objectContaining({ selectionModel: expect.anything() }),
  )
})

it('résout la passerelle par défaut : vide, et sans bouton de retour au défaut', () => {
  render(<AiSection values={VALUES} availability={AVAILABLE} onChange={() => {}} />)
  expect(screen.getByLabelText('Adresse du serveur Ollama')).toHaveProperty('value', '')
  expect(screen.queryByText(/Revenir à la résolution automatique/)).toBeNull()
})

it('propose de revenir à la résolution automatique une fois une adresse réglée', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(
    <AiSection
      values={{ ...VALUES, ollamaBaseUrl: 'http://172.20.16.1:11434' }}
      availability={AVAILABLE}
      onChange={onChange}
    />,
  )
  const button = screen.getByText(/Revenir à la résolution automatique/)
  await user.click(button)
  expect(onChange).toHaveBeenCalledWith({ ollamaBaseUrl: '' })
})

it('affiche l’indice de modèle en toutes lettres, pas seulement en placeholder', () => {
  render(<AiSection values={VALUES} availability={AVAILABLE} onChange={() => {}} />)
  // Le champ n'est jamais vide : un texte visible est le seul moyen de voir
  // l'indice, un `placeholder` ne s'affiche jamais dessus.
  expect(screen.getAllByText(/Typique chez ce fournisseur/)).toHaveLength(3)
})

it('ne montre aucun bouton de retour au défaut quand tout est déjà au défaut', () => {
  render(<AiSection values={VALUES} availability={AVAILABLE} onChange={() => {}} />)
  expect(screen.queryByText(/Revenir à Gemini/)).toBeNull()
  expect(screen.queryByText(/Revenir à gemini-3\.1-flash-lite/)).toBeNull()
})

it('propose de revenir au fournisseur par défaut, et écrit le bon champ', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(
    <AiSection
      values={{ ...VALUES, correctionProvider: 'openai' }}
      availability={AVAILABLE}
      onChange={onChange}
    />,
  )

  const button = screen.getByText(/Revenir à Gemini/)
  await user.click(button)
  expect(onChange).toHaveBeenCalledWith({ correctionProvider: 'gemini' })
})

it('propose de revenir au modèle par défaut, et écrit le bon champ', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(
    <AiSection
      values={{ ...VALUES, hookModel: 'gemini-2.5-flash' }}
      availability={AVAILABLE}
      onChange={onChange}
    />,
  )

  const button = screen.getByText('Revenir à gemini-3.1-flash-lite')
  await user.click(button)
  expect(onChange).toHaveBeenCalledWith({ hookModel: 'gemini-3.1-flash-lite' })
})
