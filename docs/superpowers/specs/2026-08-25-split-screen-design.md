# Le split-screen : deux personnes, deux cases

Conception arrêtée le 25 août 2026. Elle remplace le comportement que la
PR #176 portait — écarter la personne de profil — sur la même branche et à
partir de la même règle de détection.

## Ce qu'on construit

Dans un plan à deux personnes, la variante 9:16 cesse de poser un cadre unique
avec du fond flouté autour. Elle pose **deux cellules empilées**, une personne
par cellule, chacune remplissant la moitié du canevas vertical.

Le fichier natif ne change pas : il garde son ratio unique et sa position de
crop, et il ignore l'existence du split.

## Pourquoi le déclencheur ne se déduit pas d'une mesure

Le propriétaire du dépôt a jugé trois plans sur images le 25 août. Il a demandé
le split sur deux d'entre eux et accepté le recadrage sur une seule personne sur
le troisième. Aucun signal du corpus ne reproduit ce partage.

| Plan | Frontalité du gagnant | Frontalité du perdant | Écart | « Ils se font face » | Jugement |
|---|---|---|---|---|---|
| `nabla` 1439,4 s | 0,70 à 0,85 | 0,18 à 0,20 | 0,50 | 79 % | split |
| `cqlp` 2096,0 s | 0,86 à 0,92 | 0,03 à 0,06 | 0,81 | 0 % | split |
| `entre-nous` 1494,9 s | 0,63 à 0,87 | 0,19 à 0,22 | 0,59 | **83 %** | recadrage accepté |

Les deux premières colonnes ne séparent rien : le plan qui doit se splitter et
celui qui ne le doit pas donnent la même frontalité de gagnant. L'écart ne range
pas mieux — 0,50 puis 0,81 puis 0,59, quand il faudrait couper entre les deux
premiers et le troisième.

Le `side` d'`orientationOf` était la piste la plus prometteuse, puisqu'il dit
vers où quelqu'un est tourné. Il échoue autrement : il range `nabla` avec
`entre-nous` (79 % contre 83 %) et isole `cqlp` tout seul, soit exactement
l'inverse du regroupement demandé.

**Le split s'applique donc partout où il est géométriquement utile**, sans
chercher à deviner l'intention de la scène. C'est la seule règle qui n'invente
pas un critère que la mesure ne soutient pas.

Conséquence, mesurée avant d'être acceptée : le split devient le format dominant
de la sortie verticale.

| Émission | Montage en split | dont 16:9 | dont 1:1 | dont 4:5 |
|---|---|---|---|---|
| `nabla` | 83,9 % | 64,5 % | 11,6 % | 7,9 % |
| `entre-nous` | 82,0 % | 44,4 % | 35,3 % | 2,4 % |
| `cqlp` | 72,6 % | 19,0 % | 40,0 % | 13,6 % |
| `caro-mdlm` | 43,6 % | 34,7 % | 8,9 % | — |
| `fmr` | 0 % | — | — | — |

`fmr` ne rend rien parce que 94,2 % de son montage tient dans des plans qui ne
portent pas deux personnes.

## Le déclencheur

Un plan passe en split si les trois conditions tiennent :

1. il dure **au moins 4 secondes** ;
2. son **image médiane porte exactement deux personnes retenues** — retenues au
   sens de `spans()`, donc au-dessus du seuil de confiance et hors du filtre du
   premier plan ;
3. son ratio courant est **plus large que le 9:16**. Un plan déjà vertical
   remplit le canevas, et le couper en deux ne gagnerait rien.

Les quatre conditions de la PR #176 — écart décisif, part de 90 %, gagnant
constant, perdante jamais `unknown` — **disparaissent du déclencheur**. Elles
servaient à désigner qui écarter, et le split n'écarte personne. `orientationOf`
survit, mais réduit à son seul `side` : c'est lui qui décide de l'ordre des
deux cellules, jamais `frontality`.

La deuxième condition se juge sur l'image médiane et non image par image, parce
que le crop est fixe à l'intérieur d'un plan (spec §10). Un plan dont l'effectif
varie garde donc son cadrage actuel plutôt que de changer de composition en
cours de route.

## Ce qu'un plan produit

`ShotFraming` gagne un champ optionnel :

```
split?: [Cell, Cell]
Cell = { x0: number; y0: number; x1: number; y1: number }   // fractions de la source
```

Un champ optionnel, et non une union discriminée. Le natif et tous les lecteurs
de `ratio` et de `cropXNative` continuent de fonctionner sans savoir que le
split existe — c'est ce qui garantit qu'aucun d'eux ne se déplace.

Une cellule porte ses quatre bornes et non une seule abscisse. `cropX` suffisait
parce que le crop prend toute la hauteur ; une cellule n'en prend que la moitié,
donc son ordonnée est une décision à part entière.

## La géométrie

Le canevas vertical fait 1080 × 1920. Chaque cellule fait **1080 × 960**, soit
un rapport de 1,125.

**La cellule cadre serré** : le tronc de sa personne, plus une fois sa largeur
de part et d'autre — donc trois fois la largeur du tronc au total. Un plancher
de largeur l'accompagne, faute de quoi un tronc étroit produirait un
grossissement absurde ; les maquettes l'ont posé à 60 % de la largeur d'une
cellule pleine hauteur, et il reste à balayer. Le cadrage large — prendre toute la hauteur de la source — a
été essayé et rejeté sur image. Il ne s'agit pas d'un réglage à corriger mais
d'une impossibilité arithmétique : une cellule de rapport 1,125 prise sur toute
la hauteur d'une source 1920 × 1080 mesure 1215 pixels de large, donc deux
cellules en réclament 2430 quand la source n'en a que 1920. Elles se recouvrent
nécessairement, et le recouvrement se voit — sur `nabla` à 1440 s il atteint
441 pixels, et le bras d'un comédien apparaît dans la cellule de l'autre.

