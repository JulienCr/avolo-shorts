# L'ordonnanceur de publication

Conception : `docs/superpowers/specs/2026-08-26-publication-scheduling-design.md`
(§5.4-§5.5). Ce document est le mode d'emploi côté machine : comment poser la
tâche planifiée, comment la tester avant de lui faire confiance, et où lire ce
qu'elle a fait.

## Ce que la tâche fait

Toutes les cinq minutes, la tâche invoque `wsl.exe` pour exécuter
`scripts/publish-scheduled.ts`, sans serveur Next. Le script prend au plus une
échéance due par passage, publie ses quatre plateformes en série, réessaie
jusqu'à trois fois, et écrit un rapport sur la sortie standard. Toute la
décision vit dans `src/server/publication/scheduler.ts` ; le script n'est qu'un
habillage en ligne de commande autour de `runOnePass`.

## Trouver le nom de la distribution WSL

Depuis PowerShell ou l'invite de commandes Windows :

```
wsl.exe -l -q
```

La sortie liste les distributions installées, une par ligne (par exemple
`Ubuntu`). C'est ce nom qui remplace `<Distro>` ci-dessous.

## La commande `schtasks`

**Julien la lance lui-même** : rien dans ce dépôt n'invoque `wsl.exe`,
`cmd.exe` ou `powershell.exe`, et aucun agent n'installe de tâche planifiée sur
cette machine.

Depuis PowerShell, en remplaçant `<Distro>` par le nom trouvé ci-dessus :

```
schtasks /Create /F /SC MINUTE /MO 5 /RL LIMITED /TN "AvoloShorts-PublishScheduled" /TR 'wsl.exe -d <Distro> -- /home/julien/dev/avolo-shorts/scripts/publish-scheduled.sh'
```

`/TR` invoque `scripts/publish-scheduled.sh`, un lanceur du dépôt, comme un
**chemin unique** plutôt qu'une commande `bash -lc "…"` imbriquée — la
commande n'a donc plus de guillemets doubles internes à protéger d'une
apostrophe Windows. C'est la valeur entière de `/TR`, elle, qui reste entre
apostrophes PowerShell, pour que PowerShell la transmette telle quelle à
`schtasks.exe` sans y toucher.

- `/SC MINUTE /MO 5` : toutes les cinq minutes, comme la conception le fixe.
- `/RL LIMITED` : pas de privilèges élevés, la tâche n'en a pas besoin.
- Le lanceur résout lui-même son `nvm` et vérifie la version de Node avant
  d'appeler `pnpm tsx` — voir « Pourquoi un lanceur, et pas `bash -lc` »
  ci-dessous.
- La sortie (`stdout` et `stderr`) part dans `projects/publish-scheduled.log`,
  à côté de la base et des jetons — ce dossier est déjà hors dépôt. C'est le
  **lanceur** qui redirige, pas `/TR` : `schtasks` lance le programme nommé par
  `CreateProcess`, sans interpréteur de commandes, donc un `>> … 2>&1` posé
  dans `/TR` ne serait jamais évalué — il finirait en argument nu, transmis
  tel quel au script `.ts`. Le lanceur capture donc tout dès sa première
  ligne, y compris un échec avant même que Node ne démarre.

## Pourquoi un lanceur, et pas `bash -lc`

Une version antérieure de ce document posait la tâche avec
`bash -lc "cd … && pnpm tsx …"`, au motif qu'un shell de connexion pose le
`PATH` qui contient `pnpm`. **C'est faux sur cette machine, et ça a coûté un
incident réel** : deux clips programmés à 20:50 n'étaient pas partis à 23:10.
`nvm` est sourcé depuis un fichier de démarrage **interactif**
(`.zshrc`/`.bashrc`), et une tâche planifiée n'obtient jamais de shell
interactif — `bash -lc`, en session de connexion non interactive, lit
`.bash_profile`/`.profile`, jamais `.bashrc`. Résultat mesuré :
`wsl.exe -d Ubuntu -- bash -lc 'node -v'` rend `v12.22.9`, le Node système
d'Ubuntu dans `/usr/bin/node`. Le dépôt exige Node ≥ 22, donc `pnpm` meurt
avec `SyntaxError: Unexpected token '.'`, une trace qui pointe dans
`internal/modules/cjs/loader.js` sans jamais mentionner Node, `PATH` ni `nvm`
— c'est ce message qui a fait perdre des heures à l'investigation. Appeler le
`pnpm` de `nvm` par son chemin absolu ne suffit pas non plus : son shebang est
`#!/usr/bin/env node`, qui recherche `node` dans `PATH` et retrouve la v12 en
premier.

`scripts/publish-scheduled.sh` résout cette dépendance dans le script plutôt
que dans le shell qui l'invoque : il source `$NVM_DIR/nvm.sh` s'il existe,
lance `nvm use default`, puis vérifie que la version de Node résolue est bien
≥ 22 avant d'appeler `pnpm tsx` — sinon il échoue avec un message sur
`stderr` qui nomme la version trouvée, le binaire `node` résolu et `PATH`.

