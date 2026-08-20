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

## Ce qui reste ouvert

- Le seuil `frontalThreshold` doit être relevé, et la valeur se tranche sur une
  planche centrée sur la frontière plutôt que sur un balayage.
- Une frontalité calculée sans le terme d'épaules est-elle exploitable ? Si non,
  le cas doit passer en `unknown`, ce qui est sans danger puisque `unknown`
  n'exclut personne.
- La règle du cas 2 rejette 353 s de plans dont l'écart de frontalité médiane
  dépasse pourtant 0,25. La cause est en cours de ventilation.
- Le cas 2 mesuré à l'échelle du plan entier vaut 8,0 % du montage. L'orientation
  change à l'intérieur d'un plan comme la parole, donc la même mesure à l'échelle
  du sous-plan vaudrait plus.
- Les frontières de segments du transcript sont des candidates naturelles pour
  les sous-plans : 14 segments dans les 45 s du plan de référence, durée médiane
  3,02 s. Les adopter supprime en revanche le contrôle qui devait vérifier
  l'alignement des bascules sur les tours de parole.
- `chargerEnv()` résout les secrets 1Password au démarrage de tout script, y
  compris ceux qui n'appellent aucun modèle. Chaque script de mesure doit poser
  `GEMINI_API_KEY` à une valeur littérale pour ne pas rester bloqué.
