import fs from 'node:fs'

import { z } from 'zod'

import { getClips, getDb, getProject } from '@/server/db'
import { body, json, requestInvalid, route } from '@/server/http'
import { candidatesPath } from '@/server/paths'
import { launch, UnknownProjectError } from '@/server/run'

/**
 * `POST /api/projects/:id/candidates/more` — the sweep pass: N more clips
 * once triage is done, without touching what already exists.
 *
 * Goes through `launch` like every other detection run — same reservation,
 * same scheduler, same 409 on a concurrent execution — with `force` set so
 * `planSteps` runs `candidates` again despite `candidates.json` already
 * being there. See `docs/lessons.md` for why this is a separate pass rather
 * than `POST /run` with a bigger target.
 */

const REQUEST = z.strictObject({ count: z.union([z.literal(5), z.literal(10)]) })

export const POST = route(
  'POST /api/projects/:id/candidates/more',
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const { count } = await body(request, REQUEST)
    const db = getDb()
    // Ahead of the two checks below, or an unknown id also reads as
    // "nothing to sweep" and returns their 400 instead of a 404.
    if (getProject(db, id) === undefined) throw new UnknownProjectError(id)
    // A project may never have run the windowed pass at all.
    if (!fs.existsSync(candidatesPath(id))) {
      throw requestInvalid(`Le projet ${id} n'a pas encore de premier repérage.`)
    }
    // `mergeCandidates` keeps only non-`candidate` clips: untriaged ones
    // would be silently dropped, breaking "existing clips are untouchable".
    if (getClips(db, id).some((clip) => clip.status === 'candidate')) {
      throw requestInvalid(`Le projet ${id} a encore des clips non triés : la passe « +N clips » les supprimerait.`)
    }
    const launched = await launch(id, ['candidates'], { force: ['candidates'], count })
    return json(launched, { status: 202 })
  },
)
