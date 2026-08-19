# Le ratio par clip, sur trois émissions

Mesuré le 18 août 2026, sur `2025-06-15-cqlp`, `2026-03-08-caro-mdlm` et
`2026-22-02-entre-nous`. Reproductible par `scripts/mesure-ratios.ts`,
`scripts/vignettes-premier-plan.ts` et `scripts/vignettes-cadrage.ts`.

`2026-22-02-entre-nous` **porte bien un mois 22**, et ce n'est pas une faute de
frappe de cette page : le fichier s'appelle ainsi sur le Drive, l'identifiant de
projet se déduit du nom de fichier, et c'est donc celui qu'il faut taper pour
reproduire. Le « corriger » ici ferait échouer toutes les commandes qui suivent.
Le jour et le mois y sont vraisemblablement transposés — le dossier des replays
porte par ailleurs un `2026-01-18-entre-nous.mp4`, qui est une autre émission —,
mais c'est au fichier d'être renommé, pas à la mesure.

## La question

Le cadrage automatique choisit **un ratio par clip** : le plus petit dont un crop
fixe par plan cadre 90 % des images. Sur `2025-06-15-cqlp`, tous les clips
sortaient en 16:9 — avant comme après le filtre du public au premier plan, qui
écarte pourtant 33,8 % des boîtes de cette émission.

Deux explications coexistaient, et elles n'appellent pas la même suite :

1. **`cqlp` est le pire cas connu.** Elle porte un panneau de chat Twitch sur
   environ 20 % de la largeur et elle est la seule des vingt émissions dans ce
   cas ; la §10 de la conception annonçait déjà que « qui cadrera `cqlp` verra ses
   ratios monter sans que l'algorithme ait un défaut ».
2. **Ou le ratio par clip est large partout**, auquel cas l'itération 1
   construirait une mécanique de crop par plan qui ne se déclenche jamais : à 16:9
   sur une source 16:9, un crop couvre toute la largeur et n'a rien à placer.

Personne n'avait mesuré la répartition des ratios par clip sur une émission sans
chat incrusté.

## La réponse

**Non. Le ratio ne descend pas sous le 16:9 sur une émission sans chat
incrusté.** Et le résultat va plus loin que ça : `cqlp`, l'émission qu'on croyait
être le pire cas, est **la moins large des trois**.

**Clips issus du repérage seuls** — la population du produit :

| | `cqlp` | `caro-mdlm` | `entre-nous` |
|---|---|---|---|
| clips en 9:16 | 0 | 0 | 0 |
| clips en 4:5 | 0 | 0 | 0 |
| clips en 1:1 | **2** | 0 | 0 |
| clips en 16:9 | 6 | 6 | 6 |
| **total** | **8** | **6** | **6** |
| chat Twitch incrusté | oui, par intermittence | non | non |
| boîtes de premier plan | 33,8 % | 1,8 % | 0,1 % |

**Trois clips de la base de `cqlp` sont écartés de ce tableau, et il faut dire
lesquels**, sinon le compte de `scripts/mesure-ratios.ts` — qui en affiche dix —
paraît contredire celui-ci :

- deux **vestiges de vérification** (`clip_verif_1to1`, `clip_verif_auto`, voir
  « Vestiges à nettoyer » dans `ROADMAP.md`). Tous deux sortent en 16:9, et l'un
  d'eux ne porte **aucune** image mesurée : le ratio le plus large y est le
  comportement voulu d'un clip qu'aucune détection ne renseigne, pas un résultat ;
- un clip `discarded`, qui ne sera jamais rendu. Une lecture qui l'inclut trouve
  un 1:1 de plus à la marge par défaut et un 4:5 de plus à marge nulle — c'est ce
  seul clip, et rien d'autre, qui sépare les deux comptages.

Le script ne les filtre pas de lui-même : mettre une convention de nommage dans un
script de mesure la ferait se périmer sans bruit. Il les nomme, ligne par ligne.

Dix ou six clips ne font pas une distribution — ce sont les moments que le
repérage a retenus, pas un échantillon de l'émission. Des fenêtres de 30 s
prises toutes les 30 s couvrent l'émission entière et disent ce qu'un clip
*quelconque* deviendrait :

| | `cqlp` | `caro-mdlm` | `entre-nous` |
|---|---|---|---|
| 9:16 | 1 | 3 | 5 |
| 4:5 | 19 | 1 | 3 |
| 1:1 | 29 | 1 | 11 |
| 16:9 | 148 | 334 | 208 |
| total | 197 | 339 | 227 |
| **part sous le 16:9** | **25 %** | **1 %** | **8 %** |

C'est le tableau qui décide, et il dit l'inverse de ce qu'on attendait :
l'émission au chat incrusté est celle qui laisse le plus de place au cadrage.

## L'empan résiduel, qui explique le reste

Un crop pleine hauteur couvre `0,316` de la largeur en 9:16, `0,450` en 4:5,
`0,5625` en 1:1. L'empan résiduel — la largeur qu'il faut pour contenir tout le
monde, filtre du premier plan appliqué et marge comprise — se lit à côté :

| Empan des images des clips | `cqlp` | `caro-mdlm` | `entre-nous` |
|---|---|---|---|
| médian | 0,551 | 0,778 | 0,614 |
| p90 | 0,698 | 0,998 | 0,769 |

Le seuil du 1:1 est à 0,5625. `cqlp` passe juste dessous en médiane, les deux
autres sont loin au-dessus — et `caro-mdlm` sature : à p90, l'empan vaut **toute
la largeur de l'image**.

Par image et sur l'émission entière, filtre actif (`scripts/mesure-premier-plan.ts`),
la part qui tient dans chaque ratio confirme l'ordre :

