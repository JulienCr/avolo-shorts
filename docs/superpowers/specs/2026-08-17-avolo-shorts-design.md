# avolo-shorts : conception

Date : 17 août 2026.
Statut : validé section par section, en attente de relecture finale avant plan d'implémentation.

Le nom `avolo-shorts` est retenu, par cohérence avec `avolo-cam`, `avolo-server`
et `avolo-logo`.

## 1. Le problème

Julien produit « LA SCÈNE AVOLO », une émission d'improvisation théâtrale diffusée en
direct sur Twitch. Vingt émissions sont déjà enregistrées, de 4,5 à 12,7 Go pièce,
soit environ 150 Go. Il veut en tirer des extraits courts pour Instagram, TikTok,
YouTube Shorts et Facebook.

OpenShorts, qu'il utilise aujourd'hui, ne convient pas. Ce n'est pas une question
de réglage : son cœur résout un autre problème. Il cherche un sujet à suivre là
où il faut cadrer une scène, il détecte des visages là où il faut détecter des
corps, et il ne sait produire que du 9:16 ou du 16:9 posé sur fond flouté, qui
n'occupe alors que 32 % de la hauteur d'écran.

## 2. Ce qui a été mesuré

Trois émissions entières échantillonnées le 17 août 2026, 400 images chacune,
détection MediaPipe pleine portée au seuil 0,5.

Les trois émissions mesurées : 1920x1080, 60 fps, h264 à environ 6 Mbps, audio
AAC stéréo 48 kHz, 2 à 3 heures. La cadence n'est pas uniforme sur tout le
corpus : `2025-06-15-cqlp.mp4` est déjà en 30 fps. Sans conséquence, le filtre
`fps=30` traite les deux cas.

### Le cadre le plus serré qui contient encore les gens

Un crop pleine hauteur de ratio `r` dans une image 16:9 couvre `r / (16/9)` de la
largeur. Pour chaque image, on calcule l'empan des personnes détectées augmenté
d'une largeur de visage de chaque côté (les épaules), puis on cherche le plus
petit ratio qui le couvre.

| | Duo 2h17 | Groupe 1h53 | Trio 2h50 |
|---|---|---|---|
| 9:16 suffit (31,6 % de largeur) | 24,2 % | 31,2 % | 32,8 % |
| 4:5 nécessaire (45,0 %) | 13,8 % | 8,5 % | 6,0 % |
| 1:1 nécessaire (56,2 %) | 10,2 % | 9,8 % | 8,8 % |
| 16:9 obligatoire | 46,5 % | 20,0 % | 33,2 % |
| Aucun visage détecté | 5,2 % | 30,5 % | 19,2 % |
| **Cumul jusqu'à 1:1** | **48,2 %** | **49,5 %** | **47,5 %** |

Le cumul tombe à 48 % sur les trois, malgré trois configurations de plateau
différentes. C'est une propriété du dispositif de tournage. Autoriser les ratios
médians double la couverture par rapport au seul 9:16.

Sur un canevas 9:16 de 1080x1920, un 16:9 en letterbox occupe 32 % de la hauteur,
un 1:1 en occupe 56 %, un 4:5 en occupe 70 %. La moitié du bénéfice visuel du
projet se gagne là.

**Ces mesures comptent toute personne détectée, spectateurs compris.** La méthode
prend l'empan de tout ce que le détecteur trouve, sans distinguer un comédien sur
le plateau d'une tête de spectateur collée au bord bas de l'image. La détection au
corps du 18 août 2026 dit ce que ça coûte, sur `2025-06-15-cqlp` qui n'est pas
dans le tableau ci-dessus : **33,8 % des boîtes y sont du public au premier plan**
et, une fois le filtre de la §10 posé, l'empan médian tombe de 0,642 à 0,520 et la
part des images qui tient dans un 1:1 passe de 34,5 % à 60,1 %. Ces quatre nombres
étaient 0,661 / 0,540 et 31,3 % / 55,1 % tant que la marge valait 0,02 ; elle vaut
0,01 depuis le balayage du 18 août au soir (§10), et une marge entre dans l'empan
des deux côtés du filtre. Ce que le filtre gagne n'a pas bougé — le départ et
l'arrivée, si.

Ces quatre chiffres remplacent ceux qui figuraient ici — 0,68 à 0,50 et 33 % à
64 %. Ils venaient d'un écartement provisoire du premier plan, plus large que
celui qui a été retenu ; le détail de la différence est dans
`docs/premier-plan.md`.

Le tableau n'est pas réécrit : il reste ce que la méthode du 17 août a mesuré. Et
ce qu'on peut en conclure s'arrête là où s'arrêtent les mesures : la méthode
**peut** sous-estimer la couverture, largement, partout où du public entre dans le
cadre. Pas que son 48 % la sous-estime en fait. L'écart a été mesuré sur
`2025-06-15-cqlp`, qui n'est pas dans le tableau ; `2026-03-08-caro-mdlm`,
repassée en entier à la détection le 18 août, n'a que **832 boîtes de premier plan
sur 45 362, soit 1,8 %**. Le public au cadre appartient à une émission, pas au
fonds. Trancher demanderait de repasser les trois émissions du tableau à la
détection au corps, premier plan écarté.

**Et un chiffre par image ne prédit pas un ratio par clip.** Sur `cqlp`, 55,1 %
des images tiennent dans un 1:1 après filtrage, mais seules 20 % des fenêtres de
30 s en sortent avec un ratio de 1:1 ou plus serré. L'écart n'est pas une erreur :
le crop est fixe à l'intérieur d'un plan et doit cadrer 90 % des images du clip,
donc une image cadrable isolément ne l'est pas forcément par la position qui cadre
ses voisines. Les deux grandeurs se ressemblent assez pour qu'on les confonde, et
c'est la confusion qui ferait chercher un défaut là où il n'y en a pas.

### Le ratio par clip, mesuré

Le tableau ci-dessus compte des images. Ce qui sort du produit est **un ratio par
clip**, et il a été mesuré le 18 août 2026 sur trois émissions entières, filtre
du premier plan actif (`scripts/mesure-ratios.ts`).

| | `2025-06-15-cqlp` | `2026-03-08-caro-mdlm` | `2026-22-02-entre-nous` |
|---|---|---|---|
| Clips en 1:1 ou plus serré | 2 sur 8 | 0 sur 6 | 0 sur 6 |
| Fenêtres de 30 s sous le 16:9 | 25 % (197) | 1 % (339) | 8 % (227) |
| Empan résiduel médian | 0,551 | 0,778 | 0,614 |

**Ce tableau est celui du 18 août, et le rognage latéral de la §10 l'a déplacé le
19.** Aux réglages du jour, la part des fenêtres qui descend sous le 16:9 vaut
**50 % sur `cqlp`, 7 % sur `caro-mdlm` et 32 % sur `entre-nous`**, et quatorze clips
sur trente et un sortent en 1:1 ou plus serré. Le tableau reste parce qu'il dit
d'où l'on part et pourquoi la question s'est posée.

**Le cumul de 48 % du tableau des images ne se retrouve pas en clips.** Ce n'est
pas une contradiction — un crop fixe par plan doit cadrer 90 % des images du
clip, et le paragraphe précédent dit pourquoi les deux grandeurs divergent —,
mais l'ordre de grandeur n'est pas celui qu'on pouvait déduire. Et ce sont deux
émissions **sans chat incrusté** qui sortent le plus large, ce qui retire au
panneau de `cqlp` la responsabilité qu'on lui prêtait (voir §10).

L'identifiant `2026-22-02-entre-nous` porte un mois 22 : c'est le nom du fichier
sur le Drive, dont l'ingestion déduit l'identifiant de projet, et le corriger dans
un texte ne renommerait rien. À renommer à la source si ça vaut le coup.

L'explication tient au dispositif, pas au calcul : les trois émissions du tableau
d'images sont de 2025, avec des comédiens debout sur un plateau ; les deux
mesurées ici sont à trois personnes assises et écartées, avec incrustations et
diffusions de vidéo plein cadre. **Rien ne dit combien des vingt émissions
ressemblent aux unes ou aux autres**, et c'est la mesure qui manque avant de
promettre un bénéfice visuel. Le détail est dans `docs/ratios-par-clip.md`.

### Taille des sujets

| Taille du plus gros visage | Duo | Groupe | Trio |
|---|---|---|---|
| Plan serré (≥ 18 % de largeur) | 0,5 % | 0,0 % | 1,0 % |
| Plan moyen (11 à 18 %) | 22,0 % | 1,8 % | 5,5 % |
| Plan large (6 à 11 %) | 68,5 % | 51,0 % | 60,8 % |
| Très large (< 6 %) | 3,8 % | 16,8 % | 13,5 % |

Les vrais plans serrés sont quasi absents. Le mode dominant est le plan large.

La taille des visages ne bloque pas : un crop 9:16 pleine hauteur fait 607x1080,
agrandi en 1080x1920 soit 1,78x, ce que paie tout repurposing vertical depuis du
1080p. Un visage à 8,8 % de largeur ressort à 308 px en sortie, un cadrage de
short normal. Ce qui bloque est la géométrie du plateau : les comédiens occupent
des positions écartées qu'un 9:16 ne couvre pas.

### Ce que les images ont appris et que les chiffres cachaient

Une mosaïque de 600 images I sur 20 minutes d'une scène à deux montre que les
comédiens jouent debout, face à face, **de profil**, dans un **plan continu de
plusieurs minutes**. Les images I y sont contiguës toutes les 2 secondes, sans
coupe.

Deux conséquences. La détection de visages rate les profils, ce qui gonfle
artificiellement la colonne « aucun visage » : il faut détecter des corps. Et une
coupe interne ne pourra pas se cacher derrière un changement d'axe, puisqu'il n'y
en a pas pendant la scène.

**La seconde conséquence est démentie : les émissions sont multicaméra.** Détection
de plans exécutée le 18 août 2026 sur deux émissions. 131 plans sur
`2025-06-15-cqlp`, 1 h 39, médiane 27 s. 67 plans sur un extrait de 10 minutes de
`2026-03-08-caro-mdlm`, médiane 5,3 s. Vérifié image par image sur 32 candidates :
8 vraies coupes sur 10 dans la bande 0,40 à 0,50 du score de scène sur `cqlp`,
10 sur 10 au-dessus de 0,40 sur `caro-mdlm`.

La mosaïque n'était pas mal lue, elle était non représentative : vingt minutes
d'une scène à deux, prélevées dans une émission qui compte 131 plans.

**Une coupe interne peut donc se cacher derrière un changement d'axe.** Poser les
coupes sur les frontières de plans cesse d'être un raffinement pour devenir utile,
et le crop fixe par plan a de vraies frontières où se déplacer au lieu d'une seule
par scène.

**Le piège du détecteur, relevé au passage : ce n'est pas le mouvement qui fait
monter le score de scène, c'est la lumière.** Des barres de LED qui basculent
donnent 0,61 sans qu'aucune caméra ne bouge. Un seuil calé sur le seul score
prendra des changements d'éclairage pour des coupes.

Portée de tout ce qui précède : deux émissions, dont une seule en entier. C'est
plus solide que la mosaïque, ce ne sont pas les vingt du fonds.

### Contraintes de production

- Pas d'audio multipiste. Le mix se fait en amont sur une table qui n'exporte pas
  en multipiste. Aucune conception ne peut supposer une piste par micro.
- Les rires, signal **non mesuré**. La spec a longtemps écrit « pas de rires :
  l'émission n'est pas jouée devant un public », et la seconde moitié est démentie
  depuis le 18 août 2026 : sur `2025-06-15-cqlp`, 33,8 % des boîtes de personnes
  sont des têtes de spectateurs au bord bas de l'image, contre 1,8 % pour
  `2026-03-08-caro-mdlm`. Il y a donc du public sur certaines émissions. Personne
  n'a écouté si ce public s'entend. L'absence de piste séparée rend un rire plus
  dur à isoler, pas absent du mix : ni fonder ni écarter quoi que ce soit là-dessus
  avant d'avoir mesuré.
- Musique de fond fréquente, effets sonores quasi absents.
- Habillage incrusté sur les vingt émissions existantes : bloc « SOMMAIRE » sur
  environ 20 % à gauche, listes de défis à droite, cartouches de jeu en bas
  (« Bim Bam Boum ! »), logo permanent en haut à droite. Les prochains lives
  pourront être enregistrés sans habillage, mais l'existant reste tel quel.
- Aucune métadonnée de régie sur les émissions passées. Toute conception doit
  fonctionner sur le seul fichier mixé.

