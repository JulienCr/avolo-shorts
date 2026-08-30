import { useEffect, useRef } from 'react'

/**
 * Committe un brouillon non validé au démontage — Échap ferme une modale de
 * champs sans déclencher `onBlur`. Un drapeau « sale », jamais une comparaison
 * à `value` : au blur juste avant Échap, la prop `value` n'a pas encore le
 * retour serveur, et comparer dessus renverrait un second `PATCH` identique.
 * (issue #282)
 */
export function useCommitOnUnmount(dirty: boolean, commit: () => void) {
  const dirtyRef = useRef(dirty)
  const commitRef = useRef(commit)
  useEffect(() => {
    dirtyRef.current = dirty
    commitRef.current = commit
  })

  useEffect(
    () => () => {
      if (dirtyRef.current) commitRef.current()
    },
    [],
  )
}
