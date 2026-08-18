# L'environnement de la machine

Ce qu'il faut installer, et les chiffres qui disent pourquoi. Toutes les mesures
de cette page ont été relevées le 18 août 2026 sur la machine de Julien : RTX
4090 24 Go, WSL2, pilote 610.88.

## ffmpeg

### Le problème

Le paquet `ffmpeg` d'Ubuntu (7.1.1) embarque libass, mais il n'est compilé ni
avec NVENC ni avec le décodage CUDA :

```
$ /usr/bin/ffmpeg -hide_banner -encoders | grep nvenc     # rien
$ /usr/bin/ffmpeg -hide_banner -hwaccels                  # vdpau vaapi qsv drm opencl
```

Sans NVENC, l'export d'un clip tourne à 2x le temps réel. Avec, il tourne à
4,6x. Sur une émission de 2 h 50 dont on tire une dizaine de clips, ça se sent.

### L'installation

```bash
./setup.sh
```

Le script télécharge le build statique GPL de
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), l'installe dans
`~/.local/opt/ffmpeg-nvenc/` et vérifie qu'il fonctionne. Relancé, il ne
retélécharge rien tant que le binaire en place convient ; `--force` passe outre.
`FFMPEG_PREFIX` change le dossier d'installation.

Ce build ne remplace pas celui du système : rien n'est écrit hors de
`~/.local/opt`, et `/usr/bin/ffmpeg` reste ce qu'il était. Le projet trouve le
bon binaire par `FFMPEG_BIN`.

**La release est épinglée**, à `autobuild-2026-08-17-13-05`, qui porte le
binaire sur lequel toutes les mesures de cette page ont été faites. BtbN publie
aussi une étiquette `latest`, réécrite à chaque build nocturne : la viser
rendrait l'installation non reproductible, et la spec §5 confie précisément ce
rôle à `setup.sh`, faute de conteneur. Pour prendre sciemment un build plus
récent :

```bash
FFMPEG_RELEASE=latest ./setup.sh --force
```