**L'habillage de cette liste est observé, pas relevé.** Dix images prélevées le
18 août 2026 sur quatre émissions (`2025-06-15-cqlp`, `2025-11-09-realisateur`,
`2026-03-08-caro-mdlm`, `2026-02-01-faq`) ne montrent ni le bloc de gauche ni la
liste de droite : un seul cartouche en bas à droite, et le logo en haut à droite
partout. Dix images ne prouvent pas une absence, et ces éléments apparaissent sans
doute par séquence plutôt qu'en permanence. Avant que le cadrage s'appuie sur
cette liste pour poser des préférences de crop, il faut un relevé comparable à
celui du 17 août sur les personnes : un échantillonnage régulier sur des émissions
entières, et non quelques images choisies.

### Matériel

RTX 4090, 24 Go, accessible depuis WSL. Julien possède déjà
`rythmo-impro/diarizer` : WhisperX large-v3, `pyannote/speaker-diarization-community-1`,
VAD `segmentation-3.0`, suppression de voix MDX23C.

## 3. Périmètre

Dans le périmètre :

- ingestion d'un fichier local, analyse complète, repérage de candidats ;
- délimitation d'un extrait sur son unité narrative entière ;
- nettoyage du transcript (hésitations appliquées, digressions proposées) ;
- correction du transcript (glossaire, lexique, modèle local) et correction
  manuelle persistée ;
- choix du cadre et rendu ;
- sous-titres incrustés, logo et mention Twitch ;
- interface de tri et de montage ;
- API de déclenchement ;
- **la publication vers Instagram, Facebook, TikTok et YouTube Shorts**, dont la
  conception vit à part dans
  `docs/superpowers/specs/2026-08-18-publication-reseaux-design.md`.

Cette dernière ligne était dans le hors-périmètre jusqu'au 18 août 2026 — « l'outil
produit des fichiers MP4 et les textes, Julien publie avec ses outils » — et un
spike l'en a sortie le jour même : Instagram et Facebook se publient gratuitement,
sans démarche et sans revue, depuis une app Meta en mode développement. Ce qui
reste vrai de l'ancienne phrase est que le `.txt` continue d'exister, pour les
réseaux qu'on ne branche pas et pour le rattrapage à la main.

Hors périmètre :

- l'ordonnancement des publications, le multi-comptes et les statistiques de
  performance : voir le §4 de la spec de publication.
- le doublage, la traduction, les effets vidéo générés, les vignettes.
- le multi-utilisateur, la facturation, tout ce qui relève d'un SaaS.

## 4. Livraison : un squelette qui marche, puis de la qualité

La priorité est d'avoir la chaîne complète en état de marche, interface comprise,
avant d'améliorer quoi que ce soit. Une sortie moyenne mais entière apprend plus
qu'un étage parfait qu'on ne peut pas encore regarder.

### Itération 0, le squelette

Ce qui doit fonctionner de bout en bout :

- ingestion d'un fichier local et proxy ;
- transcription WhisperX, écrite dans le sidecar ;
- candidats : Gemini sur le transcript seul, le premier pourvoyeur et le plus
  simple ;
- interface : liste de candidats à garder ou écarter ; éditeur avec le transcript
  comme surface, bornes déplaçables, suppression de passages ;
- **ratio et position du crop choisis à la main**, par clip ;
- rendu : concaténation des segments, crop selon le réglage, sous-titres karaoké
  au format repris d'OpenShorts, logo ;
- export MP4 et textes ;
- API : créer un projet, lister les candidats, éditer un clip, exporter.

Deux choses qui ressemblent à du raffinement et qui sont dans l'itération 0 quand
même, chacune pour sa raison :

- **le sidecar du transcript**, qui évite de repayer la transcription à chaque
  essai. La mesure de la section 6 a ramené ce coût de 25 minutes à 2 : le sidecar
  reste, mais il tient maintenant sur les raisons de la section 5 et non plus sur
  la vitesse d'itération ;
- **le saut d'étape si l'artefact existe**, version simplifiée du graphe (une
  présence de fichier, pas encore une clé de validité). C'est lui qui porte la
  vitesse d'itération, puisqu'il épargne le proxy et l'analyse, pas les deux
  minutes du transcript.

