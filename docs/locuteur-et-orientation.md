# Suivre une personne dans un plan à deux

Spike ouvert le 20 août 2026. Question posée par Julien : sur un plan large où
deux personnes se répondent, peut-on cadrer en 9:16 sur celle qui parle, et
changer quand la parole alterne ? Et sur un plan où l'une est de face et l'autre
de profil, peut-on ignorer celle de profil ?

Ce document porte les mesures. Les scripts qui les produisent vivent dans
`scripts/spike/` et `worker/`, la fonction d'orientation dans
`src/core/framing.ts`.

**Rien de tout cela n'est branché sur le rendu.** `computeFraming` a le même
comportement qu'avant le spike, et c'est délibéré : on mesure avant de brancher.

---

## Ce que ça vaudrait

Un plan large à deux personnes sort en 16:9, qui occupe **31,6 % du canevas
vertical**. Sur un téléphone, ce sont deux silhouettes au milieu d'un fond
flouté. Le même plan cadré sur une seule personne remplit le canevas.

Mesuré par `scripts/spike/addressable.ts` sur les quatre émissions du disque,
en temps de plan restreint au montage (2 023 s de clips gardés) :

| | temps | part du montage |
|---|---|---|
| Plans à exactement 2 personnes, 16:9, d'au moins 4 s | 878 s | **43,4 %** |
| dont les **deux** rangs, pris seuls, donneraient un 9:16 | 555 s | 27,4 % |
| dont **un seul** des deux | 197 s | 9,7 % |
| dont **aucun** | 126 s | 6,2 % |

Le détail par émission est très inégal : 63,7 % du montage de
`2026-05-31-nabla`, 43,5 % de `2026-22-02-entre-nous`, 35,0 % de
`2026-03-08-caro-mdlm`, 19,0 % de `2025-06-15-cqlp`.

La troisième ligne mérite d'être lue. Suivre le locuteur ne demande pas que les
deux personnes soient cadrables : il suffit que celle qui parle le soit. Un
premier chiffrage n'avait compté que la deuxième ligne et sous-estimait donc le
plafond.

### Le montage est-il un échantillon honnête ?

Les clips sont choisis par le repérage sur l'intérêt du propos, donc sur des
moments bavards, qui sont justement les plans d'interview à deux. Le gisement
mesuré sur le montage pourrait n'être qu'un effet de cette sélection.

Comparaison entre les plans qui touchent un clip et les autres, sur les plans
d'au moins 4 secondes :

| Émission | plans à deux, dans / hors clip | dont 16:9, dans / hors |
|---|---|---|
| `2025-06-15-cqlp` | 72,3 % / 80,4 % | 52,3 % / 40,7 % |
| `2026-03-08-caro-mdlm` | 50,7 % / 46,1 % | 90,1 % / 74,5 % |
| `2026-05-31-nabla` | 90,4 % / 82,0 % | 81,5 % / 82,6 % |
| `2026-22-02-entre-nous` | 91,8 % / 79,2 % | 52,9 % / 51,6 % |

Sur la grandeur qui décide — la part de 16:9 **parmi** les plans à deux —
`nabla` et `entre-nous` ne montrent aucun biais. `cqlp` et `caro-mdlm` sont
enrichies de 12 et 16 points. Le gisement n'est donc pas un artefact de
sélection, mais il est modérément optimiste sur deux émissions sur quatre.

Hors clip, `nabla` porte encore 4 206 s de plans à deux en 16:9. Le gisement
grandit avec le nombre de clips extraits.

---

## Subdiviser un plan resserre le ratio tout seul

C'est le résultat le plus utile du spike, et il est arrivé par un contrôle qui a
démenti la mesure qu'il accompagnait.

Point de départ : une coupe caméra a été trouvée à l'œil **à l'intérieur** du
plan de référence de Julien, `2026-05-31-nabla` 7 154,3 → 7 199,4. Entre 7 180,0
et 7 182,5 le cadre se resserre nettement. C'est le résidu que la skill `cadrage`
nomme déjà : un changement d'axe où les largeurs de boîte changent et pas
seulement leur position, que `collective_shift` ne voit jamais.

