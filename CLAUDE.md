# CLAUDE.md

Guidance pour Claude Code (claude.ai/code) sur ce dépôt. **Des règles, pas de la
documentation** : ce fichier est chargé en entier à chaque session, donc ce qu'on
y met est payé par toutes les sessions, y compris celles que ça ne concerne pas.
Les démonstrations vivent dans `docs/lessons.md` et dans les specs ; ici, une
règle tient en trois lignes et pointe vers ce qui la fonde.

## Ce que c'est

`avolo-shorts` transforme les replays Twitch de « LA SCÈNE AVOLO », une émission
d'improvisation théâtrale, en extraits courts pour Instagram, TikTok, YouTube
Shorts et Facebook. Il remplace `~/dev/openshorts`, qui n'est pas mauvais mais
résout un autre problème : suivre un sujet plutôt que cadrer une scène, détecter
des visages plutôt que des corps.

**La conception fait autorité et vit dans
`docs/superpowers/specs/2026-08-17-avolo-shorts-design.md`.** Lis-la avant de
toucher à quoi que ce soit de structurant : elle contient les mesures qui
justifient chaque décision, et plusieurs de ces décisions sont contre-intuitives.

**Une spec est datée, et le code peut l'avoir rattrapée.** Regarde à quel commit
elle a été écrite et ce qui a été fusionné depuis, et quand tu constates l'écart,
corrige la spec dans le même mouvement. Deux cas mesurés dans
[`docs/lessons.md`](docs/lessons.md).

## La langue

**Le code est en anglais, sans exception** : identifiants, fonctions, variables,
types, constantes, noms de fichiers, champs de base, clés JSON, branches git.
**Aucun accent dans un identifiant** — ça casse la complétion, rend un `grep`
dépendant de la normalisation Unicode, et traverse mal les outils qui supposent
l'ASCII.

**Tout le reste est en français** : libellés d'interface, commentaires,
documentation, specs, corps de PR et réponses aux relecteurs.

Trois exceptions qui suivent le code plutôt que la prose. Les **messages de
commit**, titre et corps, parce qu'ils vivent dans le dépôt aux côtés du code.
Et les **titres de PR**, parce qu'une fusion en squash en fait le sujet du commit
qui atterrit sur `main` — le corps de la PR, lui, reste en français.

Une troisième, plus petite mais qui coûte à chaque fois : **le mot-clé qui ferme
une issue**. `Closes #191` referme, « Ferme #191 » ne referme rien — GitHub ne lit
que l'anglais. Le mot est lu par une machine, il suit donc le code et non la
prose qui l'entoure. Constaté sur la PR #192, dont l'issue est restée ouverte
après le merge.

Le dépôt ne respecte pas encore la règle — 333 identifiants accentués dans 72
fichiers. C'est l'**issue #73** ; la règle vaut dès maintenant pour tout code
neuf. Pourquoi le glissement se produit : [`docs/lessons.md`](docs/lessons.md).

## Les commentaires

Le dépôt porte **790 blocs de prose libre d'au moins quatre lignes, dans 179
fichiers** (mesuré le 23 août 2026) ; ses 2283 blocs JSDoc sont, eux, à leur
place. Comme pour l'issue #73, la dette se réduit dans les fonctions qu'on
modifie — sans passe dédiée, sans issue, sans TODO.

## Les décisions à ne pas défaire par réflexe

Chacune a coûté une mesure, et chacune contredit l'approche qui vient
spontanément.

| Décision | Le réflexe qu'elle remplace |
|---|---|
| Le clip est une **liste de segments**, la durée est un résultat | une fenêtre de 15 à 60 s |
| On raccourcit **par le milieu**, jamais par les bouts | tronquer la fin |
| Le **ratio varie par plan** (9:16, 4:5, 1:1, 16:9) | tout sortir en 9:16, ou un ratio unique par clip |
| Le **crop est fixe à l'intérieur d'un plan** | une caméra qui suit le sujet |
| On détecte des **corps**, pas des visages | la détection de visages |
| La surface d'édition est le **transcript** | une timeline multi-pistes |
| La correction renvoie des **substitutions indexées**, pas du texte | demander au modèle de corriger la phrase |

Les mesures sont en section 2 de la spec. En résumé : sur trois émissions, seuls
24 à 33 % du temps tiennent dans un 9:16, mais 48 % tiennent dans un 1:1 ou plus
serré, et ce chiffre est stable sur les trois.

La sixième ligne demande une précision depuis que l'écran de clip porte une bande
de temps : elle monte du temps, le transcript monte des mots, et les deux
coexistent. Le détail est dans [`docs/lessons.md`](docs/lessons.md).

## Trois règles tirées des revues

- **Une valeur notée qu'on compare à un seuil inclusif se tronque vers le bas,
  jamais ne s'arrondit.** Et quand une revue trouve un défaut de forme dans un
  champ, demander « quels autres champs ont cette forme » : le même défaut existe
  presque toujours ailleurs. Le miroir vaut autant : un garde recopié d'un
  champ voisin apporte sa forme, pas la raison qui le rendait juste.
- **Un défaut prudent est juste face à une information absente, faux face à une
  information ambiguë.** Deux hypothèses à une voix chacune ne se départagent pas
  par le défaut : ça rend un faux résultat avec l'aplomb d'un vrai. Rejeter,
  plutôt que trancher au hasard.