Il faut alors reporter ici la nouvelle version et refaire les mesures : rien ne
garantit qu'un autre build rende les mêmes chiffres, et c'est déjà arrivé (voir
plus bas l'écart avec la spec).

Chaque release publie un fichier `checksums.sha256`. Le script y lit le nom de
l'archive au lieu de le construire, ce qui le rend indifférent à la release
visée, puis vérifie la somme avant d'extraire quoi que ce soit.

**Le build téléchargé est vérifié avant de remplacer celui en place.** Les six
contrôles tournent dans le dossier temporaire ; l'installation existante n'est
touchée qu'une fois tous passés. Un build qui aurait perdu libass, ou qui ne
parlerait plus au pilote, laisse donc une machine en état de marche plutôt
qu'une machine sans ffmpeg.

### Les trois capacités, et pourquoi les trois

| Capacité | À quoi elle sert |
|---|---|
| `h264_nvenc` | encoder sur le GPU |
| `-hwaccel cuda` | décoder sur le GPU |
| filtre `ass` (libass) | incruster les sous-titres |

Un build qui a NVENC mais pas libass ne convient pas. Les sous-titres sont
incrustés dans l'image par le filtre `ass`, pas ajoutés en piste séparée : sans
libass, il n'y a pas de sous-titres du tout. Le paquet d'Ubuntu a libass et pas
NVENC, le build BtbN a les trois. D'où le remplacement plutôt qu'une
cohabitation.

`setup.sh` vérifie les trois, plus un encodage NVENC réel de quelques images de
synthèse. Cette dernière vérification n'est pas décorative : un encodeur peut
être compilé dans le binaire et échouer au premier appel si le pilote ne suit
pas.

Version épinglée et installée le 18 août 2026 :
`N-126188-g426841da9d-20260817`.

## Les mesures

Source : `2026-03-08-caro-mdlm.mp4`, 12,7 Go, 2 h 50, 1080p60. Fenêtre de 120 s
prise à 30 minutes. Sortie vers `-f null`, donc l'écriture disque ne compte pas.

### Le proxy ne gagne rien au GPU

Proxy 960x540@30, `-vf fps=30,scale=960:540`.

| | Vitesse |
|---|---|
| CPU, `libx264 -preset veryfast -crf 20` | **13,8x** |
| NVENC, `-preset p4` | 12,8x |

NVENC est plus lent. Le travail est dominé par le redimensionnement, qui se fait
sur le processeur dans les deux cas, et la descente des images depuis la mémoire
du GPU coûte plus qu'elle ne rapporte. Une mesure antérieure sur le fichier
entier donnait 14,2x contre 15,7x, soit la même conclusion : le gain est nul.

**Tranché.** La section 6 de la spec porte maintenant `ffmpeg, CPU — NVENC est
plus lent`, et la section 12 les chiffres ci-dessus. `proxyArgs` reçoit tout de
même son encodeur en argument (tâche 5) : le choix se fait à l'appel, sans
toucher au code. Ce que dit la mesure, c'est qu'il n'y a rien à gagner à y
mettre le GPU.

**Conséquence dans le code** (tâche 7) : `FFMPEG_ENCODER=auto` rend `x264` pour
le proxy et `nvenc` pour l'export. Ce n'est pas une entorse à `auto`, c'est ce
qu'`auto` veut dire — *le meilleur pour cette étape*. La sonde NVENC n'est même
pas consultée côté proxy, puisque sa réponse ne changerait rien. Une valeur
explicite, elle, est respectée partout. Voir `encodeurProxy` dans
`src/server/steps/proxy.ts` et `encoderName` dans `src/server/ffmpeg.ts`.

### L'export gagne beaucoup

Rendu 1080x1920, `crop=608:1080:656:0,scale=1080:1920:flags=lanczos`.

| | Vitesse | Images/s |
|---|---|---|
| CPU, `libx264 -preset medium -crf 18` | 1,97x | 118 |
| NVENC, `-preset p5 -tune hq` | **4,58x** | 275 |
| NVENC, `-preset p4 -tune hq` | 7,51x | 451 |

Le facteur 2,3 entre le CPU et NVENC en qualité est la raison d'être de cette
page.

Le chiffre de 4,58x demande une note, parce qu'il ne correspondait pas à celui
inscrit d'abord dans la conception : 5,76x. **Ce 5,76x avait été relevé avec le
ffmpeg de Windows**, appelé depuis WSL, qui parle au pilote sans traverser la
passerelle CUDA de WSL. Le binaire Linux, celui que ce projet appelle, la
traverse, et donne 4,58x de façon reproductible. Le CPU, lui, retombe pile sur
sa valeur d'origine (1,97x contre 2,02x annoncés), donc ce n'est pas la machine
qui a changé de rythme — c'est le binaire mesuré qui n'était pas le bon. Le
classement et la décision ne bougent pas, et la spec porte désormais le bon
chiffre. **Le repère à retenir pour cette machine est 4,6x.**

### Ce qui n'est pas le goulot

Trois hypothèses écartées, chacune par une mesure, pour éviter qu'on les reprenne :

- **Le Drive n'y est pour rien.** L'extraction en copie de flux des 120 s lit
  131 Mo en 3,3 s, soit 40 Mo/s. L'export en demande six. Rejouer l'export
  depuis une copie locale donne 4,52x, à la marge de bruit près du 4,58x mesuré
  sur `/mnt/j`.
- **Le décodage n'y est pour rien.** Décoder seul, `-hwaccel cuda` et rien
  d'autre, tourne à 16x (957 images/s).
- **Les filtres n'y sont pour rien.** Sans aucun filtre, l'encodage tourne à
  4,59x. Avec `crop` et `scale` en lanczos, 4,58x. En remplaçant lanczos par
  bicubic, 4,60x. Les trois se tiennent dans le bruit.

Ce qui reste : le préréglage NVENC. `p5` plafonne à 275 images/s, `p4` monte à
451, sur le même matériel et la même source. `-spatial-aq` et `-temporal-aq` ne
coûtent rien de mesurable.

**Ces trois mesures datent d'un graphe qui n'était qu'un `crop` suivi d'un
`scale`.** Le rendu porte désormais les sous-titres, les marques et — sur la
variante 9:16 — un flou de fond, et ce sont eux qui bornent l'export.
Voir « Le préréglage NVENC de l'export » plus bas : la conclusion de l'époque
était juste, elle a seulement cessé de s'appliquer.

### Les sous-titres sont gratuits

La chaîne complète (`-hwaccel cuda`, `crop`, `scale`, filtre `ass`, NVENC)
tourne à 4,56x contre 4,58x sans sous-titres. L'incrustation par libass ne coûte
rien de mesurable, ce qui rejoint la mesure d'incrustation de texte de la spec
(2,02x → 2,12x).

## Le piège à ne pas repayer

`-hwaccel_output_format cuda` et `-pix_fmt yuv420p` ne vont pas ensemble.
Reproduit le 18 août 2026 :

```
[enc:h264_nvenc] Could not open encoder before EOF
[out#0/null] Nothing was written into output file, because at least one of its
             streams received no packets.
Conversion failed!
```

Le message ne nomme ni l'option coupable ni le format, et la commande échoue en
moins d'une seconde sans rien produire. Facile d'y perdre une heure.

`-hwaccel_output_format cuda` laisse les images décodées dans la mémoire du GPU.
Le graphe de filtres les attend en mémoire système, et l'encodeur reçoit un
format qu'il ne sait pas ouvrir. La règle du projet :

> **`-hwaccel cuda` seul, jamais `-hwaccel_output_format cuda`.**

Les images redescendent en mémoire système, ce qu'exige de toute façon libass
pour incruster les sous-titres. Le coût est celui du transfert, et il est déjà
compris dans les 4,58x ci-dessus.

La tâche 5 verrouille cette règle par un test sur `renderArgs` : les arguments
produits ne contiennent jamais `-hwaccel_output_format`. Voir
`tests/core/ffmpeg-args.test.ts`.

**Le corollaire, mesuré lui aussi** : `-hwaccel` est une option **d'entrée**, sa
portée s'arrête au `-i` qui suit. Un rendu à N segments porte donc N
`-hwaccel cuda`, un devant chaque couple `-ss`/`-i`. Posée une seule fois en
tête, seul le premier segment décoderait sur le GPU et les suivants
retomberaient sur le chemin logiciel — sans erreur, juste plus lentement.

## L'autre piège : échapper un chemin dans un filtre

Le chemin du `.ass` et celui du dossier de polices entrent dans le
`-filter_complex`. Les replays s'appellent `2026-03-08-caro-mdlm.mp4`, mais rien
n'empêche un dossier de porter une apostrophe, et le premier réflexe est faux.

**Une valeur de filtre traverse `av_get_token` deux fois** : une fois quand le
graphe est découpé en filtres, une fois quand les options du filtre sont
séparées. Et les règles diffèrent des deux côtés d'une apostrophe.

| | contre-oblique | apostrophe | deux-points |
|---|---|---|---|
| **entre apostrophes** | littérale, n'échappe rien | ferme la chaîne | littéral |
| **hors apostrophes** | `\X` rend `X` | ouvre une chaîne | sépare les options |

La conséquence qui coûte : écrire `\'` **à l'intérieur** des apostrophes
n'échappe rien. Mesuré, `filename='/l\'été\:2026/c.ass'` échoue à l'analyse sur
« No option name near '2026' ». Et la forme documentée `'\''`, elle, passe
l'analyse mais **perd l'apostrophe en silence** — libass reçoit `/lété:2026/`,
qui n'existe pas. C'est le pire des deux, parce qu'il ressemble à un fichier
manquant.

Ce qui marche, vérifié par aller-retour sur des fichiers réellement posés sur le
disque (`l'été:2026`, `a'b'c`, `[x],y;z=w`, `dos\slash`, `';exit[v];a='`) :

| dans le chemin | émis |
|---|---|
| `\` | `\\` |
| `:` | `\:` |
| `'` | `'\\\''` |

La dernière ligne ferme la chaîne, écrit `\'` **lui-même doublement échappé** —
pour que le premier niveau livre `\'` au second —, puis la rouvre. C'est
`échapper()` dans `src/core/ffmpeg/args.ts`, et `tests/core/ffmpeg-args.test.ts`
en fige les trois formes.

## `loudnorm` change le taux d'échantillonnage

En passe unique, le filtre `loudnorm` travaille à **192 kHz** pour mesurer les
crêtes, et il sort à ce taux. Sans consigne, ffmpeg redescend alors au plus haut
taux que l'encodeur accepte. Mesuré : une source à 44,1 kHz ressort en
**96 kHz**. La variante floutée en héritait alors par `-c:a copy` ; elle ne
recopie plus le son du natif depuis le correctif de #22 — elle le normalise
elle-même, depuis la source, et passe donc par le même `aresample`.
(relevé par Aristarque)

Rien ne le signale — le fichier se lit, il est seulement plus lourd et dans un
format que personne ne livre. La parade est un `aresample=48000` **derrière**
`loudnorm`, dans le graphe. Vérifié : 44,1 kHz en entrée, 48 kHz en sortie.

## La sortie est positionnelle

`ffmpeg … /chemin/-sortie.mp4` écrit le fichier ; `ffmpeg … -sortie.mp4` échoue
sur « Unrecognized option 'sortie.mp4' ». ffmpeg accepte `--`, qui met fin aux
options, et cela ne change rien sur un chemin absolu. Les quatre constructeurs
d'argv le posent donc systématiquement.

## Deux pièges de la détection, dans setup.sh

Trouvés en écrivant le script. Tous deux se manifestent en faux négatifs : le
binaire annonçait `h264_nvenc absent` alors qu'un encodage NVENC passait dans la
foulée.

**`grep -q` ment sous `set -o pipefail`.** Il sort à la première correspondance,
ffmpeg prend un SIGPIPE en écrivant la suite de sa liste d'encodeurs, et
`pipefail` remonte cet échec comme celui du pipeline entier. Le résultat dépend
de qui gagne la course entre l'écriture et la fermeture du tube, donc le faux
négatif est intermittent, le pire genre. La parade : lire la sortie en entier,
filtrer ensuite.

**Le format de `-filters` change d'un build à l'autre.** Ubuntu écrit
`... ass`, BtbN écrit `.. ass`. Deux colonnes de drapeaux au lieu de trois. Un
motif qui compte les caractères se casse au premier changement de build.

## Les variables d'environnement

`cp .env.example .env`, puis ajuster. Le fichier `.env` n'est pas versionné.

| Variable | Rôle |
|---|---|
| `FFMPEG_BIN`, `FFPROBE_BIN` | binaires installés par `setup.sh` |
| `FFMPEG_ENCODER` | `auto`, `nvenc` ou `x264`. `auto` sonde NVENC une fois par processus — mais rend `x264` pour le proxy, où la mesure dit que le GPU fait perdre du temps. Une valeur inconnue est refusée, jamais rabattue en silence |
| `REPLAY_DIR` | le Drive partagé qui porte les replays |
| `STAGE_DIR` | copies de travail locales |
| `PROJECTS_DIR` | artefacts par projet |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | repérage des candidats |
| `WHISPER_PYTHON` | venv du diariseur de `rythmo-impro`, réutilisé tel quel |
| `WHISPER_MODEL` | `large-v3` |
| `WHISPER_WORKER` | facultative : le chemin de `worker/transcribe.py`, si le processus ne tourne pas depuis la racine du dépôt |

## Le worker de transcription

`worker/transcribe.py` ne fait que transcrire et aligner. L'itération 0 n'utilise
pas les locuteurs.

**Pas de `HF_TOKEN`** — et la formule courte « pas de pyannote » est fausse, donc
autant la dire en entier. `pyannote.audio` est bel et bien installé : c'est une
dépendance de WhisperX, et c'est lui qui porte la détection d'activité vocale,
avec un point de contrôle livré dans les fichiers de WhisperX. Ce dont on se
passe, c'est du **pipeline de diarisation**, sous accord sur le Hub, et qui seul
exige un jeton. Il n'est jamais instancié. Les modèles d'alignement, eux, sont
publics.

Il **réutilise le venv du diariseur** plutôt que d'en reconstruire 8,1 Go, et
`src/server/steps/transcript.ts` lui pose les deux variables du `run-wsl.sh` de
ce dépôt-là :

```
TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1
LD_LIBRARY_PATH=<venv>/lib/pythonX.Y/site-packages/nvidia/cudnn/lib
                [:<chaque segment non vide du LD_LIBRARY_PATH hérité>]
```

Sans la seconde, CTranslate2 ne trouve pas cuDNN et le chargement du modèle
échoue sur une bibliothèque introuvable — un message qui ne nomme ni Python, ni
sa version, ni pip. **Ce n'est pas facultatif.**

Deux écarts avec le `run-wsl.sh`, qui écrit `…/cudnn/lib:${LD_LIBRARY_PATH}` :

- **la version de Python se lit dans le venv** au lieu d'être codée à `3.10` ;
- **le chemin hérité est redécoupé, et ses segments vides sont jetés.** La forme
  du shell en produit un dès que la variable est absente, vide, ou finit par
  `:` — et un segment vide dans `LD_LIBRARY_PATH` désigne le **dossier
  courant**, donc ferait chercher les bibliothèques du processus là où il a été
  lancé. Écrire le `:` du shell sous condition ne suffirait d'ailleurs pas : un
  `/usr/lib::/opt/lib` hérité porte le sien au milieu.

`worker/requirements.txt` dit quoi installer sur une machine qui n'a pas ce
venv — à ne pas lancer par réflexe sur celle-ci.

## Le rendu : deux dossiers, et d'où ils sont lus

`src/server/steps/render.ts` va chercher deux choses hors de `PROJECTS_DIR`, et
les deux sont résolues **depuis le dossier de travail du processus**, comme
`worker/transcribe.py` l'est déjà :

| Dossier | Ce qu'il porte | S'il manque |
|---|---|---|
| `fonts/` | `Anton-Regular.ttf`, la police du preset de sous-titres | le rendu prévient et laisse libass prendre ce que fontconfig lui donne |
| `assets/brand/` | `logo.png` et `twitch.png` | le clip se rend sans marque |

Aucun des deux n'a de variable d'environnement : lancer depuis la racine du dépôt
suffit, c'est ce que fait Next comme `pnpm tsx`. Le second est ignoré par git —
les marques appartiennent à l'opérateur, et `assets/brand/README.md` dit quoi y
déposer.

Un clip produit **deux fichiers dès que son ratio n'est pas 9:16** : le format
natif pour le feed d'Instagram et de Facebook, et une variante 9:16 sur fond
flouté pour TikTok et Shorts. **Les deux se rendent depuis la source**, avec les
mêmes segments, le même rectangle de crop, les mêmes sous-titres et les mêmes
marques — voir la section suivante, qui explique pourquoi la variante ne part
plus du natif.

Mesuré le 18 août 2026 sur `2025-06-15-cqlp.mp4`, un clip de 43,2 s monté en
trois segments et rendu en 1:1 : **15 s pour les deux sorties**, le natif et sa
variante réunis. Un second clip du même projet, 29,4 s en deux segments et déjà
en 9:16, donc sans variante : 4 s. Cette source est en 30 images par seconde ;
les émissions en 60 fps coûtent le double.

## Le fond flouté ne peut plus porter de texte

La variante 9:16 partait du **rendu natif déjà terminé**. Son fond était donc un
agrandissement du clip fini, cartons de sous-titres compris, et un flou gaussien
n'efface pas des lettres de 40 px cerclées d'un contour de 8 : il les étale.

**Constaté à l'image, et le filtergraph ne le disait pas.** Sur les 43 s du clip
1:1 de `2025-06-15-cqlp`, une image par seconde extraite de la bande du bas —
1080x420, sous l'avant-plan — donne **43 tuiles sur 43 avec un carton pleinement
lisible**, à la même taille que le vrai, le jaune du mot actif compris. C'est
exactement la bande où TikTok et Shorts posent leur interface, et cette variante
est ce qui permet à un 1:1 ou à un 4:5 d'atteindre ces deux plateformes : la
moitié du bénéfice mesuré en section 2 de la spec passe par elle.

**Monter le sigma était la mauvaise réponse**, et c'est pour ça qu'elle est
écrite ici. Elle floute toute l'image davantage — le fond n'a pas à devenir une
purée — et rien ne garantit qu'elle suffise : un flou gaussien étale un trait à
fort contraste, il ne le détruit pas, et le sigma qu'il faudrait ferait cesser le
fond d'être une image. `SIGMA_DU_FOND` vaut toujours 12 dans
`src/core/ffmpeg/args.ts`, et le commentaire y dit pourquoi il n'en bouge pas.

**Ce qui répare, c'est de ne jamais mettre de texte dans le fond.** La variante
se rend depuis la source comme le natif, et le `split` qui sépare le fond de
l'avant-plan est posé **avant** l'incrustation :

```
[vc]split=2[bga][fga];
[bga]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=12[bg];
[fga]ass=…[vf0];[vf0][lg0]overlay=…[vf1];[vf1]scale=1080:-2[fg];
[bg][fg]overlay=x=0:y=(H-h)/2,setsar=1[v]
```

Le fond ne peut plus contenir de sous-titre ni de marque : il n'en a jamais vu
passer. C'est correct par construction, là où un sigma plus haut n'aurait été
qu'un réglage à défendre. Vérifié à l'image sur le même clip, avec la même
mosaïque : **43 tuiles sur 43 sans un pixel de texte**, et la bande du haut est
propre elle aussi.

Le même jour, même clip, sortie vers `-f null`, meilleur temps de quatre passes :

| Passe d'encodage | 43,2 s de clip |
|---|---|
| rendu natif 1:1 | 3,85 s (337 img/s) |
| ancienne variante, depuis le natif | 6,19 s (210 img/s) |
| **nouvelle variante, depuis la source** | **8,73 s (149 img/s)** |

L'export passe donc de 10 s à 12,6 s d'encodage pour ce clip, **+26 %**, ce qui
reste loin de la minute pour un clip de 90 s. Deux notes sur ce prix :

- il ne se paie **pas** en décodage — décoder les segments une seconde fois est
  la partie bon marché, le décodage seul tournant à 16x sur cette machine ;
- il rapporte au passage une génération d'encodage en moins sur l'avant-plan, qui
  ne recycle plus un MP4 déjà compressé. Le son, lui, n'est plus recopié du natif
  mais renormalisé depuis la source : c'est le même `loudnorm` sur le même PCM
  d'origine, donc toujours une seule compression.

**Où passe le temps, mesuré** : la même variante sans le `gblur` tourne à
218 img/s contre 149. Le flou coûte donc `1000/149 − 1000/218 = 2,1 ms` par
image, soit **32 % de la passe**. C'est aujourd'hui le poste le plus cher de
l'export, avant l'encodeur — voir la section suivante, qui en tire la
conséquence.

Le calcul est écrit parce qu'il a été faux une fois : cette page portait 2,4 ms
et 35 %, qui ne se déduisent pas de ces deux débits — il aurait fallu 232 img/s
sans le flou pour les obtenir. Les deux débits sont les mesures ; le reste s'en
dérive et doit pouvoir se refaire de tête. (relevé par Copilot)

## Le préréglage NVENC de l'export : `p5` reste

`p5` était écrit en dur dans `NVENC.quality` (`src/core/ffmpeg/encoder.ts`),
repris d'OpenShorts, et personne n'avait regardé ce que `p4` coûtait en qualité.
La question se posait parce que `p4` encode 1,6x plus vite que `p5`. Tranché le
18 août 2026, **après** le passage de la variante à un rendu depuis la source :
mesurer avant, c'eût été mesurer le pipeline qu'on remplaçait.

**Côté qualité, `p4` tient — et pas de justesse.** Même graphe, même fenêtre de
6 s prise dans le clip 1:1, encodée en `p5` et en `p4`, comparées à une référence
sans perte (`libx264 -qp 0`) du même graphe :

| | PSNR Y | SSIM Y | Taille |
|---|---|---|---|
| `p5` | 34,5678 dB | 0,990743 | 3,78 Mo |
| `p4` | 34,5674 dB | 0,990629 | 3,78 Mo |
| `p7` | 34,5702 dB | 0,990805 | 3,82 Mo |

Les écarts sont à la quatrième décimale, et l'œil ne fait pas mieux : à
1080x1920, sur le sujet, sur le fond flouté — le grand aplat en dégradé où un
matriçage se verrait en premier — et sur le bord des lettres d'un carton, les
paires sont indiscernables ; l'image de différence amplifiée douze fois est
plate. Sur les 43 s complètes, `p5` et `p4` pèsent 29,67 et 29,73 Mo.

**Côté vitesse, la raison de changer a disparu.** Le préréglage fait toujours ce
qu'il annonce sur l'encodeur seul, mais l'export n'est plus borné par
l'encodeur :

| Meilleur de cinq passes, `-f null` | `p5` | `p4` |
|---|---|---|
| encodeur seul, 1080x1920, sans filtre | 261 img/s | **425 img/s** (1,63x) |
| rendu natif 1:1, graphe complet | 3,85 s | 3,86 s |
| variante 9:16, graphe complet | 8,73 s | 8,84 s |

Sur le graphe réel, les deux préréglages rendent **le même temps**. La variante
plafonne à 149 img/s là où `p5` seul en tient 261 au même format ; le natif
plafonne à 337, et son plafond d'encodeur est plus haut encore puisqu'il sort en
1080x1080. Ce sont donc les filtres qui bornent — `lanczos`, `ass`, les deux
marques, et pour la variante le `gblur` à lui seul. Le corollaire de la mesure
« Les filtres n'y sont pour rien » plus haut a cessé de valoir le jour où le
graphe a cessé d'être un `crop` suivi d'un `scale`.

**Verdict : on ne touche pas à la table.** Non parce que `p5` serait le prix de
la qualité — il ne l'est pas, `p4` rend la même image —, mais parce que `p4` ne
rend rien de plus : ni image différente, ni seconde gagnée. Un réglage de
livraison ne change pas pour zéro.

**Ce qui rouvrirait la question**, et c'est la seule chose à surveiller : que
l'export redevienne borné par l'encodeur. Cela arriverait si le `gblur` était
allégé — le flouter en quart de résolution avant de le remonter est le candidat
évident, et il rendrait jusqu'à 2,1 ms par image — ou si les filtres passaient
sur le GPU. Ce jour-là, `p4` reprendrait ses 1,63x, et la mesure de qualité
ci-dessus dit qu'il n'y a rien à perdre à les prendre.

## Le reste de la machine

Ces points vivent dans `CLAUDE.md` et dans la spec, rappelés ici pour mémoire :

- `REPLAY_DIR` est monté en 9p. Il est lent et décroche de deux façons que
  `/proc/mounts` ne distingue pas. On copie en local avant de traiter, en
  gardant le nom de fichier d'origine.
- Ollama tourne sur l'hôte Windows, port 11434. L'adresse de la passerelle WSL
  change au redémarrage : la résoudre par `ip route show default`.
- 24 Go de VRAM ne suffisent pas à tenir un modèle Ollama de 18 Go et WhisperX
  large-v3 en même temps. La correction des sous-titres passe après la
  transcription, jamais en parallèle.
- Pas de Docker. Node natif, Python en venv, ffmpeg natif.

## Le port de l'application

L'application écoute sur **4005**, fixé dans les scripts `dev` et `start` de
`package.json` plutôt que laissé au défaut 3000 de Next. La raison est
pratique : cette machine fait tourner plusieurs projets Next à la fois, et le
défaut partagé les fait se voler le port au premier démarrage — celui qui perd
échoue sur « Another next dev server is already running », ou pire, sert
silencieusement l'autre application.