D'où la question : le gisement est-il en 16:9 parce qu'il y a deux personnes, ou
parce que ce sont en réalité plusieurs plans ? La sonde cherche, dans chaque plan
du gisement, la coupe interne qui maximise l'écart de largeur d'empan médiane
entre l'avant et l'après, puis recalcule le ratio des deux moitiés.

| Corpus, 989 s de gisement | couper resserre |
|---|---|
| au meilleur pas de largeur | 41,3 % |
| **témoin, au hasard** | **31,7 %** |
| témoin, au milieu | 16,8 % |

Le critère ne bat le hasard que de 9,6 points, et par émission il fait pire : sur
`cqlp` (80,1 % contre 84,8 %) comme sur `nabla` (18,3 % contre 21,4 %), couper au
hasard fait aussi bien ou mieux. Le pas de largeur ne repère pas les vraies
coupes.

Ce que le témoin apprend en revanche vaut pour tout le reste du spike : **couper
un plan n'importe où resserre souvent le ratio**, parce que la règle des 90 %
s'applique alors à un intervalle plus court, où l'action a moins le temps de
bouger.

Conséquence de méthode, et elle n'est pas négociable : toute comparaison A/B d'un
cadrage suivant le locuteur doit inclure un **témoin à cadence fixe**, qui
subdivise le plan au même rythme en ignorant qui parle. Sans lui, on crédite la
détection de locuteur d'un gain que n'importe quelle subdivision donne.

La coupe manquée à 7 181 s reste vraie, elle. Elle a été vue à l'image ; c'est sa
quantification qui a échoué.

---

## L'orientation : elle est déjà dans le fichier

`analysis.json` en version 2 porte les dix-sept points COCO par personne, avec
une confiance par point. Nez, deux yeux et deux oreilles suffisent à situer un
visage, et les épaules disent où va le buste.

Aucun modèle neuf, aucune passe GPU, aucune ré-analyse du corpus.

`orientationOf(box, options)` dans `src/core/framing.ts` rend trois choses : un
`facing` (`frontal`, `profile`, `unknown`), une `frontality` entre 0 et 1 et le
côté vers lequel la personne est tournée. Elle combine trois termes :

| Terme | Ce qu'il lit |
|---|---|
| `earAsymmetry` | l'écart des confiances d'oreille, sur les valeurs brutes |
| `eyeTerm` | deux yeux confiants, un seul ou aucun |
| `shoulderRatio` | l'écart des épaules en x, rapporté à une échelle verticale |

**`frontality` vaut `null` quand `facing` vaut `unknown`, jamais 0.** Un appelant
qui trierait par frontalité classerait un 0 comme « le plus de profil », alors
qu'on n'en sait rien. Une personne de dos n'est pas de profil. C'est la doctrine
de `CLAUDE.md` sous « Distinguer l'absence d'information de son ambiguïté », et
elle a un corollaire : **`unknown` n'exclut jamais personne du cadre.**

L'échelle du terme d'épaules n'est pas la largeur de tête, qui se calcule sur les
points confiants et bouge donc avec la grandeur qu'on mesure. C'est la distance
verticale du nez au milieu des épaules, ou celle des épaules aux hanches quand le
nez manque.

### La règle de filtrage est relative, jamais absolue

La spec §2 dit que les comédiens **jouent de profil, face à face**. Le profil est
la norme du plateau. Une règle « on écarte le profil » serait juste sur les
séquences d'interview et fausse partout ailleurs.

Une personne n'est donc écartée que si une autre du même plan est nettement plus
de face, que l'écart tient sur la durée, que la perdante n'est pas `unknown`, et
que l'écarter change effectivement le ratio.

### Ce que les images ont dit, et que la distribution ne disait pas

`scripts/spike/orientation-sheet.ts` tire 150 vignettes de tête stratifiées sur
les quatre émissions et les pose sur cinq planches-contact, triées par
frontalité. Cinq lectures d'image pour 150 étiquettes.

Le tri est propre : de 0,000 à 0,35, trente vignettes de vrais profils sans une
inversion visible. Deux défauts sont apparus, tous deux invisibles dans les
chiffres.

