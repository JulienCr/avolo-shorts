# Le filtre du premier plan

Mesuré le 18 août 2026, sur `2025-06-15-cqlp` et `2026-03-08-caro-mdlm`.
Reproductible par `scripts/mesure-premier-plan.ts` et
`scripts/vignettes-premier-plan.ts`.

## Le constat de départ

Le cadrage automatique sortait tous les clips de `2025-06-15-cqlp` en 16:9 —
le ratio le plus large, c'est-à-dire aucun cadrage. La cause était connue :
34 % des boîtes de personnes y sont des têtes de spectateurs au premier rang,
collées au bas de l'image, une à chaque bord. Leur empan va de 0 à 1 pendant que
les comédiens tiennent dans le tiers central.

Ce qui n'était pas connu, c'est **où passer la frontière**. Couper sur le seul
bord bas ne laisse survivre que 16 % des boîtes : les comédiens jouent debout et
leurs pieds sont au bas du cadre eux aussi. Un filtre qui gagne le ratio en
perdant les comédiens n'a rien gagné.

## Ce qui a été compté, et sur quoi

| | `2025-06-15-cqlp` | `2026-03-08-caro-mdlm` |
|---|---|---|
| Durée | 1 h 39 | 2 h 50 |
| Plans | 131 | 1 483 |
| Boîtes | 31 407 | 45 362 |
| Boîtes touchant le bord bas (`y1 ≥ 0,97`) | 84,2 % | 69,4 % |

L'`analysis.json` de `caro-mdlm` n'était plus sur le disque. La détection a été
relancée : **194 s pour 2 h 50** (62 s de score de scène, 131 s de YOLO à
155 im/s), sur une machine à `loadavg` 6 parce que d'autres agents tournaient.
Une passe, pas trois : c'est un ordre de grandeur pour décider si ça vaut le
coup, pas une mesure de performance. Le résultat vit dans un dossier temporaire
et n'a pas été écrit dans `projects/`.

## Les deux populations

Sur la population entière, la hauteur des boîtes est déjà bimodale, mais les
deux modes se touchent assez pour qu'aucun seuil ne soit défendable.
**Conditionnée au contact du bord bas, la séparation devient nette** :

| Hauteur de la boîte | Boîtes collées au bord bas, sur `cqlp` |
|---|---|
| moins de 0,08 | 224 |
| 0,08 à 0,25 | 10 173 — le mode du public |
| 0,25 à 0,32 | 194 |
| **0,32 à 0,40** | **29** — le creux |
| 0,40 à 0,45 | 203 |
| 0,45 et plus | 15 613 — le mode des comédiens |

Vingt-neuf boîtes sur 26 436, soit 0,11 %. **Le seuil de 0,35 est le fond de ce
creux, il n'est pas choisi** : le déplacer de ±0,03 ne change presque rien, et
c'est ce qui en fait un réglage tenable.

Les deux populations se décrivent bien par ailleurs, ce qui rassure sur le fait
qu'on sépare bien deux choses et non deux queues d'une même :

| Médiane | Boîtes courtes | Boîtes hautes |
|---|---|---|
| `y0` | 0,84 | 0,17 |
| `y1` | 0,997 | 0,989 |
| largeur / hauteur | 1,02 | 0,29 |
| score du détecteur | 0,67 | 0,92 |

## Ce que les images ont montré, et que les chiffres cachaient

Une trentaine d'images tirées du proxy aux instants des boîtes, de part et
d'autre de chaque frontière candidate. Trois choses en sont sorties, et **aucune
n'était visible dans un histogramme**.

**Le rapport largeur/hauteur ne tranche pas.** Il paraissait le meilleur
candidat : scale-invariant, un corps debout est trois fois plus haut que large,
une tête tronquée est carrée. Mesuré, il laisse 11,4 % des boîtes dans la bande
d'incertitude `[0,5 ; 0,8[`, contre 0,8 % pour la hauteur. Et à 1 797,5 s, une
tête de spectateur **vue de profil** donne 0,33 — exactement la signature d'un
corps debout.

**La hauteur seule jette des comédiens.** À 419 s, deux comédiens assis dans le
noir donnent des boîtes de 0,27 de haut, qui flottent au milieu du cadre à
`y1 ≈ 0,47`. Une hauteur minimale sans condition de bord vide ce plan de ses deux
comédiens. Le cas est marginal sur `cqlp` — 97 boîtes — et **massif sur
`caro-mdlm`, où 3 075 boîtes sont courtes et détachées du bord bas**. Calibrer
sur une seule émission aurait produit exactement la régression silencieuse qu'on
craignait.