| | `cqlp` | `caro-mdlm` | `entre-nous` |
|---|---|---|---|
| tient dans un 9:16 | 4,2 % | 4,5 % | 15,7 % |
| tient dans un 4:5 | 36,2 % | 9,4 % | 29,2 % |
| tient dans un 1:1 | 60,1 % | 15,6 % | 42,2 % |
| empan médian par image | 0,520 | 0,742 | 0,589 |

Le même ordre qu'en clips, et le même renversement : `cqlp` est la moins large,
`caro-mdlm` la plus large de loin — une image sur six seulement y tient dans un
1:1.

**Ces trois colonnes sont prises à la marge de 0,01**, celle que la section
suivante installe, et elles remplacent donc celles de la spec §2 et de
`docs/premier-plan.md`, mesurées à 0,02 : sur `cqlp`, l'empan médian passe de
0,642 à 0,520 avec le filtre — et non de 0,661 à 0,540 —, et la part des images
qui tient dans un 1:1 de 34,5 % à 60,1 % — et non de 31,3 % à 55,1 %. Le filtre
gagne exactement autant qu'avant ; c'est le point de départ et le point d'arrivée
qui se déplacent tous les deux.

Et le filtre du premier plan **n'a presque rien à écarter** hors de `cqlp` :
832 boîtes sur 45 362 pour `caro-mdlm` (1,8 %), 27 sur 24 816 pour `entre-nous`
(0,1 %), contre 33,8 % sur `cqlp`. Le phénomène reste ce que la §10 en dit, une
propriété d'une émission et non du fonds — ce qui veut aussi dire que le filtre
n'avait rien à gagner là où les ratios sont les plus larges.

Un avertissement sur ce p90, parce qu'il invite à une conclusion trop optimiste :
il porte sur des largeurs **par image**, donc il suppose un crop libre par image,
alors que le crop est fixe pour tout le plan. C'est une borne basse. Le ratio réel
est celui qu'il indique **ou plus large**, jamais plus serré.

## Ce que les images montrent, et ce qu'aucun chiffre ne disait

Trois personnes réparties d'un bord à l'autre, ce n'est pas la même chose qu'une
détection parasite qui élargit. Les vignettes tirent les images les plus larges
de chaque plan, une par plan, boîtes dessinées.

**Sur `caro-mdlm`, l'écartement est réel, et il est structurel.** À 8 141 s,
trois personnes assises occupent l'image de `x ≈ 0` à `x ≈ 0,97` : rien à
resserrer. À 1 225 s, l'habillage compose un **gros plan incrusté sur le tiers
gauche** — avec ses propres sous-titres déjà incrustés — et une vue large des deux
autres à droite ; l'empan va d'un bord à l'autre parce que l'image, elle, est
composée de deux images. À 5 476 s, la régie diffuse une vidéo en plein cadre avec
**deux bulles de webcam collées au coin haut droit** : mêmes conséquences. Aucune
de ces trois configurations n'est un défaut de détection, et aucune ne se cadre
plus serré sans perdre quelqu'un.

**Sur `entre-nous`, c'est plus mêlé.** À 4 499 s, deux comédiens sont réellement
aux deux bords et le 16:9 est juste. Mais deux autres cas élargissent sans raison :

- **Des faux positifs.** À 4 374 s, deux boîtes vertes sont posées sur un
  **fauteuil vide** et sur un **pan de mur vide**, pendant que le seul comédien
  présent, à gauche, n'a **aucune** boîte. L'empan de 0,17 à 0,98 est entièrement
  fabriqué. Le filtre du premier plan ne les voit pas — elles ne touchent pas le
  bord bas — et il n'a pas à les voir : ce n'est pas son sujet.
- **Les jambes.** À 2 973 s, deux personnes sont assises côte à côte, têtes entre
  `x ≈ 0,05` et `x ≈ 0,50`, mais la boîte de l'une inclut ses **jambes tendues**
  et va jusqu'à `x ≈ 0,83`. On détecte des corps et c'est la bonne décision ; mais
  une jambe tendue n'a pas la même valeur de cadrage qu'une tête, et rien
  aujourd'hui ne les distingue.

**Sur `cqlp`, la §10 avait raison sur son propre cas.** À 2 116 s, deux comédiens
occupent `[0,11 ; 0,41]` et `[0,52 ; 0,80]` : ils sont vraiment aux deux bords, et
le 16:9 est le bon ratio. On y trouve aussi une boîte trop large — à 3 131 s, une
seule boîte part de `x = 0` et avale une bibliothèque, pendant que le comédien de
droite n'en a pas — mais le crop du plan tombe juste quand même, parce qu'il se
décide sur toutes les images du plan et pas sur la plus large.

Reproduction :

```bash
pnpm tsx scripts/mesure-ratios.ts 2026-03-08-caro-mdlm --instants 3
pnpm tsx scripts/vignettes-premier-plan.ts 2026-03-08-caro-mdlm 1225.5 5476.5 8141.5
```

Les vignettes ne sont pas versionnées : elles montrent des visages identifiables
et ce dépôt est public.

## La marge : mesurée, et son défaut change

`FramingOptions.margin` valait 0,02 et n'avait jamais été mesuré — un réglage de
confort, posé parce que la boîte du détecteur épouse la silhouette et qu'un crop
posé pile dessus met un coude sur le bord. Elle compte **deux fois** dans l'empan,
une fois de chaque côté : à 0,02 elle dépense 0,04 de largeur là où un 1:1 n'en
couvre que 0,5625, soit un quatorzième du cadre.

Balayage sur les clips des trois émissions, `0` / `0,01` / `0,02` / `0,03` :

