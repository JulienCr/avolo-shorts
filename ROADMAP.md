# Feuille de route

Ce fichier est le point d'entrée pour reprendre le projet. Il dit où en est la
chaîne, ce qui reste et ce qu'il faut savoir pour orchestrer la suite sans
repayer ce qui a déjà été payé.

Deux autres documents font autorité et ne se remplacent pas :
`CLAUDE.md` porte les décisions à ne pas défaire et l'environnement,
`docs/superpowers/specs/2026-08-17-avolo-shorts-design.md` porte la conception
et les mesures qui la fondent.

## Où en est le projet

**L'itération 0 est livrée, entièrement, et la moitié de l'itération 1 avec.**
Neuf PR fusionnées le 18 août 2026, 965 tests, CI verte à chaque PR.

Ce qui tourne : ingestion depuis le Drive, proxy, extraction audio,
transcription WhisperX, repérage des candidats par Gemini, tri et montage dans
le transcript, cadrage manuel, rendu avec sous-titres karaoké incrustés et
logo, export en deux formats, l'API qui pilote le tout — et, depuis cette
vague, la détection des corps et des plans, le cadrage automatique en fonctions
pures, et les secrets résolus depuis 1Password.

**Le raccord côté serveur est fait.** Les trois routes orphelines ont leurs
fonctions dans `src/lib/api.ts` (`createProject`, `runProject`, `exportClip`),
`GET /api/clips/:id` rend les sorties produites en URL, et une route sert les
rendus en requêtes partielles. **Les gestes d'interface, eux, n'existent
toujours pas** : ils appartiennent à la passe UI/UX, dont la conception est
livrée dans `docs/superpowers/specs/2026-08-18-parcours-utilisateur-design.md`.

**Les trois anomalies sont fermées.** #22 — la variante 9:16 tire désormais son
fond d'avant l'incrustation, vérifié à l'image : 43 tuiles sur 43 sans un pixel
de texte, contre 43 sur 43 lisibles avant. #21 — jeton d'ordre par champ. #12 —
`p4` est visuellement équivalent à `p5` mais ne gagne plus rien depuis que
l'export n'est plus borné par l'encodeur ; la table reste à `p5`, les deux
moitiés de la mesure sont dans `docs/environnement.md`.

**Et le filtre de sécurité de Gemini n'écarte plus rien.** Il n'est pas
configurable — mesuré, les quatre catégories à `OFF` donnent quatre refus sur
quatre — mais il vise la **concentration de matière dans une requête** : un lot
de huit est refusé là où les mêmes fenêtres passent une à une. Le repérage
recoupe donc les lots refusés et les renvoie. Résultat sur `2025-06-15-cqlp` :
**51 fenêtres notées sur 83 → 83 sur 83**, et **trois des six clips retenus
sortent de fenêtres qu'on jetait sans les juger**.

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

La transcription est **au moins neuf fois plus rapide que ce que la spec
annonçait** (15 à 25 min, donc de neuf à quinze fois selon la borne ; la
section 6 porte la mesure depuis). Ce chiffre change ce qu'on
peut se permettre : retranscrire une émission n'est plus une décision.

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

### L'itération 1 n'est pas finie, et son dernier morceau est un préalable

Le cadrage automatique est en ligne et **ne produit rien d'utilisable en
l'état** : sur `2025-06-15-cqlp`, les **30 clips sortent tous en 16:9**.

La cause est mesurée : **34 % des boîtes de personnes sont des têtes de
spectateurs collées au bord bas de l'image.** Écarter le premier plan fait
passer l'empan médian de 0,68 à 0,50 et la part du temps qui tient dans un 1:1
de **33 % à 64 %**. Sur `2026-03-08-caro-mdlm`, 26 boîtes sur 3 083 seulement :
c'est propre à `cqlp`, pas général.

Ce n'est pas un seuil. Couper à `y1 ≤ 0,97` déplace bien 19 clips sur 30 vers un
ratio plus serré, mais ne laisse survivre que 16 % des boîtes — donc il jette
aussi des comédiens debout. **Le filtre demande sa propre mesure**, et il vient
avant tout le reste de l'itération 1 : sans lui, l'automatique ne vaut pas mieux
que le manuel.

Restent ensuite, dans cet ordre :

1. **Le rendu à crop variable.** `renderArgs` applique un seul rectangle à tous
   les segments (`src/core/ffmpeg/args.ts`). Un segment qui traverse une
   frontière de plan doit se découper en autant d'entrées que de plans. La
   migration porte `cropMode` et la table `crops`, décrites plus bas.
2. **Le préremplissage.** `resolveRatio('auto')` rend encore `9:16` en dur et
   doit aller chercher `computeFraming`.
3. **Les coupes posées sur les frontières.** `snapToShots` est écrit, pur et
   testé ; il reste à le brancher dans la délimitation.

