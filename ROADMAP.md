# Feuille de route

Ce fichier est le point d'entrée pour reprendre le projet. Il dit où en est la
chaîne, ce qui reste et ce qu'il faut savoir pour orchestrer la suite sans
repayer ce qui a déjà été payé.

Deux autres documents font autorité et ne se remplacent pas :
`CLAUDE.md` porte les décisions à ne pas défaire et l'environnement,
`docs/superpowers/specs/2026-08-17-avolo-shorts-design.md` porte la conception
et les mesures qui la fondent.

## Où en est le projet

**L'itération 0 est livrée, à un raccord près.** Quatorze tâches, dix-neuf PR,
759 tests, CI vert à chaque PR.

Ce qui tourne : ingestion depuis le Drive, proxy, extraction audio,
transcription WhisperX, repérage des candidats par Gemini, tri et montage dans
le transcript, cadrage manuel, rendu avec sous-titres karaoké incrustés et
logo, export en deux formats et l'API qui pilote le tout.

**Mais l'export n'est pas atteignable depuis l'interface**, ce qui rend la
chaîne incomplète du point de vue de son utilisateur. Le détail est plus bas,
sous « Le raccord manquant ». Ne pas lire « itération 0 livrée » comme
« utilisable de bout en bout au clavier » : la chaîne se pilote encore en
`curl` pour sa dernière étape.

## Ce qui le prouve

Mesuré sur `2025-06-15-cqlp.mp4`, 4,3 Go, 1 h 39, une émission entière :

| Étape | Coût réel |
|---|---|
| Copie depuis le Drive | 45 s, 97 Mo/s sur le 9p |
| Proxy 960x540 à 30 fps | 6 min, soit 16,4x le temps réel |
| Extraction audio | 6 s |
| Transcription WhisperX | 1 min 41 s, soit 59x le temps réel |
| Repérage Gemini | 30 s |
| Export d'un clip à trois segments | 10 s, deux fichiers |

La transcription est **quinze fois plus rapide que ce que la spec annonçait**
(15 à 25 min). Ce chiffre change ce qu'on peut se permettre : retranscrire une
émission n'est plus une décision.

Trois vérifications comptent plus que les autres, parce qu'elles portent les
paris de la conception.

**Le plafond de durée est mort.** Sur un vrai transcript, Gemini rend des
candidats de 37 à 167 secondes, dont plusieurs au-dessus de 60. C'est le défaut
d'OpenShorts qui a motivé le projet : `snap_clip_to_words` y plafonnait à 60 s
et coupait les chutes.

**Le recalage des sous-titres tient.** Vérifié à l'image après chaque coupe
interne : le carton affiche les bons mots au dixième de seconde près, et le
fichier ASS le confirme au centième. C'est le piège principal du rendu, celui
qu'aucun test de durée ne voit.

**Le graphe ne recalcule rien d'inutile.** Sur un projet dont le transcript
existe, demander les candidats rend `plan: ["candidates"]` et rien d'autre ;
sans `force`, `plan: []`. Une relance complète de l'ingestion et de la
transcription prend 0,4 s.

## Faire tourner la chaîne

L'application écoute sur **4005**. Le port est fixé dans `package.json` et non
laissé au défaut de Next, que tous les projets Next de cette machine se
disputent.

```bash
pnpm dev                                   # http://localhost:4005
pnpm tsx scripts/dev-ingest.ts "<fichier>.mp4"
pnpm tsx scripts/dev-transcribe.ts <projectId>
pnpm tsx scripts/dev-render.ts <clipId>
pnpm lint && pnpm type-check && pnpm test
```

`.env.example` liste ce qu'il faut. Les deux variables sans lesquelles le worker
Python échoue sur une bibliothèque cuDNN introuvable sont posées par le code, pas
par l'environnement : `TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD` et le `LD_LIBRARY_PATH`
vers le cudnn du venv de `rythmo-impro`. Ne pas les retirer.

Un projet complet est déjà sur le disque : `2025-06-15-cqlp`, avec son proxy,
son audio, son transcript sur le Drive et quelques rendus. De quoi travailler
sans repayer les six minutes de proxy.

## Ce qui reste

### Le raccord manquant : l'export est inaccessible depuis l'interface

C'est le premier chantier, avant les itérations suivantes, parce qu'il empêche
d'utiliser ce qui est déjà construit. Constaté par Julien devant l'écran, puis
vérifié dans le code.

Un clip affiche l'étiquette « exporté » et rien ne permet de déclencher un
export, de lire le fichier produit, ni de récupérer les textes. Trois pièces
manquent, toutes du même côté :

