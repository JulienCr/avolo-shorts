/**
 * Un remplaçant de `next/font/local` sous Vitest — une transformation
 * statique du build Next, pas une fonction exécutable sous Node.
 * `hook-font.ts` l'appelle au chargement, donc tout test qui importe
 * transitivement le calque du hook en a besoin. `vitest.config.mts` résout
 * `next/font/local` vers ce fichier. `style.fontFamily` est un stub aussi :
 * `use-text-measure.ts` le lit pour ne jamais mesurer sur `'Anton'` en dur.
 */
export default function localFont(): { className: string; style: { fontFamily: string } } {
  return { className: 'font-hook-test-stub', style: { fontFamily: 'AntonTestStub' } }
}
