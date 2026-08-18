// Extension `.mts` et non `.ts` : sans `"type": "module"` dans le `package.json`
// — que Next n'apprécierait pas — un `vitest.config.ts` est chargé comme du
// CommonJS, et Vite avertit à chaque exécution que la syntaxe ESM qu'il contient
// cessera d'être acceptée. Le `.mts` lève l'ambiguïté sans toucher au reste.
import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Les trois extensions, pas seulement `.ts`. Les tests de composants et de
    // hooks sont des `.test.tsx` : avec un motif en `.test.ts` seul, ils
    // seraient ignorés **en silence**, ce qui est pire qu'un test absent — un
    // test absent se voit, une suite qui n'exécute pas un fichier annonce une
    // couverture qu'elle n'a pas.
    include: ['tests/**/*.test.{ts,mts,tsx}'],
    // `node`, pas `jsdom`, et **le DOM se demande par fichier** — une ligne
    // `// @vitest-environment jsdom` en tête de celui qui en a besoin.
    //
    // L'immense majorité de ce qui est testé ici est du calcul pur — durées,
    // découpes, argv ffmpeg, phases de projet — et n'a aucune raison de payer
    // le montage d'un DOM. Le poser globalement le ferait payer aux trente et
    // quelques fichiers qui s'en passent, à chaque exécution, y compris en CI.
    environment: 'node',
  },
  // Le même alias que `tsconfig.json`. Sans lui, `@/core/edl` ne se résout pas
  // sous Vitest alors qu'il se résout sous `tsc` et sous Next.
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
})