**Le seuil de 0,35 était trop bas.** À 0,366 et 0,474 la fonction dit `frontal`
sur des visages franchement de profil. Il avait été posé au milieu du trou entre
les quatre cas d'étalonnage — 0,036 d'un côté, 0,686 de l'autre — et la vraie
distribution est dense autour de la frontière.

**Les trois termes ne sont pas trois voix indépendantes.** Une vignette à
`frontality = 0,000` montre une femme qui regarde la caméra : cheveux longs sur
une oreille, yeux baissés. L'asymétrie d'oreille vient de sa coiffure, la faible
confiance d'un œil de son regard baissé. Les deux termes de visage mesurent la
même chose — la visibilité du visage — et s'effondrent ensemble sous des causes
étrangères à l'orientation.

Sur 117 937 boîtes retenues, 3 101 sortent en `unknown`, soit 2,6 %. Le terme
d'épaules manque sur 6 629 boîtes, soit 5,6 %, dont 46,7 % étaient déjà
`unknown` : le cas « deux termes de visage et rien d'autre » ne pèse donc que 3 %.

### Le buste ne dit pas où va la tête

Une planche centrée sur la frontière, tirée entre 0,25 et 0,80, a démenti la
prémisse de départ.

Il est vrai qu'un torse de profil projette ses deux épaules au même endroit. Ce
qui est faux, c'est que ça renseigne sur le visage : **on tourne la tête, pas le
buste**. Deux personnes assises côte à côte se parlent buste face caméra et tête
de profil, et c'est la posture la plus fréquente du corpus. Les profils francs de
la planche ont un rapport d'épaules de 0,77 à 1,31, c'est-à-dire élevé. Les
quatre cas d'étalonnage avaient tête et buste alignés, ce qui a caché le cas
général.

Le terme d'œil ne rattrape pas : **au-dessus de 0,46, il vaut 1,00 partout**. Il
ne distingue plus rien et n'ajoute qu'un décalage constant. Le modèle de pose
place deux yeux confiants sur des visages vus de trois quarts arrière, où l'un
est occulté — c'est une propriété du détecteur, pas de la formule.

D'où les erreurs, qui ont toutes la même signature : à 0,465, 0,467, 0,504 et
0,538, deux termes sur trois disent « tourné » (`ea` proche de 1, `sh` entre 0,35
et 0,50) et le terme d'œil à 1,00 remonte la moyenne au-dessus du seuil.

**Aucun seuil unique ne sépare proprement.** Lu à l'image, la frontière est vers
0,60 à 0,65, mais des profils francs subsistent jusqu'à 0,71 et des visages
exploitables descendent à 0,54. La masse aide peu : le creux de la distribution
est entre 0,4 et 0,5 (1,7 % des boîtes), donc bien en dessous de ce que l'œil
demande.

Ça oriente la conception plutôt que de la bloquer. **La décision doit rester
relative** — un écart net entre deux personnes du même plan — et non absolue.
Dans un même plan, les deux personnes partagent le détecteur, l'éclairage et
l'angle de caméra, donc leurs biais se compensent dans la différence là où ils
s'ajoutent dans la valeur. `frontalThreshold` ne sert alors qu'à l'étiquette
`facing`, qui est un diagnostic et non une décision.

Il est passé de 0,35 à **0,60** le 20 août, sur deux mesures indépendantes : la
planche montre des profils francs étiquetés `frontal` jusqu'à 0,54, et sur les
17 927 images du jeu auto-supervisé, 0,35 range 97,7 % des boîtes du même côté.
Le nouveau seuil rend l'étiquette honnête ; il ne la rend pas juste, et aucune
valeur ne le ferait. Les quatre cas d'étalonnage ne basculent pas.

### Ce que ça donne à l'image

`scripts/spike/orientation-ab.ts` compose, par cas, trois panneaux : la source
avec les deux rectangles de crop, la sortie verticale d'aujourd'hui et celle du
candidat. L'instant choisi dans le plan est **le plus défavorable au
resserrement**, celui où l'empan est le plus large — un avant/après qui choisit
sa meilleure image ne prouve rien.

