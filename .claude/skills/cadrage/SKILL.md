---
name: cadrage
description: Le comportement du cadrage automatique d'avolo-shorts — comment le ratio et le crop sont choisis, ce qui a déjà été essayé et écarté, les pièges qui ne se voient pas, et comment mesurer un changement. À lire avant de toucher à `src/core/framing.ts`, `worker/detect.py`, `src/core/ffmpeg/args.ts` ou `analysis.json`, et avant de régler quoi que ce soit dans `FRAMING_DEFAULTS`. À lire aussi quand quelqu'un dit qu'un clip sort « trop large », qu'un ratio est « mauvais », que le cadre « coupe quelqu'un », qu'il faudrait « baisser le seuil » ou « détecter autre chose » — chacune de ces phrases a déjà été instruite, et la réponse évidente a déjà été mesurée puis écartée au moins une fois.
---

# Le cadrage

Ce document est le manuel d'exploitation du cadrage. Il ne redit pas les mesures —
elles vivent dans `docs/ratios-par-clip.md` et `docs/premier-plan.md`, et la
conception dans la section 10 de
`docs/superpowers/specs/2026-08-17-avolo-shorts-design.md`. Il porte ce que ces
documents n'ont pas : **ce qu'on défait par réflexe, ce qui a déjà été essayé, et
ce qui se paie en bug silencieux.**

## Ce qu'il fait

Un clip produit **deux fichiers**, et ce sont **deux rendus indépendants de la
source** — le second ne dérive pas du premier :

- **le natif**, à un **ratio unique pour tout le clip** (le plus large que ses
  plans demandent), pour le feed Instagram et Facebook ;
- **le 9:16**, où **chaque plan est posé au cadre le plus serré qui tienne** sur
  un canevas vertical constant, le fond flouté prenant le reste. Un plan en 9:16
  remplit le canevas, un 1:1 en occupe 56,3 % de la hauteur, un 16:9 31,6 %.

Le ratio se choisit **par plan**, au plus petit qui cadre 90 % des images de ce
plan. Le crop est **fixe à l'intérieur d'un plan** et saute aux frontières, où
une coupe existe déjà.

**La grandeur mesurée est le tronc, pas la boîte.** `personBounds` rend le tronc
tiré des points de pose (`torsoBounds`), et retombe sur la boîte rognée
latéralement (`trimmedBounds`) quand il n'y a pas de points — analyse de
version 1, modèle de détection au lieu de pose, personne de dos.

Tout se règle par `FramingOptions`, dont les défauts sont dans `FRAMING_DEFAULTS`.
Chaque valeur y est mesurée ; aucune n'est un choix de goût.

## Les décisions qu'on défait par réflexe

| Décision | Le réflexe qu'elle remplace |
|---|---|
| Le ratio se choisit **par plan** | un ratio par clip |
| Le cadre suit **le tronc** | la boîte de personne, qui va jusqu'aux pieds |
| Le crop est **fixe dans un plan** | une caméra qui suit le sujet |
| Sous-titres et marques s'incrustent **sur le canevas**, après composition | dans l'image, avant sa mise à l'échelle |
| Les deux sorties sont **indépendantes** | dériver la verticale du natif |
| Le fond flouté se tire d'**avant** toute incrustation | flouter le rendu fini |
| Une mesure se vérifie **à l'image** | se fier à la distribution |

Les quatre dernières ont chacune coûté un défaut réel. Incruster avant la mise à
l'échelle réduit le texte à 31,6 % de sa taille sur un plan 16:9 posé dans un
canevas vertical. Dériver la verticale du natif rétrécit deux fois un plan serré.
Flouter après incrustation met les sous-titres dans le fond — c'est l'anomalie
#22, et c'est le `split` du filtergraph qui la referme.

## Ce qui a été essayé, mesuré, et écarté

Ne repropose pas ces pistes sans un fait nouveau. Chacune a son contre-exemple.

**Baisser le percentile.** Sur le plan de référence de `2025-06-15-cqlp`
(2 107 → 2 138 s), **zéro instant** ne tient dans un 1:1. Aucun percentile ne
peut donc produire un 1:1 : ce n'est pas un seuil qui bloque.

