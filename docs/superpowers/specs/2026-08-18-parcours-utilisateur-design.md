# Parcours utilisateur : conception de l'interface

Date : 18 août 2026.
Statut : proposition. Aucune ligne de `src/` n'a été écrite pour l'accompagner.

Ce document décide de la **forme du parcours** et de ce que chaque écran doit
porter. Il ne décide ni du pipeline, ni de l'API, ni du cadrage : la conception
qui fait autorité reste
`docs/superpowers/specs/2026-08-17-avolo-shorts-design.md`, et les sept décisions
de `CLAUDE.md` sont tenues pour acquises. Là où j'estime que l'un des deux devrait
changer, je le dis en section 9 et je laisse Julien trancher.

Il s'appuie sur une lecture complète des trois écrans, des cinq composants métier,
du store et des routes qui les alimentent, au commit `5412597`, et sur ce que la
session qui tient le travail serveur a annoncé de la suite : les trois fonctions
clientes qui manquent, le jeton de séquence sur `PATCH`, le décompte des lots
refusés par Gemini, et le passage de `cropX` à `number | null` quand le cadrage
automatique arrivera.

## 1. L'état actuel

L'interface est jugée « déplorable » par son propriétaire. Ce jugement est juste,
mais il porte moins sur ce qui est écrit que sur ce qui manque : chaque fichier
pris isolément est soigné, commenté et sait défendre ses choix. Ce qui manque est le
niveau au-dessus. Personne n'a possédé le parcours, exactement comme personne
n'avait possédé le raccord de l'export (voir `ROADMAP.md`, « la cause est une
couture d'orchestration »).

### 1.1 Trois routes que personne n'appelle

`src/lib/api.ts` ne fait aujourd'hui que quatre `GET` et un `PATCH`. Les trois
routes qui **font** quelque chose n'ont aucun appelant côté client.

| Route | Ce qu'elle fait | Ce que l'interface en propose |
|---|---|---|
| `POST /api/projects` | ingérer un replay et lancer son analyse | rien. La création se fait en `curl` |
| `POST /api/projects/:id/run` | recalculer jusqu'à une cible, avec `force` | rien, alors qu'un bandeau conseille de « relancer le repérage depuis le projet » |
| `POST /api/clips/:id/export` | rendre un clip | rien. L'écran affiche l'étiquette « exporté » et ne sait pas exporter |

Trois parcours orphelins, donc, pas deux : l'entrée, la reprise et la sortie.
Entre eux, ce qui existe fonctionne. C'est le pire des cas de figure pour un
utilisateur : le milieu du chemin est pavé et les trois portes sont fermées.

La session qui tient le travail serveur livre les trois fonctions clientes
(`createProject`, `runProject`, `exportClip`) et la route qui sert un rendu en
requêtes partielles. Elle gèle `src/app/**` et `src/components/**` de son côté :
tout ce que décrit ce document est du ressort de l'interface, et rien n'y attend
plus une route qui n'existe pas.

### 1.2 `src/app/page.tsx` (60 lignes)

1. **Le mauvais écran d'accueil.** Il liste les projets, alors que l'entrée du
   parcours est le choix d'une source parmi 21 replays (spec §13). Les deux listes
   sont utiles et ce ne sont pas les mêmes : l'une est un point de départ,
   l'autre une bibliothèque de travail en cours.
2. **Aucun projet n'y dit son état.** `résuméProjet` rend quatre champs, dont
   aucun ne dit si l'analyse tourne, a fini ou a échoué. Un projet créé il y a
   trois secondes et un projet transcrit s'affichent à l'identique, à ceci près
   que le premier annonce `0:00` de durée, ce que `vues.ts` documente comme
   normal. Sur un parcours dont la deuxième étape dure entre neuf et
   trente-cinq minutes, c'est l'écran qui devrait porter le suivi, et il est muet.
3. **Ni état vide ni état d'erreur.** `projets.isError` n'est jamais lu : une API
   en panne rend exactement la même page qu'une bibliothèque vide, c'est-à-dire un
   titre suivi d'un paragraphe. Et une bibliothèque vide ne propose rien.
4. **Le seul texte éditorial de l'écran explique une structure de données** :
   « Un clip est une liste de segments : on raccourcit une vanne trop longue en
   retirant son milieu ». C'est vrai, c'est bien écrit et c'est adressé à un
   développeur.
5. Une colonne de `max-w-3xl` sur un écran de bureau : la spec §13 demande « un
   rendu d'application de bureau plutôt que de site web », et cette page est une
   page de site.

### 1.3 `src/app/projects/[id]/page.tsx` (203 lignes)

Le meilleur des trois écrans. Quatre défauts, dont un qui touche au cœur du
produit.

1. **L'attente tient dans 112 pixels.** `Progression` est une barre `w-28` posée
   dans la barre d'application, avec le nom de l'étape et un pourcentage. Pour une
   analyse qui dure entre neuf et trente-cinq minutes, c'est toute la surface de
   retour. Rien ne dit le temps écoulé, rien ne dit combien d'étapes restent, rien
   ne dit que le proxy est la plus longue et qu'elle passe en dernier.
2. **Rien ne relance.** `POST /api/projects/:id/run` existe et il est testé ;
   **aucun écran ne l'appelle**. La bannière d'échec dit « Relancer le repérage
   depuis le projet » : elle décrit une action que l'écran qui l'affiche ne
   propose pas. Or `running` se lit dans une `Map` du processus Next
   (`run.ts:progression`) : un redémarrage du serveur, et il y en a un à chaque
   édition en développement, laisse un projet à moitié analysé, sans erreur, sans
   rien qui tourne et sans bouton. C'est une impasse, au sens propre.
3. **L'état vide ment pendant les trois premières minutes.** `candidats.length
   === 0` affiche « Aucun candidat pour le moment / Le repérage n'a rien rendu, ou
   il n'a pas encore tourné ». C'est ce qu'on voit pendant toute la
   transcription. L'état vide doit être fonction de l'état du pipeline, jamais de
   la longueur de la liste.
4. **La boucle de tri n'a aucun instrument.** Pas un raccourci clavier sur
   vingt-cinq à trente décisions. Pire, la carte qu'on vient de juger **disparaît
   sous la main** quand on l'écarte, ce qui reflue toute la grille : l'élément
   suivant n'est plus là où l'œil l'attendait. Et rien ne marque la fin de la
   boucle, puisque « Tout est trié » ne s'affiche que dans le cas rare où tout a
   été écarté.

### 1.4 `src/app/clips/[id]/page.tsx` (477 lignes)

1. **L'aperçu de cadrage montre la mauvaise image.** C'est le défaut le plus
   coûteux de l'interface, parce qu'il porte sur la mesure qui justifie le projet.
   L'écran affiche la source 16:9 avec un rectangle et deux bandes assombries : il
   montre **ce qu'on garde de la source**. Ce que le choix du ratio décide, c'est
   la part de l'écran du téléphone que le contenu occupera : 32 % de la hauteur en
   16:9, 56 % en 1:1, 70 % en 4:5 (spec §2). Arbitrer entre 1:1 et 4:5 en
   comparant deux rectangles larges de 56 % et 45 % sur une image couchée cache
   exactement la différence qu'on cherche à voir.
2. **On ne peut pas écrire le titre ni la description.** `ClipPatch` les accepte,
   `PATCH /api/clips/:id` les valide, l'écran les affiche en lecture seule. Ces
   textes sont un livrable du produit au même titre que le MP4 (spec §3).
3. **Le lecteur ne se scrube pas.** Un bouton lecture/pause, pas de barre, pas de
   raccourci. Juger un montage de quarante secondes impose de le revoir en entier
   à chaque essai.
4. **Le transcript et le lecteur s'ignorent.** Cliquer un mot ne déplace pas la
   lecture, la lecture ne surligne pas le mot en cours. C'est le manque
   fonctionnel le plus important de l'écran, et le combler **ne contredit pas** la
   doctrine : la surface d'édition reste le transcript. C'est même l'inverse, le
   transcript devient le seul organe de navigation temporelle, ce qui rend une
   timeline encore moins nécessaire.
5. **`Ctrl+Z` sans `Ctrl+Shift+Z`.** `history.ts` ne porte qu'une pile `past`.
   Une annulation sans rétablissement transforme le geste de sécurité en pari.
6. **130 lignes de logique métier vivent dans le fichier de page** : `differences`
   et `useEnregistrementAuto`, c'est-à-dire tout le protocole d'enregistrement,
   avec ses trois défauts corrigés en revue. Ce code est le plus subtil de
   l'interface et il est le seul à ne pas être testable sans monter une page.
7. Deux coquilles de page différentes : `h-dvh` ici, `min-h-full` ailleurs.

### 1.5 Les composants

- **`app-bar.tsx`** : un fil d'Ariane que chaque page construit à la main, sous
  forme d'un tableau positionnel. Le modèle de navigation est donc recopié en
  trois endroits. Aucune place pour ce qui tourne.
- **`candidate-card.tsx`** : bonne carte. Trois cibles de clic distinctes (image,
  titre, boutons). L'action « monter ce clip » n'est portée que par un lien
  d'image sans intitulé.
- **`clip-player.tsx`** : le saut des passages retirés est correct et bien
  justifié. `setPosition` à chaque `timeupdate` rend l'arbre entier quatre fois
  par seconde, superposition de cadrage comprise.
- **`crop-picker.tsx`** : le curseur est le composant le mieux écrit du dépôt.
  `aria-valuemin` et `aria-valuemax` portent la plage réelle, la prise garde
  l'écart au centre, les flèches lisent la valeur précédente. Il ne lui manque
  que la bonne image sous les pieds, et une phrase qui dise pourquoi il se fige
  en 16:9.
- **`transcript-surface.tsx`** : le plus soigné. Deux manques : aucune recherche
  dans le texte, alors qu'une émission fait 20 000 mots et que la virtualisation
  neutralise le `Ctrl+F` du navigateur ; et `select-none` ferme le copier-coller,
  ce qui est assumé, mais rien d'autre ne permet de sortir le texte.
- **`src/components/ui/`** : sept primitives. Aucun champ de saisie, aucune boîte
  de dialogue, aucune barre de progression, aucun composant d'alerte. Les quatre
  ont donc été réécrits à la main dans des fichiers de page, avec leur ARIA.

### 1.6 Ce qui est bon et qu'il ne faut pas casser

La liste compte, parce qu'une refonte détruit d'abord ce qu'elle n'a pas compris.

- Le lecteur qui saute les passages retirés, et la phrase qui prévient que
  l'à-coup n'existe pas au rendu.
- L'écriture optimiste du tri et son jeton de séquence par clip (`queries.ts`).
- L'enregistrement différé et son vidage sur `pagehide` avec `keepalive: true`.
- La virtualisation par phrase plutôt que par mot.
- Le positionnement initial du transcript sur la première phrase du clip
  **enregistré**, et une seule fois par clip.
- La garde de `charger` dans le store, qui empêche un refetch d'écraser le montage.
- `clip-status.ts` : une seule définition de « gardé », lue par la carte et par le
  gestionnaire de clic.

## 2. La forme du parcours

### 2.1 Cinq étapes qui ne sont pas cinq étapes

Le parcours s'énonce en cinq temps : choisir une source, analyser, trier, monter,
exporter. La tentation est d'en faire un assistant à cinq écrans avec un
indicateur d'avancement en haut. Ce serait faux quatre fois sur cinq.

| Temps | Ce que c'est vraiment | Ce qu'un stepper en dit |
|---|---|---|
| Choisir une source | une décision de trois secondes dans une grille de 21 | une étape à part entière |
| Analyser | une attente de 9 à 15 minutes sans humain dedans | une étape que l'utilisateur « franchit » |
| Trier | une boucle de 25 à 30 itérations, réversibles | une étape unique, franchie une fois |
| Monter | un sous-parcours, réentré une fois par clip gardé | une étape linéaire |
| Exporter | une action terminale **par clip**, entrelacée avec le montage | la dernière étape |

Les deux erreurs qu'un stepper commettrait sont de nature différente. Sur l'étape
d'analyse, il annoncerait une progression que l'utilisateur ne produit pas :
personne ne « fait » une transcription, on la subit. Sur le tri et le montage, il
annoncerait une progression **linéaire sur une boucle**, ce qui est le mensonge
classique : une barre à 40 % au douzième candidat sur trente laisse croire qu'il
reste 60 % du travail, alors que le travail restant dépend du nombre de clips
gardés, qu'on ne connaît pas encore.

Et il y a pire qu'un mensonge : un stepper impose un ordre. Or trois va-et-vient
sont normaux et fréquents. Revenir au tri depuis un clip pour en ouvrir un autre.
Rouvrir un clip déjà exporté parce que le rendu ne convient pas. Écarter, deux
jours plus tard, un candidat qu'on avait gardé. Un assistant qui interdit le
retour arrière transformerait chacun de ces gestes en rechargement de page.

### 2.2 Ce que c'est : un objet qui traverse des phases

Le parcours n'appartient pas à l'utilisateur, il appartient au **projet**. Le
projet est un objet de longue durée, dont l'avancement est un fait du serveur
(quels artefacts existent, quels clips sont décidés), pas un souvenir du
navigateur. L'humain y entre, en sort, y revient le lendemain.

Trois conséquences, et elles guident tout le reste du document.

**Le parcours est reprenable sans état côté client.** L'URL suffit à décrire où
l'on est, parce que l'endroit est un objet et non une position dans une
séquence. Fermer l'onglet ne coûte rien. C'est déjà vrai du code
(`GET /api/projects/:id` relit `steps` sur le disque à chaque appel), et
l'interface ne l'exploite nulle part.

**L'avancement se calcule, il ne se stocke pas.** La phase d'un projet est une
fonction de son relevé de présence, de son exécution en cours et du statut de ses
clips. La stocker en base créerait une seconde vérité qui divergerait de la
première.

**Trois écrans suffisent, et c'est le bon nombre.** Bibliothèque, projet, clip.
Le problème de l'interface actuelle n'est pas son nombre d'écrans : c'est qu'aucun
ne sait dire où l'on en est ni ce qui vient ensuite.

### 2.3 La phase, calculée une seule fois

Une fonction pure, dans `src/core/parcours.ts`, qui ne dépend que de `@/core/graph`
et `@/core/edl` (la frontière de pureté d'ESLint autorise cela, et rien d'autre).

**Deux axes, pas un.** L'erreur qui vient d'abord est d'aligner tous les états sur
une seule échelle. Elle ne tient pas : un projet peut être entièrement trié alors
que son proxy n'est pas fini, et un projet complet peut n'avoir aucune décision
prise. Ce que la machine fabrique et ce que l'humain décide avancent séparément,
et c'est précisément ce que 2.4 exploite.

```ts
/** Ce que la machine a produit. */
export type Analyse =
  | 'neuf'         // inscrit, rien sur le disque
  | 'encours'      // une exécution tourne
  | 'interrompu'   // il manque des artefacts et rien ne tourne
  | 'echec'        // la dernière exécution a échoué
  | 'triable'      // candidats présents, proxy absent : on trie, on ne monte pas
  | 'complet'      // tout est là

/** Ce que l'humain a décidé. */
export type Travail =
  | 'rien'         // aucun candidat encore
  | 'atrier'       // il reste des propositions en attente
  | 'trie'         // plus aucune proposition en attente
  | 'livre'        // tous les clips gardés sont exportés

export function phaseProjet(
  steps: Record<StepName, boolean>,
  running: { step: StepName; progress: number } | null,
  erreur: string | null,
  clips: { status: ClipStatus }[],
): { analyse: Analyse; travail: Travail }
```

Ces dix valeurs ne sont pas un décor. Chacune répond à une question qu'un écran
pose aujourd'hui à sa façon, avec ses propres `if` :

- `interrompu` **n'existe pas dans l'interface actuelle**, et c'est l'impasse
  décrite en 1.3. C'est la seule valeur qui appelle une action de réparation.
- `triable` sépare « on peut décider » de « on peut monter ». Voir 2.4.
- `trie` est l'événement de fin de boucle, aujourd'hui invisible.
- `livre` est le succès du parcours, aujourd'hui inexprimable.

Le couple compte autant que ses membres : `{ triable, trie }` est un état réel et
fréquent, celui où Julien a fini de trier avant que le proxy ne soit encodé.
L'écran doit alors dire « tout est trié, le montage s'ouvre dans trois minutes »,
ce qu'aucune échelle unique ne sait exprimer.

Une conséquence de forme : **la liste des étapes et leurs libellés sont des
données, pas du code d'écran**. Aujourd'hui `LIBELLES_ETAPES` est un `Record`
déclaré dans la page de tri ; ajouter `shots` et `people` en itération 1
obligerait à éditer une page. Le tableau des étapes, avec pour chacune son
libellé, son ordre attendu et son coût mesuré, vit à côté de `phaseProjet`.

### 2.4 L'attente : trois régimes, pas un écran de chargement

**Le fait qui commande tout ici est un ordre d'exécution.**
`CIBLES_INITIALES = ['candidates', 'proxy']` (`run.ts`), et `planPourCibles`
déroule donc : ingestion, audio, transcript, candidats, **puis** proxy. Les
candidats arrivent avant le proxy.

Chiffres mesurés le 18 août 2026 sur `2025-06-15-cqlp.mp4` (4,3 Go, 1 h 39),
consignés dans `ROADMAP.md` :

| | Coût | Cumul |
|---|---|---|
| Copie depuis le Drive | 45 s | 0:45 |
| Extraction audio | 6 s | 0:51 |
| Transcription WhisperX | 1 min 41 | 2:32 |
| Repérage Gemini | 30 s | **3:02, les candidats sont là** |
| Proxy 960x540 | 6 min | **9:02, tout est là** |

Autrement dit : **un tiers de l'attente sépare le lancement de la première
décision possible, et les deux tiers restants ne bloquent que le montage.** Sur
l'émission la plus longue du corpus (2 h 50), les mêmes rapports donnent environ
5 minutes jusqu'aux candidats et 15 minutes au total.

De là, trois régimes et trois écrans différents pour le même projet.

**Régime 1, rien encore (0 à 3 minutes).** L'écran de projet **est** le panneau
d'avancement : il occupe la page, il liste les étapes avec celle qui tourne, le
temps écoulé et le coût attendu de chacune. Une seule chose y compte au-delà de
l'esthétique : dire **ce qui se passera ensuite** (« les propositions arrivent
avant les images ; vous pourrez commencer à trier »), parce que c'est ce qui
détermine si Julien reste ou s'en va.

**Régime 2, triable (3 à 9 minutes).** La grille de candidats remplace le
panneau, qui se replie en une bande dans la barre d'application. Deux
conséquences à assumer explicitement :

- les vignettes sont absentes, puisqu'elles se tirent du proxy
  (`vues.ts:urlVignette` rend `null` sans lui). Le repli actuel dit « vignette en
  attente du proxy », ce qui est exact ; il lui manque **quand** : « les images
  arrivent avec le proxy, dans environ six minutes ». Une attente nommée est une
  attente supportable ;
- l'action « monter » d'une carte est **désactivée avec sa raison**, parce que
  l'écran de clip ne peut rien lire sans proxy. Le tri, lui, marche entièrement :
  titre, durée, trois premières phrases, garder ou écarter.

**Régime 3, complet.** Rien de particulier, et c'est le but.

Ce découpage n'est pas une commodité d'affichage, c'est ce qui rend la
trente-cinquième minute vivable : elle n'existe pas. Il y a trois minutes
d'attente réelle, puis six minutes pendant lesquelles on travaille déjà.

**Que fait Julien pendant ce temps ?** Trois réponses, par ordre de fréquence
attendue. Il s'en va, et le parcours doit rendre le retour gratuit : aucune boîte
de dialogue à rouvrir, aucune sélection à refaire, l'URL suffit. Il trie un autre
projet lancé plus tôt, ce qui exige que la bibliothèque montre plusieurs états
d'analyse à la fois. Il attend devant l'écran, ce qui est le cas où le panneau
d'avancement doit être honnête plutôt que rassurant.

**S'il ferme l'onglet ?** L'exécution vit dans le processus Next, pas dans la
page : elle continue. En revanche `progression()` lit une `Map` de ce processus,
donc **un redémarrage du serveur perd l'exécution sans laisser de trace d'erreur**.
C'est le cas `interrompu`, et il se répare par `POST /api/projects/:id/run` avec
la cible manquante. Sans ce bouton, l'utilisateur n'a aucun recours dans
l'interface, ce qui est la situation d'aujourd'hui.

Côté client, `interrompu` se déduit de « il manque une étape et rien ne tourne ».
Le serveur pourrait le dire mieux : `status.json` porte le `pid` du processus qui
a lancé l'exécution, donc un `pid` qui n'est plus le sien distingue une exécution
morte d'une exécution qui n'a jamais eu lieu. Je le signale sans le demander,
parce que la déduction côté client suffit à fermer l'impasse.

### 2.5 Le tri est une boucle, et une boucle a ses instruments

Vingt-cinq à trente cartes, deux décisions par carte, chacune réversible. Ce que
demande cette forme, et que la barre de progression ne donne pas :

**Le reste à faire, pas le chemin parcouru.** « 12 à trier » se lit d'un coup
d'œil et reste vrai quand on change d'avis. « 60 % » ne survit pas à un retour en
arrière. Le compteur existe déjà et il est bon.

**Rien ne bouge sous la main.** Une carte décidée reste à sa place, marquée.
Aujourd'hui, écarter fait disparaître la carte et refluer toute la grille : la
suivante n'est plus sous l'œil ni sous le curseur. C'est le défaut qui coûte le
plus cher sur une boucle, parce qu'il se paie à chaque itération. Le compactage se
fait au changement de vue, jamais au moment du clic.

Le plan (tâche 12, étape 3) demande que les écartés « disparaissent de la vue par
défaut, avec un filtre pour les revoir ». Je propose de lire cette phrase comme
une règle sur **la vue**, pas sur **l'instant du clic** : à l'ouverture de l'écran
et après un rafraîchissement, les écartés ne sont pas là ; pendant la session de
tri en cours, ils restent en place, grisés. Ce que le plan protège vraiment (un
écarté ne revient pas à la passe suivante) est garanti par les données, dans
`mergeCandidates`.

**Les mains sur le clavier.** Sur trente items, l'aller-retour souris devient le
coût dominant. `J`/`K` pour se déplacer, `G` pour garder, `E` pour écarter,
`Entrée` pour ouvrir, `U` pour défaire la dernière décision. Ce n'est pas un
confort d'expert : c'est ce qui fait passer le tri de dix minutes à trois.

**Une fin.** Quand le compteur tombe à zéro, l'écran le dit et propose la suite :
la liste des clips gardés, avec pour chacun son état de montage. C'est la
transition `trie` de 2.3, et c'est aussi le seul endroit du parcours où une
progression linéaire est honnête, puisqu'on connaît enfin le dénominateur.

### 2.6 Le montage est un sous-parcours réentré

L'écran de clip est visité une fois par clip gardé, soit trois à cinq fois par
émission, et il porte lui-même quatre gestes distincts : délimiter, retirer des
passages, choisir un cadre, prévisualiser. Deux exigences en découlent.

**Sa sortie ramène dans la boucle.** Deux issues, pas une : « retour au tri » et
« clip suivant à monter ». La seconde est ce qui évite de repasser par la grille
entre chaque clip, et elle se calcule côté client sur la liste des gardés déjà en
cache.

**L'export vit ici, pas ailleurs.** Le rendu se demande par clip parce que c'est
par clip qu'on choisit le ratio et le cadrage : le lanceur de `run.ts` refuse
d'ailleurs `renders` comme cible pour cette raison. Un écran d'export séparé
ferait sortir du sous-parcours pour y revenir. Voir 3.4.

### 2.7 Ce qui constitue la réussite

Le parcours a réussi quand, **sans avoir tapé un chemin ni ouvert un terminal**,
Julien a sur son disque un MP4 vertical sous-titré et son fichier de textes, tirés
d'un replay qu'il a choisi dans une grille. C'est la vérification de bout en bout
du plan, et c'est le bon critère : « le vrai test est à la souris, pas au curl ».

Trois critères secondaires, mesurables :

- **le tri de 25 candidats tient en moins de cinq minutes**, ce qui suppose le
  clavier ;
- **aucun écran ne peut se trouver dans un état sans action possible**, ce qui se
  vérifie en énumérant les états de la section 3 ;
- **fermer l'onglet à n'importe quel moment ne coûte rien**, ce qui se vérifie en
  rouvrant l'URL.

## 3. Les écrans

### 3.0 La carte, et la règle de navigation

```
/                    bibliothèque : les projets en cours, puis la grille des sources
   │  clic sur une source neuve  -> POST /api/projects -> redirection
   │  clic sur un projet         -> navigation simple
   v
/projects/:id        le projet : avancement, puis tri des candidats
   │  clic sur un candidat gardé -> navigation simple
   v
/clips/:id           le clip : transcript, cadrage, export
   ^__ retour au tri, ou clip suivant à monter
```

**Une seule règle : la profondeur ne dépasse jamais trois, et chaque niveau se
quitte par le haut.** Le fil d'Ariane de `app-bar.tsx` porte déjà cette forme ; ce
qui lui manque est de la connaître au lieu de la recevoir. Le module qui décrit la
navigation est décrit en 5.2.

**Rien ne s'ouvre en modale sauf une confirmation.** Un clip ouvert en panneau
au-dessus de la grille rendrait son URL impartageable et son rechargement
impossible, sur l'écran précisément où l'on passe le plus de temps.

### 3.1 Bibliothèque (`/`)

**Objectif unique** : reprendre un travail en cours, ou en commencer un.

**Un écran, deux sections, les projets d'abord.** La grille des 21 sources est
l'entrée du tunnel (tâche 15), mais ce n'est pas le geste quotidien : une émission
par semaine arrive, et chacune se travaille en plusieurs séances. Ce qu'on ouvre
le plus souvent est un projet déjà lancé. Les deux sections sur le même écran
évitent par ailleurs un choix arbitraire d'écran d'atterrissage.

**Une source déjà analysée porte la marque de son projet et mène à lui**, au lieu
de relancer une création. Techniquement `POST /api/projects` est idempotent sur ce
cas (le plan revient vide), mais proposer deux chemins vers le même endroit sans
le dire fait douter de ce qu'on vient de déclencher.

| | |
|---|---|
| **Repérage** | le titre de l'écran et la marque du produit. C'est la racine, elle n'a pas de fil d'Ariane. |
| **Navigation** | sortante seulement. Un projet mène à son écran, une source neuve crée un projet puis y mène. |
| **Persistance aller** | aucune. Il n'y a rien à saisir. |
| **Persistance retour** | la position de défilement de la grille des sources, gardée pendant la session. Vingt et une cartes chargées à la demande : revenir en haut à chaque retour ferait redemander les vignettes déjà vues. |
| **Validation** | aucune saisie, donc aucune validation. La seule erreur possible vient du serveur. |

**Les cinq états**

| État | Ce qui s'affiche |
|---|---|
| Chargement | squelettes aux dimensions finales, pour que la grille ne saute pas quand les cartes arrivent. Les vignettes ont leur propre chargement, plus lent, indépendant. |
| Vide | deux vides distincts, et les confondre serait un défaut de diagnostic. **Aucun projet** : la section disparaît, la grille prend toute la place. **Aucune source** : la ligne de montage de `GET /api/sources` dit `fstype` et `entries`, donc l'écran distingue « ce dossier est vide » de « ce montage n'a pas eu lieu » (spec §12, incident réel d'OpenShorts). |
| Erreur | `GET /api/sources` en échec affiche le message du serveur et un bouton « réessayer ». Le 503 de `POST /api/projects` sur un Drive muet a son propre texte, déjà écrit côté serveur : le reprendre tel quel plutôt que le réécrire. |
| Désactivé | la carte sur laquelle on vient de cliquer, le temps que `POST /api/projects` réponde. La réponse arrive en quelques centaines de millisecondes, mais elle traverse un `lstat` sur un montage 9p qui peut mettre plusieurs secondes : sans cet état, on clique deux fois. Un second cas viendra plus tard, la source dont le fichier grossit encore parce que le live vient de finir, que rien ne surveille en itération 0. |
| Succès | la création répond 202 et redirige. La redirection **est** la confirmation : une notification en plus dirait deux fois la même chose. |

**Actions destructrices** : aucune. Créer un projet sur une source déjà analysée
ne détruit rien, `créerProjet` réutilisant la ligne existante.

**Pas d'impasse** : chaque état porte une action. Le pire cas, montage absent et
aucun projet, affiche une seule phrase (« le dossier des replays n'est pas
monté ») et le geste qui la répare, pris de `CLAUDE.md` : rouvrir le lecteur côté
Windows.

**Clavier** : la grille est une liste de liens, donc tabulable telle quelle. Les
flèches ne naviguent pas dans la grille : vingt et une cartes ne justifient pas un
gestionnaire de focus bidimensionnel, et `Tab` y suffit.

### 3.2 Projet (`/projects/:id`)

**Objectif unique** : décider quelles propositions valent d'être montées.
L'avancement de l'analyse est sur le même écran non pas comme second objectif,
mais parce que c'est **le même objet à un autre moment de sa vie** (voir 2.4).

| | |
|---|---|
| **Repérage** | fil d'Ariane `avolo·shorts / <émission>`, et sous le titre la phase en toutes lettres : « analyse en cours », « prêt à trier, images dans 6 min », « 12 à trier », « tout est trié ». À côté du compte, **la couverture du repérage** quand elle n'est pas entière : « 27 propositions, tirées de 64 % de l'émission ». Voir 7.2. |
| **Navigation** | vers le haut, la bibliothèque. Vers le bas, un clip. Aucune navigation latérale. |
| **Persistance aller** | rien à transmettre : l'identifiant du projet est dans l'URL. |
| **Persistance retour** | trois choses à retrouver en revenant d'un clip : la position de défilement, la vue active (à trier / gardés / écartés) et le focus sur la carte d'où l'on est parti. La vue dans l'URL (`?vue=gardes`), les deux autres dans l'état de session. L'URL pour la vue parce qu'un rechargement doit rendre le même écran ; la session pour le reste, parce qu'une position de défilement dans une URL est une URL qu'on ne peut plus partager. |
| **Validation** | aucune saisie. |

**Les cinq états**, et c'est ici que la distinction paie.

| État | Ce qui s'affiche |
|---|---|
| Chargement | squelettes de cartes tant que `GET /candidates` n'a pas répondu. **À ne pas confondre avec l'attente d'analyse** : le premier dure 200 ms, le second neuf minutes. Aujourd'hui les deux rendent la même grille grise. |
| Vide | quatre vides différents, chacun avec son texte et son action. `neuf` ou `encours` : le panneau d'avancement, pas un message. `triable` avec zéro candidat : le repérage a rendu une liste vide, proposer « relancer le repérage » avec `force`. `trie` : « tout est trié, 4 clips gardés », avec la liste. `echec` : le message du serveur et le bouton de reprise. |
| Erreur | deux origines à distinguer. L'analyse a échoué (`ProjectStatus.error`) : bandeau en `role="alert"`, message serveur, bouton « reprendre l'analyse ». La liste ne se charge pas : message local et « réessayer ». La seconde n'efface pas la première. |
| Désactivé | pendant `encours`, le bouton « relancer le repérage » est désactivé, parce que `lancer` lève `ExécutionEnCoursError` et que la route en fait un 409. Pendant `triable`, l'action « monter » de chaque carte est désactivée : pas de proxy, donc rien à lire. **Dans les deux cas la raison est écrite à côté du contrôle, pas dans une bulle d'aide.** Un contrôle désactivé sans raison visible est un cul-de-sac silencieux. |
| Succès | la décision est optimiste et instantanée : la carte change d'apparence, sans notification. Le succès de la boucle entière, lui, se marque : « tout est trié ». |

**Le panneau d'avancement** porte quatre choses, et pas une de plus : l'étape en
cours et sa progression, la liste ordonnée des étapes avec celles déjà faites, le
temps écoulé depuis le lancement, et une phrase qui dit ce qui devient possible
ensuite. Le temps restant **n'est pas affiché** : les seules mesures dont on
dispose sont deux points sur une émission, et une estimation fausse coûte plus
cher qu'une absence d'estimation. Le coût attendu par étape, lui, s'affiche comme
un ordre de grandeur mesuré (« proxy, environ 6 min sur 1 h 40 d'émission »).

**Actions destructrices**

- **Écarter** : réversible d'un clic, le même bouton reprend sa décision.
  Aucune confirmation, et c'est une exigence explicite du plan.
- **Relancer le repérage** (`force`) : détruit les propositions non traitées et
  garde tout ce qui est humain (`mergeCandidates`). Confirmation par boîte de
  dialogue, dont le texte énonce exactement le partage : « vos 4 clips gardés
  sont conservés, les 19 propositions en attente sont remplacées ». Une
  confirmation qui ne dit pas ce qui va disparaître ne fait que retarder le clic.

**Pas d'impasse** : l'état `interrompu` est le seul qui n'ait aujourd'hui aucune
issue, et le bouton de reprise est l'ajout qui le ferme. Il appelle
`POST /run` avec `{ target: 'candidates' }`, ou `'proxy'` si le proxy seul manque,
la cible se déduisant de `steps`.

**Clavier** : voir la section 4. C'est l'écran qui en dépend le plus.

### 3.3 Clip (`/clips/:id`)

**Objectif unique** : rendre un candidat publiable. Quatre gestes en dessous
(délimiter, retirer, cadrer, exporter), un seul but.

| | |
|---|---|
| **Repérage** | fil d'Ariane `avolo·shorts / <émission> / <titre du clip>`, et le rang dans les gardés : « clip 2 sur 4 gardés ». C'est ce rang qui dit qu'on est dans une boucle et pas au bout du monde. |
| **Navigation** | retour au tri par le fil d'Ariane. « Clip suivant à monter » et « précédent », calculés sur la liste des gardés déjà en cache. Aucun chargement supplémentaire. |
| **Persistance aller** | rien. Le clip vient de l'API, le montage en cours vient du store. |
| **Persistance retour** | l'enregistrement différé écrit avant de quitter (`pagehide` et démontage, `keepalive: true`). Ce qui **ne** survit pas est la pile d'annulation, remise à zéro au changement de clip par la garde de `charger`. C'est acceptable et il faut le dire : `Ctrl+Z` défait le montage de cette séance, pas celui d'hier. |
| **Validation** | le titre et la description sont libres, et rien ne s'y valide pendant la frappe. Une seule règle, dite au moment de l'export : un titre vide n'empêche pas le rendu mais produit un `.txt` dont la première ligne est vide, donc rien à coller au moment de publier. L'avertissement se pose sur le bouton d'export, pas sur le champ. |

**Trois changements de fond**, par ordre de valeur.

**1. L'aperçu montre la sortie, pas la source.** Deux images côte à côte :

- à gauche, la source 16:9 avec le rectangle déplaçable et les bandes assombries.
  C'est l'outil de **position** : on cadre en regardant ce qu'on laisse dehors, et
  le composant actuel le fait bien ;
- à droite, le **canevas de sortie** au ratio choisi, à l'échelle où il sera vu.
  C'est l'outil de **décision** : c'est là qu'un 16:9 se voit occuper le tiers de
  la hauteur et un 4:5 les sept dixièmes.

Sans la seconde image, le sélecteur de ratio demande d'arbitrer à l'aveugle
l'unique mesure qui fonde le projet.

Un seul `<video>` décode, et le canevas de sortie se peint à partir de lui par
`drawImage` sur `requestVideoFrameCallback`. Deux éléments `<video>` sur la même
source seraient plus courts à écrire et décoderaient deux fois le même flux, sur
un proxy que la page lit déjà en requêtes partielles.

**2. Le transcript devient l'organe de navigation temporelle.** Cliquer un mot
place la lecture dessus ; la lecture surligne le mot en cours et fait défiler le
transcript s'il est sorti du champ. Ce n'est pas une timeline déguisée, c'est
l'inverse : plus rien ne réclame de tête de lecture, puisque la position se lit
dans le texte. Le défilement automatique se coupe dès que l'utilisateur fait
défiler à la main, et se reprend au clic sur un mot.

**3. `Ctrl+Shift+Z` rétablit.** `history.ts` gagne une pile `future`, vidée à
chaque nouveau geste. Sans cela, annuler est un pari.

**Un `PATCH` refusé pour jeton périmé n'est pas un échec.** Le serveur ajoute un
jeton de séquence que `ClipPatch` transporte et qu'il refuse s'il n'est plus le
dernier. Ce refus veut dire « une écriture plus récente a gagné », ce qui est
exactement le résultat voulu. L'afficher comme une erreur ferait clignoter
« échec de l'enregistrement » au moment précis où tout s'est bien passé, et
`useEnregistrementAuto` bloquerait la suite en attendant un nouveau geste. Le
refus se traite donc comme un succès dont on jette la réponse : l'état reste
« enregistré », rien n'est réécrit et la version du serveur fait foi. Seuls les
autres codes remontent à l'écran.

`usePatchClip` tient déjà un jeton par clip pour son cache optimiste, avec la
bonne justification (« une réponse tardive du premier écraserait de même celle du
second »). Le jeton du serveur répond à la même question un étage plus bas, et les
deux doivent rester distincts : celui du client ordonne les réponses, celui du
serveur ordonne les écritures.

**Le cadrage change de nature en itération 1**, et c'est traité en 3.5.

**Les cinq états**

| État | Ce qui s'affiche |
|---|---|
| Chargement | squelettes déjà en place, à conserver. |
| Vide | un clip dont tous les mots ont été retirés : durée nulle, transcript entièrement barré, export désactivé avec sa raison. Le cas est prévu côté serveur (`étendueOrigine` retombe sur `candidates.json`) et n'a pas de rendu propre aujourd'hui. |
| Erreur | trois surfaces, séparées. L'enregistrement a échoué : l'état à trois valeurs existe déjà, il lui manque un bouton « réessayer » plutôt que l'attente d'un nouveau geste. Le clip est introuvable : page dédiée avec retour à la bibliothèque. L'export a échoué : message dans le panneau d'export, avec le code renvoyé. **Le refus d'un `PATCH` périmé n'est aucune des trois** : voir plus bas. |
| Désactivé | l'export tant qu'un enregistrement est en attente ou en échec, parce que rendre un état non enregistré produirait un fichier qui ne correspond à rien de persistant. Le curseur de cadrage en 16:9, déjà géré. Le bouton « clip suivant » sur le dernier. |
| Succès | l'export produit un ou deux fichiers et le panneau les montre : lecture sur place, taille et texte à copier. C'est le seul succès du parcours qui mérite d'être vu. |

**Actions destructrices**

- **Retirer un passage** : annulable, pas de confirmation.
- **Ré-exporter** un clip déjà rendu (`force: true`) : écrase un fichier livré.
  Confirmation, avec le nom des fichiers concernés. Sans `force`, le serveur
  répond `skipped: true` et l'interface doit le dire plutôt que de faire croire à
  un nouveau rendu.
- **Quitter avec une modification en attente** : aucune confirmation, et c'est
  volontaire. Le vidage sur `pagehide` avec `keepalive: true` fait le travail. Un
  `beforeunload` afficherait une boîte du navigateur pour un risque qui n'existe
  plus, sur l'écran qu'on quitte le plus souvent.

**Pas d'impasse** : toute erreur porte son geste de reprise, et le fil d'Ariane
reste atteignable dans tous les états, y compris « clip introuvable ».

### 3.4 L'export : un panneau, pas un écran

L'export ne mérite pas d'écran. Il consomme le clip qu'on vient de monter, il
dure de dix secondes à une minute (mesuré : 10 s pour un clip à trois segments),
et son résultat se juge à côté de ce qui l'a produit. Un écran séparé ferait
sortir du sous-parcours pour y revenir aussitôt.

Le panneau vit au bas de la colonne de gauche de l'écran de clip et porte quatre
choses.

**Avant** : le ratio résolu, les fichiers qui seront produits et le bouton. Deux
fichiers quand le ratio n'est pas 9:16 (le natif pour le feed, la variante
floutée pour TikTok et Shorts), un seul sinon. **C'est la seule conséquence du
choix de ratio qui ne se voit nulle part aujourd'hui**, alors qu'elle change ce
qu'on aura à publier.

**Pendant** : la requête est synchrone et dure de dix secondes à une minute. Un
bouton muet pendant ce temps passe pour cassé, `ROADMAP.md` le dit déjà. Le bouton
devient un indicateur de travail, et il n'est pas annulable : le rendu ffmpeg ne
s'interrompt pas proprement en itération 0, et un bouton d'annulation qui ne
ferait qu'ignorer la réponse mentirait sur ce qui se passe.

**Après** : la liste des fichiers, chacun lisible sur place. La variante 9:16
absente n'est pas une anomalie quand le ratio est déjà 9:16, et l'interface doit
le dire ainsi plutôt que de montrer une case vide.

**Les textes** : titre, description et hashtags, dans une zone qui se copie d'un
bouton. Le fichier `.txt` existe sur le disque et Julien publie avec ses propres
outils : ce qu'il lui faut ici est le presse-papiers, pas un chemin.

**Un défaut connu à signaler dans le panneau.** L'anomalie #22 laisse les
sous-titres lisibles dans le fond flouté de la variante 9:16, jaune du mot actif
compris. Tant qu'elle n'est pas corrigée, le panneau le dit sur la variante
concernée. Livrer un
fichier dont on connaît le défaut sans le dire est ce qui fait perdre confiance
dans les autres.

### 3.5 Le cadrage quand l'automatique arrive

L'itération 1 change le sens du sélecteur de cadrage, et c'est le changement le
plus structurant qui attende cet écran. Trois faits, arrêtés côté serveur :

- `cropX` passe de `number` à `number | null`. `null` vaut « automatique », un
  nombre vaut « dérogation humaine, sur tout le clip, gagnante » ;
- **la position du crop devient fixe par plan, donc variable d'un plan à l'autre
  dans un même clip** (spec §10) ;
- **le ratio se recalcule depuis l'EDL, il n'est pas stocké.** Retirer le passage
  où un comédien traverse le plateau peut faire retomber un 16:9 en 1:1.

#### La règle : `ratio` et `cropX` se traitent pareil

Ce sont deux réglages voisins, tous deux à trois états (automatique, dérogé,
retour à l'automatique). Deux mécaniques différentes seraient une dette
d'interface payée à chaque ouverture d'un clip. Trois obligations, les mêmes pour
les deux :

1. **Montrer ce que l'automatique a décidé, même quand on n'y touche pas.** Le
   sélecteur de ratio affiche `auto → 4:5`, pas `auto`. Le rectangle de cadrage se
   dessine à la position calculée.
2. **Un geste pour déroger, et c'est le geste naturel.** Cliquer une pastille de
   ratio, saisir le rectangle. Aucun interrupteur préalable à basculer.
3. **Un geste pour revenir**, visible au même endroit. La pastille `auto` du
   sélecteur de ratio le fait déjà, et c'est le bon modèle ; le rectangle n'a
   aucun équivalent aujourd'hui et lui en doit un.

#### En automatique, le rectangle bouge, et c'est ce qui rend la falaise visible

C'est la conséquence d'interface de « le crop est fixe à l'intérieur d'un plan ».
En automatique, la position du cadre n'est pas un nombre, c'est une fonction du
temps : le rectangle saute aux frontières de plans pendant la lecture. Le voir
sauter apprend en trois secondes ce qu'aucune phrase d'aide n'explique.

Et le jour où l'on saisit le rectangle, **il s'arrête de sauter**. La dérogation
n'a donc pas besoin d'être annoncée par un avertissement : elle se voit. C'est le
seul endroit de ce document où un comportement remplace un texte, et c'est
possible parce que la chose à comprendre est un mouvement.

#### Les frontières de plans se lisent dans le transcript

L'itération 0 avait écarté la bande des plans faute de plans. La question se
rouvre, et l'argument est bon : c'est aux frontières que le crop saute, et c'est
là que les coupes se posent de préférence.

**Je propose de ne pas la mettre sous le lecteur, mais dans le transcript.** Une
frontière de plan est un filet horizontal en travers du texte, à l'instant où elle
tombe, dans la gouttière qui porte déjà les positions. Trois raisons :

- la surface d'édition reste unique. Une bande sous le lecteur rouvre un axe
  temporel horizontal, c'est-à-dire la première moitié d'une timeline ;
- la frontière apparaît **là où l'on décide**. Quelqu'un qui retire une phrase
  voit du même regard qu'une frontière est à deux mots, donc que sa coupe peut s'y
  poser ;
- un filet dans un texte est un saut de paragraphe, une forme que tout le monde
  lit sans apprentissage.

La bande sous le lecteur reste le repli si les filets s'avèrent illisibles à
l'usage. Elle serait en lecture seule dans les deux cas, comme la spec §13 le
prévoit.

#### Réserve 1 : la dérogation n'a pas la granularité de l'automatique

L'automatique donne un crop **par plan**, la dérogation est un nombre **pour tout
le clip**. Saisir le rectangle une seule fois efface donc le cadrage de tous les
plans, y compris ceux qui étaient bons. C'est une falaise, pas un réglage, et la
formule qui la décrit le mieux est : l'outil de dernier recours détruit d'abord
tout ce qui marchait.

**Ce qui décide, et personne ne l'a mesuré : combien de plans dans un clip.** Le
corpus mesuré a des plans continus de plusieurs minutes (spec §2, « les comédiens
jouent debout, face à face, de profil, dans un plan continu de plusieurs
minutes »), et les candidats font de 37 à 167 secondes. Si la plupart des clips
tiennent dans un seul plan, la falaise n'existe pas et le nombre unique suffit.
Si un tiers d'entre eux traversent trois plans ou plus, le nombre unique est un
outil de démolition.

Le compte est bon marché une fois `analysis.json` produit : compter les frontières
qui tombent dans l'étendue de chaque candidat. **Cette mesure est à faire avant
d'écrire la moindre ligne du sélecteur d'itération 1.**

Ce que je recommande en attendant, et l'arbitrage est à Julien :

- **l'interface d'itération 1 ne propose qu'une dérogation globale**, parce qu'une
  dérogation par plan demande de désigner un plan, donc une surface de désignation
  que rien ne justifie tant que la mesure n'est pas faite ;
- **la forme persistée, elle, mérite d'être choisie une fois.** Une liste de
  `{ start, end, cropX }` couvre les deux cas (la dérogation globale est l'entrée
  unique qui couvre tout le clip), s'ancre dans le temps de la source comme tout le
  reste du produit, et **survit à une redétection des plans** là où une clé de plan
  ne survivrait pas : `shots.json` vit dans le projet précisément parce que son
  seuil se réglera. Le prix de ne pas le faire est une migration des clips
  enregistrés, ce qui, sur une bibliothèque d'un seul utilisateur, est un script.
  Je signale le choix, je ne le force pas.

Un mot sur `CLAUDE.md`, qui interdit d'anticiper une itération au prétexte que
« c'est presque le même code ». La règle vise le code. Ici il s'agit d'un champ
**persisté**, et le coût de se tromper ne se paie pas à l'écriture mais à la
migration. C'est la seule raison pour laquelle je pose la question maintenant
plutôt qu'en itération 1.

#### Réserve 2 : un montage ne doit pas changer un format en silence

Le ratio se recalcule depuis l'EDL. Retirer une digression peut donc faire passer
un clip de 16:9 à 1:1, c'est-à-dire du tiers de la hauteur d'écran aux
cinquante-six centièmes. C'est une bonne nouvelle, et elle ne doit pas arriver par
surprise.

**Épingler est déjà possible et il faut le rendre lisible.** `ratio` porte
`'auto' | <ratio>` : choisir 4:5 est déjà une dérogation, et le sélecteur la
propose déjà. Ce qui manque est le reste de la symétrie de la règle ci-dessus :
l'affichage de la valeur calculée sous `auto`, et l'annonce du changement.

Concrètement, quand une modification du montage change le ratio résolu, la
pastille `auto` le dit à cet instant : « auto → 1:1, c'était 16:9 ». Une ligne, à
côté du sélecteur, pas une notification. Julien épingle s'il n'est pas d'accord, et
le geste pour épingler est celui qu'il connaît déjà.

Ma position sur la question posée : **non, il ne faut pas épingler par défaut.**
Le recalcul est ce qui produit le bénéfice mesuré à la section 2 de la conception,
et un format épinglé d'office le gèlerait sur l'état du clip au moment où il a été
ouvert, c'est-à-dire avant montage, c'est-à-dire au pire moment. Ce qu'il faut
n'est pas moins de recalcul, c'est moins de silence.

## 4. Le clavier et l'accessibilité

Un seul utilisateur, sur sa machine, ne dispense de rien : le clavier est ici une
question de vitesse avant d'être une question d'accès, et les deux se traitent
avec les mêmes moyens. Trente décisions à la souris coûtent trois fois le prix des
mêmes au clavier.

### 4.1 Les raccourcis

| Écran | Touche | Effet |
|---|---|---|
| Tri | `J` / `K` ou flèches | carte suivante, précédente |
| Tri | `G` | garder, et avancer d'une carte |
| Tri | `E` | écarter, et avancer d'une carte |
| Tri | `Entrée` | ouvrir le clip |
| Tri | `U` | défaire la dernière décision |
| Clip | `Espace` | lecture, pause |
| Clip | `Ctrl+Z` / `Ctrl+Shift+Z` | annuler, rétablir |
| Clip | `Suppr` | retirer la sélection |
| Clip | `Échap` | vider la sélection |
| Clip | `[` / `]` | poser la borne de début, de fin, sur le mot sous le curseur |
| Clip | `/` | chercher dans le transcript |
| Partout | `?` | la liste des raccourcis |

Trois règles derrière ce tableau.

**`G` et `E` avancent.** Une boucle se parcourt : décider sans avancer oblige à un
geste sur deux. `U` revient sur la décision précédente **et sur sa carte**, sinon
on corrige à l'aveugle.

**Aucun raccourci ne vole une frappe à un champ de saisie.** La garde existe déjà
dans `useRaccourcis`, avec le contrôle `instanceof HTMLElement` sans lequel aucun
raccourci ne fonctionnait. Elle doit suivre partout où des raccourcis se posent,
et l'écran de clip va gagner deux champs de texte.

**`?` existe parce que le reste existe.** Douze raccourcis qui ne se découvrent
que dans un `title` HTML sont douze raccourcis que personne n'utilise. Aujourd'hui
`Ctrl+Z` n'est annoncé que par l'attribut `title` du bouton « Annuler ».

### 4.2 L'ordre de tabulation, et le cas du transcript

Chaque mot du transcript est aujourd'hui un arrêt de tabulation (`tabIndex={0}` sur
chaque `<span role="button">`). La justification est bonne : un mot **est** la
commande, et le rendre inatteignable au clavier retirerait les trois gestes du
produit. Mais la conséquence l'est moins : traverser le transcript pour atteindre
la barre d'outils demande une centaine de `Tab`, et le nombre dépend de ce que le
virtualiseur a rendu, donc de la position de défilement.

**Le `tabindex` glissant règle les deux.** La surface est un seul arrêt de
tabulation ; à l'intérieur, les flèches déplacent le mot actif et `Tab` sort. Le
mot actif porte `tabIndex={0}`, tous les autres `tabIndex={-1}`. C'est le motif
standard des grilles et des listes, il ne retire aucun geste, et il rend la
surface franchissable.

Deux détails que le virtualiseur impose : le mot actif peut sortir du champ rendu,
donc son index se garde dans l'état et non dans le DOM ; et le déplacement doit
appeler `scrollToIndex` pour ramener le mot actif, sinon la flèche paraît sans
effet.

### 4.3 Ce qui se dit à voix haute

**La progression ne s'annonce pas en continu.** L'écran de tri interroge l'état
toutes les deux secondes : une région live sur le pourcentage produirait une
annonce toutes les deux secondes pendant neuf minutes. Le `role="progressbar"`
met à jour `aria-valuenow` en silence, et une région `aria-live="polite"`
distincte n'annonce que **les changements d'étape** et la fin. Quatre annonces sur
toute l'analyse.

**Trois régions live, et pas une de plus** : l'avancement (changements d'étape),
les erreurs (`role="alert"`, donc `assertive`) et le résultat d'un export. Le
bandeau d'échec d'analyse porte déjà `role="alert"`, ajouté en revue, et pour la
bonne raison : il apparaît après coup, à l'issue d'une attente de plusieurs
minutes.

**Une décision de tri ne s'annonce pas par une région live.** Trente annonces en
trois minutes noieraient les trois qui comptent. L'état de la carte est porté par
le bouton (`aria-pressed`), et un lecteur d'écran le lit au moment du geste.

### 4.4 Le focus

- **Au retour d'un clip vers le tri, le focus revient sur la carte d'où l'on est
  parti.** Sans cela, le clavier repart du haut de la page à chaque aller-retour,
  soit quatre fois par émission.
- **Une boîte de dialogue piège le focus et le rend à son déclencheur.** Base UI
  le fait ; c'est une raison supplémentaire de prendre la primitive plutôt que
  d'écrire la boîte à la main.
- **Un contrôle désactivé pour une raison qui compte reste atteignable.**
  `disabled` sort du parcours de tabulation : un utilisateur au clavier ne
  découvre jamais le bouton, donc jamais sa raison. Pour « monter » sans proxy et
  « exporter » avec un enregistrement en attente, `aria-disabled="true"` plus un
  gestionnaire inerte, et la raison écrite à côté. Pour les cas sans intérêt
  (« clip précédent » sur le premier), `disabled` suffit.

### 4.5 Lisibilité

L'interface descend aujourd'hui à `0.65rem`, soit environ 10 px, sur des
informations qui ne sont pas décoratives : l'état d'enregistrement, l'étiquette de
statut, la position dans la source. Sur une séance de deux heures, c'est une
fatigue gratuite.

**Plancher à `0.75rem` pour tout ce qui porte une information**, et le gris
`text-muted-foreground` réservé à ce qui est vraiment secondaire. Les nombres qui
bougent restent en chiffres tabulaires, ce que le code fait déjà partout.

## 5. L'architecture de l'interface

### 5.1 Trois étages d'état, et la règle qui les sépare

| Étage | Qui le porte | Ce qu'il contient |
|---|---|---|
| Serveur | TanStack Query | tout ce qui est persisté : projets, état, candidats, clip, sources, rendus |
| Éphémère | Zustand, `src/store/editor.ts` | le montage en cours, la sélection, le cadrage, la pile d'annulation |
| Dérivé | fonctions pures de `src/core/` | la phase du projet, la durée, le rectangle de cadrage, le clip suivant |

**La règle : une donnée persistée n'est jamais recopiée dans le store.** Le
commentaire d'en-tête du store la formule déjà (« deux copies d'une même donnée
divergent toujours, et c'est celle qu'on regarde qui se trompe ») et le code la
respecte. Ce qui manque est l'étage dérivé : il n'existe pas, donc chaque écran
recalcule sa part de vérité dans son propre corps de composant.

Deux corollaires opérationnels.

**Rien de dérivable ne se met dans un `useState`.** L'état d'enregistrement de
l'écran de clip est déjà écrit ainsi, avec la bonne justification : « il reste
quelque chose à écrire » est exactement « la comparaison n'est pas vide ». La
même discipline vaut pour la phase, le compte des candidats et le clip suivant.

**Le store reste par clip et se vide au changement.** La garde de `charger` est
correcte. Il faut seulement le dire à l'utilisateur, puisque cela signifie que
`Ctrl+Z` ne traverse pas les clips.

### 5.2 La navigation, décrite une fois

Aujourd'hui chaque page construit son fil d'Ariane à la main, sous forme d'un
tableau positionnel passé à `AppBar`. Le modèle de navigation est donc recopié
trois fois, et une quatrième page le recopiera.

Un module `src/lib/parcours.ts` porte les trois fonctions que toute l'interface
consulte :

```ts
chemin(lieu)          // le fil d'Ariane, depuis le lieu et ses données
suite(phase, projet)  // l'action qui fait avancer : sa cible, son intitulé
                      // `phase` est le couple { analyse, travail } de 2.3
clipSuivant(clips, courant)  // le prochain gardé à monter, ou null
```

`suite` est le morceau qui compte : c'est lui qui garantit qu'aucun état n'est une
impasse, et le fait qu'il soit **une fonction unique** rend cette garantie
testable. Un test qui énumère les vingt-quatre couples de phases et vérifie
qu'aucun ne rend `null`
vaut mieux qu'une relecture des trois écrans.

### 5.3 Ajouter ou retirer une étape

L'itération 1 ajoute `shots` et `people` au graphe, l'itération 2 ajoute quatre
pourvoyeurs de candidats. Pour que ce soit une ligne et non une refonte :

- **les étapes sont une liste de données**, avec libellé, ordre et coût attendu,
  posée à côté de `phaseProjet` dans `src/core/`. Aujourd'hui `LIBELLES_ETAPES`
  vit dans un fichier de page ;
- **le panneau d'avancement itère cette liste**, il ne connaît aucun nom d'étape ;
- **`phaseProjet` ne cite aucune étape par son nom** sauf celles qui changent ce
  que l'utilisateur peut faire : le transcript ouvre le tri, le proxy ouvre le
  montage. Les autres ne sont que du temps qui passe.

Retirer une étape suit le même chemin. Le test qui protège : donner à
`phaseProjet` un relevé de présence portant une étape inconnue et vérifier qu'elle
ne change pas la phase.

### 5.4 Sortir la logique métier des composants

Ce qui doit déménager, dans l'ordre du gain :

| Aujourd'hui | Où | Pourquoi |
|---|---|---|
| `differences` et `useEnregistrementAuto` (130 lignes) | `src/app/clips/[id]/page.tsx` | le protocole d'enregistrement, le code le plus subtil de l'interface, testable seulement en montant une page. Vers `src/lib/enregistrement.ts` |
| `compter` | `src/app/projects/[id]/page.tsx` | trois comptes et une somme de durées, la matière du fil de tri. Vers `src/core/parcours.ts` |
| `LIBELLES_ETAPES` | même fichier | voir 5.3 |
| le calcul de `ligneInitiale` | `src/app/clips/[id]/page.tsx` | « la première phrase du clip enregistré » est une règle de produit, pas une mise en page. Vers `src/lib/editing.ts`, où vivent déjà ses voisines |

Ce qui reste dans un composant après ce déménagement : de la disposition, des
gestionnaires d'événement d'une ligne, et des appels aux hooks. C'est la même
frontière que `src/core` contre `src/server`, appliquée un cran plus haut, et elle
se vérifie de la même façon, à la lecture d'un fichier de page qui ne calcule
plus rien.

### 5.5 Tester une étape seule

Vingt-neuf fichiers de test, **zéro sur un composant**. `vitest.config.mts` prévoit
déjà les `.test.tsx` (« un test absent se voit, une suite qui n'exécute pas un
fichier annonce une couverture qu'elle n'a pas »), mais l'environnement est `node`.

Le minimum utile, par ordre de valeur :

1. **`phaseProjet` et `suite`, en tests purs, sans DOM.** Les vingt-quatre
   couples de phases, et l'invariant « aucun couple sans action ». C'est le test
   qui remplace la relecture des écrans.
2. **`enregistrement.ts`**, une fois sorti de la page : les trois défauts trouvés
   en revue (quitter dans les 600 ms, la boucle d'échec, le « enregistré » qui
   ment) sont des tests, pas des commentaires.
3. **La boucle de tri, en test de composant** : `G` avance, `U` revient sur la
   carte précédente, une carte décidée ne bouge pas. Ce sont les trois
   comportements dont une régression serait silencieuse.

Pour le troisième, l'environnement `jsdom` se pose par fichier
(`// @vitest-environment jsdom`) plutôt que globalement : les vingt-neuf tests
purs n'ont aucune raison de payer un DOM, et le démarrage en CI compte. Le prix
est trois dépendances de développement (`jsdom`, `@testing-library/react`,
`@testing-library/user-event`) et il ne se paie que pour le troisième point.
Les deux premiers, qui sont les plus rentables, ne coûtent rien de plus que ce
qui est déjà installé.

### 5.6 L'arborescence proposée

```
src/core/
  parcours.ts         phaseProjet, la liste des étapes, les comptes de tri   (pur)
src/lib/
  parcours.ts         chemin, suite, clipSuivant                             (client)
  enregistrement.ts   le protocole d'écriture différée
src/components/
  parcours/           app-bar, fil d'Ariane, indicateur d'exécution
  sources/            source-card, grille, ligne de montage
  tri/                candidate-card, grille, panneau d'avancement
  clip/               transcript-surface, clip-player, crop-picker, apercu-sortie,
                      panneau-export, champs de textes
  ui/                 les primitives shadcn
```

Un dossier par étape du parcours, plus `parcours/` pour ce qui les traverse. Le
critère qui décide où va un composant : **si le retirer casse une seule étape, il
appartient à cette étape**. `app-bar` en casse trois, donc il est dans `parcours/`.

## 6. Les primitives à ajouter, et celles à refuser

Sept primitives aujourd'hui : `badge`, `button`, `card`, `separator`, `skeleton`,
`toggle`, `toggle-group`. Aucun champ de saisie, aucune boîte de dialogue, aucune
barre de progression, aucune alerte. Les quatre ont donc été réécrites à la main
dans des fichiers de page, ARIA comprise. C'est exactement ce que la spec §13
voulait éviter en prenant shadcn : « les composants deviennent du code du projet ».

À vérifier au moment de l'ajout que le registre `base-nova` les fournit : la spec
note déjà que la version de shadcn posée sur Base UI plutôt que Radix est à
contrôler à l'installation.

### 6.1 À ajouter

| Primitive | Ce qu'elle sert | Pourquoi elle vaut son poids |
|---|---|---|
| `dialog` | confirmer un repérage forcé, confirmer un ré-export, afficher la liste des raccourcis | trois usages, et surtout le piège de focus, la fermeture par `Échap` et le retour du focus au déclencheur. Réécrire ça à la main est la façon la plus sûre de le rater |
| `progress` | l'avancement, dans la bibliothèque et dans le panneau du projet | le `role="progressbar"` est aujourd'hui écrit à la main dans un fichier de page, avec ses quatre attributs ARIA. Il va servir à deux endroits, donc il sort |
| `alert` | quatre surfaces d'erreur : analyse échouée, liste non chargée, enregistrement en échec, export en échec | le bandeau actuel est écrit à la main, et son `role="alert"` a été ajouté en revue. Quatre occurrences valent une primitive |
| `input`, `textarea`, `label` | le titre et la description du clip | il n'existe aucun champ de saisie dans le dépôt, alors que ces deux textes sont un livrable du produit |
| `tabs` | les trois vues du tri : à trier, gardés, écartés | remplace un bouton fantôme qui bascule un booléen, donne la navigation aux flèches et rend exprimable la règle de 2.5 : les écartés ne disparaissent qu'au changement de vue |
| `tooltip` | l'information d'appoint : le raccourci d'un bouton, la définition d'un terme | **jamais pour porter la raison d'un contrôle désactivé** : une bulle qui n'apparaît qu'au survol est invisible au clavier, et la raison d'un blocage doit être lue avant d'essayer |

### 6.2 À refuser, et pourquoi

- **`scroll-area`** : le virtualiseur a besoin d'un élément de défilement réel dont
  il mesure la hauteur. Une zone de défilement stylée interposerait son propre
  conteneur, et le `scrollToIndex` du positionnement initial retomberait à côté.
- **`slider`** : le curseur de cadrage n'est pas un curseur générique. Sa plage
  dépend du ratio (le centre d'un 9:16 ne va que de 15,8 à 84,2 %), il garde
  l'écart entre le point saisi et le centre pour ne pas sauter au premier appui,
  et il se fige à 16:9. Une primitive générique perdrait les trois.
- **`table`** : déjà écarté par la spec, vingt-cinq cartes ne sont pas un tableau
  de données.
- **`toast` ou `sonner`** : rien à notifier tant qu'on ne regarde qu'un projet à
  la fois. Ce qui l'appellerait : une analyse qui finit pendant qu'on trie un
  autre projet. Tant que la bibliothèque montre les états, l'information est déjà
  quelque part, et une notification qui disparaît est une mauvaise surface
  d'erreur.
- **`command`** : une palette de commandes sur trois écrans est un gadget. Les
  douze raccourcis de la section 4 couvrent le besoin.

## 7. Deux points ouverts du `ROADMAP.md`

Le `ROADMAP.md` laisse « deux points sans ticket, à trancher devant l'écran ». Ce
document en propose la réponse, parce que dans les deux cas c'est l'interface qui
décide.

### 7.1 Le mot barré cliqué loin devant

« Cliquer un mot barré loin devant le clip crée un segment isolé de quelques
dixièmes à cet endroit. C'est ce que le plan demandait, `Ctrl+Z` le défait, mais
c'est un piège possible. »

C'en est un, et la raison est que le même geste répond à deux intentions
différentes selon l'endroit. **Un mot barré à l'intérieur de l'étendue du clip est
un trou** : le remonter comble ce trou, ce qui est exactement ce qu'on voulait.
**Un mot barré à l'extérieur est une borne** : le remonter veut dire « le clip
commence là », pas « ajoute une île de trois dixièmes de seconde à quarante
secondes d'ici ».

La réponse tient dans les fonctions qui existent déjà : à l'intérieur de
l'étendue, `restoreWord` ; à l'extérieur, `moveBoundaryToWord` avec le bord le
plus proche. Aucune mécanique nouvelle, une comparaison de deux nombres suffit,
et le geste devient prévisible dans les deux cas.

### 7.2 Le filtre de sécurité de Gemini, et ce que l'écran en dit

Quatre lots de notation sur onze reviennent `PROHIBITED_CONTENT` sur
`2025-06-15-cqlp`, de façon reproductible. Un tiers du matériau est écarté sans
être jugé, **en silence**.

La cause se traite ailleurs et se traitera plus tard. Mais le silence, lui, est
une décision d'interface, et c'est la mauvaise. Julien trie vingt-cinq cartes en
croyant regarder ce que l'émission a de mieux, alors qu'il regarde ce que
l'émission a de mieux **dans les deux tiers qui ont été notés**. Sans le mot, il
attribuera au repérage une qualité qui n'est pas la sienne, et il n'aura aucune
raison d'aller chercher dans le tiers manquant.

Le décompte remonte dans `status.json` : le champ existera. Trois exigences sur ce
qu'on en fait, et aucune n'est cosmétique.

**Ça se dit en couverture, pas en incident.** « 4 lots sur 11 ont été refusés par
le filtre de sécurité » est un message pour celui qui a écrit le code. « 27
propositions, tirées de 64 % de l'émission » est ce que Julien a besoin de savoir
pour décider s'il fait confiance à la liste. Le détail technique se replie sous
la phrase, pour qui veut le lire.

**Ça reste à l'écran.** Ni notification, ni bandeau qu'on referme : c'est une
propriété permanente de cette liste-là, au même titre que son nombre d'éléments,
et ça vit à côté du compte. Une information qui change la confiance qu'on accorde
à un écran ne peut pas s'afficher trois secondes.

**Ça porte une action.** « Relancer le repérage » est le seul recours disponible :
le découpage en lots n'est pas déterministe dans ce qu'il déclenche, donc une
seconde passe peut noter des fenêtres que la première a laissées de côté. Le
bouton existe déjà par ailleurs, pour la reprise ; ici il a une seconde raison
d'être, et l'écran doit la dire.

Je décris ce que l'écran en fait. La correction de la cause, elle, ne relève pas
de ce document.

## 8. Ordre de mise en œuvre

Sept lots, chacun livrable seul, dans cet ordre. Le critère est le nombre de
défauts que chacun ferme par rapport à son coût.

1. **La phase et la reprise.** `phaseProjet`, `suite`, le panneau d'avancement, le
   bouton qui appelle `runProject`. Ferme la seule impasse réelle de l'interface,
   et tous les lots suivants lisent la phase.
2. **Le tri comme boucle.** Clavier, pas de compactage sous la main, fin de boucle
   marquée, `tabs` pour les trois vues et la couverture du repérage. C'est
   l'écran que la spec demande de soigner en premier, et le seul dont le coût se
   paie trente fois par émission.
3. **Les textes et l'export.** Titre, description, panneau d'export sur
   `exportClip`, lecture des rendus. Ferme la sortie du tunnel, donc rend le
   parcours entier vérifiable pour la première fois.
4. **L'aperçu de sortie.** Le canevas au ratio choisi à côté de la source, et
   l'annonce des fichiers produits. C'est le lot qui rend visible la mesure qui
   fonde le projet.
5. **La bibliothèque.** Deux sections, `createProject` sur une carte de source,
   états d'analyse par projet, ligne de montage. Ferme l'entrée du tunnel.
6. **Le transcript comme organe de navigation.** Clic pour se placer, surlignage
   du mot en cours, `tabindex` glissant, rétablissement.
7. **Le cadrage automatique** (section 3.5), avec l'itération 1 et pas avant. La
   mesure du nombre de plans par clip se fait au début de ce lot, pas à la fin.

Les lots 3 et 5 dépendent chacun d'un travail serveur en cours dans l'autre
session. Les lots 1, 2, 4 et 6 ne dépendent de rien qui n'existe pas.

L'ordre a changé une fois, à la lecture de ce que livre la session serveur : les
trois lots qui ferment un parcours orphelin (1, 3 et 5) sont remontés devant ceux
qui améliorent un parcours qui marche. Une porte fermée coûte plus qu'un confort
absent.

## 9. Ce que ce document ne tranche pas

### 9.1 Le chiffre de l'attente

La demande à l'origine de ce document annonce « environ 35 minutes : 12 min de
proxy, 20 de transcription, mesuré ». La spec §6 donne le même ordre de grandeur
(15 à 25 min de transcription). Le `ROADMAP.md`, lui, rapporte une mesure faite le
18 août sur une émission entière : **1 min 41 de transcription**, soit quinze fois
moins, et 6 min de proxy sur 1 h 39.

J'ai conçu contre la mesure, pas contre l'estimation, et je le signale plutôt que
de le passer sous silence : la conclusion d'ergonomie ne change pas (on ne reste
pas devant un écran pendant neuf minutes non plus), mais l'ampleur des moyens, si.
À trente-cinq minutes, il faudrait une file d'attente, des notifications et un
suivi hors écran. À neuf minutes dont trois avant la première décision, un panneau
honnête suffit.

Si le chiffre de 35 minutes vient d'une mesure que je n'ai pas trouvée, la
section 2.4 est à refaire. Sinon, c'est la spec §6 qui mérite une note.

### 9.2 L'ordre des candidats et du proxy

`CIBLES_INITIALES = ['candidates', 'proxy']` est ce qui rend possible le régime
« triable » de 2.4, et je propose de le garder. Le prix est que la grille de tri
passe ses six premières minutes sans vignettes, sur l'écran que la spec demande de
soigner en premier.

Une autre voie existe et je ne la tranche pas, parce qu'elle est côté serveur :
extraire les vignettes des candidats **de la copie locale de l'original** plutôt
que du proxy, avec `-ss` avant `-i` comme le fait déjà la vignette d'une source.
La copie est locale, donc l'extraction ne traverse pas le 9p, et vingt-cinq
d'entre elles coûteraient probablement moins d'une minute. Ce « probablement »
est le seul chiffre non mesuré de ce document, et c'est ce qui empêche de
trancher : à vérifier avant de faire quoi que ce soit. Si le compte tient, cette
voie supprime le régime intermédiaire au lieu de le rendre supportable.

### 9.3 Deux documents qui gagneraient une ligne

Je n'y touche pas, et je les signale.

**`CLAUDE.md`** porte sept décisions « à ne pas défaire par réflexe ». Celle de ce
document est de la même famille, puisqu'elle contredit elle aussi l'approche
spontanée : *le parcours est un objet qui traverse des phases, pas un tunnel à
étapes*. Le réflexe qu'elle remplace est l'assistant à cinq écrans.

**La spec §13** décrit l'écran de tri et l'écran de clip, et ne dit rien de
l'export dans l'interface. Ce silence est exactement le trou que `ROADMAP.md`
décrit comme « une couture d'orchestration » : chaque agent a livré son périmètre
et personne ne possédait le raccord. Une ligne dans §13 disant que l'export est un
panneau de l'écran de clip aurait suffi à le faire exister.

### 9.4 Les deux arbitrages du cadrage automatique

Ils sont argumentés en 3.5 et ils reviennent ici parce qu'ils demandent une
décision de Julien avant que quiconque écrive le sélecteur d'itération 1.

**La granularité de la dérogation.** L'automatique cadre par plan, la dérogation
proposée porte sur tout le clip. Ma position : l'interface d'itération 1 s'en
tient à la dérogation globale, et **la mesure du nombre de plans par clip se fait
d'abord**, parce que c'est elle qui dit si la falaise existe. La forme persistée,
elle, mérite d'être choisie une fois : une liste de `{ start, end, cropX }` couvre
les deux granularités et survit à une redétection des plans. Ce qui me ferait
changer d'avis : une mesure montrant qu'un clip sur trois traverse trois plans ou
plus. La dérogation par plan deviendrait alors nécessaire tout de suite, avec la
surface de désignation qu'elle implique.

**L'épinglage du ratio.** Il est déjà possible et ma position est de ne pas
l'imposer par défaut : le recalcul depuis l'EDL est ce qui produit le bénéfice
mesuré, et l'épingler d'office le gèlerait sur l'état d'avant montage. Ce qu'il
faut n'est pas moins de recalcul, c'est moins de silence. Ce qui me ferait changer
d'avis : constater à l'usage qu'un format change plusieurs fois pendant le montage
d'un même clip. L'annonce deviendrait alors du bruit, et l'épinglage au premier
choix serait plus honnête.