**Le rendu, lui, ne se saute plus sur une présence de fichier** : depuis
l'issue #48, il se saute sur une **empreinte persistée** à côté des sorties
(`projects/<projet>/renders/<clip>.rendu.json`), et une empreinte absente vaut
*périmé*, jamais *inconnu* — c'est ce qui fait repasser par la porte les rendus
posés avant elle. Elle porte les quatre champs qui disent ce qui était **demandé**
(`segments`, `framing`, `captions`, `branding` — `framing` a remplacé `ratio` et
`cropX` séparés quand le cadrage automatique est entré en vigueur, spec §10) et
quatre qui disent ce qui
a été **obtenu** : le condensat de chaque marque réellement incrustée — les deux
fichiers portent des noms fixes, donc le nom seul ne distingue pas une mise à
jour —, un condensat du style des sous-titres qui inclut le contenu du dossier de
polices — sans `fonts/`, libass se rabat sur fontconfig et incruste dans une
autre police sans un mot —, un condensat de ce que les sous-titres ont
**réellement porté** (`captionsContent`, issue #87) — sans lui, une correction du
transcript qui ne touche aucun segment d'aucun clip laisse un MP4 déjà exporté
porter des mots que le transcript ne dit plus —, et une `version` de recette pour
le cas général du rendu produit dans des conditions qui ne sont plus celles
d'aujourd'hui. Le reste des étapes en est toujours à la présence de fichier ; la
clé de validité générale
reste l'itération 4.

Le choix manuel du crop n'est pas un pis-aller jetable : il reste ensuite comme
réglage de dernier recours, et l'automatique ne fera que le préremplir.

### Les itérations suivantes

| Itération | Contenu |
|---|---|
| 1 | Cadrage automatique : détection de personnes et de plans, ratio au seuil de 90 % d’images cadrées, crop fixe par plan, coupes posées sur les frontières |
| 2 | Qualité du repérage : les quatre autres pourvoyeurs, reclassement en vision |
| 3 | Sous-titres : nettoyage déterministe des hésitations, correction par modèle local, personnalisation du style |
| 4 | Automatisation : watcher sur le dossier de replays, webhook, graphe complet avec clés de validité |

L'ordre suit le rapport entre ce que chaque étage change à l'écran et ce qu'il
coûte à construire. Le cadrage arrive en premier parce que c'est là que se trouve
la moitié du bénéfice visuel mesuré à la section 2.

## 5. Architecture

### Deux horloges

| | Quand | Ordre de grandeur | Produit |
|---|---|---|---|
| Analyse | une fois par live | 25 à 32 min sur cette machine, somme du tableau de la section 6 hors locuteurs | des artefacts réutilisables |
| Montage | à volonté | instantané | des EDL |
| Export | par clip validé | 1 à 2 min | un MP4 |

L'analyse ne relit jamais un clip et le montage ne relance jamais l'analyse.
C'est ce qui rend le tri de 25 candidats supportable.

### Le pipeline se comporte comme un `make`

Aucune étape ne se rejoue parce qu'une étape située en aval a changé. Changer de
logo ne doit pas retranscrire deux heures d'audio.

Chaque étape déclare ses entrées, produit un artefact et stocke la **clé** qui
l'a produit : version de l'outil, paramètres, empreinte des entrées. On demande
une cible, le système recalcule ce qui manque ou ce qui est périmé en amont. Rien
d'autre.

```
source.mp4
  ├─► proxy                     <- params proxy
  ├─► audio.wav
  │     └─► transcript          <- modèle Whisper, glossaire
  │           └─► transcript corrigé  <- lexique, modèle Ollama, corrections humaines
  ├─► shots                     <- proxy
  ├─► people                    <- proxy, params détection
  └─► audio_analysis
        │
        └─► candidates          <- transcript corrigé, shots, people, audio, prompts, modèle
              └─► clips (EDL)   <- candidats et éditions humaines
                    └─► rendus  <- EDL, source, style (logo, sous-titres, habillage)
```

Le style n'entre que dans le rendu. Cette propriété du graphe est ce qui rend un
changement de logo bon marché.

**Empreinte de la source** : taille, date de modification et durée ffprobe. Pas
de hash. Digérer 12 Go à chaque lancement coûterait plus cher que l'étape qu'on
cherche à éviter.

Un drapeau `force` court-circuite la clé, pour le cas où les paramètres n'ont pas
changé mais où l'on veut malgré tout d'autres propositions.

### Où vivent les artefacts

Deux emplacements, et la règle qui les sépare : ce qui est **intrinsèque à la
vidéo** vit à côté d'elle, le reste vit dans le projet.

```
Replay/
  2026-03-08-caro-mdlm.mp4
  2026-03-08-caro-mdlm.avolo/       le sidecar
      transcript.json               mots, segments, locuteurs (format WhisperX)
      meta.json                     clés de validité, versions

projects/2026-03-08-caro-mdlm/
  source.json          chemin vers l'original, jamais copié
  proxy.mp4            960x540 à 30 fps, keyframe toutes les 1 s, environ 1,4 Go
  analysis.json  frontières de plans, boîtes de personnes et dimensions de la source
  audio.json           musique, silences, événements
  candidates.json      les propositions, par passe
  status.json          l'état d'exécution
  clips/               les EDL
  renders/             les MP4 produits
```

**Un seul fichier pour les plans et les personnes.** Cette liste a longtemps
porté `shots.json` et `people.json` ; l'analyse en écrit un seul,
`analysis.json`, et l'étape qui le produit s'appelle `analysis`. Les deux mesures
sortent de la même passe sur le même proxy, donc les séparer ferait deux
écritures à tenir d'accord pour un fichier qu'on relit toujours entier. Il porte
aussi les dimensions de la source, sans lesquelles le rendu ne sait pas à quoi
les fractions se rapportent. L'argument qui plaçait `shots.json` dans le projet
vaut inchangé : le seuil de détection se règle, et ce qui se règle vit là où on
le règle.

`status.json` est écrit par `écrireStatut` (`src/server/run.ts`) et porte l'état
d'exécution. Il est arrivé après cette liste, et tout le suivi d'avancement en
dépend.

Le transcript est une propriété du fichier vidéo, pas un paramètre de projet. Le
poser à côté de la source le fait survivre à la suppression du projet, le rend
réutilisable par d'autres outils et le fait suivre la vidéo si elle est déplacée.
Un dossier plutôt que des fichiers en vrac évite de noyer le dossier de replays.

Une version antérieure de cette section invoquait un précédent qui n'en est pas
un : `2026-01-04-drag.cli.json` se trouve bien à côté de son `.mp4` dans le
dossier des replays, mais c'est une copie. Le diariseur de `rythmo-impro` écrit
dans un `output_dir` distinct (`rythmo-impro/out/` en pratique), et la
redirection passe par `--output-dir`. Le sidecar tient sur ses propres raisons,
il n'a pas de précédent maison.

Le proxy reste dans le projet : 1,4 Go par émission n'ont rien à faire sur un
Drive partagé. `analysis.json` aussi, parce qu'il dépend du détecteur et du taux
d'échantillonnage — et il y reste alors même qu'un changement de plan est un fait
de la vidéo, pour la raison pratique déjà dite : le seuil de détection demande
des réglages, et ce qui se règle vit là où on le règle.

**Le proxy est en 960x540 plutôt qu'en 640x360.** Un sujet occupant 6 % de la
largeur ne fait que 38 px sur un proxy 640, ce qui est mince pour YOLO ; à 960 il
en fait 58. Le poids double, ce qui reste sans conséquence sur un disque local.

**Le proxy est en 30 fps quelle que soit la source**, et c'est bien « quelle que
soit » qu'il faut lire : le corpus existant est majoritairement en 60 fps mais
pas uniformément, `2025-06-15-cqlp.mp4` étant déjà en 30. Un filtre `fps=30`
couvre les deux cas, en décimant 2:1 dans le premier et sans rien faire dans le
second. Aucun chemin de code n'a donc à connaître la cadence de sa source.

Les tournages à venir passeront en 30 fps : le 60 double le coût de décodage à
chaque étape et la taille des fichiers, sans rien apporter à un vertical
compressé.

**Repli** : si le dossier source est en lecture seule, le sidecar va dans le
projet et l'interface le signale. Pas d'échec, seulement moins de réutilisation.

### Une nouvelle passe n'écrase jamais un travail humain

Relancer le repérage ne doit pas balayer les clips déjà montés. La règle :

- un clip dont le statut n'est plus `candidate` est **humain** et survit toujours ;
- les propositions non encore traitées sont remplacées ;
- chaque lot porte son numéro de passe, pour distinguer les nouvelles
  propositions des anciennes.

Le proxy porte tout le travail en aval : le montage se scrube dessus, la
détection de personnes tourne dessus, la prévisualisation le lit. L'original
n'est rouvert qu'à l'export. Sans lui, ni l'interface ni la détection ne tiennent
sur des fichiers de 12 Go.

### Le clip est une liste de segments

```json
{
  "id": "clip_07",
  "projectId": "2026-03-08-caro-mdlm",
  "segments": [
    { "start": 2841.20, "end": 2856.90 },
    { "start": 2874.10, "end": 2931.40 }
  ],
  "ratio": "auto",
  "captions": true,
  "branding": true,
  "title": "",
  "description": "",
  "status": "candidate"
}
```

Pas de `start` et `end` uniques : une liste. Toutes les opérations demandées
deviennent alors la même chose.

| Demande | Opération sur la liste |
|---|---|
| retirer une digression | couper un segment en deux |
| retirer les hésitations | beaucoup de petites coupures, calculées sur les timings |
| étendre ou rétrécir | déplacer une borne |
| durée du clip | la somme des segments |

La durée est un résultat, jamais une contrainte d'entrée. C'est ce qui répare le
cas qui a motivé la conception : une blague de 90 secondes dont OpenShorts avait
gardé 25 secondes de préambule et coupé la chute, parce que
`snap_clip_to_words` plafonne à 60 secondes. On délimite la vanne entière, puis
on retire le préambule et la digression interne. La chute reste.

`ratio` vaut `auto` par défaut, et accepte `9:16`, `4:5`, `1:1` ou `16:9` pour
forcer la main.

### Frontière Node et Python

Le worker Python ne fait que ce qui exige `torch` : transcription WhisperX,
détection de personnes, analyse audio. Il ne touche pas à ffmpeg.

Tout le reste (API, EDL, rendu ffmpeg, interface) est en TypeScript. ffmpeg est
un binaire que Node pilote aussi bien que Python, et aucune décision de montage
ne traverse alors une frontière de processus.

```
Interface ──┐
            ├──► API Node/TS ──► ffmpeg (proxy, export)
API externe ┘         │
                      └──► worker Python (WhisperX, YOLO, audio) ──► GPU
```

Stockage : SQLite pour les projets et les clips, fichiers sur disque pour le
reste.

### Pas de Docker

openshorts est entièrement conteneurisé. Ce projet ne l'est pas, et la décision
s'appuie sur trois constats.

**Julien a déjà abandonné Docker pour cette charge de travail.**
`rythmo-impro/diarizer` tourne dans un venv : `run-wsl.sh` l'active, et exporte
`LD_LIBRARY_PATH` vers le `nvidia/cudnn/lib` du venv, correctif classique de
CTranslate2 et WhisperX. Le `CLAUDE.md` de ce dépôt porte encore les deux
versions de l'histoire, « Python runs ONLY inside Docker » puis « Docker is no
longer used » ; c'est la seconde qui décrit le code.

**openshorts avait besoin de Docker parce qu'il s'installe chez des inconnus.**
Reproduire cv2, torch, mediapipe, ultralytics, ffmpeg et whisper est un problème
réel, et c'est celui que Docker résout. Ici : une machine, un utilisateur, un
environnement déjà monté.

**Conteneuriser réimporterait la fragilité des montages.** Le `CLAUDE.md`
d'openshorts documente longuement ce que coûte un bind absent :
`create_host_path: false` pour échouer bruyamment, un timer systemd et
`ON_MOUNT_CMD` pour remonter les disques apparus après le boot, et le constat que
`restart: unless-stopped` ne récupère pas d'une source manquante puisque Docker
échoue à la **création** du conteneur. Un process natif lit `/mnt/j/...` sans
rien de tout cela.

`nvidia-container-toolkit` est installé et Docker expose bien le runtime
`nvidia` : ce n'est pas une impossibilité technique, c'est un arbitrage.

**Ce que ça coûte** : pas d'installation reproductible. La parade est un
`setup.sh` et un `requirements.txt` épinglé, sur le modèle du `setup-wsl.sh`
existant.

**Ce que ça ne ferme pas** : la frontière de processus entre Node et le worker
Python existe déjà. Le jour où ce projet doit tourner sur un serveur, c'est ce
worker qu'on conteneurise, et rien d'autre ne bouge.

Dépôt neuf, pas un module de `rythmo-impro`, qui est un système de doublage live.
La parenté s'arrête au diariseur.

## 6. Le pipeline d'analyse

| Étape | Outil | Ordre de grandeur pour 2 h |
|---|---|---|
| Proxy 960x540 à 30 fps, keyframe 1 s | ffmpeg, CPU — NVENC est plus lent | 7 à 9 min selon la cadence de la source |
| Extraction audio | ffmpeg | 10 s |
| Transcript et alignement au mot | WhisperX large-v3 | 2 min |
| Locuteurs | pyannote, hors itération 0 | non mesuré |
| Correction du transcript | lexique, puis Ollama (après libération du GPU) | 3 à 8 min |
| Frontières de plans | détection sur le proxy | 2 min |
| Personnes et poses | YOLO `-pose`, 2 images par seconde | 2 à 3 min |
| Analyse audio | voir plus bas | 5 min |
| Repérage des candidats | Gemini | 1 min |

**Six lignes sur neuf sont mesurées, trois restent des estimations et les
locuteurs n'ont ni l'une ni l'autre.** Relevé le 18 août 2026 sur
`2025-06-15-cqlp.mp4`, une émission entière de 1 h 39 : proxy en 6 min, soit 16,4x
le temps réel et 7 min pour 2 h ; extraction audio en 6 s ; transcription et
alignement en 1 min 41 s, soit 59x le temps réel ; repérage Gemini en 30 s. Les trois estimations qui
subsistent (correction du transcript, analyse audio, locuteurs) n'ont encore rien
derrière elles.

**Les deux passes du détecteur sont mesurées depuis le 19 août 2026**, et elles
tiennent ensemble dans une même exécution : 139 s pour 1 h 54, 207 s pour 2 h 50,
113 s pour 1 h 39, frontières de plans comprises. La détection de pose ne coûte
rien de plus que la détection de boîtes — 145 im/s contre 147, trois passes chacun
sur le même proxy, un écart de 1,4 % que la variance de cette machine ne permet
pas d'établir. Ce qu'elle coûte est sur le disque : `analysis.json` grossit d'un
facteur cinq, dix-sept points par personne.

**La cadence de la source décide du proxy, d'où la fourchette.** Les 16,4x
viennent de `2025-06-15-cqlp`, seule source du corpus déjà en 30 fps. La section 11
en mesure 13,8x sur `2026-03-08-caro-mdlm`, qui est en 1080p60, soit près de 9 min
pour 2 h : une source en 60 fps donne deux fois plus d'images à décoder avant que
`fps=30` n'en jette la moitié, et ça se paie. Les deux cadences sont donc
chronométrées, une émission chacune.

**La transcription était l'estimation la plus fausse, et dans le bon sens** :
15 à 25 minutes annoncées contre 1 min 41 s mesurées, neuf à quinze fois moins
selon la borne qu'on retient. Le chiffre change ce qu'on peut se permettre, puisque retranscrire une
émission cesse d'être une décision qu'on pèse. La mesure ne couvre pas les
locuteurs, d'où leur ligne à part : `worker/transcribe.py` transcrit et aligne, il
n'instancie jamais le pipeline de diarisation, que l'itération 0 n'utilise pas
(§17).

La musique de fond gêne Whisper. La suppression de voix MDX23C du diariseur
existant corrige cela mais coûte cher, donc elle ne se déclenche que sur les
passages détectés comme musicaux.

**Et depuis le chantier des bascules de composition (19 août 2026), une étape
de plus dans ces mêmes 139 à 207 s.** Les frontières de plans se recalculent en
croisant les boîtes de personnes déjà détectées et les scores de scène déjà
collectés à l'étape 1 : aucune passe ffmpeg de plus, aucun passage GPU de plus.
Le surcoût mesuré est sous 5 s sur `2026-03-08-caro-mdlm`, l'émission la plus
longue du corpus. Voir §10 et `docs/ratios-par-clip.md`.

## 7. Le repérage des candidats

Aucun signal automatique n'identifiera de façon fiable les bons moments d'une
improvisation. Cette phrase disait « sans public », ce que la détection au corps du
18 août 2026 a démenti : sur `2025-06-15-cqlp`, 34 % des boîtes de personnes sont
des spectateurs au premier plan. Le choix de conception ne bouge pas pour autant,
parce qu'il ne reposait pas sur l'absence de public : aucune des sources ci-dessous
ne consomme de rires, et personne n'a mesuré si ceux-là s'entendent dans le mix.
La réponse n'est donc pas un meilleur juge mais
**plusieurs sources indépendantes fusionnées**. Une source aveugle sur un type de
moment est rattrapée par une autre. Julien trie ensuite, et l'objectif de
l'étage est le rappel, pas la précision.

1. **Gemini sur le transcript.** Fenêtres de 90 secondes chevauchées de 30, notées
   par lots avec un barème ancré, mécanique reprise d'OpenShorts. On garde le
   haut du panier, **à hauteur de ce que la matière porte** — voir « Combien on
   en garde » ci-dessous. Cette source ne voit pas le jeu physique, par
   construction.
2. **Le mouvement des corps.** Les boîtes de personnes sont déjà échantillonnées à
   2 images par seconde pour le cadrage ; la quantité de déplacement s'en déduit
   sans coût. Une bouffée d'agitation après une phase calme est la signature d'un
   gag physique.
3. **Les cartouches de jeu.** Un OCR sur le proxy segmente l'émission en séquences
   nommées. « Le meilleur moment du Bim Bam Boum » est une question mieux posée
   que « le meilleur moment de ces deux heures ».
4. **Le resserrement du cadre.** Quand le réalisateur resserre, il se passe quelque
   chose. La taille des personnes est déjà calculée, la variation ne coûte rien.
5. **La densité des tours de parole.** Un échange vif se distingue d'un monologue,
   et cela ne demande pas de savoir *qui* parle, seulement *que* ça change. C'est
   la partie robuste de la diarisation.

### Combien on en garde

**Le dimensionnement suit la matière, jamais un plafond plat.** La règle
précédente prenait une part des fenêtres bornée à 24, et une cible de clips
bornée à `[6, 12]` ; les deux saturaient si tôt qu'une capsule de dix minutes et
un live de deux heures recevaient la même consigne. Mesuré le 18 août 2026 :
`2026-22-02-entre-nous`, 1 h 53, a rendu six clips — le plancher exact, parce que
le modèle rend toujours le minimum qu'on lui donne.

L'unité est la **durée de parole** : l'union des segments qui portent de la
prose, jamais l'écart du premier mot au dernier. La distinction n'est pas
théorique — sur les deux émissions mesurées, l'écart surestime de 19 à 21 %, et le
plus grand silence isolé fait 4 min 46 sur l'une, 6 min 43 sur l'autre. C'est
aussi ce qui rend la mesure comparable au fenêtrage, qui se bâtit sur les mêmes
segments.

```
plancher de clips  = étendue de parole / minutesPerClip, borné par minimumClips
                     et par le nombre de créneaux de 90 s
plafond            = une moitié en plus, borné par maximumClips
présélection       = plancher × windowsPerClip, borné par minimumWindows et par
                     le nombre de fenêtres réelles
```

Les cinq constantes sont des **réglages globaux tenus en base** (table
`settings`), modifiables sans toucher au code — et depuis le 19 août 2026, sans
toucher à la base non plus : `GET` et `PUT /api/settings` les servent et les
écrivent. La validation vient d'un **registre de champs décrits**
(`src/server/db.ts`) — famille, type, plancher, plafond, défaut — et non d'un
schéma par famille : le repérage est la première, l'IA par usage, l'ingestion et
les défauts du hook suivent, et chacune aurait sinon réinventé ce que « hors
bornes » veut dire. Le plafond (`max`) et un quatrième type, `color`
(`#RRGGBB`, normalisé en majuscules), sont arrivés avec la famille `hook`
(PR #114) : les deux étaient absents jusque-là, les familles antérieures
n'en avaient pas besoin. Une liste de champs à couvrir par un écran ne doit
en revanche **pas** être un tableau : `durationMs` a vécu une PR entière
réglable en base, surchargeable par l'API et présent dans l'empreinte, sans
aucun contrôle dans l'écran Clip, parce qu'un `readonly K[]` ne casse pas au
type-check quand il en oublie un. Un `Record<K, true>` l'exige. Le préfixe `selection.` de la clé stockée a été posé
en prévoyant exactement cela. Une clé inconnue et une valeur hors bornes sont
des 400, jamais un enregistrement silencieux ; changer un réglage ne recalcule
rien.

**Jamais une clé d'API dans cette table.** Elle se relit en clair avec
`sqlite3`, et le dépôt est public : les secrets passent par `src/server/secrets.ts`,
qui les résout depuis 1Password. Une famille « intelligence artificielle »
stockera un modèle et une *référence* au secret, jamais sa valeur.

Défauts : un clip toutes les
**6 minutes** de parole, **2** fenêtres examinées par clip demandé, plancher de
**6** clips et de **10** fenêtres, aucun plafond absolu. Sur les deux émissions
mesurées, cela donne 15 clips sur 30 fenêtres et 13 sur 26, contre 6 sur 24 pour
les deux auparavant.

Le calcul reste **pur** : `src/core/` ne lit ni base ni environnement, les
réglages lui arrivent en argument depuis `runCandidates`.

### Ce que la fusion en fait

Les cinq produisent des ancres. On fusionne et on déduplique, ce qui laisse une
quarantaine de régions.

**Reclassement en vision.** Douze images à 1024 px coûtent environ 3000 tokens,
quelle que soit la durée de la source, et font mieux que le mode vidéo de Gemini
(qui facturerait 1,08 million de tokens pour deux heures, hors de portée). On
envoie douze images de chacune des quarante régions, soit environ 120 000 tokens,
pour un classement qui a vu le jeu. C'est le seul étage de la chaîne qui juge
autre chose que du texte. Les 25 à 30 premières sont présentées.

## 8. Délimiter et nettoyer

### Délimitation

Une ancre n'est pas un clip. Deuxième passe Gemini sur la région autour de
l'ancre, avec un marqueur `[SECONDS]` par phrase (technique reprise d'OpenShorts,
avec sa contrainte : les marqueurs sont **tronqués, jamais arrondis**, sinon le
modèle rend une borne qui tombe dans le premier mot de la phrase qu'il voulait
exclure).

Sans plafond de durée. Le raccourcissement vient après, et par le milieu.

### Nettoyage, deux niveaux de statut différent

**Déterministe, appliqué par défaut.** Les « euh », « bah », faux départs,
répétitions immédiates et silences au-delà d'un seuil. Cela se calcule sur les
timings mot à mot, sans modèle. Aucun sens ne se perd. Réversible d'un clic.

**Gemini, proposé et jamais appliqué.** Les digressions. Retirer « alors
généralement les blagues avec des pingouins, je sais ce que vous vous dites »
est un jugement éditorial, pas un nettoyage. L'interface le surligne, Julien
tranche.

La distinction est opérationnelle : le premier niveau tourne sans personne dans
la boucle, le second non.

### Placement des coupes

Chaque borne de coupe cherche d'abord une frontière de plan dans une fenêtre de
tolérance. À défaut, jump cut assumé.

## 9. Les sous-titres

### Le format

Repris d'OpenShorts, dont le rendu convient : karaoké mot à mot, Anton, blanc
sur surlignage `#FFE500`, contour noir, majuscules. Génération d'un fichier ASS
puis incrustation par ffmpeg.

Ces valeurs deviennent un preset modifiable, pas des constantes en dur.

**Correction du 23 août 2026.** Le preset d'OpenShorts (Anton 44, contour 4 px,
16 caractères et 1,4 seconde par carton) rendait des cartons de quatre mots qui
occupaient toute la largeur du cadre — mesuré à 247 px de hauteur de glyphe sur
un rendu 1080×1920. Julien a choisi, sur une planche de quatre candidats rendus
sur de vraies images, un preset plus petit et posé plus longtemps à l'écran :
Anton 22 (120 px sur 1080×1920), contour 2 px, 36 caractères et 2,5 secondes par
carton. Le contour descend avec la police parce que `ScaledBorderAndShadow` le
met à l'échelle du repère `PlayResY`, pas de la taille de police — resté à 4 il
aurait mangé la lettre à ce corps. Ce nouveau preset est le défaut
(`DEFAULT_CAPTION_STYLE` dans `src/core/captions/ass.ts`, `MAX_CHARS_DEFAULT` et
`MAX_DURATION_DEFAULT` dans `src/core/captions/cards.ts`), pas une borne : il
reste modifiable par preset.

