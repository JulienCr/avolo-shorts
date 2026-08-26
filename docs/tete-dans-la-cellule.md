# La tête dans la cellule : l'instrument, et ce qu'il mesure

Mesures faites le 26 août 2026, sur le code de cette PR
(`tooling/framing-head-instrument`), à partir de la base `94e89e2`, complétées
le même jour après un checkpoint du propriétaire du dépôt (deuxième section
« Ce que le checkpoint a changé »). Répond à l'issue #190 pour sa première
moitié — « présence et intégrité de la tête » — sans toucher à la seconde
(profil contre trois-quarts dos, hors périmètre).

**Ce document mesure, il ne décide pas.** Les indicateurs qu'il présente ne
sont câblés dans aucune règle : `computeShotSplit` n'a pas changé de
comportement, `pnpm tsx scripts/framing-cases.ts verify` le confirme (dernière
section). Le seuil, et la barre de présence à retenir, sont une arbitration
humaine sur planche, prévue pour une PR ultérieure (PR-D).

## L'instrument

Dans `src/core/framing.ts` :

- **`headContainment(box, cell, options)`** — la part de la tête d'une
  personne qui tombe dans une cellule de split. `null` quand `headBounds` ne
  se définit pas, **ou quand la tête est dégénérée** (moins de deux points
  confiants, ou une aire nulle — deux points alignés) : voir la section
  suivante, c'est le correctif du checkpoint.
- **`headPointCount(box, options)`** — combien des cinq points de tête (nez,
  deux yeux, deux oreilles) passent `torsoMinScore`. N'existait pas dans la
  première livraison ; ajouté pour rendre visible ce que `headContainment`
  ne pouvait que cacher derrière un `null`. N'écrit pas dans `headBounds`,
  qui garde ses six autres appelants intacts.
- **`computeShotHeadInstrument(...)`** — agrège par cellule, sur les images
  **appariées** d'un plan (jamais une seule image). Réutilise l'appariement
  et les cellules de `computeShotSplit` lui-même (`splitPairs`, `splitCells`,
  `splitBleed`, `splitLeftOnTop`, extraits en fonctions partagées) plutôt que
  de les recalculer — voir la note sur ce refactor dans le corps de la PR.

