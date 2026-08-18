/**
 * Deux petits calculs que le lanceur (`src/server/run.ts`) et l'API font sur du
 * texte, et qui n'ont donc rien à faire dans du code qui touche au disque.
 */

const MOIS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
]

/** `2025-06-15-cqlp` → `{ date: …, reste: 'cqlp' }`, ou `null` si pas de date. */
const PRÉFIXE_DATE = /^(\d{4})-(\d{2})-(\d{2})[-_ ]?(.*)$/

/**
 * Le titre affiché d'un projet, **dérivé du nom de fichier** (spec §12).
 *
 * Les replays sont nommés `AAAA-MM-JJ-qui-quoi` : la date en tête sert à trier
 * un dossier, elle ne se lit pas. On la remet donc en français et on la passe
 * derrière, ce qui laisse en tête ce qui distingue une émission d'une autre.
 *
 * **Jamais un hachage, et jamais rien qui se perde** : un nom qui ne suit pas la
 * convention ressort tel quel plutôt que d'être deviné. Le renommage d'une
 * bibliothèque entière en charabia est précisément ce que la spec interdit ici.
 */
export function titreProjet(id: string): string {
  const m = PRÉFIXE_DATE.exec(id)
  if (m === null) return id

  const [, année, mois, jour, reste] = m
  // **La date entière est vérifiée, pas seulement le mois.** Un `2026-02-31`
  // ressortait en « 31 février 2026 », c'est-à-dire en date affirmée sur un jour
  // qui n'existe pas — alors que la règle annoncée juste au-dessus est de rendre
  // tel quel un nom qui ne suit pas la convention. Le passage par `Date` traite
  // les mois courts et les années bissextiles sans table à tenir : une date
  // impossible se recale sur le mois suivant, donc ne se relit pas identique.
  // (relevé par Copilot)
  const d = new Date(Date.UTC(Number(année), Number(mois) - 1, Number(jour)))
  const valide =
    d.getUTCFullYear() === Number(année) &&
    d.getUTCMonth() === Number(mois) - 1 &&
    d.getUTCDate() === Number(jour)
  if (!valide) return id

  const date = `${Number(jour)} ${MOIS[Number(mois) - 1]} ${année}`
  const sujet = reste.replace(/[-_]+/g, ' ').trim()
  return sujet === '' ? date : `${sujet} — ${date}`
}

/**
 * Les quatre étapes que le worker de transcription annonce sur stderr, sous la
 * forme `[2/4] Lecture de l'audio…`.
 *
 * WhisperX ne rend aucune position temporelle exploitable : il charge un modèle,
 * lit tout l'audio, transcrit, puis aligne. Ces quatre marqueurs sont donc la
 * seule progression disponible, et c'est déjà l'essentiel — la question posée
 * devant une barre immobile pendant quarante minutes est « est-ce que ça
 * avance », pas « à quel pourcent ».
 *
 * La fraction rendue est celle des étapes **terminées** : entrer dans l'étape 2
 * prouve que la 1 est finie, pas que la 2 avance.
 */
export function avancementWorker(ligne: string): number | null {
  const m = /\[(\d+)\/(\d+)\]/.exec(ligne)
  if (m === null) return null
  const fait = Number(m[1]) - 1
  const total = Number(m[2])
  if (!Number.isFinite(fait) || !Number.isFinite(total) || total <= 0) return null
  return Math.min(1, Math.max(0, fait / total))
}