Sur `2026-05-31-nabla` à 2 707,5 s, frontalité 0,70 contre 0,23 : la sortie passe
de 31,7 % à 100 % de hauteur de canevas, et l'homme de profil sort entièrement du
cadre. C'est l'effet voulu.

Les trois contrôles négatifs — deux personnes de face, une seule personne, deux
personnes de profil — rendent des panneaux identiques, à un déplacement de
`cropX` de 0,0003 près sur le troisième, soit moins d'un pixel sur 960.

---

## La bouche est lisible sur le proxy

Le proxy fait 960×540 à 30 im/s et porte sa piste audio ; `audio.wav` existe déjà
en 16 kHz mono. Rien à aller chercher sur le Drive.

Une tête y fait environ 90 pixels de large et une bouche 25 sur 12. C'est peu, et
c'était le pari le plus incertain du spike. Vérifié à l'image, agrandi six fois :
les lèvres, l'ouverture sombre et le menton se distinguent. Un signal d'énergie
temporelle sur ce patch a de quoi mordre.

`worker/spike_mouth.py` décode un intervalle à 30 im/s, passe `yolo11m-pose` et
écrit par personne et par image un patch de bouche en 32×32, les points bruts et
l'enveloppe RMS de l'audio à 100 Hz. Sur les 45 s du plan de référence : 1 353
images, deux personnes présentes à ~100 %, 1,8 Mo.

**La géométrie de la région de bouche a été fausse deux fois, et seules les
images de contrôle l'ont dit.** D'abord un carré de la taille d'une tête entière,
centré sur le nez, donc décalé du côté opposé au visage : chez l'un il tombait
sur le fauteuil, chez l'autre sur le fond. Ensuite un décalage le long du vecteur
œil → nez, qui marche de face et échoue de profil — vu de côté, ce vecteur est
presque horizontal, et le prolonger pousse devant le visage au lieu de descendre
vers la bouche.

La construction retenue garde la longueur de ce vecteur comme échelle, parce
qu'elle suit la taille du visage sans dépendre du lacet, et prend sa direction
ailleurs : la perpendiculaire à l'axe des yeux quand les deux sont visibles, la
verticale image sinon.

Deux drapeaux distincts, et pas un seul : `present` dit que le rang porte une
détection, `mouth` qu'une région de bouche a pu être posée. Les confondre faisait
perdre des boîtes et des points parfaitement valides sur une tête tournée dont le
nez n'était pas assez confiant.

### Une bande de patchs vaut mieux que six images pleines

`--strip` écrit une image portant, par personne, soixante patchs consécutifs
agrandis et alignés dans le temps. Six vues pleines disent où l'on a visé ; la
bande dit ce que le signal attrape, et si ça bouge.

Sur les 45 s du plan de référence, elle sépare nettement les deux hommes. Chez
celui de droite, on voit une bouche : lèvres, ouverture sombre, dents, et l'ouverture
change d'une cellule à l'autre. Chez celui de gauche, on voit un nez
de profil sur du noir — la région est bien posée, mais cet homme garde la tête
baissée et tournée, du côté sombre du plateau.

**Une personne dont la bouche n'est pas observable ne doit pas être déclarée
silencieuse.** Sans cette règle, le détecteur choisit systématiquement celui
qu'on voit le mieux, et il aura l'air de marcher. C'est la même doctrine que
l'`unknown` de l'orientation : sur un intervalle où l'un des deux n'est pas
mesurable, la décision est « je ne sais pas », et le repli garde les deux
personnes dans le cadre.

---

## Ce que la règle rejette, et pourquoi

À l'échelle du plan entier, la règle du cas 2 ne retient que 162 s, soit 8,0 %
du montage, sur les 878 s du gisement. La ventilation des rejets :

| cause | temps | part du montage |
|---|---|---|
| `noGap` — l'écart médian est sous la marge | 364 s | 18,0 % |
| `unknownVeto` — la perdante est `unknown` quelque part | **0 s** | 0,0 % |
| `winnerFlips` — le gagnant change en cours de plan | 178 s | 8,8 % |
| `shareTooLow` — l'écart n'est décisif que sur trop peu d'images | 175 s | 8,6 % |
| `ratioUnchanged` — tout est net mais le ratio ne bouge pas | 0 s | 0,0 % |

