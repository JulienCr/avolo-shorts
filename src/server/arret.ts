import { closeDb } from '@/server/db'

/**
 * L'arrêt du serveur : **refermer SQLite.**
 *
 * `closeDb()` existe depuis la tâche 6 et n'était accroché à rien. La base
 * tourne en WAL — l'analyse écrit pendant trente minutes pendant que
 * l'interface lit la même base —, et une connexion qu'on ne referme jamais
 * laisse derrière elle un `-wal` et un `-shm` que rien ne consolide. Le contenu
 * n'est pas perdu, SQLite les rejoue à l'ouverture suivante ; ce qui est perdu,
 * c'est le moment où l'on pourrait savoir que la fermeture s'est mal passée.
 *
 * En développement, Next redémarre à chaque édition : ce chemin est emprunté
 * plusieurs fois par heure.
 *
 * **Ce fichier est chargé par `instrumentation.ts`, jamais importé
 * statiquement.** `instrumentation.ts` est compilé pour les deux exécutions de
 * Next, et l'exécution edge n'a ni `process.on` ni de quoi charger un module
 * natif : un import statique y produit un avertissement à chaque compilation.
 */
export function accrocherArrêt(): void {
  const fermer = (): void => {
    try {
      closeDb()
    } catch (cause) {
      console.error('Fermeture de la base :', cause)
    }
  }

  // Les sorties ordinaires. `exit` n'accepte que du synchrone, et `closeDb` l'est.
  process.on('exit', fermer)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      fermer()
      // **Sortir seulement si personne d'autre ne s'en charge.** Poser un
      // gestionnaire sur un signal désarme le comportement par défaut de Node :
      // sans ce garde-fou, un serveur dont rien d'autre n'écoute resterait en vie
      // à un Ctrl+C. Mais le serveur de développement de Next écoute déjà et fait
      // son propre arrêt : sortir par-dessus lui couperait son nettoyage en plein
      // milieu.
      if (process.listenerCount(signal) <= 1) process.exit(0)
    })
  }
}
