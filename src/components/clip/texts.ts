/**
 * Les textes de publication et les noms de sortie, **côté navigateur**.
 *
 * Le panneau d'export propose de copier le contenu du `.txt` plutôt que son
 * chemin : le fichier est sur le disque du serveur, et ce qu'il faut au moment
 * de publier est le presse-papiers (spec §3.4). Il annonce aussi, avant le
 * rendu, les fichiers qui seront produits — un ou deux MP4 selon le ratio, ce
 * qui est la seule conséquence du choix de ratio qui ne se voyait nulle part.
 *
 * **`wordsHash` et `publicationText` sont un re-export depuis le 23 août
 * 2026.** Elles vivaient ici en copie de `src/server/steps/render.ts`, faute
 * de pouvoir descendre dans `src/core/`, gelé jusqu'à cette PR-ci ; la
 * publication par plateforme (`platformTexts`) en a maintenant besoin des deux
 * côtés, et `src/core/publication.ts` est leur unique foyer. Le re-export
 * reste ici pour ne pas toucher `export-panel.tsx`, tenu par la PR #142 en
 * cours de revue.
 */

import type { Ratio } from '@/core/edl'
export { wordsHash, publicationText } from '@/core/publication'
import { RENDER_NATIVE } from '@/core/render-flags'

/** Ce que l'export produira, sous les noms qu'il leur donnera. */
export type OutputNames = {
  /**
   * `null` quand `RENDER_NATIVE` est désactivé (`@/core/render-flags`) ET
   * qu'une variante 9:16 existe pour le remplacer. Reste dû sur un clip déjà
   * en 9:16 — c'est alors l'unique livrable.
   */
  mp4: string | null
  /**
   * `null` quand le ratio **natif** résolu est déjà 9:16 : la variante à fond
   * flouté serait le même cadre réencodé une seconde fois. Elle n'existera
   * jamais, et son absence n'est pas une anomalie.
   */
  variant9x16: string | null
  texts: string
}

/**
 * Les noms des fichiers que l'export écrira pour ce clip.
 *
 * **Le ratio attendu est le ratio natif résolu**, celui que le serveur publie
 * dans `framing.ratio` — le plus large que les plans demandent —, jamais
 * `clip.ratio` : un clip en `auto` n'en a pas à lui.
 *
 * `renderNative` défaut à `RENDER_NATIVE`, comme `pathsRender` s'y règle côté
 * serveur — les deux doivent rester d'accord, faute de quoi ce panneau
 * annoncerait un fichier que l'export ne produira jamais, ou l'inverse.
 */
export function outputNames(
  clipId: string,
  ratioNative: Ratio,
  renderNative = RENDER_NATIVE,
): OutputNames {
  return {
    mp4: renderNative || ratioNative === '9:16' ? `${clipId}.mp4` : null,
    variant9x16: ratioNative === '9:16' ? null : `${clipId}-9x16.mp4`,
    texts: `${clipId}.txt`,
  }
}
