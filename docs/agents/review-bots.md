# Review bots: how this repo's machinery actually behaves

Four facts about the review surfaces here. Each one has cost an agent time at
least once, and none is derivable from reading the code.

## Aristarque fires on `ready_for_review`, never on push

`.github/workflows/pr-review.yml` triggers on `opened` and `ready_for_review`
only. Pushing commits does **not** re-run it; comment `@aristarque review` to
re-trigger. Copilot, by contrast, does review on push.

Consequence for the loop: marking a PR ready is what starts Aristarque's first
round, so on a PR opened as a draft its **first** reading is whatever pass
number the loop happens to be on. An integrator counting rounds will see it
arrive "late" — that is expected, not a delay.

## Aristarque posts a comment, not a review

It appears in neither the `reviews` array nor the review-thread list. Fetch the
comments surface (`gh pr view <n> --json comments`) or you will conclude it said
nothing. And it is **silent** when `OLLAMA_API_KEY` is unset: a PR with no
comment from it is not a PR it judged good.

## A silence has three causes, and one command separates them

Quota exhausted, it says so in a comment. Secret missing, it says nothing at
all. **And `ready_for_review` sometimes creates no workflow run whatsoever** —
measured 2026-08-27 on PR #222: `gh pr ready` is in the issue timeline, five
other PRs got their run the same evening, `OLLAMA_API_KEY` was set, and the
branch had zero runs after the draft's skipped one. A manual `workflow_dispatch`
on the same PR and the same sha posted seven seconds later, so the action, the
quota and Ollama were all healthy — the run was simply never created. A second
case the same night on #223. Cause unknown, upstream of the action.

So ask whether a run exists **before** asking why it said nothing — **et sans
filtre de branche** :

```bash
gh run list --workflow=pr-review.yml --limit 6 \
  --json createdAt,event,headBranch,status,conclusion
```

Zero runs means the event never fired: re-dispatch with
`gh workflow run pr-review.yml -f pr=<N>`, and do not go looking at the secret.

**Le filtre `--branch` ne voit pas les runs dispatchés à la main**, et c'est le
piège que ce paragraphe tendait lui-même. Un `workflow_dispatch` s'exécute sur la
branche par défaut : son run est enregistré avec `headBranch: main`, quelle que
soit la PR qu'il relit via `-f pr=`. Donc `--branch <branche>` rend « zéro run »
pour le chemin même que la ligne suivante recommande. Mesuré le 29 août 2026 sur
la PR #273 : deux runs `workflow_dispatch` en `completed/success`, une review
d'Aristarque publiée sur la PR, et `--branch feat/clip-screen-shell` n'en montrait
aucun — un orchestrateur y a perdu une ronde, en réveillant un intégrateur pour
lui annoncer un silence qui n'existait pas. Lire `event` et `headBranch` ligne par
ligne plutôt que filtrer.
A run that completed with no comment is the other half, and only then are
`gh secret list` and the quota worth reading. Prefer the dispatch to an
`@aristarque review` comment: same result, no public trace on a public repo.

## `mergeStateStatus: BLOCKED` means an unresolved conversation

Not a missing approval. The gate is an active **ruleset** named
"Protection de main" requiring conversation resolution. Classic branch
protection is not configured, so `repos/<owner>/<repo>/branches/main/protection`
returns **404** — do not look there, and do not conclude the branch is
unprotected. Resolve the threads and the state clears.

## Arming `gh pr merge --auto` is safe on `BLOCKED`, dangerous on `CLEAN`

`check-reviews` has you arm the auto-merge from inside the loop, before the last
round of fixes, so the merge survives an agent that dies between the push and
the merge. That is correct **while something still blocks the merge**. On
`CLEAN`, GitHub merges on the spot — before the fixes you were about to push.
Check the state before arming.

## Count bot passes by reviewer login

An agent answering its own threads posts under the human's GitHub account, so
the `reviews` array overstates the round count badly — measured here at twelve
entries for four actual bot passes. Group by `.author.login` and count only the
bot logins (`copilot-pull-request-reviewer`, `chatgpt-codex-connector`) plus
Aristarque's comments.
