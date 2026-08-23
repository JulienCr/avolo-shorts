# La hiérarchie des écrans : ce qui domine, et ce qui devrait

Date : 23 août 2026.
Statut : proposé. Rien de ce document n'est implémenté. Le chantier est suivi par
l'**issue #131**, qui porte le périmètre et l'ordre ; les mesures et les
arbitrages sont ici.

Ce document décide du **poids relatif** de ce que les écrans portent déjà. Il
n'ajoute aucune fonction. Il ne touche ni au pipeline, ni à l'API, ni au cadrage
automatique : la conception qui fait autorité reste
`docs/superpowers/specs/2026-08-17-avolo-shorts-design.md`, et la forme du
parcours reste `docs/superpowers/specs/2026-08-18-parcours-utilisateur-design.md`,
dont il prolonge la section 3.

Il s'appuie sur un parcours de l'interface **rendue**, au commit `ceb921a`, sur
le serveur de développement en `:4005` : les quatre écrans, les deux tiroirs de
transcript, le panneau d'avancement, avec les mesures relevées dans le DOM à
2558 × 1318. Les chiffres cités se revérifient de la même façon, et c'est leur
seul intérêt.

## 1. Le diagnostic

**Cette section décrit le code au commit `ceb921a`, et elle ne se met pas à
jour.** Comme la section 1 de la spec du 18 août, c'est le constat qui a fait
écrire le reste.

Il faut commencer par ce qui va bien, parce que ça oriente les corrections. Le
plancher typographique de 0,75 rem est tenu — zéro texte sous 12 px sur l'écran
de clip. Les actions bloquées portent `aria-disabled` et **la raison écrite en
clair à côté**, jamais en infobulle. Les cartes et les mots du transcript ont un
roving tabindex, le rectangle de cadrage et les poignées de bornes se déplacent
au clavier, Base UI rend le focus au déclencheur, les états vides sont distincts
par filtre, et les confirmations sont là où il en faut sans être ailleurs.
Chaque fichier pris isolément est soigné et sait défendre ses choix.

Ce qui manque est, une fois de plus, le niveau au-dessus — mais pas au même
endroit qu'en août. En août, trois routes n'avaient aucun appelant : le parcours
était troué. Depuis, tout a été branché. L'écran de clip a gagné le hook,
l'export, la publication, les textes de publication et un tiroir de montage.
Personne n'a redécidé ce qui domine à mesure que ça arrivait.

Le résultat se mesure : sur l'écran de clip, **un seul bouton primaire**, et ce
n'est pas le geste terminal. « Publier » est en `outline`, à côté d'« Exporter »,
en bas d'un bandeau. « Régénérer » — un appel LLM occasionnel sur le texte
d'accroche — occupe une position haute dans la colonne de droite, à hauteur
d'œil. Un utilisateur qui arrive sur l'écran ne peut pas lire *ce qu'on vient y
faire* dans la façon dont il est dessiné.

Cette spec ne demande donc presque rien à écrire. Elle demande à **retirer,
masquer, fusionner, démonter, repondérer**. C'est de la soustraction.

## 2. La tâche de chaque écran, en une phrase

Le test est celui-là : si la phrase devient « gérer X, inspecter Y, régler Z et
publier W », l'écran n'est pas encore formé.

| Écran | La tâche | L'action qui l'avance |
|---|---|---|
| `/` bibliothèque | reprendre une émission, ou lancer l'analyse d'un replay | la carte elle-même |
| `/projects/:id` | décider quelles propositions valent d'être montées | Garder / Écarter, puis Monter |
| `/clips/:id` | vérifier le clip, corriger son cadre, le livrer | Exporter, puis Publier |
| `/settings` | régler ce qui vaut par défaut pour toutes les émissions | aucune : l'écriture est au blur |

Les trois premières tiennent. La quatrième aussi, mais elle explique la section 4.3 :
un écran sans action dominante n'a pas besoin d'un bouton, il a besoin qu'on voie
l'effet de ce qu'on règle.

