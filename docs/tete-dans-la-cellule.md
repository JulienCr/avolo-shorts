# La tête dans la cellule : l'instrument, et ce qu'il mesure

Mesures faites le 26 août 2026, sur le code de cette PR
(`tooling/framing-head-instrument`), à partir de la base `94e89e2`. Répond à
l'issue #190 pour sa première moitié — « présence et intégrité de la tête » —
sans toucher à la seconde (profil contre trois-quarts dos, hors périmètre).

**Ce document mesure, il ne décide pas.** Les deux indicateurs qu'il présente
ne sont câblés dans aucune règle : `computeShotSplit` n'a pas changé de
comportement, `pnpm tsx scripts/framing-cases.ts verify` le confirme (dernière
section). Le seuil, s'il y en a un, est une arbitration humaine sur planche,
prévue pour une PR ultérieure (PR-D).

## L'instrument

Deux indicateurs, tous deux dans `src/core/framing.ts` :

- **`headContainment(box, cell, options)`** — la part de la tête d'une
  personne qui tombe dans une cellule de split. `null` quand `headBounds` ne
  se définit pas (aucun des cinq points du visage ne passe le seuil de
  confiance) : l'absence est un indicateur *différent*, jamais un
  containment de 0.
- **`computeShotHeadInstrument(...)`** — agrège les deux indicateurs par
  cellule, sur les images **appariées** d'un plan (jamais une seule image,
  puisque la cellule est fixe pour tout le plan). Il réutilise l'appariement
  et les cellules de `computeShotSplit` lui-même — extraits en fonctions
  partagées (`splitPairs`, `splitCells`, `splitBleed`, `splitLeftOnTop`) —
  plutôt que de les recalculer : mesurer une autre population que celle que
  la décision verrait rendrait la mesure sans valeur (leçon de #192).

Deux métriques dérivées dans `scripts/framing/metrics.ts` : `head-absence-worst`
et `head-containment-worst`, chacune le pire des deux cellules — un split est
mauvais si *l'une ou l'autre* l'est.

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
head-absence-worst (part 0 à 1)
  min 0.0000  déciles [0, 0, 0, 0, 0, 0, 0, 0, 0]  max 1.0000  médiane 0.0000

head-containment-worst (part 0 à 1)
  min 0.9482  déciles [1, 1, 1, 1, 1, 1, 1, 1, 1]  max 1.0000  médiane 1.0000
```

**Les deux indicateurs se déclenchent rarement**, et c'est mesuré, pas supposé
(`docs/lessons.md`, « un signal qui se déclenche toujours n'est pas un
signal » — ici c'est l'inverse qu'il fallait vérifier) :

| Indicateur | Se déclenche sur |
|---|---|
| `head-absence-worst` > 0 | 33 / 499 plans (6,6 %) |
| `head-containment-worst` < 1 | 2 / 499 plans (0,4 %) |

## Combien chaque indicateur retirerait, seul puis combiné

C'est le chiffre que #190 demande explicitement, en reprochant à la mesure
précédente (sur `frontality`) de n'avoir jamais compté ses deux causes
séparément :

| Seuil sur l'absence (part) | Retire, seul |
|---|---|
| > 0 | 33 |
| > 0,1 | 10 |
| > 0,3 | 5 |
| > 0,5 | 3 |

| Seuil sur le containment (médiane) | Retire, seul |
|---|---|
| < 1 | 2 |
| < 0,95 | 1 |
| < 0,9 | 0 |
| < 0,8 | 0 |

**Combiné (l'un ou l'autre) aux seuils les plus larges (absence > 0 OU
containment < 1) : 33 plans — exactement le compte de l'absence seule.** Sur
les 499 plans, les deux qui ont un containment < 1 ont *aussi* une absence
positive ailleurs dans le plan (répartition mesurée : 31 plans où seule
l'absence se déclenche, 2 où les deux se déclenchent, **0 où seul le
containment se déclenche**, 466 où aucun ne se déclenche). **Sur ce corpus,
`head-containment-worst` n'identifie aucun plan que `head-absence-worst` ne
trouve pas déjà.**

## Falaise ou pente ?

Ni l'une ni l'autre au sens où #190 pose la question pour `frontality` (une
pente sans creux, de 227 à 16 plans sur onze tranches). Ici, la distribution
est **concentrée à zéro** : 93,4 % des plans à `absence = 0`, 99,6 % à
`containment = 1`. Un seuil à `> 0` n'est donc pas un choix arbitraire dans une
pente continue — c'est la limite naturelle entre « l'indicateur ne voit rien »
et « l'indicateur voit quelque chose ». Ce point diffère nettement du cas de
la frontalité. Mais — et c'est la réserve centrale de ce document — **le fait
que l'indicateur ne se déclenche presque jamais ne dit pas qu'il capture tout
ce qui doit l'être** : voir la section suivante.

## Les huit cas de référence

| Cas | Verdict humain | Cellule haute (absence / containment) | Cellule basse (absence / containment) | Séparé ? |
|---|---|---|---|---|
| `nabla-2056800` | garder | 0,000 / 1,000 | 0,000 / 1,000 | — (propre) |
| `nabla-1798867` | garder | 0,000 / 1,000 | 0,000 / 1,000 | — (propre) |
| `nabla-1607967` | garder | 0,000 / 1,000 | 0,000 / 1,000 | — (propre) |
| `nabla-2077400` | écarter (trois-quarts dos) | 0,000 / 1,000 | 0,000 / 1,000 | non — hors périmètre, orientation |
| `nabla-6418667` | écarter (nuque, tête absente) | 0,000 / 1,000 | 0,000 / 1,000 | **non — raté** |
| `cqlp-1366033` | écarter (têtes tronquées/absentes) | 0,000 / 1,000 | **0,727** / 1,000 | oui |
| `entre-nous-3495867` | écarter (tête tronquée) | 0,000 / 1,000 | 0,000 / 1,000 | **non — raté** |
| `fmr-1115733` | écarter (aucune tête) | **1,000** / null | 0,000 / 1,000 | oui |

**Les trois cas `keep` sont propres** : absence nulle, containment plein sur
les deux cellules — aucun faux positif. Mais sur les quatre cas `drop`
qualifiés de « liés à la tête » par le contrat de cette PR, **deux seulement
sont attrapés** (`cqlp-1366033`, `fmr-1115733`) et **deux passent à travers**
(`nabla-6418667`, `entre-nous-3495867`), avec exactement les mêmes valeurs que
les trois cas `keep`. C'est une réfutation partielle, et il faut la dire
loudly : sur ce jeu d'épreuve, l'instrument tel que spécifié ne sépare pas
franchement les cas qu'il devait séparer.

## Pourquoi les deux cas manqués passent à travers — vérifié à l'image

`headBounds` déclare une tête présente dès qu'**un seul** des cinq points du
visage (nez, deux yeux, deux oreilles) passe `torsoMinScore` (0,5 par défaut).
Sur `entre-nous-3495867`, la personne de dos (Baba) ne montre jamais son
visage — mais un point unique, son oreille visible, est détecté à une
confiance qui franchit ce seuil sur *toutes* les images du plan :

```
box x[0.0003, 0.2598] head { x0: 0.1961, y0: 0.6505, x1: 0.1961, y1: 0.6505 }
```

Une tête réduite à un point (`x0 === x1`, `y0 === y1`) : `headContainment`
la lit comme une simple appartenance à la cellule — elle y est, donc
`containment = 1` — et `headBounds` n'étant jamais `null`, l'absence reste à
0. Vérifié à l'image (`scripts/framing-thumbnails.ts`) : le point magenta
tombe exactement sur l'oreille visible, aucun autre repère du visage.

`nabla-6418667` (« nuque, `facing == 'unknown'` ») montre le même mécanisme :
sur les dix-sept images du plan, la cellule concernée porte un point de tête à
aire nulle — jamais un vrai rectangle de visage — sur chacune d'elles.

**Ce n'est pas un défaut de `headContainment` ou de `computeShotHeadInstrument`** —
les deux appliquent fidèlement ce que le contrat demandait : réutiliser
`headBounds` sans écrire un second parcours de points. C'est une propriété de
`headBounds` lui-même, partagée avec tout le reste du module (torse, contour),
qui n'a jamais eu besoin jusqu'ici de distinguer « un point de visage isolé »
de « un visage qu'on peut lire ». L'issue #190 le formule ainsi : « soit on
est en mesure de suivre la tête ». Un seul point d'oreille ne permet de suivre
personne, et le critère actuel ne le sait pas.

**Ouvert pour l'arbitrage humain (PR-D), pas tranché ici** : une définition
plus stricte de l'absence — par exemple exiger que `headBounds` porte au moins
deux points, ou qu'il ait une aire non nulle, ou qu'il inclue au moins un
point central (nez ou un œil) plutôt que n'importe lequel des cinq — attraperait
vraisemblablement les deux cas manqués. Ce n'est pas mesuré ici : le contrat de
cette PR réserve le seuil et la définition finale à la planche humaine, et
change la définition reviendrait à écrire la règle candidate que #190 confie à
une PR ultérieure.

## Vérification de la chaîne

```
$ pnpm lint && pnpm type-check && pnpm test
# tout vert, 3195 tests

$ PROJECTS_DIR=/home/julien/dev/avolo-shorts/projects pnpm tsx scripts/framing-cases.ts verify
# identique avant/après cette PR :
13 cas vérifiés — 2 en dérive, 8 ancrés sur une frontière (sans conséquence), 0 absents.
```

Les deux dérives (`cqlp-2138000`, `caro-mdlm-652500`) sont préexistantes,
documentées dans `docs/lessons.md`, et n'ont pas bougé d'un chiffre entre la
base `94e89e2` et cette branche : aucun comportement de cadrage n'a changé.
