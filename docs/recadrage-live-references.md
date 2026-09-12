# Le recadrage en direct — sources et relevés

Le dossier documentaire d'[ADR-0001](adr/0001-avolo-reframe.md). Ce que les
autres font, ce que les API permettent, et ce qu'on a déjà mesuré. Relevé le
**12 septembre 2026** ; chaque section dit ce qui est **vérifié à la source** et
ce qui reste une **hypothèse**.

Deux mises en garde qui ont déjà servi pendant ce relevé :

- Les pages produit datent vite, et les dépôts meurent sans l'annoncer. Toute
  affirmation d'état (« maintenu », « archivé ») porte sa date.
- Une phrase citée ne dit pas ce qu'on en déduit. Une conclusion tirée d'une
  citation a été fausse une fois dans ce relevé même — voir §4, la latence AWS.

---

## 1. L'écosystème OBS : quatre outils, quatre impasses

Recherché le 12 septembre 2026. Aucun ne cadre **plusieurs corps**.

| Outil | État | Détecte | Verdict |
|---|---|---|---|
| [Intel OpenVINO plugins for OBS](https://github.com/intel/openvino-plugins-for-obs-studio) — *Smart Framing* | **archivé le 17 août 2026** par Intel | personnes **et** visages | mort ; et OpenVINO sur machine NVIDIA tourne sur CPU |
| [StreamFX](https://github.com/Vhonowslend/StreamFX-Public/wiki/Filter-Auto-Framing) — *Auto Framing* | déprécié, cassé sur OBS 30+ ; binaires réservés au Patreon (7,50 €/mois) ; SDK NVIDIA requis en 404 | **visages**, 8 max en mode groupe | impasse pratique |
| [obs-face-tracker](https://github.com/norihiro/obs-face-tracker) | vivant, mainteneur unique ; « consumes a lot of CPU » | **visages** (dlib HOG/CNN), **un seul** | inutilisable ici |
| [obs-detect](https://github.com/locaal-ai/obs-detect) | **stalled depuis le 18 décembre 2024** | objets (EdgeYOLO) + visages (YuNet) | abandonné |

**Ce qui est verifié.** Les quatre états et les capacités ci-dessus viennent des
pages liées. Le README d'obs-face-tracker documente son cas d'échec :
« if there are two or more faces, the plugin might hover back and forth over the
faces » — c'est-à-dire une scène d'AVOLO.

**Deux relevés qui servent au-delà du tableau.**

- **Ce sont tous des plugins natifs**, sans exception. Ce qui les tue est la
  maintenance, pas l'écriture. Intel n'a pas tenu.
- **StreamFX expose sa cadence de suivi en secondes ou en Hz**, comme un réglage
  utilisateur, à côté de *Stability*, *Smoothing* et *Prediction*. Un outil du
  domaine considère donc la cadence de détection comme un paramètre libre, pas
  comme une contrainte à 25 im/s.

---

## 2. Le double canevas

### Les canvases sont entrées dans le cœur d'OBS

- [PR #11832 — *Canvases, Part Deux (Loading/Saving + Frontend API)*](https://github.com/obsproject/obs-studio/pull/11832)
- [PR #11833 — *Canvases, Part Tres (Multitrack Changes)*](https://github.com/obsproject/obs-studio/pull/11833)

Fusionnées. Testées, dit la PR, « with a fork of the vertical canvas plugin that
makes use of the new APIs ».

### Aitum Vertical s'est posé dessus

[Aitum/obs-vertical-canvas](https://github.com/Aitum/obs-vertical-canvas) —
[release 1.6.0](https://github.com/Aitum/obs-vertical-canvas/releases/tag/1.6.0),
verbatim :

> - Requires OBS 31.1 or higher
> - **Converts existing Aitum Vertical scenes to the new OBS canvas system**

Et la 1.6.3 porte « Fix edit transform for OBS 32.1 ». La 1.6.4 est la plus
récente au 12 septembre 2026.

**Conséquence, et c'est le fait qui débloque tout** : le canevas vertical n'est
plus une construction privée du plugin. C'est un canevas OBS, adressable par
l'API du cœur.

Côté produit : [Aitum Vertical](https://obsproject.com/forum/resources/aitum-vertical.1715/)
donne un canevas 1080x1920 à côté du 1920x1080, lie les scènes des deux, et
fournit à la verticale sa propre sortie. Avec **Aitum Multistream** pour les
clés, le double streaming ne demande aucun développement.

### Le trou entre OBS 32.0 et 32.1

Sur le [fil du forum](https://obsproject.com/forum/threads/aitum-vertical.166504/page-12),
des utilisateurs signalent avoir perdu le contrôle websocket de leurs scènes
verticales **depuis OBS 32.0.0**. Le développeur ne répond pas sur ce point et
renvoie vers « Aitum Stream Suite ».

**Hypothèse, non confirmée par une source** : les canvases arrivent dans le cœur
en 32.0, Aitum y migre, mais obs-websocket ne sait les adresser qu'en 32.1 —
d'où une fenêtre où les scènes verticales étaient invisibles à l'API. Ça colle
avec §3, mais personne ne l'écrit. **C'est la raison pour laquelle le go/no-go de
l'ADR impose OBS >= 32.1.**

---

## 3. obs-websocket : la chaîne d'appels, vérifiée

[Notes de version OBS 32.1](https://obsproject.com/blog/obs-studio-32-1-release-notes) :
« Added partial support for Canvases to obs-websocket ». Le mot **partial** est
dans la source ; le prendre au sérieux.

Spec brute (à relire à la source plutôt que de mémoire) :
[`docs/generated/protocol.md`](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md).
obs-websocket est développé dans obs-studio depuis la fusion des projets : ses
versions suivent celles d'OBS, et la page *Releases* du dépôt s'arrête à la 5.0.1.

**Relevé dans la spec, le 12 septembre 2026 :**

| Élément | Détail |
|---|---|
| `GetCanvasList` | « Gets an array of canvases in OBS » — **ajouté en v5.7.0**. Réponse documentée seulement comme `canvases: Array<Object>`, sans détail des champs. |
| Évènements | `CanvasCreated`, `CanvasRemoved`, `CanvasNameChanged`, portant `canvasName` et `canvasUuid` |
| `?canvasUuid` en champ de requête | sur `GetSceneList`, `GetSceneItemList`, `GetSceneItemTransform`, **`SetSceneItemTransform`**, et la plupart des requêtes de scènes et de sources |

Et la formulation qui compte, répétée sur chacune :

> `?canvasUuid` — UUID of the canvas the scene is in, **if using the sceneName field**

Donc **adresser par `sceneUuid` dispense du canevas** : les UUID de scènes sont
uniques globalement.

**La chaîne complète :**

```
GetCanvasList                     -> UUID du canevas vertical
GetSceneList(canvasUuid)          -> les scènes de ce canevas
GetSceneItemList(sceneUuid)       -> le sceneItemId de la source à cadrer
SetSceneItemTransform(sceneUuid, sceneItemId, { sceneItemTransform: { crop... } })
```

`SetSceneItemTransform` « sets the transform **and crop** info of a scene item ».

**Ce qui reste à éprouver à l'exécution**, et que la doc ne dira pas : ce que
`GetCanvasList` renvoie réellement, et si le crop prend effet sans avoir ouvert
le filtre dans l'interface. Un défaut de cette forme est documenté sur
[Move Transition](https://github.com/exeldro/obs-move-transition/issues/269).

**Autres pistes de transport**, non retenues mais notées :
[obs-crop-control](https://github.com/rse/obs-crop-control) pilote des filtres
Crop/Pad par websocket avec interpolation ; le
[filtre Render Delay](https://obsproject.com/kb/render-delay-filter) d'OBS
retarde une source de 500 ms par instance, empilable — de quoi offrir au
lisseur une fenêtre d'avance sur la seule sortie verticale.

---

## 4. Ce que font les autres, et ce qu'ils ne font pas

### AWS Elemental Inference

- [Annonce AWS News Blog](https://aws.amazon.com/blogs/aws/transform-live-video-for-mobile-audiences-with-aws-elemental-inference)
- [Smart crop dans MediaLive](https://docs.aws.amazon.com/medialive/latest/ug/elemental-inference-smart-crop.html)
- [Prérequis et contraintes](https://docs.aws.amazon.com/medialive/latest/ug/smart-crop-get-ready.html)
- [Mise en oeuvre](https://aws.amazon.com/blogs/media/using-aws-elemental-inference-with-medialive/)

Phrase de référence, verbatim :

> AWS Elemental Inference applies AI capabilities **in parallel with live video**,
> achieving 6–10 second latency **compared to minutes for traditional
> postprocessing approaches**.

**Le piège, et il a été payé dans cette étude.** Ces 6-10 s ne sont **pas** un
surcoût de l'IA, et surtout pas un buffer de look-ahead : la comparaison de
référence est le **post-traitement en minutes**, et une chaîne
MediaLive -> MediaPackage -> CDN est déjà à
[3 à 5 s glass-to-glass en LL-HLS](https://docs.aws.amazon.com/wellarchitected/latest/streaming-media-lens/scenario-4-low-latency-live-streaming.html),
bien pire en HLS standard. Les 6-10 s sont l'ordre de grandeur d'une diffusion
live ordinaire.

**La latence réellement ajoutée par le smart crop n'est publiée nulle part** — ni
par AWS ni par ses intégrateurs.

Contraintes documentées, utiles parce qu'elles disent ce que le détecteur
confond : pas d'overlays d'image dynamiques (« movement in the overlay might
include movement that Elemental Inference will incorrectly start to track »), pas
d'overlays statiques ni de sous-titres incrustés (« the smart crop might cut them
off awkwardly »), pas d'AFD, entrée live seulement. La fonction s'active **par
sortie** ; la facturation est **par pipeline**.

### Grabyo

[AI Auto-Framing for Vertical Video: How It Works](https://about.grabyo.com/ai-auto-framing-vertical-video/) —
la page la plus technique trouvée côté fournisseurs, et ils s'appuient sur AWS
Elemental Inference.

La boucle, en quatre temps : **détecter -> choisir le crop -> lisser -> sortir**,
et elle tourne « **several times a second** ». Ratios cités : 9:16, 1:1, 4:5.

Trois relevés qui valent pour nous :

- Le lissage est « the **second biggest differentiator** between vendors ». C'est
  là que se joue la qualité perçue, pas dans la cadence de détection.
- Les cas difficiles annoncés : plans de foule, action d'ensemble, plans larges
  d'établissement, changements rapides de sujet.
- Ils recommandent « a human operator with the ability to override ».

### Google AutoFlip

[Billet de recherche](https://research.google/blog/autoflip-an-open-source-framework-for-intelligent-video-reframing/) —
la référence historique, et **hors ligne**, donc à ne pas invoquer pour le direct.

Deux points structurants quand même, parce qu'ils recoupent nos propres choix :
les coupes sont détectées par **comparaison d'histogrammes de couleur** (comme
notre score de scène ffmpeg, avec la même cécité aux translations), et AutoFlip
« **buffers the video until the scene is complete** before making reframing
decisions » — exactement notre percentile 90 sur la durée d'un plan.

---

## 5. Les chiffres de détection

### Ce qu'on mesure déjà (spec §6, 18-19 août 2026)

`worker/detect.py` : `yolo11m-pose`, FP16, `imgsz=960`, lots de 32, classe
*person* seule, sur le proxy 960x540.

| Grandeur | Valeur |
|---|---|
| `--fps` par défaut | **2 im/s** — images analysées par seconde de vidéo, un choix de cadrage |
| Débit GPU | **145 im/s** en pose, 147 en détection (3 passes chacun ; écart de 1,4 % non établi) |
| Étape complète | 113 s pour 1 h 39, 139 s pour 1 h 54, 207 s pour 2 h 50, frontières comprises |

**Le rapport qui décide** : à 25 im/s le budget est de 40 ms par image, on en
consomme **6,9**. Les 25 im/s sont déjà acquises avec un facteur 5 à 6 de marge,
en PyTorch, par lots, à `imgsz=960` sur un proxy qui fait 540 de haut. **Un GPU
plus gros est la mauvaise dépense.**

Attention : ces 145 im/s sont un débit **par lots**. Le direct impose un lot
unitaire, dominé par le coût de lancement des noyaux — à mesurer, jamais à
extrapoler d'ici.

### Les leviers, par rentabilité décroissante

1. **`imgsz` de 960 à 640** — 2,25x moins cher, sur un proxy de 540 de haut.
2. **Export TensorRT FP16** — facteur 3 à 4 annoncé. **Chemin live uniquement** :
   un moteur TRT est lié à la carte et au pilote, et son non-déterminisme
   casserait la reproductibilité du chemin fichier.
3. **Modèle plus petit** (`yolo11s-pose`, `yolo11n-pose`) — 5 à 10x. À mesurer
   contre les cas de contrôle, pas à supposer.

### Repères publiés

- [Ultralytics YOLO11](https://docs.ultralytics.com/models/yolo11/) — YOLO11m
  détection : **4,7 ± 0,1 ms** sur T4 TensorRT10 à 640 px, 20,1 M paramètres.
- [Ultralytics — tâche pose](https://docs.ultralytics.com/tasks/pose/) — la page
  documente désormais la famille **YOLO26**, à inférence *NMS-free* :
  YOLO26m-pose à **5,0 ms** sur T4 TensorRT10 à 640. Le NMS-free aide surtout
  l'export TRT et la latence à lot unitaire.
- [YOLOs-CPP-TensorRT](https://github.com/Geekgineer/YOLOs-CPP-TensorRT) —
  implémentation C++ annonçant « sub-2ms end-to-end latency with 530+fps ».

### La piste NVIDIA

[SDK AR de NVIDIA Maxine](https://docs.nvidia.com/maxine/ar/index.html) —
[dépôt](https://github.com/NVIDIA-Maxine/Maxine-AR-SDK).

Le **3D Body Pose** prédit **34 points en 2D et 3D** avec angles articulaires,
**multi-personnes**, corps entier ou buste. Turing / Ampere / **Ada** /
Blackwell à Tensor Cores. Livré en **redistribuable Windows**.

C'est le seul candidat natif Windows qui détecte des **corps**. Deux réserves :
ses 34 points ne sont pas les 17 COCO, donc `torsoBounds` et la définition `bust`
demandent un remappage **et une re-mesure** ; et la saga StreamFX montre que la
distribution de ces SDK bouge — vérifier la disponibilité avant d'en dépendre.

---

## 6. Les contraintes de plateforme

Elles conditionnent le projet entier et ne dépendent pas de nous. À vérifier sur
les comptes AVOLO **avant** d'écrire du code.

- **TikTok** : le LIVE et la clé RTMP demandent généralement **1 000 abonnés**
  (variable selon les régions) et 18 ans. Sans ça, rien de tout ceci ne sert.
- **Instagram** : passe par **Live Producer**, compte **professionnel** requis.
  La clé est **régénérée à chaque session** et ne vaut que 4 à 7 h — donc pas de
  configuration « une fois pour toutes » : quelqu'un va la chercher avant chaque
  émission.

---

## Ce qu'on n'a pas trouvé

Consigné pour ne pas le rechercher deux fois :

- Aucune latence **ajoutée** publiée pour un smart crop live, chez aucun
  fournisseur.
- Rien de technique sur l'offre Dolby en recadrage vertical live ; les recherches
  ne renvoient que Hybrik, qui fait du crop paramétré, pas du crop automatique.
- Aucune cadence de détection publiée, sauf le « several times a second » de
  Grabyo et le réglage en Hz de StreamFX.
- Aucun plugin OBS, vivant ou mort, qui cadre **plusieurs corps** vers un
  canevas vertical. C'est le créneau d'ADR-0001.
