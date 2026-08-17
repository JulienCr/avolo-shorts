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

### Contraintes de production

- Pas d'audio multipiste. Le mix se fait en amont sur une table qui n'exporte pas
  en multipiste. Aucune conception ne peut supposer une piste par micro.
- Pas de rires : l'émission n'est pas jouée devant un public.
- Musique de fond fréquente, effets sonores quasi absents.
- Habillage incrusté sur les vingt émissions existantes : bloc « SOMMAIRE » sur
  environ 20 % à gauche, listes de défis à droite, cartouches de jeu en bas
  (« Bim Bam Boum ! »), logo permanent en haut à droite. Les prochains lives
  pourront être enregistrés sans habillage, mais l'existant reste tel quel.
- Aucune métadonnée de régie sur les émissions passées. Toute conception doit
  fonctionner sur le seul fichier mixé.

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
- API de déclenchement.

Hors périmètre :

- la publication sur les réseaux. L'outil produit des fichiers MP4 et les textes
  (titre, description, hashtags). Julien publie avec ses outils.
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

Deux choses qui ressemblent à du raffinement et qui sont dans l'itération 0
parce qu'elles conditionnent la vitesse d'itération :

- **le sidecar du transcript**, sans lequel chaque essai recoûte 25 minutes de
  transcription ;
- **le saut d'étape si l'artefact existe**, version simplifiée du graphe (une
  présence de fichier, pas encore une clé de validité).

Le choix manuel du crop n'est pas un pis-aller jetable : il reste ensuite comme
réglage de dernier recours, et l'automatique ne fera que le préremplir.

### Les itérations suivantes

| Itération | Contenu |
|---|---|
| 1 | Cadrage automatique : détection de personnes et de plans, ratio au percentile 90, crop fixe par plan, coupes posées sur les frontières |
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
| Analyse | une fois par live | 30 à 45 min sur GPU | des artefacts réutilisables |
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
  shots.json           frontières de plans
  people.json          boîtes de personnes échantillonnées
  audio.json           musique, silences, événements
  candidates.json      les propositions, par passe
  clips/               les EDL
  renders/             les MP4 produits
```

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
Drive partagé. `people.json` aussi, parce qu'il dépend du détecteur et du taux
d'échantillonnage.

`shots.json` reste également dans le projet, alors qu'un changement de plan est
un fait de la vidéo. La raison est pratique et l'emporte : le seuil de détection
demandera des réglages, et ce qui se règle doit vivre là où on le règle.

**Le proxy est en 960x540 plutôt qu'en 640x360.** Un sujet occupant 6 % de la
largeur ne fait que 38 px sur un proxy 640, ce qui est mince pour YOLO ; à 960 il
en fait 58. Le poids double, ce qui reste sans conséquence sur un disque local.

**Le proxy est en 30 fps quelle que soit la source.** Les vingt émissions
existantes sont en 60 fps, décimées en 2:1, ce qui est exact et sans saccade. Les
tournages à venir passeront en 30 fps : le 60 double le coût de décodage à chaque
étape et la taille des fichiers, sans rien apporter à un vertical compressé.

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
| Proxy 960x540 à 30 fps, keyframe 1 s | ffmpeg, CPU | 10 à 15 min |
| Extraction audio | ffmpeg | 1 min |
| Transcript, alignement, locuteurs | WhisperX large-v3 | 15 à 25 min |
| Correction du transcript | lexique, puis Ollama (après libération du GPU) | 3 à 8 min |
| Frontières de plans | détection sur le proxy | 2 min |
| Personnes | YOLO classe *person*, 2 images par seconde | 5 min |
| Analyse audio | voir plus bas | 5 min |
| Repérage des candidats | Gemini | 1 min |

La musique de fond gêne Whisper. La suppression de voix MDX23C du diariseur
existant corrige cela mais coûte cher, donc elle ne se déclenche que sur les
passages détectés comme musicaux.

## 7. Le repérage des candidats

Aucun signal automatique n'identifiera de façon fiable les bons moments d'une
improvisation sans public. La réponse n'est donc pas un meilleur juge mais
**plusieurs sources indépendantes fusionnées**. Une source aveugle sur un type de
moment est rattrapée par une autre. Julien trie ensuite, et l'objectif de
l'étage est le rappel, pas la précision.

1. **Gemini sur le transcript.** Fenêtres de 90 secondes chevauchées de 30, notées
   par lots avec un barème ancré, mécanique reprise d'OpenShorts. On garde le
   haut du panier. Cette source ne voit pas le jeu physique, par construction.
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

Repris d'OpenShorts, dont le rendu convient : karaoké mot à mot, Anton 44, blanc
sur surlignage `#FFE500`, contour noir de 4 px, majuscules, 16 caractères par
carton au maximum et 1,4 seconde par carton au maximum. Génération d'un fichier
ASS puis incrustation par ffmpeg.

Ces valeurs deviennent un preset modifiable, pas des constantes en dur.

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

