import localFont from 'next/font/local'

/**
 * Anton, servie au navigateur pour le calque de preview du hook.
 *
 * **`fonts/Anton-Regular.ttf`, le même fichier que ffmpeg incruste**
 * (`src/core/captions/ass.ts`, `src/server/steps/render.ts`) — jamais une
 * copie. `next/font/local` l'empreinte et le sert depuis ce fichier unique ;
 * la PR qui rend le hook en prend le condensat dans l'empreinte de rendu, et
 * une seconde copie sous `public/` en serait une seconde source qui pourrait
 * diverger de celle que ffmpeg lit.
 *
 * `.className` porte directement la déclaration `font-family` : appliqué au
 * calque, il évite de devoir déclarer une variable CSS sur un ancêtre que ce
 * fichier ne possède pas (`src/app/layout.tsx`, hors du périmètre de cette PR).
 */
export const hookFont = localFont({ src: '../../../fonts/Anton-Regular.ttf' })
