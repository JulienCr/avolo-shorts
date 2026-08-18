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
Vingt-deux PR fusionnées le 18 août 2026, **1594 tests** sur 71 fichiers, CI
verte à chaque PR.

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

**Le filtre du public au premier plan est livré** (PR #61), et il ne suffit pas.

Le discriminateur n'est pas un seuil de hauteur : c'est le bord bas **et** une
tranche courte — `y1 ≥ 0,97` et une hauteur sous 0,35 —, et ce second seuil n'a
pas été choisi. Conditionnée au contact du bord, la hauteur est bimodale et le
creux est profond : **29 boîtes sur 26 436 entre 0,32 et 0,40**. Trois pistes ont
été écartées à l'image et non à l'histogramme — le rapport largeur/hauteur ne
tranche pas, la hauteur seule jette 3 075 comédiens lointains, le bord bas seul
jette 76 % des comédiens.

Sur `2025-06-15-cqlp`, l'empan médian tombe de 0,661 à 0,540, la part des images
tenant dans un 1:1 monte de 31,3 % à 55,1 %, et 25 fenêtres de 30 s sur 197 se
resserrent sans qu'aucune ne s'élargisse. **Et pourtant les dix clips réels
sortent tous en 16:9, avant comme après.** Sur quatre d'entre eux les deux
comédiens sont réellement aux deux bords : l'empan résiduel vaut 0,61 pour un 1:1
qui en couvre 0,5625, et le ratio est juste.

Le piège que cette mesure a fermé mérite d'être gardé : **le filtre naïf sur le
bord bas seul paraît bien meilleur — 90,4 % en 1:1 — parce qu'il vide 64 % des
images de toute détection.** Une part calculée sur ce qui reste ne dit rien.

**La trouvaille qui compte est ailleurs, et elle touche la prémisse du projet.**
Une part par image ne prédit pas un ratio par clip : 55,1 % des images tiennent
dans un 1:1, contre 20 % des clips. C'est mécanique — le crop est fixe par plan,
donc le ratio se choisit sur ce qu'une position fixe cadre, pas sur ce qu'un crop
libre par image cadrerait. Or la mesure fondatrice de la spec §2, « 48 % du temps
tient dans un 1:1 ou plus serré », est une mesure **par image**. Elle ne soutient
donc pas directement ce qu'on en a conclu pour les clips.

**Personne n'a mesuré la répartition des ratios par clip sur une émission sans
chat incrusté**, et c'est ce chiffre qui dit si l'itération 1 paie : à 16:9 sur
une source 16:9, un crop couvre toute la largeur et n'a rien à placer. La mesure
est en cours sur `2026-03-08-caro-mdlm` — proxy et `analysis.json` sur le disque,
il lui manque audio, transcript et candidats, soit une quinzaine de minutes. Elle
mesure aussi ce que coûte `FramingOptions.margin`, la marge de confort de 2 %
jamais mesurée, qui vaut 0,04 d'empan et arbitre plusieurs clips autour du seuil
du 1:1 — la piste la plus rentable devant toute amélioration du filtre.

**Le cadrage automatique est en service depuis le 19 août 2026.** Le serveur
publie le cadrage résolu dans `ClipDetail.framing` et dans
`PatchClipResult.framing` — ratio natif, ratio et deux positions par plan,
origine du calcul —, le rendu découpe les segments aux frontières de plans, et
l'écran montre ce que l'export produira. Ce que ça a changé au modèle, et qui
n'était pas prévu ici :

- **le ratio se choisit par plan**, plus par clip. Le natif, celui du feed, garde
  le plus large de ses plans d'un bout à l'autre ; la variante 9:16 pose chaque
  plan à son propre cadre sur fond flouté. Ça ne coûte rien parce que la variante
  ne dérive pas du natif (#22) ;
- **les sous-titres et les marques s'incrustent après la composition**, à
  l'échelle du canevas. L'ordre d'avant les réduisait avec l'image : un 16:9 posé
  dans un 9:16 s'y retrouvait à 31,6 % de sa taille ;
- **sans `analysis.json`, le cadrage vaut celui de l'itération 0 et le dit.**
  `renders` ne dépend pas d'`analysis` dans le graphe, donc le cas est
  atteignable ; `origine` le nomme et l'écran l'affiche.

Restent ensuite, dans cet ordre, et **sous réserve de cette mesure** :

1. **La persistance du cadrage.** `computeFraming` reçoit aujourd'hui
   `cropMode: 'auto'` et aucune table : le crop calculé n'est donc jamais
   dérogeable, et le curseur de l'écran est inerte quand le calcul décide. La
   migration porte `cropMode` et la table `crops`, décrites plus bas. La clé
   d'une dérogation est **l'intervalle source du plan**, résolu par recouvrement
   maximal — pas son instant de début, que `computeFraming` indexe encore. Ce que
   décide cette forme n'est pas la frontière qui bouge de trois dixièmes, c'est
   que le seuil de détection sera reréglé et que `plans()` ajoute et retire des
   frontières : une redétection produit exactement des plans divisés et fusionnés.
   Le raisonnement complet est en §3.5 du document de parcours.
2. **Les coupes posées sur les frontières.** `snapToShots` est écrit, pur et
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
  pas stockés. Retirer un passage peut changer le ratio sous les doigts — d'où le
  `framing` que le `PATCH` renvoie, et pas seulement le `GET`.

**Le lot 7 reste, et il n'attend pas l'interface.** Mode de cadrage explicite,
retour à l'automatique, historique d'annulation étendu au cadrage, bande des
plans, dérogation par plan (§3.5). Une PR d'écran, à peu près la taille de #50.
Il est **bloqué en amont** par la persistance du cadrage, sans laquelle une
dérogation posée disparaîtrait au rechargement — et c'est aussi ce qui rend le
curseur de cadrage inerte aujourd'hui quand le calcul décide : il vaut mieux un
contrôle figé qui dit pourquoi qu'un contrôle qui bouge sans rien changer au
fichier produit.

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

**Celle qui compte :**

- **#48 (P1)** — un rendu peut se dire à jour sans l'être, par quatre chemins qu'une
  seule empreinte de rendu persistée ferme. Le quatrième échappe aux cinq champs
  de `leRenduEstPérimé` : les trois rendus sur le disque ne portent aucune marque
  alors que `branding` valait `true` aux deux instants, donc l'empreinte doit dire
  **ce qui a réellement été incrusté**, pas ce qui était demandé.

**Les autres :** #56 (cinq restes d'interface — le point 5 est livré, et son pari
selon lequel il fermerait aussi le point 2 s'est révélé faux, démontré), #57 (le
bilan de repérage annonce une perte quand la récupération a tout rattrapé, P1
quick-win), #65 (le minuteur de l'écriture différée renvoie un `PATCH` après
restauration depuis le bfcache).