Le veto sur `unknown` était le coupable désigné et **il ne rejette pas une
seconde**. Le desserrer n'achète rien tant qu'un autre réglage ne rend pas
d'abord des plans éligibles.

Les deux vrais goulots disent la même chose sous deux angles : **sur un plan
réel, la frontalité ne tient pas en place**, ni dans sa direction, ni dans sa
constance. Les gens bougent. Les 17,4 % qui manquent ne demandent donc pas une
meilleure règle, ils demandent une **frontière plus fine** — et c'est le même
mécanisme dont le suivi du locuteur aurait besoin.

### Un visage imprimé n'est pas une personne

Deux des six cas soumis à l'examen visuel ne gagnent rien, pour la même raison.
Sur `2026-05-31-nabla` à 988,5 s, le détecteur pose une boîte de personne sur la
femme imprimée d'une jaquette de DVD qu'un comédien brandit, avec une tête posée
sur son visage imprimé et une **frontalité de 0,96, plus haute que celle des deux
vrais comédiens**. Le plan compte alors trois personnes et la règle, qui n'agit
qu'à deux, ne se déclenche plus.

C'est pire qu'un manque à gagner. Sur une image à deux boîtes dont l'une serait
une affiche, la règle cadrerait **sur l'affiche**. L'issue #69 documente les faux
positifs sur du mobilier ; les visages imprimés sont une famille distincte, et
sur une émission qui parle de culture pop ils sont systématiques — jaquettes,
livres, écrans.

Un remède se présente tout seul : un visage imprimé ne bouge pas la bouche.

---

## Qui parle : la voie la moins chère est fermée

L'hypothèse : la bouche qui bouge **en synchronie avec le son** est celle qui
parle. Le mouvement seul ne discrimine pas — rires, hochements, mastication —,
c'est la synchronie qui devait trancher.

L'évaluation n'a demandé **aucun étiquetage humain**. Sur les plans où une seule
personne est à l'écran, on sait qui parle sans le demander : c'est elle. Le
corpus en porte 3 031 s. La vérité vient des instants de **mots** du transcript,
pas des segments, qui couvrent aussi leurs silences.

Tirage : 48 fenêtres, 634 s, 19 020 images, 17 927 mesurables, dont 74,5 %
portent de la parole.

| mesure | AUC corpus | AUC médiane par fenêtre | Pearson |
|---|---|---|---|
| `rawDiff` | 0,523 | 0,492 | 0,077 |
| `normDiff` | 0,502 | 0,496 | 0,142 |
| `centerDiff` | 0,509 | 0,498 | 0,127 |
| **`noseShift`, témoin de bruit de tête** | **0,551** | 0,491 | 0,001 |

**Le témoin bat les trois mesures de bouche.** C'est le verdict qu'il existait
pour rendre.

Le contrôle négatif ne fait pas s'effondrer l'AUC, parce qu'il n'y avait rien à
effondrer : elle est déjà à 0,5, et deux fois la vérité décalée fait mieux que la
vraie. La corrélation, elle, tombe bien de 0,127 à 0,021 — mais sa médiane par
fenêtre vaut 0,014. C'est une covariance **entre** extraits, les passages
bruyants étant aussi ceux où ça bouge, et non un lien à l'intérieur d'un plan.

La courbe de décalage, cherchée entre −8 et +8 images, est plate : 17 %
d'amplitude sur ±267 ms, aucun pic.

Les trois explications commodes ont été éprouvées et écartées :

- **l'orientation** — restreindre aux visages de face ne gagne rien (0,511
  contre 0,509) ;
- **le mouvement de tête** — restreindre au tiers d'images où la tête est la plus
  immobile fait *baisser* l'AUC à 0,476 ;
- **la résolution** — la région de bouche fait 55 × 42 px en médiane sur le proxy,
  redimensionnée en 32×32, donc sur-échantillonnée plutôt que l'inverse.

