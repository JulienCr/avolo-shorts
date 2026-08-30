# La hiérarchie du volet Image — la forme arrêtée le 30 août

Date : 30 août 2026. Statut : **arrêté**, pas encore implémenté.

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

## 1. Ce qui est mesuré, et où la critique se trompe

Mesures prises avec Playwright (Chromium 130, headless) sur
`http://localhost:4014/clips/2026-03-08-caro-mdlm_005472883-005518477`, la même
clip de référence que le 28 août. Le choix de l'outil est une adaptation
délibérée : la contrainte du contrat (fenêtre Chrome bloquée à 5120×1440,
mesurer dans une iframe pincée) vaut pour un Chrome **de bureau, sous Windows**,
piloté depuis WSL. Playwright pilote un Chromium **headless**, natif à WSL, dont
le viewport se règle directement — le même besoin (un vrai moteur de rendu, pas
jsdom) sans le contournement de l'iframe.

### 1.1 Le débordement existe à 2560 × 1320, contrairement à ce que dit le contrat

Le contrat de ce chantier affirme : « 32 px à 1920×1080, none at 2560×1320 ».
**C'est faux, mesuré trois fois, avec capture d'écran à l'appui.**

```
Playwright, 2560 × 1320 :
  row (le conteneur "flex-wrap ... max-h-[58vh]")   : haut 242, bas 960, h 718
  figure (ClipPlayer, aspect-ratio 16/9)            : haut 242, bas 1003, h 762
  transport (le bloc suivant, "shrink-0")           : haut 972, bas 1000, h 28

  → la figure déborde son propre conteneur de 43 px (1003 - 960)
  → elle recouvre l'intégralité du bloc transport (chevauchement de 28 px,
    min(1003,1000) - max(242,972) = 28)
```

À 1920 × 1080, le chevauchement mesuré est de **28 px**, proche des 32 annoncés
(petit écart de commit, sans conséquence). **La différence qui compte, c'est
1920×1080 vs 2560×1320** : le contrat présentait la seconde comme saine, elle ne
l'est pas. Capture jointe : `overlap-2560.png` dans le scratchpad de cette
tâche, montrant le rectangle de cadrage du plan qui déborde visiblement sur la
ligne de transport en dessous.

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
différent (une hauteur de contenu, pas un `aspect-ratio`). Un simple
`overflow-hidden` posé sur la rangée réglerait le débordement de la vidéo
(perte tolérable — quelques pixels de bandes noires) mais **couperait des
champs de saisie de la fiche** dans ce second cas — un défaut fonctionnel, pas
seulement visuel. La correction ne peut donc pas être un `overflow-hidden`
unique posé sur la rangée ; voir §4.

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
hauteur.** Voir le calcul du §3. Le vrai gain de hauteur vient d'ailleurs : la
ligne d'outils unique (§2.3) et une hauteur de rangée **calculée**, plus une
`fiche` qui défile en interne plutôt que de déborder (§2.1 et §4.1).

### 2.1 Carte Source

Bordure autour de la rangée source + fiche + transport, avec la légende
existante (« la source — le rectangle est le cadre pris pour ce plan ») en
guise d'en-tête — pas de nouveau `<h2>`. À l'intérieur :

- la **figure source** (16:9, avec le rectangle de cadrage superposé) —
  `overflow-hidden` en filet de sécurité, pas en mécanisme principal ;
- la **fiche éditoriale** (Titre, Description, Hook, Badge) à droite, dans un
  conteneur à `max-height: 100%` et `overflow-y-auto` propre — **c'est le
  changement qui règle le débordement du §1.1** : la fiche ne peut plus pousser
  le conteneur au-delà de la hauteur que la rangée lui accorde, elle défile en
  interne au lieu d'échapper à sa boîte ;
- le **transport**, sous les deux, inchangé.

La hauteur de la rangée n'est plus `max-h-[58vh]` (un pourcentage de la
fenêtre, sans rapport avec ce qu'il y a autour) mais une valeur calculée contre
le chrome fixe réel — voir §3. **La figure garde `overflow-hidden` en plus**,
parce que même avec une hauteur calculée exacte, un cas limite (fenêtre très
basse **et** très étroite en même temps) peut encore produire un `aspect-ratio`
dont la hauteur voulue dépasse d'un pixel ou deux ; le filet coupe alors
quelques pixels de bande noire, jamais du contenu qui compte.

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
et il n'a pas besoin d'être remplacé pour porter ce chantier. Ce qu'il lui
manque, c'est une **borne de hauteur avec défilement interne**, exactement le
mécanisme déjà retenu pour la fiche éditoriale au §4.2 : sans elle, un clip de
88 s pousserait son panneau à 287 px, un clip plus long encore davantage, et
le budget de la carte Montage grandirait avec la durée du clip au lieu de
rester fixe.

