import { windowTextWithAnchors, type Transcript, type Window } from '@/core/transcript'

/**
 * Les deux prompts du repérage, **repris mot pour mot** de
 * `openshorts/gemini_worker.py:212-251` et `:253-331`.
 *
 * Ils sont en anglais et le restent : c'est le texte qui a été calibré en
 * production, et le traduire referait le calibrage à zéro sans rien apprendre.
 * La langue du transcript, elle, est une variable du prompt — le modèle écrit
 * les titres et les descriptions en français parce que `TRANSCRIPT_LANGUAGE` le
 * lui dit.
 *
 * **Deux choses ne se reformulent pas.** Le barème ancré du prompt de notation
 * (0-19 / 20-49 / 50-79 / 80-100) existe parce que les lots sont notés dans des
 * appels séparés : sans échelle partagée, un lot médiocre s'étale sur 40-80 et
 * un lot excellent sur 60-95, et les trier ensemble compare deux règles
 * différentes. La règle des 2 secondes est le critère principal, mesuré comme
 * tel. Les toucher invalide le calibrage.
 *
 * **La seule modification volontaire : la ligne « Each clip must be 15 to 60
 * seconds long » a disparu du prompt de détail.** La durée est un résultat,
 * jamais une contrainte d'entrée (spec §5), et ce plafond est précisément le
 * défaut qui a motivé le projet — une vanne de 90 secondes dont OpenShorts
 * gardait 25 secondes de préambule et coupait la chute. Un test vérifie
 * qu'aucun plafond de durée ne revient par une autre formulation.
 *
 * Les accents graves du texte d'origine (`` `score` ``, `` `reason` ``…) sont
 * échappés parce que TypeScript en fait des délimiteurs de gabarit. La chaîne
 * produite, elle, est identique caractère pour caractère.
 */

export type ScorePromptInput = {
  /** La langue du transcript, telle que WhisperX l'a détectée. */
  language: string
  /** La durée de la source, en secondes. */
  videoDuration: number
  /** Les fenêtres du lot, déjà sérialisées — voir `scoreWindowsJson`. */
  windowsJson: string
}

export function scorePrompt({ language, videoDuration, windowsJson }: ScorePromptInput): string {
  return `
You are a senior short-form video strategist.
Score every candidate window in this batch on its potential as a short.

Rules:
- Return only valid JSON.
- Score EVERY window in this batch. Do not omit any, however weak — a low score
  is the right answer for weak material, silence is not.
- \`score\` must be an integer from 0 to 100, on this scale:
  - 80-100: opens on a hook, stands alone without context, clear payoff.
  - 50-79: a real moment, but it needs a better entry point or trails off.
  - 20-49: on-topic filler — explanation, setup, housekeeping, rambling.
  - 0-19: no usable moment at all — outros, admin, dead air, pure transition.
  Use the whole scale. A batch where everything scores 70 is a batch you have
  not separated.
- THE 2-SECOND TEST is the main criterion: would the first 2 seconds of this
  moment force a cold viewer (no context) to keep watching? Windows that only
  work with prior context score low.
- Prefer windows with strong hooks, conflict, surprise, outrage, emotion,
  novelty, big numbers, or a clear payoff.
- \`reason\` is at most 8 words.

TRANSCRIPT_LANGUAGE: ${language}
VIDEO_DURATION_SECONDS: ${videoDuration}
WINDOWS_JSON:
${windowsJson}

Return only:
{
  "windows": [
    {
      "id": "<window id>",
      "start": <number>,
      "end": <number>,
      "score": <integer 0-100>,
      "reason": "<very short reason>"
    }
  ]
}
`
}

/**
 * Le « HOOK PLAYBOOK » : les cinq patrons d'accroche, **anglais et fixes**,
 * pour la même raison que le reste de ce fichier — c'est le texte calibré, le
 * traduire referait le calibrage à zéro.
 *
 * **Extrait de `detailPrompt` plutôt que réénumérés dans `hookPrompt`.** Les
 * deux prompts en ont besoin — la passe de détail les pose sur
 * `viral_hook_text`, `hookPrompt` régénère un hook seul — et deux listes
 * recopiées à la main dérivent au premier patron ajouté ou reformulé, le même
 * défaut que `CLAUDE.md` documente pour un bornage réécrit deux fois plutôt
 * qu'importé (« un correctif compris comme local revient au champ suivant »).
 */
