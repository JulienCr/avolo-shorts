import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { buildInjectTemplate, createBatchInjector, parseInjectOutput, type BatchInjector } from '@/server/op-inject'

/**
 * Les secrets ne vivent pas dans le `.env` : il en porte l'**adresse**.
 *
 *     GEMINI_API_KEY=op://Personal/Avolo-Shorts/GEMINI_API_KEY
 *
 * Au démarrage, ce module parcourt l'environnement, repère les valeurs qui
 * commencent par `op://` et les remplace par ce que 1Password rend. Une valeur
 * littérale, elle, ne traverse rien du tout : `op://` est une possibilité, pas
 * une obligation, et c'est ce qui garde utilisables un dépôt fraîchement cloné
 * et un CI qui n'a pas 1Password.
 *
 * ## Pourquoi pas `op run`, qui est la voie canonique
 *
 * `op run --env-file=.env -- next dev` résout les références et injecte les
 * valeurs dans l'environnement du processus. C'est ce que 1Password documente,
 * et le doute qui a motivé la mesure était que le `.env` est **relu après** le
 * lancement — Next le charge tout seul, et `chargerEnv()` appelle
 * `process.loadEnvFile` pour les scripts `tsx`. Si ce second chargement écrasait
 * une variable déjà posée, `op run` serait cassé en silence : la vraie clé
 * injectée, puis remplacée par la chaîne `op://…`, et un 401 du fournisseur
 * d'API qui accuse la clé.
 *
 * **Mesuré le 18 août 2026, le piège n'existe pas.** Ni `process.loadEnvFile`
 * (Node 22.22.1) ni `@next/env` (16.3.1) n'écrasent une variable déjà présente
 * dans l'environnement : le premier ignore la ligne du fichier, le second
 * compare à un instantané de `process.env` pris au tout premier chargement.
 * `chargerEnv()` réapplique de surcroît l'environnement de départ par-dessus.
 *
 * `op run` reste donc écarté, mais pour ses coûts, pas pour ce risque :
 *
 * - il rendrait `op` **obligatoire**. Un `.env` à valeurs littérales ne
 *   démarrerait plus sans 1Password installé, alors que rien dans ce projet ne
 *   l'exige ;
 * - il faudrait le préfixer partout — `pnpm dev`, `pnpm start`, et chacun des
 *   `pnpm tsx scripts/dev-*.ts` ;
 * - il ne peut rien dire de plus qu'« la variable est vide » quand ça rate,
 *   alors que la moitié de la valeur de ce fichier est dans ses messages
 *   d'erreur.
 *
 * ## Ce que ça coûte
 *
 * **2,5 s** pour un `op read`, mesuré sur cette machine à froid comme à chaud.
 * Un `op read` par référence en parallèle demande une approbation 1Password
 * par process ; `op inject` résout tout le lot en un seul, donc une seule
 * approbation. Voir le corps de la PR pour la mesure complète.
 *
 * ## Comment `op` s'authentifie ici
 *
 * Par l'**intégration avec l'application de bureau** — 1Password 8 pour Windows,
 * vu depuis WSL —, pas par un jeton de compte de service : aucun
 * `OP_SERVICE_ACCOUNT_TOKEN` n'est posé sur cette machine. La conséquence
 * pratique est qu'une lecture peut **bloquer sur une approbation** quand
 * l'application est verrouillée. Une approbation au démarrage est tenable ; une
 * par appel d'API ne le serait pas.
 */

const execFileP = promisify(execFile)

/**
 * Les préfixes qu'une adresse de secret peut porter. Un seul aujourd'hui, celui
 * de 1Password.
 *
 * **La liste est exportée parce qu'elle en contraint une autre.**
 * `src/core/errors.ts` caviarde les références dans les messages servis par
 * l'API, et la frontière de pureté lui interdit d'importer ce fichier : il en
 * recopie donc le préfixe à la main. Deux exemplaires d'une même vérité ne se
 * contraignent pas tout seuls, et la dépendance a vécu un temps en commentaire
 * des deux côtés — ce qui ne la faisait échouer nulle part.
 * `tests/core/errors.test.ts` lit désormais cette liste et exige que chacune
 * de ses formes ressorte caviardée : un préfixe ajouté ici sans passe
 * correspondante là-bas fait rougir la suite au lieu de sortir en silence sur
 * un dépôt public. (issue #49)
 */
export const REFERENCE_PREFIXES: readonly string[] = ['op://']

/**
 * Ce qu'on laisse à `op`. Une lecture coûte 2,5 s, mais l'application peut
 * demander une approbation biométrique et l'humain n'est pas toujours devant.
 * Le délai borne la panne : sans lui, un démarrage attendrait indéfiniment une
 * fenêtre que personne ne regarde.
 */
