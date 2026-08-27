// @vitest-environment jsdom

/**
 * `AiSection` : le fournisseur et le modèle des trois usages, plus l'adresse
 * Ollama — retour d'usage §6.1.
 *
 * **Les trois usages ont désormais un appelant** : le repérage agissait
 * déjà, le hook a `POST /api/clips/:id/hook`, et la correction du transcript
 * a `POST /api/projects/:id/transcript/correction` — la dernière case qui
 * portait encore le bandeau « pas encore câblé ». Aucun des trois n'en a
 * plus, et ce test le vérifie.
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

it('affiche les trois usages, aucun avec le bandeau « pas encore câblé »', () => {
  render(
    <AiSection values={VALUES} availability={AVAILABLE} onChange={() => {}} />,
  )

  expect(screen.getByText('Repérage')).toBeTruthy()
  expect(screen.getByText('Correction du transcript')).toBeTruthy()
  expect(screen.getByText('Hook')).toBeTruthy()

  // Aucun bandeau « pas encore câblé » : les trois usages ont un appelant.
  expect(screen.queryAllByText(/rien ne le lit/)).toHaveLength(0)
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

it('propose de revenir au fournisseur par défaut, et remet le modèle avec lui', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(
    <AiSection
      values={{ ...VALUES, correctionProvider: 'openai', correctionModel: 'gpt-4.1-mini' }}
      availability={AVAILABLE}
      onChange={onChange}
    />,
  )

  const button = screen.getByText(/Revenir à Gemini/)
  await user.click(button)
  // **Atomique** : sinon le modèle OpenAI reste en place avec Gemini réglé,
  // une combinaison vouée au 404 dès le prochain repérage. (relevé par Copilot)
  expect(onChange).toHaveBeenCalledWith({
    correctionProvider: 'gemini',
    correctionModel: 'gemini-3.1-flash-lite',
  })
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

it('le défaut du champ modèle suit le fournisseur courant, pas toujours Gemini', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(
    <AiSection
      values={{ ...VALUES, hookProvider: 'openai', hookModel: 'gemini-3.1-flash-lite' }}
      availability={AVAILABLE}
      onChange={onChange}
    />,
  )

  // **Le modèle indicatif d'OpenAI, pas celui de Gemini** : sinon « revenir
  // au défaut » remplace un modèle par un autre qui 404 chez ce fournisseur.
  // (relevé par Copilot)
  const button = screen.getByText('Revenir à gpt-4.1-mini')
  await user.click(button)
  expect(onChange).toHaveBeenCalledWith({ hookModel: 'gpt-4.1-mini' })
})

/**
 * #88 : `foo` était accepté à l'écran et n'échouait qu'au premier `fetch`,
 * loin de l'écran où il avait été tapé. Le refus vient du serveur
 * (`InvalidSettingError`, `db.ts`) ; ce champ suit **le même mécanisme que
 * les autres** — `onChange` rejette, le brouillon revient à ce qui est
 * enregistré — plutôt que d'inventer une validation côté client.
 */
it('revient à l’adresse enregistrée quand le serveur refuse l’adresse saisie', async () => {
  const onChange = vi.fn().mockRejectedValue(
    new Error('Réglage ai.ollamaBaseUrl : une URL absolue http:// ou https:// est attendue, reçu "foo".'),
  )
  const user = userEvent.setup()
  render(<AiSection values={VALUES} availability={AVAILABLE} onChange={onChange} />)

  const input = screen.getByLabelText('Adresse du serveur Ollama')
  await user.type(input, 'foo')
  await user.tab()

  await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ollamaBaseUrl: 'foo' }))
  await waitFor(() => expect(input).toHaveProperty('value', ''))
})