export const HOOK_PATTERNS = `HOOK PLAYBOOK — pick the strongest fitting pattern for \`viral_hook_text\` (max 6 words):
- Open question: "Why does everyone get this wrong?"
- Hot take / controversy: "Stop doing this. Seriously."
- Number / fact shock: "97% of people miss this."
- Story loop: "This one email almost ruined me."
- POV / pattern interrupt: "POV: you finally understand it."
(These are English PATTERNS — always write the actual hook in TRANSCRIPT_LANGUAGE.)`

/**
 * Le brief du badge : la pastille courte posée **au-dessus** de l'accroche.
 * Anglais et fixe, comme tout ce fichier, et **partagé par les deux prompts**
 * pour la raison écrite sur `HOOK_PATTERNS` — deux briefs recopiés à la main
 * dérivent au premier ajustement.
 *
 * **Toute la consigne tient dans « rendre vide plutôt qu'inventer ».** Un
 * modèle remplit systématiquement un champ facultatif si on ne l'en dissuade
 * pas, et un badge sur chaque clip est exactement le contraire de ce qu'un
 * badge sert à faire : signaler qu'un clip appartient à une rubrique
 * récurrente. Sur toute la ligne, le badge est facultatif — absent du
 * `required` de `SCHEMA_DETAIL`, `.optional()` côté zod, vide par défaut en
 * base.
 */
export const HOOK_BADGE_BRIEF = `BADGE — an OPTIONAL 1-3 word kicker that sits ABOVE the hook, in a small
coloured pill (e.g. "DÉFI 10", "EPISODE 4", "BACKSTAGE"). Only return one when
the clip really carries a label of that kind: a numbered challenge, a segment
name, a recurring rubric. Return an EMPTY STRING rather than inventing one — a
badge on every clip is noise, not a signal. Never repeat or paraphrase the hook
in it.
(Write it in TRANSCRIPT_LANGUAGE.)`

export type DetailPromptInput = {
  language: string
  videoDuration: number
  /** Les fenêtres présélectionnées, texte ancré compris — voir `detailWindowsJson`. */
  windowsJson: string
  /**
   * Les cibles de nombre de clips, **calculées avant la fusion des fenêtres**
   * par `clipCountTargets(nombre de fenêtres retenues)`. Fusionner remanie la
   * charge utile, cela ne retire pas de matière : faire dépendre le plancher du
   * nombre de blocs le ferait bouger parce que deux fenêtres se trouvent
   * voisines, alors qu'il repose sur une mesure de rétention.
   */
  minClips: number
  maxClips: number
}

