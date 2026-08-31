# Post-mortem — la flotte du 30 août sur l'écran de clip

Écrit à la demande de Julien, à la fin d'une session qu'il a qualifiée de
catastrophique. **Le but n'est pas de plaider : c'est de rendre la prochaine
tentative moins chère.**

## Ce qui a été livré

Quatre PR fusionnées, huit issues fermées, `main` vert à 3763 tests.

| PR | Sujet | Issues |
|---|---|---|
| #285 | restauration de `process.env` dans les tests | #276 |
| #287 | courses de publication vignette/planche | #274, #275 |
| #286 | cinq dettes de l'écran de clip | #277, #279, #280, #282, #283 |
| #289 | hiérarchie du volet gauche, seuil `workbench` | (n'a pas fermé #131) |

Deux issues déposées en cours de route : #288, #291.

## Ce qui a raté

**L'écran ne convient toujours pas.** C'est le seul critère qui comptait, et
c'est celui-là qui n'est pas atteint. Julien devra reprendre le chantier.

### 1. Sur un travail visuel, l'orchestrateur a rendu des chiffres, jamais des images

Le point d'arrêt visuel a été livré sous forme de tableaux de valeurs mesurées.
**C'est Julien qui a envoyé les captures d'écran**, trois fois, et c'est lui qui
a trouvé chacun des défauts visibles : le désordre sous la bande, le
recouvrement bande/vidéo, les vignettes étirées, les boutons `Temps | Mots`
inertes.

Une préférence enregistrée disait explicitement que sur une mesure visuelle il
faut soumettre les **paires avant/après**, pas un tableau. Elle n'a pas été
suivie.

### 2. Le contrôle de recouvrement était incomplet, deux fois de suite

- Première annonce : « géométrie inchangée », sur les métriques du relevé de
  référence (largeurs, défilement) — **sans aucun contrôle de recouvrement**.
  La PR posait 65 px de bande sur la vidéo à 2560×1320.
- Deuxième annonce, après la capture de Julien : contrôle vidéo/bande ajouté,
  recouvrement mesuré à 0. **Il manquait encore vidéo/transport**, 28 px, trouvé
  par un agent et non par l'orchestrateur.

**Leçon : un contrôle de recouvrement n'est complet que si on énumère les
paires.** « Vérifier la mise en page » n'est pas une consigne exécutable ; la
liste des paires en est une. Elle est désormais dans le plan de la refonte.

Deuxième leçon, du même épisode : un sélecteur aveugle rend un faux négatif.
L'orchestrateur a conclu « le commutateur n'existe plus dans le DOM » depuis une
recherche sur `role="tab"` / `aria-pressed` — les boutons n'avaient ni l'un ni
l'autre. **Un résultat négatif tiré d'un sélecteur qui ne pouvait pas trouver la
cible n'est pas un résultat.**

### 3. Le protocole était le mauvais outil pour la seconde moitié du chantier

La skill `orchestrating-agent-fleets` a été choisie parce que le travail est
arrivé sous forme de liste d'issues. Elle n'a jamais été **re**choisie quand le
chantier est devenu de la conception ouverte, après « toute cette partie est
affreuse ».

Ses garanties — propriété de fichier, revue interne, contrat autoportant —
traitent la collision et la correction. Elles ne traitent pas « est-ce que c'est
ce que l'humain voulait voir ». Et sa latence l'empêche activement : contrat →
implémenteur → deux rondes de revue interne → intégrateur → jusqu'à cinq passes
de bots, soit **20 à 40 minutes par itération**. Sur du jugement visuel, ça met
l'humain en bout de chaîne au lieu de le mettre dans la boucle.

### 4. Le budget est parti dans la rigueur, pas dans le résultat

Une quinzaine d'agents, plusieurs centaines de milliers de tokens, dont une part
notable à vérifier des vérifications. Les huit issues sont fermées proprement.
L'écran n'est pas meilleur aux yeux de son utilisateur.