**Conclusion : bâtir un détecteur de locuteur sur une statistique de différence
d'images donnerait un pile-ou-face.** Le critère d'arrêt était écrit d'avance et
il s'applique.

Ce que ce résultat ne dit pas : il ferme la statistique de pixels, pas la
détection audiovisuelle de locuteur. Un modèle appris comme Light-ASD ou TalkNet
travaille sur un plongement avec du contexte temporel, pas sur une différence
image à image, et il n'est pas réfuté ici. La piste audio — diarisation, ancrage
sur les gros plans, ré-identification par la couleur du buste — n'a pas été
essayée non plus.

---

## Les sous-plans, et ce qu'ils gagnent vraiment

`scripts/spike/subshots.ts` subdivise chaque plan en intervalles, chacun gardant
un crop fixe, et suit la personne la plus de face quand l'écart est décisif. La
partition reste exacte — aucun trou, aucun recouvrement, vérifié sur les quatre
émissions et les quatre variantes.

Rien du cœur n'est modifié : `computeFraming` reçoit des `people` filtrées et des
`shots` subdivisés, et fait le reste.

Gain, en part du temps de montage dont la sortie verticale **remplit le
canevas** :

| variante | corpus | ce qu'elle isole |
|---|---|---|
| `today` | 7,7 % | le comportement actuel |
| `candidate` | **41,1 %** | subdiviser et suivre la plus de face |
| `randomWho` | 39,3 % | mêmes frontières, sujet **tiré au sort** |
| `evenCuts` | 33,6 % | coupes **régulières**, choix par frontalité |

Le risque ne monte pas : les têtes perdues **parmi les personnes gardées**
passent de 19 images-personne aujourd'hui à 14 pour le candidat. Subdiviser ne
coûte aucun visage. Les 1 350 images-personne de têtes **écartées** sont l'effet
voulu, pas une faute, et les confondre ferait crier au désastre pour ce qu'on
cherche à faire.

Le prix se paie en respiration : 2,67 coupes de plus par minute, et les
changements de taille de canevas passent de 3,14 à 5,43 par minute.

### La métrique ne peut pas juger le choix, et il faut le dire

`candidate` ne bat `randomWho` que de 1,8 point sur les 33,4 gagnés, soit 5 %.
Le témoin est pourtant bien exercé : il désigne l'autre rang sur 62,4 % du temps
où le candidat suit quelqu'un, et six graines le situent entre 38,9 et 40,4 %.

La conclusion facile serait que le choix ne sert à rien. Elle est fausse, et
c'est un piège de mesure qu'il faut nommer : **cadrer sur la mauvaise personne
remplit le canevas exactement aussi bien que cadrer sur la bonne.** La grandeur
mesurée est le remplissage, pas la justesse. Aucun chiffre de cadrage ne verra
jamais la différence, et en construire un ne changerait rien — c'est le contenu
qui est en cause, pas la géométrie.

Le choix se juge donc à la vidéo, avec le son : on voit qui est cadré, on entend
qui parle. C'est ce que produit `scripts/spike/subshot-ab.ts` — trois panneaux
côte à côte, chacun un vrai canevas 9:16 passé par `blurredVariantArgs`, donc ce
que le rendu produirait et non une démonstration.

Et la vidéo tranche en un dixième de seconde. Sur `2025-06-15-cqlp` à 2 107 s,
au même instant :

| panneau | ce qu'on voit |
|---|---|
| aujourd'hui | un 1:1 en boîte aux lettres, les deux comédiens minuscules |
| candidat | plein canevas sur l'homme, face caméra, en train de parler |
| témoin | plein canevas sur **la nuque de la comédienne**, pas un visage |

Les deux derniers remplissent le canevas à l'identique et la métrique leur donne
la même note. **Le choix compte énormément ; c'est la mesure qui est aveugle.**

Le contrôle négatif, un gros plan à une personne, est mieux qu'indiscernable :
les trois panneaux ont un PSNR **infini** sur douze secondes, donc ils sont
identiques bit à bit. Sur un cas où les cadrages diffèrent, le même PSNR vaut
14,3 dB.

