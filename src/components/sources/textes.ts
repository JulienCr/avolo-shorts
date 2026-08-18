/**
 * Les textes de la bibliothèque.
 *
 * Ils vivent ici plutôt que dans `@/lib/format` parce qu'ils ne décrivent que
 * cet écran : une taille de fichier et une date de dépôt n'existent nulle part
 * ailleurs dans le produit — un clip a une durée et une position, jamais un
 * poids. `@/lib/format` porte ce qui traverse plusieurs écrans, et l'y ajouter
 * ferait passer pour un vocabulaire commun ce qui est le vocabulaire d'une
 * grille de sources.
 */

import { ApiError } from '@/lib/api'

/** Les multiples décimaux, à partir du kilo : l'octet a son propre cas. */
const MULTIPLES = ['ko', 'Mo', 'Go', 'To', 'Po'] as const

/**
 * Une taille de fichier, **en décimal**.
 *
 * `ROADMAP.md` et `CLAUDE.md` parlent de replays « de 4,5 à 12,7 Go » et d'une
 * copie « à 97 Mo/s » : ce sont des giga décimaux. Compter en 1024 afficherait
 * 4,0 Go sur le fichier que tout le dépôt appelle 4,3 Go, et personne ne
 * retrouverait le sien.
 *
 * Trois chiffres significatifs, pas plus. « 982,4 Mo » n'aide pas à reconnaître
 * un replay, et une décimale qui apparaît et disparaît d'une carte à l'autre
 * casse l'alignement de la colonne.
 *
 * La doctrine de `formatDuration` pour le reste : une valeur absente ou
 * aberrante rend une taille nulle plutôt que « NaN Go » — l'interface affiche
 * zéro, elle ne se casse pas. Et 0 octet est une valeur réelle, celle d'un
 * enregistrement qui vient tout juste de commencer.
 */
export function formatOctets(octets: number): string {
  if (!Number.isFinite(octets) || octets <= 0) return '0 octet'

  const entier = Math.round(octets)
  if (entier < 1000) return pluriel(entier, 'octet', 'octets')

  let valeur = entier / 1000
  let rang = 0
  while (valeur >= 1000 && rang < MULTIPLES.length - 1) {
    valeur /= 1000
    rang += 1
  }
  let arrondi = valeur < 100 ? Math.round(valeur * 10) / 10 : Math.round(valeur)

  // **L'arrondi peut franchir la borne que la boucle vient de refuser.**
  // 999 999 999 octets valent 999,999999 Mo : la boucle s'arrête sous 1000,
  // l'arrondi rend 1000, et la carte annonçait « 1000 Mo » — une unité que
  // personne n'écrit, juste sous le seuil du Go. La promotion se fait donc
  // après l'arrondi, jamais avant. (relevé par Copilot)
  if (arrondi >= 1000 && rang < MULTIPLES.length - 1) {
    arrondi = 1
    rang += 1
  }

  return `${String(arrondi).replace('.', ',')} ${MULTIPLES[rang]}`
}

/**
 * La date de dépôt d'un replay, **dans un fuseau fixé**.
 *
 * C'est la source d'écart d'hydratation la plus courante en Next : le rendu
 * serveur prend le fuseau de `TZ`, le navigateur celui du système, et le même
 * `modifiedAt` produit alors deux textes différents — React jette l'arbre et
 * recommence, sur la page d'entrée du produit.
 *
 * Le fuseau est donc écrit ici, et il n'est pas arbitraire : l'émission est
 * tournée à Paris, et c'est sous cette heure-là que Julien reconnaît un replay.
 * Un `toLocaleString` sans fuseau afficherait la bonne heure au bon endroit et
 * une autre partout ailleurs, y compris dans un rendu serveur lancé sous `TZ=UTC`.
 *
 * Le formateur est construit une fois : `Intl.DateTimeFormat` coûte plus cher
 * que le formatage lui-même, et la grille en appelle vingt et un.
 */
const FORMAT_DATE = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Paris',
})

export function formatDateSource(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'date inconnue'
  return FORMAT_DATE.format(date)
}

/**
 * Un compte et son nom.
 *
 * **Zéro prend le singulier** — « 0 replay », pas « 0 replays ». C'est la règle
 * du français, et elle se rate d'autant plus facilement qu'elle est l'inverse de
 * l'anglais, où toute la mécanique de ce genre est écrite.
 */
export function pluriel(n: number, singulier: string, pluriels: string): string {
  return `${n} ${n < 2 ? singulier : pluriels}`
}

/**
 * Le message d'un échec, **tel que le serveur l'a formulé**.
 *
 * La règle qui gouverne les surfaces d'erreur de cet écran : on affiche ce que
 * le serveur a dit, on n'en compose jamais un depuis une exception. Les réponses
 * d'erreur des routes sont déjà épurées de leurs chemins absolus ; le message
 * d'un `TypeError` de `fetch`, lui, ne l'est pas — il dépend du navigateur, il
 * est en anglais, et une région `role="alert"` le lirait à voix haute.
 *
 * D'où le partage : une `ApiError` porte la phrase du serveur, tout le reste
 * n'est pas une phrase et se remplace par la seule chose vraie qu'on sache alors.
 */
export function messageServeur(erreur: unknown): string {
  return erreur instanceof ApiError ? erreur.message : 'Le serveur n’a pas répondu.'
}