## 3. Les six constats qui portent la refonte

Ordonnés par valeur. Chacun dit ce qui est mesuré, ce qui entre en concurrence
avec la tâche, et le geste.

### 3.1 `Ctrl+Z` ne défait pas le cadrage, et il le fait en silence

`src/store/editor.ts:235-241` : `chooseRatio` et `moveCrop` écrivent l'état
directement, sans passer par `pushHistory`. `cancel` et `restore`
(`editor.ts:201-207`) ne parcourent que l'historique des segments, et
`useCanCancel` / `useCanRestore` s'activent sur ce seul historique.

Donc : tu changes le ratio, tu déplaces le rectangle, tu te ravises, tu fais
`Ctrl+Z`. Les boutons de la barre d'app sont actifs — ils le sont parce qu'une
édition de segments plus ancienne dort dans la pile. Ce qui se défait est cette
édition-là. Quelque chose que tu ne regardais pas, dans un tiroir fermé.

Un undo absent laisse chercher. Un undo qui agit ailleurs fait perdre du travail
sans qu'on sache où le récupérer. C'est le seul constat de ce document qui coûte
des données, et c'est pour ça qu'il est en premier.

Le cadrage est l'étape 2 du parcours réel — vérifier, cadrer, ajuster, livrer.
C'est exactement ce qu'on tâtonne.

**Le geste.** Faire passer `chooseRatio` et `moveCrop` par l'historique, comme
les segments. La pile devient celle du montage entier, ce qui est aussi ce que
les boutons prétendent déjà être. Si l'on préfère garder des piles distinctes —
il y a un argument : un `Ctrl+Z` qui traverse trois natures de geste surprend
aussi —, alors les boutons doivent se désactiver quand le dernier geste n'est pas
annulable, et nommer ce qu'ils annulent.

Attention au piège du glissé : `moveCrop` est appelé à chaque image pendant un
déplacement à la souris. Empiler chaque appel remplirait les 200 entrées de
`HISTORY_LIMIT` en deux secondes. Un seul point d'historique par geste, posé à la
fin du glissé, pas pendant.

### 3.2 Le titre et la description sont saisis deux fois sur le même écran

`src/components/clip/export-panel.tsx:531-548` — `TextsZone` rend `clip.title` et
`clip.description` verbatim, à un `.trim()` près, plus des mots-dièse dérivés de
ces deux mêmes chaînes. Les champs éditables sont à environ 700 px au-dessus,
dans la section « Contenu ».

Le fichier connaît le problème : un commentaire de `FieldCopyable` explique que
l'écran porte déjà un champ « Titre » et un champ « Description », et corrige la
collision **pour les lecteurs d'écran**, en nommant ceux-ci « Titre de
publication ». Le doublon visuel, lui, reste entier.

Coût à l'écran : trois `textarea` en lecture seule et quatre boutons « Copier »
pour du contenu déjà présent, éditable, à un demi-écran de là.

**Le geste.** Cette zone est un pis-aller en attendant les connecteurs, pas une
surface de travail : le jour où « Publier » fonctionne vraiment, personne ne
copiera plus rien à la main. Elle se réduit donc à **un seul bouton « Copier pour
publication »**, avec le détail des trois textes sous un dépliant pour qui veut
en coller un seul. Les mots-dièse restent visibles quelque part, parce qu'eux ne
sont écrits nulle part ailleurs — ils se calculent.

### 3.3 La colonne « Image » gaspille 45 % de sa largeur, « Contenu » étrangle ses champs

Mesuré à 2558 px de fenêtre, `main` plafonné à `max-w-[104rem]` soit 1664 px :

| Région | x | largeur | ce qui l'occupe |
|---|---|---|---|
| section « Image » | 447 | 1247 px | les deux aperçus font 690 px de large — **557 px vides**, en permanence |
| colonne « Contenu » + « Montage » | 1727 | 384 px | `minmax(20rem,24rem)` : le champ Titre tronque sa propre valeur |

