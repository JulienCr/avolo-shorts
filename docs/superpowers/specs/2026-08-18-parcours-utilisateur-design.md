# Parcours utilisateur : conception de l'interface

Date : 18 août 2026.
Statut : appliqué. **L'avancement se lit en section 8 et nulle part ailleurs**,
lot par lot : un état recopié en tête de document vieillit sans que personne ne
le relise, et celui-ci avait déjà vieilli d'une vague entière.

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
refusés par Gemini, et le cadrage automatique de l'itération 1. Il intègre la
première passe de relecture (Copilot, Codex, Aristarque) et l'arbitrage de Julien
sur le mode de cadrage, qui a fait réécrire la section 3.5.

## 1. L'état actuel

**Cette section décrit le code au commit `5412597`, et elle ne se met pas à
jour.** C'est le diagnostic qui a fait écrire le reste, pas un état des lieux. Ses
« aujourd'hui », comme ceux des sections 5 et 6, nomment ce qui manquait alors ;
les lire au présent ferait rouvrir des défauts refermés depuis. Ce qui vaut
maintenant se lit dans les sections qui décident, et l'avancement en section 8.

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
   parcours est le choix d'une source parmi 21 replays (spec §13). La tâche 15 du
   plan n'est pas faite : ni `src/app/api/sources/`, ni `source-card.tsx`. Les
   deux listes sont utiles et ce ne sont pas les mêmes : l'une est un point de
   départ, l'autre une bibliothèque de travail en cours.
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
/** Ce que la machine a produit. Des artefacts, jamais une activité. */
export type Analyse =
  | 'attente'      // les candidats manquent, une exécution tourne
  | 'interrompu'   // il manque une étape et rien ne tourne
  | 'echec'        // la dernière exécution a échoué
  | 'triable'      // candidats présents, proxy absent : on trie, on ne monte pas
  | 'complet'      // candidats et proxy présents

/**
 * Ce que l'humain a décidé. **Les quatre valeurs se testent dans cet ordre**, et
 * la première qui répond gagne : les conditions ne sont pas disjointes prises
 * séparément, l'ordre est ce qui les rend exclusives.
 */
export type Travail =
  | 'rien'         // la liste est vide
  | 'atrier'       // sinon, au moins une proposition reste indécise
  | 'livre'        // sinon, au moins un clip gardé, et tous ont un rendu à jour
  | 'trie'         // sinon : tout est décidé, il reste à monter ou à exporter

export function phaseProjet(
  steps: Record<StepName, boolean>,
  running: { step: StepName; progress: number } | null,
  erreur: string | null,
  clips: { status: ClipStatus }[],
): { analyse: Analyse; travail: Travail }
```

Cinq propriétés de ce modèle, et quatre viennent de la relecture.

**Il n'y a pas de valeur `neuf`.** Une version précédente en portait une, pour
« rien sur le disque et rien ne tourne encore ». Elle n'est pas observable :
`créerProjet` appelle `lancer` avant de répondre, et `lancer` pose sa réservation
dans `enCours` avant son premier `await`. Un projet que le client peut voir a donc
toujours quelque chose qui tourne, ou quelque chose sur le disque. La forme « aucun
artefact, aucune exécution » ne décrit pas un projet neuf : elle décrit une
exécution morte, et c'est `interrompu`. Deux valeurs que rien ne distingue sont
une invitation à en choisir une au hasard. (relevé par Copilot)

**L'axe `Analyse` décrit ce qui est disponible, pas ce qui s'agite.** Une première
version portait une valeur `encours`, et elle recouvrait `triable` : pendant les
six minutes d'encodage du proxy, une exécution tourne **et** les candidats sont
là. Une implémentation qui aurait donné la priorité à `encours` aurait affiché le
panneau d'attente sur un écran parfaitement triable, c'est-à-dire annulé le régime
2 de 2.4. « Quelque chose tourne » est déjà un champ de l'API (`running`) et se lit
à côté. `attente` et `interrompu` se distinguent d'ailleurs par lui seul : mêmes
artefacts manquants, une exécution dans un cas et rien dans l'autre. (relevé par
Copilot)

**La phase choisit ce que l'écran met en avant, elle ne retire jamais ce qui
existe.** C'est l'invariant, et il vaut mieux que les préconditions qui suivent :
trois relectures successives ont trouvé trois façons différentes de le violer
(`encours` recouvrant `triable`, puis `interrompu`, puis `{ attente, trie }` après
un repérage forcé), ce qui veut dire que le défaut n'est pas dans une valeur mais
dans la manière de s'en servir. Le panneau d'avancement remplace la grille
**seulement quand la grille serait vide**. Le reste du temps il se replie en
bande, et un échec s'affiche en bandeau.

Le troisième cas mérite d'être nommé parce qu'il est mesurable dans le code :
`effacerArtefact` (`src/server/steps/candidates.ts`) retire `candidates.json`
**avant** de toucher à la base, donc pendant un repérage forcé `steps.candidates`
vaut `false` alors que les clips gardés sont toujours en base et toujours
montables. `{ attente, trie }` est donc atteignable, et une implémentation qui
laisserait la phase commander l'affichage cacherait à Julien le travail qu'il
vient de faire. (relevé par Aristarque)

Les deux préconditions ci-dessous sont des conséquences de cet invariant, pas des
règles indépendantes.

**`interrompu` et `echec` ne s'appliquent que tant que `candidates` est absent.**
Sans cette précondition, ils recouvrent `triable` exactement comme `encours` le
faisait : une exécution interrompue pendant l'encodage du proxy cacherait la
grille de tri au moment précis où elle doit remplacer le panneau. Passé ce point,
un échec ne décrit plus ce que l'écran peut faire, il décrit un incident : il
s'affiche à côté, en bandeau, et la phase reste `triable` ou `complet`. La règle
générale est celle de l'axe entier : **une valeur d'`Analyse` dit ce qui est
disponible, jamais ce qui s'est passé.** (relevé par Aristarque)

**`triable` teste la présence de l'artefact, pas son contenu.** C'est le graphe de
l'itération 0, où « à jour » veut dire « le fichier est là ». Un `candidates.json`
qui ne contient rien donne donc `{ triable, rien }`, et c'est l'axe `Travail` qui
porte le vide. Cette séparation est la raison d'être des deux axes : sans elle, il
faudrait une valeur `triable-mais-vide` sur l'axe des artefacts. (relevé par
Aristarque)

**L'ordre des tests fait partie du contrat.** Écrites comme quatre prédicats
indépendants, les conditions se recouvrent : une liste vide satisfait aussi « plus
aucune proposition en attente », et `livre` mordrait sur `atrier` dès le premier
clip gardé rendu alors que d'autres propositions restent indécises. Selon l'ordre
choisi par l'implémenteur, l'écran annoncerait « tout est trié » sur un vide, ou
« livré » avant la fin du tri. Une cascade ordonnée coûte un commentaire et
supprime la question. (relevé par Copilot)

**`livre` exige au moins un clip gardé.** « Tous les clips gardés sont exportés »
est vrai d'une liste vide : après avoir tout écarté, la phase terminale annonçait
un livrable alors qu'aucun MP4 n'existe. (relevé par Copilot)

**`livre` se déduit du statut `exported`, et c'est vrai depuis le 18 août.**

Ce document affirmait le contraire, à raison au moment où il a été écrit : rouvrir
un clip exporté pour en retoucher le montage laissait son statut à `exported`
alors que le MP4 décrivait l'édition précédente, et il fallait donc demander au
serveur un champ de fraîcheur. Le raisonnement était juste, la demande aussi — et
la vague de l'export l'a satisfaite avant que ce document ne soit lu.

`écarterRenduPérimé` (`src/server/steps/render.ts`) fait sortir le clip
d'`exported` dès qu'un champ **que l'encodage consomme** change : segments,
ratio, cadrage, sous-titres, marque. Le titre et la description n'y sont pas, et
c'est délibéré — ils ne vont que dans le `.txt`, réécrit depuis l'état à jour, et
les compter ferait perdre son statut à un clip dont on a corrigé une faute de
frappe.

Et l'invariant ne tient pas à l'effacement des fichiers, qui peut échouer : il
tient à `sortiesDuClip` (`src/server/rendus.ts`), qui rend quatre `null` dès que
`status !== 'exported'`. Des fichiers présents sous un clip qui ne porte pas ce
statut décrivent autre chose que sa livraison, et les publier servirait la vidéo
d'avant sans que rien ne le signale.

**Donc pas de champ de fraîcheur à ajouter**, et ne pas en ajouter un en croyant
obéir à ce paragraphe : il ferait doublon avec un invariant déjà tenu, et deux
sources de vérité sur la même question finissent par diverger. (demande relevée
par Codex, satisfaite par la PR #28, constaté le 18 août)

Ces valeurs ne sont pas un décor. Chacune répond à une question qu'un écran pose
aujourd'hui à sa façon, avec ses propres `if` :

- `interrompu` **n'existe pas dans l'interface actuelle**, et c'est l'impasse
  décrite en 1.3. C'est la seule valeur qui appelle une action de réparation.
- `triable` sépare « on peut décider » de « on peut monter ». Voir 2.4.
- `trie` est l'événement de fin de boucle, aujourd'hui invisible.
- `livre` est le succès du parcours, aujourd'hui inexprimable.

Le couple compte autant que ses membres. `{ triable, trie }` est un état réel :
Julien a fini de trier avant que le proxy ne soit encodé. **Il n'a aucune action
qui fasse avancer le montage**, et c'est ce qui a fait apparaître le défaut de la
règle « aucune phase sans action » : forcer une action sur cet état-là revenait à
en inventer une. D'où la forme de `suite` :

```ts
type Suite =
  | { kind: 'action'; libelle: string; cible: string }
  | { kind: 'attente'; raison: string; debloquePar: StepName }
