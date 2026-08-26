import { z } from 'zod'

import type { ScheduledEntry } from '@/lib/api'
import { deliveryToDay } from '@/server/renders'
import { getClip, getDb, getPublications, listSchedule, schedulePublications } from '@/server/db'
import { body, json, requestInvalid, route } from '@/server/http'

/**
 * `GET /api/planning/schedule?from=<ms>&to=<ms>` — le calendrier, en lecture
 * (spec planning §5.2).
 *
 * **Lit `publications`, jamais le vivier ni le statut du clip** : un clip
 * reprogrammé qui retombe à `kept` reste sur le calendrier et part quand même
 * — implémenter l'inverse serait la régression silencieuse que la spec nomme.
 */
export const GET = route('GET /api/planning/schedule', async (request: Request) => {
  const params = new URL(request.url).searchParams
  const fromParam = params.get('from')
  const toParam = params.get('to')
  const from = Number(fromParam)
  const to = Number(toParam)
  if (fromParam === null || toParam === null || !Number.isFinite(from) || !Number.isFinite(to)) {
    throw requestInvalid('Paramètres `from` et `to` requis, en millisecondes depuis l’époque.')
  }

  const db = getDb()
  const rows = listSchedule(db, from, to)

  // Une échéance par clip, pas par ligne : les quatre plateformes partagent la
  // même date (spec §5.1), et `deliveryToDay` n'a besoin d'être sondé qu'une
  // fois par clip.
  const byClip = new Map<string, typeof rows>()
  for (const row of rows) {
    const forClip = byClip.get(row.clipId) ?? []
    forClip.push(row)
    byClip.set(row.clipId, forClip)
  }

  const entries: ScheduledEntry[] = []
  for (const [clipId, clipRows] of byClip) {
    const clip = getClip(db, clipId)
    if (clip === undefined) continue
    const statuses: ScheduledEntry['statuses'] = {}
    for (const row of clipRows) statuses[row.platform] = row.status
    // Une plateforme déjà publiée garde l'échéance de son envoi, distincte
    // d'une reprogrammation ultérieure des lignes encore `planned` : l'écran
    // doit montrer la date qui reste à venir, pas celle d'un envoi passé.
    const plannedRow = clipRows.find((row) => row.status === 'planned')
    entries.push({
      clipId,
      projectId: clip.projectId,
      title: clip.title,
      scheduledAt: (plannedRow ?? clipRows[0]).scheduledAt ?? 0,
      statuses,
      stale: !deliveryToDay(clip),
    })
  }
  entries.sort((a, b) => a.scheduledAt - b.scheduledAt)

  return json({ entries })
})

const SCHEDULE_REQUEST = z.strictObject({
  clipIds: z
    .array(z.string())
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'un clip ne peut pas apparaître deux fois',
    }),
  scheduledAt: z.number().int().positive(),
})

/**
 * `POST /api/planning/schedule` — pose une échéance sur les quatre lignes
 * `publications` de chaque clip (spec planning §5.1).
 */
export const POST = route('POST /api/planning/schedule', async (request: Request) => {
  const { clipIds, scheduledAt } = await body(request, SCHEDULE_REQUEST)
  const db = getDb()
  // Un identifiant inconnu heurterait sinon la contrainte de clé étrangère et
  // remonterait en 500 : on la vérifie ici pour rendre une 400 exploitable.
  for (const clipId of clipIds) {
    if (getClip(db, clipId) === undefined) {
      throw requestInvalid(`Clip inconnu : ${clipId}`)
    }
  }
  schedulePublications(db, clipIds, scheduledAt, Date.now())

  const entries: ScheduledEntry[] = []
  for (const clipId of clipIds) {
    const clip = getClip(db, clipId)
    if (clip === undefined) continue
    const statuses: ScheduledEntry['statuses'] = {}
    for (const row of getPublications(db, clipId)) {
      if (row.scheduledAt !== null) statuses[row.platform] = row.status
    }
    entries.push({
      clipId,
      projectId: clip.projectId,
      title: clip.title,
      scheduledAt,
      statuses,
      stale: !deliveryToDay(clip),
    })
  }
  return json({ entries })
})
