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
 */
export default function localFont(): { className: string } {
  return { className: 'font-hook-test-stub' }
}
