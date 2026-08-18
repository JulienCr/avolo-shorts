# CLAUDE.md

Guidance pour Claude Code (claude.ai/code) sur ce dépôt.

## Ce que c'est

`avolo-shorts` transforme les replays Twitch de « LA SCÈNE AVOLO », une émission
d'improvisation théâtrale, en extraits courts pour Instagram, TikTok, YouTube
Shorts et Facebook.

**La conception fait autorité et vit dans
`docs/superpowers/specs/2026-08-17-avolo-shorts-design.md`.** Lis-la avant de
toucher à quoi que ce soit de structurant : elle contient les mesures qui
justifient chaque décision, et plusieurs de ces décisions sont contre-intuitives.

Le projet remplace `~/dev/openshorts`, qui n'est pas mauvais mais résout un autre
problème (suivre un sujet plutôt que cadrer une scène, détecter des visages
plutôt que des corps).

**Une spec est datée, et le code peut l'avoir rattrapée.** Avant d'implémenter ce
qu'elle réclame, regarde à quel commit elle a été écrite et ce qui a été fusionné
depuis : le 18 août, deux de ses demandes étaient déjà satisfaites — les zones de
cadrage interdites, qu'un constat ultérieur a réduites à un cas unique, et un
champ de fraîcheur des rendus que la vague de l'export avait rendu inutile. Obéir
au texte y aurait ajouté une seconde source de vérité sur une question déjà
tranchée, et deux sources sur la même question finissent par diverger. Quand tu
constates l'écart, **corrige la spec dans le même mouvement** : elle fait
autorité, donc la laisser fausse coûte au suivant ce qu'elle vient de te coûter.

## Les décisions à ne pas défaire par réflexe

Chacune a coûté une mesure ou un aller-retour, et chacune contredit l'approche
qui vient spontanément.

| Décision | Le réflexe qu'elle remplace |
|---|---|
| Le clip est une **liste de segments**, la durée est un résultat | une fenêtre de 15 à 60 s |
| On raccourcit **par le milieu**, jamais par les bouts | tronquer la fin |
| Le **ratio varie par clip** (9:16, 4:5, 1:1, 16:9) | tout sortir en 9:16 |
| Le **crop est fixe à l'intérieur d'un plan** | une caméra qui suit le sujet |
| On détecte des **corps**, pas des visages | la détection de visages |
| La surface d'édition est le **transcript** | une timeline multi-pistes |
| La correction renvoie des **substitutions indexées**, pas du texte | demander au modèle de corriger la phrase |

Les mesures qui les fondent sont dans la section 2 de la spec. En résumé : sur
trois émissions, seuls 24 à 33 % du temps tiennent dans un 9:16, mais 48 %
tiennent dans un 1:1 ou plus serré, et ce chiffre est stable sur les trois.

## L'environnement

- **GPU** : RTX 4090, 24 Go, accessible depuis WSL.
- **Sources** : le Google Drive partagé qui porte les replays est **lent** (9p) et
  décroche de deux façons différentes. Copier en local avant de traiter, en
  gardant le nom de fichier d'origine.
- **Ollama** tourne sur l'hôte Windows, port 11434. **L'adresse de la passerelle
  WSL change au redémarrage** : la résoudre par `ip route show default`, jamais
  la coder en dur.
- **VRAM** : un modèle Ollama de 18 Go et WhisperX large-v3 ne tiennent pas
  ensemble sur 24 Go. La correction des sous-titres s'exécute après la
  transcription, jamais en parallèle.
- **Sources vidéo** : 1920x1080, 4,5 à 12,7 Go pièce. La cadence n'est pas
  uniforme : les trois émissions mesurées sont en 60 fps, `2025-06-15-cqlp.mp4`
  est en 30. Sans conséquence, le filtre `fps=30` traite les deux. Les tournages
  à venir passeront en 30 fps.
- **ffmpeg** : le binaire d'Ubuntu sous WSL n'a **ni `h264_nvenc` ni
  `-hwaccel cuda`**. Il faut un build statique, installé par `setup.sh`. Mesuré
  avec ce binaire : NVENC est **plus lent** que le CPU sur le proxy (12,8x contre
  13,8x) et lui gagne un facteur 2,3 sur l'export (4,58x contre 1,97x, en
  `-preset p5`). Ne jamais combiner `-pix_fmt yuv420p` et
  `-hwaccel_output_format cuda` : l'encodage échoue sans message exploitable.
  Attention aux chiffres mesurés avec le ffmpeg **Windows** : il ne passe pas par
  la passerelle CUDA de WSL et flatte l'export d'environ 25 %.