**Point qui reste ouvert, pas dans le périmètre de cette correction.** Le même
fichier `.ass` est incrusté sur les deux canevas le jour où `RENDER_NATIVE`
(`src/core/render-flags.ts`) repasse à `true` : 18 unités de `PlayResY` donnent
120 px sur un 9:16 (1920 de haut) mais 84 px sur un natif 4:5 (1350 de haut).
C'est déjà vrai aujourd'hui, ce n'est pas une régression introduite par ce
preset.

### La correction, trois étages du moins risqué au plus risqué

**Étage 0, avant la transcription.** Whisper accepte un `initial_prompt` qui
biaise son vocabulaire. Y placer les noms de l'émission, des jeux et des invités
corrige les noms propres à la source, ce qui vaut mieux que n'importe quelle
correction ultérieure.

Ce n'est pas gratuit pour autant : le diariseur de `rythmo-impro` **n'expose pas
ce paramètre** (zéro occurrence dans son `main.py` et son `config.toml`). Le
brancher demande une quinzaine de lignes dans son chargement de modèle. Rien de
sérieux, mais à prévoir en itération 3 plutôt qu'à découvrir.

**Étage 1, un lexique déterministe.** Remplacements exacts pour ce que le
glossaire n'a pas attrapé. Aucun risque.

