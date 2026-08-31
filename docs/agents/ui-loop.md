# UI loop: looking at the app, not just measuring it

Facts, not prose. See `docs/postmortem-2026-08-30-fleet-ecran-clip.md` for the
incident this file exists to prevent.

## Serving the app

`pnpm dev` serves **4005** from the main checkout, and belongs to the human. A
worktree takes another port: `pnpm exec next dev -p 40xx`.

**`localhost`, never `127.0.0.1`** — the dev server returns 403 on the literal
address.

## Data is real and local

8 projects, 93 clips in `projects/avolo.db`. The Google Drive mount is **not**
needed to display a screen — thumbnails and filmstrips come from the local
`proxy.mp4` (`src/server/thumbs.ts:19-26`). `projects/2025-12-14-handicap` has
no proxy and renders no clip screen.

Reference clip: `2026-03-08-caro-mdlm_005472883-005518477`. The long one
(88.3 s, 284 words) is `2026-03-08-caro-mdlm_007212212-007300496`.

## Capturing and comparing

Use `pnpm ui-shot`, never an improvised Playwright path — see `scripts/ui-shot.ts`.

**The rule: an image goes to the human; a table of numbers does not replace
it.** Measuring proves the page renders, not that it is right.
`claude-in-chrome` screenshots are unreliable here (the viewport shrinks on
each call) — that is a fact about that tool, not a reason to stop looking.

See `docs/ui/systeme-visuel.md` for the tokens and component grammar that
`scripts/ui/pairs.ts` selectors depend on.