**Proposition : un panneau transcript de hauteur fixe (~150 px, l'ordre de
grandeur de la bande elle-même), avec défilement interne, affiché en
permanence sous la bande dans la carte Montage.** À 150 px, le clip de
référence (137 mots, ≈ 138 px estimés au prorata du relevé de 287 px pour
284 mots) tient sans défiler ; le clip le plus long défile. Aucun clip de
l'émission n'oblige à agrandir ce chiffre — il borne le pire cas, pas la
moyenne.

**La bascule `◷ Temps | ❞ Mots` ne survit pas telle quelle, et c'est le seuil
`workbench` lui-même qui tranche où.**

- **Au-dessus du seuil : elle disparaît comme sélecteur de mode.** Les deux
  panneaux étant tous les deux visibles, un composant `Tabs`
  (`timeline.tsx:294-318`, un vrai `role="tablist"` avec un unique
  `TabsContent`) n'a plus de sens — l'ARIA d'un tabpanel promet qu'un seul
  panneau est visible à la fois, exactement le contrat que la coexistence
  rompt. Garder les deux étiquettes comme simples ancres de défilement (cliquer
  « Mots » amène le panneau transcript dans le viewport et y place le focus,
  cliquer « Temps » fait le symétrique vers la bande) est une option
  raisonnable si le propriétaire veut garder un raccourci visuel vers chacun,
  mais ce n'est plus une bascule.
- **En dessous du seuil : elle reste exactement ce qu'elle est aujourd'hui**,
  bascule exclusive comprise. La colonne qui défile n'a pas la place pour les
  deux blocs à la fois — c'est déjà la situation qui a fait écarter la
  coexistence le 28 août, et rien dans cet amendement ne change ce calcul-là
  en dessous du seuil. **Le même seuil qui décide entre volet fixe et colonne
  qui défile décide donc aussi entre coexistence et bascule** — pas un
  second seuil à inventer, le même.

**`Ctrl+F` suit la même coupure.** Au-dessus du seuil, il amène le focus dans
le champ de recherche du panneau transcript déjà visible, sans rien démonter.
En dessous, il continue de faire ce qu'il fait aujourd'hui
(`shortcuts.tsx:172` ; `clip-screen.tsx:314-317`) : basculer en mode Mots.

**Conséquence chiffrée, qui revient au §3.** Ajouter un panneau de 150 px en
permanence est le plus gros ajout de tout ce chantier au budget vertical —
plus gros que tout ce que le regroupement en cartes a coûté ou fait gagner.
Le §3.6 en tire l'arithmétique.

## 3. L'arithmétique du seuil `workbench`, refaite

Méthode identique à celle de `globals.css:8-29` (28 août) : sommer, à une
largeur de référence, tout ce qui n'est ni la source ni la sortie, puis
demander combien il reste aux deux aperçus à la hauteur de seuil.

**Largeur de référence : 1024 px, pas 1416.** Le 23 août avait choisi 1416 sans
justifier le choix contre le plancher réel du seuil. Le pire cas pour la
rangée source+fiche est justement à la largeur **minimale** que `workbench`
autorise (1024), parce que c'est là que la fiche (largeur fixe minimale,
360 px) mange le plus de place relative face à la figure.

### 3.1 Ce qui est mesuré, indépendant de la largeur

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

### 3.2 Ce qui change avec ce chantier — estimé, à revérifier une fois construit

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

### 3.3 Le budget qu'il reste à la rangée, à la largeur plancher (1024 px)

À 1024 px de large : fiche à 360 px (son minimum, `clamp(360px, 30cqw, 620px)`
à 30 % de ~950 px de conteneur = 285, donc bornée au plancher), figure à
`1024 − 32(remplissage) − 360(fiche) − 16(gap) = 616` px de large, soit
`616 × 9 / 16 ≈ 347` px de haut à pleine largeur disponible.

Avec la fiche bornée en interne (§2.1, `max-height` + défilement plutôt que
hauteur naturelle), **la rangée n'a plus besoin d'accueillir le pire des deux
côtés** : elle a juste besoin de la hauteur de la figure, 347 px, la fiche
s'ajustant dans ce qu'on lui laisse.

### 3.4 Le nouveau seuil

```
seuil ≥ chrome(654) + rangée_confortable(347) ≈ 1001 px
```