### 5. Trop de prose

Julien a dû le dire deux fois : « tu me parles trop », « si je dois faire
quelque chose, ne le noie pas dans un pavé ». Une demande à l'humain doit tenir
en trois lignes et arriver seule.

## Ce qui a bien marché, et qu'il faut garder

- **Les revues internes ont trouvé ce que les bots ne trouvent pas.** L'assertion
  `not.toHaveBeenCalled()` placée après `mockRestore()`, donc incapable
  d'échouer, et citée dans le corps de PR comme sa preuve. Le doublon « Bornes »
  entre le `<dl>` et les champs A/B.
- **Vérifier par opération plutôt que par lecture.** Les relecteurs qui ont
  réintroduit exprès le bug pour voir le test tomber, puis remis le code, ont
  produit les seules garanties solides de la session.
- **Les agents ont rendu compte honnêtement de leurs limites.** Un implémenteur
  sans navigateur a fourni une reconstruction calculée en la marquant comme
  telle et en demandant vérification ; elle était juste au pixel près.
- **Une rétractation explicite.** Un agent avait écrit « la critique se trompe »
  dans une spec ; après vérification il a retitré la section, écrit que le
  chiffre adverse était juste, et mis la rétractation dans le message de commit.
- **La collision inter-sessions a été négociée, pas devinée.** Deux sessions
  pairs interrogées avant de brancher ; l'une a transmis la règle split/doublage
  qui n'est écrite nulle part et que la PR allait enfreindre une troisième fois.

## Le motif le plus cher de la session

**Quatre tests qui passaient sans rien valider**, tous dans la même famille :

1. `expect(renameSpy).not.toHaveBeenCalled()` **après** `mockRestore()`, qui
   efface l'historique d'appels — inconditionnellement vraie.
2. Un test de course lisant un appel de mock laissé par le test précédent.
3. Un test d'éviction qui passait par coïncidence, la comparaison brute tombant
   juste sans que la normalisation serve à rien.
4. Une porte (`comment-budget.sh`) annoncée verte sans avoir été lue ; l'outil
   signalait un dépassement.

Trois ont été trouvés par des bots ou des relecteurs, un en retapant la
commande. **Le compte de tests ne dit rien, la suite verte ne dit rien.** Seul
un test qu'on a vu échouer sur le commit parent dit quelque chose — et encore
faut-il vérifier qu'il échoue **à la bonne ligne**, pour la bonne raison.

Corollaire, apparu deux fois : **un agent qui affirme qu'une porte est verte
sans avoir lu la sortie de la commande**. La parade est mécanique — capturer la
sortie, lire `$?`, `grep` le résultat — et elle doit être dans le contrat.

## Ce qu'il faut faire autrement

**Pour un objectif que seul un humain peut juger, la flotte est le mauvais
outil.** Le critère de sélection n'est pas « combien de fichiers » mais **« qui
décide si c'est bon »**.

| | flotte | boucle courte |
|---|---|---|
| Critère d'acceptation | vérifiable par une machine | jugé par un humain |
| Exemples | les huit issues, les courses serveur | « cet écran est brouillon » |
| Forme | contrat, revue interne, intégrateur | un agent, un serveur, des images |
| Latence | 20-40 min par itération | quelques minutes |

Pour reprendre l'écran :

1. **Un seul agent**, pas de contrat de 400 lignes, pas de revue interne.
2. **Un serveur qui tourne en permanence**, et Julien avec l'URL.
3. **Une capture avant/après à chaque changement**, poussée à lui — jamais un
   tableau de chiffres à la place d'une image.
4. **Son avis toutes les dix minutes**, pas une validation à la fin.
5. Les portes automatiques (lint, types, tests) restent, mais ne décident rien
   sur le rendu.

## Ce qui reste ouvert

- **#131** — la hiérarchie des écrans. La PR #289 n'en couvre qu'un sous-ensemble
  et ne l'a délibérément pas fermée.