| marge | 1:1 sur `cqlp` | empan méd. `cqlp` | `caro-mdlm` | `entre-nous` |
|---|---|---|---|---|
| 0 | 2 | 0,531 | 0 | 0 |
| **0,01** | **2** | **0,551** | 0 | 0 |
| 0,02 | 0 | 0,571 | 0 | 0 |
| 0,03 | 0 | 0,591 | 0 | 0 |

Et sur les fenêtres, où la population est assez grande pour compter :

| marge | `cqlp` sous 16:9 | `caro-mdlm` | `entre-nous` |
|---|---|---|---|
| 0 | 56 / 197 | 7 / 339 | 19 / 227 |
| **0,01** | **49 / 197** | **5 / 339** | **19 / 227** |
| 0,02 | 40 / 197 | 5 / 339 | 18 / 227 |
| 0,03 | 37 / 197 | 5 / 339 | 18 / 227 |

**Le défaut passe donc de 0,02 à 0,01.** Trois raisons, et la troisième est celle
qui compte :

1. **Rien ne s'élargit.** Entre 0,02 et 0,01, aucun clip et aucune fenêtre ne
   monte d'un cran ; deux clips de `cqlp` et quinze fenêtres sur 197 descendent.
   Le mouvement est à sens unique sur les trois émissions.
2. **0 n'achète rien de plus au niveau du clip** — même répartition qu'à 0,01 sur
   les trois — et perd tout l'air. 0,01 de la source fait 19 px sur une sortie de
   1 080 : c'est mince, ce n'est pas nul.
3. **Ce que la marge protège tient encore à 0,01, et c'est vérifié à l'image.**
   Sur les deux clips qui basculent, `scripts/vignettes-cadrage.ts` dessine le
   rectangle que le rendu découperait, et compte les images du plan qui en
   sortent. Les trois plans concernés :

   | Plan | Crop 1:1 | Images qui débordent | Ce qui déborde |
   |---|---|---|---|
   | 3 058 s | `[0,263 ; 0,825]` | 1 sur 85 | une boîte partie de `x = 0` qui avale une bibliothèque |
   | 3 131 s | `[0,182 ; 0,745]` | 8 sur 34 | une boîte à `[0,02 ; 0,17]` posée sur une étagère sombre |
   | 4 549 s | `[0,179 ; 0,742]` | 6 sur 52 | la comédienne d'avant-plan droit, déjà coupée par le bord de l'image |

   **Aucun comédien n'est mis au bord par le rectangle.** Sur le plan à 3 058 s il
   cadre les deux comédiens avec de l'air des deux côtés et laisse la bibliothèque
   dehors ; sur celui de 3 131 s il cadre le seul comédien présent, et ce qui
   déborde est une détection sur du mobilier. Les 9 images débordantes sur 119
   font 7,6 % du clip, sous les 10 % que le seuil accorde — le calcul se fait sur
   le clip entier, pas plan par plan, et c'est ce qui explique qu'un plan à 24 %
   passe.

Un défaut reste, et il appartient à `cqlp` : sur le plan à 3 131 s, le bord droit
du crop à `0,745` mord d'environ deux centièmes sur le panneau de chat, qui
commence vers `0,72`. C'est le cas unique documenté en §10, pas une propriété du
fonds.

```bash
pnpm tsx scripts/vignettes-cadrage.ts 2025-06-15-cqlp 2025-06-15-cqlp_003089230-003148633
```

## Ce que ça dit de la suite de l'itération 1

**Cette section est celle du 18 août, et la campagne du 19 en dément la première
phrase** — elle est gardée telle quelle parce que le raisonnement qui suit reste
juste et parce que la corriger effacerait ce qui a fait chercher plus loin. La
répartition d'aujourd'hui est dans « Le rognage latéral », plus bas : 7 % des
fenêtres de `caro-mdlm` et 32 % de celles d'`entre-nous` descendent sous le 16:9.

La mécanique de crop par plan **ne se déclenche presque jamais** sur les émissions
mesurées : 1 % des fenêtres de `caro-mdlm` et 8 % de celles d'`entre-nous`
descendent sous le 16:9. Ce n'est pas zéro, et le crop par plan reste nécessaire
pour ces cas-là — mais ce n'est pas la moitié du bénéfice visuel que la §2
annonçait.

Les deux causes ne sont pas dans le choix du ratio et ne se corrigent pas là :

- **Le dispositif de tournage a changé.** La §2 mesure trois émissions de 2025 sur
  un plateau où deux comédiens jouent debout. `caro-mdlm` et `entre-nous` sont des
  émissions à trois personnes assises et écartées, avec incrustations et
  diffusions de vidéo plein cadre. La table du 17 août ne décrit pas ces
  émissions-là, et rien ne dit combien des vingt leur ressemblent.
- **Le détecteur élargit pour deux raisons évitables** : des faux positifs sur du
  mobilier vide, et des boîtes de corps qui suivent des jambes tendues. Les deux
  se voient à l'image, aucun des deux n'est mesuré, et aucun des deux ne relève du
  filtre du premier plan. C'est l'issue #69, et le rognage du 19 août en rattrape
  une partie sans la résoudre : il borne ce qu'une boîte fausse peut coûter, il ne
  la corrige pas.

## Le rognage latéral : mesuré le 19 août 2026

Ce qui précède est daté du 18 août. La suite est du 19, elle porte sur les mêmes
trois émissions, et elle **déplace la conclusion de la section précédente** : la
mécanique du crop par plan ne se déclenchait presque jamais parce que le critère
demandait trop, pas parce que les émissions ne s'y prêtent pas.

### Le constat qui l'a ouverte

