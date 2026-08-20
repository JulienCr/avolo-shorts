// @vitest-environment jsdom

/**
 * `IngestionSection` : copier ou non le replay dans `stage/` avant de
 * l'exploiter.
 *
 * **Ce qu'une case à cocher rate le plus souvent**, et que ces tests tiennent :
 * partir décochée alors que le serveur dit l'inverse, ne pas dire ce que
 * l'autre état coûte, et rester dans sa nouvelle position quand le serveur
 * vient de refuser l'écriture.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { IngestionSection } from '@/components/settings/ingestion-section'
import type { IngestionSettings } from '@/lib/api'
import { installPointerEventPolyfill } from '../../fixtures/pointer-event'

// La `Checkbox` de Base UI dispatche son propre `PointerEvent`, que `jsdom`
// n'a pas. Voir le repli pour le raisonnement complet.
installPointerEventPolyfill()

afterEach(() => {
  cleanup()
})

const ON: IngestionSettings = { copySourceLocally: true }
const OFF: IngestionSettings = { copySourceLocally: false }

/**
 * `getByRole` et non `getByLabelText` : la case de `@base-ui` rend un `span`
 * porteur du rôle **et** un `input` caché, et l'étiquette les désigne tous les
 * deux. C'est le rôle qui départage — c'est aussi ce que fait
 * `publish-dialog.test.tsx`.
 */
const box = () => screen.getByRole('checkbox', { name: /Copier la source en local/ })

it('part cochée quand le serveur dit qu’on copie', () => {
  render(<IngestionSection values={ON} onChange={() => {}} />)
  expect(box().getAttribute('data-checked')).not.toBeNull()
})

it('part décochée quand le serveur dit qu’on ne copie pas', () => {
  // **Le serveur fait autorité, pas la constante du composant.** Afficher le
  // défaut du code là où la base porte autre chose ferait croire qu'on copie
  // alors qu'on ne copie pas — et le premier export partirait sur le Drive sans
  // que personne s'y attende.
  render(<IngestionSection values={OFF} onChange={() => {}} />)
  expect(box().getAttribute('data-checked')).toBeNull()
})

it('n’envoie que le champ touché, et seulement quand il change', async () => {
  const onChange = vi.fn()
  render(<IngestionSection values={ON} onChange={onChange} />)

  fireEvent.click(box())
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ copySourceLocally: false })
})

/**
 * **Un libellé seul ne suffit pas ici.** Lequel des deux états est le rapide
 * dépend de l'endroit où vit le fichier : sur le Drive en 9p, copier fait
 * gagner ; sur un disque local, copier ne fait que dupliquer. Personne ne peut
 * deviner la réponse à notre place, donc la case doit dire les deux faces.
 */
it('dit ce que chacun des deux états coûte', () => {
  render(<IngestionSection values={ON} onChange={() => {}} />)
  const help = document.getElementById(box().getAttribute('aria-describedby')!)
  expect(help?.textContent).toMatch(/Coché/)
  expect(help?.textContent).toMatch(/Décoché/)
  // Et la question que ce réglage soulève tout de suite : ce qui arrive à une
  // copie déjà là.
  expect(help?.textContent).toMatch(/décocher n’efface rien/i)
})

/**
 * **L'écriture n'est pas optimiste, donc la case doit se recaler elle-même.**
 * Un `PUT` en 400 ne touche pas au cache : `values` ne bouge pas, et une case
 * qui n'écouterait que sa propre humeur resterait dans la position que le
 * serveur vient de rejeter, sous un bandeau qui déclare qu'elle n'est pas
 * enregistrée.
 */
it('revient à l’état du serveur quand l’écriture est refusée', async () => {
  const onChange = vi.fn().mockRejectedValue(new Error('refusé'))
  render(<IngestionSection values={ON} onChange={onChange} />)

  fireEvent.click(box())
  await waitFor(() => expect(box().getAttribute('data-checked')).not.toBeNull())
})

/**
 * Le rejet est consommé par la case, pas relevé : le bandeau de l'écran le
 * porte déjà, et un rejet non géré coupe le processus en développement.
 */
it('ne laisse pas un refus partir en rejet nu', async () => {
  const rejections: unknown[] = []
  const onRejection = (e: PromiseRejectionEvent) => {
    e.preventDefault()
    rejections.push(e.reason)
  }
  window.addEventListener('unhandledrejection', onRejection)
  try {
    render(
      <IngestionSection values={ON} onChange={() => Promise.reject(new Error('refusé'))} />,
    )
    fireEvent.click(box())
    await new Promise((r) => setTimeout(r, 0))
    expect(rejections).toEqual([])
  } finally {
    window.removeEventListener('unhandledrejection', onRejection)
  }
})

/**
 * Le retour au défaut ne s'affiche que s'il y a quelque chose à défaire — un
 * bouton toujours présent et sans effet apprend à ne plus le lire.
 */
it('ne propose de revenir au défaut que si on s’en est écarté', async () => {
  const onChange = vi.fn()
  const { rerender } = render(<IngestionSection values={ON} onChange={onChange} />)
  expect(screen.queryByRole('button', { name: /Revenir au défaut/ })).toBeNull()

  rerender(<IngestionSection values={OFF} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: /Revenir au défaut/ }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ copySourceLocally: true })
})

it('se laisse désactiver le temps d’une écriture en vol', () => {
  render(<IngestionSection values={ON} onChange={() => {}} disabled />)
  expect(box().getAttribute('data-disabled')).toBe('')
})
