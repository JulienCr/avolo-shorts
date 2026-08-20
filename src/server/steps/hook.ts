import type Database from 'better-sqlite3'
import { z } from 'zod'

import type { Segment } from '@/core/edl'
import { parseJsonResponse } from '@/core/gemini/parse'
import { hookPrompt } from '@/core/gemini/prompts'
import { normalizeHookBadge, normalizeHookText } from '@/core/hook'
import { getClip, getProject } from '@/server/db'
import { createCallFromSettings } from '@/server/llm/registry'
import type { JsonSchema, LlmCallConfig, LlmMode } from '@/server/llm/types'
import { leverIfBlocked, type TranscriptLu } from '@/server/steps/candidates'
import { projectTranscript } from '@/server/views'

/**
 * La génération du hook d'un clip — **premier appelant de l'usage `'hook'`**
 * (`@/server/llm/registry`, `LlmUsage`). La chaîne existe depuis la PR
 * précédente : réglages, persistance, câblage du fournisseur. Il ne lui
 * manquait qu'un appelant, et c'est tout ce que ce fichier ajoute.
 *
 * **Deux appelants, aucun par le graphe.** Le bouton « Régénérer » de l'écran
 * Clip — un clip qu'on monte, à la demande — et le rattrapage qui part à la
 * transition `candidate → kept` quand l'accroche est vide
 * (`src/server/steps/hook-backfill.ts`). Zéro étape de graphe, zéro traitement
 * par lot : la lecture la plus économique et la plus fidèle de « uniquement
 * pour les clips réellement gardés, idéalement au moment où ils entrent dans
 * le workflow de montage ou à la demande ».
 *
 * Le cas courant ne passe par aucun des deux : la passe de détail du repérage
 * rend déjà `viral_hook_text` et `viral_hook_badge` dans la même réponse que
 * le titre, donc un clip naît avec son hook, sans un appel de plus.
 *
 * **Pas la politique de relance de `src/server/steps/candidates.ts`.**
 * L'escalier 5 s/10 s, les trois tentatives, l'attente de quota existent pour
 * un lot de trente appels derrière quarante minutes de pipeline sans personne
 * devant l'écran. Ici quelqu'un attend devant un bouton : un essai, un
 * message d'erreur clair, un bouton qu'on re-clique. Le jour où un deuxième
 * usage a besoin de cette politique, c'est là qu'elle s'extrait de
 * `candidates.ts` — pas avant.
 */

/**
 * Le plafond de mots demandé au modèle. **Dupliqué depuis `HOOK_TEXT_MAX_WORDS`
 * de `@/core/hook`, pas importé** : cette constante-là n'est pas exportée — ce
 * fichier ne fait qu'informer le prompt, l'application réelle du plafond reste
 * `normalizeHookText`, seule autorité sur la forme du texte rendu. Un écart
 * entre les deux valeurs serait sans conséquence : le modèle recevrait une
 * consigne légèrement différente du plafond réel, que `normalizeHookText`
 * applique de toute façon après coup.
 */
const HOOK_PROMPT_MAX_WORDS = 6

/**
 * Le plafond de mots du badge demandé au modèle. **Dupliqué depuis
 * `HOOK_BADGE_MAX_WORDS` de `@/core/hook` pour la même raison que
 * ci-dessus** : cette constante-là n'est pas exportée, et l'autorité sur la
 * forme rendue reste `normalizeHookBadge`.
 */
const HOOK_BADGE_PROMPT_MAX_WORDS = 3

/**
 * Le délai au-delà duquel l'appel est abandonné, en millisecondes. Plus court
 * que celui du repérage (`DELAY_CALL_MS`, 120 s) : personne n'attend une
 * passe de repérage devant son écran, mais ici quelqu'un attend ce bouton.
 */
const TIMEOUT_MS = 30_000

const SCHEMA_HOOK: JsonSchema = {
  type: 'object',
  properties: { hook: { type: 'string' }, badge: { type: 'string' } },
  // **`badge` est requis ici, contrairement à `SCHEMA_DETAIL`.** L'appel n'a
  // qu'une tâche et le modèle sait quoi rendre quand il n'a rien à proposer :
  // la chaîne vide, que `HOOK_BADGE_BRIEF` lui demande explicitement de
  // préférer. La passe de détail, elle, rend une douzaine de champs sur des
  // fenêtres encore candidates — y exiger le badge le pousserait à en
  // inventer un par clip.
  required: ['hook', 'badge'],
}