**Conclusion inattendue : le chiffre ne bouge presque pas.** 1001 px calculé
contre 1000 px aujourd'hui — à un pixel près. Ce n'est pas une coïncidence
suspecte, c'est la conséquence directe du §3.2 : ce chantier fait à peu près du
surplace sur le budget vertical (+52 de chrome, mais l'assouplissement de la
fiche libère un peu plus que ça sur la rangée elle-même). **Garder 1000 px**,
mais avec deux différences par rapport à aujourd'hui :

1. **Le chiffre est maintenant vrai.** Aujourd'hui, à 1024×1000 exactement, le
   contenu déborde déjà (§1.2). Avec la fiche bornée en interne, il ne
   débordera plus — la marge est fine (moins de 1 px sur le calcul ci-dessus),
   donc à vérifier à l'œil une fois construit, pas seulement recalculé.
2. **Le seuil reste inatteignable sur un 1920×1080 réel** (hauteur utile
   mesurée : 937 px, §1.2). Ce n'est pas un défaut de calcul, c'est un fait :
   il n'y a pas 1000 px de hauteur utile sur cet écran une fois la fenêtre du
   navigateur et la barre des tâches Windows déduites, quelle que soit la
   mise en page. Le repli en colonne qui défile (§2.4) **est** la réponse
   pour ce cas, pas un pis-aller à corriger davantage — c'est déjà ce que dit
   le commentaire de `globals.css`, et rien dans cette mesure ne le contredit.

Si le propriétaire préfère élargir la couverture des écrans 1080p plutôt que
garder un budget confortable, la marge du §3.3 (347 px pour la figure) peut
descendre jusqu'à ~250 px sans que la figure devienne illisible, ramenant le
seuil à ~904 px — **mais ça reste sous les 937 px mesurés d'un 1080p réel**
sans jamais les atteindre confortablement tant que la barre d'app (48) et la
fresque des clips (146) occupent 194 px avant même la colonne Image. Ce
chiffre-là (904) est proposé, pas arrêté : c'est un curseur à trancher avec le
propriétaire, pas une déduction unique.

**Ce chiffre est repris et corrigé au §3.6** : l'amendement du §2.5 (la
coexistence bande/transcript) ajoute un poste que le calcul ci-dessus ne
porte pas encore.

### 3.5 Pourquoi ça reste une `@media`, jamais une container query

