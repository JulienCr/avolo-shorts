import { getDb, getProject } from '@/server/db'
import { notFound, json, route } from '@/server/http'
import { readCorrectionLog } from '@/server/steps/transcript-correction'

/**
 * `GET /api/projects/:id/transcript/correction` — l'historique de la
 * correction automatique du transcript (spec §9, étage 2, correction du
 * 23 août 2026) : la liste des substitutions appliquées, dans l'ordre où
 * `correction.json` les porte.
 *
 * **Il n'y a plus de `POST` ici.** La correction s'applique désormais
 * d'office pendant l'analyse (`case 'correction'`, `src/server/run.ts`) : la
 * relecture avant écriture livrée par #128 n'a plus d'appelant, et cette
 * route ne fait plus que lire ce que le pipeline a déjà écrit. Défaire une
 * substitution est `POST .../correction/undo`.
 * @returns Un journal vide, jamais une erreur, tant que la correction n'a pas
 * encore tourné sur ce projet.
 */
export const GET = route(
  'GET /api/projects/:id/transcript/correction',
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const db = getDb()
    const project = getProject(db, id)
    if (project === undefined) throw notFound(`Projet inconnu : ${id}`)

    return json(readCorrectionLog(project).entries)
  },
)