La grille de `clip-screen.tsx:406-411` donne le plus de largeur à la région qui
en a le moins besoin. Les aperçus ont une hauteur fixe `h-72` ; tout ce qui est à
leur droite est du blanc, sur chaque clip, à chaque visite.

Ce n'est pas un problème d'esthétique. Le champ Titre tronque le titre qu'on est
en train d'écrire, et la description tient sur trois lignes, alors que 557 px
attendent à côté.

**Le geste, arrêté le 23 août 2026 après trois formes maquettées : l'établi.**
L'écran cesse de défiler et tient dans la fenêtre. Deux volets sous la fresque —
à gauche la scène, à droite la fiche —, et un rail d'action en pied. Les aperçus
ne sont plus figés à `h-72` : ils se dimensionnent sur la hauteur du volet, donc
**le vide s'annule par construction** au lieu d'être rempli.

La règle qui ordonne les volets est **la diagonale du regard**. L'œil entre par
le coin haut-gauche et sort par le coin bas-droit, et les trois moments de
l'écran tombent dessus dans l'ordre où on les fait :

1. **choisir l'extrait** — la scène, à gauche : les deux aperçus, la lecture, la
   bande de temps, le ratio, le cadre, les faits de montage ;
2. **définir ce qu'il dira** — la fiche, à droite : titre, description,
   mots-dièse, hook, badge ;
3. **l'exporter** — le rail, primaire à l'extrémité **droite**.

Un geste terminal placé ailleurs demande à l'œil de revenir en arrière pour
finir, et un parcours qui revient en arrière ne se lit pas comme une séquence.

« Montage » cesse d'être une zone : ses trois faits et son déclencheur rejoignent
la scène. Tout ce qui ne sert pas à chaque clip part derrière un déclencheur —
c'est la **condition d'existence** de cette forme, pas un ornement.

**Ce geste défait une décision mesurée, et c'est le point cher du lot.**
`PREVIEW_HEIGHT` (`clip-screen.tsx:41-54`) refuse explicitement une hauteur qui
suit la fenêtre. Mais sa mesure porte sur un `max-width` posé à côté d'un
`aspect-ratio`, qui faisait recalculer la hauteur depuis la largeur clampée et
emportait l'égalité des deux vues. L'établi ne pose aucun `max-width` : le refus
est donc énoncé plus large que ce que sa mesure démontre. **Ça se rouvre avec une
mesure, pas avec un avis** — et cette mesure est une condition de recette du lot,
pas une vérification de confort. Ce qui doit rester vrai : les deux aperçus ont
exactement la même hauteur rendue, à toute hauteur de fenêtre, et leur hauteur
vient d'une seule source.

### 3.4 Aucune action ne porte l'écran de clip

Un seul `variant="default"` sur tout l'écran : « Exporter ». « Publier » est en
`outline`, immédiatement à côté. « Régénérer », qui déclenche un appel LLM
facultatif, est plus haut et plus visible que les deux.

Et la barre d'app porte six contrôles — état d'enregistrement, Réessayer,
Annuler, Rétablir, Raccourcis, Paramètres — dont deux servent un undo qui ne
couvre qu'un tiers de l'écran (§3.1).

**Le geste.** Un seul bouton primaire, et il dépend de l'état du clip.

**Ce document affirmait que « l'empreinte de rendu sait déjà faire cette
distinction ». C'est faux**, vérifié le 23 août 2026 : les motifs que rend
`lFingerprintGap` (`render.ts:1093`) ne quittent jamais le serveur, et
`discardRenderStale` (`render.ts:2389`) efface les fichiers puis redescend le
clip de `exported` à `kept` — la péremption s'auto-efface.

Deux champs **déjà transmis** suffisent, et ils se croisent en trois cas :