Une container query répond à la taille du **conteneur**, jamais à celle du
**viewport**. La question posée par `workbench` — « est-ce que la fenêtre a la
place verticale pour deux volets fixes sans défiler » — porte sur le viewport
par construction : c'est justement parce que la fenêtre est haute qu'on peut se
permettre de ne pas faire défiler `main`. Un conteneur n'a pas de hauteur
propre à interroger avant que le reste de la page (barre d'app, fresque) ait
déjà pris la sienne — la seule taille disponible à ce moment-là **est** celle
du viewport.

Il y a un second problème, plus subtil, et il est déjà visible dans le code
d'aujourd'hui : la section Image porte `workbench:[container-type:inline-size]`
(`clip-screen.tsx:612-615`), utilisé par `30cqw` pour la largeur de la fiche.
**`inline-size` ne peut répondre qu'à des requêtes de largeur.** Passer la
question du seuil à une container query demanderait `container-type: size`
(largeur **et** hauteur), qui force le navigateur à calculer la taille du
conteneur *avant* de savoir combien de place il occupera dans la page — un
problème circulaire quand ce même conteneur décide, via le seuil, s'il doit
être un volet fixe ou une colonne qui défile. Le viewport, lui, est toujours
connu avant la mise en page : c'est précisément pour ça qu'une `@media` reste
la bonne réponse à cette question-là, et une container query la bonne réponse
à la question — différente — de la largeur de la fiche.

**Ce raisonnement n'est pas à reproposer.** Il a déjà été demandé une fois par
le contrat de ce chantier (§ « Le seuil `workbench` »), et une fois par la
critique d'entrée (§5) ; les deux disent la même chose sans le démontrer. Ce
paragraphe est la démonstration, pour que la question ne revienne pas une
troisième fois.

### 3.6 L'arithmétique de la coexistence, et la tension qu'elle rend visible

Le §2.5 ajoute un panneau transcript de ~150 px, affiché en permanence
au-dessus du seuil, plus un espacement (~16 px) qui n'existait pas. Reporté
dans le calcul du §3.4 :

```
ancien seuil (§3.4)              : chrome(654) + rangée(347)         ≈ 1001 px
avec le panneau transcript       : chrome(654) + rangée(347)
                                    + panneau(150) + espacement(16)  ≈ 1167 px
```

**Ce chiffre va dans le sens contraire du but affiché de l'issue #131** —
rendre le seuil atteignable sur l'écran le plus courant. Un 1920×1080 réel
offre ~937 px de hauteur utile (§1.2) ; même l'ancien seuil, à 1000, ne
l'atteignait déjà pas. À 1167, l'écart se creuse : **aucun 1080p, même sans
barre de titre ni barre des tâches, n'atteindra ce chiffre.** Ce n'est pas un
défaut d'arithmétique à corriger en cherchant encore de la marge ailleurs — il
n'y a plus grand-chose à gratter (le §3.2 avait déjà trouvé la fusion de la
ligne d'outils, sa seule vraie économie, et elle est comptée dans les 654).
**C'est une tension réelle entre deux demandes qui tirent en sens opposé**, et
elle doit se trancher par un choix, pas par un calcul plus fin.

**Deux issues, à choisir par le propriétaire :**

1. **Accepter le seuil à ~1170-1200 px.** Le volet fixe à deux colonnes ne
   s'active plus que sur les écrans les plus hauts (2560×1320 et au-delà) ;
   tout le reste — 1080p compris — passe par le repli en colonne qui défile
   du §2.4. Ce repli n'est plus le mode dégradé et cassé d'aujourd'hui : avec
   la fiche bornée (§4.2) et le calcul refait, il fonctionne. Un repli qui
   marche n'est pas un pis-aller : c'était déjà l'intention du commentaire du
   23 août dans `globals.css`, avant que les mesures de ce chantier ne
   montrent qu'il ne marchait plus.
2. **Réduire le panneau transcript en dessous de 150 px** (par exemple ~90 px,
   trois à quatre lignes visibles avant défilement) pour limiter la casse sur
   le seuil, au prix d'un panneau qui défile plus souvent, y compris sur des
   clips courts.

Ce document ne tranche pas entre les deux : c'est un arbitrage de confort
d'écran contre couverture d'écran, pas une question qui se déduit d'une
mesure. **Recommandation, pas décision** : l'option 1, parce que la coexistence
est la demande la plus récente et la plus explicite du propriétaire, et
qu'elle a plus de valeur que la couverture du seuil sur un 1080p — mais c'est
son arbitrage à faire, pas celui de ce document.

## 4. Ce qui se retire, explicitement, pour que ça se veto avant de disparaître

Rien de nouveau ne s'ajoute — ce chantier retire et regroupe. Cinq choses,
dans un ordre de risque croissant :

### 4.1 Le `max-h-[58vh]` de la rangée

Remplacé par une valeur calculée contre le chrome réel plutôt qu'une fraction
arbitraire du viewport. **58vh n'a jamais eu de rapport avec ce qui entoure la
rangée** — c'était un chiffre qui marchait par coïncidence à une combinaison de
tailles, pas un calcul. C'est la cause directe du bug du §1.1 : un pourcentage
de fenêtre ignore complètement combien de chrome fixe se trouve au-dessus et
en dessous de la rangée.

### 4.2 La hauteur naturelle de la fiche éditoriale

Elle perd le droit de pousser son conteneur : `max-height: 100%` +
`overflow-y-auto`, propre à la fiche, pas à toute la rangée. **Conséquence
visible pour l'utilisateur** : une description très longue, ou beaucoup de
mots-dièse, peut désormais faire défiler la fiche à l'intérieur de sa propre
carte plutôt que de repousser la figure ou déborder sur le transport. C'est un
changement de comportement, pas seulement de code — à valider avec le
propriétaire avant de l'implémenter, puisque défiler dans un petit encart n'est
pas gratuit pour l'ergonomie.

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

### 4.5 La bascule Temps/Mots, comme sélecteur de mode exclusif — au-dessus du seuil seulement

Décrit au §2.5. Les deux panneaux restant montés, le composant `Tabs`
(`timeline.tsx:294-318`) n'a plus de `tabpanel` unique à annoncer ; il se
retire au profit de deux ancres de défilement, ou disparaît complètement si le
propriétaire ne tient pas à garder un raccourci visuel vers chacun. **En
dessous du seuil, rien ne bouge** : la bascule reste, exclusive, exactement
comme aujourd'hui — §2.5 explique pourquoi le même seuil tranche les deux
questions.

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
  motive de donner à la fiche sa propre borne de hauteur (§4.2) plutôt que de
  la laisser dicter celle de toute la rangée.
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
  budget qui n'avait pas de marge pour lui. Le §2.5 la défait, à la demande du
  propriétaire, et le §3.6 en chiffre le prix.

Un troisième point, qui n'est ni un acquis ni un raté mais une découverte de ce
chantier : **le mécanisme de débordement de flexbox (`items-start` +
`aspect-ratio` + `flex-wrap`) touche potentiellement d'autres endroits de
l'écran qui utilisent le même patron.** Il n'a pas été cherché ailleurs que
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
