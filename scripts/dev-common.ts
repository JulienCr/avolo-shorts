/**
 * Le peu que les deux scripts de développement partagent.
 *
 * Ces scripts sont des **points d'entrée en ligne de commande**, pas une couche
 * du produit : ils existent parce qu'une chaîne qui ne tourne que depuis une
 * page web ne se vérifie pas, et parce que la vérification manuelle des tâches 7
 * et 8 les appelle nommément. La tâche 10 branchera les mêmes étapes derrière
 * l'API.
 */

import { resolveSecrets } from '@/server/secrets'

/**
 * Charge `.env` dans `process.env`, puis résout ce qui n'y est qu'en adresse.
 *
 * Next fait le chargement tout seul ; un script lancé par `tsx`, non.
 * `process.loadEnvFile` est natif depuis Node 20.12, et le `package.json` exige
 * Node 22.
 *
 * Les variables déjà posées dans l'environnement l'emportent : c'est ce qui
 * permet un `FFMPEG_ENCODER=x264 pnpm tsx scripts/dev-ingest.ts …` sans toucher
 * au fichier. **Mesuré, `process.loadEnvFile` s'en charge déjà** — il ignore la
 * ligne du fichier quand la variable existe. Le `Object.assign` final reste
 * quand même : ce comportement n'est écrit nulle part dans la documentation de
 * Node, et une version qui le changerait casserait cette ligne de commande sans
 * rien dire.
 *
 * La résolution des secrets vient ensuite parce qu'elle a besoin du fichier :
 * c'est lui qui porte les `op://…`. Elle coûte 2,5 s la première fois, ce qui
 * est du bruit devant les douze minutes de proxy de `dev-ingest`, et rien du
 * tout quand le `.env` ne contient que des valeurs littérales — auquel cas `op`
 * n'est même pas appelé.
 */
export async function chargerEnv(file = '.env'): Promise<void> {
  const before = { ...process.env }
  try {
    process.loadEnvFile(file)
    Object.assign(process.env, before)
  } catch (cause) {
    // **Seule l'absence est tolérée.** Les valeurs par défaut de `paths.ts`
    // suffisent alors pour `STAGE_DIR` et `PROJECTS_DIR`, et `REPLAY_DIR`
    // échouera avec un message qui nomme la variable.
    //
    // Un `.env` présent mais illisible (`EACCES`) ou qui est un dossier
    // (`EISDIR`) est un défaut de configuration, pas une absence : l'avaler
    // ferait échouer le script trois appels plus loin sur « REPLAY_DIR n'est pas
    // définie », qui est un diagnostic faux. (relevé par Copilot)
    if ((cause as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw cause
    // Et on continue : un `.env` absent n'empêche pas l'environnement d'hériter
    // d'une référence posée à la main sur la ligne de commande.
  }

  const resolved = await resolveSecrets()
  // Les **noms**, jamais les valeurs.
  if (resolved.length > 0) console.log(`1Password : ${resolved.join(', ')} résolue(s).`)
}

/** Une durée en secondes, telle qu'on la lit : `1 h 38 min 57 s`. */
export function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '?'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h} h ${m} min ${s % 60} s` : m > 0 ? `${m} min ${s % 60} s` : `${s} s`
}

/** Des octets, en gibioctets. Les tailles dont on parle ici commencent à 4 Go. */
export function size(octets: number): string {
  return `${(octets / 1024 ** 3).toFixed(2)} Gio`
}

/**
 * Une barre d'avancement réécrite sur place, et **seulement sur un terminal**.
 *
 * Redirigée dans un fichier, elle produirait des dizaines de milliers de lignes.
 * `isTTY` tranche : sur un tube, on n'écrit rien du tout et le résumé final
 * suffit.
 */
export function createBar(tag: string): (fraction: number | null) => void {
  const tty = process.stdout.isTTY === true
  let last = -1
  return (fraction) => {
    if (!tty || fraction === null) return
    const percent = Math.floor(fraction * 100)
    if (percent === last) return
    last = percent
    const full = Math.round(fraction * 30)
    process.stdout.write(
      `\r${tag} [${'#'.repeat(full)}${'.'.repeat(30 - full)}] ${String(percent).padStart(3)} %`,
    )
  }
}

/** Referme la ligne d'une barre d'avancement. Sans effet hors terminal. */
export function finBar(): void {
  if (process.stdout.isTTY === true) process.stdout.write('\n')
}

/** Le chrono d'une étape, en secondes. */
export function timer(): () => number {
  const start = process.hrtime.bigint()
  return () => Number(process.hrtime.bigint() - start) / 1e9
}

/**
 * Rend la main, pour de bon.
 *
 * `process.exitCode` seul ne suffit pas ici : quand le délai de garde du montage
 * se déclenche, la requête `fs` abandonnée reste **en vol** — un appel système
 * ne s'annule pas —, et une requête en vol maintient la boucle d'événements
 * vivante. Le script afficherait donc son message d'erreur puis resterait
 * planté, ce qui est exactement ce que le délai de garde était censé éviter.
 * (relevé par Copilot)
 *
 * Les deux flux sont vidés avant de sortir : `process.exit` tronque une sortie
 * branchée sur un tube, et le rappel de `write` n'est appelé qu'une fois le flux
 * écoulé. **Les deux, pas seulement `stdout`** — les messages d'usage et
 * d'échec partent sur `stderr`, donc précisément sur le chemin qui compte.
 * (relevé par Copilot)
 */
export function quit(code: number): void {
  process.exitCode = code
  let remaining = 2
  const done = (): void => {
    if (--remaining === 0) process.exit(code)
  }
  process.stdout.write('', done)
  process.stderr.write('', done)
}
