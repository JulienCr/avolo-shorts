'use client'

import { useRouter, useSearchParams } from 'next/navigation'

/**
 * Un paramètre de l'URL du planning, lu et posé.
 *
 * **Les autres paramètres survivent** — même règle que `useTranscriptPanelUrl`
 * (`show/transcript-panel.tsx`) : un `URLSearchParams` reconstruit depuis
 * `useSearchParams().toString()` avant d'ajouter ou de retirer la clé. C'est
 * la raison d'être de ce module : l'onglet et l'aperçu s'écrasaient l'un
 * l'autre si chacun refaisait la manœuvre de son côté.
 */
export function usePlanningUrlParam(key: string): [string | null, (value: string | null) => void] {
  const router = useRouter()
  const searchParams = useSearchParams()

  function set(value: string | null) {
    const params = new URLSearchParams(searchParams.toString())
    if (value !== null) params.set(key, value)
    else params.delete(key)
    const query = params.toString()
    router.replace(`/planning${query === '' ? '' : `?${query}`}`, { scroll: false })
  }

  return [searchParams.get(key), set]
}