**Le bord bas seul jette les comédiens debout**, ce qu'on savait, et les images
le confirment sans ambiguïté : à 555,5 s comme à 470,5 s, les deux comédiens
touchent le bas du cadre par les pieds pendant que trois têtes de spectateurs le
touchent par le haut du crâne.

## Le discriminateur retenu

Une boîte est du premier plan si elle est **tronquée par le bord bas** et que ce
qui en reste est **court** :

```
y1 ≥ 0,97   et   y1 − y0 < 0,35
```

Les deux moitiés sont nécessaires et chacune a son contre-exemple ci-dessus. Le
critère décrit une situation physique et pas une statistique : quelqu'un entre la
caméra et le plateau, dont le bas de l'image coupe le corps, et dont il ne reste
qu'une tranche.

Il vit dans `src/core/framing.ts` (`isForeground`), pas dans `worker/detect.py`.
Deux raisons. La sortie du détecteur est une **donnée** : un filtre posé dedans
est irréversible sans relancer le GPU, alors que relire un `analysis.json` est
instantané. Et le phénomène **n'est pas général** — 33,8 % des boîtes sur `cqlp`,
1,8 % sur `caro-mdlm` —, donc ce qui se règle doit vivre là où on le règle
(spec §5). Les deux seuils sont dans `FramingOptions`, avec le motif `réglage()`
qui refuse un `NaN` ; `foregroundMaxHeight: 0` éteint le filtre, ce qui est aussi
la façon dont l'avant/après se mesure sans deux versions du code.

## L'effet mesuré

### Sur `2025-06-15-cqlp`

|  | sans filtre | bord bas seul | filtre livré |
|---|---|---|---|
| Images mesurées | 10 745 | **3 823** | 10 743 |
| Empan médian | 0,661 | 0,213 | **0,540** |
| Images tenant dans un 1:1 | 31,3 % | 90,4 % | **55,1 %** |
| Clips réels (10) en 16:9 | 10 | 4 | **10** |
| Fenêtres de 30 s (197) en 16:9 | 182 | 77 | **157** |

**La colonne du milieu est un piège, et c'est pour ça qu'elle reste dans la
sortie du script.** Le filtre naïf semble largement meilleur : il fait descendre
six clips sur dix et quatre-vingt-dix fenêtres en 9:16. Mais il ne mesure plus
que 3 823 images sur 10 745 — il en vide 64 % de toute détection. Ses 90,4 %
portent sur le tiers d'images où un comédien se trouvait détaché du bas ; sur les
deux autres tiers, il ne cadre plus rien du tout.

Le filtre livré perd **deux images sur 10 745** et fait le reste du chemin.
Aucune fenêtre ne s'élargit, vingt-cinq se resserrent.

### Sur `2026-03-08-caro-mdlm`, le contre-exemple

Le filtre y est presque inerte, comme attendu : 832 boîtes écartées sur 45 362
(1,8 %), empan médian 0,765 → 0,757, une seule fenêtre déplacée sur 339. **C'est
le résultat qu'on voulait** : un filtre calibré sur `cqlp` ne devait pas coûter
quoi que ce soit ailleurs.

La fenêtre déplacée l'est **vers le large**, et elle mérite son paragraphe. À
9 071 s, la seule détection de trente secondes est un **poisson rouge du
générique de fin**, à 0,57 de confiance, collé au bas du cadre. Sans le filtre,
la fenêtre se cadrait en 9:16 sur le poisson. Avec, il ne reste rien à mesurer et
`chooseRatio` rend le ratio le plus large. Entre une faute silencieuse et une
faute voyante, la conception a choisi la voyante ; c'est ce qui se produit ici.

## Ce que le filtre ne fait pas, et qu'il faut dire

**Les dix clips réels de `cqlp` restent tous en 16:9.** C'est le chiffre qui
juge la tâche, et il ne bouge pas. Vérifié à l'image sur quatre d'entre eux : le
16:9 y est **honnête**. Les deux comédiens sont réellement aux deux bords du
cadre, le filtre écarte bien les spectateurs, et l'empan résiduel est celui des
comédiens seuls. À 1 924 s il vaut 0,61 pour un 1:1 qui en couvre 0,5625 : il
manque cinq centièmes, dont quatre viennent de la marge de confort de 2 % par
côté.

Il y a donc deux choses à ne pas confondre, et la confusion était déjà dans le
ROADMAP :

- **« la part des images dont l'empan tient dans un 1:1 »** — 31,3 % → 55,1 % ;
- **« la part des clips que `chooseRatio` sort en 1:1 ou plus serré »** — 20 %
  sur les fenêtres de 30 s.