const DELAY_MS = 60_000

/** Le binaire, surchargeable comme `FFMPEG_BIN` l'est pour ffmpeg. */
function opBin(): string {
  return process.env.OP_BIN || 'op'
}

/** Ce qui lit un secret. Injecté par les tests, qui ne lancent jamais `op`. */
export type SecretPlayer = (reference: string) => Promise<string>

/** Résout tout un lot de références en un seul `op inject`. Voir `src/server/op-inject.ts`. */
const injectViaOp: BatchInjector = (template) =>
  createBatchInjector({ bin: opBin(), timeoutMs: DELAY_MS })(template)

/**
 * Un environnement, et non `NodeJS.ProcessEnv`.
 *
 * `next typegen` rend `NODE_ENV` **obligatoire** sur `ProcessEnv` : un test qui
 * passe `{ GEMINI_API_KEY: 'op://…' }` ne compilerait pas, et devrait poser un
 * `NODE_ENV` qui n'a rien à voir avec ce qu'il vérifie. `process.env` reste
 * assignable à ce type-ci.
 */
export type Environment = Record<string, string | undefined>

/**
 * Ce qu'une référence nomme, sans son préfixe — `<coffre>/<fiche>/<champ>` —,
 * ou `undefined` quand la valeur n'est pas une référence.
 *
 * Le préfixe se sépare ici plutôt que chez l'appelant parce que c'est ici qu'on
 * sait lequel a mordu. `redactReferencesKnown` (`src/server/errors.ts`)
 * s'en sert pour retirer d'un message d'erreur la référence entière **en
 * remettant son préfixe derrière** : c'est lui qui dit que la variable portait
 * une adresse et non une valeur littérale.
 *
 * Le corps d'un préfixe nu est la chaîne vide, et non `undefined` :
 * `op://` reste une référence — mal formée, mais une référence —, simplement
 * elle ne nomme rien.
 */
export function referenceBody(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const prefix = REFERENCE_PREFIXES.find((p) => value.startsWith(p))
  return prefix === undefined ? undefined : value.slice(prefix.length)
}

/** Une valeur est-elle une adresse plutôt qu'un secret ? */
export function isReference(value: string | undefined): boolean {
  return referenceBody(value) !== undefined
}

/**
 * Lit une référence par `op read`.
 *
 * `--no-newline` n'est pas une coquetterie : sans lui, `op` ajoute un saut de
 * ligne qu'il faudrait retirer — et retirer un saut de ligne final abîmerait un
 * secret qui en porte un pour de bon (une clé privée, par exemple).
 */
export async function lireInOnePassword(reference: string): Promise<string> {
  const { stdout } = await execFileP(opBin(), ['read', '--no-newline', reference], {
    encoding: 'utf8',
    timeout: DELAY_MS,
  })
  return stdout
}

/**
 * Le diagnostic de `op`, débarrassé de ce qui n'apprend rien.
 *
 * On lit `stderr` en priorité : le `message` d'une erreur d'`execFile` le
 * recopie, mais précédé d'un `Command failed: …` qui répète une commande qu'on
 * cite déjà. **Ni l'un ni l'autre ne porte la valeur du secret** — `stdout`, qui
 * la porterait, n'est jamais lu ici.
 */