**Le modèle du crop, arbitré et non encore implémenté.** Trois champs :
`cropMode: 'auto' | 'manual'` (mode explicite — bouger un curseur ne le bascule
pas), `crops: Record<shotStartMs, number>` (dérogation **par plan**, un plan sans
entrée garde son crop calculé), et `ratio` qui devient **épinglable**. Un ratio
épinglé fait recalculer les crops **pour ce ratio**. La clé désigne le plan
**dans la source** — son instant de début en millisecondes —, jamais son rang
dans le clip : indexée sur le rang, une dérogation se décale au premier retrait
de segment en amont et atterrit sur le mauvais plan, sans erreur ni signal.

### L'interface

Aucun geste. La conception est livrée
(`docs/superpowers/specs/2026-08-18-parcours-utilisateur-design.md`, §8 porte
l'ordre de mise en œuvre) et c'est le chantier suivant.

Ce que le serveur impose et qu'une interface écrite sans le savoir présenterait
comme des erreurs :

- **L'export est synchrone et dure de dix secondes à une minute.** Un bouton muet
  pendant ce temps passe pour cassé.
- **`skipped: true` au ré-export est un cas nominal**, pas un échec.
- **Un clip a une ou deux sorties.** La variante 9:16 n'existe que si le ratio
  résolu n'est pas déjà 9:16 ; son absence alors n'est pas une anomalie.
  `variant9x16Due` distingue « n'existera jamais » de « due, pas encore produite ».
- **Un `PATCH` refusé pour jeton périmé est un cas nominal** — « une écriture plus
  récente a gagné », pas « la sauvegarde a échoué ». **Et `applied: false` doit
  réconcilier l'état local**, sinon la sauvegarde différée renvoie l'intention
  refusée avec un jeton neuf et annule la garantie d'ordre. C'est le premier
  geste à faire.
- **Le vocabulaire d'étapes est recopié, pas dérivé.** `LIBELLES_ETAPES` porte sur
  le `StepName` **client** de `src/lib/api.ts:35`, une union écrite à la main et
  distincte de `src/core/graph.ts`. `analysis` y manque, donc l'écran affiche un
  libellé vide et un `aria-label` « undefined en cours » pendant l'analyse d'un
  projet neuf. Correctif en deux lignes indissociables. La cause — deux contrats
  qui ne se contraignent pas — vaut mieux qu'un correctif par symptôme.
- **La perte du repérage doit rester visible.** `dernierBilan(projectId)` est
  exporté par `src/server/steps/candidates.ts` ; il reste à le faire remonter
  dans `status.json` (une ligne dans `écrireStatut`, `src/server/run.ts`), en
  croisant avec `error`/`finishedAt` — le bilan décrit une notation *tentée*.

### Trois points laissés ouverts par la vague

- **`épurerChemins` ne caviarde pas les références `op://…`** (`src/core/erreurs.ts`).
  Une référence n'est pas une valeur, mais elle nomme le coffre. Contourné en ne
  la citant pas dans le message servi ; le trou reste pour tout autre message.
- **`sauterLeRendu` tient des fichiers périmés pour complets**, et les écritures
  du `.txt` ne sont pas ordonnées entre `PATCH` et `renderClip`. Les deux se
  referment ensemble avec une empreinte de rendu persistée, dans `render.ts`.
- **Trois trouvailles consignées sur la PR #31 et non traitées** : `round(score, 3)`
  fait franchir le seuil inclusif de 0,5 à une confiance de 0,4996 ; un
  `--scene-threshold` sous le plancher de collecte de 0,05 ne s'applique pas ; et
  **la validation avant renommage n'est exercée par aucun test** — la plus
  sérieuse, la propriété est annoncée en tête de fichier et inverser les deux
  lignes laisserait la suite verte.

### L'environnement et l'outillage

Quatre faits payés par la vague du 18 août, et qui coûtent cher à redécouvrir.

- **Chaque worktree d'agent a besoin de son propre `node_modules`.** Le partager
  par lien symbolique paraît gratuit et ne l'est pas : un `pnpm install` lancé
  depuis n'importe quel worktree **recâble les liens de la racine** pour les faire
  passer par lui. Node résout quand même — le chemin reboucle — donc les tests
  passent et rien n'avertit ; mais Turbopack refuse un chemin qui sort de la
  racine du projet (`Could not find the Next.js package`) et le serveur de dev
  meurt. Avec les liens matériels de pnpm, sept installations réelles coûtent
  **300 Mo**. L'économie n'a jamais existé.
- **`next dev` et `next build` ne démarrent pas dans un worktree** dont le
  `node_modules` sort de l'arborescence. Seuls `vitest`, `tsc` et `eslint` y
  tournent. Une vérification qui a besoin d'un vrai serveur passe par un harnais
  HTTP Node montant les mêmes gestionnaires.
- **`eslint` lancé depuis la racine lit les worktrees** et échoue sur les types
  générés par Next qui s'y trouvent. Ce n'est pas un défaut du dépôt : la CI part
  d'un clone frais et ne les voit pas. Restreindre à `src scripts tests` pour un
  contrôle local honnête.
- **Le venv de détection pèse 7,8 Go** et `setup.sh` le construit dans
  `worker/venv`, avec les poids YOLO dans `worker/models` (149 Mo, release
  épinglée, somme SHA-256 vérifiée). Les deux sont ignorés par git — vérifié :
  zéro chemin sous `worker/venv` dans tout l'historique. Ne jamais les laisser
  entrer dans un commit.

Le reste — la variance de 40 à 80 % des mesures prises sous WSL, l'absence de
throttling thermique, les alias interactifs de `rm`, `cp` et `mv` — est dans
`CLAUDE.md`, section « L'environnement ».

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

`main` est protégée : suppression et force-push refusés, fils de review résolus
avant merge. **Une dérogation existe pour le rôle administrateur**, posée le
18 août pour que la documentation de reprise — ce fichier — puisse être poussée
directement sans un cycle de review complet.

GitHub ne sait pas restreindre une dérogation à un chemin : elle vaut donc aussi
pour le code, et rien de mécanique n'empêche d'y pousser. **Ce qui la tient est
une règle, pas un verrou** : du code passe par une PR, toujours. Ce que la vague
du 18 août a établi vaut d'être relu avant de s'en dispenser — treize trouvailles
réelles sur une seule PR, dont un interblocage et une boucle infinie.

**L'agent fusionne sa propre PR** quand tout est vert, tous les fils résolus, et
après `git merge origin/main` suivi d'une revérification : plusieurs PR
fusionnées en parallèle périment le vert les unes des autres. L'orchestrateur ne
fait pas barrage — mais il ne fusionne pas non plus **sous** un agent qui tient
encore sa boucle : le merge supprime la référence distante, une poussée qui
arrive juste après recrée la branche avec un commit orphelin, et les derniers
correctifs restent hors de `main`. C'est arrivé deux fois le 18 août.

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
filtergraph de rendu. Ils ne sont pas décoratifs — et la vague du 18 août l'a
confirmé plus durement encore : un interblocage sur un tube stderr saturé et une
boucle infinie sur une dimension nulle, tous deux dans `worker/detect.py`, tous
deux trouvés en review.

**Mais le critère d'arrêt écrit ci-dessus ne termine pas, et c'est mesuré.** Sur
les sept PR du 18 août : passes 1 à 3, **17,7 trouvailles par passe** ; passes 4
et suivantes, **2,1 par passe sur un plateau plat**. Et la part de défauts
d'exécution **monte** avec les passes (77 % puis 82 %) au lieu de baisser. Une PR
a coûté **douze passes** et 574 000 jetons, avec une trouvaille réelle à chacune.

Attendre « une passe qui ne rend que du cosmétique » est donc attendre un état
qui n'arrive jamais. **Le critère est le rendement en valeur absolue, et il
s'applique même quand la passe trouve du réel** — c'est le cas normal ici, pas
l'exception. Trois passes, puis on fusionne.

La cause est connue : **47 % des trouvailles portent sur du code écrit après la
première review**, c'est-à-dire sur les correctifs eux-mêmes, que personne n'a
relus. Un correctif écrit en réaction à un commentaire, par un agent qui a déjà
brûlé l'essentiel de son contexte, mérite le même soin qu'une implémentation —
avec son test. C'est là qu'est le levier, pas dans un meilleur critère d'arrêt.

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

Des clips `clip_verif_*` restent en base ; les rendus de `clip_verif_auto` ont
été effacés par une vérification du 18 août.

**`assets/brand/` est vide dans le checkout principal** — `logo.png` et
`twitch.png` ont disparu entre les rendus du matin, qui les portent incrustés, et
l'après-midi. Le dossier est ignoré par git : les marques appartiennent à
l'opérateur et personne ne peut les rendre. Deux substituts fabriqués pour les
tests subsistent dans le worktree `fond-floute`. **Le vrai risque est ailleurs** :
`collecterMarques` traite un dossier vide comme « rendre sans marque », en
silence — donc une série entière peut sortir sans logo sans que rien ne le
signale.

**Les worktrees d'agents pèsent 13 Go** sous `.claude/worktrees/`. Avant d'en
supprimer un, `git status --short --ignored` : un worktree ne contient pas que du
versionné. Celui de l'analyse porte les **7,8 Go du venv de détection et les
poids YOLO**, qui n'existent nulle part ailleurs.
