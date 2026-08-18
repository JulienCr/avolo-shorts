/**
 * Les textes de publication et les noms de sortie, **côté navigateur**.
 *
 * Le panneau d'export propose de copier le contenu du `.txt` plutôt que son
 * chemin : le fichier est sur le disque du serveur, et ce qu'il faut au moment
 * de publier est le presse-papiers (spec §3.4). Il annonce aussi, avant le
 * rendu, les fichiers qui seront produits — un ou deux MP4 selon le ratio, ce
 * qui est la seule conséquence du choix de ratio qui ne se voyait nulle part.
 *
 * **C'est une copie de `src/server/steps/render.ts`, et elle est délibérée.**
 * `texteDePublication` et `cheminsRendu` y vivent au milieu de `node:fs`, de
 * `better-sqlite3` et de ffmpeg : rien de tout cela n'entre dans un composant
 * client. Les partager demanderait de les remonter dans `src/core/`, qui est
 * gelé pour cette PR — et le geste vaut d'être fait d'un coup pour les deux
 * fonctions plutôt qu'à moitié.
 *
 * Ce que la copie coûte est une divergence possible ; ce qui la referme est
 * `tests/components/textes.test.ts`, qui compare les deux sorties mot pour mot
 * sur les cas qui les séparent. Une divergence casse la suite, elle ne se
 * découvre pas devant un `.txt` collé de travers.
 */

import type { Ratio } from '@/core/edl'

/** Les mots-dièse d'un texte, dans l'ordre, sans doublon — la casse ne compte pas. */
export function motsDièse(texte: string): string[] {
  const vus = new Set<string>()
  const sortie: string[] = []
  for (const trouvé of texte.matchAll(/#[\p{L}\p{N}_]+/gu)) {
    const clé = trouvé[0].toLowerCase()
    if (vus.has(clé)) continue
    vus.add(clé)
    sortie.push(trouvé[0])
  }
  return sortie
}

/**
 * Le `.txt` qui accompagne le MP4 : titre, description, mots-dièse.
 *
 * Les mots-dièse ne sont pas retirés de la description, ils en sont extraits :
 * la description se colle telle quelle dans le formulaire d'Instagram, et la
 * section du bas n'existe que pour les reprendre ailleurs sans les retaper.
 */
export function texteDePublication(clip: { title: string; description: string }): string {
  const titre = clip.title.trim()
  const description = clip.description.trim()
  const dièses = motsDièse(`${titre}\n${description}`)
  return [
    `Titre : ${titre === '' ? '(sans titre)' : titre}`,
    '',
    'Description :',
    description === '' ? '(sans description)' : description,
    '',
    `Mots-dièse : ${dièses.length === 0 ? '(aucun)' : dièses.join(' ')}`,
    '',
  ].join('\n')
}

/** Ce que l'export produira, sous les noms qu'il leur donnera. */
export type NomsDeSortie = {
  mp4: string
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
 */
export function nomsDeSortie(clipId: string, ratioNatif: Ratio): NomsDeSortie {
  return {
    mp4: `${clipId}.mp4`,
    variant9x16: ratioNatif === '9:16' ? null : `${clipId}-9x16.mp4`,
    texts: `${clipId}.txt`,
  }
}
