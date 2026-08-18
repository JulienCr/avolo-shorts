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
| `FFMPEG_ENCODER` | `auto`, `nvenc` ou `x264`. `auto` sonde NVENC une fois par processus |
| `REPLAY_DIR` | le Drive partagé qui porte les replays |
| `STAGE_DIR` | copies de travail locales |
| `PROJECTS_DIR` | artefacts par projet |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | repérage des candidats |
| `WHISPER_PYTHON` | venv du diariseur de `rythmo-impro`, réutilisé tel quel |
| `WHISPER_MODEL` | `large-v3` |

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