### Ce que la comparaison mesure légitimement

`evenCuts` fait 33,6 % contre 41,1 %, soit **7,5 points, quatre fois ce que vaut
le choix**. Cette comparaison-là est valide : le placement des frontières décide
si un cadre serré est seulement possible sur un intervalle, et la géométrie le
voit.

Ce que la frontalité apporte n'est donc pas *qui* suivre, mais *où* couper.

### Les replis, et le prix des visages imprimés

La règle ne se déclenche pas partout, et la ventilation dit pourquoi :

| cause | temps | part du montage |
|---|---|---|
| écart de frontalité insuffisant | 600 s | 29,7 % |
| moins de deux personnes | 238 s | 11,8 % |
| **plus de deux personnes** | **208 s** | **10,3 %** |
| une frontalité `unknown` | 89 s | 4,4 % |

**Les 208 s de « plus de deux personnes » viennent pour 166 s de `caro-mdlm`
seule**, soit la moitié du montage de cette émission. C'est le faux positif sur
visage imprimé : une boîte de plus fait passer le plan à trois personnes, et une
règle qui n'agit qu'à deux se tait. Un filtre rendrait presque tout son effet
sur une seule émission.

### Les deux réglages, et ce qu'ils coûtent

`--min-hold` est bon marché : de 1 s à 4 s, le gain ne perd que 3,5 points et la
cadence tombe de 3,50 à 1,48 coupe par minute. Le confort ne se paie presque pas.

`--ratio-lock shot` coûte cher, et par un mécanisme qu'on n'attendait pas.
Verrouiller le ratio met tous les sous-plans d'un plan à la même largeur, donc
leurs crops se recouvrent presque toujours, donc le garde-fou du faux raccord les
refuse en bloc : 0,15 coupe par minute et 25,8 % de gain. Ce n'est pas un défaut
du garde-fou, c'est sa conclusion juste — à ratio verrouillé, la plupart de ces
coupes *sont* des faux raccords. Le compromis reste défendable : 25,8 % contre
7,7 % aujourd'hui, avec **moins** de respiration qu'aujourd'hui, 2,97 par minute
contre 3,14.

Aucune des huit lignes du balayage n'achète du gain en coupant des têtes : le
risque parmi les gardées tient entre 13 et 14 images-personne partout.

### Le garde-fou du faux raccord se rapporte au crop le plus large

Écrit d'abord au plus étroit, ce qui se lit spontanément, puis mesuré : un 9:16
entièrement contenu dans le 16:9 voisin note alors un recouvrement de 1,00, donc
**toute** coupe touchant un plan large est refusée, et 45 % du montage de `nabla`
refusionne. Or ce cas n'est pas un faux raccord, c'est un **cut-in** — la scène
entière, puis une personne, 31,6 % → 100 % de canevas. Le vrai faux raccord est
deux cadres de même taille au même endroit, et c'est lui que le rapport au plus
large note à 1,00.

---

## Ce qui reste ouvert

- Une frontalité calculée sans le terme d'épaules est-elle exploitable ? Le cas
  ne pèse que 3 % des boîtes ; le basculer en `unknown` serait sans danger,
  puisque `unknown` n'exclut personne.
- Les faux positifs sur les visages imprimés, à consigner en commentaire sur
  l'issue #69 plutôt qu'en issue neuve.
- Le plafond de gain annoncé par `addressable.ts` est optimiste : ses colonnes
  `ratioIfRank0/1` ne comptent que les images à exactement deux personnes, alors
  qu'un cadrage réel doit aussi satisfaire les images à une ou trois personnes du
  même plan.
- Les frontières de segments du transcript sont des candidates naturelles pour
  les sous-plans : 14 segments dans les 45 s du plan de référence, durée médiane
  3,02 s. Les adopter supprimerait en revanche le contrôle qui devait vérifier
  l'alignement des bascules sur les tours de parole.
- `chargerEnv()` résout les secrets 1Password au démarrage de tout script, y
  compris ceux qui n'appellent aucun modèle. Chaque script de mesure doit poser
  `GEMINI_API_KEY` à une valeur littérale pour ne pas rester bloqué.
