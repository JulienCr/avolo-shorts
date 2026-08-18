/**
 * Ce qui s'exécute une fois par processus serveur, avant tout le reste.
 *
 * Une seule chose ici : **refermer SQLite quand le serveur s'arrête.**
 * `closeDb()` existe depuis la tâche 6 et n'était accroché à rien. La base
 * tourne en WAL — l'analyse écrit pendant trente minutes pendant que l'interface
 * lit —, et une connexion qu'on n'a jamais refermée laisse derrière elle un
 * `-wal` et un `-shm` que rien ne consolide. Le contenu n'est pas perdu, SQLite
 * les rejoue à l'ouverture suivante ; ce qui est perdu, c'est l'occasion de
 * savoir que la fermeture s'est bien passée.
 *
 * En développement, Next redémarre à chaque édition : c'est donc plusieurs fois
 * par heure que ce chemin est emprunté.
 */
export async function register(): Promise<void> {
  // `instrumentation.ts` est aussi chargé par le runtime edge, qui n'a ni
  // `process.on` ni de quoi faire tourner `better-sqlite3`. L'import est donc
  // dynamique et sous la garde : statique, il partirait dans le paquet edge et
  // le ferait échouer à la compilation.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { closeDb } = await import('@/server/db')

  const fermer = (): void => {
    try {
      closeDb()
    } catch (cause) {
      console.error('Fermeture de la base :', cause)
    }
  }

  // Les sorties ordinaires. Synchrone, comme l'exige `exit`, et `closeDb` l'est.
  process.on('exit', fermer)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      fermer()
      // **Sortir seulement si personne d'autre ne s'en charge.** Poser un
      // gestionnaire sur un signal désarme le comportement par défaut de Node :
      // sans ce garde-fou, un serveur dont rien d'autre n'écoute resterait en
      // vie à un Ctrl+C. Mais le serveur de développement de Next écoute déjà et
      // fait son propre arrêt : sortir par-dessus lui couperait son nettoyage en
      // plein milieu.
      if (process.listenerCount(signal) <= 1) process.exit(0)
    })
  }
}
