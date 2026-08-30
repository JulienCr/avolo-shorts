# La hiérarchie du volet Image — la forme arrêtée le 30 août

Date : 30 août 2026. Statut : **arrêté**, pas encore implémenté.

**Amendé le 30 août (nuit), après arbitrage du propriétaire** : le défilement
dans le volet gauche est accepté (« c'est pas grave, au pire on scroll un
peu »), en plus de la coexistence bande/transcript déjà approuvée. Ça retire
la contrainte qui cadrait tout le §3 d'origine — deux volets fixes où rien ne
défile — et avec elle la cause commune de chaque symptôme mesuré dans ce
chantier : le débordement vidéo/bande, le débordement vidéo/transport, et un
seuil recalculé qui retombait quand même sur un budget à tenir au pixel près.
Les sections touchées le disent explicitement plutôt que de laisser l'ancien
raisonnement en place à côté du nouveau.

Répond à l'issue **#131** pour l'écran de clip. Amende
`docs/superpowers/specs/2026-08-28-ecran-clip-design.md`, dont l'ossature à deux
volets tient et n'est pas rediscutée ici : la sortie 9:16 garde le volet droit,
inchangé. Ce document ne porte que le **volet gauche** — la colonne « Image » —
et le seuil `workbench` qui conditionne les deux.

L'entrée de ce chantier est `.claude/contracts/D-critique.md`, écrite le 30 août
contre l'application en marche. Ses grandes lignes tiennent ; ce document
reprend ses mesures en les vérifiant soi-même, dans un vrai navigateur, sur le
code du commit `02c66ba` — **avant** la PR #286, actuellement ouverte sur
`clip-screen.tsx` et `timeline.tsx`. Ce que #286 est en train de faire (fusionner
Segments et Cadre dans le pied de la bande, supprimer « Bornes ») n'est pas
refait ici ; c'est supposé acquis.

## 1. Ce qui est mesuré, dans un vrai navigateur

Mesures prises avec Playwright (Chromium 130, headless) sur
`http://localhost:4014/clips/2026-03-08-caro-mdlm_005472883-005518477`, la même
clip de référence que le 28 août. Le choix de l'outil est une adaptation
délibérée : la contrainte du contrat (fenêtre Chrome bloquée à 5120×1440,
mesurer dans une iframe pincée) vaut pour un Chrome **de bureau, sous Windows**,
piloté depuis WSL. Playwright pilote un Chromium **headless**, natif à WSL, dont
le viewport se règle directement — le même besoin (un vrai moteur de rendu, pas
jsdom) sans le contournement de l'iframe.

### 1.1 Deux débordements distincts, tous deux réels, vérifiés par deux méthodes indépendantes

Le contrat affirme : « 32 px à 1920×1080, none at 2560×1320 ». **Ce chiffre
est exact** — reproduit à l'identique par le coordinateur, par deux méthodes
indépendantes (Chrome GUI en iframe pincée, et Playwright avec un settle de
3,5 s), pour la paire vidéo/figure **contre le conteneur de la bande, l'onglet
Temps et le ruban**. Ma première lecture de ce chiffre était fausse : je l'ai
comparé à une mesure prise contre un **autre élément** (le bloc transport) et
j'en ai conclu, à tort, que le contrat se trompait sur 2560×1320. Il ne se
trompait pas — je mesurais une paire différente sans le dire.

**Les deux débordements coexistent, contre des éléments différents, et il
faut les nommer séparément :**

```
Playwright, deviceScaleFactor=1, domcontentloaded + 3,5 s de repos :

                          2560 × 1320        1920 × 1080       1456 × 1010
vidéo/figure vs bande     0                  32                0
vidéo/figure vs onglet Temps  0              25                0
vidéo/figure vs ruban     0                  0                 0
vidéo/figure vs transport 28                 28                0
```

Les trois premières lignes sont **la mesure du contrat**, confirmée par le
coordinateur (deux méthodes) et par moi (une troisième) : à 2560×1320 la
figure déborde son propre conteneur de 43 px (1003 contre 960), ce qui suffit
à recouvrir tout le bloc transport juste en dessous mais s'arrête 9 px avant
d'atteindre la bande — d'où le 0 sur ces trois lignes à ce viewport. À
1920×1080, le débordement est plus grand en absolu (84 px, la figure étant
plus étroite donc proportionnellement plus haute) et il traverse le bloc
transport en entier pour mordre sur la bande et son onglet.

**La quatrième ligne est un second constat, distinct du premier, contre un
élément que ni le contrat ni le coordinateur n'avaient testé** — le bloc
transport (`ClipTransport`, entre la rangée et la bande). Il est non nul aux
deux viewports larges, y compris à 2560×1320 où le contrat (à raison, pour sa
propre paire) annonçait zéro. `closest('div[class*="shrink-0"]')` parti du
ruban ne peut pas le trouver : le transport n'est pas un ancêtre du ruban,
c'est un frère précédent de la bande dans le DOM, hors de portée d'un
`closest()`. Ce n'est donc l'erreur de personne — les deux méthodes de mesure
ne pouvaient tout simplement pas voir la même chose.

```
Playwright, 2560 × 1320 :
  row (le conteneur "flex-wrap ... max-h-[58vh]")   : haut 242, bas 960, h 718
  figure (ClipPlayer, aspect-ratio 16/9)            : haut 242, bas 1003, h 762
  transport (le bloc suivant, "shrink-0")           : haut 972, bas 1000, h 28

  → la figure déborde son propre conteneur de 43 px (1003 - 960)
  → elle recouvre l'intégralité du bloc transport (chevauchement de 28 px,
    min(1003,1000) - max(242,972) = 28)
```