Clip `2025-06-15-cqlp_002107357-002143228`, deux plans, tous deux en 16:9. Sur le
premier — 30,6 s, 61 images, deux comédiens —, l'empan brut vaut 0,669 au médian
et 0,686 au p90 quand un 1:1 en couvre 0,5625 : **aucune** image ne tient, donc
aucun réglage de percentile n'aurait pu produire autre chose qu'un 16:9.

À l'image, à 2 120 s, elle occupe `[0,106 ; 0,490]` et lui `[0,523 ; 0,778]`. Un
1:1 posé sur `[0,181 ; 0,744]` garde **les deux visages et les deux bustes** et ne
perd que l'épaule extérieure de chacun. Le critère refusait ce cadre parce qu'il
exigeait que l'union des boîtes **entières** tienne, bras traînant compris.

### Ce qui a été retenu, et pourquoi pas les autres

Chaque boîte abandonne, de chaque côté, `min(0,30 × sa largeur ; 0,12 de
l'image)`. C'est le seul changement ; le seuil de 90 %, la marge, le filtre du
premier plan et le choix de position ne bougent pas.

Trois formes ont été mesurées :

- **Un débordement toléré, uniforme.** Arithmétiquement identique à une marge
  négative : la fenêtre admissible s'élargit de deux fois la tolérance, quels que
  soient les gens présents. Elle rabote donc autant les empans déjà étroits, et
  les pousse vers des ratios trop serrés — à 0,07 de tolérance, `cqlp` sort 17
  fenêtres en 9:16 contre 29 en 4:5, là où le rognage proportionnel en amène 13 et
  29. Rogner là où il y a de quoi rogner vaut mieux que rogner partout, et une
  boîte est large précisément quand un membre est tendu.
- **Une fraction exigée de chaque personne.** Elle autorise à prendre toute la
  perte d'un seul côté, alors que la version symétrique — celle retenue — donne la
  même réduction d'empan en garantissant que ce qui reste est centré. À gain égal,
  elle est strictement moins sûre.
- **Pondérer la boîte par sa partie haute**, comme le suggère l'issue #69 : pas
  possible avec les données actuelles. `PersonBox` est un rectangle sans structure
  interne, et sa largeur est la même à toutes les hauteurs. Il faudrait des points
  de pose, donc une autre passe de détection.

### Le plafond, payé par une image

Sans plafond, à 0,30 de part, `2026-03-08-caro-mdlm` à 7 250 s bascule en 1:1 —
et **c'est une faute**. Un comédien assis, jambes tendues vers la gauche, donne
une boîte de 0,536 de large dont la tête occupe l'extrémité droite. En abandonner
30 % de chaque côté fait 0,161 de l'image, le crop s'arrête à 0,736, et **son
visage est dehors pendant les 28 secondes du plan**. Le compteur de pertes ne le
signalait pas : il n'a perdu que 27 % de sa boîte.

C'est le cas des jambes tendues de l'issue #69, vu par l'autre bout. Le plafond
ramène la perte à un liseré et le plan reste en 16:9.

Les deux bornes se lisent ensemble : la part protège les sujets **lointains**,
qu'un plafond seul effacerait ; le plafond protège les sujets **larges**, dont la
tête n'est pas au milieu.

### Les valeurs, et la distance aux deux falaises

| | seuil | ce qui se passe en dessous / au-dessus |
|---|---|---|
| part | 0,30 | en dessous, le plan de référence reste en 16:9 |
| plafond, borne basse | 0,09 | en dessous, le plan de référence reste en 16:9 |
| plafond, borne haute | 0,15 | au-dessus, le visage de `caro-mdlm` tombe |

Le plafond retenu, **0,12**, est au milieu de l'intervalle. Au-delà de 0,40 de
part le coût s'emballe : sur les fenêtres de `cqlp`, le temps où quelqu'un perd
plus d'un tiers de sa largeur passe de 79 s à 220 s.

### La répartition, avant et après

Rognage nul à gauche de la flèche, réglage retenu à droite.

**Clips du repérage** — la population du produit. Les 19 de `cqlp` incluent les
deux vestiges `clip_verif_*` et les clips non écartés de la base du jour ; c'est
ce que le script compte, et les lignes sont nommées dans sa sortie.

| | `cqlp` (19) | `caro-mdlm` (6) | `entre-nous` (6) |
|---|---|---|---|
| 9:16 | 0 → **1** | 0 → 0 | 0 → 0 |
| 4:5 | 1 → **4** | 0 → 0 | 0 → 0 |
| 1:1 | 2 → **6** | 0 → **1** | 0 → **2** |
| 16:9 | 16 → **8** | 6 → **5** | 6 → **4** |
| part en 16:9 | 84 % → **42 %** | 100 % → **83 %** | 100 % → **67 %** |

**Fenêtres de 30 s** — ce qu'un clip quelconque deviendrait.

| | `cqlp` (197) | `caro-mdlm` (339) | `entre-nous` (227) |
|---|---|---|---|
| 9:16 | 1 → **18** | 0 → 0 | 3 → **5** |
| 4:5 | 16 → **32** | 0 → **1** | 1 → **20** |
| 1:1 | 22 → **49** | 1 → **24** | 8 → **47** |
| 16:9 | 158 → **98** | 338 → **314** | 215 → **155** |
| part en 16:9 | 80 % → **50 %** | 100 % → **93 %** | 95 % → **68 %** |

**Et le ratio se choisit par plan, donc le chiffre qui décrit ce que la variante
9:16 montre est le temps, pas le compte de clips.** Part du temps de plan monté
en 16:9, sur les clips du repérage : **77 % → 25 %** sur `cqlp`, **100 % → 90 %**
sur `caro-mdlm`, **99 % → 58 %** sur `entre-nous`. Sur les fenêtres : 69 % → 36 %,
97 % → 84 %, 87 % → 52 %.