- Le diariseur de `~/dev/rythmo-impro/diarizer` (WhisperX large-v3 + pyannote)
  existe déjà et fonctionne. Il tourne **en venv, pas en Docker** : son
  `run-wsl.sh` exporte `LD_LIBRARY_PATH` vers le `nvidia/cudnn/lib` du venv,
  correctif indispensable à CTranslate2. Le `CLAUDE.md` de ce dépôt-là contient
  encore une ligne périmée affirmant l'inverse.
- **Une mesure prise dans WSL sur cette machine porte 40 à 80 % de variance**, et
  ce n'est ni thermique ni réglable. Le planificateur de Windows place les vCPU de
  la machine virtuelle où il veut sur une topologie hybride : d'une exécution à
  l'autre, le même travail tombe sur des P-cores à 5,1 GHz ou sur des E-cores à
  4,1 GHz, dont l'IPC est nettement inférieur en AVX2. `.wslconfig` n'a aucune clé
  d'affinité — vérifié dans la source de WSL, pas déduit de la documentation.
  Conséquence pour un dépôt qui décide sur des mesures : relever `/proc/loadavg` à
  côté de chaque chiffre, refuser toute mesure prise sous charge, faire trois
  passes et garder la médiane. **Un écart inférieur à ~10 % n'est pas établi** —
  ce qui vise nommément les 7 % qui font préférer x264 à NVENC sur le proxy
  (13,8x contre 12,8x, deux lignes plus haut) : la conclusion n'est pas démentie,
  elle n'a simplement jamais été mesurable en une passe.
- **Le throttling thermique a été cherché et n'existe pas** (18 août 2026). Sous
  six minutes de charge AVX2 tous cœurs, les P-cores tiennent 5,12 à 5,15 GHz sans
  décroître, `PerformanceLimitFlags` reste à 0, et le journal Windows ne porte
  aucun événement 37. Le GPU tient 67 °C à 448 W, compteurs de ralentissement
  thermique à zéro. Une lenteur observée ici est de la **contention**, pas de la
  chaleur — ne pas rouvrir la question sans un fait nouveau.
- **Pas de Docker ici.** Node natif, Python en venv, ffmpeg natif. Le
  raisonnement est en section 5 de la spec : openshorts se conteneurise parce
  qu'il s'installe chez des inconnus, ce projet tourne sur une machine dont
  l'environnement est déjà monté, et conteneuriser réimporterait la fragilité des
  binds sur le Drive.

## Livraison

L'itération 0 fait marcher la chaîne de bout en bout, interface comprise, avec un
cadrage réglé à la main. Le cadrage automatique, la qualité du repérage, la
correction des sous-titres et l'automatisation suivent dans cet ordre. Le détail
est en section 4 de la spec.

Ne pas anticiper une itération ultérieure au prétexte que « c'est presque le
même code ».

## Les issues

Le dépôt a des templates, vingt-cinq labels et un workflow qui étiquette tout
seul. Il n'a presque pas d'issues, et c'est voulu : un backlog noyé cache ses
propres urgences, et rien ne le noie plus vite qu'une flotte d'agents qui
consigne chacun ce qu'il a remarqué.

Une issue se crée si **les trois** tiennent :

1. **Il y a une action différée.** Pas un fait, pas une réserve, pas une
   observation. Si personne ne fera jamais rien, c'est une note.
2. **Il n'y a pas de meilleur foyer.** Un commentaire au point d'appel, la tâche
   du plan, ce fichier ou la spec valent mieux dès lors que la personne qui en a
   besoin les lira au bon moment. Une issue qui double l'un d'eux vieillit
   séparément et finit par le contredire.
3. **Ce serait perdu autrement.** Rien dans le plan de l'itération en cours ne le
   fera remonter au moment utile.

Deux règles de portée :

- **Dans l'itération en cours, le tracker est le plan**, pas la liste des issues.
  Une issue sert à ce qui survit au plan.
- **Un agent ne crée pas d'issue de sa propre initiative.** Il le signale dans son
  rapport final, et celui qui orchestre tranche.

Une exception, parce qu'elle vient d'ailleurs : au triage d'une review, une
trouvaille réelle mais hors du périmètre de la PR se dépose en issue avec les
labels du dépôt, et son numéro est consigné dans la réponse au relecteur.