**Étage 2, un modèle local via Ollama**, sur ce qui reste : ponctuation et
homophones français (et/est, a/à, ces/ses/c'est) plus les accords. Seul étage qui
peut mal tourner.

### Le contrat qui rend la réécriture impossible

Le modèle ne renvoie pas de texte. Il renvoie des substitutions indexées :

```json
{ "corrections": [
  { "i": 12, "w": "Avolo" },
  { "i": 45, "w": "c'est" },
  { "i": 60, "merge": 2, "w": "c'est-à-dire" }
]}
```

`i` est l'index du mot dans l'empan soumis, `w` son remplacement, `merge: n`
fusionne n mots et le résultat prend leur empan temporel.

Insertion, suppression et réordonnancement ne sont pas exprimables dans ce
format. Le modèle ne *peut* pas réécrire. C'est une propriété de la sortie et non
une consigne dans un prompt, ce qui est la seule garantie qui tienne : une
consigne se contourne.

Deux gardes par-dessus :

- **Invariance phonétique.** Une substitution qui ne sonne pas comme l'original
  est rejetée. C'est la définition opérationnelle de « corriger sans changer ce
  qui a été dit ».
- **Horodatages préservés** mot par mot, sinon le karaoké se désynchronise.

### La correction humaine

Le transcript est déjà la surface d'édition de l'interface : corriger un mot est
la même interaction que supprimer une phrase.

Une correction remonte dans le sidecar. Corriger « Avolo » une fois le corrige
dans tous les clips de cette émission, définitivement. Un terme corrigé alimente
aussi le glossaire de l'étage 0, donc les émissions suivantes en profitent.

**Précision du 19 août 2026, la vue Émission (PR « le transcript de
l'émission ») : la correction manuelle prend la même forme que le contrat du
modèle ci-dessus, un empan de mots indexé plutôt que du texte libre, mais
bornée à une phrase — pas à tout le transcript — et sans les gardes que le
modèle exige, l'humain n'ayant pas besoin d'être contraint par le format.
`WordCorrection` (`src/lib/editing.ts`) en porte les règles : les timings hors
de l'empan ne bougent pas, ceux du remplacement se redistribuent sur l'empan
retiré au prorata de la longueur des mots.

**Deux conséquences restent partielles.** Le glossaire de l'étage 0 n'est pas
alimenté — cette PR pose la correction, pas la boucle de rétroaction vers
`initial_prompt`, qui reste à faire. Et le mécanisme d'empreinte de rendu
(`src/server/steps/render.ts`, §11 ci-dessous) ne compare pas encore le texte
pour décider qu'un rendu déjà exporté est périmé : une correction touchant un
clip déjà monté est signalée à l'écran — les clips concernés sont nommés dans
la réponse de la route —, mais rien ne force encore le réexport par le graphe
comme le fait déjà l'empreinte pour le montage, les marques ou le style des
sous-titres.

### Ce qui est constaté sur la machine

Ollama tourne sur l'hôte Windows, joignable depuis WSL sur le port 11434, avec
`gemma4:26b` (25,8 milliards de paramètres, quantisation Q4_K_M, 18 Go).

- **L'adresse de la passerelle WSL change au redémarrage.** À résoudre
  dynamiquement (`ip route show default`), jamais à coder en dur.
- **26 B est surdimensionné pour cette tâche.** Ponctuer et arbitrer des
  homophones sur des empans courts relève du gros volume et de la faible
  difficulté ; un modèle de 4 à 8 B ira nettement plus vite pour un résultat
  équivalent. Le modèle et l'adresse sont configurables.
- **Contrainte de VRAM, bloquante.** 18 Go de modèle et WhisperX large-v3 ne
  tiennent pas ensemble sur 24 Go. La correction s'exécute après que la
  transcription a rendu le GPU, jamais en parallèle.

## 10. Le cadrage

**Le ratio est choisi par plan** : pour chaque plan, le plus petit dont un crop
fixe cadre 90 % de ses images. Pas le maximum, sinon une seule image où quelqu'un
traverse le cadre condamne le plan entier ; sur les 10 % restants, un sujet peut
sortir partiellement du cadre.

**Et « cadrer » ne veut pas dire contenir les gens en entier.** C'est la mesure du
19 août 2026, et c'est ce qui a débloqué le choix du ratio. Une boîte de personne
abandonne, de chaque côté, `min(0,30 × sa largeur ; 0,12 de l'image)` avant
d'entrer dans l'empan. Le cas qui l'a ouverte : sur
`2025-06-15-cqlp_002107357-002143228`, deux comédiens occupent `[0,106 ; 0,490]`
et `[0,523 ; 0,778]`, leur union fait 0,672 quand un 1:1 en couvre 0,5625, et
**aucune** des 61 images du plan ne tient — aucun réglage de percentile ne pouvait
donc rendre autre chose qu'un 16:9. Vérifié à l'image, le 1:1 garde pourtant les
deux visages et les deux bustes, et ne perd que l'épaule extérieure de chacun.

Les deux bornes sont nécessaires, et la seconde a été payée par une image :

- *La part* borne la perte relative. Elle protège les sujets lointains — un
  rognage absolu effacerait une boîte de 0,10 de large — et elle rogne là où il y
  a de quoi rogner, une boîte étant large précisément quand un membre est tendu.
  Un débordement toléré uniforme, qui revient arithmétiquement à une marge
  négative, rabote autant les empans déjà étroits et les pousse vers des ratios
  trop serrés.
- *Le plafond* borne la perte absolue. Sans lui, sur `2026-03-08-caro-mdlm` à
  7 250 s, un comédien assis jambes tendues donne une boîte de 0,536 de large dont
  la tête occupe l'extrémité droite : 30 % de chaque côté font 0,161 de l'image et
  **son visage tombe dehors pendant les 28 secondes du plan**, sans que le
  compteur de pertes le signale — il n'a perdu que 27 % de sa boîte. C'est le cas
  des jambes tendues de l'issue #69, vu par l'autre bout. **Ce plafond ne sert plus
  que sur le chemin de repli** depuis que les points de pose nomment la tête au
  lieu de la deviner : voir plus bas.

Le compteur qui manquait à ce paragraphe existe depuis le 19 août au soir, et
c'est ce que les points de pose ont apporté de plus net : `scripts/mesure-ratios.ts`
compte les couples (personne, image) dont **aucun point de tête n'est dans le
rectangle de crop**. Un visage tombé dehors ne se cherche donc plus à l'œil sur une
image.

Ce que ça déplace, sur les trois émissions : la part des clips en 16:9 tombe de
84 à 42 % sur `cqlp`, de 100 à 83 % sur `caro-mdlm`, de 100 à 67 % sur
`entre-nous` ; celle des fenêtres de 30 s, de 80 à 50 %, de 100 à 93 % et de 95 à
68 %. Aucun clip ni aucune fenêtre ne s'élargit. Le prix se compte en secondes :
sur les 31 clips, dix épisodes d'une demi-seconde à une seconde et demie montrent
quelqu'un amputé de plus de la moitié, tous dans les 10 % d'images que le seuil
sacrifie déjà. Le détail, les seuils et les images sont dans
`docs/ratios-par-clip.md`.

**Et depuis le 19 août au soir, « cadrer » veut dire contenir les troncs**, pas
les boîtes rognées. Le détecteur tourne sur `yolo11m-pose.pt`, qui rend dix-sept
points COCO par personne ; le cadre doit contenir la tête et les épaules de
chacun, rognées de 30 % et rembourrées de 15 % de leur largeur, la tête servant de
plancher à ce rognage. C'est la réponse à l'issue #69, et c'est un changement de
primitive : une `PersonBox` est un rectangle dont la largeur est la même à toutes
les hauteurs, donc rien à l'intérieur ne distingue une tête d'une cheville, et le
rognage latéral ne pouvait que parier sur la position de la tête.

Ce que ça déplace, part du temps de montage en 16:9, à modèle égal :
`2025-06-15-cqlp` 42 → 37 % sur les fenêtres, `2026-22-02-entre-nous` 55 → 51 %
sur les fenêtres et 60 → 49 % sur les clips, `2026-03-08-caro-mdlm` inchangé. Ce
que ça déplace surtout, c'est le coût : ce que le cadre coupe d'un tronc tombe de
0,309 à 0,016 au p99 sur `cqlp` et de 0,192 à 0,000 sur `entre-nous`, et le nombre
de têtes posées à moins de 1 % du bord du cadre est divisé par cinq et par trois.

**Le plafond du rognage latéral n'a donc plus d'objet sur ce chemin-là.** Il
existait pour empêcher un rognage aveugle de jeter un visage — le cas de
`caro-mdlm` à 7 250 s, ci-dessous —, et la tête n'est plus devinée. `sideTrim` et
`sideTrimMax` restent comme **repli** : une analyse de version 1 n'a pas de points,
un `DETECT_MODEL` repassé sur `yolo11m.pt` non plus, et une personne de dos n'a pas
de tronc lisible. Sur une analyse de pose, 99 % des boîtes ont un tronc et le
balayage complet du rognage latéral ne déplace plus aucun ratio.

**La boîte corps entier reste écrite à côté du tronc**, et ce n'est pas de la
prudence : le filtre du public au premier plan lit sa géométrie — bord bas et
hauteur —, et un squelette ne dit pas si le bas de l'image a tronqué quelqu'un.

**Ce que ça ne fait pas.** Un plan dont le détecteur ne donne aucune boîte
exploitable reste mal cadré — sur le second plan du clip de référence, un gros plan
sur un comédien qui parle, ses boîtes vont de 0,42 à 0,65 de large et sautent de
±0,15 d'une image à l'autre pour un visage qui en occupe 0,30. Les points de pose
divisent cette gigue par deux, de 0,380 à 0,178 d'écart entre la plus étroite et la
plus large, et **le plan reste en 1:1 quand il devrait être en 9:16** : ce n'est
plus la largeur qui décide, c'est la position — aucune position fixe de 9:16 ne
sert dix de ses onze images. Le reste de l'issue #69 est là, et dans les faux
positifs sur du mobilier, que les points n'écartent pas non plus.

**Ce paragraphe demandait un ratio unique pour tout le clip, et la mesure l'a
démenti.** Sur trois émissions, la part des fenêtres de 30 s qui descend sous le
16:9 vaut 25 % sur `2025-06-15-cqlp`, 8 % sur `2026-22-02-entre-nous` et 1 % sur
`2026-03-08-caro-mdlm` — mais un ratio unique par clip écrase ces moments-là sous
le plan le plus large, et **la totalité des clips mesurés sortait en 16:9**. Le
filtre du premier plan et la marge de confort ont été mesurés l'un et l'autre :
ni l'un ni l'autre ne déplace ce résultat. Un ratio par plan est ce qui récupère
ces 8 à 25 %, et c'est le seul levier que le choix du ratio conserve.

Le saut de taille tombe **sur une coupe**, donc il ne se voit pas. C'est
exactement l'argument qui justifie déjà le crop qui saute aux frontières, appliqué
à la grandeur voisine.

**`ShotFraming` porte donc deux positions**, une par sortie. Une position
optimisée pour un 9:16 posée dans la fenêtre 1:1 du natif n'est pas fausse — elle
est bornée dans l'image — mais elle n'est plus celle qui cadre le plus d'images,
et rien ne le dirait. Les deux se calculent sur les mêmes empans, et une
dérogation humaine les écrit toutes les deux : elle porte sur *où regarder*, pas
sur une fenêtre.

Mesuré sur les 23 clips en base le 19 août 2026 : **huit portent au moins un plan
plus serré que leur plan le plus large**, c'est-à-dire huit clips dont le 9:16
gagne quelque chose qu'un ratio unique aurait écrasé. Le rognage latéral du même
jour n'a fait qu'agrandir cet écart, puisqu'il resserre par plan.

Ce paragraphe demandait le **percentile 90 des largeurs par image**, et c'est
faux : une largeur par image suppose un crop libre par image, alors que le crop
est fixe pour tout le plan. Un sujet étroit à gauche pendant la moitié d'un plan
puis à droite pendant l'autre tient dans un 9:16 image par image, alors qu'aucune
position fixe de 9:16 n'en cadre plus de la moitié. Le code a tranché en premier
(`chooseRatio`, relevé en review) ; le texte suit.

**Le public au premier plan ne compte pas.** Une boîte de personne **tronquée par
le bord bas** de l'image et dont il ne reste qu'une **tranche courte** est écartée
avant tout calcul d'empan : c'est quelqu'un entre la caméra et le plateau, pas un
comédien. Sur `2025-06-15-cqlp`, ce sont 33,8 % des boîtes, et sans ce filtre tous
les clips sortaient en 16:9.

Les deux conditions sont nécessaires et aucune ne suffit — le point s'est payé, et
les deux contre-exemples ont été trouvés en regardant les images :

- Le bord bas seul jette les comédiens. 76 % de leurs boîtes touchent le bas du
  cadre, puisqu'ils jouent debout ; couper là-dessus ne laisse survivre que 16 %
  des boîtes, et le ratio qui en résulte est calculé sur un tiers des images.
- La hauteur seule jette les plans lointains. Deux comédiens assis dans le noir
  donnent des boîtes courtes qui flottent au milieu du cadre — 3 075 sur
  `2026-03-08-caro-mdlm`.

Les seuils par défaut sont `y1 ≥ 0,97` et une hauteur inférieure à `0,35`. Le
second tombe dans un creux de la distribution : entre 0,32 et 0,40, il ne reste
que 29 boîtes sur 26 436. Ce sont des **réglages** (`FramingOptions`), pas des
constantes, parce que le phénomène appartient à une émission et pas au fonds :
1,8 % des boîtes sur `caro-mdlm` contre 33,8 % sur `cqlp`. Le filtre vit dans
`src/core/framing.ts`, jamais dans `worker/detect.py` : la sortie du détecteur
reste brute, et un filtre posé dedans se paierait en heures de GPU pour être
défait. Le détail de la mesure, images comprises, est dans `docs/premier-plan.md`.

Conséquence à connaître : quand le filtre vide un clip de toute mesure, le ratio
monte au plus large, comme n'importe quel clip qu'aucune détection ne renseigne.
Le cas s'est produit sur une fenêtre de `caro-mdlm` dont la seule détection était
un poisson rouge du générique de fin. C'est le comportement voulu — une faute
voyante plutôt qu'un cadrage serré sur rien.

**Le filtre ne suffit pas à sortir `cqlp` du 16:9, et ce n'est pas un défaut du
filtre.** Ses dix clips y restaient au 18 août, vérification à l'image comprise.
Ce qui se gagne se mesurait ailleurs — l'empan médian passe de 0,642 à 0,520, la
part des images qui tient dans un 1:1 de 34,5 % à 60,1 %, et 25 fenêtres de 30 s
sur 197 se resserrent sans qu'aucune ne s'élargisse.

Le 19 août les a fait sortir, et par l'autre bout : ce n'est pas *quelles* boîtes
comptent qui bloquait, c'est *ce qu'on exigeait d'elles*. Le paragraphe reste
parce que sa conclusion tient toujours pour le filtre — et parce que la lecture
qui en a été faite pendant une journée, « le ratio est large partout, tant pis »,
est exactement celle qu'il ne fallait pas en tirer.

**La marge est un réglage mesuré depuis le 18 août 2026, et elle vaut 0,01.**
Elle comptait 0,02 sans avoir jamais été éprouvée, et elle pèse **deux fois** —
une fois de chaque côté —, donc 0,04 sur les 0,5625 qu'un 1:1 couvre. À 0,01,
aucun clip ni aucune fenêtre ne s'élargit sur les trois émissions mesurées, deux
clips de `cqlp` passent au 1:1 et quinze fenêtres sur 197 se resserrent. Zéro
donne la même répartition par clip et supprime tout l'air ; 0,01 en laisse encore
19 px sur une sortie de 1 080, et le rectangle de crop dessiné à cette valeur
garde de l'air des deux côtés des comédiens. Le détail est dans
`docs/ratios-par-clip.md`.

**La position du crop est fixe à l'intérieur de chaque plan**, calculée pour
couvrir l'action de ce plan. Elle ne change qu'aux frontières de plans, où une
coupe existe déjà, donc où le saut est invisible.

**Et depuis le 19 août 2026, une frontière de plan peut aussi venir d'une
bascule de composition, pas seulement d'une coupe de scène — ce paragraphe
supposait les frontières justes, elles ne l'étaient pas toujours.** À
l'intérieur d'un plan que le score de scène de ffmpeg ne sépare pas — une
translation en bloc de la scène par le mélangeur OBS préserve l'histogramme —,
un second détecteur croise les boîtes de personnes, qui disent qu'une bascule
a lieu et la situent à ±1/fps près, avec les scores de scène déjà collectés et
jusque-là jetés, qui donnent l'image exacte dans cette fenêtre. **Le crop reste
fixe à l'intérieur d'un plan** : ce détecteur ajoute des frontières là où une
coupe réelle existait sans être vue, il n'introduit ni lissage ni suivi de
caméra. Mesuré sur `2026-22-02-entre-nous` : le temps de montage borné par la
position plutôt que par la largeur (le même phénomène que le plan à boîtes
instables décrit plus haut, où aucune position fixe ne sert plus de la moitié
des images) tombe de 41 % à 18 %. C'est le plafond mesuré de cette approche —
au-delà, `2025-06-15-cqlp` et `2026-05-31-nabla` régressent. Le temps de
montage en 16:9 des clips tombe de 49 % à 39 %, sans régression sur les trois
autres émissions du corpus — dont le temps de montage en 16:9 reste
essentiellement stable (31 → 30 %, 90 → 90 %, 65 → 65 %). En **compte de
clips**, `entre-nous` ne bouge d'ailleurs pas (4 sur 6 restent en 16:9 avant
comme après) : tout le gain vit dans le temps de montage, jamais dans le
compte de clips — voir `docs/ratios-par-clip.md`. **Une bascule dont
le second signal ne confirme pas le premier est rejetée, pas posée au milieu
de sa fenêtre** : exiger un seul signal aurait pris pour des bascules réelles
deux comédiens qui bougent de concert, vérifié à l'image sur `cqlp`
(t ≈ 1 111,9 et 1 182,4 s). Le détail, les seuils retenus et la méthode
d'étalonnage sont dans `worker/detect.py` (section « Les bascules de
composition ») et `docs/ratios-par-clip.md`.

Le mouvement de caméra perçu est nul. Dès qu'un plan dure et que les comédiens se
déplacent, toute caméra qui suit finit par tanguer : c'est la cause du défaut
reproché à OpenShorts, et elle est structurelle, pas dans un réglage
d'amortissement.

Le prix est assumé : un plan long où les comédiens traversent le plateau impose un
crop large, donc un ratio qui monte, parfois jusqu'au 16:9. Un cadre large et
stable vaut mieux qu'un cadre serré qui vacille. La détection de plans du 18 août
2026 rend ce prix plus rare que ne le supposait ce paragraphe, qui parlait de
plans continus de plusieurs minutes : la médiane est de 27 s sur
`2025-06-15-cqlp` et de 5,3 s sur `2026-03-08-caro-mdlm`, donc le crop se
recalcule souvent au lieu de tenir une scène entière.