**Le ratio est choisi une fois par clip.** Pour chaque image des segments retenus,
on calcule la largeur nécessaire, on prend le **percentile 90** (pas le maximum,
sinon une seule image où quelqu'un traverse le cadre condamne le clip entier), et
on retient le plus petit ratio qui couvre. Sur les 10 % restants, un sujet peut
sortir partiellement du cadre.

**La position du crop est fixe à l'intérieur de chaque plan**, calculée pour
couvrir l'action de ce plan. Elle ne change qu'aux frontières de plans, où une
coupe existe déjà, donc où le saut est invisible.

Le mouvement de caméra perçu est nul. Sur des plans continus de plusieurs minutes
avec des comédiens qui se déplacent, toute caméra qui suit finit par tanguer :
c'est la cause du défaut reproché à OpenShorts, et elle est structurelle, pas
dans un réglage d'amortissement.

Le prix est assumé : un plan de trois minutes où les comédiens traversent le
plateau impose un crop large, donc un ratio qui monte, parfois jusqu'au 16:9. Un
cadre large et stable vaut mieux qu'un cadre serré qui vacille.

**Zones d'habillage.** Sur les vingt émissions existantes, le crop évite le bloc
de gauche quand il le peut. Le logo en haut à droite est permanent et tombe dans
tout crop pris à droite : on l'accepte.

## 11. Le rendu

Depuis l'original, jamais depuis le proxy.

1. Concaténation des segments de l'EDL.
2. Crop et mise à l'échelle, un réglage par plan.
3. Sous-titres incrustés depuis le transcript aligné au mot, **recalés sur la
   timeline du clip**. Après les coupes internes, les timings d'origine ne valent
   plus rien : c'est le piège principal du rendu.
4. Logo et mention Twitch, dans une bande qui tient compte des zones réservées
   (chrome des plateformes en haut, sous-titres en bas).

Deux fichiers par clip quand le ratio n'est pas 9:16 : le format natif (4:5 ou
1:1) pour le feed Instagram et Facebook, et une variante 9:16 plein écran avec le
contenu posé sur fond flouté pour TikTok et Shorts.

### Encodage : ce que NVENC apporte, et où

Mesuré le 18 août 2026 sur `2026-03-08-caro-mdlm.mp4`, par la session
d'implémentation.

| | CPU | NVENC |
|---|---|---|
| Proxy 960x540 à 30 fps | 14,2x | 15,7x |
| Export 1080x1920 | 2,02x | **5,76x** |

**Le proxy ne gagne rien à passer sur le GPU** : son goulot n'est pas l'encodeur.
Une émission de 2h50 coûte une douzaine de minutes en CPU, ce qui reste dans
l'ordre de grandeur de la section 6. **L'export gagne un facteur trois**, et
c'est lui qui tourne une fois par clip validé.

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
POST   /api/projects              { source } -> 202 + projectId
GET    /api/projects/:id                       état, progression, clés par étape
GET    /api/projects/:id/candidates            les propositions
GET    /api/clips/:id                          l'EDL
PATCH  /api/clips/:id                          édition de l'EDL
POST   /api/clips/:id/export                   rendu
```

Et les routes qui portent la reprise :

```
POST   /api/projects/:id/run      { target, force? }   recalcule jusqu'à la cible
POST   /api/projects/:id/rerender { style? }           re-rend les clips exportés
```

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

## 13. L'interface

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
- Une bande secondaire montre les plans et le ratio retenu, en lecture seule.

La durée s'affiche et bouge en direct, comme information et non comme contrainte.

### La pile front

| Choix | Pour quoi |
|---|---|
| Next.js | même socle que `obs-tools` et `obs-suite`, et un serveur est de toute façon nécessaire pour l'API, ffmpeg et le proxy servi en requêtes partielles |
| shadcn/ui sur Base UI | les composants deviennent du code du projet, modifiables sans lutter contre une API ; rendu d'application de bureau plutôt que de site web |
| TanStack Query | l'analyse dure 30 à 45 minutes : suivi d'avancement, invalidation, reprise d'étape |
| TanStack Virtual | le **transcript**, environ 20 000 mots pour deux heures, affiché sélectionnable |
| Zustand | état local de l'éditeur ; l'EDL étant une structure simple, l'annulation est une pile d'instantanés |

**Écartés tant qu'il n'y a pas de raison** : `dnd-kit` (rien à glisser, les
segments naissent d'une sélection dans le texte), TanStack Table (25 cartes, pas
un tableau de données), `react-resizable-panels` (un seul séparateur au départ)
et toute la famille timeline multi-pistes, waveforms et playhead. Ce dernier
point mérite d'être dit explicitement, parce que c'est le réflexe naturel quand
on décrit « une interface de montage » : **la surface d'édition ici est le
transcript**, et la bande des plans est en lecture seule. Construire un NLE
reviendrait à bâtir le morceau le plus difficile du métier pour un produit qui
ne s'en sert pas.

La version de shadcn qui repose sur Base UI plutôt que Radix est à vérifier à
l'installation.

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