1. **Aucune route ne sert un fichier rendu.** `/api/projects/:id/proxy` existe et
   gère les requêtes partielles, mais rien d'équivalent pour
   `projects/<id>/renders/`. La mécanique est là et se réutilise :
   `parseRange` dans `src/core/range.ts`, et la route proxy comme modèle.
2. **`GET /api/clips/:id` ne dit rien des sorties produites.** Il rend
   `{ clip, project, lines, proxyUrl }`. Il lui faut les rendus, en URL et jamais
   en chemins absolus du serveur, avec `null` quand le fichier n'existe pas. La
   variante 9:16 n'existe que si le ratio résolu n'est pas déjà 9:16 : son absence
   n'est pas une anomalie.
3. **`src/lib/api.ts` n'expose pas d'`exportClip`**, et l'écran de clip n'a ni
   bouton, ni état d'attente, ni lecteur des sorties. L'export prend de dix
   secondes à une minute : un bouton muet pendant ce temps passe pour cassé. Il
   faut aussi traiter le ré-export, le serveur rendant `skipped: true` quand le
   rendu existe déjà.

**La cause est une couture d'orchestration, pas une erreur d'un agent.**
L'interface a été construite contre des fixtures pendant que les autres tâches
tournaient, donc avant que la route d'export existe. Quand la tâche 10 a branché
`src/lib/api.ts` sur les vraies routes, elle a câblé les fonctions que
l'interface appelait déjà, et l'export n'en faisait pas partie. Chaque agent a
livré son périmètre, et personne ne possédait le raccord.

La leçon vaut pour la suite : **quand un périmètre est découpé pour paralléliser,
quelqu'un doit posséder explicitement la jonction**, sinon elle tombe entre deux
rapports tous deux exacts.

### Trois anomalies ouvertes

**#22, et elle est pire que son ticket ne le dit.** Sur la variante 9:16, le fond
flouté ne laisse pas seulement « deviner » les sous-titres : le carton est
pleinement lisible dans la bande du bas, à la même taille, le jaune du mot actif
compris. Constaté à l'image, pas déduit du filtergraph. La variante est
construite depuis le rendu natif déjà incrusté, et `gblur=sigma=12` n'efface pas
des lettres cerclées d'un contour de 8. Ça compte parce que
cette variante est ce qui permet à un 1:1 ou un 4:5 d'atteindre TikTok, donc le
mécanisme qui porte la moitié du bénéfice mesuré en section 2 de la spec.

**#21.** Deux `PATCH` sur le même clip qui se croisent peuvent laisser la
première valeur à l'écran. Le fermer demande un jeton de séquence, donc le
schéma, le contrat et le hook, soit trois surfaces.

**#12.** Le préréglage NVENC de l'export : `p4` rend 7,51x contre 4,58x pour le
`p5` retenu, à qualité que personne n'a regardée.

### Deux points sans ticket, à trancher devant l'écran

Cliquer un mot barré loin devant le clip crée un segment isolé de quelques
dixièmes à cet endroit. C'est ce que le plan demandait, `Ctrl+Z` le défait, mais
c'est un piège possible.

**Le filtre de sécurité de Gemini se déclenche sur du transcript d'improvisation.**
Quatre lots de notation sur onze reviennent `PROHIBITED_CONTENT` sur
`2025-06-15-cqlp`, de façon reproductible et diagnostiquée lot par lot. Ce n'est
donc ni un hasard ni un incident réseau : c'est un taux, et sur cette émission il
vaut 36 %.

Ce que ça coûte aujourd'hui : le repérage classe les lots refusés derniers plutôt
que d'échouer, donc leurs fenêtres ne sont jamais notées et ne peuvent pas
remonter dans la présélection. Un tiers du matériau est écarté sans être jugé, en
silence. Le contournement empêche la panne, pas la perte.

Ce que ça engage pour la suite : l'itération 2 ajoute quatre pourvoyeurs et un
reclassement en vision, tous chez le même fournisseur. Si le filtre mord déjà sur
du texte, il mordra sur des images de scène. La cause mérite d'être élucidée
avant d'y investir : quelles catégories se déclenchent, si les réglages de
sécurité de l'API les couvrent, et si le découpage en lots de huit concentre le
risque au lieu de le diluer.

### Les quatre itérations suivantes

L'ordre suit le rapport entre ce que chaque étage change à l'écran et ce qu'il
coûte à construire. Il est fixé en section 4 de la spec et n'a pas de raison de
bouger.

