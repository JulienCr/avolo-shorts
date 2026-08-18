# Feuille de route

Ce fichier est le point d'entrée pour reprendre le projet. Il dit où en est la
chaîne, ce qui reste et ce qu'il faut savoir pour orchestrer la suite sans
repayer ce qui a déjà été payé.

Deux autres documents font autorité et ne se remplacent pas :
`CLAUDE.md` porte les décisions à ne pas défaire et l'environnement,
`docs/superpowers/specs/2026-08-17-avolo-shorts-design.md` porte la conception
et les mesures qui la fondent.

## Où en est le projet

**L'itération 0 est livrée, l'interface avec, et la moitié de l'itération 1.**
Dix-sept PR fusionnées le 18 août 2026, **1494 tests**, CI verte à chaque PR.

Ce qui tourne : ingestion depuis le Drive, proxy, extraction audio,
transcription WhisperX, repérage des candidats par Gemini, tri et montage dans
le transcript, cadrage manuel, rendu avec sous-titres karaoké incrustés et
logo, export en deux formats, l'API qui pilote le tout — et, depuis cette
vague, la détection des corps et des plans, le cadrage automatique en fonctions
pures, et les secrets résolus depuis 1Password.

**Le parcours est entier, et vérifiable à la souris.** C'était le critère de
réussite que la conception se donnait : *sans avoir tapé un chemin ni ouvert un
terminal*, choisir une source, lancer l'analyse, la suivre, reprendre une
exécution morte, trier au clavier, monter dans le transcript, cadrer, exporter,
copier les textes. Six des sept lots de la §8 sont livrés — il ne reste que le
septième, le cadrage automatique, et il attend l'itération 1.

Deux vagues d'agents l'ont écrit. La première a posé le contrat et le socle : le
`StepName` client dérivé du graphe, `POST /run` en liste de cibles, le bilan du
repérage dans `status.json`, `GET /api/sources`, puis `phaseProjet`, la
navigation décrite une fois, le protocole d'écriture différée sorti des pages et
les huit primitives manquantes. La seconde a écrit les trois écrans.

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

### L'interface est livrée, sauf son dernier lot