| État | Condition | Primaire | Secondaire |
|---|---|---|---|
| jamais livré | `status !== 'exported'` et `mp4Url === null` | **Exporter** | — |
| périmé | `status === 'exported'` et `mp4Url === null` | **Ré-exporter** | — |
| livré, à jour | `mp4Url !== null` | **Publier** | Ré-exporter |

Le troisième cas est atteignable parce que la péremption est **paresseuse**,
posée par `deliveryToDay` (`src/server/renders.ts:162`) : un réglage global de
hook qui change annule les URL au prochain `GET` sans que `discardRenderStale`
soit passé, et `status` reste `exported`. Aucun changement d'API, ce que le §6
exige.

`alreadyDelivered` (`export-panel.tsx:126`) et `publicationEligibility.eligible`
(`:167`) sont deux dérivations distinctes du même fait : elles convergent vers un
seul état nommé, et la seconde disparaît.

« Publier » **disparaît** quand il n'est pas éligible, au lieu de rester grisé.
« Ré-exporter » ouvre de toute façon la confirmation d'écrasement
(`export-panel.tsx:361`) : un geste confirmé n'est jamais le primaire.
« Régénérer » redescend en `ghost`, à côté du champ qu'il remplit.

### 3.5 La carte de proposition dit trois fois son état, et cache ce qu'on vient y faire

`src/components/review/candidate-card.tsx`, huit à dix éléments par carte. Sur un
clip gardé, l'état « gardé » est dit trois fois : par le badge ambre en haut à
gauche, par le bouton « Gardé » ambre plein qui porte `aria-pressed` et par la
présence même du bouton « Monter », qui n'existe que pour les clips gardés.

Le bouton ambre plein **est l'état**, pas l'action. C'est pourtant lui qui a le
poids visuel du bouton primaire. Et « Écarter » garde un poids égal à « Garder »
sur une carte déjà gardée, alors que ce n'est plus la décision en cours.

« Monter » — la seule chose qu'on vient faire dans l'onglet « Gardés » — est le
plus discret des trois, et il est en dernier.

Multiplié : dans l'onglet « Gardés » de l'émission `2025-06-15-cqlp`, neuf cartes
portent chacune trois boutons dont deux ne servent pas la tâche. Vingt-sept
boutons pour neuf gestes.

**Le geste.** L'onglet change ce que la carte offre, parce qu'il change la tâche.

- « À trier » : Garder et Écarter dominants, c'est la décision du moment.
- « Gardés » : **Monter** dominant et seul. Le badge suffit à dire l'état, et
  « Écarter » repart en action secondaire — au survol, ou dans un menu.
- « Écartés » : « Garder » redevient la seule action, c'est le geste de retour.

La règle qui tient les trois : ce qui est déjà décidé se lit, ce qui reste à faire
se clique.

### 3.6 Quatorze réglages visuels du hook, réglés à l'aveugle

`/settings`, section « Hook » : police, taille, rayon des coins, position,
alignement, capitales, quatre couleurs, opacité du fond, durée, effet
d'apparition, effet de disparition. **Aucun aperçu.** On choisit une couleur de
fond et une opacité en lisant `#001979` et `100`.

Ce sont des réglages purement visuels, et le seul moyen d'en voir l'effet est
d'ouvrir un clip, dont les valeurs peuvent par ailleurs être surchargées — donc
de vérifier un défaut sur un cas qui ne l'utilise peut-être pas.

L'écran de clip rend déjà `HookOverlay` sur un canevas, à partir des mêmes
valeurs. Le composant existe, alimenté ailleurs.

**Le geste.** Un aperçu unique en tête de la section, collant au défilement, sur
une image fixe — n'importe quelle vignette de replay fait l'affaire, avec un
texte d'exemple. Quatorze nombres aveugles deviennent une boucle
regarder-corriger. C'est l'ajout le plus rentable des Paramètres, et le seul de
ce document qui ajoute quelque chose plutôt que d'en retirer.

## 4. Les constats mineurs, même famille

### 4.1 La prose permanente de l'écran de clip