Capture jointe : `overlap-2560.png` dans le scratchpad de cette tâche,
montrant le rectangle de cadrage du plan qui déborde visiblement sur la ligne
de transport en dessous — c'est le débordement contre le transport que la
capture montre, pas celui contre la bande.

**Le mécanisme est plus large que « le calque vidéo ignore son plafond ».**
`crop-picker.tsx` n'est pour rien dans le débordement en pixels — le vrai
coupable est la ligne `flex min-h-0 flex-wrap items-start gap-4
workbench:flex-nowrap workbench:max-h-[58vh]` (`clip-screen.tsx:626`) : sous
Chromium, un conteneur flex avec `items-start` dont un enfant a un
`aspect-ratio` explicite peut se calculer une hauteur propre **inférieure** à
celle du plus grand de ses enfants, sans qu'aucune règle CSS ne le clippe. Ce
n'est pas seulement vrai pour la vidéo :

```
Playwright, 1024 × 1000 (le plancher actuel du seuil workbench) :
  row     : h 380
  figure  : h 116  (comprimée en largeur — 164 px — par la fiche qui garde son minimum)
  fiche   : h 470  ← plus grande que le conteneur qui est censé la porter
```

**La fiche éditoriale déborde elle aussi**, de 90 px, et par un mécanisme
différent (une hauteur de contenu, pas un `aspect-ratio`).

**Ce que le défilement accepté (amendement du 30 août, nuit) change à cette
analyse : ce ne sont plus deux débordements à contenir chacun dans son coin,
c'est un seul bug de calcul à corriger à la racine.** Un simple
`overflow-hidden` sur la rangée resterait un mauvais correctif — il
couperait des champs de saisie de la fiche à la largeur plancher, un défaut
fonctionnel, pas seulement visuel. Le bon correctif est plus direct :
faire en sorte que la rangée **rende réellement** la hauteur de son plus
grand enfant (`items-stretch` plutôt que `items-start`, ou une autre
disposition qui n'oppose pas `aspect-ratio` et calcul de hauteur flex — le
choix précis se tranche en phase 2, pas ici). Une fois ce calcul corrigé, les
deux débordements du §1.1 disparaissent **par construction**, pas par un
filet qui masque leurs pixels : il n'y a plus de bug à masquer. Et si le
résultat pousse la colonne au-delà de la fenêtre, elle défile — la section
`zone-image` porte déjà `workbench:overflow-y-auto`
(`clip-screen.tsx:615`), qui n'a jamais pu jouer son rôle parce que le
débordement se produisait *à l'intérieur* de la rangée, entre deux frères de
même niveau, avant même d'atteindre le bord de la section qu'il aurait fallu
faire défiler. Voir §2.1 et §4.1.

### 1.2 Le seuil `workbench` est à la fois inatteignable et, atteint, insuffisant

```
1920 × 937 (hauteur réelle d'un 1080p sous Windows, chrome de fenêtre déduit) :
  matchMedia('(min-width: 1024px) and (min-height: 1000px)') → false
  document.scrollingElement.scrollHeight - innerHeight → 103

1024 × 1000 (exactement au seuil actuel) :
  matchMedia(...) → true
  mais la rangée source+fiche mesure 380 px de conteneur pour 470 px de
  contenu (fiche) — la même famille de débordement qu'en §1.1.
```

