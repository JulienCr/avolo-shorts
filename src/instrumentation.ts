/**
 * Ce qui s'exécute une fois par processus serveur, avant tout le reste.
 *
 * Trois choses, et **les trois ont leur corps ailleurs, à dessein.** Next
 * compile ce fichier pour ses deux exécutions, y compris `edge`, qui n'a ni
 * `process.on` ni de quoi charger `better-sqlite3` ou lancer un sous-processus :
 * un import statique y ferait un avertissement à chaque compilation, sur un code
 * que l'exécution edge n'atteindra jamais. La garde et les imports dynamiques
 * sont la forme que Next documente pour ce cas.
 *
 * L'ordre compte, et les deux premières sont attendues quand la troisième ne
 * l'est pas : les secrets d'abord, parce qu'ils décident si le processus a de
 * quoi travailler ; la fermeture de la base ensuite, parce qu'elle doit être
 * accrochée avant qu'un signal puisse arriver ; le nettoyage du cache de travail
 * en dernier et sans attente, parce que rien n'en dépend.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // **Une seule fois, ici, et pas à chaque appel d'API.** Chaque lecture est un
  // aller-retour de 2,5 s vers 1Password, et potentiellement une approbation
  // biométrique. Voir `@/server/secrets` pour le reste du raisonnement.
  const { resolveSecrets } = await import('@/server/secrets')
  // **Ça lève, et c'est voulu.** Un `.env` qui donne l'adresse d'un secret
  // qu'on ne sait pas lire est une configuration fausse, pas un service
  // dégradé : laisser démarrer renverrait la chaîne `op://…` au fournisseur
  // d'API, qui répondrait 401 en accusant la clé. Next préfixe le message de
  // « An error occurred while loading instrumentation hook » et le laisse
  // intact — c'est-à-dire dans le terminal où l'on vient de taper `pnpm dev`.
  const resolved = await resolveSecrets()
  // Les **noms**, jamais les valeurs. Cette ligne dit que 1Password a répondu,
  // ce qui est précisément ce qu'on veut savoir au démarrage.
  if (resolved.length > 0) console.log(`1Password : ${resolved.join(', ')} résolue(s).`)

  const { hookShutdown } = await import('@/server/shutdown')
  hookShutdown()

  // **Le cache de travail, borné au démarrage** (retour d'usage §5). `stage/`
  // porte plusieurs gigaoctets par émission ; sans passage régulier, il grossit
  // jusqu'au disque. Huit heures de TTL, et une copie effacée ne coûte qu'une
  // recopie — 45 secondes pour 4,3 Go —, jamais un artefact.
  //
  // **Sans `await`, et sans laisser d'échec remonter.** Le nettoyage n'est pas
  // une condition de démarrage : `register()` lève exprès quand un secret ne se
  // résout pas, parce que c'est une configuration fausse ; un `readdir` sur un
  // dossier absent, lui, ne doit pas empêcher le serveur de servir. Et
  // l'attendre ferait payer au premier chargement de page un balayage de disque
  // dont personne n'attend le résultat.
  // **`cleanWorkCache` et non `cleanStage` nu.** Ce balayage continue après le
  // retour de `register()`, donc le serveur accepte une analyse pendant qu'il
  // tourne ; cette analyse constate sa copie de travail présente — elle n'a rien
  // à recopier, donc rien ne l'inscrit dans `copiesInFlight` — et le balayage la
  // lui retirait. `cleanWorkCache` épargne ce que les exécutions lisent, et il
  // relit la liste à chaque fichier. (relevé par Copilot)
  const { cleanWorkCache } = await import('@/server/run')
  void cleanWorkCache().catch((cause: unknown) => {
    console.warn('Nettoyage de stage/ au démarrage :', cause)
  })
}

/**
 * **Un `.env` modifié pendant que `next dev` tourne défait la résolution.**
 *
 * Mesuré sur `@next/env` 16.3.1 : quand le serveur de développement recharge le
 * fichier, `loadEnvConfig` commence par réappliquer l'instantané de
 * `process.env` pris au tout premier chargement — instantané qui précède
 * `register()` —, puis relit le `.env`. La variable repasse donc à `op://…`, et
 * `register()` ne sera pas rappelé.
 *
 * Le geste est de **relancer le serveur** après avoir touché au `.env`, ce qu'on
 * fait déjà pour la plupart des variables de ce projet. Rétablir la résolution
 * elle-même demanderait `updateInitialEnv` de `@next/env`, que la disposition
 * stricte de pnpm ne rend pas résoluble depuis le dépôt ; l'atteindre par un
 * chemin interne de `next` coûterait plus cher au premier changement de version
 * que le désagrément qu'il évite.
 *
 * **Ce qui est corrigé, en revanche, c'est le silence.** `requireSecret` refuse
 * une variable restée à l'état d'adresse au lieu de l'envoyer comme clé : on
 * obtient « la résolution du démarrage a été défaite […] relancer le serveur »
 * plutôt qu'un 401 du fournisseur d'API. (relevé par Copilot)
 */

