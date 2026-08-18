/**
 * Ce qui s'exécute une fois par processus serveur, avant tout le reste.
 *
 * Deux choses, et **les deux ont leur corps ailleurs, à dessein.** Next compile
 * ce fichier pour ses deux exécutions, y compris `edge`, qui n'a ni `process.on`
 * ni de quoi charger `better-sqlite3` ou lancer un sous-processus : un import
 * statique y ferait un avertissement à chaque compilation, sur un code que
 * l'exécution edge n'atteindra jamais. La garde et les imports dynamiques sont
 * la forme que Next documente pour ce cas.
 *
 * L'ordre compte : les secrets d'abord, parce qu'ils décident si le processus a
 * de quoi travailler.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // **Une seule fois, ici, et pas à chaque appel d'API.** Chaque lecture est un
  // aller-retour de 2,5 s vers 1Password, et potentiellement une approbation
  // biométrique. Voir `@/server/secrets` pour le reste du raisonnement.
  const { résoudreSecrets } = await import('@/server/secrets')
  // **Ça lève, et c'est voulu.** Un `.env` qui donne l'adresse d'un secret
  // qu'on ne sait pas lire est une configuration fausse, pas un service
  // dégradé : laisser démarrer renverrait la chaîne `op://…` au fournisseur
  // d'API, qui répondrait 401 en accusant la clé. Next préfixe le message de
  // « An error occurred while loading instrumentation hook » et le laisse
  // intact — c'est-à-dire dans le terminal où l'on vient de taper `pnpm dev`.
  const résolus = await résoudreSecrets()
  // Les **noms**, jamais les valeurs. Cette ligne dit que 1Password a répondu,
  // ce qui est précisément ce qu'on veut savoir au démarrage.
  if (résolus.length > 0) console.log(`1Password : ${résolus.join(', ')} résolue(s).`)

  const { accrocherArrêt } = await import('@/server/arret')
  accrocherArrêt()
}