**Zones d'habillage.** Sur les vingt émissions existantes, le crop évite le bloc
de gauche quand il le peut. Le logo en haut à droite est permanent et tombe dans
tout crop pris à droite : on l'accepte. La préférence tient tant qu'elle reste une
préférence ; la coder demande le relevé réclamé en section 2, puisque dix images
ne disent ni où ce bloc commence ni sur quelles séquences il est à l'écran.

**Le panneau de chat de `2025-06-15-cqlp` est un cas unique.** Constaté à l'image
le 18 août 2026, en regardant un rendu et non le filtergraph : le chat Twitch
occupe environ 20 % de la largeur, du haut jusqu'en bas. Ce n'est pas le logo,
qu'on accepte parce qu'il est petit et coincé ; c'est une bande entière, et un 1:1
centré l'attrape. Une première version de ce paragraphe en tirait une contrainte
permanente et demandait de traiter cette bande comme interdite.

Le prélèvement d'images sur trois autres émissions, le même jour, dément la
généralisation. `2025-11-09-realisateur`, `2026-03-08-caro-mdlm` et
`2026-02-01-faq` n'incrustent aucun chat : l'image est pleine et seul le petit
logo en haut à droite revient à chaque fois. Sur `2025-06-15-cqlp` elle-même, le
panneau va et vient, présent à 15 minutes et absent à 40, 60 et 90. Julien a
tranché : le chat ne sera pas réincrusté, cette émission restera la seule à le
porter.

**Le cadrage automatique de l'itération 1 n'a donc pas de zone interdite à
gérer.** Le bloc de gauche reste ce que le paragraphe précédent en dit, une
préférence. Et le calcul qui suivait ici, entre un cinquième et un tiers de la
largeur dépensé avant même de cadrer alors que 24 à 33 % du temps seulement tient
déjà dans un 9:16, ne vaut que pour cette émission et pour ses passages avec
chat. Qui cadrera `cqlp` verra ses ratios monter sans que l'algorithme ait un
défaut : c'est un cas de test, pas un gabarit.

**Sauf que la mesure a démenti la moitié de cette phrase le 18 août 2026 :
`cqlp` n'est pas le pire cas, c'est le meilleur des trois mesurés.** Le
18 août au soir, `2026-03-08-caro-mdlm` et `2026-22-02-entre-nous` — deux
émissions sans chat incrusté — sortent **six clips sur six en 16:9** chacune,
là où `cqlp` en sort deux sur huit en 1:1. Sur des fenêtres de 30 s qui couvrent
l'émission entière, la part qui descend sous le 16:9 est de **25 % sur `cqlp`,
8 % sur `entre-nous` et 1 % sur `caro-mdlm`**. Le chat n'est donc pas ce qui
élargit, et le corriger en amont ne rendrait pas les ratios qu'on croyait qu'il
prenait.

Vérifié à l'image, l'écartement est réel sur les deux émissions propres, et il
appartient au dispositif de tournage bien plus qu'à l'algorithme : trois
personnes assises d'un bord à l'autre, un gros plan incrusté sur le tiers gauche
avec ses propres sous-titres, une diffusion de vidéo en plein cadre avec deux
bulles de webcam au coin. Deux causes évitables s'y ajoutent, toutes deux hors
du sujet du filtre du premier plan : des **faux positifs** posés sur du mobilier
vide pendant que le seul comédien présent n'a aucune boîte, et des boîtes de
corps qui suivent des **jambes tendues** jusqu'à un bord que la tête n'atteint
pas. Le détail, les images et la reproduction sont dans
`docs/ratios-par-clip.md`.

Le remède le moins cher reste en amont, dans OBS : enregistrer un programme
propre, ou une seconde sortie d'archive, rend au cadrage ce qu'une incrustation
lui prend, sans une ligne de code. Il n'y a plus de bande permanente à récupérer,
donc plus de chantier ; la réponse est notée pour le jour où un habillage revient
dans le programme.

## 11. Le rendu

Depuis l'original, jamais depuis le proxy.

1. Découpage des segments de l'EDL **aux frontières de plans** : un segment qui
   traverse cinq plans devient cinq entrées, chacune avec son cadre. Deux entrées
   contiguës au même cadre sont refusionnées — sur les 23 clips en base, un clip
   de 19 plans tous cadrés pareil retombe ainsi à une seule entrée, et le maximum
   observé est de cinq.
2. Crop et mise à l'échelle, un réglage par plan, puis **composition sur le
   canevas** : un cadre qui ne le remplit pas tire son fond de son propre
   `split`, le floute et se pose dessus. La composition précède la
   concaténation, que `concat` exige de flux de même taille.
3. Sous-titres incrustés depuis le transcript aligné au mot, **recalés sur la
   timeline du clip**. Après les coupes internes, les timings d'origine ne valent
   plus rien : c'est le piège principal du rendu.
4. Le hook, s'il y en a un, incrusté **après** les sous-titres — un PNG
   rasterisé (fond plein, coins arrondis, texte capitales par défaut) composé
   en `overlay`, pas un second document ASS : `BorderStyle: 3` ne sait
   dessiner ni un coin arrondi ni une boîte unique sur plusieurs lignes. Sa
   géométrie est une fraction de la **largeur** du canevas, contrairement aux
   sous-titres, pour que le même hook rende le même bandeau sur le natif et
   sur la variante 9:16 quand les deux partagent leur largeur (1080) — sauf
   une exception : la marge basse, qui protège du chrome de TikTok et Reels,
   une contrainte physique en hauteur, reste une fraction de la **hauteur**
   du canevas quand le hook est positionné en bas. Rasterisé par canevas : le
   PNG et son placement dépendent de dimensions en pixels, donc
   potentiellement deux images distinctes par clip.

   **Le PNG est un composite depuis le 20 août 2026.** Quand le clip porte un
   badge — un libellé très court posé au-dessus de l'accroche, « DÉFI 10 » sur
   les vignettes de référence —, sa pastille est dessinée dans la **même**
   image, mordant légèrement sur le haut du carton. Un seul PNG et non deux,
   parce que tout le reste de la chaîne en dépend : une seconde entrée ffmpeg
   décalerait l'index des logos, il faudrait un second placement que rien ne
   garderait accordé au premier, et les deux fichiers par clip deviendraient
   quatre. Le carton est peint **avant** la pastille, sans quoi son fond opaque
   en effacerait la partie basse ; le calque de preview a le problème inverse,
   le DOM empilant dans l'autre sens, d'où le `z-index` qu'il pose. Le badge
   n'a que **deux** réglages propres, ses couleurs — tout le reste est hérité
   du hook, parce que les deux boîtes sont un seul objet visuel. Un badge sans
   accroche n'incruste rien : sa géométrie est définie par rapport au carton,
   et l'écran le dit plutôt que de se taire.

   **Aucun fondu d'entrée par défaut.** Instagram fabrique la vignette du fil
   avec la **première image** du fichier ; un fondu, si court soit-il, y pose
   un hook invisible — opacité nulle sur cette image, pas partielle — donc une
   accroche absente de la seule image qu'on voit avant de cliquer. Le réglage
   reste, son défaut est `none`. Le fondu de sortie, lui, ne se joue sur
   aucune vignette et reste à `fade`.
5. Logo et mention Twitch, dans une bande qui tient compte des zones réservées
   (chrome des plateformes en haut, sous-titres en bas) — après le hook, pour
   la même raison qui le place après les sous-titres : une marque posée
   dessous serait recouverte par le premier carton, ou le bandeau, qui monte
   assez haut.

Deux fichiers par clip quand le natif n'est pas déjà 9:16, et ils ne se déduisent
pas l'un de l'autre :

- **le natif**, à **un ratio unique pour tout le clip** — le plus large de ceux que
  ses plans demandent —, pour le feed Instagram et Facebook. Pas de variation à
  l'intérieur : une vidéo de feed à bandes latérales intermittentes serait le
  défaut que le fond flouté existe pour éviter ;
- **le 9:16**, pour TikTok et Shorts, où **chaque plan est posé au cadre le plus
  serré qui tienne** sur un canevas vertical constant, le fond flouté prenant ce
  qui reste. Un plan en 9:16 remplit le canevas, un 1:1 en occupe 56,3 % de la
  hauteur, un 16:9 31,6 %.

**Le natif ne se produit plus par défaut depuis le 23 août 2026**
(`src/core/render-flags.ts`, `RENDER_NATIVE`). Sur les trois émissions
mesurées, personne ne récupérait ce fichier : Instagram, TikTok et YouTube
Shorts publient tous la variante 9:16. Un clip déjà en 9:16 continue de
produire son natif — il n'a pas de variante séparée, c'est alors l'unique
livrable. Un simple booléen, gardé réversible : remettre le flag à `true`
restaure le comportement ci-dessus à l'identique, pour le jour où un feed
Instagram/Facebook natif redevient un besoin réel.

**Les deux sont deux rendus indépendants de la source** : `blurredVariantArgs`
refait tout le chemin — décoder, recadrer, mettre à l'échelle, composer — plutôt
que de partir du fichier natif. C'est ce qui permet au 9:16 de resserrer un plan
que le natif a dû élargir, sans que ce plan soit rétréci deux fois.

**Les sous-titres et les marques s'incrustent sur le canevas, après composition.**
Les incruster dans l'image avant sa mise à l'échelle les réduit avec elle : sur un
plan 16:9 posé dans un canevas 9:16, le texte tombe à 31,6 % de sa taille. Avec un
ratio qui varie par plan, il changerait de taille à chaque coupe. Le fond flouté,
lui, continue d'être tiré d'**avant** toute incrustation — c'est l'anomalie #22, et
le `split` du filtergraph la referme.

Corollaire d'implémentation : **les marques se planifient par canevas**, une fois
pour chaque sortie et non une fois pour les deux. `planifierMarques` raisonne en
fractions du canevas qu'on lui donne, donc un placement calculé sur le natif
poserait dans la variante une bande dimensionnée pour un autre format.

### Encodage : ce que NVENC apporte, et où

Mesuré le 18 août 2026 sur `2026-03-08-caro-mdlm.mp4`, par la session
d'implémentation.

| | CPU | NVENC |
|---|---|---|
| Proxy 960x540 à 30 fps | **13,8x** | 12,8x |
| Export 1080x1920 | 1,97x | **4,58x** en `p5`, 7,51x en `p4` |

Ces chiffres sont ceux du **binaire Linux**, celui que le projet appelle. Deux
mesures de la première passe ne valaient rien et sont remplacées ici : le proxy
donnait 14,2x contre 15,7x — l'ordre des deux s'inverse, la conclusion ne bouge
pas —, et l'export donnait 5,76x, relevé par erreur avec le ffmpeg **de
Windows**, qui ne traverse pas la passerelle CUDA de WSL. Le CPU, lui, retombe
sur sa valeur d'origine (1,97x contre 2,02x annoncés), donc la machine n'a pas
changé de rythme. Le `p4` n'a pas été évalué en qualité.

**Le proxy ne gagne rien à passer sur le GPU** : son goulot n'est pas l'encodeur.
Une émission de 2h50 coûte une douzaine de minutes en CPU, ce qui reste dans
l'ordre de grandeur de la section 6. **L'export gagne un facteur 2,3**, et c'est
lui qui tourne une fois par clip validé.

**Le ffmpeg d'Ubuntu sous WSL n'a ni `h264_nvenc` ni `-hwaccel cuda`** : ses
accélérations sont `vdpau`, `vaapi`, `qsv`, `drm` et `opencl`. Une version
antérieure de cette spec annonçait « NVDEC/NVENC » pour le proxy, ce que le
binaire ne peut pas faire. Il faut un build statique qui les embarque.

**Piège vérifié** : `-pix_fmt yuv420p` combiné à `-hwaccel_output_format cuda`
fait échouer l'encodage sans message exploitable (« Nothing was written into
output file »). Comme libass exige de toute façon des images en mémoire système
pour incruster les sous-titres, le chemin retenu est `-hwaccel cuda` **sans**
`-hwaccel_output_format cuda`.

### Découper sans redécoder

Un `-ss` par segment placé **avant** son `-i`, puis un filtre `concat`. Mesuré :
36 secondes produites en 10, bornes exactes, aucun décodage depuis le début du
fichier.