**Aucun clip ni aucune fenêtre ne s'élargit**, à aucune valeur du balayage, de 0
à 0,40. La propriété se démontre — rogner ne peut que réduire un empan — et un
test la tient.

### Ce que ça coûte, en secondes de clip

La mesure porte sur **toutes** les images des clips, y compris celles que le seuil
de 90 % sacrifie : c'est là que se cachent les pertes qu'aucun tableau de ratios
ne montre. Une image vaut une demi-seconde.

| | `cqlp` (19 clips) | `caro-mdlm` (6) | `entre-nous` (6) |
|---|---|---|---|
| p99 de ce qu'une personne perd | 0,000 → 0,300 | 0,000 → 0,198 | 0,000 → 0,509 |
| temps où quelqu'un perd > 1/3 | 0,5 s → 8,5 s | 0 s → 0,5 s | 0 s → 8,0 s |
| temps où quelqu'un perd > 1/2 | 0 s → 2,5 s | 0 s → 0 s | 0 s → 7,5 s |

**Les deux lignes de temps sont à relire à la baisse, et le script a été corrigé
depuis.** Elles ont été relevées quand `mesure-ratios.ts` comptait des
*personnes-images* et les multipliait par le pas d'échantillonnage : deux
comédiens amputés sur la même image de 0,5 s donnaient « 1,0 s ». Le script
agrège désormais par image — la pire perte de chacune — avant de convertir, donc
il rendrait ici au plus ces valeurs, et jusqu'à deux fois moins. Le comptage
d'épisodes du paragraphe suivant, lui, a été fait à la main et ne dépend pas de
cette colonne. (relevé par Copilot en review de la #83)

Sur les 31 clips, dix épisodes dépassent la moitié, **de 0,5 à 1,5 seconde
chacun**, 7,5 s cumulées. Aucun n'est une perte installée : ce sont des images
isolées, celles que le seuil de 90 % accepte déjà de sacrifier. Le pire est à
2 137,5 s de `cqlp`, où le comédien de droite marche jusqu'au bord dans la
dernière demi-seconde de son plan et sort du cadre.

**Un cas reste discutable et il faut le nommer.** Sur
`2026-22-02-entre-nous_001964265-002036031`, le plan de 1 979 s passe en 4:5. La
plupart du temps il cadre bien les deux comédiens ; mais la comédienne assise se
déplace, et pendant trois épisodes d'une seconde elle se retrouve au bord gauche
du crop, visage compris. C'est le seul endroit du corpus où le réglage perd un
visage.

### Ce que les images ont dit, et que les chiffres ne disaient pas

- **Le 1:1 du plan de référence est bon** : à 2 113 s comme à 2 123 s, les deux
  visages, les deux bustes et les deux mains sont dedans. Ce qui tombe est le
  dehors du chignon de l'une et le bord de l'épaule de l'autre.
- **Le rognage est une permission, pas une coupe.** Sur ce plan, la fenêtre 1:1
  fait 0,5625 pour un empan rogné de 0,501 : le crop rend l'essentiel de ce qui a
  été abandonné, et chacun ne perd en fait que 12 % et 20 % de sa boîte, non 30 %.
- **Le chat Twitch sort du cadre**, et c'est un bénéfice qu'aucune ligne du
  tableau ne porte. À 3 930 s, un 4:5 cadre le comédien seul et laisse le panneau
  dehors ; à 5 014 s, un 9:16 fait de même sur un gros plan. En 16:9, un quart de
  l'image partait en chat et un autre quart en mur vide.
- **Un faux positif posé dans le panneau de chat est éjecté** par le resserrement,
  à 1 226 s. Le gain est réel et fortuit.
- **Le deuxième plan du clip de référence sort en 1:1, pas en 9:16.** Julien le
  voyait en 9:16 et il a raison sur ce qu'il faut voir — un gros plan sur le
  comédien qui parle. Le détecteur ne le permet pas : ses boîtes pour cet homme
  vont de 0,42 à 0,65 de large et sautent de ±0,15 d'une image à l'autre, pour un
  visage qui occupe 0,30. Aucun critère lisant ces boîtes ne peut cadrer ce
  visage ; il faudrait de meilleures boîtes, ce qui est l'issue #69. La troisième
  boîte que Julien voyait à gauche, une main au bord du cadre, est en revanche
  **déjà écartée** par le seuil de confiance, à 0,45 contre 0,50 exigé.

### Ce que le rognage ne peut pas soigner : les frontières de plans manquées

Signalé par Julien sur `2026-22-02-entre-nous_002940409-003025773` : le clip
commence bien en 1:1 et 4:5, puis bascule en 16:9 alors que les plans suivants
s'y prêtaient. Ce n'est pas le critère.

**Ces plans-là ne sont pas trop larges, ils sont trop mobiles.** Sur le plan
3 234 → 3 297 s, **89 images sur 89 tiennent dans un 1:1** et le ratio retenu est
le 16:9 : l'action y alterne entre `[0,12 ; 0,55]` et `[0,39 ; 0,91]`, deux axes
de caméra dans un même « plan ». Aucune position fixe n'en sert plus de 47 sur 89.

Vérifié à l'image sur le plan voisin, 2 949,9 → 2 955,8 s : à 2 952,5 s c'est un
plan serré sur les deux comédiens, à 2 954,0 s un plan large depuis une autre
caméra. La coupe est réelle, elle tombe à **2 953,2 s**, et son score de scène
vaut **0,366** — sous le seuil de 0,40 du détecteur.

Le compte, par `scripts/mesure-ratios.ts` (section 5) :

| | plans bornés par la position | temps de montage concerné |
|---|---|---|
| `2025-06-15-cqlp` | 1 sur 32 | 22 s sur 549 (4 %) |
| `2026-03-08-caro-mdlm` | 0 sur 31 | 0 s sur 330 (0 %) |
| `2026-22-02-entre-nous` | **13 sur 54** | **138 s sur 391 (35 %)** |

Les treize sortent tous « 1:1 possible, 16:9 retenu ». Sur `entre-nous`, c'est
**le premier gisement restant**, devant tout réglage du cadrage.

**Et la correction évidente ne l'est pas.** Sur les cent secondes autour de la
coupe manquée, la distribution des scores est parfaitement séparée : dix-neuf
évènements au-dessus de 0,48, six entre 0,366 et 0,388 — tous de vraies coupes —,
puis plus rien jusqu'à 0,032. Un seuil n'importe où entre 0,05 et 0,36 les
prendrait tous sans rien ajouter.

Sur l'émission entière, cette vallée n'existe pas : 373 évènements entre 0,35 et
0,40 contre 255 entre 0,40 et 0,45, sans creux. Descendre le seuil à 0,35
ajouterait 41 % d'évènements dont on ne sait pas ce qu'ils sont — et la §2 de la
conception prévient que ce n'est pas le mouvement qui fait monter le score de
scène, c'est la lumière. **La fenêtre de cent secondes disait un seuil ; l'heure
et demie dit qu'il faudra le mesurer.** Le tableau ci-dessus est le bon critère
pour le faire, parce qu'il nomme les plans à réparer au lieu de compter des pics.

### Reproduction

```bash
pnpm tsx scripts/mesure-ratios.ts 2025-06-15-cqlp 2026-03-08-caro-mdlm 2026-22-02-entre-nous
pnpm tsx scripts/vignettes-cadrage.ts 2025-06-15-cqlp 2025-06-15-cqlp_002107357-002143228 --images 3
pnpm tsx scripts/vignettes-cadrage.ts 2025-06-15-cqlp 2025-06-15-cqlp_002107357-002143228 --trim 0
```

## Le tronc, mesuré le 19 août 2026 au soir

Ce qui précède lit des **boîtes**. La suite lit des **points de pose**, et elle
répond à l'issue #69 : le rognage latéral borne ce qu'une boîte trop large peut
coûter sans savoir ce qu'il abandonne, alors qu'un squelette dit où est la tête.

Les trois émissions ont été repassées avec `yolo11m-pose.pt`, qui rend dix-sept
points COCO par personne en plus de la boîte. `src/core/framing.ts` en déduit le
**tronc** — la tête et les épaules, rognées d'une part, la tête servant de
plancher —, et c'est lui qui entre dans l'empan à la place de la boîte rognée.
La boîte reste : le filtre du public au premier plan lit sa géométrie, et un
squelette ne dit pas si le bas de l'image a tronqué quelqu'un.

### Ce que la détection coûte, et ce n'est rien

Trois passes de chaque modèle sur le même proxy, 11 874 images, `loadavg` de 1,4
à 6,2 :

| modèle | passes | médiane |
|---|---|---|
| `yolo11m.pt` | 151, 146, 147 im/s | **147 im/s** |
| `yolo11m-pose.pt` | 145, 140, 155 im/s | **145 im/s** |

**1,4 % d'écart, donc rien d'établi** : `CLAUDE.md` fixe à 10 % le seuil en deçà
duquel une mesure prise sous WSL ne conclut pas. Sur des émissions entières :
139 s pour 1 h 54, 207 s pour 2 h 50, 113 s pour 1 h 39, toutes deux passes
comprises.

Ce que ça coûte est ailleurs : **le fichier grossit d'un facteur cinq**. Sur
`entre-nous`, `analysis.json` passe de 2,2 à 11,6 Mo, dix-sept triplets par boîte.
Les dix-sept sont écrits et non le tronc, pour la raison qui a déjà placé le
filtre du premier plan côté lecture : la définition du tronc est un réglage, et
la changer ne doit pas coûter une passe de GPU.

### L'empan que chaque primitive demande

Par personne gardée, avant tout choix de ratio. **99 % des boîtes ont un tronc
lisible** sur les trois émissions — le tronc n'est pas un raffinement qui ne
s'applique jamais.

| médiane / p99 | `cqlp` | `caro-mdlm` | `entre-nous` |
|---|---|---|---|
| boîte corps entier | 0,225 / 0,616 | 0,250 / 0,534 | 0,249 / 0,602 |
| boîte rognée (le code du 19 août) | 0,090 / 0,376 | 0,100 / 0,294 | 0,100 / 0,362 |
| tronc | 0,084 / 0,352 | 0,079 / 0,217 | 0,081 / 0,242 |

**Au médian, le rognage latéral était déjà plus serré que le tronc**, et c'est le
chiffre qui a renversé l'attente : il abandonne `min(0,30 × largeur ; 0,12)` de
chaque côté d'une boîte de 0,25, soit 60 % d'elle. Le gain du tronc n'est donc pas
qu'il resserre — c'est qu'il resserre **au bon endroit**. La boîte rognée est
centrée sur le milieu de la boîte ; quand les jambes partent d'un côté, ce milieu
n'est pas la tête.

### La répartition, boîte contre tronc

**Sur le même fichier d'analyse**, pour que la comparaison porte sur la primitive
et non sur le modèle. Part du temps de montage en 16:9, qui est ce que la variante
9:16 montre :

| | `cqlp` | `caro-mdlm` | `entre-nous` |
|---|---|---|---|
| clips, boîte + rognage | 31 % | 90 % | 60 % |
| clips, **tronc** | **31 %** | **90 %** | **49 %** |
| fenêtres, boîte + rognage | 42 % | 84 % | 55 % |
| fenêtres, **tronc** | **37 %** | **84 %** | **51 %** |

Et ce que ça coûte aux gens, sur les mêmes lignes :

| | `cqlp` | `caro-mdlm` | `entre-nous` |
|---|---|---|---|
| tronc coupé, p99, boîte + rognage | 0,309 | 0,098 | 0,192 |
| tronc coupé, p99, **tronc** | **0,016** | **0,056** | **0,000** |
| têtes hors cadre, boîte + rognage | 52 | 63 | 56 |
| têtes hors cadre, **tronc** | **46** | **62** | **53** |
| têtes à moins de 1 % du bord, boîte + rognage | 332 | 667 | 318 |
| têtes à moins de 1 % du bord, **tronc** | **67** | **562** | **109** |

**« Têtes hors cadre » est l'instrument qui manquait**, et il vaut d'être nommé :
c'est le nombre de couples (personne, image) dont aucun point de tête n'est dans
le rectangle. La campagne du 19 août au matin a posé le plafond du rognage sur un
visage tombé dehors qu'elle n'a vu qu'en regardant une image, et notait que « le
compteur de pertes ne le signalait pas ». Il le signale maintenant, sur une
émission entière et sans regarder.

**Le chiffre qui gagne le plus est le dernier.** Les têtes cessent d'être posées
sur le bord du cadre : cinq fois moins sur `cqlp`, trois fois moins sur
`entre-nous`. Un buste rogné de 1 % ne se voit pas ; un visage collé au bord, si.

### Ce que ça donne contre le code en service

La comparaison précédente isole la primitive. Celle-ci compare ce qui tourne
aujourd'hui — modèle de détection, boîtes rognées — à ce qui le remplace — modèle
de pose, tronc :

| part du temps de montage en 16:9 | `cqlp` | `caro-mdlm` | `entre-nous` |
|---|---|---|---|
| clips, aujourd'hui | 26 % | 90 % | 58 % |
| clips, tronc | 31 % | 90 % | **49 %** |
| fenêtres, aujourd'hui | 36 % | 84 % | 52 % |
| fenêtres, tronc | 37 % | 84 % | **51 %** |

**L'écart avec le tableau précédent est le modèle, pas la primitive**, et il faut
le dire : sur `cqlp`, les mêmes boîtes rognées donnent 36 % avec les poids de
détection et 42 % avec ceux de pose. Le tronc en récupère cinq points, pas six.
La cause n'est pas établie, seulement située — les deux modèles ne voient pas la
même population. Le modèle de pose ne rend que 2 429 boîtes courtes collées au bord
bas là où celui de détection en rend 8 325, c'est-à-dire qu'**il ne voit pas la
plupart des têtes de spectateurs** ; le filtre du premier plan n'a donc plus que
11,5 % des boîtes à écarter contre 30 %, pour un nombre de boîtes gardées presque
identique (20 306 contre 19 972).

Sur `caro-mdlm`, rien ne bouge, et c'est attendu : trois personnes assises d'un
bord à l'autre, un gros plan incrusté sur le tiers gauche, une diffusion de vidéo
plein cadre. Aucune primitive ne resserre une image qui est composée de deux
images.

### Les trois cas de contrôle, et un quatrième

**Les jambes de l'issue #69** — `entre-nous`, 2 973 s. Les boîtes font
`[0,008 ; 0,827]` d'union parce qu'une cheville est à 0,757 ; les troncs font
`[0,043 ; 0,497]`, soit 0,454. Le clip entier bascule :
`2026-22-02-entre-nous_002940409-003025773` sortait **treize de ses dix-neuf plans
en 16:9** et son fichier natif avec ; il n'en sort plus **aucun**, et le natif
passe en 1:1. Vérifié à l'image : le 4:5 garde les deux visages, les deux bustes,
et laisse la basket dehors.

**Le visage à l'extrémité de sa boîte** — `caro-mdlm`, 7 250 s, le cas qui a payé
le plafond du rognage. La boîte fait `[0,332 ; 0,873]`, la tête `[0,704 ; 0,813]`.
Le rognage sans plafond s'arrête à 0,711, donc dehors ; avec le plafond il
s'arrête à 0,753, donc le nez dedans et l'oreille dehors. Le tronc rend
`[0,688 ; 0,829]`, exactement la tête et les épaules. **Le plafond n'a plus
d'objet** là où les points nomment la tête : il n'était qu'un pari sur sa
position.

**Le gros plan indomptable** — `cqlp`, 2 138 s. Il s'améliore sans se résoudre.
L'empan de ce comédien allait de 0,099 à 0,479 d'une image à l'autre sur les
boîtes ; sur les troncs il va de 0,120 à 0,298, donc la gigue tombe de 0,380 à
0,178. Le plan reste en 1:1 et non en 9:16, et **ce n'est plus la largeur qui
décide, c'est la position** : sur onze images, aucune position fixe de 9:16 n'en
sert dix. C'est le sujet des plans trop mobiles, pas celui du tronc.

**Le seul endroit du corpus où le rognage perdait un visage** —
`2026-22-02-entre-nous_001964265-002036031`, plan de 1 979 s. Le crop passait en
4:5 sur `[0,349 ; 0,799]` et coupait la comédienne assise en deux pendant trois
épisodes d'une seconde. Avec le tronc il passe en 1:1 sur `[0,271 ; 0,833]` :
elle reste entière. Le plan s'élargit d'un cran et c'est le bon échange, puisque
c'était le cas que la campagne précédente avait nommé comme discutable.

### Ce qu'il reste du rognage latéral

**Rien, sur une analyse qui porte des points.** 99 % des boîtes ont un tronc, donc
`sideTrim` ne gouverne plus que le centième restant : balayé de 0 à 0,40 sur les
six clips et les 227 fenêtres d'`entre-nous`, il ne déplace **aucun** ratio.

Il reste quand même, et il n'est pas décoratif :

- un `analysis.json` de version 1 n'a pas de points, et il y en a sur le disque ;
- `DETECT_MODEL` peut repasser sur `yolo11m.pt`, ce qui est la seule façon de
  refaire la comparaison ci-dessus ;
- une personne de dos, dont le réseau ne voit ni tête ni épaules, n'a pas de tronc
  lisible. Elle retombe sur la boîte rognée, c'est-à-dire sur un comportement
  mesuré qui marchait.

`sideTrimMax`, en revanche, ne protège plus rien sur le chemin du tronc : il
existait pour empêcher un rognage aveugle de jeter une tête, et la tête n'est plus
devinée. Il reste sur le chemin de repli, où il garde tout son sens.

### Les deux réglages du tronc

`torsoPad` élargit le tronc à proportion de sa largeur, **parce qu'un point
d'épaule est le centre d'une articulation** et non le bord de la silhouette : à
zéro, le cadre passe au milieu de chaque épaule. `torsoTrim` abandonne une part du
tronc de chaque côté, la tête exceptée — c'est `sideTrim` posé sur la bonne
primitive.

Balayage sur les fenêtres, part en 16:9 et têtes hors cadre :

| `torsoTrim` | `cqlp` | `caro-mdlm` | `entre-nous` |
|---|---|---|---|
| 0 | 52 % / 17 | 92 % / 28 | 68 % / 29 |
| 0,20 | 42 % / 35 | 86 % / 50 | 57 % / 48 |
| **0,30** | **37 % / 46** | **84 % / 62** | **51 % / 53** |
| 0,40 | 35 % / 52 | 82 % / 77 | 49 % / 57 |

**0,30 est le coude.** De 0,20 à 0,30, cinq à six points de temps de montage ; de
0,30 à 0,40, deux points, et le tronc commence à être coupé (p99 de 0,000 à 0,036
sur `entre-nous`). La valeur coïncide avec celle du rognage latéral, et ce n'est
pas une coïncidence entretenue : les deux abandonnent une part d'un intervalle,
c'est le même geste sur deux primitives différentes.

| `torsoPad` | `cqlp` | `caro-mdlm` | `entre-nous` |
|---|---|---|---|
| 0 | 33 % / 63 | 81 % / 79 | 47 % / 65 |
| 0,10 | 35 % / 50 | 83 % / 63 | 50 % / 53 |
| **0,15** | **37 % / 46** | **84 % / 62** | **51 % / 53** |
| 0,20 | 38 % / 41 | 84 % / 56 | 52 % / 53 |
| 0,30 | 42 % / 34 | 87 % / 45 | 57 % / 47 |

Ce réglage-là n'a pas de coude : il échange linéairement du ratio contre des
visages. **0,15 est un arbitrage, pas un optimum**, et le dire vaut mieux que de
l'habiller — c'est à peu près l'épaisseur d'un bras rapportée à la largeur des
épaules, et c'est la valeur au-delà de laquelle le tronc cesse d'être coupé sur
deux émissions sur trois.

### Les cinq définitions de tronc comparées

Le balayage retient `bust` — la tête et les épaules. Sur les fenêtres
d'`entre-nous`, part en 16:9 et têtes hors cadre : `head` 47 % / 71, `bust`
51 % / 53, `bust-hips` 51 % / 55, `shoulders-hips` 51 % / 55, `upper-body`
57 % / 45.

- **`head` est plus serré et moins sûr** : un cadre garanti sur les seuls visages
  coupe les bustes, et le compteur de têtes le confirme au lieu de le cacher.
- **`bust-hips` et `shoulders-hips` ne se distinguent pas de `bust`**, à un point
  près. Chez quelqu'un d'assis de face, les hanches ne dépassent pas les épaules ;
  et quand elles le feraient, elles sont cachées, donc leur confiance est basse et
  elles ne comptent pas. `shoulders-hips` perd la tête sur le papier et s'en tire
  parce que la tête sert de plancher — mais ce plancher ne le sauverait pas si le
  rognage était plus fort.
- **`upper-body` élargit** de six points sur `entre-nous` : un bras tendu rentre
  dans le cadre, et c'est exactement ce qu'on venait d'en sortir.

### Reproduction

```bash
pnpm tsx scripts/mesure-ratios.ts 2026-22-02-entre-nous
pnpm tsx scripts/mesure-ratios.ts 2026-22-02-entre-nous --tronc off
pnpm tsx scripts/vignettes-cadrage.ts 2026-22-02-entre-nous \
  2026-22-02-entre-nous_002940409-003025773 --images 3
pnpm tsx scripts/vignettes-cadrage.ts 2026-22-02-entre-nous \
  2026-22-02-entre-nous_002940409-003025773 --tronc off --images 3
```

`--analyse <projet>=<fichier>` lit une analyse d'ailleurs, ce qui permet de
comparer deux détecteurs sans écraser celui que le serveur de développement sert.
Les deux autres émissions n'ont **pas** été rebasculées en pose sur le disque : les
chiffres ci-dessus viennent d'analyses écrites dans un dossier temporaire, et les
reproduire demande de relancer la détection.

## Discipline de mesure

Compter des ratios est déterministe : une passe suffit, et la variance de 40 à
80 % que `CLAUDE.md` documente ne concerne que les mesures de temps. Les seuls
chiffres de durée ici sont ceux de la chaîne relancée sur `caro-mdlm` — transcript
167 s, repérage 155 fenêtres sur 155, analyse 196 s pour 2 h 50 —, pris à
`loadavg` 7 pendant que d'autres agents tournaient : des ordres de grandeur, pas
des mesures de performance.
