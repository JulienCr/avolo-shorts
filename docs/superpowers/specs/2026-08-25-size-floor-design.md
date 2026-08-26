# Le plancher de taille

Conception arrêtée le 25 août 2026, extraite de celle du split-screen
(`docs/superpowers/specs/2026-08-25-split-screen-design.md`) parce que ce
plancher part dans sa **propre PR, avant le split** (#177, fusionnée) : il
change ce que « deux personnes » veut dire, donc le déclencheur du split doit
être mesuré après lui.

## Le problème mesuré

Le détecteur pose une boîte de personne sur les visages imprimés. Sur `nabla`
à 984,0 s, une jaquette de DVD reçoit sa boîte, tête comprise, avec une
frontalité de 0,95 — **plus haute que celle des deux vrais comédiens** (0,87 et
0,16). La frontalité ne les sépare pas ; la taille à l'écran le fait : la
jaquette fait 0,384 de hauteur visible contre 0,935 et 0,729 pour les deux
comédiens. Sur les 160 202 boîtes retenues des cinq projets, la médiane vaut
0,805 et le premier décile 0,399 : la jaquette est plus petite que 91 % du
corpus.

## La décision

**Le plancher est relatif à l'image, pas absolu.** Une boîte nettement plus
petite que la plus haute de sa propre image ne compte pas comme quelqu'un à
cadrer. Un plancher absolu poserait le même seuil sur un comédien au fond du
plateau, qui est petit pour une raison légitime.

Il **déplace le fichier natif** sur les plans à affiche, ce qui est voulu : il
ne dit pas « ne cadre pas sur cette personne », il dit « ce n'est pas une
personne », comme `isForeground` le fait déjà pour le public au premier rang.

Sa valeur par défaut, `0,5` (`FRAMING_DEFAULTS.sizeFloor`), vient d'un
balayage, quantifié dans le corps de la PR #177.