**Un filtre du premier plan sur le seul bord bas.** Il donne 90,4 % des images en
1:1 et paraît excellent — **parce qu'il vide 64 % des images de toute détection**.
Une part calculée sur ce qui reste ne dit rien. Le filtre retenu croise le bord
bas *et* une hauteur visible courte, et son seuil est le fond d'un creux
bimodal : 29 boîtes sur 26 436 entre 0,32 et 0,40.

**Une tolérance de débordement uniforme.** Arithmétiquement identique à une marge
négative, démontré : la fenêtre admissible s'élargit de deux fois la tolérance.
Elle rabote autant les empans déjà étroits et les pousse vers le 9:16.

**Exiger qu'une fraction de chaque personne tienne.** Autorise à prendre toute la
perte d'un seul côté. La version symétrique donne la même réduction en garantissant
que ce qui reste est centré : à gain égal, strictement plus sûr.

**Les autres définitions de tronc**, toutes mesurées contre `bust` (nez, yeux,
oreilles, épaules) : `head` seul est plus serré et perd des visages ;
`bust-hips` et `shoulders-hips` ne s'en distinguent pas d'un point — chez
quelqu'un d'assis les hanches ne dépassent pas les épaules, et quand elles le
feraient elles sont cachées donc peu confiantes ; `upper-body` élargit de six
points, un bras tendu rentrant dans le cadre qu'on venait d'en sortir.

## Six pièges

**1. Les points de pose sortent de `[0, 1]`.** Un bornage qui ne couvre qu'une
extrémité produit alors une **largeur négative** qui traverse le choix du ratio en
silence — mesurée à −0,575. Ce défaut a existé en **trois exemplaires** dans le
dépôt, et deux ont été trouvés dans du code que le correctif du premier venait de
toucher. Quand tu bornes une abscisse, borne les deux côtés.

**2. Une confiance arrondie contre un seuil inclusif.** `0,496` devient `0,50` et
passe un seuil qu'il ne devrait pas passer. Corrigé deux fois, à deux endroits
différents, parce que la première correction avait été comprise comme locale à son
champ. La règle : **une valeur notée qu'on compare à un seuil inclusif se tronque
vers le bas.** Voir la section correspondante de `CLAUDE.md`.

**3. `analysis.json` a deux versions vivantes.** La version 2 porte les points de
pose, la version 1 non. Ne suppose jamais leur présence : `personBounds` gère le
repli, passe par lui plutôt que de lire les points en direct.

**4. Les outils qui dessinent la boîte mentent maintenant.** Le cadre suit le
tronc ; un outil qui affiche les boîtes entières montre un rectangle qui n'est
celui d'aucune sortie. `scripts/vignettes-cadrage.ts` dessine les deux ;
vérifie-le avant de juger un cadrage sur une image annotée.

**5. `sideTrim` ne décide plus rien sur une analyse de version 2.** Balayé de 0 à
0,40, il ne déplace aucun ratio — les troncs ont pris la main. Le régler pour
changer un ratio est une perte de temps ; il n'agit que sur le centième de boîtes
sans tronc.

**6. Les boîtes et les scores de scène ne partagent pas la même horloge.**
`-vf fps={fps}` affecte chaque image d'entrée à l'emplacement de sortie le plus
proche : le contenu de l'image étiquetée `t` dans `analysis.json` vient en
réalité d'un instant postérieur, jusqu'à `1 / (2 · fps)` plus tard — mesuré à
+0,233 s sur un proxy à 30 im/s. Une fenêtre de recherche naïve `(t1, t2]` sur
les scores de scène rate 22 bascules sur 58 ; il faut l'étendre à
`(t1, t2 + 1/(2·fps)]`. Absorbé dans la fenêtre par `refine_switch`
(`worker/detect.py`), pas corrigé à la source — corriger l'étiquette imposerait
une version 3 du schéma et une ré-analyse GPU du corpus.

## Mesurer

Trois outils, à étendre plutôt qu'à doubler :

- `scripts/mesure-ratios.ts` — la répartition des ratios par clip, par fenêtre de
  30 s et **en temps de plan**. C'est le troisième qui compte : il dit ce que la
  sortie verticale montre vraiment ;
- `scripts/vignettes-cadrage.ts` — une image par plan, choisie sur son débordement,
  avec les boîtes, les troncs et le rectangle de crop ;
- `scripts/apercu-cadrage.ts` — un serveur local qui joue le proxy avec la même
  surimpression, pour voir *où* dans un plan le crop serre.