- **Changer la recette ffmpeg oblige à monter `VERSION_FINGERPRINT`**
  (`src/server/steps/render.ts`) : aucun champ de l'empreinte ne porte le graphe,
  donc les rendus périmés se disent à jour et l'ordonnanceur les republie.
  **Deux PR qui montent toutes deux cette valeur ne se voient pas** : git les
  fusionne sans conflit, et la seconde n'invalide plus rien. Qui fusionne en
  second relit la valeur sur `main` et la corrige à `main + 1` si elle a bougé.

Les cas qui les ont produites, avec leurs chiffres : [`docs/lessons.md`](docs/lessons.md).

## L'environnement

- **GPU** : RTX 4090, 24 Go, accessible depuis WSL.
- **Sources** : le Google Drive partagé qui porte les replays est **lent** (9p) et
  décroche de deux façons. Copier en local avant de traiter, en gardant le nom de
  fichier d'origine.
- **Ollama** tourne sur l'hôte Windows, port 11434. **L'adresse de la passerelle
  WSL change au redémarrage** : la résoudre par `ip route show default`, jamais la
  coder en dur.
- **VRAM** : un modèle Ollama de 18 Go et WhisperX large-v3 ne tiennent pas
  ensemble sur 24 Go. La correction des sous-titres s'exécute après la
  transcription, jamais en parallèle.
- **Sources vidéo** : 1920x1080, 4,5 à 12,7 Go pièce. La cadence n'est pas
  uniforme — trois émissions en 60 fps, `2025-06-15-cqlp.mp4` en 30. Sans
  conséquence, le filtre `fps=30` traite les deux. Les tournages à venir passeront
  en 30 fps.
- **ffmpeg** : le binaire d'Ubuntu sous WSL n'a **ni `h264_nvenc` ni
  `-hwaccel cuda`** ; il faut le build statique installé par `setup.sh`. NVENC est
  plus lent que le CPU sur le proxy et lui gagne un facteur 2,3 sur l'export
  (4,58x contre 1,97x en `-preset p5`). Ne jamais combiner `-pix_fmt yuv420p` et
  `-hwaccel_output_format cuda` : l'encodage échoue sans message exploitable.
  Méfiance envers les chiffres mesurés avec le ffmpeg **Windows**, qui ne passe
  pas par la passerelle CUDA de WSL et flatte l'export d'environ 25 %.
- **Diarisation** : celui de `~/dev/rythmo-impro/diarizer` (WhisperX large-v3 +
  pyannote) existe et fonctionne. Il tourne **en venv, pas en Docker** : son
  `run-wsl.sh` exporte `LD_LIBRARY_PATH` vers le `nvidia/cudnn/lib` du venv,
  correctif indispensable à CTranslate2. Le `CLAUDE.md` de ce dépôt-là porte
  encore une ligne périmée affirmant l'inverse.
- **Les mesures d'ici valent peu prises une fois** : 40 à 80 % de variance, ni
  thermique ni réglable. Trois passes, la médiane, `/proc/loadavg` relevé à côté
  du chiffre, et **un écart inférieur à ~10 % n'est pas établi**. Le pourquoi, et
  le throttling thermique cherché puis écarté : [`docs/lessons.md`](docs/lessons.md).
- **Pas de Docker ici.** Node natif, Python en venv, ffmpeg natif.

## Livraison

L'itération 0 fait marcher la chaîne de bout en bout, interface comprise, avec un
cadrage réglé à la main. Le cadrage automatique, la qualité du repérage, la
correction des sous-titres et l'automatisation suivent dans cet ordre. Le détail
est en section 4 de la spec.

Ne pas anticiper une itération ultérieure au prétexte que « c'est presque le même
code ».

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
   besoin les lira au bon moment.
3. **Ce serait perdu autrement.** Rien dans le plan de l'itération en cours ne le
   fera remonter au moment utile.

Deux règles de portée : **dans l'itération en cours, le tracker est le plan**, et
**un agent ne crée pas d'issue de sa propre initiative** — il le signale dans son
rapport final, et celui qui orchestre tranche. Une exception : au triage d'une
revue, une trouvaille réelle mais hors du périmètre de la PR se dépose en issue
avec les labels du dépôt, et son numéro est consigné dans la réponse au relecteur.

## Agent skills

Configuration lue par les skills d'ingénierie. Quatre fichiers, une règle chacun.

### Issue tracker

Les issues vivent dans les GitHub Issues du dépôt, pilotées par `gh`. Voir
[`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

### Triage labels

Les cinq rôles canoniques, chaque libellé égal à son nom. Voir
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

### Review bots

Aristarque ne se déclenche pas au push et poste un commentaire, pas une review ;
`BLOCKED` veut dire conversation non résolue. Voir
[`docs/agents/review-bots.md`](docs/agents/review-bots.md).

### Domain docs

Dépôt à contexte unique : `CONTEXT.md` et `docs/adr/` à la racine, créés
paresseusement. Voir [`docs/agents/domain.md`](docs/agents/domain.md).

### UI loop

Sur un jugement visuel, une image tranche, pas un tableau de chiffres. Voir
[`docs/agents/ui-loop.md`](docs/agents/ui-loop.md).
