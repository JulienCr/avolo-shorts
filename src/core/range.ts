/**
 * L'analyse de l'en-tête `Range` (RFC 7233).
 *
 * Elle vit dans `src/core/` parce que c'est du calcul sur une chaîne, et que
 * c'est là que sont les bugs. Ce qui reste dans la route — ouvrir, décrire,
 * pousser des octets — se vérifie au `curl` contre un serveur qui tourne, et
 * c'est cette dépendance-là que la CI n'a pas ; toucher au disque, elle sait
 * faire, `tests/server/paths.test.ts` ne fait que ça. (relevé par Copilot, dont
 * la version précédente de ce paragraphe donnait une raison fausse.)
 *
 * L'enjeu n'est pas cosmétique : sans réponse aux requêtes partielles, la barre
 * de lecture d'un `<video>` ne fonctionne pas — le navigateur ne peut pas
 * sauter. L'éditeur de clip scrube sur le proxy en permanence.
 */

/** Une plage d'octets **inclusive aux deux bouts**, comme HTTP la définit. */
export type ByteRange = {
  /** Premier octet servi, à partir de 0. */
  start: number
  /** Dernier octet servi, **inclus** — `bytes=0-1023` fait 1024 octets. */
  end: number
}

/**
 * Une seule plage, et rien d'autre.
 *
 * La virgule qui sépare plusieurs plages n'est volontairement pas acceptée :
 * servir plusieurs plages exige une réponse `multipart/byteranges`, que cette
 * route ne produit pas. Aucun lecteur vidéo n'en demande.
 *
 * Le `\s*` est plus permissif que la grammaire, qui n'admet pas d'espace autour
 * du tiret. Refuser un en-tête sur un espace ne protège de rien.
 */
const RANGE = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i

/**
 * Lit l'en-tête `Range` et rend la plage d'octets à servir, ou `null`.
 *
 * `null` recouvre deux situations que **l'appelant doit distinguer lui-même**,
 * parce qu'elles n'appellent pas la même réponse HTTP :
 *
 * - `header === null` — pas d'en-tête du tout : le client veut le fichier
 *   entier, donc 200 ;
 * - le reste — plage illisible ou insatisfiable : 416.
 *
 * La route teste donc l'absence d'en-tête avant d'appeler cette fonction. Rendre
 * un troisième cas ici (un `'absent' | 'invalide'`) ferait porter à du calcul
 * pur une distinction qui est celle du protocole, pas celle des bornes.
 *
 * Ce qui est refusé donne 416 plutôt que d'être ignoré. La RFC autorise les deux
 * — un en-tête `Range` mal formé *peut* être ignoré, et la réponse est alors un
 * 200 complet. On choisit la réponse bruyante : le seul client de cette route
 * est notre propre interface, et un `Range` qu'elle aurait mal construit doit se
 * voir, pas se dissoudre dans une réponse qui a l'air normale.
 *
 * Les nombres ne sont pas contrôlés contre `Number.MAX_SAFE_INTEGER` : un très
 * grand nombre de chiffres donne `Infinity`, et les comparaisons avec `size`
 * restent justes. L'imprécision des entiers commence à 2^53, soit 9 Po — très
 * au-delà de toute taille de fichier que ce projet manipule.
 */
export function parseRange(header: string | null, size: number): ByteRange | null {
  if (header === null) return null
  // Une taille qui n'est pas un entier positif ne peut pas borner quoi que ce
  // soit, et un fichier vide n'a aucun octet à servir : toute plage y est
  // insatisfiable. Le cas se produit pour de vrai, avec un proxy dont l'encodage
  // vient d'être interrompu.
  if (!Number.isSafeInteger(size) || size <= 0) return null

  const found = RANGE.exec(header.trim())
  if (found === null) return null

  const [, startRaw, finRaw] = found
  const last = size - 1

  // `bytes=-500` : les 500 derniers octets. C'est la forme que prend « la fin du
  // fichier » quand le client ne connaît pas encore sa taille — un lecteur MP4
  // s'en sert pour aller chercher l'index rangé en queue.
  if (startRaw === '') {
    if (finRaw === '') return null
    const length = Number(finRaw)
    if (length === 0) return null
    return { start: Math.max(0, size - length), end: last }
  }

  const start = Number(startRaw)
  if (start > last) return null

  // Une plage ouverte (`bytes=1024-`) va jusqu'au bout ; une plage fermée est
  // bornée à la taille réelle, ce qui n'est pas une erreur mais la règle.
  const end = finRaw === '' ? last : Math.min(Number(finRaw), last)
  if (end < start) return null

  return { start, end }
}