Deux métriques dans `scripts/framing/metrics.ts` : `head-absence-worst`
(sur `headBounds`, jamais sur `headContainment` — voir plus bas pourquoi
c'est un choix et non un oubli) et `head-containment-worst`, chacune le pire
des deux cellules. **Une cellule dégénérée ne se laisse plus remplacer par
l'autre** : si l'une des deux cellules ne rend pas de containment mesurable,
la métrique entière rend `null` plutôt que de répondre avec la seule cellule
qui, elle, va bien — sans quoi le cas exactement visé par ce document
disparaîtrait de la mesure.

## Ce que le checkpoint a changé

Le premier jet de ce document rapportait deux cas `drop` liés à la tête —
`nabla-6418667`, `entre-nous-3495867` — comme indiscernables des trois cas
`keep`. Vérifié à l'image (`framing-thumbnails.ts`) : dans les deux cas, un
**point unique** (une oreille aperçue de dos) passait le seuil de confiance de
`headBounds`, produisant une tête d'aire nulle que `headContainment` lisait
comme « contenue » (1) plutôt que comme une question qui ne se pose pas.

Deux corrections, une mesure supplémentaire :

1. **`headContainment` rend maintenant `null` sur une tête dégénérée**, au
   lieu de trancher 0 ou 1 sur une géométrie qui n'existe pas.
2. **`head-containment-worst` ne remplace plus une cellule dégénérée par
   l'autre.** Avant le correctif, une cellule `null` disparaissait
   silencieusement du calcul du pire, laissant l'autre cellule — souvent
   bonne — répondre à la place du plan entier. C'est exactement ce qui aurait
   continué à cacher `nabla-6418667` même après le correctif n°1 si on
   l'avait laissé filtrer les `null` comme avant.
3. **Une seconde barre de présence est mesurée, jamais choisie** : la
   première livraison exigeait **un seul** point de tête confiant pour dire
   « présent » (`headBounds` non nul). `orientationOf` pose déjà une règle
   voisine — « `frontality` exige deux contributions disponibles, jamais une
   seule ... en dessous de deux, `facing` vaut `'unknown'` »
   (`src/core/framing.ts:1041-1043`). Ce n'est pas une coïncidence : le dépôt
   a déjà tranché qu'un signal isolé ne suffit pas à dire quoi que ce soit
   d'une tête. La section « Deux barres de présence » applique la même règle
   à l'absence et rapporte les deux côte à côte, sans en câbler aucune.

**Ce qui n'a pas bougé** : `computeShotSplit` reste inchangé dans son
comportement (`pnpm tsx scripts/framing-cases.ts verify` produit une sortie
identique avant/après, voir dernière section). Les deux correctifs ne
touchent que `headContainment` et l'agrégation de `head-containment-worst`
dans `metrics.ts` — jamais `headBounds`, qui garde ses six autres appelants.

## La population, remesurée

L'issue #190 cite **489 plans splittés** ; `scripts/framing/corpus.ts` porte
encore ce chiffre en commentaire. Mesuré aujourd'hui, sur le même corpus et
par le même chemin (`sweepCorpus({ population: 'splits' })`) :

```
population (splits): 499
```

Soit le chiffre que #191 avait déjà trouvé le 26 août (`docs/lessons.md:281-297`),
pas celui de #190. Le corpus et le code du cadrage ont bougé entre les deux
mesures ; celle-ci est datée pour ne pas s'ajouter à la liste des chiffres qui
dérivent en silence.

## Un biais de corpus qui n'était écrit nulle part

Quatre des cinq analyses sur le disque ont été produites **avant** la fusion de
la PR #101 (« bascules de composition », `b2d3273`, fusionnée le 19 août 2026 à
22:17) ; seule `2026-04-24-fmr` la porte :

| Projet | `analysis.json` produite le | Après #101 ? |
|---|---|---|
| `2025-06-15-cqlp` | 19 août, 12:00 | non |
| `2026-03-08-caro-mdlm` | 19 août, 12:03 | non |
| `2026-05-31-nabla` | 19 août, 12:06 | non |
| `2026-22-02-entre-nous` | 19 août, 21:27 | non |
| `2026-04-24-fmr` | 23 août, 15:09 | oui |

Un balayage du corpus entier mélange donc deux régimes de frontières de plan.
Les sept cas de référence de l'issue reposent presque tous sur le régime
d'avant #101 — six sur sept, seul `fmr-1115733` vient du régime d'après. Aucune
conclusion de ce document ne s'appuie sur une comparaison entre les deux
régimes, mais le mélange reste réel et personne ne l'avait consigné jusqu'ici.

## Distribution sur les 499 plans splittés

```
head-absence-worst (part 0 à 1) — barre ≥ 1 point
  min 0.0000  déciles [0, 0, 0, 0, 0, 0, 0, 0, 0]  max 1.0000  médiane 0.0000
  499 / 499 défini

head-containment-worst (part 0 à 1)
  min 0.9482  déciles [1, 1, 1, 1, 1, 1, 1, 1, 1]  max 1.0000  médiane 1.0000
  496 / 499 défini — 3 plans rendent `null` (au moins une cellule dégénérée
  sur toutes ses images appariées)
```