Trois phrases sous les boutons de ratio — « Le fichier natif sort en 1:1… », « La
variante 9:16 pose chaque plan sur un canevas vertical… », « Le cadre est calculé
pour chaque plan… » — et une quatrième sous la case des marques. Elles sont
justes et elles s'apprennent une fois. Ensuite elles sont du bruit, sur chaque
clip. → dépliant, ou aide au survol de l'étiquette.

### 4.2 Le bandeau « Livraison » casse l'alignement

Mesuré : le `h2` « Image » commence à x = 463, « Contenu » à x = 1727,
« Livraison » à x = 16. Trois bords gauches pour trois titres de même niveau. Le
bandeau est pleine largeur avec son propre `max-w-[104rem]` interne, qui ne
retombe pas sur le conteneur du `main` au-dessus. L'œil le lit comme une autre
page. → aligner sur le même conteneur, ou assumer la rupture et lui donner un
fond.

### 4.3 La barre de sélection pousse la grille

Cocher un clip insère une bande d'environ 37 px entre l'en-tête et les onglets
(`feed.tsx:316-331`). Toutes les cartes descendent — y compris celle qu'on vient
de cocher, sous le curseur, au moment où l'on s'apprête à cocher la suivante. →
réserver la ligne, ou poser la barre en surimpression.

### 4.4 Les compteurs en double sur l'écran d'émission

« 10 à trier · 9 clips gardés · 5:12 au total » dans la ligne d'en-tête, et les
trois mêmes comptes en badges sur les onglets, deux lignes plus bas. La durée
totale n'est dite qu'une fois : elle reste. Le reste part.

### 4.5 Une carte par champ dans les Paramètres

Cinq boîtes bordées pour cinq nombres dans « Repérage », six pour « Hook »,
chacune avec son paragraphe d'aide toujours visible, dans une colonne de 48 rem
au milieu d'un écran de 2558 px. La page est très longue, sans navigation de
section, et les deux tiers de sa largeur sont vides. → grouper les champs par
boîte plutôt qu'une boîte par champ, démonter l'aide en dépliant ou en survol,
laisser la page prendre sa largeur.

L'encart d'estimation de « Repérage » — « pour une émission avec environ 90 min de
parole : ~15 à 23 clips demandés » — ne change pas. C'est le modèle : il fait
comprendre l'effet d'un réglage mieux que les cinq paragraphes au-dessus.

## 5. Transverse

Indépendants de la refonte, petits, chacun traitable seul.

| Point | Où | Effort |
|---|---|---|
| La bande de couverture ne répond qu'à la souris | `show/coverage-timeline.tsx:88-113` | S |
| `prefers-reduced-motion` nulle part | global | XS |
| Le thème sombre est écrit et jamais appliqué | `globals.css:100-135` | S |
| Pas de `h1` sur `/clips/:id`, pas de lien d'évitement | `clip-screen.tsx`, `app-bar.tsx` | XS |
| Pas de compteur sur l'application en lot des corrections | `show/transcript-panel.tsx:474-490` | S |
| `HookSection` montre des défauts pendant le chargement | `settings/settings-screen.tsx:142-146` | XS |

Deux méritent un mot.

**La bande de couverture.** Un `<div role="group">` avec `onClick` de seek, sans
`tabIndex`, et le commentaire refuse explicitement `role="button"`. C'est le
dispositif de navigation de l'écran d'émission — celui que la spec du 18 août
appelait à construire — et il est inatteignable au clavier. Pire : l'infobulle
riche qui porte la vignette, les timecodes, la durée et le statut n'apparaît
qu'au survol. Son contenu n'a donc **aucun** chemin clavier ni tactile. Le refus
du `role="button"` est défendable pour la bande entière ; les blocs de clip, eux,
sont des cibles nommées et devraient être focalisables.

