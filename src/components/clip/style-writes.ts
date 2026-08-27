import { useCallback, useEffect, useRef } from 'react'

/**
 * Le point commun à `framing-fields.tsx` et `hook-fields.tsx` (issue #189) :
 * `setStyle`/`resetField` rebâtissaient l'objet `*Style` depuis `clip.*Style`,
 * capturé par fermeture. Deux écritures sur deux champs, la seconde émise
 * avant que le cache n'ait absorbé la première `PATCH`, partaient donc toutes
 * les deux de la même valeur de départ : la seconde écrasait la première.
 *
 * `base` porte la valeur sur laquelle la **prochaine** écriture se fusionne,
 * et elle est mise à jour de façon synchrone à chaque écriture — donc dans le
 * même tick qu'une écriture sœur, pas seulement au prochain rendu. Elle se
 * resynchronise sur `style` dès que ce prop change réellement (nouvelle
 * réponse serveur, changement de clip), pour ne pas dériver du serveur.
 *
 * **Ne ferme pas le cas à deux onglets** (issue #122) : deux onglets sur le
 * même clip ont chacun leur propre `base`, et rien ici ne les réconcilie.
 */
export function useStyleWrites<S extends Record<string, unknown>>(
  style: S,
  writeStyle: (next: S) => Promise<unknown> | void,
) {
  const base = useRef(style)
  // Se resynchronise hors du rendu (une ref lue au rendu ne rejouerait pas le
  // composant) : sans effet, une réponse serveur qui change `style` ne
  // rattraperait jamais `base`, qui resterait bloquée sur la valeur du montage.
  useEffect(() => {
    base.current = style
  }, [style])

  const commit = useCallback(
    (next: S) => {
      base.current = next
      void Promise.resolve(writeStyle(next)).catch(() => {})
    },
    [writeStyle],
  )

  const setStyle = useCallback(
    <K extends keyof S>(field: K, value: S[K]) => {
      commit({ ...base.current, [field]: value })
    },
    [commit],
  )

  const resetField = useCallback(
    (field: keyof S) => {
      const rest = { ...base.current }
      delete rest[field]
      commit(rest)
    },
    [commit],
  )

  const resetAll = useCallback(() => commit({} as S), [commit])

  return { setStyle, resetField, resetAll }
}