export function detailPrompt({
  language,
  videoDuration,
  windowsJson,
  minClips,
  maxClips,
}: DetailPromptInput): string {
  return `
You are a senior short-form video editor and viral copywriter.
Choose the BEST short clips from these shortlisted candidate windows.

READING THE TRANSCRIPT — each window's text is interleaved with markers like
[123.400]. Each one is the EXACT absolute time, in seconds from the start of the
source video, at which the sentence that follows it begins. They are measured,
not estimated. Use them:
- Take \`start\` from the marker of the sentence the clip should open on.
- Take \`end\` from the marker of the sentence AFTER the last one you want, or
  from the window's own end if you want the last sentence in it.
- Never invent a time that is not derived from a marker. Do not interpolate
  inside a sentence, and do not round a marker to a whole number.

CLIP RULES:
- Return only valid JSON.
- Stay within the candidate window boundaries.
- THE 2-SECOND RULE: the clip MUST open on its strongest moment. If the first
  2 seconds would not stop a cold viewer from scrolling, move the start or skip the clip.
- Start slightly before the hook and end slightly after the payoff when possible.
- Do not cut in the middle of a word or phrase.
- No generic intros/outros unless they are the hook.
- STANDS ALONE: the clip must make sense to someone who has seen nothing else.
  If it opens on a pronoun, a "that", a "so anyway", or an answer whose question
  was asked earlier, move the start back to where the idea begins or skip it.
  A brilliant moment that needs the previous five minutes is not a clip.
  Fix this by moving the START earlier, never by cutting the ending short: a
  clip that loses its payoff to gain context has traded down.
- HOW MANY: return ${minClips} to ${maxClips} clips. Work through EVERY candidate
  window — they were already scored as the best moments in the video, so a window
  that yields nothing should be the exception, not the norm. Two or three clips
  from one window are fine when they are genuinely different moments. The rules
  above let you skip a weak clip; they are not a licence to return one clip and
  stop. Only fall short of ${minClips} when the material truly does not hold
  them, and never pad with a clip you would not publish yourself.
- DIVERSITY: never return two clips that make the same point, tell the same
  story, or land the same joke — even across different windows. Pick the
  stronger one and drop the other. Two clips on the same broad topic are fine
  as long as each lands its own moment.

${HOOK_PATTERNS}

${HOOK_BADGE_BRIEF}

COPY RULES — ALL text fields (descriptions, title, hook) MUST be written in TRANSCRIPT_LANGUAGE (${language}):
- Descriptions (TikTok + Instagram): 1-2 punchy sentences that tease the payoff
  without spoiling it, then 3-5 topically relevant hashtags. No generic hashtag spam.
- \`video_title_for_youtube_short\`: max 100 chars, curiosity-driven, no fake claims.
- \`predicted_score\`: honest 0-100 estimate of viral potential. Use the whole
  range — if every clip scores the same, you have not ranked them.
- ORDER the \`shorts\` array by predicted performance, best first. Do NOT return
  them in transcript order.

TRANSCRIPT_LANGUAGE: ${language}
VIDEO_DURATION_SECONDS: ${videoDuration}
CANDIDATE_WINDOWS_JSON:
${windowsJson}

Return only:
{
  "shorts": [
    {
      "start": <number>,
      "end": <number>,
      "source_window_id": "<window id>",
      "predicted_score": <integer 0-100>,
      "video_description_for_tiktok": "<description + hashtags>",
      "video_description_for_instagram": "<description + hashtags>",
      "video_title_for_youtube_short": "<title max 100 chars>",
      "viral_hook_text": "<short overlay max 6 words>",
      "viral_hook_badge": "<optional 1-3 word kicker, or empty string>"
    }
  ]
}
`
}

export type HookPromptInput = {
  /** La langue du transcript, telle que WhisperX l'a détectée. */
  language: string
  title: string
  description: string
  /**
   * Les phrases du clip, dans l'ordre — le texte que le clip contient
   * **actuellement** (`clip.segments`), pas la fenêtre de contexte que
   * l'écran de montage affiche autour.
   */
  lines: readonly string[]
  /** Le plafond de mots — `HOOK_TEXT_MAX_WORDS` de `@/core/hook`, dupliqué en
   * paramètre plutôt qu'importé : ce fichier reste pur et sans dépendance vers
   * `@/core/hook`, comme le reste de `src/core/gemini/`. */
  maxWords: number
  /** Le plafond de mots du badge — `HOOK_BADGE_MAX_WORDS`, passé pour la même raison. */
  maxBadgeWords: number
}

/**
 * Régénère le hook d'un clip **déjà choisi** — contrairement à `detailPrompt`,
 * qui le propose parmi d'autres champs sur des fenêtres encore candidates.
 *
 * **Deux champs en sortie**, `{ hook, badge }` : ce prompt ne rejuge ni le
 * titre ni la description, il ne fait que réécrire l'accroche et sa pastille à
 * partir de ce que le clip contient maintenant — utile après une coupe qui a
 * déplacé l'ouverture, ou simplement parce que la première proposition ne
 * convainc pas. Les deux ensemble et non l'un sans l'autre : une accroche
 * neuve sous une pastille écrite pour l'ancienne accolerait un sur-titre à une
 * ligne pour laquelle il n'a jamais été écrit.
 */
export function hookPrompt({
  language,
  title,
  description,
  lines,
  maxWords,
  maxBadgeWords,
}: HookPromptInput): string {
  return `
You are a senior short-form video viral copywriter.
Write ONE short hook overlay for this already-selected clip — the text burned
onto the very first frame to stop a cold viewer from scrolling.

${HOOK_PATTERNS}

${HOOK_BADGE_BRIEF}

RULES:
- Return only valid JSON.
- \`hook\` is at most ${maxWords} words, written in TRANSCRIPT_LANGUAGE (${language}).
- \`badge\` is at most ${maxBadgeWords} words, or an empty string when the clip
  carries no such label. Prefer the empty string.
- No surrounding quotes.
- Base it on what the clip actually says below — not the title or description alone.

TRANSCRIPT_LANGUAGE: ${language}
TITLE: ${title}
DESCRIPTION: ${description}
CLIP_TEXT:
${lines.join('\n')}

Return only:
{
  "hook": "<short overlay max ${maxWords} words>",
  "badge": "<optional kicker max ${maxBadgeWords} words, or empty string>"
}
`
}