Cette forme suppose une **session Windows ouverte** au moment du réveil (la
tâche tourne dans le contexte de l'utilisateur courant). Si l'essai plus bas
montre qu'elle ne se déclenche pas session verrouillée ou fermée, la variante
qui fonctionne « session fermée » ajoute `/RU <utilisateur> /RP *` à la
commande — `schtasks` demande alors le mot de passe une fois, à la création,
plutôt que de l'écrire en clair dans la commande.

## Essayer d'abord, sans rien publier

```
cd /home/julien/dev/avolo-shorts
pnpm tsx scripts/publish-scheduled.ts --dry-run
```

Ne pose aucun verrou, n'écrit aucune ligne, n'envoie aucun courriel : il lit la
prochaine échéance due (s'il y en a une) et l'affiche, avec les plateformes
qu'elle viserait. C'est la vérification à faire avant de poser la tâche, et
celle à refaire après toute modification du script ou de l'environnement.

Si `publication.autoPublish` est coupé, rien de tout ça ne s'affiche : l'essai
rend `disabled` avant même de regarder les échéances (section suivante).

## Lire une passe réelle

Chaque appel de `scripts/publish-scheduled.ts` (sans `--dry-run`) imprime une
ligne de résumé — `Rien à publier.`, `Verrou déjà posé depuis …`, ou, préfixées
par l'heure de la passe, `<heure> — Publié : …` et `<heure> — Abandonné
après … essai(s) : …` — suivie, pour ces deux dernières, du détail par
plateforme. Le code de sortie est 0 dans tous les cas sauf `Abandonné`, qui
rend 1 : le planificateur Windows consigne les échecs de tâche, ce qui donne
une seconde voie d'alerte à côté du courriel.

Sur abandon après les trois essais, un courriel part à `julien@avolo.fr` via
Resend (voir `.env.example` pour `RESEND_API_KEY` et `RESEND_FROM`) — **le
domaine de `RESEND_FROM` doit être vérifié dans Resend**, sinon l'envoi échoue
côté fournisseur sans que rien ici ne le sache. Une clé absente ou mal résolue
ne bloque jamais une publication : elle est seulement journalisée, dans
`projects/publish-scheduled.log`.

## L'essai qui compte : session verrouillée, puis session fermée

C'est le point que la conception laisse ouvert et que seul un essai tranche
(spec §5.4, §7) : `wsl.exe`, invoqué par une tâche planifiée, se comporte-t-il
pareil quand la session Windows est verrouillée, puis quand elle est fermée ?

**Avant de commencer, résoudre les secrets une fois pour toutes** :

```
pnpm generate-env:local
```

`chargerEnv()` (`scripts/dev-common.ts`) résout toute adresse `op://` restée
dans `.env` **à chaque réveil de cinq minutes**, et `src/server/secrets.ts` le
dit sans détour : une lecture 1Password peut bloquer sur une approbation quand
l'application de bureau est verrouillée — tenable une fois au démarrage,
jamais à chaque appel. Sans cette étape, l'essai « session verrouillée »
peut réussir une première fois pendant que 1Password est encore déverrouillé,
puis se bloquer en silence à un réveil suivant, sans qu'aucune ligne
n'apparaisse dans le journal pour le dire. `generate-env:local` écrit les
références déjà résolues dans `.env.local`, prioritaire sur `.env` — vérifier
après coup qu'aucune valeur de `.env.local` ne commence encore par `op://`
avant de poser la tâche.

**Ensuite**, poser une échéance de test proche (une à deux minutes dans le
futur) sur un clip exporté jetable, depuis l'écran `/planning`, pour avoir
quelque chose à observer sans attendre une vraie publication.

### Essai 1 — session verrouillée

1. Poser la tâche planifiée (`schtasks /Create` ci-dessus).
2. Verrouiller la session (`Win+L`), sans se déconnecter.
3. Attendre le prochain réveil de cinq minutes, ou le déclencher à la main
   depuis un autre poste : `schtasks /Run /TN "AvoloShorts-PublishScheduled"`.
4. Déverrouiller la session et lire `projects/publish-scheduled.log` : une
   ligne `Publié` ou `Abandonné` datée de pendant le verrouillage confirme que
   la tâche a tourné. Une absence de ligne, ou une ligne plus ancienne que
   prévu, dit qu'elle n'a pas tourné.

### Essai 2 — session fermée

1. Poser une nouvelle échéance de test.
2. Fermer complètement la session (pas seulement la verrouiller).
3. Attendre un réveil, puis rouvrir la session.
4. Même lecture du journal qu'à l'essai 1.

Si l'essai 2 échoue avec la commande simple, reposer la tâche avec
`/RU <utilisateur> /RP *` (ci-dessus) et refaire l'essai. Si cette variante
échoue aussi, consigner le résultat dans une issue plutôt que de forcer une
solution : la conception s'appuie sur l'hypothèse qu'une tâche planifiée
tourne sans session, et son échec est un fait qu'il faut remonter, pas
contourner en silence.

## Arrêter les publications sans arrêter la tâche

Le réglage `publication.autoPublish` (écran `/settings`, section
Publication) décide seul si une passe publie ; la tâche continue de se
réveiller toutes les cinq minutes et sort avec le code 0, sans rien faire, le
temps que le drapeau reste coupé — `disabled` dans le journal.

**Ne jamais couper avec `schtasks /Change /DISABLE`** : ça pose l'état
d'arrêt côté Windows, invisible depuis l'application, dans un endroit que
personne ne pense à revisiter. C'est cette commande qui a servi à arrêter la
tâche quand le rendu défectueux (issue #212) l'exigeait — l'arrêt, lui,
n'était visible nulle part dans le dépôt.

## Déprogrammer

Retirer la tâche :

```
schtasks /Delete /TN "AvoloShorts-PublishScheduled" /F
```

Les échéances déjà `planned` restent en base — les retirer se fait depuis
l'écran `/planning`, pas en retirant la tâche.
