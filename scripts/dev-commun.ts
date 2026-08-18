/**
 * Le peu que les deux scripts de développement partagent.
 *
 * Ces scripts sont des **points d'entrée en ligne de commande**, pas une couche
 * du produit : ils existent parce qu'une chaîne qui ne tourne que depuis une
 * page web ne se vérifie pas, et parce que la vérification manuelle des tâches 7
 * et 8 les appelle nommément. La tâche 10 branchera les mêmes étapes derrière
 * l'API.
 */

/**
 * Charge `.env` dans `process.env`.
 *
 * Next le fait tout seul ; un script lancé par `tsx`, non. `process.loadEnvFile`
 * est natif depuis Node 20.12, et le `package.json` exige Node 22.
 *
 * Les variables déjà posées dans l'environnement l'emportent : c'est ce qui
 * permet un `FFMPEG_ENCODER=x264 pnpm tsx scripts/dev-ingest.ts …` sans toucher
 * au fichier.
 */
export function chargerEnv(fichier = '.env'): void {
  const avant = { ...process.env }
  try {
    process.loadEnvFile(fichier)
  } catch {
    // Pas de `.env` : les valeurs par défaut de `paths.ts` suffisent pour
    // `STAGE_DIR` et `PROJECTS_DIR`, et `REPLAY_DIR` échouera avec un message
    // qui nomme la variable.
    return
  }
  Object.assign(process.env, avant)
}

/** Une durée en secondes, telle qu'on la lit : `1 h 38 min 57 s`. */
export function durée(secondes: number | null): string {
  if (secondes === null || !Number.isFinite(secondes)) return '?'
  const s = Math.round(secondes)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h} h ${m} min ${s % 60} s` : m > 0 ? `${m} min ${s % 60} s` : `${s} s`
}

/** Des octets, en gibioctets. Les tailles dont on parle ici commencent à 4 Go. */
export function taille(octets: number): string {
  return `${(octets / 1024 ** 3).toFixed(2)} Gio`
}

/**
 * Une barre d'avancement réécrite sur place, et **seulement sur un terminal**.
 *
 * Redirigée dans un fichier, elle produirait des dizaines de milliers de lignes.
 * `isTTY` tranche : sur un tube, on n'écrit rien du tout et le résumé final
 * suffit.
 */
export function créerBarre(étiquette: string): (fraction: number | null) => void {
  const tty = process.stdout.isTTY === true
  let dernier = -1
  return (fraction) => {
    if (!tty || fraction === null) return
    const pourcent = Math.floor(fraction * 100)
    if (pourcent === dernier) return
    dernier = pourcent
    const plein = Math.round(fraction * 30)
    process.stdout.write(
      `\r${étiquette} [${'#'.repeat(plein)}${'.'.repeat(30 - plein)}] ${String(pourcent).padStart(3)} %`,
    )
  }
}

/** Referme la ligne d'une barre d'avancement. Sans effet hors terminal. */
export function finBarre(): void {
  if (process.stdout.isTTY === true) process.stdout.write('\n')
}

/** Le chrono d'une étape, en secondes. */
export function chrono(): () => number {
  const départ = process.hrtime.bigint()
  return () => Number(process.hrtime.bigint() - départ) / 1e9
}