/**
 * Les fenêtres du lot de notation, sérialisées pour `WINDOWS_JSON`.
 *
 * Quatre clés nommées, et pas la fenêtre entière : `segFrom`/`segTo` sont de la
 * plomberie interne, et les envoyer inviterait le modèle à s'en servir comme
 * d'une position — il rendrait alors un `start` en index de segment. La prose
 * est celle de `buildWindows`, sans ancres : la notation juge un moment, elle
 * n'a pas de borne à rendre.
 */
export function scoreWindowsJson(windows: Window[]): string {
  return JSON.stringify(
    windows.map((w) => ({ id: w.id, start: w.start, end: w.end, text: w.text })),
  )
}

/**
 * Les fenêtres présélectionnées, avec un marqueur `[SECONDS]` par phrase.
 *
 * C'est la différence entre les deux passes : la passe de détail doit rendre des
 * secondes absolues, donc elle reçoit de vraies ancres au lieu d'interpoler une
 * position dans 90 secondes de prose.
 */
export function detailWindowsJson(windows: Window[], tx: Transcript): string {
  return JSON.stringify(
    windows.map((w) => ({
      id: w.id,
      start: w.start,
      end: w.end,
      text: windowTextWithAnchors(w, tx),
    })),
  )
}

// ---------------------------------------------------------------------------
// La correction du transcript (spec §9, étage 2)
// ---------------------------------------------------------------------------

export type CorrectionPromptInput = {
  /** La langue du transcript, telle que WhisperX l'a détectée. */
  language: string
  /** Les mots de l'empan, sérialisés — voir `correctionWordsJson`. */
  wordsJson: string
}

/**
 * Le prompt de la correction du transcript par modèle (spec §9).
 * @remarks En anglais comme les deux autres prompts de ce fichier — un
 * modèle suit des consignes en anglais plus fidèlement, quelle que soit la
 * langue du texte à corriger. La garantie vient du contrat de sortie et de
 * `validateCorrections` (`@/core/correction`), pas de ce texte : rien ici
 * n'empêche techniquement le modèle d'halluciner.
 */
export function correctionPrompt({ language, wordsJson }: CorrectionPromptInput): string {
  return `
You are a meticulous French transcription proofreader.
Fix punctuation, French homophones (et/est, a/à, ces/ses/c'est/s'est, and
similar), and grammatical agreement mistakes in this transcript excerpt —
nothing else.

READING THE WORDS — each word of the excerpt is given as {"i": <index>, "w": "<word>"}
in WORDS_JSON, in the original order. \`i\` is its position in THIS excerpt,
starting at 0.

Rules:
- Return only valid JSON.
- Return ONLY the words that need a correction — do not repeat words that are
  already correct.
- For a single-word fix, return { "i": <index>, "w": "<corrected word>" }.
- To fix a mistake spread over several consecutive words, return
  { "i": <first index>, "merge": <word count>, "w": "<single corrected token>" } —
  \`merge\` collapses that many consecutive original words into ONE replacement.
- \`w\` is always a SINGLE token: never put a space in it. Use a hyphen if the
  correct spelling needs one.
- Never invent a word, delete one, or reorder the excerpt — only replace what
  is already there, word for word. If nothing needs fixing, return an empty array.
- Proper nouns belonging to the show (e.g. "Avolo") are corrected the same
  way when misheard, but do not invent a name that is not actually there.
- Stay as close as possible to the sound of the original word or words —
  turning a mistake into an unrelated word is never a correction.

TRANSCRIPT_LANGUAGE: ${language}
WORDS_JSON:
${wordsJson}

Return only:
{ "corrections": [ { "i": <number>, "merge": <optional number>, "w": "<token>" } ] }
`
}

/**
 * Les mots d'un empan, sérialisés pour `WORDS_JSON` — indexés dans l'empan
 * lui-même, pas dans le transcript entier : c'est cet index-là que le modèle
 * doit rendre dans `i`.
 */
export function correctionWordsJson(words: readonly string[]): string {
  return JSON.stringify(words.map((w, i) => ({ i, w })))
}
