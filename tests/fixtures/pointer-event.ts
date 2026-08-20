/**
 * Le repli `PointerEvent` que réclame une `Checkbox` de Base UI sous `jsdom`.
 *
 * **Pourquoi il faut le poser.** La case distingue la souris du tactile en
 * dispatchant elle-même un `PointerEvent` synthétique à la validation
 * (`dispatchClickWithModifiers`), et `jsdom` n'a pas ce constructeur. Sans ce
 * repli, tout clic sur une case lève `PointerEvent is not a constructor` — une
 * erreur qui ne dit rien de la case, et qu'on cherche dans le composant avant de
 * la trouver dans l'environnement.
 *
 * **Pourquoi il vit ici plutôt que recopié.** Il est né en tête de
 * `publish-dialog.test.tsx`, avec un commentaire qui justifiait sa place :
 * « aucun autre test du dépôt ne clique une `Checkbox` ». C'était vrai, ça a
 * cessé de l'être au deuxième fichier, et le troisième aurait fait trois copies
 * de la même dizaine de lignes — le motif que `CLAUDE.md` nomme *un correctif
 * compris comme local revient au champ suivant*.
 *
 * **Pourquoi ce n'est toujours pas une configuration globale.** Le raisonnement
 * d'origine tient, lui : `vitest.config.mts` monte `node` par défaut et laisse
 * chaque fichier demander son DOM, précisément pour que la trentaine de fichiers
 * de calcul pur ne paient rien. Un appel explicite en tête des fichiers qui
 * cliquent une case garde ce partage, et dit sur place pourquoi il est là.
 */
export function installPointerEventPolyfill(): void {
  if (typeof window === 'undefined' || typeof window.PointerEvent !== 'undefined') return
  class PointerEventPolyfill extends MouseEvent {}
  // @ts-expect-error -- un repli minimal, pas la classe complète du DOM.
  window.PointerEvent = PointerEventPolyfill
}
