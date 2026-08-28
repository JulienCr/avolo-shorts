# L'écran de clip : la forme arrêtée le 28 août

Date : 28 août 2026.
Statut : arrêté. Sept décisions tranchées sur fiche, six points déjà acquis.
Rien n'est implémenté à cette date ; la maquette est le seul artefact.

Ce document **remplace le §3.3 de
`docs/superpowers/specs/2026-08-23-hierarchie-ui-design.md`** — « l'établi » — et
amende son §8. Le reste de la spec du 23 août tient : le §3.4 sur le bouton
primaire, le §4.1 sur la prose permanente, le §3.1 sur l'undo du cadrage.

Il s'appuie sur deux maquettes croisées : `tmp/maquette-montage.html`, construite
ici sur les données réelles du clip
`2026-03-08-caro-mdlm_005472883-005518477`, et une maquette externe apportée par
Julien. Les chiffres cités se revérifient dans le DOM à 2560 × 1320, et c'est
leur seul intérêt.

## 1. Pourquoi l'établi ne tenait pas

L'établi avait raison sur l'ossature — deux volets, pas de défilement — et tort
sur la répartition. Sa règle centrale, « les deux aperçus ont exactement la même
hauteur, depuis une source unique » (`PREVIEW_FRAME`, `clip-screen.tsx:77`),
traitait la source 16:9 et la sortie 9:16 comme deux vues équivalentes du même
clip. Elles ne le sont pas.

La source est un **instrument** : on y règle un cadre. La sortie est le
**produit** : c'est le fichier qu'on publie. Leur donner la même hauteur revient
à donner au 9:16 la moitié de la largeur d'un 16:9 de même hauteur, soit
296 × 526 mesurés — contre 935 × 526 pour l'instrument. L'écran montrait
l'outil trois fois plus grand que l'ouvrage.

**Cette règle est donc annulée.** Les deux aperçus n'ont plus la même hauteur,
et `PREVIEW_FRAME` disparaît en tant que source unique.

## 2. La tâche, en une phrase

Vérifier ce que le clip donne, corriger son cadre et ses bornes, le livrer.

Le titre, la description et le hook sont éditoriaux : on les écrit une fois. Ils
restent visibles, ils ne dominent pas.

Une phrase de plus, qui n'est pas une tâche mais une contrainte de forme :
**le produit tire des 9:16 d'une émission 16:9, et ça doit paraître magique.**
La mécanique du cadrage — le ratio résolu par plan, la composition détectée, le
repli du calcul automatique — ne s'expose pas en permanence. Ce qui se dessine
sur l'image reste ; ce qui s'écrit à côté part.

## 3. La forme

