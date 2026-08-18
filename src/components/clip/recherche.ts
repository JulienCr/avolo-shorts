/**
 * Chercher dans le transcript.
 *
 * **`Ctrl+F` du navigateur ne marche pas ici, et c'est structurel** : la surface
 * est virtualisée par phrase, donc le DOM ne porte qu'une trentaine de phrases
 * sur les plusieurs centaines d'une émission. Le navigateur ne peut chercher que
 * dans ce qu'il voit. Sans cette recherche-ci, il n'y en a aucune sur vingt
 * mille mots.
 *
 * Le résultat est une liste d'**index de mots**, pas de phrases : c'est ce qui
 * permet à la navigation de poser le curseur du clavier sur l'occurrence, et
 * donc de poser une borne dessus dans la foulée.
 */

/** Sans casse ni accents : on tape « theatre » quand on cherche vite. */
export function normaliser(texte: string): string {
  return texte
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/**
 * Les mots qui commencent une occurrence de `requête`.
 *
 * **L'appariement commence sur une frontière de mot**, jamais au milieu : sans
 * cette règle, chercher « le » désigne aussi « brûle », et la navigation saute
 * sur des mots que personne ne cherchait. Il n'a en revanche pas à *finir* sur
 * une frontière, sinon la recherche ne trouverait rien tant que le dernier mot
 * n'est pas tapé en entier.
 */
export function chercher(mots: readonly { word: string }[], requête: string): number[] {
  const cible = normaliser(requête).trim()
  if (cible === '') return []

  // Le transcript entier en une chaîne normalisée, et de quoi retrouver le mot
  // qui commence à chaque décalage. Construit ici plutôt que mot à mot parce
  // qu'une requête de plusieurs mots traverse les frontières.
  let texte = ''
  const motAuDécalage = new Map<number, number>()
  for (const [index, mot] of mots.entries()) {
    // **Le mot est ébarbé avant que son décalage ne soit noté.**
    // `lireTranscript` transmet ce que WhisperX rend, espaces compris : noter le
    // décalage puis ajouter la forme brute faisait commencer l'occurrence un
    // caractère plus loin que le mot, et la comparaison à un décalage de début
    // de mot l'écartait. Un mot qui n'est que du blanc ne désigne rien, et ne
    // prend donc pas de place non plus. (relevé par Copilot)
    const normalisé = normaliser(mot.word).trim()
    if (normalisé === '') continue
    motAuDécalage.set(texte.length, index)
    texte += `${normalisé} `
  }

  const trouvés: number[] = []
  for (let début = texte.indexOf(cible); début >= 0; début = texte.indexOf(cible, début + 1)) {
    const index = motAuDécalage.get(début)
    if (index !== undefined) trouvés.push(index)
  }
  return trouvés
}