Les trois écrans sont en ligne (PR #50, #51, #52). Ce qui suit dit ce qu'il faut
savoir avant d'y toucher, et ce qui reste.

**Ce que le serveur impose, et qu'une interface écrite sans le savoir
présenterait comme des erreurs.** Ces contraintes ne disparaissent pas parce que
les écrans existent : elles sont désormais tenues quelque part, et les défaire
casse un comportement voulu.

- **L'export est synchrone et dure de dix secondes à une minute.** Le bouton est
  un indicateur de travail et n'est pas annulable — le rendu ffmpeg ne
  s'interrompt pas proprement.
- **`skipped: true` au ré-export est un cas nominal**, et l'écran le dit comme un
  succès.
- **Un clip a une ou deux sorties.** `variant9x16Due` distingue « n'existera
  jamais » de « due, pas encore produite ».
- **Un `PATCH` refusé pour jeton périmé est un cas nominal**, et `applied: false`
  réconcilie l'état local — sinon l'intention refusée repart avec un jeton neuf,
  gagnant. La réconciliation est dans `src/lib/enregistrement.ts`, et **elle est
  aujourd'hui neutralisée par l'issue #55** : les rappels de `mutate` vivent sur
  un observateur partagé, qu'une écriture de titre vole au montage.
- **Le ratio et les crops se recalculent sur les segments courants**, ils ne sont
  pas stockés. Retirer un passage peut changer le ratio sous les doigts.

**Le lot 7 reste, et il n'attend pas l'interface.** Mode de cadrage explicite,
retour à l'automatique, historique d'annulation étendu au cadrage, bande des
plans, dérogation par plan (§3.5). Une PR d'écran, à peu près la taille de #50.
Mais il est **bloqué en amont** par les quatre morceaux d'itération 1 listés
au-dessus, à commencer par le filtre du premier plan. Le montrer avant eux
reviendrait à offrir de déroger à un cadrage automatique qui ne calcule rien
d'utilisable.

**Ce qui a été payé cher et qu'il ne faut pas défaire.** Les deux plus subtils,
trouvés en review et documentés au point d'appel : la garde des raccourcis doit
écarter **tout élément qui traite déjà la touche** (`button`, `a[href]`,
`[role="button"]`, `[role="tab"]`, `[role="slider"]`, `summary`), faute de quoi
le clavier meurt dès qu'on décide à la souris — le focus reste sur le bouton et
plus rien ne répond, pendant que la carte garde son anneau de sélection. Et le
compteur de temps du panneau d'avancement **ne compte pas des battements** : un
onglet en arrière-plan les étrangle, et l'écran affirmerait trois minutes là où
neuf se sont écoulées, sur la seule surface censée dire l'attente.

**`use(params)` ne se résout pas sous jsdom.** Les trois écrans vivent donc dans
`src/components/<étape>/ecran-*.tsx` et leur fichier de route tombe à quelques
dizaines de lignes. Ce n'est pas une préférence de style : c'est la seule façon
de monter un écran en test, et l'extraction a révélé trois défauts au premier
montage sur l'écran de projet.

### Ce que les vagues ont laissé, et où c'est suivi

Tout est en tickets. **Le tracker fait autorité ; cette section ne le double pas**,
elle dit seulement quoi lire en premier.

**Les deux qui comptent, dans cet ordre :**

- **#55 (P1, correctif d'une ligne)** — les rappels passés à `patch.mutate` vivent
  sur un observateur que `usePatchClip` partage entre le montage et les écritures
  de champs. Taper un titre pendant que le montage s'enregistre **vole ses
  rappels** : la réconciliation d'un `PATCH` refusé n'a jamais lieu, l'intention
  écartée repart avec un jeton neuf et gagne, et un échec devient muet pendant que
  la barre affiche « enregistré ». C'est exactement la garantie d'ordre que le
  socle avait été écrit pour établir. `mutateAsync` la referme.
- **#48 (P1)** — un rendu peut se dire à jour sans l'être, par quatre chemins qu'une
  seule empreinte de rendu persistée ferme.

**Les trois autres :** #54 (la conception contredit le code sur six points
vérifiés, à reprendre en une fois), #56 (six restes d'interface, chacun borné et
documenté au point d'appel), #41 (les vignettes de source, avec la mesure et
l'argument qui la rend discutable), #49 (deux résidus du caviardage).

Ce qui a été fermé en route : #37, #38, #39, #40.

