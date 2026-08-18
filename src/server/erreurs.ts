import { messageÉpuré } from '@/core/erreurs'
import { projectsDir, replayDir, stageDir } from '@/server/paths'

/**
 * L'épuration des messages, avec les racines de **cette** machine sous les yeux.
 *
 * `épurerChemins` vit dans `src/core/` et ne peut donc pas lire l'environnement
 * — c'est ce qui la rend testable. Or elle a besoin des trois racines pour être
 * exacte : un chemin nu se coupe au premier espace, et `REPLAY_DIR` vaut
 * littéralement `/mnt/j/Drive partagés/…`. Ce fichier-ci est le seul endroit qui
 * connaisse les deux — le calcul pur et la configuration.
 *
 * **Une racine non définie n'est pas une erreur ici.** `replayDir()` lève quand
 * `REPLAY_DIR` manque, et cette fonction est appelée précisément sur le chemin
 * d'échec : y relever une seconde erreur remplacerait le message qu'on essaie de
 * rendre lisible par un autre, moins utile.
 */
function racines(): string[] {
  const trouvées: string[] = []
  for (const lire of [replayDir, stageDir, projectsDir]) {
    try {
      trouvées.push(lire())
    } catch {
      // Variable absente : rien à retirer sous ce nom-là.
    }
  }
  return trouvées
}

/** Le message d'une erreur, sans un chemin de la machine dedans. */
export function messageSûr(erreur: unknown): string {
  return messageÉpuré(erreur, racines())
}
