/**
 * Un remplaçant de `next/font/local` sous Vitest.
 *
 * `next/font/local` n'est pas une fonction exécutable en dehors du pipeline de
 * build de Next — c'est une transformation statique (SWC/webpack) qui repère
 * l'appel dans le code source et le réécrit. Appelée telle quelle sous Node,
 * elle lève. `hook-font.ts` (`@/components/clip/hook-overlay`) l'appelle au
 * chargement du module, donc tout test qui importe transitivement le calque
 * du hook — `hook-overlay.tsx`, `output-preview.tsx`, `clip-screen.tsx` — en
 * a besoin, pas seulement les tests qui portent sur le hook.
 *
 * `vitest.config.mts` résout `next/font/local` vers ce fichier.
 *
 * **`style.fontFamily` est aussi un stub, pas un nom lisible par un
 * navigateur de test.** `use-text-measure.ts` le lit pour ne jamais mesurer
 * sur le littéral `'Anton'` : jsdom n'ayant pas de moteur de police, la
 * valeur exacte est sans conséquence sur ce que ces tests vérifient.
 */
export default function localFont(): { className: string; style: { fontFamily: string } } {
  return { className: 'font-hook-test-stub', style: { fontFamily: 'AntonTestStub' } }
}