Deux écrans, atteints par des onglets dans la barre d'app : **Édition** et
**Exports**. L'écran d'édition tient dans la fenêtre et ne défile pas.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ caro mdlm / Macron × Voldemort  [ Édition | Exports ]  enr. ⤺ ⤻  ▸Publier │
├──────────────────────────────────────────────────────────────────────────┤
│ ▭ ▮ ▭ ▭ ▭ ▭                                                       ‹  ›   │
├─────────────────────────────────┬────────────────────┬───────────────────┤
│                                 │ Titre              │                   │
│    SOURCE 16:9   1322 × 744     │ Description        │   SORTIE 9:16     │
│    + cadre de sélection         │ Hook            ✨ │    600 × 1067     │
│                                 │ Badge      ⋯ plus  │                   │
├─────────────────────────────────┴────────────────────┤                   │
│ [◷ Temps | ❞ Mots]                     plan 3 sur 7  │                   │
│ ▓▒▓▒▓▓▒▓▒▓▓▒  ruban de 12 vues                       │                   │
│ A╞═════╡ ✂2,4s ╞═══════════╡ ✂1,1s ╞════════╡B       │                   │
│ 1:31:12 ⌨   →   1:32:03 ⌨          0:50 · 2 coupes   │  ◉ Aperçu ○ Export│
└──────────────────────────────────────────────────────┴───────────────────┘
```

Mesuré à 2560 × 1320, sur la maquette, contre l'écran rendu au commit `9361cb7` :

| Région | Aujourd'hui | Arrêté | Facteur |
|---|---|---|---|
| sortie 9:16 | 296 × 526 | **600 × 1067** | ×4,1 en surface |
| source 16:9 | 935 × 526 | **1322 × 744** | ×2,0 |
| bande de temps | ~1200 px | **1912 px** | ×1,6 |
| fiche éditoriale | 480 px | 574 px | ×1,2 |

Ces chiffres supposent le rail du bas supprimé et le primaire monté dans la
barre d'app (§4.7) : les soixante pixels qu'il occupait vont à la hauteur du
volet, donc à la sortie. Avec le rail, la sortie retombe à 570 × 1013.

La fiche va **à droite de la source**, dans le volet gauche, et non sous la
sortie. Deux raisons mesurées : une sortie 9:16 pleine hauteur laisse 1912 px au
volet gauche, dont un 16:9 n'occupe que 1322 — les 574 restants étaient le vide
permanent que le §3.3 de la spec du 23 août avait déjà relevé sous une autre
forme (« 557 px vides, en permanence ») ; et le hook s'incruste dans l'image,
donc son champ doit être visible en même temps qu'elle.

Le volet gauche ne défile pas : à 2560 × 1320 il dispose de 1109 px, dont 744
pour la source, ce qui laisse 365 px à la bande, aux champs de bornes et aux
outils réunis — la bande mesurée en fait 161. **C'est la contrainte qui cadre
toutes les décisions de la section 4.**

## 4. Les sept décisions

### 4.1 Deux modes pairs, `◷ Temps | ❞ Mots`

Un commutateur au-dessus de la bande. En mode Mots, le ruban de mots prend la
place de la piste ; le tiroir « Modifier le montage » disparaît du cas courant.

Ce n'est pas une nouvelle fonction. `src/store/editor.ts` porte un seul modèle —
une liste de segments — et `setBoundaryAt` (le temps) comme `poserBound` (les
mots) écrivent la même chose et empilent le même point d'annulation. Les deux
modes sont **une fonction avec deux viseurs**, ce qui est la condition pour que
le commutateur ne mente pas.

Ça ferme une ambiguïté que le dépôt traînait : le `CLAUDE.md` décide que « la
surface d'édition est le transcript, pas une timeline multi-pistes », et
`docs/lessons.md` a dû préciser depuis que la bande de temps et le transcript
coexistent. Deux modes nommés valent mieux qu'une note de bas de page.

Les deux surfaces visibles **en même temps** ont été écartées faute de hauteur :
365 px portent une piste de 64 px, sa voie de plans, ses champs de bornes et une
ligne d'outils — pas en plus un ruban de mots, qui en réclame une centaine.

### 4.2 Un ruban de douze vues dans la piste

Une route rend une planche 1920 × 90 depuis le proxy ; le client la pose en fond
de piste. La bande cesse de dire seulement *où* on est pour dire *quoi*.

Mesure du 28 août 2026, trois passes sur le clip Macron (50,5 s), `loadavg`
relevé à 3,41 : **0,45 / 0,44 / 0,43 s, médiane 0,44 s**, pour une planche
`tile=12x1` de **43 Ko**. Commande :
`ffmpeg -ss … -vf "fps=12/50.5,scale=160:90,tile=12x1"` sur le proxy 960 × 540.

Le proxy est déjà servi en requêtes partielles par `api/projects/[id]/proxy` et
les vignettes de clip par `api/clips/[id]/thumb` : la route de planche suit le
même patron, et le graphe par présence de fichier sait déjà l'invalider.

Sur cette machine un écart inférieur à ~10 % n'est pas établi (40 à 80 % de
variance). Ce n'est donc pas un arbitrage de performance entre deux options :
c'est un coût absolu, et il est petit.

### 4.3 Poignées franches **et** champs de timecode

La poignée pour approcher, le champ pour poser à l'image près, le clavier pour
corriger. Les champs vont **en bas à gauche** de la bande.

Le clavier existe déjà : `timeline.tsx:522` fait ±1/30 s, et ±0,5 s avec Maj, sur
une oreille focalisée, et `clampEdge` interdit le croisement via `MIN_DURATION`.
Un champ n'ajoute pas de logique, il ajoute une entrée.

**Le champ affiche `clipBounds`, jamais la valeur demandée.** `clipBounds`
(`src/lib/editing.ts:205`) rend les bornes *après* normalisation : afficher la
demande ferait mentir le champ dès que la valeur tombe dans un passage retiré.

Ça règle aussi un défaut que le dézoom ne réglait qu'à moitié : la fenêtre de la
bande vaut bornes ± 3 s (`CONTEXT_SECONDS`, `timeline.tsx:49`), donc reculer A de
dix secondes demande aujourd'hui de tirer jusqu'au bord et d'attendre.

**Le composant existant est repris, pas réécrit.** `src/components/clip/timeline.tsx`
porte ce qui est cher et juste — un seul point d'annulation par geste
(`commit`, `timeline.tsx:167`), la fenêtre figée pendant un glissé, le
non-accrochage délibéré aux mots (`timeline.tsx:31`), la vignette de survol à
une seule requête en vol (`useFramePreview`, `timeline.tsx:571`). Ce qui change
est sa peau, son ruban et ses champs.

### 4.4 Deux familles de glyphes, jamais une seule

La coupe est une **encoche hachurée qui porte sa durée**. Le changement de plan
est un **repère fin, sans étiquette**.

Une coupe est un passage que quelqu'un a retiré, et ça se défait. Une frontière
de plan est un cadrage que l'analyse a trouvé, et ça ne se défait pas. Leur
donner le même trait promet une action qui n'existe pas.

Deux relevés cadrent les tailles respectives. Aucun clip du dépôt n'a plus d'un
segment (vérifié le 28 août sur les huit émissions de `projects/`) : les coupes
sont rares, donc quand il y en a une, elle doit se voir — un creux nu se lit
comme une absence, pas comme une décision. Les plans, eux, sont nombreux : sept
sur le clip Macron pour 50 s, trois sur un clip de 26 s. Sept étiquettes
permanentes, ce serait la mécanique exposée que la section 2 écarte.

La skill `cadrage` documente que le cadre est **fixe à l'intérieur d'un plan** :
le repère de plan sert à comprendre pourquoi l'image saute, pas à agir dessus.
Il n'a donc pas besoin d'un nom.

### 4.5 La géométrie se dessine, la prose disparaît

Sur la source, **les cadres de sélection restent** : le rectangle quand il y en
a un, les cellules de la composition quand le plan en porte une. Ce qui part,
c'est le texte qui explique pourquoi.

La frontière est là, et elle est nette : un trait sur l'image montre ce qui sera
pris, un paragraphe à côté expose la mécanique. Le premier sert la tâche à
chaque clip, le second s'apprend une fois puis devient du bruit — ce que le §4.1
de la spec du 23 août avait déjà tranché sans que ce soit fait.

Partent donc : « Comment chaque sortie se comporte » (`crop-picker.tsx:399`),
« Repli du cadrage automatique » (`:451`), la phrase sur le doublage improvisé
(`:50`), la ligne résolue « auto → 4:5 sur ce plan · natif 16:9 » (`:374`),
« Montage doublage — 7 plans » (`framing-fields.tsx:94`) et le `<dl>` des faits
de montage (`clip-screen.tsx:604`), dont les quatre valeurs reviennent sous la
bande en une ligne.

Le sélecteur de ratio se réduit à `auto`, avec un déclencheur discret pour
forcer un cadrage. Le forçage reste possible ; il cesse d'être offert.

**Un point de friction, et il est écrit dans le code.** `crop-picker.tsx:384-390`
porte un commentaire qui *interdit explicitement* de masquer la ligne « Fichier
natif 16:9 · Variante 9:16 sur fond flouté », restaurée après une séance
d'usage. Cette ligne-là est **épargnée** : elle dit ce que le clip produit, pas
comment le cadrage y est arrivé. Le commentaire reste vrai et ne se réécrit pas.

### 4.6 L'aperçu compose le doublage

`paintOutput` (`output-preview.tsx:68`) ne connaissait que `split`, jamais
`dubbing`, alors que le rendu compose la mise en page depuis le commit `80697f7`.
Sur un clip de doublage, le viseur montrait autre chose que le fichier.

**C'est traité par la PR #270** (`feat/dubbing-preview`, +418/−47, ouverte au
28 août), qui étend `paintOutput`, dessine les cellules dans `CropOverlay` et
met la skill `cadrage` à jour.

Cette PR touche `output-preview.tsx`, `crop-picker.tsx` et `clip-screen.tsx` —
les trois fichiers que cette refonte réécrit. **Elle passe d'abord ; la refonte
se rebase dessus.** Fusionner dans l'autre sens ferait perdre la composition ou
la refonte, en silence, puisque git n'y verrait pas de conflit.

Une conséquence à ne pas manquer : multiplier la surface du viseur par 3,7 sans
cette PR aurait multiplié l'écart d'autant. C'était la seule décision de la
fiche dont le coût augmentait avec le report.

### 4.7 Le geste terminal monte en haut à droite

`Exporter` / `Ré-exporter` / `Publier` selon l'état, à côté des onglets
`Édition | Exports`. Le rail du bas disparaît, et ses 60 px vont à la bande.

L'argument de la diagonale du regard — l'œil entre en haut à gauche et sort en
bas à droite — supposait un écran qui se lit une fois, de haut en bas. Avec deux
onglets, la livraison devient un **lieu**, et son bouton appartient au même
endroit que son onglet.

Le §3.4 de la spec du 23 août tient sans changement : le primaire dépend de
l'état, « Publier » **disparaît** quand il n'est pas éligible au lieu de rester
grisé, et « une vidéo rendue » se lit `mp4Url !== null || variant9x16Url !== null`.

**En revanche, le §8 de cette même spec est amendé.** Son critère de recette
« le primaire est l'élément interactif le plus à droite de la dernière ligne »
devient : *le primaire est l'élément interactif le plus à droite de la première
ligne, et il n'en existe qu'un sur l'écran*. Le critère « l'écran ne défile
plus » reste inchangé.

## 5. Ce qui est acquis et ne se rediscute pas

- **Les onglets `Édition | Exports` vivent dans la barre d'app.** Les autres
  écrans héritent de la nouvelle barre sans changer de contenu.
- **L'historique d'export est préparé à vide.** Le dépôt ne conserve aucune
  version : quatre tables (`projects`, `clips`, `settings`, `publications`),
  aucune pour les rendus, des fichiers nommés par l'identifiant du clip donc
  écrasés à chaque export, et `discardRenderStale` qui les efface. L'écran
  Exports montre donc **une** entrée — la livraison courante — et la place pour
  les suivantes, comme la publication a été préparée à vide avant ses
  connecteurs. Conserver des versions est une décision ultérieure, avec sa
  rétention : 39 Mo pour une minute de 9:16.
- **Le viseur montre l'aperçu vivant par défaut**, et bascule vers le fichier
  rendu au même emplacement et à la même taille. La bascule `Export` **n'existe
  pas** quand rien n'a été livré, au lieu d'être grisée.
- **La fresque des clips reste en haut**, navigation entre clips inchangée.

## 6. Les options avancées passent en modale

Le style du hook (quatorze réglages), le pied de page, les réglages du rendu —
incrustation des marques et des sous-titres —, les cinq nombres du montage
doublage : tout ça s'utilise rarement et occupe en permanence. Chacun derrière
un petit déclencheur près du champ qu'il complète, ouvrant une modale.

C'est le seul emploi de modale de cet écran, et il est justifié : un réglage
qu'on ouvre, qu'on ajuste et qu'on ferme est une interaction bloquante par
nature. Le montage et la fiche, eux, ne sont jamais dans une modale.

## 7. Hors périmètre

- **La navigation globale.** Le chantier va jusqu'à la barre d'app ; la
  bibliothèque, l'écran d'émission, le planning et les paramètres gardent leur
  contenu.
- **Le cadrage automatique.** Rien ici ne change *quel* ratio ni *quel* crop est
  calculé. La skill `.claude/skills/cadrage` reste la référence.
- **Le pipeline, les routes existantes, le schéma.** Une seule route neuve : la
  planche du ruban (§4.2).
- **La publication.** Les états par couple clip/plateforme et le badge « publié,
  mais modifié depuis » attendent toujours une persistance et un connecteur.
- **Conserver plusieurs versions de rendu** (§5).

## 8. Ordre de réalisation

**Lot 0 — la PR #270 fusionne.** Rien ne commence avant, sous peine de perdre la
composition du doublage dans un merge sans conflit (§4.6).

**Lot 1 — l'ossature.** Les onglets dans la barre d'app, les deux volets, la
fiche à droite de la source, le primaire en haut. C'est le lot cher : il décide
où tout le reste atterrit. `clip-screen.tsx` (849 l), `app-bar.tsx`,
`export-panel.tsx` (719 l).

**Lot 2 — la bande.** Les deux modes, le ruban, les poignées et les champs, les
deux familles de glyphes. `timeline.tsx` (695 l), `transcript-surface.tsx`
(527 l), plus la route de planche. Se parallélise mal avec le lot 1 : les deux
touchent la hauteur du volet gauche.

**Lot 3 — la soustraction.** Les textes qui partent, le sélecteur réduit, les
modales des options avancées. `crop-picker.tsx`, `framing-fields.tsx`,
`hook-fields.tsx` (790 l).

Les vingt et un fichiers de `tests/components/clip/` affirment les libellés
supprimés : ils se déplacent avec le lot qui les casse, jamais après.

## 9. Comment on saura que c'est fait

Trois relevés et deux questions, devant l'écran rendu, à 2560 × 1320.

1. `document.scrollingElement.scrollHeight` vaut la hauteur de la fenêtre, et le
   `main` ne déborde pas. Inchangé depuis le 23 août.
2. La sortie 9:16 mesure au moins 560 px de large — la maquette en donne 600.
   Elle en fait 296 aujourd'hui ; un chiffre qui n'a pas bougé est un lot qui
   n'a pas été fait.
3. Il existe **un seul** `variant="default"` sur l'écran, et c'est l'élément
   interactif le plus à droite de la première ligne.
4. Sur un clip de doublage, l'image du viseur et une image du fichier rendu au
   même instant se superposent. C'est la recette de la PR #270, reprise ici
   parce que la refonte peut la casser.
5. Un inconnu peut-il dire en trois secondes ce qu'on vient faire sur cet écran,
   et où cliquer pour le faire ?
