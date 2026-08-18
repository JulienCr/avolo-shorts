/**
 * Ce qui s'exécute une fois par processus serveur, avant tout le reste.
 *
 * Une seule chose ici, et elle vit dans `@/server/arret` : refermer SQLite quand
 * le serveur s'arrête. **Le corps est ailleurs à dessein.** Next compile ce
 * fichier pour ses deux exécutions, y compris `edge`, qui n'a ni `process.on` ni
 * de quoi charger `better-sqlite3` : un import statique y ferait un
 * avertissement à chaque compilation, sur un code que l'exécution edge
 * n'atteindra jamais. La garde et l'import dynamique sont la forme que Next
 * documente pour ce cas.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { accrocherArrêt } = await import('@/server/arret')
  accrocherArrêt()
}