La limite est le nombre de décodeurs ouverts, un par segment, ce qui tient
jusqu'à une dizaine. Le nettoyage des hésitations de l'itération 3 produira des
dizaines de coupures et imposera alors un rendu segment par segment suivi d'un
`concat` en copie de flux, comme le fait `reframe_v2.py:637` dans openshorts.

## 12. L'API

```
GET    /api/sources                            les replays disponibles
GET    /api/sources/thumb?file=<nom>           la vignette d'un replay
POST   /api/projects              { source } -> 202 + projectId
GET    /api/projects/:id                       état, progression, clés par étape
GET    /api/projects/:id/candidates            les propositions
GET    /api/clips/:id                          l'EDL
PATCH  /api/clips/:id                          édition de l'EDL
POST   /api/clips/:id/export                   rendu
POST   /api/clips/:id/hook                     régénère le hook et son badge (LLM)
GET    /api/settings                           les réglages effectifs
PUT    /api/settings                           applique un patch partiel
```

`POST /api/clips/:id/hook` (19 août 2026) refuse un clip qui n'est pas **gardé**
(`isGuard`, `src/core/phase.ts`) : la génération n'a de sens qu'à la demande, sur
un clip qu'on monte, jamais sur un candidat ou un clip écarté qu'on n'a pas
encore décidé de garder. Écrit sur le clip **relu juste avant l'écriture**, pas
sur l'instantané pris avant l'appel — l'appel réseau tient jusqu'à 30 s, assez
pour qu'une écriture concurrente (autosave, un autre onglet) se glisse dedans.
Elle régénère **la paire**, accroche et badge, y compris quand le badge revient
vide : une accroche neuve sous une pastille écrite pour l'ancienne lui
accolerait un sur-titre qui ne la décrit plus.

**Le cas courant ne passe par aucune route** (20 août 2026). La passe de détail
du repérage rend `viral_hook_text` et `viral_hook_badge` dans la **même
réponse** que le titre et la description : un clip naît donc avec son hook,
sans un appel LLM de plus — c'est ainsi que « ne pas générer des hooks pour
tous les candidats » est tenu. Le badge y est **facultatif** là où l'accroche
est requise : toutes les émissions ne portent pas de rubrique numérotée, et
l'exiger pousserait le modèle à en inventer une par clip.

Reste le trou : un modèle qui a omis le champ, ou un clip antérieur à la
fonctionnalité. Un **rattrapage** part alors à la transition
`candidate → kept` de `PATCH /api/clips/:id`
(`src/server/steps/hook-backfill.ts`), et seulement quand l'accroche est vide.
En tâche de fond, jamais bloquant, hors du chemin synchrone lecture→écriture
que cette route protège. Il relit le clip avant d'écrire et **n'écrase jamais
un hook non vide**. Son échec est un avertissement, jamais une erreur rendue au
client : garder un clip est un geste au clavier dans le feed, il ne peut pas
dépendre d'un fournisseur LLM joignable. Ce n'est ni une étape du graphe ni un
`launch` — la réservation de `launch` est par projet, donc un rattrapage
entrerait en collision avec une analyse et s'afficherait comme « une analyse
tourne » sur la carte du projet.

L'interface n'en est pas notifiée : le hook apparaît au prochain chargement de
l'écran Clip, ce qui suffit dans le parcours réel (on garde une série de clips,
puis on les ouvre un par un). Le bouton « Régénérer » reste le recours
explicite.

Et les routes qui portent la reprise :

```
POST   /api/projects/:id/run      { target, force? }   recalcule jusqu'à la cible
POST   /api/projects/:id/stop                          arrête l'analyse en cours
POST   /api/projects/:id/rerender { style? }           re-rend les clips exportés
```

`stop` est **idempotente**, et ses deux réponses sont des succès :
`{ stopped: false }` dit que rien ne tournait — l'analyse venait de finir, ou un
redémarrage du serveur a emporté l'exécution. L'arrêt est propagé aux processus,
pas simulé : `SIGTERM` puis `SIGKILL` sur ffmpeg et sur les deux workers Python,
fermeture des flux pour la copie d'ingestion, `abortSignal` pour l'appel Gemini.
Ce qui le rend sûr est la règle du nom temporaire ci-dessus : une étape tuée ne
laisse rien que le relevé de présence prendrait pour un artefact fait, donc la
reprise repart à la première étape manquante sans qu'il y ait de reprise à
écrire. Le rendu, lui, n'est pas annulable — il tient dans une requête.

`target` nomme une étape du graphe (`transcript`, `people`, `candidates`,
`renders`). Le système remonte les dépendances, recalcule ce qui manque ou ce qui
est périmé, et s'arrête là. Demander `candidates` sur un projet dont le
transcript existe déjà ne relance que le repérage.

`rerender` couvre le cas du logo ou de l'habillage modifié : les EDL ne bougent
pas, seuls les MP4 sont refaits.

Webhook optionnel en fin d'analyse.

Pour le déclenchement après chaque live, un watcher sur le dossier de replays est
plus robuste qu'un appel manuel. Deux pièges, tous deux déjà payés dans
OpenShorts :

- **Le fichier s'écrit pendant le live.** Attendre que sa taille reste stable
  plusieurs minutes avant de lancer l'analyse.
- **Le Drive partagé est lent.** `REPLAY_DIR` est monté en 9p et l'analyse relit
  la source une dizaine de fois. Copier en local d'abord, en **gardant le nom de
  fichier d'origine** : le titre du projet en dérive, et un nom haché renommerait
  toute la bibliothèque en charabia.

`stage/` est un **cache**, jamais une source de vérité : il peut être supprimé
sans conséquence fonctionnelle, au prix d'une recopie — 45 secondes pour 4,3 Go.
Une copie y vit **huit heures**, et le nettoyage passe au démarrage du serveur et
après chaque exécution. Deux traitements qui demandent la même source ne la
copient pas deux fois : la seconde demande attend la première au lieu d'ouvrir un
second flux sur un montage à 97 Mo/s.

**La copie est un réglage depuis le 20 août 2026**, `ingestion.copySourceLocally`,
coché par défaut. Le « copier en local d'abord » ci-dessus décrit le Drive, et
c'est ce qui le justifie ; il ne décrit pas une source déjà posée sur un disque
rapide, où la recopie ne fait que dupliquer plusieurs gigaoctets par émission.
Décoché, toute la chaîne lit l'original — le proxy, l'audio, le relevé des
dimensions et l'export d'un clip. Trois choses ne changent pas : une copie déjà
présente sert toujours (le réglage gouverne ce qu'on *fabrique*), décocher
n'efface rien, et `workingInput` (`src/server/steps/ingest.ts`) tranche seul la
question « ce fichier décrit-il encore la source ? ». L'export ne l'appelle pas
directement : `ensureLocalCopy`, dans le même fichier, s'en remet à lui puis
reconstitue la copie manquante sous délai de garde plutôt que d'exiger une
ingestion préalable.

### Lister les sources

`GET /api/sources` alimente le sélecteur. La forme est reprise d'OpenShorts, où
chaque champ a été payé une fois :

```json
{
  "files":     [{ "name": "2026-03-08-caro-mdlm.mp4", "size_mb": 12174, "mtime": 1772... }],
  "truncated": false,
  "sources":   [{ "name": "Replay", "fstype": "9p", "entries": 21 }]
}
```

- **Un parcours plat, les enfants directs de `REPLAY_DIR` et rien d'autre**, et
  **aucun lien symbolique**. Ce n'est pas une simplification : c'est le contrat que
  `resolveSource` applique déjà (`path.dirname(résolu) === replayDir()`) et que
  l'ingestion double d'un `lstat`. Un sélecteur qui descendrait dans les
  sous-dossiers proposerait des cartes que le `POST` refuse par 400. Et la raison
  du contrat vaut pour le sélecteur aussi : `projectIdFromSource` ne garde que le
  nom du fichier, donc `2025/show.mp4` et `2026/show.mp4` se partageraient un seul
  projet, silencieusement.
- **Des noms de fichier, jamais des chemins absolus.** Le résolveur les rejoint de
  toute façon sur la racine ; exposer l'arborescence du serveur n'apporterait rien
  à l'appelant.
- **Les entrées cachées et celles commençant par `$` sont ignorées.** Un dossier
  adossé à un Drive porte des fichiers de téléchargement partiel, qui
  apparaîtraient comme des vidéos cassées.
- **`truncated` est remonté, pas absorbé.** Un sélecteur qui s'arrête silencieusement
  à N donne à croire que les fichiers manquants n'existent pas.
- **`sources[]` porte `fstype` et `entries`.** Un montage cassé est indiscernable
  d'un dossier vide dans une liste à plat, et ce n'est pas théorique : sur
  OpenShorts, un Drive non monté au démarrage du conteneur a fait disparaître une
  source du sélecteur pendant des jours, avec l'apparence exacte de « il n'y a rien
  dedans ». `entries` compte **toutes** les entrées du répertoire, pas seulement les
  vidéos, parce qu'une source littéralement vide est presque toujours un montage qui
  n'a pas eu lieu.

Tri par date de modification décroissante : le dernier live est en haut.

`GET /api/sources/thumb?file=<nom>` rend la vignette d'une source, en `image/jpeg`,
et `404` si le fichier n'existe pas.

**Ce `file` vient du client, et c'est un changement de frontière de confiance.** La
vignette d'un candidat part d'un `projectId` que le serveur contrôle ; celle-ci part
d'un nom que l'appelant écrit. Sans confinement, `?file=../../etc/passwd` ferait
ouvrir un fichier arbitraire par ffmpeg. La route passe donc par le **même
`resolveSource`** que `POST /api/projects`, qui rejette l'octet nul, résout et exige
que le parent soit exactement `REPLAY_DIR`, puis par le même `lstat` que
l'ingestion pour refuser les liens. Aucune validation maison : réutiliser le
résolveur est ce qui garantit que le sélecteur, la vignette et l'ingestion ne
peuvent pas diverger.

## 13. L'interface

**Écran de bibliothèque.** Une carte par replay, portant l'état de son analyse.
Un projet n'est que l'état de traitement d'un replay : deux listes séparées
faisaient apparaître une émission analysée deux fois, sans rien qui dise que
c'était la même.

**Écran d'émission.** Le tri des candidats, et au-dessus le replay lui-même : le
proxy en lecture, et une bande de couverture qui montre où sont, dans l'heure
quarante, les clips qu'on en a tirés. Voir l'arbitrage sur la timeline, plus bas.

**Écran de tri.** La liste des candidats : vignette, durée, titre proposé, trois
premières phrases. Garder ou écarter d'un clic. Trier 25 candidats occupe plus de
temps que monter les trois qui survivent, donc cet écran se soigne en premier.

**Écran de clip.** Le transcript est la surface d'édition principale, pas la
timeline.

- Les hésitations apparaissent barrées, déjà appliquées, un clic les rend.
- Les digressions apparaissent surlignées, en proposition.
- Sélectionner une phrase et la supprimer retire le segment vidéo correspondant.
- Les bornes de début et de fin se déplacent au mot.
- Le proxy se lit à côté, en sautant les parties retirées.
- Une bande secondaire montre les plans, le ratio retenu et **les bornes du
  clip**. Elle a été écrite en lecture seule ; le 19 août 2026 elle a gagné deux
  oreilles qu'on tire, et c'est une exception assumée à la ligne suivante — voir
  « la bande des plans est en lecture seule », plus bas, où la raison est écrite.

**Le hook, en zone Contenu, à côté du titre et de la description (19 août
2026, revu le 20 août 2026).** Le texte, l'activation et « Régénérer » restent
visibles en permanence — **le texte du badge aussi, depuis le 20 août 2026** :
c'est du contenu, pas un réglage, et il vit à côté de l'accroche. Les quatorze
réglages de style (police, taille, rayon des coins, capitales, position,
alignement, couleurs du carton, opacité, couleurs du badge, durée, transitions)
sont repliés derrière un bouton « Personnaliser », fermé par défaut et affichant
leur nombre — republier à plat tout le panneau Réglages sur l'écran qui sert à
monter un clip s'est avéré une gêne plutôt qu'un service. Chaque contrôle dit
s'il est **hérité** des réglages globaux ou **surchargé** par le clip — même à
valeur égale — et se rend individuellement à l'héritage. Un calque de
prévisualisation, frère du `<canvas>` de l'aperçu 9:16 et jamais peint dedans,
montre le rendu approché en `cqw`/`cqh` dérivés des fractions de largeur de
`hookLayout()` — les mêmes que le rasteriseur PNG du rendu multiplie par la
largeur réelle du canevas. L'approximation ne porte plus sur l'interlignage de
libass, qui n'intervient plus dans le rendu du hook : elle porte sur la
largeur exacte de la boîte — celle du **composite** depuis le badge, donc sur
deux mesures plutôt qu'une —, le rasteriseur mesurant le texte avec les vraies
métriques d'Anton quand le calque laisse le navigateur composer la sienne
autour d'un `<span>`. La **hauteur** de la pastille, elle, est exacte des deux
côtés : elle se calcule au lieu de se mesurer, la pastille tenant sur une seule
ligne par construction. Le bouton
« Régénérer » appelle `POST /api/clips/:id/hook` (§12), réservé aux clips
**gardés** : un essai, sans la politique de relance du repérage — quelqu'un
attend devant un bouton, pas un lot de trente appels derrière quarante minutes
de pipeline.

La durée s'affiche et bouge en direct, comme information et non comme contrainte.

### La pile front

| Choix | Pour quoi |
|---|---|
| Next.js | même socle que `obs-tools` et `obs-suite`, et un serveur est de toute façon nécessaire pour l'API, ffmpeg et le proxy servi en requêtes partielles |
| shadcn/ui sur Base UI | les composants deviennent du code du projet, modifiables sans lutter contre une API ; rendu d'application de bureau plutôt que de site web |
| TanStack Query | l'analyse dure une demi-heure : suivi d'avancement, invalidation, reprise d'étape |
| TanStack Virtual | le **transcript**, environ 20 000 mots pour deux heures, affiché sélectionnable |
| Zustand | état local de l'éditeur ; l'EDL étant une structure simple, l'annulation est une pile d'instantanés |

**Écartés tant qu'il n'y a pas de raison** : `dnd-kit` (rien à glisser, les
segments naissent d'une sélection dans le texte), TanStack Table (25 cartes, pas
un tableau de données), `react-resizable-panels` (un seul séparateur au départ)
et toute la famille timeline multi-pistes, waveforms et playhead. Ce dernier
point mérite d'être dit explicitement, parce que c'est le réflexe naturel quand
on décrit « une interface de montage » : **la surface d'édition ici est le
transcript**. Construire un NLE reviendrait à bâtir le morceau le plus difficile
du métier pour un produit qui ne s'en sert pas.

**Une exception, tranchée le 19 août 2026, et bornée exprès.** La bande des plans
était en lecture seule ; elle porte désormais **deux oreilles**, l'entrée et la
sortie, libres à l'image près. Ce qui la sépare encore d'un NLE, et qui est la
frontière à tenir : elle n'a **ni pistes, ni forme d'onde, ni montage des mots**,
et elle ne sait faire que trois choses — promener la lecture, déplacer les deux
bornes extérieures, montrer où le cadre change de plan. Les coupes internes
continuent de se faire dans le texte.

La raison de l'exception est que le transcript ne sait pas exprimer le geste :
gagner la demi-seconde de silence avant une réplique, se caler sur une réaction
muette, rattraper une borne posée au mot alors que le souffle d'avant en faisait
partie. `moveBoundary` prend déjà un temps ; c'est `moveBoundaryToWord`, un étage
au-dessus, qui aimante au mot. Les deux chemins coexistent parce qu'ils répondent
à deux intentions, et la contrepartie est assumée : **une borne libre peut tomber
au milieu d'un mot** (ce que le générateur de sous-titres traite en rognant le
mot à la borne, `retimeWords`).

