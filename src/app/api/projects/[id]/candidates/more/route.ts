import { z } from 'zod'

import { body, json, route } from '@/server/http'
import { launch } from '@/server/run'

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
    const launched = await launch(id, ['candidates'], { force: ['candidates'], count })
    return json(launched, { status: 202 })
  },
)