function diagnostic(cause: unknown): string {
  const error = cause as (Error & { stderr?: unknown }) | undefined
  const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
  const raw = stderr.trim() !== '' ? stderr : (error?.message ?? String(cause))
  return raw
    .split('\n')
    // `[ERROR] 2026/08/18 15:07:28 ` : un horodatage à la seconde dans un
    // message d'erreur qui sera lu des mois plus tard ne dit rien à personne.
    .map((line) => line.replace(/^\[ERROR]\s+\S+\s+\S+\s+/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('Command failed:'))
    .join(' ')
}

/**
 * Ce que dit 1Password quand il n'est ni déverrouillé ni autorisé.
 *
 * **Des phrases, pas des mots isolés.** Le diagnostic testé contient le nom du
 * coffre, de la fiche et du champ : un champ nommé `signin`, `unlock` ou
 * `authorization` faisait répondre « déverrouiller 1Password » à un champ
 * simplement absent. Une phrase de plusieurs mots ne se confond pas avec un nom
 * de champ, et une phrase qu'on aurait manqué ici retombe sur le remède
 * générique — qui montre de toute façon le diagnostic brut. Le sens de l'erreur
 * est celui-là. (relevé par Copilot et par Aristarque)
 */
const NOT_UNLOCKED =
  /not (?:currently )?signed in|(?:isn'?t|not) authoriz|connecting to desktop app|authorization (?:prompt|timeout)/i

/**
 * Le remède, et c'est tout l'intérêt de ce fichier.
 *
 * Sans lui, une clé qu'on n'a pas su lire part telle quelle chez le fournisseur
 * d'API et revient en 401 — qui accuse la clé, alors que la cause est un
 * 1Password verrouillé, une fiche renommée ou un `op` absent. Trois causes, trois
 * gestes différents : les distinguer ici évite de les chercher là-bas.
 */
function fix(cause: unknown): string {
  if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return (
      'La commande « op » est introuvable. Installer 1Password CLI ' +
      '(https://developer.1password.com/docs/cli/get-started/), poser OP_BIN sur son ' +
      'chemin, ou remettre la valeur littérale dans .env.'
    )
  }
  // **Le délai a un message à lui**, et c'est le seul cas où `op` n'a rien
  // écrit du tout : `execFile` le tue par un signal, `stderr` est vide, et le
  // `message` se réduit au `Command failed:` que `diagnostic` retire. Sans
  // cette branche, le remède commençait par un point isolé et ne nommait pas
  // la cause la plus probable — une approbation restée à l'écran.
  // (relevé par Copilot et par Aristarque)
  //
  // `killed` et non le code de sortie : mesuré, un dépassement de `maxBuffer`
  // rend `code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` et laisse `killed`
  // **indéfini**, tandis qu'un délai rend `code: null`, `killed: true`,
  // `signal: 'SIGTERM'`. Les deux ne se confondent donc pas. (relevé par
  // Aristarque, qui demandait à ce que ce soit vérifié)
  if ((cause as { killed?: unknown } | undefined)?.killed === true) {
    return (
      `1Password n'a pas répondu en ${DELAY_MS / 1000} s. L'application attend ` +
      "peut-être une approbation : la déverrouiller, puis relancer."
    )
  }
  const said = diagnostic(cause)
  // Une cause sans un mot à dire. Rare, mais un message qui commence par « . »
  // fait douter de sa propre exactitude.
  if (said === '') {
    return '`op` a échoué sans rien dire. « op read <référence> » rejoue l\'appel.'
  }
  const point = said.endsWith('.') ? '' : '.'
  if (NOT_UNLOCKED.test(said)) {
    return `${said}${point} Déverrouiller l'application 1Password, ou « op signin », puis relancer.`
  }
  return `${said}${point} « op read <référence> » rejoue l'appel ; vérifier le coffre, la fiche et le nom du champ.`
}

/**
 * La valeur d'un secret, ou une erreur qui dit pourquoi il n'y en a pas.
 *
 * **Le garde-fou du milieu est le seul qui ne soit pas évident**, et c'est celui
 * qui compte : une variable qui vaut *encore* `op://…` au moment de servir veut
 * dire que la résolution du démarrage a été défaite. Le cas mesuré est le
 * rechargement du `.env` par `next dev` (voir `src/instrumentation.ts`), qui
 * réapplique l'instantané pris avant `register()`. Sans ce contrôle, l'adresse
 * partirait comme clé chez le fournisseur d'API et reviendrait en 401 — soit
 * exactement le diagnostic faux que tout ce module existe pour éviter.
 * (relevé par Copilot)
 *
 * **Le message ne cite pas la référence**, contrairement à ceux de
 * `resolveSecrets`, et la différence n'est pas un oubli. Cette erreur-ci est
 * levée *en servant* : elle remonte par `runCandidates`, `status.json` et le
 * champ `error` de `GET /api/projects/:id` jusqu'à un client HTTP. Or
 * `cleanPaths` ne la nettoie pas — vérifié : `POSIX_BARE` exclut un `/`
 * précédé de `:` ou d'un autre `/`, donc `op://Personal/Avolo-Shorts/…` passe
 * intact —, et le nom du coffre et de la fiche sortiraient sur un dépôt public.
 * L'opérateur, lui, a son propre `.env` sous les yeux : la référence ne lui
 * apprend rien. Celles de `resolveSecrets` restent complètes parce qu'elles ne
 * quittent jamais le terminal du démarrage. (relevé par Aristarque)
 */
export function requireSecret(name: string, env: Environment = process.env): string {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} n'est pas définie. Voir .env.example.`)
  }
  if (isReference(value)) {
    throw new Error(
      `${name} vaut encore une adresse 1Password (op://…), donc la résolution du ` +
        'démarrage a été défaite — typiquement un .env modifié pendant que le serveur ' +
        'tourne. Relancer le serveur.',
    )
  }
  return value
}

type ReferenceOutcome =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly cause: unknown }