Ce qui a été fermé en route : #37, #38, #39, #40, #41, #49, #54, #55.

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
- **Le venv de détection pèse 7,0 Go** et `setup.sh` le construit dans
  `worker/venv` **du checkout principal**, avec les poids YOLO dans `worker/models` (149 Mo, release
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
| 1 | Cadrage automatique : détection de personnes et de plans, ratio choisi sur ce qu'un crop fixe par plan cadre, crop fixe par plan, coupes posées sur les frontières |
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

**Aristarque a été coupé le 18 août au soir faute de jetons, puis rallumé à
20:32 le même jour.** Les trois relecteurs sont donc en service. Vérifier la
variable plutôt que de se fier à ce paragraphe : elle a changé deux fois en une
soirée, et six agents avaient été briefés sur l'état d'avant.

**Ce qui déclenche qui, et c'est ce qui gouverne le coût d'une PR.** Copilot
relit à **chaque poussée** ; Codex ne relit que sur `opened`, `ready_for_review`
et sur `@codex review` explicite, **jamais sur push** ; Aristarque suit son
workflow. Conséquence pratique, mesurée le 18 août sur cinq PR : le nombre de
passes n'est pas choisi, c'est une fonction du nombre de **poussées** — 9 commits
et 5 passes sur une PR d'un seul fichier de documentation. Grouper les correctifs
d'un même tour en une seule poussée est le levier, pas le critère d'arrêt.

Le corollaire tentant — `gh pr ready --undo`, pousser à l'abri, puis `gh pr ready`
— **n'achète pas zéro tour** : le repassage en ready émet `ready_for_review`, donc
un tour complet à **trois** relecteurs au lieu de N tours à Copilot seul. C'est
presque toujours le bon échange, et c'est aussi le seul moyen de redéclencher
Aristarque sans `gh workflow run` ; ce n'en est pas un couvercle. Et `--undo`
porte « if supported by your plan » : son échec est silencieux dans la mauvaise
direction — la PR reste en ready, les relecteurs relisent, et l'agent croit avoir
mis un couvercle. Vérifier le code de sortie. Une PR en brouillon n'accepte pas
l'auto-merge, ce qui ordonne la manœuvre et la procédure de plafond.

**Le pied de page d'Aristarque peut contredire ses sections.** « Rien à signaler »
partout, et en bas `⚠ passes « … » non abouties` : le verdict ne vaut alors que
pour les axes qui ont abouti. Quatre cas le 18 août. Deux causes distinctes — une
passe tuée par le `timeout-minutes` sur un run à 200k+ jetons, et un axe non lancé
faute de fichier exécutable dans le diff. Lire le pied avant les sections.

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
  `git ls-files -s | grep -E '^(160000|120000)'` avant chaque push. **Les deux
  modes, pas seulement le premier** : `.gitignore` porte `/worker/venv/` et
  `/worker/models/` avec un `/` final, qui ne matche qu'un répertoire, alors que
  `avolo-worktree` y pose des liens symboliques quand on le lui demande — ils
  ressortent donc en `??`, et entreraient en mode `120000`, que le contrôle
  historique ne voyait pas. Trois agents l'ont relevé le même soir.
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

**Les quatorze worktrees périmés ont été retirés** le 18 août au soir, avec 25
branches locales fusionnées. Avant d'en supprimer un, `git status --short
--ignored` : un worktree ne contient pas que du versionné. Et ne pas attendre
grand-chose du nettoyage — les liens matériels de pnpm partagent les inodes entre
installations, donc quatorze worktrees supprimés n'ont rendu que **0,9 Go**. La
raison de les retirer est qu'ils encombrent `git worktree list` et qu'`eslint`
lancé depuis la racine les lit, pas la place qu'ils prennent.

`~/.local/bin/avolo-worktree <nom> <branche>` monte celui d'un agent correctement
du premier coup : branché sur le **HEAD local**, installation réelle, `.env` copié
et `STAGE_DIR`/`PROJECTS_DIR` réécrits en absolu, marques recopiées. Le venv de
détection et les poids YOLO ne sont liés que sous `AVOLO_VENV=1`, et ce lien a
deux effets à connaître : `next build` refuse un lien qui sort de la racine du
projet, et les liens ressortent en `??`. Contrairement à ce
qu'affirmait cette ligne, **aucun worktree ne porte le venv de détection** : il
vit dans `worker/venv` du checkout principal, et un worktree ne l'obtient que si
`avolo-worktree` l'y lie sur demande. Chacun porte son propre `node_modules` — une vraie installation,
jamais un lien, pour la raison écrite plus haut.

Deux d'entre eux ne sont pas des worktrees d'agent : `apercu-feat-ui-*` sont
créés détachés par `~/.local/bin/avolo-apercu`, qui sert une branche sur un
serveur de développement sans la prendre à son agent. Ils se recyclent, ils ne se
gardent pas.