Le second est bien plus dur que le premier, et ce n'est pas un défaut : le crop
est **fixe à l'intérieur d'un plan** et doit cadrer 90 % des images du clip. Une
image cadrable isolément ne l'est pas forcément par la position qui cadre ses
voisines. Un chiffre par image ne prédit donc pas un ratio par clip, et l'écart
entre les deux ne se referme pas en améliorant le filtre.

Trois pistes restent ouvertes, aucune n'est de ce ressort :

1. **La marge de 2 %.** Elle coûte 0,04 d'empan et arbitre plusieurs clips de
   `cqlp` autour du seuil du 1:1. C'est un réglage de confort qui n'a jamais été
   mesuré ; il vaut d'être repris avec un rendu sous les yeux.
2. **Le seuil de 90 % de `chooseRatio`.** Sur le clip `..._002724960-002816945`,
   140 images sur 184 ont un empan qui tient dans un 1:1 — donc **au mieux** 76 %,
   et une position fixe par plan en cadre encore moins. La conception le veut et
   elle a ses raisons ; le dire évite qu'on cherche un bug.
3. **`caro-mdlm` cadre encore plus large que `cqlp`** : 13,8 % d'images dans un
   1:1 contre 55,1 %, et 334 fenêtres sur 339 en 16:9. Le public n'y est pour
   rien. Si le cadrage automatique doit rendre autre chose que du 16:9 sur cette
   émission-là, la réponse est ailleurs que dans ce filtre.

## Ce qui reste incertain

- **Deux émissions, dont une seule avec du public au cadre.** Le seuil de 0,35
  est calé sur le creux de `cqlp`. Rien ne dit qu'une salle plus proche ou un
  objectif plus court ne le déplacerait pas. C'est un réglage, précisément pour
  ça.
- **Le générique d'archive.** À 373 s, le montage d'ouverture montre une vraie
  salle de théâtre, et les silhouettes des premiers rangs y sont hautes de plus
  de 0,42 : le filtre les garde. Ce sont bien des spectateurs, et ils élargissent
  l'empan. Le cas est sans conséquence — un générique ne devient pas un clip —
  mais il montre la limite : le critère reconnaît une **troncature par le bord
  bas**, pas un spectateur.
- **Les détections sur le panneau de chat de `cqlp`.** Soixante-dix-sept boîtes hautes de 0,35 à
  0,42 se posent dans la bande de droite, juste au-dessus du seuil. Elles
  survivent. Leur effet sur l'empan est faible parce qu'elles sont étroites et
  déjà du côté où les comédiens se trouvent.
- **Le score du détecteur n'a pas été utilisé.** Il sépare pourtant bien — 0,67
  de médiane pour le public contre 0,92 pour les comédiens. Un seuil de confiance
  plus haut aurait écarté une partie du public, et aussi les comédiens dans le
  noir, dont le score tombe à 0,42. Deux réglages qui tirent sur la même corde
  valent moins qu'un seul dont on sait ce qu'il fait.

## Reproduire

```bash
pnpm tsx scripts/mesure-premier-plan.ts 2025-06-15-cqlp
pnpm tsx scripts/vignettes-premier-plan.ts 2025-06-15-cqlp --frontiere 8
pnpm tsx scripts/vignettes-premier-plan.ts 2025-06-15-cqlp --large 6
```

Le premier imprime les trois lectures comparées ci-dessus. Les deux autres
écrivent des vignettes dans un dossier temporaire : **vert** ce que le cadrage
garde, **rouge** ce que le filtre écarte, **gris** ce que le seuil de confiance
écarte avant lui — le détecteur écrit dès 0,25 et le cadrage ne lit qu'à partir de
0,5, et peindre ces boîtes-là en vert ferait mentir la vérification sur ce qu'elle
montre.

`--frontiere` tire les images au voisinage du seuil, là où le filtre hésite :
c'est le tirage qui vaut le plus, et c'est celui qui a produit les trois
contre-exemples de cette page. `--large` prend les moments les plus larges après
filtrage, un par plan au plus — les images les plus larges d'une émission sont
contiguës, et les six premières du classement brut montrent six fois la même
seconde.

Pour une émission dont l'`analysis.json` n'existe plus, la détection se relance
en quelques minutes et son résultat se lit directement :

```bash
./worker/venv/bin/python worker/detect.py \
  --proxy projects/<projet>/proxy.mp4 --out /tmp/analyse.json \
  --ffmpeg "$FFMPEG_BIN" --model worker/models/yolo11m.pt \
  --duration <secondes> --proxy-size 960x540 --source-size 1920x1080
pnpm tsx scripts/mesure-premier-plan.ts --analyse /tmp/analyse.json
```
