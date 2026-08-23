import type { Platform } from '@/core/publication'

/**
 * Le registre des publications en cours, **dans ce processus**.
 *
 * Même forme que `inCurrent` (`src/server/run.ts:104`), reprise ici plutôt
 * qu'importée : `run.ts` est tenu par la PR #143 en cours de revue. Un
 * lancement sur un couple (clip, plateforme) déjà en vol lève, la route en
 * fait un 409 — le même rôle que `ExecutionInCurrentError` côté pipeline.
 */

const inFlight = new Map<string, Set<Platform>>()

/** Levée quand une publication tourne déjà pour ce clip sur l'une des plateformes visées. */
export class PublicationInCurrentError extends Error {
  constructor(
    readonly clipId: string,
    readonly platforms: readonly Platform[],
  ) {
    super(`Une publication est déjà en cours pour ${clipId} sur ${platforms.join(', ')}.`)
    this.name = 'PublicationInCurrentError'
  }
}

/**
 * Réserve `platforms` pour `clipId`, ou lève si l'une d'elles est déjà prise.
 *
 * **Rien d'asynchrone entre le contrôle et la pose** — comme `launch()` dans
 * `run.ts` — sans quoi deux requêtes simultanées pourraient toutes les deux
 * lire « libre » avant que l'une des deux ne pose sa réservation.
 */
export function reserve(clipId: string, platforms: readonly Platform[]): void {
  const current = inFlight.get(clipId)
  const overlapping = platforms.filter((p) => current?.has(p) === true)
  if (overlapping.length > 0) throw new PublicationInCurrentError(clipId, overlapping)
  const next = current ?? new Set<Platform>()
  for (const p of platforms) next.add(p)
  inFlight.set(clipId, next)
}

/** Libère `platforms` pour `clipId`. Sans effet sur une plateforme déjà libre. */
export function release(clipId: string, platforms: readonly Platform[]): void {
  const current = inFlight.get(clipId)
  if (current === undefined) return
  for (const p of platforms) current.delete(p)
  if (current.size === 0) inFlight.delete(clipId)
}

/** Pour les tests : remet le registre à vide entre deux cas. */
export function forgetAll(): void {
  inFlight.clear()
}