/**
 * Résout tout `references` en un seul `inject`. `op inject` échoue en bloc
 * dès qu'une référence est fausse et ne nomme que la première fautive : le
 * repli relit chaque référence séparément via `lire`, **en séquence, jamais
 * en parallèle** — c'est tout l'objet de cette fonction —, pour un diagnostic
 * par référence.
 */
async function resolveReferences(
  references: readonly string[],
  inject: BatchInjector,
  lire: SecretPlayer,
): Promise<Map<string, ReferenceOutcome>> {
  const nonce = randomUUID()
  const entries = references.map((reference) => ({ key: reference, reference }))
  try {
    const output = await inject(buildInjectTemplate(entries, nonce))
    const values = parseInjectOutput(output, entries, nonce)
    return new Map(
      references.map((reference) => [reference, { ok: true, value: values.get(reference) as string }]),
    )
  } catch {
    const outcomes = new Map<string, ReferenceOutcome>()
    for (const reference of references) {
      try {
        outcomes.set(reference, { ok: true, value: await lire(reference) })
      } catch (cause) {
        outcomes.set(reference, { ok: false, cause })
      }
    }
    return outcomes
  }
}

interface Failure {
  readonly name: string
  readonly reference: string
  readonly text: string
  /** Une cause qui touche le process (op introuvable, session verrouillée), pas une référence précise. */
  readonly systemic: boolean
}

/**
 * Une ligne par échec, sauf pour les causes `systemic` qui partagent le même
 * texte : op introuvable ou 1Password verrouillé touchent toutes les
 * références à l'identique, donc une seule ligne suffit plutôt que N copies.
 */
function formatFailures(failures: readonly Failure[]): string {
  const systemic = failures.filter((f) => f.systemic)
  const distinctTexts = new Set(systemic.map((f) => f.text))
  const systemicLines =
    distinctTexts.size === 1 && systemic.length > 1
      ? [systemic[0].text]
      : systemic.map((f) => `${f.name} : impossible de lire ${f.reference}. ${f.text}`)
  const perReferenceLines = failures.filter((f) => !f.systemic).map((f) => `${f.name} : ${f.text}`)
  return [...systemicLines, ...perReferenceLines].join('\n')
}

/**
 * Remplace dans `env` chaque référence `op://` par le secret qu'elle désigne, et
 * rend les noms des variables résolues — **les noms, jamais les valeurs** : ce
 * retour est fait pour être journalisé au démarrage.
 *
 * - **Sans référence, ni `inject` ni `lire` ne sont appelés** — traversable par
 *   un CI sans 1Password.
 * - **`OP_BIN` est hors du balayage** : une `OP_BIN=op://…` demanderait à `op`
 *   de se lire lui-même. (relevé par Aristarque)
 * - **Tout ou rien** : un échec ne laisse pas un environnement à moitié résolu.
 * - **Les échecs se cumulent**, sauf ceux qui partagent une cause `systemic`
 *   (voir `formatFailures`).
 */
export async function resolveSecrets(
  env: Environment = process.env,
  lire: SecretPlayer = lireInOnePassword,
  inject: BatchInjector = injectViaOp,
): Promise<readonly string[]> {
  // Trié : ce que la fonction rend finit dans un journal, et un journal dont
  // l'ordre suit celui d'énumération de `process.env` se compare mal d'un
  // lancement à l'autre.
  const names = Object.keys(env)
    .filter((name) => name !== 'OP_BIN' && isReference(env[name]))
    .sort()
  if (names.length === 0) return []

  // Une entrée par référence **distincte** dans le gabarit : deux variables
  // qui pointent le même champ n'en valent qu'une.
  const references: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const reference = env[name] as string
    if (!seen.has(reference)) {
      seen.add(reference)
      references.push(reference)
    }
  }

  const outcomes = await resolveReferences(references, inject, lire)

  const failures: Failure[] = []
  const resolved: [string, string][] = []
  for (const name of names) {
    const reference = env[name] as string
    const outcome = outcomes.get(reference) as ReferenceOutcome
    if (!outcome.ok) {
      failures.push({ name, reference, text: fix(outcome.cause), systemic: true })
    } else if (outcome.value === '') {
      // Un champ vidé dans 1Password rendrait une chaîne vide, que le garde-fou
      // de `clientParDéfaut` prendrait pour une variable absente — donc un
      // message qui accuse le `.env` alors que le `.env` est juste.
      failures.push({
        name,
        reference,
        text: `1Password rend une valeur vide pour ${reference}. Le champ est vide.`,
        systemic: false,
      })
    } else {
      resolved.push([name, outcome.value])
    }
  }
  if (failures.length > 0) throw new Error(formatFailures(failures))

  for (const [name, value] of resolved) env[name] = value
  return names
}