**Et un second `<video>` décode, en plus du lecteur.** La règle « un seul
`<video>` décode » vaut pour l'aperçu de sortie, qui se peint par `drawImage` sur
les trames du lecteur. Elle ne peut pas valoir pour la vignette de scrub : faire
chercher le lecteur principal pendant qu'on tire une oreille tuerait la lecture
et ferait sauter cet aperçu-là, qui s'accroche à ses trames. Le second élément est
donc **caché, muet, en `preload="metadata"`**, et il ne cherche qu'**une position
à la fois** — la dernière demandée, relancée au `seeked` précédent. Mesuré sur
`2025-06-15-cqlp` (proxy de 900 Mo) : un glissé d'un bout à l'autre de la bande
coûte **0 à 5 requêtes partielles**, et la vignette suit chaque position
échantillonnée.

**Deux bandes horizontales existent dans le produit, et il faut les distinguer ici
sous peine de faire lire une contradiction.** L'exception ci-dessus ne parle que de
la première :

- **la bande des plans**, sur l'écran de clip, qui a gagné ses deux oreilles le
  19 août — c'est l'exception, avec ses trois gestes et ses trois interdits ;
- **la bande de couverture**, sur la vue Émission, qui n'a rien gagné du tout :
  un bloc par clip gardé sur toute la durée du replay, les chevauchements
  répartis en voies, survol pour le résumé, clic pour ouvrir le clip. Rien ne s'y
  déplace, rien ne s'y coupe, rien ne s'y étire, et ce qu'on y clique **navigue au
  lieu d'éditer**.

Elles ne décrivent d'ailleurs pas le même objet : l'une montre un clip vu de
l'intérieur — ses plans, ses bornes —, l'autre montre une émission vue de
l'extérieur, et ce qu'on en a tiré. Une phrase écrite pour l'une ne vaut pas pour
l'autre, et c'est précisément ce que cette liste existe pour empêcher.

Ce que le refus vise est le **coût** — un NLE est le morceau le plus difficile du
métier — et la **place** : une timeline éditable prendrait le rôle que le
transcript tient. La bande de couverture ne paie ni l'un ni l'autre, et elle rend
visible une propriété de l'émission que trois écrans ne savaient pas dire : ce qui
en a été extrait, et ce qui reste inexploité. Le placement en voies vit dans
`src/core/coverage.ts`, pur, ce qui est la mesure de ce qu'il coûte : une fonction
et son test, pas un banc de montage.

La version de shadcn qui repose sur Base UI plutôt que Radix est à vérifier à
l'installation.


### Le choix d'une source, et ses vignettes

Créer un projet commence par choisir un fichier dans `REPLAY_DIR`. Une liste de noms
ne suffit pas : `2026-03-08-caro-mdlm.mp4` ne dit ni le plateau, ni le nombre
d'invités, ni si l'habillage est incrusté. Les cartes portent donc une vignette.

**Et c'est là que ça coûte.** La vignette d'un candidat se tire du proxy, qui est
local, en 960x540, avec une image-clé par seconde. Une vignette de source n'a pas ce
luxe : au moment de choisir, aucun proxy n'existe encore. Il faut donc aller chercher
l'image dans l'original, sur un Drive monté en 9p, pour des fichiers de 4,5 à
12,7 Go. Vingt et une cartes, ce sont vingt et une ouvertures distantes.

Trois règles rendent la chose tenable :

- **`-ss` avant `-i`**, qui fait chercher dans le conteneur au lieu de décoder depuis
  le début. C'est la mesure qui vaut déjà pour la découpe.
- **Cache sur disque local, clé = nom + taille + date de modification.** Une
  vignette n'est calculée qu'une fois par fichier, jamais à chaque visite de l'écran,
  et un fichier remplacé invalide la sienne.
  Cette clé n'est **pas** l'empreinte de source du graphe (§5), qui ajoute la durée
  ffprobe : l'y mettre imposerait un `ffprobe` distant avant même de savoir s'il faut
  calculer la vignette, ce qui annulerait tout le bénéfice. Taille et date suffisent
  à détecter un remplacement de fichier.
- **À la demande, au défilement.** On ne pré-calcule pas les vingt et une au
  chargement : on demande celle d'une carte quand elle entre dans le champ.

**La durée arrive avec la vignette, pas avec la liste.** L'instant de capture étant
une fraction de la durée, il faut la connaître, donc un `ffprobe` sur l'original.
C'est le même aller distant que la vignette : on le fait une fois, au moment de
calculer celle-ci, et on écrit la durée dans le cache à côté d'elle. La carte affiche
le nom, la taille et la date dès la liste, puis la durée quand sa vignette arrive.

`GET /api/sources` ne porte donc **aucun champ de durée** : l'y mettre exigerait
vingt et un `ffprobe` distants au chargement de la grille, exactement ce que le
chargement au défilement cherche à éviter.

**Ne jamais prendre l'image à zéro seconde.** Les lives ouvrent sur un carton
« ON ARRIVE VITE » avec compte à rebours, présent sur les trois émissions mesurées :
on obtiendrait une grille de vignettes toutes identiques et toutes inutiles. Prendre
l'image à une fraction de la durée place au cœur de l'émission.

## 14. Vérification

Le CI d'OpenShorts n'a jamais tourné une seule fois, et tout ce qui vit dans son
`main.py` est intestable parce que le module importe `torch` au chargement. D'où
l'existence de `clip_selection.py`, sorti pour cette seule raison. Le principe
s'applique ici dès le départ, et il est plus facile à tenir en TypeScript.

**Testable sans vidéo, sans GPU et sans ffmpeg**, là où se trouvent les bugs qui
coûtent cher :

- les opérations sur l'EDL (couper un segment, retirer des mots, recalculer la
  durée) ;
- le recalage des sous-titres après coupes internes ;
- le choix du ratio à partir de boîtes de personnes ;
- le placement d'une coupe sur la frontière de plan la plus proche ;
- **l'invalidation du graphe** : demander une cible calcule exactement les étapes
  manquantes ou périmées, et aucune autre. Un changement de style ne doit
  invalider que les rendus, et le test doit le prouver plutôt que le supposer ;
- **la survie du travail humain** à une nouvelle passe de repérage ;
- **le contrat de correction** : une réponse du modèle qui insère, supprime ou
  réordonne des mots est rejetée ; une substitution qui ne sonne pas comme
  l'original est rejetée ; les horodatages survivent à une fusion. Ce sont les
  tests qui empêchent une correction de devenir une réécriture, et ils
  s'écrivent sur des réponses de modèle enregistrées, sans appeler Ollama ;
- **la découpe en cartons** : 16 caractères et 1,4 seconde au maximum, sur des
  mots dont les durées sont fournies.

**Sur golden files** : un extrait de référence de deux minutes avec son projet
d'analyse figé, pour la sélection et le cadrage.

**Non testé et assumé** : la qualité du choix de Gemini, non déterministe et
subjective. Elle se juge à l'œil sur des sorties.

Le CI doit tourner, contrairement à celui d'OpenShorts. Les tests purs n'ont
besoin ni de GPU ni de ffmpeg, donc rien ne les en empêche.

## 15. Ce qui est repris d'OpenShorts

Portés en TypeScript, ce qui met toute la logique de décision du même côté et
réduit le worker à « modèle vers JSON » :

- le fenêtrage du transcript et le dimensionnement de la shortlist ;
- les marqueurs `[SECONDS]` et leur troncature ;
- le calage des bornes sur les mots.

Repris tels quels : les deux prompts (notation et détail).

Repris comme raisonnement et non comme code : la doctrine de placement de
`branding.py`, en particulier le fait que la position donnée est le bord
supérieur de la bande et non son centre, parce que la hauteur dépend du rapport
d'aspect du logo, que l'opérateur choisit.

## 16. Risques

**Le repérage des candidats peut décevoir.** C'est le pari central et rien n'a été
mesuré. Les cinq sources et le tri humain amortissent le risque sans l'annuler.
À valider tôt sur une émission réelle, avant d'investir dans l'interface.

**L'OCR des cartouches dépend de la stabilité de l'habillage.** Si la position ou
la police ont changé au fil des vingt émissions, la source 3 devient irrégulière.

**La lecture d'une EDL dans le navigateur** produit un à-coup à chaque saut. C'est
acceptable pour juger, pas pour valider un rendu final.

**La détection de personnes sur des plans très larges** reste à vérifier : YOLO
tient mieux les profils que MediaPipe, mais des sujets à 6 % de la largeur
d'image font 58 px de large sur le proxy 960x540 retenu, ce qui reste à
confirmer sur du plan très large.

## 17. Questions laissées ouvertes

- Le diariseur appelé comme service ou copié depuis `rythmo-impro`. Se tranche
  mieux au moment d'écrire le code, et l'itération 0 n'en dépend pas : elle
  n'utilise que la transcription, pas les locuteurs.
- **Les rires s'entendent-ils dans le mix ?** Question ouverte depuis que le public
  a été trouvé au premier plan de `2025-06-15-cqlp`, le 18 août 2026. Écouter
  quelques minutes suffirait à trancher. Une réponse positive ouvrirait une source
  de repérage que la section 7 s'était interdite d'envisager.
