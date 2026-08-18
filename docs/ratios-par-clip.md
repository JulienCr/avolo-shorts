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
  filtre du premier plan.

## Discipline de mesure

Compter des ratios est déterministe : une passe suffit, et la variance de 40 à
80 % que `CLAUDE.md` documente ne concerne que les mesures de temps. Les seuls
chiffres de durée ici sont ceux de la chaîne relancée sur `caro-mdlm` — transcript
167 s, repérage 155 fenêtres sur 155, analyse 196 s pour 2 h 50 —, pris à
`loadavg` 7 pendant que d'autres agents tournaient : des ordres de grandeur, pas
des mesures de performance.