| Itération | Contenu |
|---|---|
| 1 | Cadrage automatique : détection de personnes et de plans, ratio au percentile 90, crop fixe par plan, coupes posées sur les frontières |
| 2 | Qualité du repérage : les quatre autres pourvoyeurs, reclassement en vision |
| 3 | Sous-titres : nettoyage des hésitations, correction par modèle local, style personnalisable |
| 4 | Automatisation : watcher, webhook, graphe complet avec clés de validité |

Le cadrage arrive en premier parce que c'est là que se trouve la moitié du
bénéfice visuel mesuré. Le réglage manuel livré en itération 0 n'est pas jetable :
il reste comme réglage de dernier recours, et l'automatique ne fera que le
préremplir.

## Reprendre l'orchestration

Le travail se fait en sous-agents, un par tâche, chacun dans son worktree, chacun
livrant sa PR. Ce qui suit a été payé pendant l'itération 0 et vaut d'être tenu.

### Le découpage

Grouper le long de la chaîne de dépendances, paralléliser tout le reste. La
review coûte un forfait par PR, mesuré entre 16 et 33 minutes et sans rapport
avec la taille. Mais les reviews tournent en parallèle entre PR. Fusionner deux
tâches ne rapporte donc que si elles étaient séquentielles de toute façon.

Chaque agent reçoit un périmètre de fichiers **disjoint**, nommément énoncé, avec
la liste de ce que les autres agents touchent au même moment.

### La livraison

Ouvrir la PR en brouillon dès le premier commit, pousser autant qu'on veut
et ne passer en « prêt » qu'une fois le travail fini et vert. Les relecteurs
ignorent les brouillons ; une PR ouverte tôt déclenche une passe de review par
commit, sur du code en chantier. La première PR du projet en a consommé douze.

Personne ne pousse sur `main` : elle est protégée, les fils de review doivent
être résolus avant merge.

### Les reviews

Trois relecteurs, trois surfaces différentes. En rater une fait passer une
PR pour propre alors qu'elle ne l'est pas :

- Copilot et Codex déposent des fils en ligne **et un corps de review**. Copilot
  enterre le gros de ses trouvailles dans un bloc `<details><summary>Suppressed comments</summary>`
  du corps : zéro fil affiché ne veut rien dire.
- Aristarque, le relecteur maison, poste en **commentaire de haut niveau** sous
  `github-actions[bot]`. Ce n'est ni un fil ni une review au sens de l'API.

La skill `check-reviews` lit les trois par script. S'en servir plutôt que de
bricoler des appels à l'API.

Le critère d'arrêt, sans lequel la boucle ne ferme jamais puisque Copilot relit à
chaque push : défaut réel, on corrige ; suggestion, on décline en une ligne ;
faux positif, on le dit. Un tour qui ne produit que des deux derniers se répond
et se merge. **Répondre à chaque fil avant de le résoudre** : une correction
silencieuse est indistinguable d'une trouvaille ignorée.

Sur l'itération 0, les relecteurs ont sorti des défauts réels dans **le code du
plan lui-même** : deux dans les opérations sur les segments, un dans le
filtergraph de rendu. Ils ne sont pas décoratifs.

### Les pièges de la mécanique

- **Jamais `git add -A` ni `git add .`.** Les worktrees d'agents sont des dépôts
  imbriqués visibles depuis la racine ; `-A` les embarque en gitlinks. Vérifier
  `git ls-files -s | grep ^160000` avant chaque push.
- **Jamais `git checkout main` dans un worktree d'agent** : git refuse la même
  branche dans deux worktrees et le checkout principal se retrouve bloqué. Pour
  vérifier l'intégration, `git merge origin/main` sur sa propre branche.
- **Ne pas abréger le SHA passé à `--head`** des outils de review.
- Le Drive `/mnt/j` décroche de deux façons que `/proc/mounts` ne distingue pas :
  absent au démarrage, ou monté avec son transport mort. Éprouver par un accès
  réel avec délai de garde, jamais par les bits de permission.
- `sudo` passe par une approbation 1Password : un « authorization timeout » est un
  échec définitif, pas à réessayer.

### Les issues

La doctrine est en section « Les issues » de `CLAUDE.md`. Une issue se crée
seulement s'il y a une action différée, si aucun autre foyer ne convient et si
elle serait perdue autrement. **Un agent n'en crée pas de sa propre initiative.** Il signale
dans son rapport, et celui qui orchestre tranche. Sur l'itération 0, une candidate
sur cinq a passé les trois tests.

## Vestiges à nettoyer

Deux clips `clip_verif_*` sont en base avec leurs rendus, laissés par la
vérification du rendu. Et `assets/brand/` contient deux PNG générés pour les
tests, à remplacer par les vrais logos. Le dossier est ignoré par git : les
marques appartiennent à l'opérateur.
