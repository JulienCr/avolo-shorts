// Extension `.mts` et non `.ts` : sans `"type": "module"` dans le `package.json`
// — que Next n'apprécierait pas — un `vitest.config.ts` est chargé comme du
// CommonJS, et Vite avertit à chaque exécution que la syntaxe ESM qu'il contient
// cessera d'être acceptée. Le `.mts` lève l'ambiguïté sans toucher au reste.
import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // `node`, pas `jsdom` : ce qui est testé ici est du calcul pur — durées,
    // découpes, argv ffmpeg. Rien n'a besoin d'un DOM, et le démarrage est
    // d'autant plus rapide en CI.
    environment: 'node',
  },
  // Le même alias que `tsconfig.json`. Sans lui, `@/core/edl` ne se résout pas
  // sous Vitest alors qu'il se résout sous `tsc` et sous Next.
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
})