Quatre projets sont sur le disque avec leur analyse. **Compare toujours au code en
service, pas à un état antérieur** : deux améliorations successives se sont déjà
attribué le même gain.

**Compter des empans est déterministe : une passe suffit.** La règle des trois
passes et de la médiane de `CLAUDE.md` vise les mesures de *temps*, que la variance
de 40 à 80 % sous WSL rend traîtresses.

**Et vérifie à l'image.** Ce n'est pas une précaution de style : sur ce sujet, la
lecture d'une image a renversé une conclusion que les chiffres soutenaient au moins
trois fois. Les cas de contrôle, avec leur timestamp :

| Cas | Où | Ce qu'il éprouve |
|---|---|---|
| Jambes tendues | `2026-22-02-entre-nous`, 2 973 s | Le tronc contre la boîte |
| Tête à l'extrémité de sa boîte | `2026-03-08-caro-mdlm`, 7 250 s | Qu'un rognage aveugle perd un visage |
| Deux comédiens aux deux bords | `2025-06-15-cqlp`, 2 120 s | Qu'un 1:1 garde les deux bustes |
| Gros plan à boîtes instables | `2025-06-15-cqlp`, 2 138 s | Ce qu'aucune largeur ne résout |

## Ce qui reste ouvert

- **Le public que la pose ne voit pas.** Sur `2025-06-15-cqlp`, le modèle de pose
  ne rend que 2 429 têtes de spectateurs au bord bas contre 8 325 en détection — il
  lui faut des articulations, une nuque de premier rang n'en offre aucune. Le
  passage à la pose y coûte six points de temps de montage. Si des émissions à
  public reviennent, il faudra garder les deux modèles ou reprendre le filtre du
  premier plan sur la population de pose.
- **Les faux positifs sur du mobilier** (issue #69, cause restante) : un modèle de
  pose pose un squelette sur un fauteuil vide.
- **Les plans trop mobiles, en grande partie refermé depuis le 19 août 2026.**
  Sur `2026-22-02-entre-nous`, le temps de montage borné par la position plutôt
  que par la largeur tombait à 41 % : le mélangeur OBS translate la scène en
  bloc à l'intérieur d'un même plan détecté, et le score de scène — qui compare
  des histogrammes — ne voit pas une translation. Un second détecteur, croisant
  les boîtes de personnes (qui disent qu'une bascule a lieu) et les scores de
  scène déjà collectés (qui donnent l'image exacte), le ramène à 18 % — le
  plafond mesuré de cette approche, au-delà duquel `cqlp` et `nabla`
  régressent. Voir `docs/ratios-par-clip.md` (« Résolu depuis le 19 août 2026
  au soir ») pour le détail et l'étalonnage. Deux résidus restent ouverts,
  volontairement non traités par ce chantier :
  - **Un vrai changement d'axe**, à 2 953,2 s sur `entre-nous` : les largeurs de
    boîte changent, pas seulement leur position, donc `collective_shift` ne le
    voit jamais.
  - **Un fondu manqué par le plancher de collecte** (0,05), à t = 1 646,375 s
    sur `entre-nous`, passage régie → plateau : le score ne franchit le seuil
    de rétention (0,40) qu'à la faveur d'une image isolée, plusieurs secondes
    après le vrai changement.
- **Le gros plan à boîtes instables** : ce n'est plus la largeur qui décide, c'est
  la position. Aucun ratio fixe ne sert dix images sur onze.
- **La persistance du crop.** `cropMode` et la table `crops` ne sont pas écrites,
  donc le curseur de cadrage manuel est **inerte** dès qu'une analyse existe. Le
  réglage de dernier recours n'existe pas tant que ce n'est pas fait. La clé d'une
  dérogation est l'**intervalle source du plan**, résolu par recouvrement maximal —
  le raisonnement est en §3.5 du document de parcours utilisateur.

## Où lire le reste

| Question | Document |
|---|---|
| Les chiffres, par clip et par fenêtre | `docs/ratios-par-clip.md` |
| Le filtre du public au premier plan | `docs/premier-plan.md` |
| La conception, et pourquoi le crop est fixe par plan | spec §10 |
| Ce que l'écran doit montrer du cadrage | parcours utilisateur, §3.5 |
| Les décisions du dépôt et les échecs qui n'échouent pas | `CLAUDE.md` |