- **#288** — seconde course dans `renderPoster`, contre un ré-export concurrent.
- **#291** — couverture manquante sur le défilement interne de `TranscriptSurface`.
- **PR E**, en cours au moment d'écrire : boutons début/fin, suivi du transcript
  pendant la lecture, ratio des vignettes de la planche.
- **La règle split/doublage n'est écrite nulle part dans le dépôt.** Enfreinte ou
  approchée quatre fois. Une session pair proposait de l'inscrire dans
  `.claude/skills/cadrage/SKILL.md` et attend un feu vert.

---

# Addendum — la nuit du 30 au 31 août

Écrit après coup, en autonomie, Julien endormi. Trois PR de plus, et une leçon
qui manquait au post-mortem.

## Livré

| PR | Sujet |
|---|---|
| #292 | boutons début/fin, ratio des vignettes, calage de l'export sur le montage |
| #296 | la bande ne validait aucun geste : `commit()` ne partait jamais |

Plus l'issue **#288** et trois de suite : **#293**, **#294**, **#295**.

## Ce que #296 a révélé, et qui change le diagnostic du chantier

**Aucun geste sur la bande de temps ne fonctionnait.** Ni le clic, ni le glissé —
seules les oreilles marchaient. `commit()` était atteint depuis un
`window.addEventListener('pointerup')` posé dans un `useEffect` : entre le double
appel du mode strict et les dépendances instables, l'écouteur était démonté et
reposé assez souvent pour que le vrai `pointerup` tombe dans un trou.

Cela réécrit une partie du post-mortem. « L'écran ne convient pas » n'était pas
seulement une affaire de mise en page : **son geste principal était mort**, et
aucune porte automatique ne le voyait, parce que jsdom synthétise des événements
qui n'ont pas ce défaut de calendrier.

## Deux incidents à ne pas répéter

### Les tests navigateur écrivent dans la vraie base

`projects/avolo.db` est partagée par tous les worktrees, et un serveur de
développement y écrit pour de bon. Un scénario hostile monté par un relecteur a
**vidé les segments d'un vrai clip sur disque**, et un autre a fait retomber un
clip de `exported` à `kept`. Les deux ont été réparés — le second seulement parce
que j'avais relevé son statut plus tôt dans la session et que je l'ai recoupé.

**Conséquence : un test en navigateur n'est pas inerte.** Sauvegarder la base
avant, vérifier la ligne touchée après, et ne jamais supposer qu'un clic dans une
page est sans effet.

### J'ai mesuré un serveur périmé et lancé une flotte sur un fantôme

Après le merge de #296 j'ai mesuré que le clic ne déplaçait toujours pas le
lecteur, et j'ai monté un contrat entier (PR G) sur ce constat. L'agent n'a rien
trouvé à corriger et a refusé d'inventer un correctif — il avait raison. Un
serveur d'un worktree précédent tenait encore le port 4012 ; ma commande de
relance n'avait pas pu s'y lier, et je lisais donc du code d'avant le correctif.

**Un `next dev` qui ne peut pas prendre son port ne le dit pas clairement, et le
serveur en place continue de servir.** Vérifier le `cwd` du processus qui écoute
(`readlink /proc/$pid/cwd`), pas seulement que le port répond. Une mesure ne vaut
que si l'on sait quel code la produit.

## L'état au réveil

`main` à `5a30cc2`, 168 fichiers / 3812 tests verts. Aucun worktree, aucune
branche de la session, aucun serveur. Base saine : 93 clips, zéro segment vide,
les deux clips touchés restaurés.

Vérifié en navigateur sur `main` mergé, à 1920×937 et 1456×900 : le clic sur la
bande déplace le lecteur visible de 5472,883 à 5500,644, l'écriture tracée
atterrit bien sur lui, les vignettes sont à 1,78 et la bande est remplie.