// `.catch('')` sur le badge : une réponse de l'ancienne forme, ou un modèle
// qui l'omet malgré le schéma, ne doit pas coûter la régénération entière.
const RESPONSE_HOOK = z.object({ hook: z.string(), badge: z.string().catch('') })

function configuration(mode: LlmMode): LlmCallConfig {
  if (mode !== 'hook') {
    // Ce fichier ne configure que la génération du hook : un appel dans un
    // autre mode ne peut venir que d'un défaut de câblage.
    throw new Error(
      `configuration(mode) de la génération du hook appelée avec le mode '${mode}' : seul 'hook' est attendu ici.`,
    )
  }
  return { schema: SCHEMA_HOOK, temperature: 0.9, maxOutputTokens: 256 }
}

/**
 * Les phrases que le clip contient **actuellement** (`clip.segments`), dans
 * l'ordre — pas la fenêtre de contexte que l'écran de montage affiche autour
 * (`clipLinesAround`, `CONTEXT_S`), qui déborderait le clip des deux côtés.
 *
 * **Filtre au mot, pas au segment Whisper entier.** Une coupe au milieu d'une
 * phrase ou une suppression centrale laisse le segment Whisper chevaucher un
 * morceau gardé sans que tout son texte y tienne : reprendre `s.text` tel
 * quel enverrait au modèle des mots retirés du clip. Seul un segment dépourvu
 * de mots horodatés (WhisperX en émet, voir `lireTranscript`) retombe sur son
 * `text` entier.
 */
function linesInClip(transcript: TranscriptLu, segments: readonly Segment[]): string[] {
  return transcript.segments
    .filter((s) => segments.some((seg) => s.end > seg.start && s.start < seg.end))
    .map((s) => {
      if (s.words.length === 0) return s.text.trim()
      return s.words
        .filter((w) => segments.some((seg) => w.end > seg.start && w.start < seg.end))
        .map((w) => w.word.trim())
        .filter((w) => w !== '')
        .join(' ')
    })
    .filter((t) => t !== '')
}

/**
 * Régénère le hook d'un clip déjà gardé : **l'accroche ET sa pastille**.
 *
 * **`generateHook` et non `generateHookText`.** La fonction a changé de nature
 * en changeant de retour, et garder un nom qui dit « text » sur ce qui rend
 * deux champs coûterait une relecture par mois.
 *
 * **Un texte vide rendu par le modèle est une réponse valide**, pas une
 * erreur : c'est ce que `hookIsBurned` (`@/core/hook`) attend pour ne rien
 * incruster. Un badge vide l'est encore plus — c'est même ce que
 * `HOOK_BADGE_BRIEF` demande de préférer.
 */
export async function generateHook(
  db: Database.Database,
  clipId: string,
  params: { signal?: AbortSignal } = {},
): Promise<{ text: string; badge: string }> {
  const clip = getClip(db, clipId)
  if (clip === undefined) throw new Error(`Clip inconnu : ${clipId}`)
  const project = getProject(db, clip.projectId)
  if (project === undefined) throw new Error(`Projet inconnu : ${clip.projectId}`)

  const transcript = await projectTranscript(project)
  const lines = transcript === null ? [] : linesInClip(transcript, clip.segments)

  const prompt = hookPrompt({
    language: transcript?.language ?? 'fr',
    title: clip.title,
    description: clip.description,
    lines,
    maxWords: HOOK_PROMPT_MAX_WORDS,
    maxBadgeWords: HOOK_BADGE_PROMPT_MAX_WORDS,
  })

  // **La clé se lit ici**, avant tout appel réseau — c'est ce qui fait
  // échouer un fournisseur sans clé tout de suite, avec un message lisible,
  // plutôt qu'au milieu d'une requête `fetch`.
  const call = createCallFromSettings(db, 'hook', {
    signal: params.signal,
    timeoutMs: TIMEOUT_MS,
    config: configuration,
  })

  const response = await call(prompt, 'hook')
  // Un refus de contenu ne se réessaie jamais : la même politique que le
  // repérage, réutilisée plutôt que réécrite.
  leverIfBlocked(response)

  const raw = parseJsonResponse(response.text ?? '')
  const lu = RESPONSE_HOOK.safeParse(raw)
  if (!lu.success) {
    throw new Error(`Réponse du fournisseur inexploitable pour le hook : ${lu.error.message}`)
  }

  return { text: normalizeHookText(lu.data.hook), badge: normalizeHookBadge(lu.data.badge) }
}