**Les yeux se posent au tiers supérieur de leur cellule.** La hauteur d'œil se
lit dans les points COCO — les deux yeux quand ils sont confiants, le nez à
défaut, le haut de la boîte en dernier recours. Elle se prend en **médiane sur
le plan** et non image par image, puisque la cellule est fixe pour toute sa
durée.

Sans cette règle, la cellule se centre sur l'image et coupe les têtes : c'est ce
que les premières maquettes ont montré.

## L'ordre des deux cellules

**Celui qui regarde à droite va en haut**, lu dans le `side` d'`orientationOf`.

Le regard départage sur 66 à 91 % des images selon l'émission, en médiane par
plan. Le sens se fixe donc **par majorité sur le plan**, comme la condition du
gagnant constant le faisait, et jamais image par image : deux cellules qui
s'échangeraient en cours de plan produiraient un saut bien plus visible qu'un
déplacement de crop.

Quand les deux regardent du même côté, ou qu'aucun `side` n'est déterminé, la
personne de gauche va en haut. Le plan `cqlp` tombe précisément dans ce cas :
l'homme de droite sort à `side` nul, ses deux oreilles étant vues avec la même
confiance.

## Ce que la chaîne doit apprendre

| Étage | Ce qui change |
|---|---|
| `src/core/framing.ts` | le déclencheur, les deux cellules, l'ordre |
| `src/core/shot-split.ts` | l'égalité de fusion des morceaux doit comparer les cellules |
| `src/core/ffmpeg/args.ts` | une entrée splittée devient `split` → deux `crop`/`scale` → `vstack` |
| `src/server/steps/render.ts` | `RenderedFraming` porte les cellules, `VERSION_FINGERPRINT` s'incrémente |

Le point le plus facile à manquer est le deuxième. `splitByShot` fusionne deux
morceaux adjacents dont le ratio et les deux positions de crop coïncident, et
cette fusion est ce qui évite d'ouvrir un décodeur par frontière. Sans les
cellules dans la comparaison, deux plans splittés différemment fusionneraient en
un seul, et le second perdrait son cadrage sans que rien ne le signale.

`VERSION_FINGERPRINT` s'incrémente parce que les empreintes existantes ne
portent pas de cellules : elles ne peuvent donc pas dire qu'un rendu splitté est
périmé. C'est le même geste que pour `captionsContent` en août.

## Le plancher de taille, et pourquoi il passe en premier

Le détecteur pose une boîte de personne sur les visages imprimés. Sur `nabla` à
988,5 s, une jaquette de DVD reçoit sa boîte, tête comprise, avec une frontalité
de 0,96 — **plus haute que celle des deux vrais comédiens**.

La taille à l'écran les sépare là où la frontalité échoue. Sur l'image mesurée,
la jaquette fait 0,384 de hauteur visible quand les deux comédiens font 0,935 et
0,729. Sur les 160 202 boîtes retenues des cinq projets, la médiane vaut 0,805
et le premier décile 0,399 : la jaquette est plus petite que 91 % du corpus.

**Le plancher est relatif à l'image, pas absolu.** Une boîte nettement plus
petite que la plus haute de sa propre image ne compte pas comme quelqu'un à
cadrer. Un plancher absolu poserait le même seuil sur un comédien au fond du
plateau, qui est petit pour une raison légitime. Le relatif sépare plus
franchement sur le cas connu : 41 % de la plus haute pour la jaquette, contre
78 % entre les deux comédiens.

Ce plancher part dans sa **propre PR, avant le split**, pour deux raisons. Il
change ce que « deux personnes » veut dire, donc le déclencheur du split doit
être mesuré après lui. Et il **déplace le fichier natif** sur les plans à
affiche, contrairement à tout le reste de cette conception : il ne dit pas « ne
cadre pas sur cette personne », il dit « ce n'est pas une personne », comme
`isForeground` le fait déjà pour le public au premier rang.

Sa valeur exacte demande un balayage, comme celui qui a fixé le rognage latéral.
Cette conception arrête la forme de la règle, pas son seuil.

## Ce qui reste ouvert

- **Le rythme.** Trois émissions sur cinq passeraient à plus de 70 % de split.
  Personne n'a encore regardé une minute entière de cette sortie avec le son. Le
  point d'arrêt qui compte est une vidéo, pas une image fixe.
- **Le 4:5.** Il représente 2,4 à 13,6 % du montage selon l'émission, et aucun
  plan 4:5 n'a été soumis au jugement. Il est inclus par cohérence avec le 1:1,
  qui l'a été.
- **Le croisement des comédiens.** Rien ne suit une identité d'une image à
  l'autre. Deux personnes qui se croisent échangent leurs rangs, et la majorité
  par plan fixe alors un ordre arbitraire pour toute la durée.
- **Les sous-titres et le hook.** Ils s'incrustent sur le canevas composé, donc
  après le `vstack`, et rien dans cette conception ne les déplace. Reste à
  vérifier à l'image qu'un carton posé au milieu du canevas ne tombe pas
  exactement sur la couture entre les deux cellules.

## Ce que la PR #176 garde

La règle de détection, la section 7 de `scripts/measure-ratios.ts`, le contrôle
mécanique que le natif ne bouge pas, les drapeaux `--split-off` et `--instant`
de `scripts/framing-thumbnails.ts`. Plus douze tests vérifiés rouges sans leur
correctif. `orientationOf` passe du rôle de juge à celui d'ordonnateur, réduit
à son `side` ; tout le reste sert à l'identique.
