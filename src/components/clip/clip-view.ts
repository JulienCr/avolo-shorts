/** Les deux vues de l'écran de clip. `edition` est le défaut, donc absent de l'URL. */
export type ClipView = 'edition' | 'exports'

const VIEWS: readonly ClipView[] = ['edition', 'exports']
const PARAM = 'vue'

/**
 * La vue demandée par l'URL.
 *
 * @param search la chaîne de requête, avec ou sans `?`, ou un `URLSearchParams`
 * @returns la vue lue, ou `edition` devant une valeur inconnue
 */
export function readClipView(search: string | URLSearchParams): ClipView {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const asked = params.get(PARAM)
  return VIEWS.includes(asked as ClipView) ? (asked as ClipView) : 'edition'
}

/**
 * La chaîne de requête portant la vue, les autres paramètres conservés.
 *
 * @returns une chaîne préfixée de `?`, ou vide quand il ne reste aucun paramètre
 */
export function writeClipView(search: string, view: ClipView): string {
  const params = new URLSearchParams(search)
  if (view === 'edition') params.delete(PARAM)
  else params.set(PARAM, view)
  const rendered = params.toString()
  return rendered === '' ? '' : `?${rendered}`
}