**Le second relevé est le plus grave des deux.** Le contrat, comme le §5 de la
critique, présente le problème comme « le seuil ne s'atteint pas sur un écran
courant ». C'est vrai, mais insuffisant : **même quand le seuil s'atteint
exactement, le contenu d'aujourd'hui ne tient déjà plus dedans.** Le budget de
780,5 px documenté dans `globals.css:16-28` date du 23 août, avant le ruban de
la bande (#278), avant la fiche éditoriale à droite de la source (#273), avant
même les déclencheurs de modale de la #281. Personne ne l'a recalculé depuis.
Relever le seuil sans le recalculer serait répéter l'erreur.

**Amendement du 30 août (nuit) : ce relevé garde sa valeur de diagnostic, mais
plus l'un et l'autre problème ne se recoupent après l'arbitrage du
propriétaire.** Le premier (le seuil ne s'atteint pas sur 1080p) est corrigé
au §3.4 — pas en cherchant plus de marge dans le même calcul, mais en
changeant ce que le seuil doit garantir. Le second (le contenu déborde déjà
au seuil actuel) est corrigé au §2.1/§4.2 — pas en resserrant le contenu,
mais en le laissant défiler.

### 1.3 Une troisième rupture de la contrainte « pas de ratio ni de pourcentage sur split/doublage »

Non demandée par le contrat, trouvée en marge des mesures ci-dessus, dans
`output-preview.tsx:353-359` :

```tsx
<span className="font-mono tabular-nums">{Math.round(part * 100)} %</span> · cadre{' '}
<span className="font-mono">
  {split !== undefined ? 'split' : dubbing !== undefined ? 'doublage' : effective}
</span>
```

Avec `part = split !== undefined || dubbing !== undefined ? 1 : lScreenPart(effective)`
(`:255-256`). Résultat, capturé à l'écran sur le clip de référence (un plan de
doublage) : **« variante 9:16 · 100 % · cadre doublage »**.

Le mot « split »/« doublage » remplace bien un ratio qui n'aurait plus de sens —
c'est ce que `tests/components/clip/clip-screen.test.tsx:236-255` vérifie, et
ces chaînes ne se retouchent pas. **Mais le « 100 % » reste**, et il est
**constant** : `part` vaut toujours 1 en split ou en doublage, quel que soit le
plan. Un nombre qui ne varie jamais n'est pas une mesure, c'est un habillage —
et c'est précisément une annonce de pourcentage de crop sur un plan où le
rendu n'en suit aucun, l'exacte définition de la contrainte absolue de ce
chantier. Ce fichier n'appartient pas à la PR #286 : la correction peut partir
en phase 2. Voir §4.4.

### 1.4 Vérifié conforme, à ne pas toucher

- **`cropReason` (`crop-picker.tsx:444-451`) reste affiché en permanence**, et
  c'est volontaire, écrit dans le commentaire qui le précède : le rectangle de
  cadrage le désigne par `aria-describedby={cropReasonId}` ; le replier
  derrière une modale fermée laisserait un identifiant pointant dans le vide.
  Cette ligne ne rejoint donc pas les modales du §4.3 — **elle est
  volontairement exemptée**, pas oubliée.
- **La ligne « Fichier natif · Variante 9:16 » (`crop-picker.tsx:453-469`)
  reste visible**, comme le veut le commentaire qui la protège depuis le
  28 août (§4.5 de la spec de cette date). Rien ici ne la retouche.
- Les cinq boutons de forçage de ratio du mockup de référence sont bien **cinq**,
  pas quatre : `Auto`, `Force 9:16`, `Force 4:5`, `Force 1:1`, `Split`
  (vérifié dans `/mnt/c/Users/julie/Downloads/clip-editor-mockup.html:30`). Le
  contrat de ce chantier avait raison sur ce point.
- **Les repères de ligne du contrat lui-même ont déjà dérivé.** Il cite
  `crop-picker.tsx:418-424` pour le commentaire qui protège `cropReason` ; sur
  le code réellement présent, c'est `:444-451`. Rien d'anormal — c'est la même
  leçon que `CLAUDE.md` répète pour les specs : un document daté peut avoir
  été rattrapé par le code, se vérifier avant de citer.

## 2. Ce que ça donne comme mise en page

Le principe de la critique — fusionner plutôt qu'empiler — est retenu, avec un
correctif : **la fusion en cartes est un gain de lisibilité, pas un gain de
hauteur** (§3.1-§3.3 le chiffrent). Ça n'a plus besoin d'être un gain de
hauteur : depuis l'arbitrage du 30 août (nuit), le volet gauche peut défiler,
donc la mise en page n'a plus à tenir sous un budget précis. Ce qui reste à
faire tenir sans défiler, c'est la sortie 9:16 dans le volet droit — la seule
pièce de l'écran qui n'a pas de scroll — et c'est elle qui cadre le seuil
`workbench` refait au §3.4.

### 2.1 Carte Source

Bordure autour de la rangée source + fiche + transport, avec la légende
existante (« la source — le rectangle est le cadre pris pour ce plan ») en
guise d'en-tête — pas de nouveau `<h2>`. À l'intérieur :

- la **figure source** (16:9, avec le rectangle de cadrage superposé) ;
- la **fiche éditoriale** (Titre, Description, Hook, Badge) à droite ;
- le **transport**, sous les deux, inchangé.

**Ni l'un ni l'autre n'a son propre défilement** — voir §1.1 pour le
changement de raisonnement depuis l'amendement du 30 août (nuit). La rangée perd son
`max-h-[58vh]` (un pourcentage de fenêtre sans rapport avec ce qu'il y a
autour, cause du bug) sans qu'un calcul de remplacement le remplace pixel
pour pixel : une fois le calcul de hauteur de la rangée corrigé à la racine
(`items-stretch`, ou une disposition équivalente — le choix précis est un
détail d'implémentation, tranché en phase 2), la rangée rend simplement la
hauteur réelle de son plus grand enfant, qu'il s'agisse de la figure ou de la
fiche selon la largeur disponible (§3.3). **Si le total dépasse la fenêtre,
la carte Source pousse la carte Montage plus bas et la colonne défile** —
`workbench:overflow-y-auto` existe déjà sur la section, il n'a simplement
jamais pu jouer son rôle tant que le bug empêchait la rangée de rendre sa
vraie taille. Plus de filet `overflow-hidden` à poser nulle part : sans bug
à masquer, il n'y a rien à couper.

### 2.2 Carte Montage

Pleine largeur, sous la carte Source. C'est très largement déjà fait : le
commutateur `◷ Temps | ❞ Mots` (`timeline.tsx:303-312`) est l'en-tête, le
ruban et la piste (ou le transcript en mode Mots) sont le corps, et le pied
existant (bornes A/B, durée) — bientôt enrichi par la PR #286 des segments et
du cadre du plan courant — est le pied. **Rien à faire ici que la donner une
bordure et la laisser telle quelle une fois #286 fusionnée.**

### 2.3 Ligne d'outils — le vrai changement

`RatioPicker`, le déclencheur de `FramingFields` et celui de `RenderSettings`
sont aujourd'hui trois `<div className="shrink-0">` empilés
(`clip-screen.tsx:692-703` et `:715-721`), pour une raison qui n'existe plus :
la #281 a déjà réduit `FramingFields` et `RenderSettings` à un simple
déclencheur de modale. Les fusionner en **une seule rangée** :

```
[ auto ]  [ Forcer un cadrage ▾ ]  [ Réglages du montage doublage ▾ ]  [ Réglages du rendu ▾ ]
Fichier natif 16:9 · Variante 9:16 sur fond flouté         ← toujours visible, basis-full
```

Le contenu ne change pas — ce sont les mêmes boutons, la même ligne
« Fichier natif » protégée, le même `cropReason` quand il s'applique. Ce qui
change, c'est le nombre de blocs `shrink-0` et donc de marges verticales entre
eux : de trois blocs (3 × ~28-72 px + 3 gaps) à un seul (même contenu + 1 gap).

### 2.4 Sous le seuil `workbench`

Ordre inchangé : Carte Source → Carte Montage → Ligne d'outils → Sortie, en
colonne qui défile — c'est l'ordre de la tâche (vérifier, corriger, livrer), et
c'est déjà celui d'aujourd'hui. Aucun changement de comportement en dessous du
seuil, seulement la même réorganisation visuelle en cartes.

**Amendement du 30 août (soir), reçu après la première passe de ce document.**
Il porte sur le point le plus lourd de tout ce chantier — plus lourd que le
regroupement en cartes — et il révise le §3 qui suit. Gardé comme sous-section
distincte plutôt que fondu en silence dans ce qui précède, pour qu'on voie
exactement ce qui a changé et pourquoi.

### 2.5 La bande et le transcript coexistent — la bascule Temps/Mots n'était pas la bonne réponse

**Vérifié en direct, sur `main`, sur le clip de référence** : basculer l'onglet
de Temps à Mots ne fait pas apparaître le transcript à côté de la bande, il la
**démonte**.

```
                          mode Temps   mode Mots
ruban (filmstrip)         présent      absent
role="slider" (2 oreilles + tête de lecture)   3            0
groupe transcript         absent       présent, 86 mots (clip de référence)
```

Le propriétaire, en le constatant sur sa propre maquette : « ce qui pose
problème dans notre version aussi, c'est le mode mot », et « [dans le modèle
les mots] s'affiche[nt] en dessous ». Dans la maquette externe, la carte
`Clip timeline` garde sa règle, son ruban, ses oreilles et ses repères de
coupe, et les mots apparaissent **en dessous**, en rangée de pastilles, avec
l'indication « cliquer près du début ou de la fin accroche les poignées aux
limites de mot ».

**Adopter la coexistence, pas le rôle qu'elle donne aux mots.** Dans la
maquette, les mots sont une aide à l'accrochage des poignées — un confort
posé sur une timeline qui reste l'instrument. Dans ce dépôt, la relation est
inverse et elle est actée : « la surface d'édition est le transcript »
(`CLAUDE.md`), et la bande de temps a été ajoutée **à côté** de lui — « elle
monte du temps, le transcript monte des mots, et les deux coexistent »
(`docs/lessons.md`). Rétrograder le transcript au rang d'aide à l'accrochage
défait une décision qui a coûté une mesure. Ce que la maquette a raison de
montrer, c'est que voir les deux à la fois rend chacun des deux utile ; ce
qu'elle a tort de montrer, c'est lequel des deux est l'instrument.

**Vérifié sur le clip le plus long de l'émission, pas seulement sur la
référence.** `2026-03-08-caro-mdlm` porte six clips ; le plus long,
`007212212-007300496`, dure 88,3 s (`segments` en base : un seul segment,
7212,212 → 7300,496) et porte **284 mots** dans cette fenêtre (contre 137 pour
le clip de référence, 50,6 s — l'écart n'est pas linéaire, il dépend du débit
de la scène). Rendu en mode Mots, sans aucune limite de hauteur posée
aujourd'hui, le bloc du transcript mesure **287 px** — grandeur comparable à
la bande elle-même. **Une rangée de pastilles au fil du texte, comme dans la
maquette, ne tient pas ce volume** : 284 mots en pastilles individuelles
demanderaient largement plus de lignes qu'un paragraphe de texte suivi. Le
composant existant (`TranscriptSurface`, réutilisé sans réécriture, comme
l'avait déjà décidé la refonte du 28 août au §4.3) rend déjà des phrases
continues avec horodatage par ligne, pas des pastilles isolées — plus dense,
et il n'a pas besoin d'être remplacé pour porter ce chantier. Ce qu'il lui manque, c'est une **borne de hauteur avec défilement interne**
— pas pour tenir un budget (§3.4 ne l'exige plus), mais pour que la carte
Montage garde une taille stable et scannable d'un clip à l'autre : sans elle,
un clip de 88 s pousserait son panneau à 287 px, un clip plus long encore
davantage, et la carte grandirait avec la durée du clip plutôt que de
présenter toujours la même forme.

**Proposition : un panneau transcript de hauteur fixe (~150 px, l'ordre de
grandeur de la bande elle-même), avec défilement interne, affiché en
permanence sous la bande dans la carte Montage.** À 150 px, le clip de
référence (137 mots, ≈ 138 px estimés au prorata du relevé de 287 px pour
284 mots) tient sans défiler ; le clip le plus long défile. Aucun clip de
l'émission n'oblige à agrandir ce chiffre — il borne le pire cas, pas la
moyenne.

**Second amendement, du 30 août (nuit) : le découpage ci-dessous ne tient
plus, et se simplifie.** Il reposait sur « la colonne qui défile n'a pas la
place pour les deux blocs à la fois » — or le propriétaire vient d'accepter
que cette colonne défile (« c'est pas grave, au pire on scroll un peu »).
Une fois le défilement acceptable **partout**, la raison de réserver la
coexistence à un seul régime disparaît avec lui.

**La bascule `◷ Temps | ❞ Mots` ne survit pas, sans condition de seuil.** Les
deux panneaux restent montés en permanence, que la mise en page soit à deux
colonnes ou en une seule qui défile. Un composant `Tabs`
(`timeline.tsx:294-318`, un vrai `role="tablist"` avec un unique
`TabsContent`) n'a plus de sens dès l'instant où les deux panneaux sont
visibles ensemble — l'ARIA d'un tabpanel promet qu'un seul est visible à la
fois, exactement le contrat que la coexistence rompt, dans les deux régimes
désormais. Les deux étiquettes peuvent rester comme simples ancres de
défilement (cliquer « Mots » amène le panneau transcript dans le viewport et
y place le focus, cliquer « Temps » fait le symétrique vers la bande) si le
propriétaire tient à garder un raccourci visuel vers chacun ; sinon elles
disparaissent avec la bascule qu'elles accompagnaient.

**`Ctrl+F` se simplifie pareil : un seul comportement, plus de coupure.** Il
amène toujours le focus dans le champ de recherche du panneau transcript déjà
visible (`shortcuts.tsx:172` ; `clip-screen.tsx:314-317`), qu'on soit
au-dessus ou en dessous du seuil `workbench` — puisque rien ne démonte plus
rien nulle part.

**Conséquence chiffrée, revue au §3.4.** Le panneau de 150 px ajouté en
permanence n'entre plus dans le calcul du seuil : il allonge simplement la
colonne gauche, qui défile pour l'absorber. Ce n'est plus « le plus gros
ajout au budget » — il n'y a plus de budget à charger, seulement une colonne
qui grandit un peu.

## 3. Le seuil `workbench`, recalculé sur une question plus faible

**Amendé le 30 août (nuit).** Les §3.1-§3.3 qui suivent datent de la première
passe de ce document, écrite quand le volet gauche devait encore *tenir* sans
défiler — la méthode de `globals.css:8-29` (23 août) : sommer tout ce qui
n'est pas la source ni la sortie, et demander combien il reste aux deux
aperçus pour que rien ne déborde. Ils restent utiles pour dimensionner un
**confort par défaut** (le cas courant n'a pas besoin de défiler), mais ils
ne répondent plus à la question que le seuil doit trancher. Cette question,
depuis l'arbitrage du propriétaire, est plus faible : **pas « est-ce que tout
tient », mais « la fenêtre a-t-elle la place pour deux colonnes côte à côte
plutôt qu'une colonne empilée ».** Le §3.4 la retraite sur cette base ; §3.1
à §3.3 sont conservés en contexte, réétiquetés en conséquence, et ne
gouvernent plus le chiffre du seuil.

**Largeur de référence : 1024 px, inchangée.** Le seuil garde ses deux
conditions (largeur **et** hauteur) : la largeur assure que les deux colonnes
ont chacune une taille utilisable côte à côte, question qui ne dépend pas de
ce qui défile. La rangée source+fiche est la plus contrainte à 1024 px
(la fiche, largeur fixe minimale de 360 px, y mange le plus de place relative
face à la figure) — ça reste vrai, et ça ne change rien à ce point.

### 3.1 Ce qui est mesuré, indépendant de la largeur — pour le confort par défaut, plus pour le seuil

Chrome vertical **hors** rangée source+fiche, relevé dans Chromium à 1416 px de
large (ces pièces ne varient pas avec la largeur, vérifié en les relevant aussi
à 2560 et 1024 — même chiffre à 1 px près) :

| Pièce | Mesuré | Ligne |
|---|---|---|
| Barre d'app | 48 | — |
| Fresque des clips | 146 | — |
| Remplissage vertical de `main` | 32 | `p-4` |
| Transport | 28 | `clip-screen.tsx:659-661` |
| Bande (Temps/Mots, ruban, pied, avant #286) | 128 | `clip-screen.tsx:667-690` |
| Ratio + réglages montage + réglages rendu, **avant fusion** | 128 | `:692-721`, 3 blocs |
| 6 espacements `gap-3` (12 px) dans la colonne Image | 72 | — |

Somme aujourd'hui : **602 px**, contre 780,5 px le 23 août — la baisse vient du
rail supprimé (83 px) et du `<dl>` de faits supprimé (84 px) par la refonte du
28 août, en partie repris par le ruban de bande (qui n'existait pas encore).

### 3.2 Ce qui change avec ce chantier pour ce confort par défaut — estimé, à revérifier une fois construit

| Pièce | Avant | Après | Écart |
|---|---|---|---|
| Ratio + montage + rendu, fusionnés (§2.3) | 128 (3 blocs, 3 gaps) | ~84 (1 bloc, 1 gap) | **−44** |
| Bande, avec le pied fusionné de la PR #286 | 128 | ~160 (estimé, reprend le chiffre du 28 août) | +32 |
| En-tête/bordure de la carte Source (padding) | 0 (pas de carte) | ~32 | +32 |
| En-tête/bordure de la carte Montage (padding) | 0 | ~32 | +32 |

**Net : +52 px de chrome fixe, pas une économie.** C'est le constat à ne pas
enjoliver : regrouper en cartes coûte de la hauteur (bordures, remplissages),
et ça ne se compense qu'à moitié par la fusion de la ligne d'outils. La
lisibilité et le budget de hauteur sont deux axes différents ; ce chantier
améliore le premier et ne dégrade que légèrement le second.

Nouvelle somme d'ensemble estimée : **602 + 52 = 654 px**, à revérifier dans un
vrai navigateur une fois la carte construite (§6, tâche 3, dernière étape).
**Ce chiffre sert à choisir un point confortable par défaut, plus à garantir
un seuil** — voir §3.4.

### 3.3 Le budget qu'il reste à la rangée, à la largeur plancher (1024 px)

À 1024 px de large : fiche à 360 px (son minimum, `clamp(360px, 30cqw, 620px)`
à 30 % de ~950 px de conteneur = 285, donc bornée au plancher), figure à
`1024 − 32(remplissage) − 360(fiche) − 16(gap) = 616` px de large, soit
`616 × 9 / 16 ≈ 347` px de haut à pleine largeur disponible.

Avec la rangée corrigée pour rendre la hauteur réelle de son plus grand
enfant (§2.1), ce chiffre (347 px pour la figure à 1024 px de large) reste
une bonne cible de confort par défaut à la largeur plancher — le cas où ni la
figure ni la fiche n'imposent de défilement interne à la colonne. Ce n'est
plus une contrainte : si le contenu dépasse, la colonne défile (§2.1).

### 3.4 Le nouveau seuil — sur la question qu'il pose réellement maintenant

**Ce que le seuil décide a changé.** Il ne garantit plus que rien ne déborde
— le défilement s'en charge, §2.1. Il décide seulement si la fenêtre a la
hauteur pour donner à la sortie 9:16 (le volet droit, la seule pièce de
l'écran qui ne défile pas) une taille qui vaille la peine d'un affichage à
deux colonnes plutôt qu'une colonne unique empilée.

```
chrome incompressible au-dessus des deux colonnes :
  barre d'app                48
  fresque des clips         146
  remplissage de `main`      32
  ────────────────────────────
                             226

hauteur de sortie 9:16 en dessous de laquelle un aperçu vertical
cesse de rendre service : 400 px (≈ 225 px de large)
                                          — décidé par le propriétaire

seuil ≥ 226 + 400 = 626 px
```

**Le chiffre de confort (400 px) est la décision du propriétaire, pas un
calcul** — contrairement au 226, mesuré et robuste à la largeur. Le seuil
précédent (1000, puis 1001 recalculé) dérivait d'exiger que *tout* le volet
gauche tienne sans défiler ; cette contrainte n'existe plus, donc il n'y a
plus de second terme mesurable à additionner — seulement la question de
quand un 9:16 devient trop petit pour être utile, et c'est lui qui a
tranché. **Confirmé le 30 août** : 400 px reste la valeur retenue pour la
phase 2, écrite comme telle dans `globals.css`.

**Conséquence directe : le seuil descend d'environ 1000 à environ 630**,
arrondi à **640 px** pour une marge ronde. Ça résout, de fait, la tension que
la première passe de ce document avait signalée entre coexistence et
couverture d'écran (ancien §3.6, retiré ci-dessous) : un 1920×1080 réel offre
~937 px de hauteur utile (§1.2), largement au-dessus de 640. **Le volet fixe
à deux colonnes redevient atteignable sur l'écran le plus courant** — pas
parce que le budget a été regagné ailleurs, mais parce que la question posée
au seuil ne demande plus qu'un aperçu confortable, sans plus jamais exiger
que la colonne entière y tienne sans défiler.

**Sous 640 px de hauteur**, la mise en page repasse en colonne unique
empilée (§2.4) — inchangé dans sa forme, seulement plus rarement déclenché.

**Le §3.3 (347 px pour la figure à la largeur plancher) n'entre plus dans ce
calcul** : il reste une donnée de confort par défaut pour le volet gauche
(§3.2), qui peut désormais défiler indépendamment de la sortie.

### 3.5 Pourquoi ça reste une `@media`, jamais une container query

Une container query répond à la taille du **conteneur**, jamais à celle du
**viewport**. La question posée par `workbench` a changé de forme depuis le
§3.4 (elle ne demande plus si tout tient sans défiler, seulement si la sortie
9:16 a une taille confortable en deux colonnes) mais elle porte toujours sur
le viewport par construction : c'est la hauteur de la *fenêtre*, moins la
barre d'app et la fresque, qui donne sa hauteur au volet droit. Un conteneur
n'a pas de hauteur propre à interroger avant que le reste de la page (barre
d'app, fresque) ait déjà pris la sienne — la seule taille disponible à ce
moment-là **est** celle du viewport.

Il y a un second problème, plus subtil, et il est déjà visible dans le code
d'aujourd'hui : la section Image porte `workbench:[container-type:inline-size]`
(`clip-screen.tsx:612-615`), utilisé par `30cqw` pour la largeur de la fiche.
**`inline-size` ne peut répondre qu'à des requêtes de largeur.** Passer la
question du seuil à une container query demanderait `container-type: size`
(largeur **et** hauteur), qui force le navigateur à calculer la taille du
conteneur *avant* de savoir combien de place il occupera dans la page — un
problème circulaire quand ce même conteneur décide, via le seuil, si l'écran
s'affiche à deux colonnes ou en une seule qui défile. Le viewport, lui, est
toujours connu avant la mise en page : c'est précisément pour ça qu'une `@media` reste
la bonne réponse à cette question-là, et une container query la bonne réponse
à la question — différente — de la largeur de la fiche.

**Ce raisonnement n'est pas à reproposer.** Il a déjà été demandé une fois par
le contrat de ce chantier (§ « Le seuil `workbench` »), et une fois par la
critique d'entrée (§5) ; les deux disent la même chose sans le démontrer. Ce
paragraphe est la démonstration, pour que la question ne revienne pas une
troisième fois.

### 3.6 La tension de la première passe, retirée par l'arbitrage du propriétaire

Cette section posait, dans la première passe de ce document, une tension
entre deux demandes : ajouter le panneau transcript en permanence poussait le
seuil recalculé de ~1001 à ~1167 px, ce qui rendait le volet fixe à deux
colonnes **moins** atteignable sur un 1080p — à l'opposé du but affiché de
l'issue #131 — et deux options étaient proposées : accepter le seuil haut, ou
réduire le panneau transcript sous 150 px pour limiter la casse.

**Cette tension n'existe plus.** Elle reposait sur l'hypothèse que le volet
gauche devait tenir sans défiler ; l'arbitrage du 30 août (nuit) lève cette
hypothèse. Le panneau transcript reste à ~150 px (§2.5) pour de bonnes raisons
de confort d'affichage, mais son coût ne remonte plus dans le calcul du seuil
— il allonge la colonne gauche, qui défile pour l'absorber (§2.1). Le seuil
recalculé au §3.4 (~640 px) ne porte donc plus trace de ce panneau, et n'a
pas eu besoin d'arbitrage entre deux options : la question qui aurait exigé
un choix a été dissoute plutôt que tranchée.

## 4. Ce qui se retire, explicitement, pour que ça se veto avant de disparaître

Rien de nouveau ne s'ajoute — ce chantier retire et regroupe. Cinq choses,
dans un ordre de risque croissant :

### 4.1 Le `max-h-[58vh]` de la rangée

**Amendé le 30 août (nuit) : retiré, sans remplacement calculé.** La première
passe de ce document proposait de le remplacer par un `calc(100dvh - X)`
tenant le chrome mesuré au §3.1-§3.3. Ce calcul n'a plus d'objet : il servait
à garantir que la rangée tienne exactement sous un budget, et cette garantie
n'est plus demandée. **58vh n'a jamais eu de rapport avec ce qui entoure la
rangée** — c'était un chiffre qui marchait par coïncidence à une combinaison
de tailles — et c'est la cause directe du bug du §1.1, mais la correction
n'est pas de lui substituer un autre chiffre : c'est de corriger le calcul de
hauteur de la rangée lui-même (§2.1, §4.2 ci-dessous) pour qu'il n'ait plus
besoin d'aucun plafond.

### 4.2 Le calcul de hauteur de la rangée, corrigé à la racine

**Ce point remplace, dans cette version du document, l'ancienne proposition
de borner la fiche éditoriale avec son propre défilement interne** — devenue
inutile une fois le défilement de toute la colonne accepté (§2.1). Le
correctif porte sur la ligne `flex ... items-start ... aspect-ratio`
(`clip-screen.tsx:626` et `:635`) : sous Chromium, cette combinaison peut
rendre une rangée plus courte que son plus grand enfant, sans qu'aucune règle
ne le clippe — c'est le mécanisme derrière les deux débordements du §1.1.
Le correctif exact (`items-stretch`, ou une disposition qui ne mélange pas
`aspect-ratio` et calcul flex de hauteur) est un détail d'implémentation à
trancher en phase 2 ; ce qui est acquis ici, c'est le résultat attendu : la
rangée rend toujours la hauteur réelle de son plus grand enfant, et
**`workbench:overflow-y-auto`, déjà posé sur la section (`clip-screen.tsx:615`)
mais jusqu'ici sans effet utile**, absorbe le reste si la rangée pousse la
carte Montage hors de la fenêtre. **Conséquence visible pour l'utilisateur** :
une description très longue peut désormais allonger toute la colonne gauche
plutôt que de déborder sur le transport ou la bande — un changement de
comportement, mais plus doux que l'ancienne proposition (défiler dans un
petit encart), puisque c'est la colonne entière qui s'ajuste, pas une carte
isolée.

### 4.3 Trois blocs `shrink-0` redevenant un

`RatioPicker`, le déclencheur de `FramingFields`, le déclencheur de
`RenderSettings` : même contenu, une seule rangée. Rien ne disparaît du texte
ou des contrôles, seulement l'empilement vertical qui les séparait.

### 4.4 Le « 100 % » du viseur, sur un plan split ou doublage

Décrit au §1.3. Proposition : quand `split !== undefined || dubbing !==
undefined`, ne plus afficher de pourcentage du tout — la légende devient
`variante 9:16 · cadre split` / `variante 9:16 · cadre doublage`, sans le
`Math.round(part * 100) %`. Les tests visés
(`clip-screen.test.tsx:236-255`) ne cherchent que la présence de « cadre
split »/« cadre doublage » ; retirer le pourcentage ne les casse pas, il faudra
seulement vérifier qu'aucun autre test n'attend le `%` sur ces deux cas (à
vérifier en phase 2, pas fait ici puisque `src/` n'est pas touché en phase 1).
**C'est la proposition la plus sûre de cette liste** — elle ne change aucun
comportement de rendu, seulement un texte, et elle corrige une rupture
mesurée, en direct, de la contrainte absolue de ce chantier.

### 4.5 La bascule Temps/Mots, comme sélecteur de mode exclusif

**Simplifié le 30 août (nuit) : la qualification « au-dessus du seuil
seulement » tombe.** Elle tenait tant que la coexistence n'était possible que
là où tout tenait sans défiler ; le défilement étant maintenant acceptable
partout (§2.5), les deux panneaux restent montés **sans condition de seuil**.
Le composant `Tabs` (`timeline.tsx:294-318`) n'a donc plus de `tabpanel`
unique à annoncer nulle part ; il se retire au profit de deux ancres de
défilement, ou disparaît complètement si le propriétaire ne tient pas à
garder un raccourci visuel vers chacun.

### 4.6 Ce qui NE se retire PAS, à nouveau, pour éviter une quatrième rupture

- `cropReason` (§1.4) : jamais derrière une modale.
- La ligne « Fichier natif · Variante 9:16 » (§1.4) : jamais masquée.
- Les chaînes « cadre split » et « cadre doublage » elles-mêmes : jamais
  reformulées, `tests/components/clip/clip-screen.test.tsx` les vérifie mot
  pour mot.

## 5. Engagement avec la refonte du 28 août

Deux choix de cette refonte sont porteurs et non rediscutés :

- **Dimensionner la sortie sur la hauteur du volet plutôt que sur une
  constante partagée avec la source** (`PREVIEW_FRAME`, annulée le 28 août).
  Ce chantier ne touche pas le volet droit, et l'idée — que deux aperçus
  peuvent avoir des logiques de taille indépendantes — est justement ce qui
  motive de corriger le calcul de hauteur de la rangée plutôt que de lui
  imposer un budget partagé avec la sortie (§4.2).
- **`Temps` et `Mots` comme deux viseurs d'une même édition, au niveau des
  données.** `setBoundaryAt` et `poserBound` écrivent la même liste de
  segments et empilent le même point d'annulation (spec du 28 août, §4.1).
  Cette unification-là tient sans réserve, et le §2.5 s'appuie dessus : c'est
  parce que les deux modes n'ont jamais été que deux vues d'un seul modèle
  qu'ils peuvent coexister à l'écran sans risque d'incohérence entre eux.

Deux choix se sont retournés, tous deux dans la même famille — un budget fixé
puis jamais rouvert :

- **Le budget de 365 px sans marge** (spec du 28 août, §3). Le §3 de ce
  document en donne la raison précise, chiffrée : le budget n'a jamais été
  recalculé après les deux ajouts qui l'ont le plus alourdi (le ruban de la
  bande, +~60 px ; les déclencheurs de modale de la #281, qui remplacent des
  blocs plus légers mais n'ont pas réduit le nombre de blocs empilés). Ce
  n'est pas le budget qui était trop serré en soi — c'est qu'il n'a plus
  jamais été revérifié après avoir été fixé.
- **L'exclusivité visuelle de `Temps | Mots`** (spec du 28 août, §4.1 :
  « Les deux surfaces visibles en même temps ont été écartées faute de
  hauteur »). La décision était juste **au moment où elle a été prise** — 365 px
  ne portaient déjà pas grand-chose de plus. Elle ne l'est plus une fois que
  le budget lui-même est reconnu insuffisant (point précédent) : masquer le
  transcript n'était pas une décision de fond, c'était la conséquence d'un
  budget qui n'avait pas de marge pour lui. Le §2.5 la défait, sans plus
  avoir besoin de la conditionner à un seuil (§4.5).

**Un même commitment porte les deux — et, en le regardant depuis
l'arbitrage du 30 août (nuit), porte aussi tout le reste de ce chantier.**
Le 28 août avait tranché pour **deux volets fixes où rien ne défile**. Chaque
symptôme mesuré ici en découle directement : le `<dl>` qui doublonnait les
bornes A/B (§1 de `D-critique.md`, l'entrée de ce chantier, déjà en cours de
correction par la PR #286 — voir la note d'ouverture de ce document) venait
d'un budget qu'il fallait faire tenir à tout prix, poussant à répéter une
valeur affichée ailleurs plutôt qu'à lui trouver une place ; le débordement
vidéo/bande et vidéo/transport (§1.1) vient d'un plafond (`58vh`) posé pour la
même raison, sur un calcul de rangée qui ne le respectait déjà pas ; le seuil
recalculé une première fois (§3.4, version initiale de ce document) retombait,
lui aussi, sur un budget à tenir au pixel près. Retirer
ce commitment — l'arbitrage du propriétaire, « au pire on scroll un peu » —
ne corrige donc pas un symptôme de plus : il retire la cause commune aux
quatre. Ce que corrigent encore §4.1-§4.2, c'est le bug de calcul CSS
lui-même (`items-start` + `aspect-ratio` + `flex-wrap`), qui resterait un
défaut même sans budget à tenir — mais il cesse d'être **entretenu** par une
contrainte qui le forçait à mentir sur sa propre taille.

Ce mécanisme de débordement flexbox touche potentiellement d'autres endroits
de l'écran qui utilisent le même patron ; il n'a pas été cherché ailleurs que
dans la rangée source+fiche — signalé pour un futur audit, pas traité ici.

## 6. Rapport à l'issue #131

L'issue porte six constats (§3.1 à §3.6 de la spec du 23 août). Ce chantier
n'en traite directement qu'**un**, le §3.3 (« 45 % de la colonne Image est
vide, Contenu étrangle ses champs ») — dans sa forme d'aujourd'hui, qui n'est
plus le vide de 557 px décrit le 23 août (déjà comblé par la fiche à droite de
la source, le 28 août) mais son successeur : sept blocs sans relief visuel,
plus le débordement du §1.1.

Les autres constats restent ouverts, et ne sont pas dans le périmètre de ce
document :

- **§3.1 (undo du cadrage)** — isolé dans `src/store/editor.ts`, sans
  dépendance sur ce chantier ; peut partir indépendamment.
- **§3.2 (texte de publication saisi deux fois)** — déjà résolu par la
  séparation Édition/Exports du 28 août : `exports-view.tsx` n'expose que des
  champs `FieldCopyable` en lecture seule (`:157-171`), pas une seconde saisie.
  À vérifier avec le propriétaire si ce constat peut être refermé indépendamment
  de ce chantier.
- **§3.5 (carte de proposition)** — l'écran du vivier, pas `/clips/:id` : hors
  périmètre par construction.
- **§3.6 (aperçu du hook)** — nouvelle fonction, explicitement exclue du
  périmètre de ce chantier par le contrat qui l'a lancé.

**Recommandation : ne pas refermer #131 avec ce chantier.** Il l'entame sur son
seul constat encore ouvert et applicable ici (§3.3), et laisse #3.1 au moins
comme travail restant identifié. À la charge de l'humain de décider si #3.2 se
referme sur simple vérification, ou si #3.1/#3.6 méritent une issue de suivi
séparée — ce document ne tranche pas une décision de tracker qui ne lui
appartient pas.
