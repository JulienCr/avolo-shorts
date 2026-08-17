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
- **Sources vidéo** : 1920x1080, 60 fps aujourd'hui, 4,5 à 12,7 Go pièce. Les
  tournages à venir passeront en 30 fps.
- Le diariseur de `~/dev/rythmo-impro/diarizer` (WhisperX large-v3 + pyannote)
  existe déjà et fonctionne.

## Livraison

L'itération 0 fait marcher la chaîne de bout en bout, interface comprise, avec un
cadrage réglé à la main. Le cadrage automatique, la qualité du repérage, la
correction des sous-titres et l'automatisation suivent dans cet ordre. Le détail
est en section 4 de la spec.

Ne pas anticiper une itération ultérieure au prétexte que « c'est presque le
même code ».