```

L'attente est un résultat de plein droit, avec sa raison et ce qui la lèvera. Sur
`{ triable, trie }` l'écran dit donc que le montage s'ouvrira quand le proxy sera
encodé, et propose la seule chose réellement disponible sans proxy : écrire les
titres et les descriptions des clips gardés. Ce n'est pas un lot de consolation,
c'est un livrable du produit (spec §3). (relevé par Aristarque)

Une conséquence de forme : **la liste des étapes et leurs libellés sont des
données, pas du code d'écran**. `LIBELLES_ETAPES` était un `Record` déclaré dans
la page de tri, et l'étape que l'itération 1 a ajoutée y manquait. L'écran
affichait alors un libellé vide pendant toute l'analyse d'un projet neuf. Le
tableau des étapes, avec pour chacune son libellé, son ordre attendu et son coût
mesuré, vit donc à côté de `phaseProjet`.

### 2.4 L'attente : trois régimes, pas un écran de chargement

**Le fait qui commande tout ici est un ordre d'exécution.** `CIBLES_INITIALES`
(`run.ts`) vise les candidats **et** le proxy, et `planPourCibles` déroule donc :
ingestion, audio, transcript, candidats, **puis** proxy, puis ce qui dépend du
proxy. La liste des cibles s'allonge, l'analyse d'image y étant entrée avec la
PR #31. La place des candidats devant le proxy, elle, ne bouge pas, et c'est
d'elle seule que dépend tout ce qui suit. Ne pas recopier la liste ici : elle vit
dans `run.ts`, et sa copie cliente `CIBLES_DE_REPRISE` (`src/lib/api.ts`) est
gardée par un test.

Chiffres mesurés le 18 août 2026 sur `2025-06-15-cqlp.mp4` (4,3 Go, 1 h 39),
consignés dans `ROADMAP.md`. **Ils contredisent la spec §6, qui annonce 15 à
25 min de transcription et 30 à 45 min d'analyse : voir 9.1, où l'arbitrage est
laissé à Julien.** Ce qui suit est bâti sur la mesure, et seuls les nombres en
dépendent. (relevé par Aristarque)

| | Coût | Cumul |
|---|---|---|
| Copie depuis le Drive | 45 s | 0:45 |
| Extraction audio | 6 s | 0:51 |
| Transcription WhisperX | 1 min 41 | 2:32 |
| Repérage Gemini | 30 s | **3:02, les candidats sont là** |
| Proxy 960x540 | 6 min | **9:02, le montage s'ouvre** |
| Analyse d'image | jamais chronométrée sur une émission entière | l'exécution continue |

Autrement dit : **un tiers de l'attente sépare le lancement de la première
décision possible, et les deux tiers restants ne bloquent que le montage.** Sur
l'émission la plus longue du corpus (2 h 50), les mêmes rapports donnent environ
5 minutes jusqu'aux candidats et 15 minutes jusqu'au montage. Ces proportions
mesurent l'attente d'un humain, pas la durée d'une exécution : l'analyse d'image
tourne encore quand le montage s'ouvre, et personne ne l'attend.

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
  attente du proxy », ce qui est exact ; il lui manque **ce qui la lèvera** :
  « les images arrivent avec le proxy, en cours d'encodage ». Une attente dont on
  connaît la cause est une attente supportable, et c'est **la cause qu'on nomme,
  jamais une durée restante** (voir plus bas) ;
- l'action « monter » d'une carte est **désactivée avec sa raison**, parce que
  l'écran de clip ne peut rien lire sans proxy. Le tri, lui, marche entièrement :
  titre, durée, trois premières phrases, garder ou écarter.

**Régime 3, complet.** Rien de particulier, et c'est le but. Une seule chose à ne
pas rater en l'écrivant : **l'exécution ne s'arrête pas quand le montage
s'ouvre.** L'analyse d'image dépend du proxy, donc elle passe après lui, et elle
alimente un cadrage automatique que l'écran ne montre pas encore. La bande
d'avancement reste donc dans la barre d'application après 9:02. Un écran qui la
rangerait à l'ouverture du montage annoncerait une fin qui n'a pas eu lieu, et
c'est le genre de mensonge qu'on ne remarque qu'une fois : la fois où l'analyse
échoue en silence.

**Une règle qui vaut partout : on affiche le coût d'une étape, jamais le temps
qu'il reste.** Le coût est une mesure (« le proxy coûte environ 6 min sur 1 h 40
d'émission ») ; le temps restant est une extrapolation à partir de deux points sur
une seule émission, et une estimation fausse coûte plus cher qu'une absence
d'estimation. Une première version de ce document annonçait « les images arrivent
dans six minutes » et « le montage s'ouvre dans trois minutes » tout en interdisant
le temps restant vingt lignes plus loin. La règle est la même sur les deux
surfaces. (relevé par Aristarque)

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
entre chaque clip, et elle se calcule côté client sur la liste des candidats du
projet, que la page de clip **interroge elle-même** plutôt que de la supposer en
cache (voir 3.3).

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
| **D'où viennent les états** | de la liste elle-même, enrichie de ce qui est gratuit à calculer. C'était une demande au serveur, et elle est satisfaite. Voir juste après. |
| **Validation** | aucune saisie, donc aucune validation. La seule erreur possible vient du serveur. |

**Ce que la bibliothèque a demandé au serveur, et ce qu'elle ne devait pas
demander.** Montrer plusieurs analyses à la fois suppose un état par projet, que
`GET /api/projects` ne portait pas (relevé par Copilot). Deux formes étaient
possibles, et elles ne se valaient pas :

- **une requête par projet** (`GET /api/projects/:id` pour chacun) : à écarter.
  Elle multiplie par vingt et un un appel qui exécute `relevéPrésence`, lequel
  sonde le montage 9p avec un délai de garde. `run.ts` documente déjà ce que coûte
  ce sondage, et pourquoi il a fallu le mettre en cache : quatre fils du vivier de
  libuv suffisent à bloquer le serveur ;
- **enrichir la liste**, mais seulement de ce qui est **gratuit** : y a-t-il une
  exécution en cours (`progression(id)`, une lecture de `Map` dans le processus)
  et la dernière a-t-elle échoué (`lireStatut(id)?.error`, un petit fichier
  local). Ni l'un ni l'autre ne touche au Drive.

C'est la seconde qui a été retenue, et elle suffit exactement à ce que la
bibliothèque doit dire : « trois analyses en cours, une en échec ». La présence
des artefacts, elle, se résout quand on ouvre le projet, là où le sondage se paie
de toute façon. Le sondage de la liste s'arrête d'ailleurs dès que plus rien ne
tourne : ce qui la rend gratuite est ce qu'elle ne demande pas.

**Les cinq états**

| État | Ce qui s'affiche |
|---|---|
| Chargement | squelettes aux dimensions finales, pour que la grille ne saute pas quand les cartes arrivent. Les vignettes ont leur propre chargement, plus lent, indépendant. |
| Vide | deux vides distincts, et les confondre serait un défaut de diagnostic. **Aucun projet** : la section disparaît, la grille prend toute la place. **Aucune source** : la ligne de montage de `GET /api/sources` porte `fstype`, `entrées` et une `cause` nommée, donc l'écran distingue « ce dossier est vide » de « ce montage n'a pas eu lieu » (spec §12, incident réel d'OpenShorts). **La cause vient du serveur, l'écran ne la devine pas** : c'est lui qui a essayé de lire, donc lui seul sait si le chemin était absent, refusé, muet ou illisible. Un écran qui énumère trois hypothèses fait relire trois choses là où une seule a échoué. |
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
| **Repérage** | fil d'Ariane `avolo·shorts / <émission>`, et sous le titre la phase en toutes lettres : « analyse en cours », « prêt à trier, les images arrivent avec le proxy », « 12 à trier », « tout est trié ». À côté du compte, **la part de l'émission que le repérage a effectivement jugée** quand elle n'est pas entière, et sous elle le compte des lots refusés qui l'explique. Voir 7.2. |
| **Navigation** | vers le haut, la bibliothèque. Vers le bas, un clip. Aucune navigation latérale. |
| **Persistance aller** | rien à transmettre : l'identifiant du projet est dans l'URL. |
| **Persistance retour** | trois choses à retrouver en revenant d'un clip : la position de défilement, la vue active (à trier / gardés / écartés) et le focus sur la carte d'où l'on est parti. La vue dans l'URL (`?vue=gardes`), les deux autres dans l'état de session. L'URL pour la vue parce qu'un rechargement doit rendre le même écran ; la session pour le reste, parce qu'une position de défilement dans une URL est une URL qu'on ne peut plus partager. |
| **Validation** | aucune saisie. |

**Les cinq états**, et c'est ici que la distinction paie.

| État | Ce qui s'affiche |
|---|---|
| Chargement | squelettes de cartes tant que `GET /candidates` n'a pas répondu. **À ne pas confondre avec l'attente d'analyse** : le premier dure 200 ms, le second neuf minutes. Aujourd'hui les deux rendent la même grille grise. |
| Vide | quatre vides différents, chacun avec son texte et son action. `attente` : le panneau d'avancement, pas un message. `{ triable, rien }` : le repérage a rendu une liste vide, proposer « relancer le repérage » avec `force`. `trie` : « tout est trié, 4 clips gardés », avec la liste. `echec` : le message du serveur et le bouton de reprise. |
| Erreur | deux origines à distinguer. L'analyse a échoué (`ProjectStatus.error`) : bandeau en `role="alert"`, message serveur, bouton « reprendre l'analyse ». La liste ne se charge pas : message local et « réessayer ». La seconde n'efface pas la première. |
| Désactivé | tant qu'une exécution tourne (`running` non nul, quelle que soit la phase), le bouton « relancer le repérage » est désactivé, parce que `lancer` lève `ExécutionEnCoursError` et que la route en fait un 409. Pendant `triable`, l'action « monter » de chaque carte est désactivée : pas de proxy, donc rien à lire. **Dans les deux cas la raison est écrite à côté du contrôle, pas dans une bulle d'aide.** Un contrôle désactivé sans raison visible est un cul-de-sac silencieux. |
| Succès | la décision est optimiste et instantanée : la carte change d'apparence, sans notification. Le succès de la boucle entière, lui, se marque : « tout est trié ». |

**Le panneau d'avancement** porte quatre choses, et pas une de plus : l'étape en
cours et sa progression, la liste ordonnée des étapes avec celles déjà faites, une
durée, et une phrase qui dit ce qui devient possible ensuite. Le temps restant
**n'est pas affiché** : les seules mesures dont on dispose sont deux points sur
une émission, et une estimation fausse coûte plus cher qu'une absence
d'estimation. Le coût attendu par étape, lui, s'affiche comme un ordre de grandeur
mesuré (« proxy, environ 6 min sur 1 h 40 d'émission »).

**La durée affichée est celle qu'on sait mesurer, et son libellé dit laquelle.**
Ce document réclamait le temps écoulé depuis le lancement. `ProjectStatus` ne le
publie pas : `status.json` porte un `updatedAt` et un `finishedAt`, jamais un
`startedAt`. Sur un projet dont l'analyse a démarré avant qu'on ouvre l'écran,
l'afficher reviendrait donc à inventer un chiffre, et il n'y a rien de plus
coûteux qu'un chiffre faux à côté d'une attente de neuf minutes. Le panneau
compte le temps qu'il a passé à regarder tourner l'analyse, et l'annonce ainsi :
« analyse suivie depuis cet écran ». Le jour où le serveur publiera l'instant du
lancement, c'est le libellé qui change, pas la place.

**Actions destructrices**

- **Écarter** : réversible d'un clic, le même bouton reprend sa décision.
  Aucune confirmation, et c'est une exigence explicite du plan.
- **Relancer le repérage** (`force`) : détruit les propositions non traitées et
  garde tout ce qui est humain (`mergeCandidates`). Confirmation par boîte de
  dialogue, dont le texte énonce exactement le partage : « vos 4 clips gardés
  sont conservés, les 19 propositions en attente sont remplacées ». Une
  confirmation qui ne dit pas ce qui va disparaître ne fait que retarder le clic.

**Pas d'impasse** : l'état `interrompu` est le seul qui n'ait aucune issue par
lui-même, et le bouton de reprise est ce qui le ferme. Il appelle `POST /run` avec
**les mêmes cibles que la création** et laisse le graphe planifier les
intermédiaires. Il ne les énumère pas : il vise `CIBLES_DE_REPRISE`, une
constante, parce qu'une liste recopiée dans un écran se sépare un jour de celle
qui crée les projets et laisse alors le projet à moitié reconstruit.

Une cible nomme un résultat à atteindre, pas une étape à refaire : viser la
première étape absente (`transcript`, par exemple) reconstruirait celle-là et
s'arrêterait, laissant le projet dans l'impasse d'où l'on voulait le sortir.
(relevé par Copilot)

C'était là une demande au serveur, et **la route prend désormais une cible ou une
liste**. La raison qui la fondait vaut d'être retenue, parce qu'elle décide encore
de ce que le bouton vise : reprendre sur `candidates` seul ne construit jamais le
proxy, rien n'en dépendant dans le graphe, et l'impasse ne serait refermée qu'à
moitié.

**Clavier** : voir la section 4. C'est l'écran qui en dépend le plus.

### 3.3 Clip (`/clips/:id`)

**Objectif unique** : rendre un candidat publiable. Quatre gestes en dessous
(délimiter, retirer, cadrer, exporter), un seul but.

| | |
|---|---|
| **Repérage** | fil d'Ariane `avolo·shorts / <émission> / <titre du clip>`, et le rang dans les gardés : « clip 2 sur 4 gardés ». C'est ce rang qui dit qu'on est dans une boucle et pas au bout du monde. |
| **Navigation** | retour au tri par le fil d'Ariane. « Clip suivant à monter » et « précédent », calculés sur la liste des candidats du projet. **La page interroge cette liste elle-même**, elle ne suppose pas qu'elle est en cache : arriver ici par une URL partagée, un signet ou un rechargement est un parcours que 2.2 promet de rendre repreneur, et le cache est alors vide. Venant de l'écran de tri, la requête est un succès de cache et ne coûte rien. (relevé par Codex et Copilot) |
| **Persistance aller** | rien. Le clip vient de l'API, le montage en cours vient du store. |
| **Persistance retour** | l'enregistrement différé écrit avant de quitter (`pagehide` et démontage, `keepalive: true`). Ce qui **ne** survit pas est la pile d'annulation, remise à zéro au changement de clip par la garde de `charger`. C'est acceptable et il faut le dire : `Ctrl+Z` défait le montage de cette séance, pas celui d'hier. |
| **Validation** | le titre et la description sont libres, et rien ne s'y valide pendant la frappe. Une seule règle, dite au moment de l'export : un titre vide n'empêche pas le rendu mais produit un `.txt` dont la première ligne porte `Titre : (sans titre)`, donc rien à coller au moment de publier. (Ce document annonçait une première ligne **vide** ; `texteDePublication` écrit un substitut depuis le début, et c'est mieux ainsi — une ligne vide dans un fichier fait à être collé ne se distingue pas d'un fichier tronqué. Corrigé le 18 août 2026, l'avertissement de l'écran disant désormais ce que le fichier porte vraiment.) L'avertissement se pose sur le bouton d'export, pas sur le champ. |

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
`drawImage`. Deux éléments `<video>` sur la même source seraient plus courts à
écrire et décoderaient deux fois le même flux, sur un proxy que la page lit déjà
en requêtes partielles.

**Le canevas se redessine sur deux déclencheurs, pas un.** `requestVideoFrameCallback`
pendant la lecture, et **tout changement de crop ou de ratio**, par un `drawImage`
direct sur l'image courante. Le second est le plus important des deux : le geste
réel est « on met en pause, on regarde, on ajuste », et une vidéo en pause ne
produit aucune image, donc aucun callback. Un implémenteur qui ne câblerait que le
callback livrerait un aperçu qui ne bouge pas quand on déplace le rectangle, sur
l'écran dont c'est la seule raison d'être. (relevé par Aristarque)

`requestVideoFrameCallback` n'existe pas avant Chrome 84, Firefox 110 et
Safari 17.4. Sans conséquence sur une machine fixe et un seul navigateur, mais une
garde (`'requestVideoFrameCallback' in HTMLVideoElement.prototype`) avec repli sur
un `timeupdate` évite un échec silencieux, et c'est une ligne.

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

**Mais un refus n'est pas non plus sans suite.** Une version précédente de ce
document ajoutait une **relecture** du clip « pour réconcilier », en réponse à une
question sur le multi-onglet. Cette relecture-là est doublement fausse, et il vaut
mieux l'écrire que de laisser la trace d'une bonne idée.

D'abord elle ne marcherait pas : `useEditeur.charger` sort immédiatement quand
l'identifiant du clip n'a pas changé, et cette garde est là pour une bonne
raison — elle empêche un refetch d'écraser le montage en cours et sa pile
d'annulation. Le cache serait rafraîchi et le montage local resterait tel quel.
(relevé par Copilot)

Ensuite, la contourner reviendrait à **jeter le montage en cours** et sa pile
d'annulation, ce qui n'est pas une opération à déclencher toute seule sur un refus
qui, dans le seul mode d'emploi prévu, n'est pas une anomalie.

**Ce qu'il faut malgré tout, et que ce document a d'abord manqué** (constaté à
l'implémentation, le 18 août 2026) : l'écran de clip garde ses segments, son ratio
et son cadrage dans un store **séparé** du cache, et l'enregistrement différé
compare *ce store* au clip du serveur. Laissé tel quel, il y retrouve l'écart,
renvoie l'intention qu'on vient de refuser — **avec un jeton neuf, donc
gagnant** — et la garantie d'ordre payée côté serveur ne sert plus à rien. Aucune
donnée perdue ; la garantie annulée. Le contrat de `PatchClipResult` le dit
d'ailleurs mot pour mot : « un appelant qui tient un état local doit s'y remettre
d'accord ».

La réconciliation retenue est donc la plus petite qui rétablisse la garantie :
**adopter, champ par champ, la valeur du gagnant**, et seulement sur les champs
qui *portent encore l'intention refusée* — un champ modifié pendant l'aller-retour
porte un geste postérieur, que personne n'a refusé — et *dont le gagnant dit autre
chose que la référence contre laquelle l'écart a été calculé* — sans quoi un refus
dû au plancher de jeton, qu'une horloge remise en arrière suffit à produire, ferait
perdre une modification parfaitement fraîche au lieu de la laisser repartir. Rien
n'est empilé dans la pile d'annulation, qui reste entière ; `future`, en revanche,
se vide quand le montage change, une branche abandonnée n'ayant plus de sens. Le
raisonnement complet vit au point d'appel, dans `src/lib/enregistrement.ts`.

**Le cadrage change de nature en itération 1**, et c'est traité en 3.5.

**Les cinq états**

| État | Ce qui s'affiche |
|---|---|
| Chargement | squelettes déjà en place, à conserver. |
| Vide | un clip dont tous les mots ont été retirés : durée nulle, transcript entièrement barré, export désactivé avec sa raison. Le cas est prévu côté serveur (`étendueOrigine` retombe sur `candidates.json`) et n'a pas de rendu propre aujourd'hui. |
| Erreur | trois surfaces, séparées. L'enregistrement a échoué : l'état à trois valeurs existe déjà, il lui manque un bouton « réessayer » plutôt que l'attente d'un nouveau geste. Le clip est introuvable : page dédiée avec retour à la bibliothèque. L'export a échoué : message dans le panneau d'export, avec le code renvoyé. **Le refus d'un `PATCH` périmé n'est aucune des trois**, et c'est expliqué juste au-dessus du présent tableau. |
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
bouton. Le fichier `.txt` existe sur le disque : ce qu'il faut ici est le
presse-papiers, pas un chemin.

**Le presse-papiers n'est plus seul depuis le 18 août 2026.** Ce paragraphe disait
« Julien publie avec ses propres outils » ; un spike a montré qu'Instagram et
Facebook se publient gratuitement depuis l'outil, et le panneau gagne donc une
seconde moitié — cases à cocher des plateformes, bouton, une ligne d'état par
plateforme. La conception en est à part, dans
`docs/superpowers/specs/2026-08-18-publication-reseaux-design.md` §6.5, et elle
laisse la zone de textes intacte : elle sert les réseaux qu'on ne branche pas.

**Un défaut connu à signaler dans le panneau — et il n'y en a plus.** Ce
paragraphe demandait au panneau d'avertir sur la variante 9:16, dont l'anomalie
#22 laissait les sous-titres lisibles dans le fond flouté, jaune du mot actif
compris. **Elle est fermée** : la variante tire désormais son fond d'avant
l'incrustation, vérifié à l'image — 43 tuiles sur 43 sans un pixel de texte,
contre 43 sur 43 lisibles avant (`ROADMAP.md` porte la mesure). Le panneau
n'affiche donc **aucun** avertissement pour ce défaut-là : en afficher un
signalerait un défaut qui n'existe plus, ce qui coûte la même confiance que de
taire celui qui existe.

La règle qui restait bonne, elle, ne bouge pas : livrer un fichier dont on
connaît le défaut sans le dire est ce qui fait perdre confiance dans les autres.
Le jour où une anomalie de rendu rouvre, c'est ici qu'elle se dit.

### 3.5 Le cadrage quand l'automatique arrive

L'itération 1 change le sens du sélecteur de cadrage, et c'est le changement le
plus structurant qui attende cet écran. Julien a arbitré les deux questions
ouvertes ; ce qui suit décrit la décision et ce qu'elle demande à l'écran.

Le point de départ, arrêté côté serveur :

- la position du crop devient **fixe par plan**, donc variable d'un plan à l'autre
  dans un même clip (spec §10) ;
- **le ratio se recalcule depuis l'EDL, il n'est pas stocké.** Retirer le passage
  où un comédien traverse le plateau peut faire retomber un 16:9 en 1:1 ;
- les frontières de plans et les boîtes de personnes existent, portées par un
  `analysis.json` unique. **C'est un écart avec la spec §5**, qui définit deux
  artefacts distincts, `shots.json` et `people.json` ; ce document n'en décide pas
  et le signale en 9.3. Rien ici n'en dépend : l'écran a besoin que les frontières
  existent, pas de savoir dans quel fichier. (relevé par Aristarque)

#### La décision : un mode explicite, puis un réglage par plan

**L'automatique ne doit jamais être écrasé par accident.** Deux conséquences, et
la première annule ce que proposait la version précédente de ce document.

**Bouger le curseur ne change pas de mode.** Un geste explicite fait basculer en
manuel : un bouton, à côté du sélecteur, qui dit ce qu'il fait (« passer en
cadrage manuel »). J'avais proposé l'inverse, en pariant que la saisie du
rectangle serait une déclaration d'intention suffisante et que le voir cesser de
bouger enseignerait le reste. Le pari est mauvais : le geste qui explore et le
geste qui décide sont le même, et on découvre alors qu'on a détruit le cadrage
automatique en essayant de le regarder. Un mode se prend, il ne se déclenche pas.

**En manuel, le crop se règle par plan.** La dérogation globale sur tout le clip
est écartée : elle effacerait le cadrage des plans qui étaient bons pour réparer
celui qui ne l'était pas.

Le `cropX` unique d'un clip n'exprime plus cela. `computeFraming` prend désormais
le mode et la table de dérogations ; ce que le clip enregistre, lui, n'a pas
bougé, et c'est le préalable du lot 7. Voir 9.4.

#### La clé d'un plan désigne la source, jamais le clip

Le détail qui se paie en bug silencieux. Les crops se recalculent depuis l'EDL et
ne sont pas stockés. Si une dérogation est indexée sur le **rang du plan dans le
clip**, retirer un segment en amont décale tous les rangs, et chaque dérogation
atterrit sur le plan voisin. Rien ne le signale : le clip se rend, et le cadrage
est faux.

La clé désigne donc le plan **dans la source**. Et pas par son instant de début,
qui paraît suffire et ne suffit pas : il parie que la frontière qui le porte sera
encore là, et à la même place, la prochaine fois que les plans seront détectés.
Une frontière déplacée de 10,0 s à 10,3 s fait tomber la clé 10,0 s **dans le plan
précédent**, qui la contient bel et bien, et la dérogation s'applique au mauvais
cadre sans que rien ne le signale ; une frontière retirée, elle, emporte sa clé.
Prendre le milieu du plan plutôt que son début rend le premier cas plus rare, pas
impossible, et ne fait rien pour le second. (relevé par Copilot)

**Une dérogation porte donc l'intervalle source du plan tel qu'il était quand elle
a été posée**, et se résout par **recouvrement maximal** avec le découpage
courant :

- elle s'applique au plan actuel avec lequel son intervalle se recouvre le plus ;
- si un plan a été **divisé**, elle suit la moitié qu'elle recouvre le plus, et
  l'autre repasse en automatique ;
- si deux plans ont été **fusionnés**, les deux dérogations tombent sur le même
  plan : on garde celle du plus grand recouvrement ;
- **les deux égalités se tranchent par ce qui commence le plus tôt**, et elles
  sont toutes deux atteignables. Une coupe exactement au milieu donne à une
  dérogation deux moitiés qu'elle recouvre autant : elle suit la première. Deux
  dérogations peuvent de même recouvrir également le plan qui les a absorbées :
  on garde celle qui commence le plus tôt. Sans cette ligne, la moitié gagnante
  dépendrait de l'ordre de parcours, ce qui est une décision prise par personne ;
- un recouvrement nul partout fait tomber la dérogation, et le plan repasse en
  automatique.

**Les deux bornes se persistent en millisecondes entières.** Le recouvrement, lui,
se calcule aussi bien sur des flottants : ce n'est pas l'arithmétique qui réclame
l'entier, c'est le fait qu'une seule unité doit régner sur tout le modèle du crop.
`detect.py` arrondit déjà `start` et `end` à la milliseconde, `shotStartMs`
(`src/core/shots.ts`) rearrondit avec son raisonnement au point d'appel, et
`computeFraming` indexe en entiers. Une table écrite en secondes cohabiterait donc
avec des plans lus en millisecondes, et c'est ce mélange qui rate d'un facteur
mille, pas le calcul. Le rattraper après coup demanderait de relire des
dérogations dont on ne saurait plus dans quelle unité elles ont été écrites.

**Ce qui a décidé de cette forme n'est pas la frontière qui bouge de trois
dixièmes, c'est que le seuil de détection des plans va être reréglé.** La spec §5
place `shots.json` dans le projet précisément parce que ce seuil se règle, et
`ROADMAP.md` note que le seuil de scène à 0,4 a été mesuré image par image et
revient à qui reprendra le détecteur.

Un réglage ne déplace pas les frontières : `plans()` (`worker/detect.py`) filtre
des instants candidats et rend tels quels ceux qui passent. Il en **ajoute** et il
en **retire**, et son garde-fou de durée minimale fait qu'une frontière
nouvellement admise peut en faire tomber une autre plus loin. Une redétection
produit donc exactement des plans divisés et des plans fusionnés, c'est-à-dire les
deux cas que les règles ci-dessus nomment.

Sous une clé qui est un instant, la dégradation n'est pas symétrique : une
frontière qui survit garde sa dérogation, une frontière retirée fait disparaître
la sienne, et la moitié née d'une frontière ajoutée n'en a jamais eu. Le jour du
réglage, on perd donc le cadrage humain **des plans qui ont le plus changé**, et
on le perd en silence. Sous le recouvrement, chaque dérogation suit le plan qui
l'a absorbée. Ce n'est pas un cas hypothétique à couvrir par prudence, c'est une
tâche au calendrier.

**Un appariement par tolérance ne remplace pas cette forme, et il rate même
l'exemple qui l'a fait poser.** Cet exemple est une frontière qui bouge de trois
dixièmes de seconde ; la tolérance de `computeFraming` est de 250 ms, donc elle ne
le couvre pas. Et le seuil ne se répare pas en se desserrant : rien dans
`SCHÉMA_PLAN` n'interdit deux frontières séparées de moins que lui, un plan devant
seulement finir après son début, donc une tolérance assez large pour rattraper un
déplacement est assez large pour sauter sur le plan voisin. Le recouvrement, lui,
est total par construction et ne suppose rien du détecteur, ce qui est exactement
ce qu'on demande d'une clé qui doit survivre au réglage de celui-ci.

**Une dérogation qui ne recouvre plus rien n'est jamais reportée sur une
voisine.** Elle est rendue à l'appelant, dans `rejectedOverrides`, et le plan qui
l'aurait reçue garde son cadrage calculé. C'est le mode de défaillance qui
comptait : un cadrage humain posé sur le mauvais plan produit un clip qui se rend,
faux, et que rien ne signale.

Ce qu'il en reste pour l'écran tient en une exigence : **une dérogation tombée se
voit, et la bande ne suffit pas à la montrer.** Un plan « automatique » y est
indistinguable d'un plan qui n'a jamais été dérogé ; pire, une dérogation écartée
parce qu'une autre recouvrait mieux le même plan laisse ce plan dérogé, donc aucun
état de la bande ne change, et une dérogation qui ne recouvre plus rien n'a même
pas de plan à marquer. L'écran lit donc `rejectedOverrides` et l'énonce à part, en
clair et de façon permanente : « une dérogation de cadrage n'a pas retrouvé son
plan », avec
son compte. Reposer un cadrage coûte un geste ; s'apercevoir trois semaines plus
tard qu'il n'a jamais été appliqué coûte une relecture de tout ce qui est sorti
depuis.

**`computeFraming` indexe encore ses dérogations sur l'instant de début**, avec
un appariement au plus proche dans une tolérance de 250 ms. C'est l'itération 0 de
la fonction pure, pas une seconde option à peser : la tâche qui écrit la
persistance du cadrage remplace cet appariement par le recouvrement décrit ici.
Entre deux modèles de clé dans un même document, c'est toujours celui qui n'a pas
été retenu qu'on finit par écrire.

#### Le ratio, exactement comme le crop

Julien suit la recommandation de symétrie. Les deux réglages ont donc le même
vocabulaire, et c'est ce qui rend l'écran apprenable en une fois :

| | Ratio | Crop |
|---|---|---|
| État par défaut | `auto`, valeur calculée affichée (`auto → 4:5`) | `auto`, rectangle dessiné à la position calculée |
| Déroger | choisir une pastille de ratio | bouton « cadrage manuel », puis saisir le rectangle |
| Portée de la dérogation | le clip | le plan courant |
| Revenir | pastille `auto` | bouton « revenir à l'automatique », ce plan ou tous |
| Effet d'une modification du montage | aucun si épinglé, recalcul si `auto` | aucun si dérogé, recalcul si `auto` |

**Le calcul, lui, rend désormais un ratio par plan** (spec §10) : le ratio du clip
est le plus large d'entre eux, et c'est celui que le sélecteur affiche. Épingler
reste une décision qui porte sur le clip entier — c'est ce qu'on veut d'une
échappatoire, un cadrage stable quand l'automatique choisit mal —, et la valeur
affichée à côté d'`auto` reste donc une valeur unique. La variation par plan se
voit dans la bande des plans et dans la sortie 9:16, pas dans le sélecteur.

**Un ratio épinglé ne bouge plus quand le montage change.** C'est le sens de
l'épinglage, et c'est ce qui manquait pour que le recalcul soit acceptable.

**Une conséquence serveur, demandée puis livrée** : quand le ratio est épinglé,
`computeFraming` saute le choix du ratio mais pas le calcul des crops, qui se
font **pour ce ratio** et non pour celui que le percentile aurait choisi. Sans
cela, des cadres calculés pour un 1:1 se retrouveraient posés dans un canevas
4:5, et l'épinglage produirait exactement le défaut qu'il devait éviter.

#### Voir d'un coup d'œil ce qui est automatique et ce qui ne l'est pas

Trois porteurs, et pas un de plus.

**Le sélecteur de ratio.** `auto → 4:5` quand il calcule, `4:5` seul et marqué
quand il est épinglé. Un mot, au même endroit, dans les deux cas.

**La bande des plans**, en lecture, sous le lecteur. Elle est désormais justifiée :
c'est aux frontières que le crop saute, c'est là que les coupes se posent de
préférence, et c'est la seule façon de voir quels plans ont été dérogés. Chaque
plan y porte **l'origine de son cadrage**, telle que `computeFraming` la rend :
calculé sur des boîtes de personnes, posé à la main ou **centré faute d'avoir
mesuré quoi que ce soit sur ce plan**. Le troisième mérite d'être distinct des
deux autres : ce n'est pas une décision, c'est un plan que personne n'a cadré, ni
la machine ni l'humain, et c'est précisément celui qu'il faut aller regarder.

**Pas d'état « validé »** en revanche : il faudrait le poser à la main, et un clip
de quatre plans deviendrait une liste de contrôle. La bande dit d'où vient un
cadrage, jamais si quelqu'un l'a approuvé.

**Elle est en lecture au sens du montage.** On n'y déplace pas une frontière, on
n'y pose pas une coupe, on n'y traîne pas de tête de lecture. Elle porte une seule
interaction, qui n'est pas temporelle : désigner le plan qu'on cadre. C'est ce qui
la sépare d'un banc de montage, et la séparation doit être tenue au moment de
l'écrire, parce qu'une bande horizontale appelle toutes les autres.

**C'est une interprétation de la spec §13, et je l'assume plutôt que de la
glisser.** §13 écrit « une bande secondaire montre les plans et le ratio retenu,
en lecture seule », et je lis « lecture seule » comme portant sur le montage :
elle ne modifie ni les segments, ni les bornes, ni les frontières. Désigner un
plan pour le cadrer ne touche à rien de tout cela. Si la lecture stricte est celle
qui vaut, c'est §13 qu'il faut amender, pas la bande qu'il faut rendre inerte :
sans désignation, la dérogation par plan n'a plus de surface. Porté en 9.3.
(relevé par Aristarque)

Les frontières apparaissent **aussi** dans le transcript, sous forme d'un filet en
travers du texte. La bande dit où l'on en est parmi les plans ; le filet dit à
celui qui retire une phrase qu'une frontière est à deux mots, donc que sa coupe
peut s'y poser. Deux questions différentes, deux endroits.

#### Naviguer de plan en plan sans banc de montage

**Le plan qu'on cadre est celui sous la tête de lecture.** Aucune sélection dans
le cas courant : on lit, on s'arrête sur le plan mal cadré, on saisit le
rectangle, il s'applique à ce plan. Deux touches sautent à la frontière précédente
et suivante. La section 4.1 dit lesquelles, et c'est le seul endroit qui les
attribue ; ce sont deux boutons de recherche, pas une piste.

C'est la réponse à « comment on navigue sans que ça devienne un banc » : on ne
navigue pas dans une timeline, on déplace la lecture, et la lecture est déjà le
seul organe de navigation temporelle de cet écran (3.3, point 2).

#### Revenir à l'automatique sans craindre de perdre son travail

Trois retours, du plus fin au plus large, et **aucun n'est destructeur** :

- ce plan revient à l'automatique ;
- tout le clip revient à l'automatique, ce qui efface toutes les dérogations : le
  seul des trois qui mérite une confirmation, avec le nombre de plans concernés ;
- `Ctrl+Z`.

Le troisième est le vrai. Il suppose une chose que ce document demande
explicitement : **l'historique d'annulation couvre le cadrage, pas seulement les
segments.** `history.ts` empile aujourd'hui des `Segment[]` ; l'instantané devient
`{ segments, ratio, mode, dérogations }`. Sans cela, « revenir en arrière »
signifie deux choses différentes selon le geste qu'on vient de faire, ce qui est
la manière la plus sûre de faire douter quelqu'un de son propre outil.

#### Ce que l'écran montre d'une décision qu'on n'a pas encore regardée

La question est réelle : l'automatique décide pour chaque plan, et rien ne garantit
qu'on ait regardé le résultat avant d'exporter.

**La réponse n'est pas une case à cocher par plan.** C'est de rendre la décision
visible sans qu'on la demande : la valeur calculée à côté de `auto`, le rectangle
dessiné à la position calculée, et **le rectangle qui saute aux frontières pendant
la lecture**. Regarder le clip une fois, ce qu'on fait de toute façon avant de
l'exporter, est ce qui passe la décision en revue.

Ce que l'écran doit empêcher, en revanche, c'est qu'on livre sans avoir vu ce qui
a été décidé pour nous. **Le panneau d'export énonce donc le cadrage** :
le ratio résolu et combien de plans sont cadrés automatiquement, sur la dernière
surface avant la livraison. Ça ne coûte rien et ça retire le seul cas où
l'automatique passerait en fraude.

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
| Clip | `I` / `O` | poser la borne de début, de fin, sur le mot sous le curseur |
| Clip | `Ctrl+F` | chercher dans le transcript |
| Clip | `,` / `.` | frontière de plan précédente, suivante (itération 1, voir 3.5) |
| Partout | `?` | la liste des raccourcis |

Trois règles derrière ce tableau.

**`G` et `E` avancent.** Une boucle se parcourt : décider sans avancer oblige à un
geste sur deux. `U` revient sur la décision précédente **et sur sa carte**, sinon
on corrige à l'aveugle.

**Aucun raccourci ne vole une frappe à un élément interactif**, et « interactif »
ne veut pas dire « champ de saisie ». La garde actuelle de `useRaccourcis` n'écarte
que `input, textarea, select` et le contenu éditable, ce qui suffisait à trois
raccourcis dont aucun n'était une touche d'activation. Ce n'est plus vrai : `Espace`
sur un bouton d'export qui a le focus l'active **et** lance la lecture, et les
flèches sur les onglets du tri déplacent à la fois l'onglet actif et la carte
sélectionnée. La garde écarte donc tout élément qui traite déjà la touche :
`button`, `a[href]`, `[role="button"]`, `[role="tab"]`, `[role="slider"]`,
`summary`, en plus des champs. Le contrôle `instanceof HTMLElement` reste, sans
lequel aucun raccourci ne fonctionnait. (relevé par Codex)

Corollaire sur `Espace` : il ne peut pas être un raccourci global inconditionnel.
Il ne pilote la lecture que si le focus est sur le corps du document ou sur la
surface transcript.

**Ce tableau est le seul endroit où une touche est attribuée.** Une version
précédente donnait `Alt+←` et `Alt+→` ici pour la navigation de plan en plan, et
`,` et `.` en 3.5 : deux raccourcis pour un même geste, dans un document qui
n'existe que pour être la source unique de qui l'implémentera. `,` et `.`
l'emportent parce qu'`Alt+←` est le retour arrière du navigateur, sur l'écran
qu'on quitte le plus souvent.

**`?` existe parce que le reste existe.** Des raccourcis qui ne se découvrent que
dans un `title` HTML sont des raccourcis que personne n'utilise. Le compte est
celui du tableau ci-dessus, et il n'a pas à être écrit deux fois.

**Les touches de boucle sont directes en AZERTY.** Une première version proposait
`[`, `]` et `/`, qui demandent `Alt Gr` ou `Shift` sur le clavier de la seule
personne qui utilisera cet outil : un raccourci à deux mains n'économise rien sur
un geste répété trente fois. Deux touches du tableau coûtent malgré tout un
`Shift`, `.` et `?`, et aucune des deux n'est un geste de boucle : sauter de plan
en plan se fait quelques fois par clip, ouvrir l'aide une fois par mois. C'est le
geste répété que la règle protège, et l'étendre à tout le tableau la rendrait
inapplicable. `I` et `O` sont d'ailleurs la
convention des bancs de montage pour les points d'entrée et de sortie, et `Ctrl+F`
remplace celui du navigateur, que la virtualisation neutralise de toute façon.
(relevé par Aristarque)

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
distincte n'annonce que **les changements d'étape** et la fin. Une annonce par
changement d'étape observé, plus celle de fin. Observé, parce que la région rend
l'étape que le dernier sondage a rapportée : une étape plus courte que les deux
secondes de l'intervalle peut passer entre deux relevés sans jamais être annoncée,
et promettre l'exhaustivité surévaluerait ce qu'un lecteur d'écran reçoit. Le
compte, lui, se lit dans `ÉTAPES` et ne s'écrit pas ici : l'itération 2 en
ajoutera, l'itération 4 aussi, et un total figé dans une phrase ne deviendrait
faux que ce jour-là, trop tard pour que quiconque s'en aperçoive.

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
testable. Le test ne parcourt pas le produit cartésien des couples : plusieurs
sont inatteignables (`attente` ne coexiste avec aucun travail décidé, faute de
candidats), et forcer une action sur un état impossible oblige à en inventer une. Il énumère donc des
**entrées** (relevés de présence, exécution en cours, statuts de clips), les passe
à `phaseProjet`, et vérifie que `suite` rend un résultat pour chaque couple ainsi
produit. Enumérer les entrées plutôt que les sorties vaut mieux qu'une relecture
des trois écrans. (relevé par Aristarque)

### 5.3 Ajouter ou retirer une étape

L'itération 1 a ajouté une étape au graphe, `analysis`, qui porte les frontières
de plans et les boîtes de personnes ; l'itération 2 ajoute quatre pourvoyeurs de
candidats. Pour que ce soit une ligne et non une refonte :

- **les étapes sont une liste de données**, avec libellé, ordre et coût attendu,
  posée à côté de `phaseProjet` dans `src/core/`. Aujourd'hui `LIBELLES_ETAPES`
  vit dans un fichier de page ;
- **le panneau d'avancement itère cette liste**, il ne connaît aucun nom d'étape ;
- **`phaseProjet` ne cite aucune étape par son nom** sauf celles qui changent ce
  que l'utilisateur peut faire : `candidates` ouvre le tri, `proxy` ouvre le
  montage. Les autres ne sont que du temps qui passe. Ce n'est **pas** le
  transcript qui ouvre le tri, même s'il le précède : la liste reste vide jusqu'à
  la fin du repérage. Nommer l'étape qui produit l'artefact qu'on affiche est la
  seule formulation qui survive à l'ajout d'étapes. (relevé par Copilot)

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

1. **`phaseProjet` et `suite`, en tests purs, sans DOM.** Les couples que
   `phaseProjet` produit réellement, et l'invariant « aucun couple atteignable
   sans issue », l'issue pouvant être une attente nommée. C'est le test qui
   remplace la relecture des écrans.
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
  raccourcis de la section 4 couvrent le besoin, et `?` les fait découvrir.

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

Des lots de notation reviennent `PROHIBITED_CONTENT` sur `2025-06-15-cqlp`, de
façon reproductible. Au moment où cette section a été écrite, un tiers du matériau
était écarté sans être jugé, **en silence**, et c'est ce silence qu'elle traite.

**La cause a été traitée depuis, et pas le silence.** Le repérage recoupe
désormais les lots refusés et resoumet les moitiés : sur cette émission, les 83
fenêtres finissent toutes notées. La perte n'est donc plus le cas courant, elle
est le cas résiduel, celui d'un lot refusé jusqu'à la fenêtre seule, et c'est ce
qui rend la suite plus exigeante et non moins. Julien trierait vingt-cinq
cartes en croyant regarder ce que l'émission a de mieux, alors qu'il regarderait
ce que l'émission a de mieux **dans la part qui a été notée**. Sans le mot, il
attribuerait au repérage une qualité qui n'est pas la sienne, et il n'aurait
aucune raison d'aller chercher dans ce qui manque. Un défaut devenu rare se
signale de la même façon qu'un défaut fréquent : c'est précisément parce qu'on ne
l'attend plus qu'il faut le dire.

Le décompte remonte dans `status.json`, et il y survit à un redémarrage du
serveur, ce que `running` ne fait pas. Trois exigences sur ce qu'on en fait, et
aucune n'est cosmétique.

**On dit ce qu'on a mesuré, pas ce qui sonne mieux.** Une première version de ce
document proposait « 27 propositions, tirées de 64 % de l'émission ». Le chiffre
est faux et les trois relecteurs l'ont attrapé : ce que le serveur compte, ce sont
des **lots**, et un lot n'est pas une part d'émission. Les fenêtres se chevauchent
de 30 secondes (`src/core/transcript.ts`), le dernier lot est plus court que les
autres puisqu'il sort d'un `slice`, et une fenêtre couvre de la parole et non une
tranche de temps. Sept lots sur onze ne font donc pas 64 % de quoi que ce soit.

Deux grandeurs, et elles ne répondent pas à la même question :

- **le compte de lots refusés** dit ce qui s'est passé et rien de plus. Le
  confondre avec de la matière perdue serait faux depuis que le repérage recoupe
  les lots refusés et les resoumet : sur `2025-06-15-cqlp`, 83 fenêtres sur 83
  finissent notées. Ne pas illustrer ce compte par un nombre pris sur le premier
  passage : `lotsRefusés` s'incrémente à **chaque profondeur** de la descente et
  `lotsRépondus` compte les sous-lots, donc le total que l'écran reçoit n'est pas
  celui du premier tour. La perte, quand il y en a une, se lit ailleurs ;
- **la couverture temporelle**, l'union des fenêtres effectivement notées
  rapportée à l'étendue du transcript, répond à la question que Julien se pose.
  Ce document la demandait au serveur ; elle existe (`BilanRepérage.couverture`),
  calculée au même endroit que le décompte.

C'est donc la couverture qui porte la phrase, et les lots qui l'expliquent
dessous. L'ordre n'est pas un détail de mise en page : lue en premier, une mesure
de mécanisme fait croire qu'on parle d'un incident technique, alors qu'on parle de
matière qui n'a pas été jugée.

**Et c'est le compte des fenêtres qui décide s'il y a quelque chose à dire, pas le
refus.** Une fenêtre non notée est une perte ; un lot refusé puis recoupé et noté
ne coûte rien. La couverture, elle, ne décide pas : elle **mesure** l'étendue de
la perte une fois qu'on sait qu'il y en a une. La distinction n'est pas
scolastique, parce que les fenêtres se chevauchent d'environ 30 secondes : une
fenêtre du milieu peut manquer sans laisser le moindre trou dans le temps, donc
une couverture sincèrement totale peut cacher une fenêtre que personne n'a jugée.
Le déclencheur est `notées < fenêtres`, et lui seul.

`motDuRepérage` tient la première moitié de cette règle et pas la seconde : son
prédicat ajoute `|| lotsRefusés > 0`, donc le cas mesuré de `2025-06-15-cqlp`, où
la descente finit par tout noter, lui fait écrire « le repérage n'a jugé que
100 % de ce qui se dit dans l'émission », une phrase qui se réfute toute seule.
(relevé par Codex et Copilot)

**Ça reste à l'écran.** Ni notification, ni bandeau qu'on referme : c'est une
propriété permanente de cette liste-là, au même titre que son nombre d'éléments,
et ça vit à côté du compte. Une information qui change la confiance qu'on accorde
à un écran ne peut pas s'afficher trois secondes.

**Et ça ne porte pas de fausse action.** Une première version proposait « relancer
le repérage » comme recours, en supposant le découpage non déterministe. Il l'est :
`buildWindows` et le découpage en lots sont déterministes, et le serveur traite
`GeminiBlockedError` comme reproductible et jamais réessayable. Une seconde passe
soumettrait exactement les mêmes charges et se ferait refuser exactement pareil,
en consommant du quota pour rien. (relevé par Codex et Copilot)

Ce qui changerait quelque chose est de **changer ce qui est soumis** : une autre
taille de lot, d'autres réglages de sécurité, un autre découpage. C'est du travail
serveur, et l'écran n'a pas à le promettre. Il énonce la perte, il ne feint pas de
la réparer. Un bouton qui ne répare rien est pire que pas de bouton : il fait
croire que le problème est traité.

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
   paie trente fois par émission. Livré avec un défaut connu, décrit en 7.2 : la
   phrase de couverture s'allume sur un refus au lieu de s'allumer sur une perte.
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
7. **Le cadrage automatique** (section 3.5), avec l'itération 1 et pas avant. Trois
   pièces, dans cet ordre : le mode explicite et le retour à l'automatique,
   l'historique d'annulation étendu au cadrage, puis la bande des plans et la
   dérogation par plan. Les deux premières ne dépendent pas des plans et peuvent
   se poser dès que le modèle serveur existe.

**Les six premiers sont livrés**, et les trois dépendances serveur qu'ils
attendaient sont satisfaites : les fonctions clientes d'action, le jeton de
séquence sur `PATCH`, et la liste de cibles pour `POST /run` sans laquelle le
bouton de reprise n'aurait reconstruit que les candidats.

**Le septième ne l'est pas, et ce n'est pas l'interface qui le retient.** Il lit
le résultat du cadrage automatique, qui est en ligne et ne produit rien
d'utilisable : sur `2025-06-15-cqlp`, les trente clips sortent tous en 16:9, parce
qu'un tiers des boîtes de personnes sont des têtes de spectateurs collées au bord
bas de l'image. Offrir de déroger à un calcul qui ne calcule rien coûterait plus
que de ne rien offrir : on croirait corriger la machine alors qu'on la
remplacerait à chaque plan. `ROADMAP.md` tient la liste des morceaux d'itération 1
qui viennent avant, et leur ordre.

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

Si le chiffre de 35 minutes vient d'une mesure que je n'ai pas trouvée, ce sont
**les nombres** de la section 2.4 qui changent, pas sa structure : les trois
régimes viennent de l'**ordre** des étapes que `CIBLES_INITIALES` déclenche
(`run.ts`), pas de leur durée. Les candidats arrivent avant le proxy
quelle que soit la vitesse de WhisperX, donc « triable mais pas montable » existe
dans les deux mondes. Ce qui change est l'ampleur des moyens : à trente-cinq
minutes il faut une file d'attente, des notifications et un suivi hors écran ; à
neuf, un panneau honnête suffit.

C'est aussi ce qui rend l'arbitrage tenable : on peut trancher plus tard sans
refaire la conception, seulement l'outillage de l'attente. Sinon, c'est la spec §6
qui mérite une note. (relevé par Aristarque, qui l'a signalé indépendamment)

### 9.2 L'ordre des candidats et du proxy

Que `CIBLES_INITIALES` place les candidats avant le proxy est ce qui rend
possible le régime « triable » de 2.4, et je propose de le garder. Le prix est
que la grille de tri passe ses six premières minutes sans vignettes, sur l'écran
que la spec demande de soigner en premier.

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

**La spec §5 et le nom des artefacts.** §5 définit `shots.json` (les frontières de
plans) et `people.json` (les boîtes de personnes). Le code en a écrit un seul,
`analysis.json`, qui porte les deux, et ce n'est plus une annonce : le fichier
existe, l'étape qui le produit s'appelle `analysis`, et `lireAnalyse` le relit et
le valide. Le raccord entre ce fichier et le cadrage reste à écrire :
`computeFraming` est une fonction pure qui reçoit des plans et des boîtes déjà
lus, la frontière de `src/core` lui interdisant de toucher au disque, et rien en
production ne l'appelle encore. Ce n'est pas une question d'interface et je ne la
tranche pas. Mais deux
noms pour un fichier, dont un seul existe, est exactement ce qui envoie le suivant
chercher un artefact absent. La fusion demande à être écrite en §5. (relevé par
Aristarque)

**La spec §13, deux fois.** D'abord la bande des plans, qu'elle décrit « en
lecture seule ». La dérogation de cadrage par plan a besoin d'y désigner un plan,
ce qui ne touche ni aux segments, ni aux bornes, ni aux frontières. Je lis donc
« lecture seule » comme portant sur le montage, et si c'est la lecture stricte qui
vaut, c'est §13 qu'il faut amender : rendre la bande inerte retirerait sa surface à
la décision que Julien vient de prendre. Le raisonnement est en 3.5.

Ensuite l'export. §13 décrit l'écran de tri et l'écran de clip, et ne dit rien de
l'export dans l'interface. Ce silence est exactement le trou que `ROADMAP.md`
décrit comme « une couture d'orchestration » : chaque agent a livré son périmètre
et personne ne possédait le raccord. Une ligne dans §13 disant que l'export est un
panneau de l'écran de clip aurait suffi à le faire exister.

### 9.4 Les arbitrages du cadrage, et ce qu'ils demandent au serveur

Les deux questions que ce document posait sont tranchées, et la section 3.5 décrit
la décision plutôt que l'alternative. Les demandes au serveur qu'elles laissaient
sont listées ici parce qu'elles ne s'écrivent pas dans `src/app/`. Celles qui sont
satisfaites restent, barrées : les retirer ferait redemander demain ce qui a déjà
été payé.

**Le modèle de cadrage, arbitré, à moitié écrit.** Il faut un `cropMode`
explicite, `auto` ou `manual`, et, en manuel, une dérogation **par plan**. La
clé n'est ni un rang, ni un instant : c'est **l'intervalle source du plan tel
qu'il était quand la dérogation a été posée**, résolu par recouvrement maximal
avec le découpage courant, **ses deux bornes en millisecondes entières**. Un rang
ne survit pas à un retrait de segment en amont, un instant ne survit pas au
prochain réglage du seuil de détection, et des secondes flottantes ne se
retrouvent pas d'une écriture à l'autre. Le raisonnement complet, avec les règles
de division et de fusion, est en 3.5.

`computeFraming` (`src/core/framing.ts`) prend déjà le mode et une table par plan,
mais l'indexe sur l'instant de début avec une tolérance de 250 ms : c'est
l'itération 0 de la fonction pure, et la tâche de persistance la remplace.

**Rien n'est enregistrable aujourd'hui.** Un clip ne porte qu'un `cropX` unique,
en base comme dans `ClipPatch`. **C'est le préalable du lot 7** : sans le mode et
la table, l'écran calculerait un cadrage par plan qui disparaîtrait au
rechargement.

**~~Le recalcul sous un ratio épinglé.~~ Livré.** `computeFraming` saute le choix
du ratio quand il est épinglé, jamais le calcul des crops : ceux-ci se calculent
pour ce ratio-là. Sinon des cadres calculés pour un 1:1 se retrouveraient posés
dans un canevas 4:5, décalés de la différence de largeur, et l'épinglage
produirait le défaut qu'il devait éviter.

**~~Une liste de cibles pour `POST /run`.~~ Livrée.** La route accepte une cible
ou une liste, et `runProject` aussi. La forme à une cible reste valide, ce qui est
délibéré : elle couvre le cas le plus fréquent, relancer le repérage, sans obliger
chaque appelant à écrire un tableau d'un élément.

**~~La fraîcheur des rendus.~~ Résolu le 18 août, avant même d'être demandé.**
Une réédition **défait** bien le statut `exported` : `écarterRenduPérimé` s'en
charge sur chaque `PATCH`, et `sortiesDuClip` refuse de servir des fichiers sous
un clip qui ne porte plus ce statut. `livre` se lit donc sur `exported`, sans
champ supplémentaire. Le détail est en 2.3.

### 9.5 Quatre questions de la relecture, et leurs réponses

Aristarque a posé quatre questions à vérifier. Trois se referment sur du code
existant, et je consigne la vérification plutôt que de la laisser ouverte.

**Le `pid` de `status.json` fuite-t-il au client ?** Non.
`GET /api/projects/:id` construit sa réponse champ par champ
(`{ project, steps, running, error }`) et ne sérialise jamais `status.json` en
bloc. Le `pid` reste côté serveur, et la déduction de `interrompu` décrite en 2.4
n'y touche pas.

**Le message d'erreur expose-t-il l'intérieur de la machine ?** Non, et c'est déjà
documenté : `ProjectStatus.error` est « déjà épuré de ses chemins absolus, comme
celui d'une réponse d'erreur ». La règle d'interface qui en découle mérite d'être
écrite : **l'écran affiche le message du serveur, il n'en compose jamais un
depuis une exception.** C'est aussi ce qui garantit qu'une région `role="alert"`
ne lise pas une trace à voix haute.

**Le multi-onglet est-il un cas d'usage ?** Non : un utilisateur, une machine, un
onglet. Et le refus d'un `PATCH` périmé y garde son sens : la plus récente de vos
deux écritures a gagné. J'avais d'abord proposé une **relecture** pour
réconcilier ; elle est inutile, et la garde de `charger` l'aurait de toute façon
rendue sans effet. Ce qu'il faut à la place — une adoption champ par champ dans le
store, pour que l'enregistrement différé cesse de renvoyer l'intention refusée —
est décrit en 3.3 depuis l'implémentation.

**La mesure de transcription contredit-elle la spec §6 ?** Oui, et c'est la §9.1
ci-dessus. Deux documents de `docs/superpowers/specs/` se contredisent sur un fait
mesuré. C'est la seule question de cette liste qui reste ouverte, et elle demande
une décision plutôt qu'une vérification. Ce que §9.1 précise depuis la seconde
passe : seuls les nombres en dépendent, pas les trois régimes, qui viennent de
l'ordre des étapes.

**Les affirmations sur le code existant tiennent-elles ?** Aristarque a demandé de
les vérifier plutôt que de les croire, ce qui est la bonne demande : ce document
fonde plusieurs décisions dessus. Vérification faite, fichier par fichier, au
commit `5412597` :

| Affirmation | Où | Vérifié |
|---|---|---|
| `CIBLES_INITIALES = ['candidates', 'proxy']` | `src/server/run.ts` | oui, et `planPourCibles` déroule audio, transcript, candidats puis proxy |
| `history.ts` n'a qu'une pile `past` | `src/lib/history.ts` | oui : `type History = { present, past }` |
| `useRaccourcis` n'écarte que les champs | `src/app/clips/[id]/page.tsx` | oui : `cible.closest('input, textarea, select')` et `isContentEditable` |
| `setPosition` à chaque `timeupdate` | `src/components/clip-player.tsx` | oui, dans `surTemps`, appelé par `onTimeUpdate` |
| `usePatchClip` tient un jeton par clip | `src/lib/queries.ts` | oui : `useRef(new Map<string, number>())` |
| `LIBELLES_ETAPES` vit dans un fichier de page | `src/app/projects/[id]/page.tsx` | oui, ligne 15 |
| `src/lib/api.ts` n'appelle aucune route d'action | `src/lib/api.ts` | oui : quatre `GET` et un `PATCH`, rien d'autre |

**L'épuration des messages est-elle effective ?** Oui, et pas seulement documentée.
`run.ts` écrit `error: messageSûr(cause)`, et `src/core/erreurs.ts` remplace tout
chemin absolu par `…/<nom de fichier>`. Le caviardage porte bien sur les
**paramètres de requête** (`/([?&](?:key|api_?key)=)[^&\s"']+/gi`), ce qui était la
question posée : une clé passée en en-tête ne se retrouve pas dans un message, une
clé dans une URL, si. Le module note d'ailleurs que le SDK Gemini utilisé passe sa
clé en en-tête, et que le caviardage est une ceinture par-dessus des bretelles
parce que ce dépôt est public et que la version du SDK bougera. La règle
d'interface tient donc : l'écran affiche ce message, il n'en compose jamais un
depuis une exception.

**`status.json` est-il dans la spec ?** Non, et c'est une lacune de la spec, pas
une invention de ce document. Le fichier existe : `projects/<id>/status.json`,
écrit par `écrireStatut` dans `src/server/run.ts`, à côté puis renommé. La liste
d'artefacts de §5 ne le mentionne pas, alors qu'il porte l'état d'exécution dont
dépend tout le suivi d'avancement. À signaler à qui tiendra §5 à jour ; ce n'est
pas un écart de conception, seulement un fichier arrivé après la liste.
