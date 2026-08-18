import type { z } from 'zod'

import { messageSûr } from '@/server/erreurs'
import { ExécutionEnCoursError, ProjetInconnuError } from '@/server/run'
import { estPassagère, GeminiBlockedError } from '@/server/steps/candidates'

/**
 * La frontière HTTP : ce qui traverse, et sous quel code.
 *
 * **Deux règles, et les deux ont été payées par les tâches précédentes.**
 *
 * 1. *Tout n'est pas un 500.* La tâche 9 distingue trois natures d'échec, et les
 *    confondre coûte le diagnostic : un refus du filtre de contenu de Gemini
 *    n'est la faute de personne et ne se réessaie jamais (422) ; une panne de
 *    service ou de réseau se réessaiera très bien dans dix minutes (503) ; tout
 *    le reste est un défaut de ce programme (500). Répondre 500 aux trois
 *    envoie chercher un bug là où il n'y en a pas.
 * 2. *Aucun chemin absolu ne sort d'ici.* `runFfmpeg`, `statAvecDélai` et
 *    `lancerWorker` écrivent la commande complète dans leurs messages — ils le
 *    documentent chacun comme « destiné à un journal de serveur, pas à une
 *    réponse HTTP », et rien ne l'appliquait. C'est ici que ça s'applique :
 *    l'erreur entière part au journal, sa version épurée part au client.
 */

/** Une erreur dont le code est décidé au point d'appel. */
export class ErreurHttp extends Error {
  constructor(
    readonly statut: number,
    message: string,
  ) {
    super(message)
    this.name = 'ErreurHttp'
  }
}

/** Ce qui n'existe pas : projet, clip, artefact. */
export function introuvable(quoi: string): ErreurHttp {
  return new ErreurHttp(404, quoi)
}

/** Ce que l'appelant a mal formulé. */
export function requêteInvalide(pourquoi: string): ErreurHttp {
  return new ErreurHttp(400, pourquoi)
}

export function json(données: unknown, init: ResponseInit = {}): Response {
  return Response.json(données, init)
}

/** Le code que mérite une erreur. Séparé de la réponse pour être testable. */
export function statutPour(erreur: unknown): number {
  if (erreur instanceof ErreurHttp) return erreur.statut
  if (erreur instanceof ProjetInconnuError) return 404
  if (erreur instanceof ExécutionEnCoursError) return 409
  // Le filtre de contenu a refusé : ni la faute de l'appelant, ni un défaut du
  // serveur. 422 — la demande est bien formée, elle ne peut simplement pas être
  // traitée.
  if (erreur instanceof GeminiBlockedError) return 422
  // Pannes et surcharges du fournisseur, coupures réseau : la même liste de
  // marqueurs que celle qui décide d'une relance côté Gemini (tâche 9).
  if (estPassagère(erreur)) return 503
  return 500
}

/**
 * La réponse d'échec. **Le journal reçoit l'erreur entière**, cause comprise ;
 * le client reçoit un message sans arborescence.
 */
export function réponseErreur(erreur: unknown, contexte?: string): Response {
  const statut = statutPour(erreur)
  console.error(`[api${contexte === undefined ? '' : ` ${contexte}`}] ${statut} —`, erreur)
  return json({ error: messageSûr(erreur) }, { status: statut })
}

/**
 * Enveloppe un gestionnaire de route : ce qui lève ressort en réponse d'échec.
 *
 * Sans elle, chaque route répéterait le même `try`/`catch`, et celle qui
 * l'oublierait renverrait la page d'erreur de Next — c'est-à-dire, en
 * développement, la trace complète avec les chemins dedans.
 */
export function route<A extends unknown[]>(
  contexte: string,
  gestionnaire: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await gestionnaire(...args)
    } catch (erreur) {
      return réponseErreur(erreur, contexte)
    }
  }
}

/**
 * Lit et valide un corps JSON.
 *
 * Un corps mal formé est un 400 : c'est la seule catégorie d'erreur dont
 * l'appelant est responsable, et lui répondre 500 lui ferait chercher la panne
 * en face.
 */
export async function corps<T>(requête: Request, schéma: z.ZodType<T>): Promise<T> {
  let brut: unknown
  try {
    brut = await requête.json()
  } catch {
    throw requêteInvalide('Corps JSON illisible.')
  }
  const lu = schéma.safeParse(brut)
  if (!lu.success) {
    throw requêteInvalide(
      `Corps invalide : ${lu.error.issues.map((i) => `${i.path.join('.') || '(racine)'} — ${i.message}`).join(' ; ')}`,
    )
  }
  return lu.data
}