**`HookSection` pendant le chargement.** Les trois autres sections des Paramètres
se remplacent par un squelette tant que `settings.data` est `undefined`. Celle-ci
rend `HOOK_DEFAULTS` en `inert` : des valeurs plausibles, lisibles et fausses.
Un `inert` empêche de les modifier, pas de les croire. C'est le même défaut de
famille que « un défaut prudent est faux face à une information ambiguë » —
ici l'information n'est pas ambiguë, elle est simplement absente, et l'écran
répond quand même.

## 6. Hors périmètre

Nommé pour que personne ne l'ajoute en chemin.

- Aucun changement de pipeline, de route API ou de schéma. Le §3.1 touche au store
  client, rien d'autre ne descend sous `src/components/`.
- Rien de la publication. Trois demandes du document du 18 août y restent
  ouvertes — les états par couple clip/plateforme, le badge « publié, mais
  modifié depuis », les effets `glitch` et `scanline` — et les deux premières
  attendent la même chose : une persistance et un connecteur, qui n'existent pas.
  L'interface est prête et testée à vide.
- Le cadrage automatique n'est pas concerné. Le §3.1 change **quand** un
  changement de cadre s'enregistre dans une pile, pas comment il se calcule ;
  la skill `.claude/skills/cadrage` reste la référence.
- Pas de refonte visuelle, pas de nouvelle palette, pas de nouveau composant de
  base. La palette à un seul accent — ambre pour ce qui est gardé, sélectionné,
  cadré — est une décision tenue, et les repondérations de ce document s'écrivent
  avec les variantes de bouton existantes.

## 7. Ordre de réalisation

Trois lots. Le premier peut partir seul, les deux autres se parallélisent.

**Lot 1 — ce qui fait perdre du travail.** §3.1, l'undo du cadrage. Petit, isolé
dans `src/store/editor.ts`, testable sans interface. Aucune raison de l'attendre.

**Lot 2 — l'écran de clip.** §3.3 l'ossature, puis §3.4 le bouton primaire, puis
§3.2 les textes de publication, puis §4.1 et §4.2. Dans cet ordre : l'ossature
décide où les autres atterrissent. Un seul agent, un seul fichier principal
(`clip-screen.tsx`) plus `export-panel.tsx`, `crop-picker.tsx` et
`hook-fields.tsx`.

L'ossature est le point cher : l'écran passe d'un `main` qui défile à deux volets
qui tiennent dans la fenêtre, et les aperçus cessent d'avoir une hauteur fixe.
La mesure de §3.3 se prend **avant** de toucher au reste — si l'égalité des deux
aperçus ne tient pas à hauteur variable, la forme retombe sur la lecture
verticale et le lot se replanifie.

**Lot 3 — l'écran d'émission et les Paramètres.** §3.5 les cartes par onglet,
§4.3, §4.4 ; puis §3.6 l'aperçu du hook et §4.5. Deux agents possibles, les
fichiers ne se croisent pas.

Le transverse (§5) se traite en marge, une entrée à la fois, par qui passe dans
le fichier.

## 8. Comment on saura que c'est fait

Pas une liste de cases : trois questions à poser devant l'écran rendu.

1. Sur `/clips/:id`, un inconnu peut-il dire en trois secondes ce qu'on vient y
   faire, et où cliquer pour le faire ? Deux relevés le disent sans discuter :
   l'écran ne défile plus (`document.scrollingElement.scrollHeight` vaut la
   hauteur de la fenêtre, et le `main` n'a plus de dépassement), et le primaire
   est l'élément interactif **le plus à droite** de la dernière ligne.
2. Dans l'onglet « Gardés », combien de boutons pour neuf clips ? Neuf est la
   bonne réponse.
3. `Ctrl+Z` après un déplacement du rectangle de cadrage : est-ce que le
   rectangle revient ?

Les mesures de la section 3 se reprennent de la même façon qu'elles ont été
prises — largeur des régions, position des `h2` — et elles doivent avoir bougé
dans le sens annoncé. Un chiffre qui n'a pas bougé est un lot qui n'a pas été
fait.
