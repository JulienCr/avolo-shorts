import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
 * Un sous-processus par référence distincte, et **2,5 s** par lecture — mesuré
 * sur cette machine, à froid comme à chaud : c'est le démarrage de `op` et
 * l'aller-retour vers l'application 1Password de Windows, pas le réseau. D'où
 * les trois précautions : on ne lit qu'au démarrage, on ne lit qu'une fois par
 * référence distincte, et on lit tout en parallèle (3,5 s pour deux, contre 5 s
 * en série).
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

/** Le préfixe d'une adresse de secret 1Password. */
const PRÉFIXE = 'op://'

/**
 * Ce qu'on laisse à `op`. Une lecture coûte 2,5 s, mais l'application peut
 * demander une approbation biométrique et l'humain n'est pas toujours devant.
 * Le délai borne la panne : sans lui, un démarrage attendrait indéfiniment une
 * fenêtre que personne ne regarde.
 */
const DÉLAI_MS = 60_000

/** Le binaire, surchargeable comme `FFMPEG_BIN` l'est pour ffmpeg. */
function opBin(): string {
  return process.env.OP_BIN || 'op'
}

/** Ce qui lit un secret. Injecté par les tests, qui ne lancent jamais `op`. */
export type LecteurDeSecret = (référence: string) => Promise<string>

/**
 * Un environnement, et non `NodeJS.ProcessEnv`.
 *
 * `next typegen` rend `NODE_ENV` **obligatoire** sur `ProcessEnv` : un test qui
 * passe `{ GEMINI_API_KEY: 'op://…' }` ne compilerait pas, et devrait poser un
 * `NODE_ENV` qui n'a rien à voir avec ce qu'il vérifie. `process.env` reste
 * assignable à ce type-ci.
 */
export type Environnement = Record<string, string | undefined>

/** Une valeur est-elle une adresse plutôt qu'un secret ? */
export function estRéférence(valeur: string | undefined): boolean {
  return valeur !== undefined && valeur.startsWith(PRÉFIXE)
}

/**
 * Lit une référence par `op read`.
 *
 * `--no-newline` n'est pas une coquetterie : sans lui, `op` ajoute un saut de
 * ligne qu'il faudrait retirer — et retirer un saut de ligne final abîmerait un
 * secret qui en porte un pour de bon (une clé privée, par exemple).
 */
async function lireDansOnePassword(référence: string): Promise<string> {
  const { stdout } = await execFileP(opBin(), ['read', '--no-newline', référence], {
    encoding: 'utf8',
    timeout: DÉLAI_MS,
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
  const erreur = cause as (Error & { stderr?: unknown }) | undefined
  const stderr = typeof erreur?.stderr === 'string' ? erreur.stderr : ''
  const brut = stderr.trim() !== '' ? stderr : (erreur?.message ?? String(cause))
  return brut
    .split('\n')
    // `[ERROR] 2026/08/18 15:07:28 ` : un horodatage à la seconde dans un
    // message d'erreur qui sera lu des mois plus tard ne dit rien à personne.
    .map((ligne) => ligne.replace(/^\[ERROR]\s+\S+\s+\S+\s+/, '').trim())
    .filter((ligne) => ligne !== '' && !ligne.startsWith('Command failed:'))
    .join(' ')
}

/** Ce que dit 1Password quand il n'est ni déverrouillé ni autorisé. */
const PAS_DÉVERROUILLÉ = /not signed in|sign ?in|not authoriz|unlock|desktop app|authorization/i

/**
 * Le remède, et c'est tout l'intérêt de ce fichier.
 *
 * Sans lui, une clé qu'on n'a pas su lire part telle quelle chez le fournisseur
 * d'API et revient en 401 — qui accuse la clé, alors que la cause est un
 * 1Password verrouillé, une fiche renommée ou un `op` absent. Trois causes, trois
 * gestes différents : les distinguer ici évite de les chercher là-bas.
 */
function remède(cause: unknown): string {
  if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return (
      'La commande « op » est introuvable. Installer 1Password CLI ' +
      '(https://developer.1password.com/docs/cli/get-started/), poser OP_BIN sur son ' +
      'chemin, ou remettre la valeur littérale dans .env.'
    )
  }
  const dit = diagnostic(cause)
  const point = dit.endsWith('.') ? '' : '.'
  if (PAS_DÉVERROUILLÉ.test(dit)) {
    return `${dit}${point} Déverrouiller l'application 1Password, ou « op signin », puis relancer.`
  }
  return `${dit}${point} « op read <référence> » rejoue l'appel ; vérifier le coffre, la fiche et le nom du champ.`
}

/**
 * Remplace dans `env` chaque référence `op://` par le secret qu'elle désigne, et
 * rend les noms des variables résolues — **les noms, jamais les valeurs** : ce
 * retour est fait pour être journalisé au démarrage.
 *
 * Trois propriétés tiennent le reste :
 *
 * - **Sans référence, `lire` n'est jamais appelé.** C'est ce qui rend ce chemin
 *   traversable par un CI sans 1Password et par un dépôt fraîchement cloné.
 * - **Tout ou rien.** Les lectures se font d'abord, les écritures ensuite : un
 *   échec ne laisse pas un environnement à moitié résolu, où la variable
 *   suivante partirait quand même chez le fournisseur d'API.
 * - **Les échecs se cumulent.** Deux références fausses valent deux lignes, pas
 *   deux démarrages ratés d'affilée.
 */
export async function résoudreSecrets(
  env: Environnement = process.env,
  lire: LecteurDeSecret = lireDansOnePassword,
): Promise<readonly string[]> {
  // Trié : ce que la fonction rend finit dans un journal, et un journal dont
  // l'ordre suit celui d'énumération de `process.env` se compare mal d'un
  // lancement à l'autre.
  const noms = Object.keys(env)
    .filter((nom) => estRéférence(env[nom]))
    .sort()
  if (noms.length === 0) return []

  // Une lecture par référence **distincte**. Deux variables qui pointent le
  // même champ ne valent pas deux allers-retours de 2,5 s, ni deux approbations.
  const lectures = new Map<string, Promise<string>>()
  for (const nom of noms) {
    const référence = env[nom] as string
    if (!lectures.has(référence)) lectures.set(référence, lire(référence))
  }

  const résultats = await Promise.allSettled([...lectures.values()])
  const valeurs = new Map<string, PromiseSettledResult<string>>()
  for (const [index, référence] of [...lectures.keys()].entries()) {
    valeurs.set(référence, résultats[index] as PromiseSettledResult<string>)
  }

  const échecs: string[] = []
  const résolus: [string, string][] = []
  for (const nom of noms) {
    const référence = env[nom] as string
    const résultat = valeurs.get(référence) as PromiseSettledResult<string>
    if (résultat.status === 'rejected') {
      échecs.push(`${nom} : impossible de lire ${référence}. ${remède(résultat.reason)}`)
    } else if (résultat.value === '') {
      // Un champ vidé dans 1Password rendrait une chaîne vide, que le garde-fou
      // de `clientParDéfaut` prendrait pour une variable absente — donc un
      // message qui accuse le `.env` alors que le `.env` est juste.
      échecs.push(`${nom} : 1Password rend une valeur vide pour ${référence}. Le champ est vide.`)
    } else {
      résolus.push([nom, résultat.value])
    }
  }
  if (échecs.length > 0) throw new Error(échecs.join('\n'))

  for (const [nom, valeur] of résolus) env[nom] = valeur
  return noms
}
