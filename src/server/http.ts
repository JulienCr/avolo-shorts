import type { z } from 'zod'

import { InvalidSettingError } from '@/server/db'
import { messageSafe } from '@/server/errors'
import { isTransient, GeminiBlockedError } from '@/server/llm/retry'
import {
  MetaAccountMisconfiguredError,
  MetaAssetPermissionError,
  MetaContainerTimeoutError,
  MetaFileRefusedError,
  MetaRateLimitError,
  MetaTokenExpiredError,
  PublicationAlreadyPublishedError,
  UploadPostAccountMisconfiguredError,
  UploadPostFileRefusedError,
  UploadPostRateLimitError,
  UploadPostTokenExpiredError,
} from '@/server/publication/errors'
import { PublicationInCurrentError } from '@/server/publication/registry'
import { ProjectErrorCollision, ExecutionInCurrentError, UnknownProjectError } from '@/server/run'

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
 * 2. *Aucun chemin absolu ne sort d'ici.* `runFfmpeg`, `statWithDelay` et
 *    `launchWorker` écrivent la commande complète dans leurs messages — ils le
 *    documentent chacun comme « destiné à un journal de serveur, pas à une
 *    réponse HTTP », et rien ne l'appliquait. C'est ici que ça s'applique :
 *    l'erreur entière part au journal, sa version épurée part au client.
 */

/** Une erreur dont le code est décidé au point d'appel. */
export class ErrorHttp extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ErrorHttp'
  }
}

/** Ce qui n'existe pas : projet, clip, artefact. */
export function notFound(what: string): ErrorHttp {
  return new ErrorHttp(404, what)
}

/** Ce que l'appelant a mal formulé. */
export function requestInvalid(why: string): ErrorHttp {
  return new ErrorHttp(400, why)
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, init)
}

/** Le code que mérite une erreur. Séparé de la réponse pour être testable. */
export function statusFor(error: unknown): number {
  if (error instanceof ErrorHttp) return error.status
  if (error instanceof UnknownProjectError) return 404
  // Une saisie refusée par le registre des réglages : clé inconnue ou valeur
  // hors bornes. La demande est mal formée, c'est un 400 — un 500 enverrait
  // chercher un défaut du serveur là où il n'y en a pas.
  if (error instanceof InvalidSettingError) return 400
  if (error instanceof ExecutionInCurrentError) return 409
  // Deux sources différentes pour un même identifiant : la demande est bien
  // formée, elle entre en conflit avec ce qui existe déjà.
  if (error instanceof ProjectErrorCollision) return 409
  // Une publication tourne déjà sur ce couple (clip, plateforme) — même rôle
  // que `ExecutionInCurrentError` côté pipeline.
  if (error instanceof PublicationInCurrentError) return 409
  // Republier une plateforme déjà `published` sans `force` : la demande est
  // bien formée, elle entre en conflit avec ce qui existe déjà (spec §6.5).
  if (error instanceof PublicationAlreadyPublishedError) return 409
  // Les quatre natures d'échec d'Upload Post qui remontent par un code HTTP
  // (spec publication §8) : jeton expiré, débit atteint, fichier refusé,
  // compte mal configuré. La cinquième — l'audit non passé — ne se voit qu'à
  // la visibilité du résultat, jamais dans un statut.
  if (error instanceof UploadPostTokenExpiredError) return 401
  if (error instanceof UploadPostRateLimitError) return 429
  if (error instanceof UploadPostFileRefusedError) return 422
  if (error instanceof UploadPostAccountMisconfiguredError) return 400
  // Le connecteur Meta direct (issue #146) : même quatre natures, plus le
  // droit manquant sur l'actif (2207085) et le sondage de conteneur qui
  // n'aboutit jamais — retentable plus tard, donc un 503 comme les pannes
  // transitoires ci-dessous.
  if (error instanceof MetaTokenExpiredError) return 401
  if (error instanceof MetaRateLimitError) return 429
  if (error instanceof MetaFileRefusedError) return 422
  if (error instanceof MetaAccountMisconfiguredError) return 400
  if (error instanceof MetaAssetPermissionError) return 403
  if (error instanceof MetaContainerTimeoutError) return 503
  // Le filtre de contenu a refusé : ni la faute de l'appelant, ni un défaut du
  // serveur. 422 — la demande est bien formée, elle ne peut simplement pas être
  // traitée.
  if (error instanceof GeminiBlockedError) return 422
  // Pannes et surcharges du fournisseur, coupures réseau : la même liste de
  // marqueurs que celle qui décide d'une relance côté Gemini (tâche 9).
  if (isTransient(error)) return 503
  return 500
}

/**
 * La réponse d'échec. **Le journal reçoit l'erreur entière**, cause comprise ;
 * le client reçoit un message sans arborescence.
 */
export function responseError(error: unknown, context?: string): Response {
  const status = statusFor(error)
  console.error(`[api${context === undefined ? '' : ` ${context}`}] ${status} —`, error)
  return json({ error: messageSafe(error) }, { status: status })
}

/**
 * Enveloppe un gestionnaire de route : ce qui lève ressort en réponse d'échec.
 *
 * Sans elle, chaque route répéterait le même `try`/`catch`, et celle qui
 * l'oublierait renverrait la page d'erreur de Next — c'est-à-dire, en
 * développement, la trace complète avec les chemins dedans.
 */
export function route<A extends unknown[]>(
  context: string,
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args)
    } catch (error) {
      return responseError(error, context)
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
export async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    // **Un corps vide vaut `{}`.** Une route dont tous les champs sont
    // facultatifs — `POST /api/clips/:id/export` — se demande naturellement par
    // un `curl -X POST` nu, et lui répondre « corps JSON illisible » serait
    // exact et inutile. Une route qui exige un champ échoue de toute façon à la
    // validation, avec un message qui nomme le champ manquant.
    const text = await request.text()
    raw = text.trim() === '' ? {} : JSON.parse(text)
  } catch {
    throw requestInvalid('Corps JSON illisible.')
  }
  const lu = schema.safeParse(raw)
  if (!lu.success) {
    throw requestInvalid(
      `Corps invalide : ${lu.error.issues.map((i) => `${i.path.join('.') || '(racine)'} — ${i.message}`).join(' ; ')}`,
    )
  }
  return lu.data
}