- **Le caviardage des `op://…`** est livré (#38). Deux résidus restent, groupés
  dans l'**issue #49** : un nom de coffre à espaces survit hors citation, et rien
  ne lie les préfixes qu'`estRéférence` accepte au motif de `src/core/erreurs.ts`.
- **`sauterLeRendu` et l'ordre d'écriture du `.txt`** sont dans l'**issue #48**,
  avec deux cas de plus découverts depuis : un clip peut rester `exported` sur un
  rendu périmé quand un `PATCH` arrive pendant l'encodage, et les rendus déjà sur
  le disque sans marque ne repasseront jamais par la porte de #37. Les quatre se
  referment par une empreinte de rendu persistée.
- **Les trois trouvailles de la PR #31** sont traitées (#40) : la validation avant
  renommage est exercée par trois tests — vérifiés par mutation, dans les deux
  sens —, `round(score, 3)` est devenu une troncature vers le bas pour que le
  seuil inclusif dise ce qu'il dit, et un `--scene-threshold` sous le plancher est
  désormais refusé plutôt qu'ignoré.

**Un résidu de mesure, laissé exprès et sans ticket.** La collecte de scène
utilise `select='gt(scene,plancher)'`, strict, alors que `plans()` retient de
façon inclusive. L'asymétrie est fermée par le refus de l'égalité, pas supprimée ;
`gte` existe dans le binaire de `setup.sh` (N-126188) et est bien inclusif —
vérifié, `gte(0.5,0.5)` retient 20 images sur 20 là où `gt` n'en retient aucune.
Ce n'est pas fait parce que ça touche la passe de scène dont le seuil de 0,4 a été
mesuré image par image, et qu'**aucun test du CI ne peut la couvrir**, faute de
ffmpeg sur le runner. À traiter par qui reprendra le détecteur, avec sa mesure.

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
- **`next dev` et `next build` marchent dans un worktree qui a sa propre
  installation**, et échouent seulement quand son `node_modules` sort de
  l'arborescence — c'est-à-dire dans le cas du lien symbolique décrit juste
  au-dessus, où Turbopack refuse un chemin qui quitte la racine du projet. Les
  deux ont été éprouvés : `next dev` est prêt en moins de 200 ms, `next build`
  passe. La formulation précédente laissait croire qu'un worktree ne pouvait pas
  servir de vrai serveur et envoyait fabriquer un harnais HTTP Node ; ce n'est
  pas nécessaire. Deux choses à savoir en revanche : le port est figé à 4005 dans
  `package.json`, donc deux worktrees se le disputent (`pnpm exec next dev -p
  4006`), et **`STAGE_DIR` et `PROJECTS_DIR` sont relatifs dans `.env`** — copié
  tel quel, un worktree part sur un `./projects` vide et l'interface se charge
  sans rien montrer, ce qui ressemble trait pour trait à une régression.
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

### La publication, qui s'ajoute et dont l'horloge tourne déjà

Un spike du 18 août 2026 a sorti la publication du hors-périmètre. Sa conception
est dans `docs/superpowers/specs/2026-08-18-publication-reseaux-design.md` ; trois
choses en ressortent pour qui orchestre.

**Deux audits sont à déposer, et ils ne tiennent pas dans une itération** : deux à
six semaines chez YouTube comme chez TikTok, avec un refus possible. Ils se
déposent donc **avant** le code qui en dépend, en parallèle du reste — c'est le
« lot 0 » de la spec, qui ne contient pas une ligne de code.

**Instagram et Facebook n'attendent rien** et se branchent quand on veut : une app
Meta en mode développement publie réellement, gratuitement, sans revue, sur les
comptes qui ont un rôle sur elle.

**Le connecteur YouTube ne doit pas être écrit avant que son audit soit passé.**
Sans audit, une vidéo envoyée par l'API est verrouillée en privé et ne peut plus
être libérée, même à la main dans Studio : le connecteur produirait une vidéo morte
et un ré-envoi manuel. C'est le contre-sens le plus coûteux du sujet, et il est
d'autant plus facile à commettre que l'intuition désigne TikTok comme la
plateforme difficile.

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

**Aristarque est coupé depuis le 18 août au soir**, faute de jetons. Il reste
Codex et Copilot. Son silence n'est pas une passe en attente : un agent qui
l'attendrait ne fusionnerait jamais.

**L'interrupteur est la variable de dépôt `ENABLE_ARISTARQUE`**, à `false`, lue
par `.github/workflows/pr-review.yml`. Elle vit dans *Settings → Variables* et
non dans le fichier, pour que couper la review ne demande ni un commit ni qu'une
branche reparte de `main`. Deux pièges que le workflow documente au point d'appel
et qui valent d'être relus avant d'y toucher : `false`, `0`, `no` et `off`
éteignent, mais une variable **supprimée** rend une chaîne vide que l'action lit
comme *allumé* — le sens de la panne va vers la review qui tourne, jamais vers
une PR qu'on croirait relue. Pour éteindre, on pose la valeur.

**Un mot pour deux choses, et il faut les séparer.** Le workflow appelle « trois
passes » les trois *axes* d'une même review — régression fonctionnelle, doctrine,
données et accès — lancés en parallèle puis fusionnés. Le critère d'arrêt plus
bas appelle « passes » les *relances* successives sur une PR. Un agent qui
confondrait les deux fusionnerait après un seul tour de review. La mesure qui
fonde le critère porte sans ambiguïté sur les relances : elle compte douze passes
sur une PR, et attribue 47 % des trouvailles à des correctifs écrits *entre* deux
d'entre elles — ce que trois axes simultanés ne peuvent pas produire.

**L'axe « données et accès » ne se débranche jamais**, à aucun cran d'effort, sur
aucun type de PR. Un `.md` publie une clé aussi bien qu'un `.ts` : un exemple de
configuration avec un vrai jeton, un endpoint interne, un chemin de montage, une
mesure copiée d'une sortie de commande — et ce dépôt est public. Le seul chemin
qui retirerait cet axe est une liste explicite dans l'input `passes`, qui
court-circuite **toutes** les règles, garde-fou compris. Ne pas s'en servir pour
économiser sur une PR de documentation : c'est l'axe qui ne pouvait rien y
trouver qu'on croit couper, et c'est l'autre qu'on coupe. Le critère d'arrêt ne change pas — trois
passes —, il porte sur deux relecteurs au lieu de trois, et le bloc replié de
Copilot devient d'autant plus le seul endroit où le gros des trouvailles se
trouve. Ce qui suit décrit les trois surfaces, Aristarque compris, pour le jour
où il sera rallumé.

En rater une fait passer une PR pour propre alors qu'elle ne l'est pas :

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

**Les marques sont retrouvées, et l'endroit vaut d'être noté.** `logo.png` et
`twitch.png` avaient disparu d'`assets/brand/` entre les rendus du 18 août au
matin, qui les portent incrustés, et l'après-midi. Elles ont été récupérées dans
**`~/dev/openshorts/assets/brand/`** — le projet que celui-ci remplace, où elles
sont ignorées par git pour la même raison — et vérifiées par `collecterMarques` :
`logo.png` 1000x996, `twitch.png` 996x224, toutes deux en RGBA, au-delà du
plancher que documente `assets/brand/README.md`.

**Elles ne sont versionnées nulle part, et c'est délibéré** : elles appartiennent
à l'opérateur et ce dépôt est public. Elles n'ont donc survécu que par un
checkout voisin, ce qui n'est pas une sauvegarde. Un worktree neuf naît sans
elles ; `avolo-apercu` les y recopie comme il recopie le `.env`.

**Le silence, lui, est fermé** : l'issue #37 est livrée. Un clip dont `branding`
vaut `true` — la valeur par défaut de tout clip repéré — refuse de se rendre
quand **aucune** des deux marques n'est exploitable, avant tout encodage. Une
seule des deux suffit : rien ne distingue « l'opérateur n'a qu'un logo » d'une
dégradation, alors que zéro ne se confond avec rien.

**Ce qui reste, et qui se voit à l'image** : les trois rendus présents sur le
disque le 18 août — celui de 6 h 50 comme ceux de 14 h 08 — **ne portent aucune
marque**, vérifié en isolant la bande des 13 à 52 % de hauteur. La ligne qui
affirmait ici que « les rendus du matin les portent incrustés » était fausse.
Et ces fichiers-là ne repasseront jamais par la nouvelle porte : `sauterLeRendu`
constate leur présence, pas leur contenu, donc l'export les saute et répond
`skipped: true`. Le remède est `--force`, la cause est l'issue #48.

**Quatorze worktrees traînent** sous `.claude/worktrees/`, dont neuf dont la
branche est fusionnée. Avant d'en supprimer un, `git status --short --ignored` :
un worktree ne contient pas que du versionné. Celui de l'analyse porte les
**7,8 Go du venv de détection et les poids YOLO**, qui n'existent nulle part
ailleurs, et chacun porte son propre `node_modules` — une vraie installation,
jamais un lien, pour la raison écrite plus haut.

Deux d'entre eux ne sont pas des worktrees d'agent : `apercu-feat-ui-*` sont
créés détachés par `~/.local/bin/avolo-apercu`, qui sert une branche sur un
serveur de développement sans la prendre à son agent. Ils se recyclent, ils ne se
gardent pas.
