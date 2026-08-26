# avolo-shorts

Découpe les replays Twitch de « LA SCÈNE AVOLO », une émission d'improvisation
théâtrale, en extraits courts pour Instagram, TikTok, YouTube Shorts et Facebook.

Un clip y est une **liste de segments** — on raccourcit une vanne trop longue en
retirant son milieu, pas en tronquant sa chute — et son ratio est choisi clip par
clip. Sur trois émissions mesurées, seuls 24 à 33 % du temps tiennent dans un
9:16, contre 48 % jusqu'au 1:1.

## Fonctionnement

1. Transcription du replay (WhisperX).
2. Repérage des moments viraux dans le transcript (Gemini).
3. Génération des clips par segments, avec un ratio et un crop choisis plan par
   plan — détection de **personnes** (YOLO, pas de visages), split vertical
   automatique quand plusieurs personnes ne tiennent pas dans un même cadre.
4. Hook, description et hashtags générés par Gemini.
5. Export ffmpeg/NVENC, puis publication sur Instagram, TikTok, Facebook et
   YouTube Shorts.

Stack : Next.js/TypeScript/React pour l'app, Python + YOLO (Ultralytics) pour
la détection, WhisperX pour la transcription, Gemini pour l'écriture, ffmpeg +
NVENC pour l'export, SQLite pour le stockage.

## Ce qui fait autorité

- `docs/superpowers/specs/2026-08-17-avolo-shorts-design.md` — la conception, les
  mesures qui la fondent, et les décisions contre-intuitives qu'elles imposent.
- `docs/superpowers/plans/2026-08-18-iteration-0.md` — le plan de l'itération 0.
- `CLAUDE.md` — le résumé opérationnel pour qui arrive sur le dépôt.

## Architecture

Un seul app Next.js. `src/core/` est du TypeScript **pur** : ni disque, ni
processus, ni réseau, ni Next. C'est là que vit toute la logique de décision, et
c'est ce qui rend le CI utile sans GPU, sans ffmpeg et sans vidéo.

La frontière n'est pas une intention, c'est une règle ESLint en `error` : depuis
`src/core/`, seuls `./` (le dossier courant et ce qui est dessous), `@/core/` et
`zod` sont importables. Le reste — modules natifs, Next, React, SDK, stockage —
fait échouer le lint, et les globaux qui contournent l'import (`fetch`,
`process`, `globalThis`) aussi. Pas de `../` non plus : un fichier de
`src/core/captions/` atteint `edl.ts` par `@/core/edl`.
`tests/core/purete.test.ts` vérifie la règle elle-même, contrôles négatifs
compris.

`src/server/` porte l'impur : fichiers, SQLite, ffmpeg, WhisperX.

## Configurer

`cp .env.example .env`, puis ajuster. Une valeur qui commence par `op://` est
l'**adresse** d'un secret dans 1Password, résolue une fois au démarrage par
`op read` ; une valeur littérale marche tout aussi bien et n'appelle rien.
`docs/environnement.md` liste les variables et ce qui se passe quand la lecture
rate.

## Vérifier

```bash
pnpm install
pnpm lint && pnpm type-check && pnpm test
```

## Licence

Aucune pour l'instant. Le dépôt est public pour être lisible, pas pour être
réutilisé tel quel : il suppose une RTX 4090, un ffmpeg compilé avec NVENC et un
dossier de replays qui n'est pas le vôtre.