**Les trois plans à `null`** — `cqlp-1366033`, `fmr-1115733`, `nabla-6418667`
— sont exactement trois des quatre cas `drop` liés à la tête du jeu de
référence. C'est le correctif n°2 qui les rend visibles : avant lui, les
trois rendaient `1.0000` (l'autre cellule, bonne, répondait à leur place).

**Les deux indicateurs se déclenchent rarement**, et c'est mesuré, pas
supposé (`docs/lessons.md`, « un signal qui se déclenche toujours n'est pas
un signal » — ici c'est l'inverse qu'il fallait vérifier) :

| Indicateur | Se déclenche sur |
|---|---|
| `head-absence-worst` > 0 | 33 / 499 plans (6,6 %) |
| `head-containment-worst` = `null` (dégénéré) | 3 / 499 plans (0,6 %) |
| `head-containment-worst` < 1 (mesuré, pas dégénéré) | 2 / 499 plans (0,4 %) |

Les deux plans à containment mesuré et inférieur à 1 (`nabla` 7409 s à
0,9482, `entre-nous` 3775,933 s à 0,9690) n'ont rien à voir avec la tête
dégénérée : ce sont de vrais recouvrements géométriques partiels, et les
deux se recoupent déjà avec `head-absence-worst` > 0 sur leur plan.

## Combien chaque indicateur retirerait, seul puis combiné

C'est le chiffre que #190 demande explicitement, en reprochant à la mesure
précédente (sur `frontality`) de n'avoir jamais compté ses deux causes
séparément :

| Seuil sur l'absence (part, barre ≥ 1 point) | Retire, seul |
|---|---|
| > 0 | 33 |
| > 0,1 | 10 |
| > 0,3 | 5 |
| > 0,5 | 3 |

| Seuil sur le containment | Retire, seul |
|---|---|
| = `null` (dégénéré) | 3 |
| < 1 (mesuré) | 2 |
| < 0,95 (mesuré) | 1 |
| < 0,9 (mesuré) | 0 |

**Combiné (absence > 0, OU containment `null`, OU containment mesuré < 1) :
34 plans sur 499 (6,8 %).** Contre 33 avant le correctif n°2 — un gain net
d'exactement un plan (`nabla-6418667`, le seul des trois `null` dont
l'absence reste à 0). Les deux autres plans à `null`
(`cqlp-1366033`, `fmr-1115733`) avaient déjà une absence positive ailleurs
dans le même plan, donc le correctif ne change pas leur statut « à retirer »,
seulement la raison qu'on peut lui attribuer.

**Le correctif rattrape un cas sur les deux qui avaient motivé le
checkpoint, pas les deux.** `entre-nous-3495867` reste à `containment = 1`
même après le correctif — voir pourquoi dans la section suivante. C'est la
barre de présence à deux points, mesurée ci-dessous et non câblée, qui le
rattrape.

## Falaise ou pente ?

Ni l'une ni l'autre au sens où #190 pose la question pour `frontality` (une
pente sans creux, de 227 à 16 plans sur onze tranches). Ici, la distribution
est **concentrée à zéro** : 93,2 % des plans à `absence = 0` ni `null`, ni
`containment < 1`. Un seuil à `> 0` n'est donc pas un choix arbitraire dans
une pente continue — c'est la limite naturelle entre « l'indicateur ne voit
rien » et « l'indicateur voit quelque chose ». Ce point diffère nettement du
cas de la frontalité. Mais — et c'est la réserve centrale de ce document —
**le fait que l'indicateur ne se déclenche presque jamais ne dit pas qu'il
capture tout ce qui doit l'être**, comme le montre `entre-nous-3495867`
ci-dessous.

## Deux barres de présence, mesurées côte à côte, aucune choisie

La première livraison de cet instrument exigeait **au moins un** point de
tête confiant pour dire « présent » — c'est `headBounds`, inchangé. Le
checkpoint demande de mesurer aussi **au moins deux** points, le seuil que
`orientationOf` applique déjà à `frontality` : « exige deux contributions
disponibles, jamais une seule ... en dessous de deux, `facing` vaut
`'unknown'` » (`src/core/framing.ts:1041-1043`). Ce n'est pas un choix
arbitraire pour ce document : c'est le seuil que le dépôt tient déjà ailleurs
pour la même question — un signal de tête isolé ne suffit pas à conclure.

**Cette seconde barre n'est câblée nulle part.** Elle est mesurée en dehors
de `headBounds` (qui garde ses six appelants et son seuil d'un point) via
`headPointCount`, sur les mêmes cellules et le même appariement que
`computeShotHeadInstrument` produit — jamais une seconde dérivation, mesuré
par un script qui rejoue `ShotFraming.split` et le même appariement par
proximité de centre que les fonctions `perFrame` de `metrics.ts` utilisent
déjà.

Corpus entier (499 plans splittés), part d'images sans tête par cellule,
pire des deux cellules :

| Barre | Se déclenche (> 0) sur | Décile 90 |
|---|---|---|
| ≥ 1 point (`head-absence-worst`, shippé) | 33 / 499 (6,6 %) | 0,000 |
| ≥ 2 points (mesuré, non câblé) | 85 / 499 (17,0 %) | 0,056 |

La barre à deux points se déclenche **plus de deux fois plus souvent**. Ce
n'est pas un défaut en soi — #190 demande justement de savoir ce qu'un
critère plus strict coûterait — mais c'est un fait à mettre devant l'arbitre
humain avant de choisir : la barre à deux points touche 52 plans de plus que
celle à un point, sur un corpus qui n'a pas encore été jugé à l'image au-delà
des huit cas de référence.

## Les huit cas de référence, sous les deux barres

Colonnes par cellule : part d'absence (barre ≥ 1 pt / barre ≥ 2 pts),
containment (médiane sur les images où il se définit), médiane du nombre de
points de tête, médiane de l'aire de tête (fraction de l'image, `null` si
jamais mesurable).

| Cas | Verdict | Cellule haute | Cellule basse |
|---|---|---|---|
| `nabla-2056800` | garder | 0,00/0,00 · 1,000 · 5 pts · 0,00262 | 0,00/0,00 · 1,000 · 3 pts · 0,00313 |
| `nabla-1798867` | garder | 0,00/0,00 · 1,000 · 4 pts · 0,00254 | 0,00/0,00 · 1,000 · 3 pts · 0,00310 |
| `nabla-1607967` | garder | 0,00/0,00 · 1,000 · 4 pts · 0,00264 | 0,00/0,00 · 1,000 · 3 pts · 0,00297 |
| `nabla-2077400` (trois-quarts dos, hors périmètre) | écarter | 0,00/0,00 · 1,000 · 4 pts · 0,00274 | 0,00/0,00 · 1,000 · 3 pts · 0,00271 |
| `nabla-6418667` (nuque) | écarter | **0,00/1,00 · `null` · 1 pt · 0,00000** | 0,00/0,00 · 1,000 · 4 pts · 0,00744 |
| `cqlp-1366033` | écarter | 0,00/0,00 · 1,000 · 4 pts · 0,00247 | **0,727/1,00 · `null` · 0 pt · 0,00000** |
| `entre-nous-3495867` | écarter | 0,00/**0,609** · 1,000 · 1 pt · 0,00000 | 0,00/0,00 · 1,000 · 4 pts · 0,00390 |
| `fmr-1115733` | écarter | **1,00/1,00 · `null` · 0 pt · `null`** | 0,00/0,00 · 1,000 · 4 pts · 0,00584 |

**Les trois cas `keep` sont propres sous les deux barres** : absence nulle,
containment plein, une médiane de 3 à 5 points par cellule, une aire de tête
toujours mesurable (≈ 0,0025 à 0,0031). Aucun faux positif.

**Sous la barre à un point (colonne shippée), deux des quatre cas `drop`
liés à la tête passent encore à travers** : `nabla-6418667` (containment
`null` mais absence à 0,00) et `entre-nous-3495867` (containment à 1,000,
absence à 0,00). **Sous la barre à deux points, les quatre sont attrapés**,
et aucun `keep` ne bascule : `entre-nous-3495867` monte à 0,609 sur sa
cellule haute, `nabla-6418667` à 1,000. `nabla-2077400` (trois-quarts dos,
hors périmètre de ce document) reste à 0,00 sous les deux barres — la barre à
deux points ne mord pas sur la seconde moitié du critère de #190, qu'elle
n'a pas à trancher.

## Pourquoi les deux cas manqués passent à travers — vérifié à l'image

`headBounds` déclare une tête présente dès qu'**un seul** des cinq points du
visage passe `torsoMinScore` (0,5 par défaut). Sur `entre-nous-3495867`, la
personne de dos (Baba) ne montre jamais son visage de face, mais un point
unique — son oreille visible — franchit ce seuil sur une partie des images :

```
box x[0.0003, 0.2598] head { x0: 0.1961, y0: 0.6505, x1: 0.1961, y1: 0.6505 }
```

Une tête réduite à un point (`x0 === x1`, `y0 === y1`) : avant le correctif,
`headContainment` la lisait comme une simple appartenance à la cellule — elle
y est, donc `containment = 1`. Vérifié à l'image
(`scripts/framing-thumbnails.ts`) : le point magenta tombe exactement sur
l'oreille visible, aucun autre repère du visage. **Après le correctif, ce
point unique rend `null`** — mais sur ce plan précis, 39 % des images
montrent malgré tout un second point (souvent le nez, en amorce de
mouvement), suffisant pour que le sous-ensemble mesurable de `containment`
ait une médiane de 1,000. La barre à un point ne peut donc pas s'en sortir
seule ; c'est la **part** d'images sous la barre à deux points (0,609) qui
porte le signal.

`nabla-6418667` (« nuque, `facing == 'unknown'` ») est plus tranché : sur les
dix-sept images du plan, la cellule concernée ne porte **jamais** plus d'un
point de tête confiant — d'où `containment = null` (attrapé par le correctif
n°2 seul, sans même la seconde barre) et `pointsMed = 1`, `areaMed = 0`.

**Ce n'est pas un défaut de `headContainment` ou de `computeShotHeadInstrument`**
tels qu'ils étaient spécifiés dans la première livraison — les deux
appliquaient fidèlement ce que le contrat demandait alors. C'est une
propriété de `headBounds`, partagée avec tout le reste du module, qui n'a
jamais eu besoin jusqu'ici de distinguer « un point de visage isolé » de
« un visage qu'on peut lire ». `orientationOf` a déjà tranché cette question
pour `frontality` ; ce document mesure ce que le même tranchant donnerait ici,
sans le poser.

**Ouvert pour l'arbitrage humain (PR-D), pas tranché ici** : la barre à
retenir pour l'absence (un point ou deux), et si le containment doit hériter
de la même exigence côté nombre de points plutôt que de la seule aire. Ce
document donne les deux lectures, chiffrées sur 499 plans et sur les huit cas
de référence ; le choix n'est pas fait ici.

## Vérification de la chaîne

```
$ pnpm lint && pnpm type-check && pnpm test
# tout vert, 3200 tests

$ PROJECTS_DIR=/home/julien/dev/avolo-shorts/projects pnpm tsx scripts/framing-cases.ts verify
# identique avant/après cette PR, correctifs du checkpoint compris :
13 cas vérifiés — 2 en dérive, 8 ancrés sur une frontière (sans conséquence), 0 absents.
```

Les deux dérives (`cqlp-2138000`, `caro-mdlm-652500`) sont préexistantes,
documentées dans `docs/lessons.md`, et n'ont pas bougé d'un chiffre entre la
base `94e89e2` et cette branche : aucun comportement de cadrage n'a changé.
Les deux correctifs de ce checkpoint ne touchent que `headContainment` et
l'agrégation de `head-containment-worst` — jamais `computeShotSplit`, jamais
`headBounds`.
