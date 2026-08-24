# Publication vers les réseaux : conception

Date : 18 août 2026.
Statut : proposition, issue d'un spike. **Mise à jour au 19 août 2026** : la PR
#95 a écrit `src/core/publication.ts` et la modale de publication — l'UI seule,
sans connecteur ni backend, périmètre tranché par Julien.

**Mise à jour au 23 août 2026, la plus importante depuis l'écriture de ce
document** : Julien s'est abonné à Upload Post (offre gratuite — voir §2.5, la
Basic évoquée plus bas n'est pas celle qui tourne). Ce n'est plus le repli du
§5 en cas d'échec de l'audit TikTok, c'est le transport qui existait alors pour
les quatre plateformes à la fois, écrit dans cette PR-ci — **mise à jour au
24 août 2026 : ça ne dure pas.** Meta (issue #146) puis TikTok (§2.3) sont
passés en direct depuis ; Upload Post ne garde que YouTube. §2.4, §3, §5 et
§6.2 sont corrigés en conséquence. Le lot 0 (démarches Meta/TikTok/YouTube) et
les audits restent la voie qui affranchirait un connecteur direct un jour,
mais rien n'en dépend plus pour publier.

Ce document décide de **la publication depuis l'outil**, que la conception
générale rangeait jusqu'ici hors périmètre
(`docs/superpowers/specs/2026-08-17-avolo-shorts-design.md`, §3 : « l'outil
produit des fichiers MP4 et les textes, Julien publie avec ses outils »). Cette
phrase est corrigée dans le même mouvement, comme `CLAUDE.md` le demande : deux
sources qui se contredisent sur la même question finissent par diverger.

Il ne décide ni du pipeline, ni du rendu, ni du cadrage. Il s'appuie sur une
vérification aux sources primaires de Meta, Google et TikTok, faite le 18 août
2026 — les blogs tiers consultés au passage se contredisaient précisément sur le
point qui décide de tout, et deux d'entre eux avaient tort.

## 1. La réponse, en trois phrases

**Instagram et Facebook sont gratuits, complets et sans aucune démarche** : une
app Meta en mode développement publie réellement et publiquement sur les comptes
qui ont un rôle sur elle.

**YouTube est la plateforme la plus dure, pas TikTok** : sans audit du projet API,
une vidéo envoyée par l'API est verrouillée en privé et ne peut plus être libérée,
même à la main.

**Ce qu'on achèterait à Upload Post n'est pas du code, c'est leur app TikTok
auditée** — soit le seul verrou que l'argent lève et que le travail ne lève pas.

## 2. Ce qui a été vérifié

### 2.1 Instagram Reels — aucun verrou

| | |
|---|---|
| Chemin | `POST /{ig-user-id}/media` en `media_type=REELS`, attente de `status_code = FINISHED`, puis `POST /{ig-user-id}/media_publish` |
| Permissions | `instagram_business_basic` + `instagram_business_content_publish` (Instagram Login), ou `instagram_basic` + `instagram_content_publish` + `pages_read_engagement` (Facebook Login) |
| Niveau d'accès | **Standard Access**, accordé d'office |
| Fichier | **Facebook Login** : `upload_type=resumable` vers `rupload.facebook.com`. **Instagram Login** : URL publique uniquement — voir ci-dessous |
| Débit | 100 publications par API sur 24 h glissantes |

Le fait qui compte est le niveau d'accès. Meta accorde le Standard Access à toute
app dès sa création, sans App Review et sans vérification d'entreprise, et ce
niveau « can only be requested from users who have a role on the application from
which the request originates ». Julien s'ajoute comme *Instagram Tester* sur son
propre compte professionnel, accepte l'invitation depuis les réglages Instagram,
et l'app publie. **Ce n'est ni un bac à sable ni un compte de test** : les
publications sont réelles, publiques, et c'est le chemin officiel pour publier
chez soi. L'App Review ne devient obligatoire que le jour où des tiers
connecteraient leurs propres comptes — ce que le §3 de la conception générale
exclut déjà (« le multi-utilisateur, la facturation, tout ce qui relève d'un
SaaS »).

Les permissions `instagram_basic` et `instagram_content_publish` ont été dépréciées
le 27 janvier 2025 au profit des `instagram_business_*` — **mais uniquement du côté
Instagram Login**. Sur le chemin Facebook Login, qui est celui retenu ici, ce sont
bien `instagram_basic` et `instagram_content_publish` qu'il faut demander, comme
le tableau ci-dessus les nomme. Les deux jeux portent des noms voisins et ne sont
pas interchangeables : c'est la confusion la plus facile à commettre sur ce sujet.

**Mesuré le 23 août 2026, et ça décide de l'appairage.** Meta expose deux
configurations dans la même app, et celle qu'il met en avant est la mauvaise ici.
La **connexion Instagram** (jeton `IGA…`, `graph.instagram.com`) n'accepte
**que** `video_url`, une URL publique — testé en v21, v22 et v23. Elle contredit
donc frontalement la décision du §3, « on téléverse depuis le disque, jamais par
URL publique », et n'est pas utilisable. C'est la **connexion Facebook** (jeton
`EAA…`, `graph.facebook.com`) qui porte `upload_type=resumable`, donc le
téléversement local. Le parcours *Instagram Tester* décrit au paragraphe
précédent reste vrai du niveau d'accès, mais il appaire par le mauvais chemin.

Deux questions que ce document laissait ouvertes sont tranchées par la même
mesure : un compte de type **Créateur** (`MEDIA_CREATOR`) publie des reels sans
réserve, et `media_publish` exige un **droit sur l'actif** dans le portefeuille
business — la portée `business_management` suffit à lire le compte, à créer le
conteneur et à téléverser, mais pas à publier. Sans ce droit, Meta rend un
`error_subcode: 2207085` libellé « erreur de serveur interne », qui invite à
réessayer alors qu'il faut affecter une personne au compte.

La démonstration, avec les deux reels publiés et le test qui a discriminé les
hypothèses : [`docs/lessons.md`](../../lessons.md), « Ce que Meta ne dit pas
quand on publie un reel ».

**Le connecteur existe** (issue #146) — `src/server/publication/meta.ts`,
qui publie Instagram sans passer par Upload Post, sur le chemin Facebook Login
mesuré ci-dessus.

### 2.2 Facebook Page Reels — aucun verrou

| | |
|---|---|
| Chemin | `POST /{page-id}/video_reels` en trois phases : `start`, téléversement, `finish` |
| Téléversement | binaire direct en `application/octet-stream` vers `rupload.facebook.com/video-upload/{video-id}`, ou `file_url` hébergée |
| Permissions | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, jeton de Page portant `CREATE_CONTENT` |
| Débit | 30 publications par API sur 24 h glissantes |
| Publication | `video_state` vaut `PUBLISHED`, `DRAFT` ou `SCHEDULED` |

Même raisonnement d'accès que pour Instagram, et la même app Meta porte les deux.
Le `SCHEDULED` est noté ici parce qu'il rendra l'ordonnanceur (§4, hors périmètre —
à ne pas confondre avec le lot 2 de §5) gratuit sur Facebook — et sur lui seul.

**Publié pour de vrai le 23 août 2026** (issue #146) : un reel réel est allé
sur la Page (`video_id` `1078358324628287`), et `GET /{video-id}?fields=
permalink_url` a rendu `"/reel/1078358324628287/"` — un chemin relatif, que
le connecteur préfixe désormais avec `https://www.facebook.com`.

### 2.3 TikTok — un verrou, et un chemin qui le contourne

| | |
|---|---|
| Publication directe | `video.publish`, contenu **forcé en `SELF_ONLY` tant que l'app n'est pas auditée** |
| Dépôt en brouillon | `video.upload`, `POST /v2/post/publish/inbox/video/init/` |
| Téléversement | `FILE_UPLOAD` chunké (5-64 Mo par morceau **déclaré** à `init` ; le dernier morceau réellement envoyé peut dépasser cette borne haute, jusqu'à un peu moins du double, plutôt que produire un reste sous 5 Mo) ou `PULL_FROM_URL` depuis un domaine vérifié |
| Débit non audité | 5 utilisateurs publiants sur 24 h |
| Durée | 10 minutes maximum par les points d'entrée de téléversement |

« All content posted by unaudited clients will be restricted to private viewing
mode » : la publication directe est donc inutilisable avant l'audit. **Mais la
restriction porte sur ce que l'API poste**, et le dépôt en brouillon ne poste
rien : il dépose dans la boîte de réception, l'utilisateur ouvre la notification
et publie lui-même depuis l'app, en choisissant sa visibilité comme pour
n'importe quelle vidéo. Ce chemin-là fonctionne aujourd'hui.

Il a deux coûts. Le premier est un geste manuel par clip et par publication. Le
second est une **péremption** : plusieurs sources tierces concordantes donnent 24 h
avant que le brouillon soit jeté, aucune source primaire consultée ne la confirme.
À mesurer au branchement plutôt qu'à recopier.

**Corrigé le 24 août 2026, mesuré contre l'app de Julien plutôt que déduit de
la documentation.** Les deux paragraphes qui suivaient ici affirmaient que
l'URL de retour devait porter un domaine vérifié et ne mentionnaient pas PKCE ;
les deux sont faux pour cette app.

**La boucle locale est acceptée, à une forme exacte près.** `http://localhost:4005/tiktok/oauth-callback` (sans slash final, `localhost`
et non `127.0.0.1`) est enregistrée et l'autorisation sert son écran de
connexion pour cette URL — sans page statique à héberger ni domaine à
vérifier. TikTok compare en chaîne stricte : `127.0.0.1` ou un slash final
font échouer l'échange, rapporté comme une erreur `client_key` plutôt que
`redirect_uri` (les deux formes essayées en pairage réel le 24 août 2026).
Rien ne dit que ce soit vrai de toute app TikTok ; ça l'est de celle-ci,
mesuré plutôt que supposé.

**PKCE est obligatoire, et aucune source consultée avant le branchement ne le
disait.** Sans `code_challenge` et `code_challenge_method=S256`, l'autorisation
rend `error=param_error&errCode=10007&error_type=code_challenge` ; avec eux,
elle sert l'écran de connexion. `src/server/publication/tiktok-pkce.ts` porte
le calcul.

### 2.4 YouTube Shorts — un verrou sans échappatoire

| | |
|---|---|
| Chemin | `videos.insert`, téléversement resumable d'un fichier local |
| Portées | `youtube.upload` suffit |
| Quota | **1 unité dans un panier dédié « Video Uploads », plafonné à 100 envois par jour** |
| Verrou | projet API non audité créé après le 28 juillet 2020 → vidéo **verrouillée en privé** |

Deux choses à retenir, et elles vont en sens inverse de l'intuition.

**Le quota n'a jamais été le sujet, et le chiffre qu'on croit connaître est
périmé.** `videos.insert` ne coûte plus 1600 unités sur les 10 000 de la journée —
c'est-à-dire six envois quotidiens, chiffre encore recopié partout. Depuis fin
2025 c'est une unité dans un panier séparé, plafonné à cent envois par jour. Le
quota n'a donc aucune influence sur la conception.

**Le verrou, lui, est absolu — mais c'est un verrou du *projet API appelant*,
pas de YouTube lui-même.** Google écrit : « You will not be able to change the
video's state until after you have successfully submitted the video for
verification. » On ne peut pas relever la visibilité à la main dans Studio. Les
deux seuls remèdes sont de re-téléverser la vidéo par le site, ou de faire auditer
le projet API. **Conséquence directe pour un connecteur écrit par ce dépôt et
appelant l'API en son nom propre : le coder avant que l'audit soit passé, c'est
coder une destruction de travail** — il produirait une vidéo morte et imposerait
un ré-envoi manuel, soit exactement le geste qu'il prétend supprimer, plus une
vidéo privée à nettoyer.

**Mise à jour au 23 août 2026 : ce paragraphe ne s'applique plus tel quel,
parce qu'Upload Post n'est pas un connecteur écrit par ce dépôt.** Le projet
API qui appelle `videos.insert` est le leur, déjà audité pour leur propre
compte — pas un projet créé ici. Leur API expose `privacyStatus:
public|unlisted|private`, ce qu'un projet non audité ne peut pas offrir : c'est
la raison d'y croire, et c'est écrite en toutes lettres dans le docbloc
d'`upload-post.ts`.

**Mesuré le 23 août 2026 : le verrou ne s'applique pas par ce chemin.** Un
envoi réel, sur le compte de Julien, `POST /api/upload` avec
`platform[]=youtube` et **`privacyStatus=unlisted`** — délibérément pas
`public`, et c'est le point qui rend la mesure concluante sans rien mettre en
ligne. Le verrou d'un projet non audité force `private` **quel que soit ce qui
est demandé** : si le verrou s'appliquait ici, `unlisted` serait retombé en
`private` tout comme `public` l'aurait fait. Observer `unlisted` en retour
prouve donc l'absence du verrou aussi sûrement que l'aurait prouvée `public`,
sans exposer la vidéo sur la chaîne le temps de vérifier. Résultat :

```
{"success":true,"results":{"youtube":{"success":true,"post_id":"<expurgé — lien-capacité>",
"url":"https://www.youtube.com/watch?v=<expurgé>","status":"completed"}}}
```

La page de la vidéo (identifiant expurgé — le connaître suffit à la voir, une
vidéo `unlisted` n'a pas d'autre protection) rend `"isPrivate":false` et
`"isUnlisted":true` — la visibilité demandée a été honorée telle quelle plutôt
que rabattue en privé — et l'oEmbed de YouTube la résout (200, auteur « La
Scène Avolo »), preuve indépendante que la vidéo existe côté plateforme et
n'est pas un artefact de l'API d'Upload Post. **Le verrou est une propriété du
projet API appelant, pas de YouTube, et le projet qui appelle par ce chemin
n'en porte pas.** Un connecteur YouTube **direct**, lui, reste soumis à tout ce
paragraphe sans changement : son verrou à lui ne se lève que par son propre
audit.

Un troisième piège, indépendant du premier : l'écran de consentement OAuth laissé
en « Testing » fait **expirer le jeton de rafraîchissement au bout de sept jours**.
Le passer en production le rend durable. L'app n'étant pas vérifiée, un écran
d'avertissement s'affichera à l'appairage — sans conséquence pour un compte qu'on
possède, et l'appairage est annuel.

### 2.5 Upload Post — ce qu'on y achèterait

| Offre | Prix | Envois | Profils | TikTok |
|---|---|---|---|---|
| Gratuite | 0 | 10 par mois | 2 | **non** |
| Basic | 24 $/mois (16 $ à l'année) | illimités | 5 | oui |

**Confirmé le 23 août 2026, depuis l'API elle-même et non la seule page de
tarifs** : l'envoi mesuré au §2.4 est reparti avec `"usage":{"count":1,
"limit":10}` — le plafond de dix par mois de l'offre gratuite, réellement
active sur le compte de Julien, et non celui de la Basic.

L'offre gratuite couvre Instagram, YouTube, Facebook et sept autres réseaux —
c'est-à-dire tout ce qu'on sait déjà faire soi-même — et exclut le seul cas
difficile. **Le service ne vend donc pas de la mécanique de téléversement, il vend
une app TikTok auditée.** C'est un produit honnête et c'est exactement ce qu'il
faut acheter le jour où l'on n'obtient pas la sienne, et rien d'autre.

Les concurrents auto-hébergeables (Postiz, Mixpost) ne changent rien à l'affaire :
ils publient par les mêmes API officielles avec **vos** identifiants d'app, donc
avec vos audits. Ce qui s'auto-héberge, c'est l'ordonnanceur, jamais le verrou.

## 3. Les décisions à ne pas défaire

Sur le modèle de `CLAUDE.md`, chacune contredit ce qui vient spontanément.

| Décision | Le réflexe qu'elle remplace |
|---|---|
| **Le connecteur YouTube n'existe pas avant l'audit** | le brancher « pour être prêt », en acceptant le privé |
| Meta se branche **sans rien demander à personne** | déposer une App Review par prudence |
| TikTok se branche **en brouillon** d'abord | attendre l'audit pour commencer |
| On téléverse **depuis le disque**, jamais par URL publique | exposer la machine ou héberger les rendus |
| `déposé` n'est pas `publié` | un seul état « fait » par plateforme |
| Une publication par plateforme, **échec isolé** | une transaction tout-ou-rien sur les quatre |
| Le type s'appelle `Platform`, en anglais | `Plateforme`, ou `Cible` déjà pris par `CibleLançable` dans `run.ts` |
| Upload Post ne porte plus que YouTube ; Meta prend Instagram et Facebook en direct (issue #146), TikTok prend son propre connecteur direct (§2.3, 24 août 2026) | attendre l'échec de l'audit TikTok pour l'écrire, ou coder un accès direct « pendant qu'on y est » |

## 4. Périmètre

Dans le périmètre :

- publier un clip **déjà exporté** vers Instagram, Facebook, TikTok et YouTube ;
- un bouton par clip, avec les plateformes en cases à cocher, toutes cochées par
  défaut ;
- l'état de chaque publication, son identifiant distant et son lien ;
- l'appairage OAuth, par script.

Hors périmètre, et nommément :

- **l'ordonnancement** : horaires de parution, file, réessai automatique d'une
  publication échouée. C'est un chantier séparé du séquencement de §5 — à ne pas
  confondre avec son lot 2 —, et `video_state: SCHEDULED` de Facebook
  l'attendra là-bas. À ne pas confondre avec la **reprise de transport** — rejouer
  un téléversement qui a rendu une erreur transitoire, à l'intérieur d'une même
  tentative : celle-là est dans le périmètre, elle appartient au connecteur, et
  `rupload.facebook.com` la rend nécessaire (voir `docs/lessons.md`) ;
- **le multi-comptes** : un compte par plateforme, ceux d'Avolo ;
- **les statistiques de performance** des publications ;
- **la publication en tant que tiers**, qui ferait basculer Meta en Advanced
  Access et le projet en SaaS ;
- **les réseaux non nommés** (X, LinkedIn, Threads, Pinterest). Le `.txt` continue
  de les servir.

## 5. Le séquencement, qui est la vraie décision

**Mise à jour au 23 août 2026 : le lot 1 est fait — le seul de ce séquencement à
l'être.** Upload Post plafonne Instagram à dix envois par mois sur l'offre
gratuite (§2.5), ce qu'une émission dépasse en un jour ; Meta direct est gratuit
et autorise 100 publications par 24 h (issue #146). `src/server/publication/
meta.ts` porte donc Instagram et Facebook sans passer par Upload Post, sans
qu'aucune démarche du lot 0 n'ait été nécessaire — Meta n'exige ni App Review ni
audit (§1). **Mise à jour au 24 août 2026 : le lot 2 est fait aussi.**
`src/server/publication/tiktok.ts` dépose en brouillon via l'app développeur
propre de Julien, sans passer par Upload Post ni par l'audit — voir §2.3 et le
lot 2 ci-dessous. Seul YouTube reste chez Upload Post, lot 3 non démarré : ce
séquencement continue de décrire la voie qui l'en affranchirait un jour, mais
rien n'en dépend pour publier maintenant.

Les audits durent de deux à six semaines et peuvent échouer. Le travail se range
donc par ce qui n'attend rien, et non par ce qui semble le plus important.

**Lot 0 — les démarches. Aucun code, et rien ne commence sans.**

1. Créer l'app Meta (type Entreprise), y ajouter le compte Instagram
   professionnel au portefeuille business, **lui affecter une personne en accès
   total** (sans quoi `media_publish` échoue en `2207085`, §2.1), et configurer
   l'app en **« API avec connexion Facebook »** — pas en connexion Instagram, qui
   ne sait pas téléverser depuis le disque. Rattacher la Page Facebook.
2. Publier sur `avolo.fr` deux pages statiques : la politique de confidentialité
   et la page de retour OAuth. Meta et TikTok exigent la première.
3. Créer l'app TikTok, y ajouter le produit *Content Posting API*, demander la
   portée `video.upload` (`video.publish` reste réservée à l'audit, §2.3),
   déclarer l'URL de retour — **corrigé le 24 août 2026** : une boucle locale
   suffit, pas de domaine à vérifier ni de page à héberger (§2.3).
4. Créer le projet Google, activer *YouTube Data API v3*, **passer l'écran de
   consentement en production** (sans quoi le jeton meurt tous les sept jours).
5. Déposer les deux audits : le formulaire *YouTube API Services — Audit and
   Quota Extension*, et l'audit TikTok.

**Lot 1 — Instagram et Facebook, de bout en bout. Partiellement fait (issue
#146).** Aucun verrou : c'est ce qui se mesurait tout de suite, et c'est ce
qui a validé l'architecture pendant que les audits dorment. **Instagram** a
publié un reel réel le 23 août 2026. **Facebook Page Reels est codé mais
jamais exercé contre le réseau réel**, faute de `pages_manage_posts` sur le
jeton de Page — à ne pas lire comme validé tant que ce droit manque.

**Lot 2 — TikTok en brouillon. Fait.** Fonctionne sans audit. Le jour où l'audit
passe, c'est l'implémentation qui change, pas l'interface ni la table.

**Lot 3 — YouTube, et seulement l'audit passé.** Voir §2.4.

**Upload Post n'est plus un repli qui attend l'échec de l'audit TikTok — voir la
mise à jour en tête de section.** Le paragraphe qui suivait ici décrivait
l'abonnement Basic (24 $/mois) comme la condition de son code ; l'offre
réellement active au 23 août 2026 est la **gratuite** (§2.5) — dix
téléversements par mois, un seul profil connecté (YouTube). Le connecteur
existe donc déjà, sous ce plafond, et non sous celui de la Basic.

## 6. La conception

Le dépôt sépare le cœur pur (`src/core/`) des étapes serveur (`src/server/`). La
publication suit la même ligne : tout ce qui se décide sans réseau se décide dans
`core`.

### 6.1 `src/core/publication/`

- **`Platform = 'instagram' | 'facebook' | 'youtube' | 'tiktok'`, en anglais et
  sans accent — pas `Plateforme`.** Cette conception nommait le type en
  français ; elle a été écrite avant que `CLAUDE.md` n'énonce la règle de
  langue pour le code, et `src/core/publication.ts` (PR #95, interface seule)
  la suit plutôt que ce paragraphe. Pas `Cible` non plus : `src/server/run.ts`
  nomme déjà `CibleLançable` les étapes du pipeline, et deux « cibles » de sens
  différent dans le même dépôt se confondent à la première relecture.
- **Quel fichier part où.** La conception générale l'a tranché en §11 — le natif
  (4:5, 1:1) pour le feed Instagram et Facebook, la variante 9:16 sur fond flouté
  pour TikTok et Shorts —, mais §11 note aussi que le natif ne se produit plus
  par défaut depuis le 23 août 2026 (`RENDER_NATIVE`, `src/core/render-flags.ts`) :
  personne ne le récupérait en pratique. Cette fonction reste utile pour le jour
  où le flag repasse à `true`, ou pour un clip déjà en 9:16, dont le natif est
  l'unique livrable. C'est une fonction pure du clip et de ses sorties, et c'est
  le premier endroit où ce choix cesse d'être une phrase.
- **Les textes par plateforme.** YouTube veut un titre (100 caractères) et une
  description séparés ; Instagram, Facebook et TikTok veulent une légende unique.
  `motsDièse` et `texteDePublication` vivent aujourd'hui dans
  `src/server/steps/render.ts` alors qu'elles sont pures : elles descendent ici,
  et l'étape de rendu les importe.
- **L'éligibilité.** Durée, taille, ratio. Un clip de plus de trois minutes n'est
  pas un Short, et la conception générale relève des candidats à 167 secondes : le
  cas est proche, il doit être refusé avec sa raison plutôt que découvert dans un
  message d'erreur de la plateforme.

### 6.2 `src/server/publication/`

**Mise à jour au 23 août 2026 : ce paragraphe décrivait un adaptateur par
plateforme (`meta.ts`, `tiktok.ts`) ; ce qui a existé un temps est un seul
connecteur pour les quatre, `upload-post.ts`, derrière l'interface
ci-dessous — écrite `src/server/publication/adapter.ts`, déclaration
canonique dont hérite tout connecteur. Depuis l'issue #146, `meta.ts` prend
Instagram et Facebook en direct ; `tiktok.ts` prend TikTok en direct depuis le
24 août 2026 (§2.3) ; Upload Post ne garde plus que YouTube (§2.2).**

```ts
export type PublicationJob = {
  clipId: string
  videoPath: string   // chemin absolu sur le disque — jamais une URL (§3)
  title: string
  description: string
  fingerprint: string
}

export type PlatformOutcome =
  | { status: 'in_progress'; requestId: string }
  | { status: 'submitted';  remoteId: string | null; remoteUrl: string | null }
  | { status: 'published';  remoteId: string | null; remoteUrl: string | null }
  | { status: 'failed';     error: string }

export type PublicationAdapter = {
  readonly platforms: readonly Platform[]
  availability(env: Environment): Promise<Record<Platform, PlatformAvailability>>
  publish(job: PublicationJob, platforms: readonly Platform[]):
    Promise<Record<Platform, PlatformOutcome>>
  poll(requestId: string, platforms: readonly Platform[]):
    Promise<Record<Platform, PlatformOutcome>>
}
```

Deux points qui ne vont pas de soi.

**`publish` prend un *ensemble* de plateformes, jamais une seule.** Une requête
Upload Post porte `platform[]=…` en répétition et un seul fichier vidéo : un
appel par plateforme paierait le téléversement autant de fois qu'il y a de
plateformes visées. Le retour reste **par** plateforme (`Record<Platform,
PlatformOutcome>`), ce qui satisfait §6.4 à la lettre : un échec Instagram
n'annule ni ne rejoue une réussite TikTok.

**`availability` est mesurée, pas déduite des variables d'environnement, et
c'est asynchrone pour cette raison.** Une clé Upload Post valide ne dit rien
des comptes réellement connectés au profil qu'elle sert — l'exemple qui a
motivé cette correction est réel : le compte de Julien n'a relié que YouTube,
et rapporter Instagram comme disponible aurait été le même mensonge que celui
que `defaultPlatformAvailability` (`src/core/publication.ts`) existe déjà pour
éviter. `upload-post.ts` interroge `GET /api/uploadposts/users` et met le
résultat en cache une minute, dans la forme du cache sidecar de `run.ts`
(`sidecars`) plutôt que par un import — ce fichier de `run.ts` est tenu par une
autre PR au moment où ceci s'écrit.

### 6.3 L'état : une table, pas un ordonnanceur

L'export est synchrone parce qu'il dure de dix à soixante secondes et ne dépend
que de la machine. Un téléversement dépend du réseau, et Instagram impose en plus
d'interroger l'état du conteneur jusqu'à `FINISHED`. Tenir une requête HTTP
ouverte aussi longtemps est fragile.

Une table `publications`, clé `(clipId, plateforme)`, portant l'état, l'identifiant
distant, l'URL publique, l'erreur et l'horodatage. `src/server/db.ts` sait déjà
migrer sans table de versions, en interrogeant `PRAGMA table_info`. La route lance
et rend aussitôt ; l'interface interroge.

C'est un état, pas un ordonnanceur : ni horaires, ni file, ni réessai automatique.

Quatre valeurs, et la troisième est celle qui compte. Nommées en anglais dans
le code (`PublicationStatus`, `src/core/publication.ts`, PR #95) — la règle de
langue du dépôt vaut pour l'identifiant, pas pour la colonne « Ce qu'il veut
dire » ci-dessous, qui reste en français comme le reste de cette conception :

| État (code) | Libellé affiché | Ce qu'il veut dire |
|---|---|---|
| `in_progress` | en cours | le téléversement tourne |
| `submitted` | déposé | **c'est chez la plateforme, ce n'est pas en ligne** — un brouillon TikTok attend un geste dans l'app |
| `published` | publié | en ligne, avec son URL |
| `failed` | échec | avec le message de la plateforme, conservé |

Afficher « publié » sur un dépôt mentirait sur ce qui est en ligne, et c'est le
genre de mensonge qu'on ne découvre qu'en cherchant la vidéo.

### 6.4 L'API

`POST /api/clips/:id/publish`, prenant la liste des plateformes et un `force`
optionnel. La réponse est immédiate et rend l'état des lignes créées.

**Chaque plateforme réussit ou échoue seule.** Un échec TikTok ne doit ni annuler
ni rejouer une publication Instagram réussie — republier est irréversible, et
c'est ce qui interdit la transaction unique qui viendrait naturellement.

### 6.5 L'interface

**Mise à jour au 19 août 2026, PR #95** : ce paragraphe décrivait les cases et la
ligne par plateforme posées directement dans le panneau d'export. La PR a choisi
une modale partagée (`PublishDialog`) à la place — même primitive pour un clip
seul et pour la sélection en masse de la vue Émission, qui n'a pas de panneau
d'export où poser des cases. Le panneau d'export (parcours utilisateur, §3.4)
gagne un bouton « Publier », à côté d'« Exporter », qui ouvre cette modale ; il
reste un panneau, pas un écran, pour la même raison que l'export. Voir
`docs/superpowers/specs/2026-08-18-parcours-utilisateur-design.md` §3.0 et §6.1
pour le parcours de la modale.

Trois garde-fous :

- **la publication est irréversible et publique.** Le parcours réserve déjà le
  `dialog` de confirmation au repérage forcé et au ré-export ; publier en est le
  troisième usage, et le plus justifié des trois ;
- **republier une plateforme déjà `publié` se refuse** sans un `force` explicite,
  faute de quoi un double-clic met deux reels identiques en ligne ;
- **le bouton est désactivé tant que le clip n'est pas `exported`**, avec sa
  raison, comme l'export l'est tant qu'un enregistrement est en attente.

Le `.txt` reste, et ne devient pas un vestige : il sert les réseaux qu'on ne
branche pas, et le rattrapage à la main quand une plateforme refuse.

## 7. Les jetons

Le `.env` porte l'**adresse** d'un secret, jamais sa valeur — c'est ce que
`src/server/secrets.ts` fait déjà pour la clé Gemini. Avec une nuance que ce
module n'a pas rencontrée : un jeton OAuth se rafraîchit, et 1Password est ici
en lecture seule.

Le partage se fait donc ainsi : **1Password garde ce qui ne tourne pas** — les
identifiants d'app, les secrets clients, le jeton de Page Facebook qui n'expire
pas — et **un fichier hors dépôt garde ce qui tourne**, sous `projects/`, que
`.gitignore` couvre déjà.

| | Durée | Ce qu'il faut en faire |
|---|---|---|
| Facebook | jeton de Page dérivé d'un jeton utilisateur longue durée : n'expire pas | le lire, rien d'autre |
| Instagram | 60 jours, rafraîchissable | rafraîchir au démarrage |
| Google | illimité si l'écran est en production, 7 jours sinon | voir lot 0, point 4 |
| TikTok | accès 24 h, rafraîchissement 365 jours | persister ce que chaque rafraîchissement rend, sans supposer qu'il est stable |

**L'appairage est un script, pas un écran** — `scripts/dev-connect-<plateforme>.ts`,
au motif des quatre `scripts/dev-*.ts` existants. Un flux OAuth se rejoue une fois
par an ; un écran de réglages coûterait plus cher que ce qu'il éviterait.

## 8. Les échecs, et ce qu'ils doivent dire

Un échec de publication est presque toujours l'un de ces cinq-là, et les
confondre coûte une heure à chaque fois :

1. **le jeton a expiré** — rejouer le script d'appairage ;
2. **le débit est atteint** — 100 chez Instagram, 30 chez Facebook, 5 utilisateurs
   chez TikTok non audité, 100 envois chez YouTube pour un accès direct.
   **En passant par Upload Post (23 août 2026), c'est un autre plafond qui
   frappe en premier : dix téléversements par mois, tous comptes confondus,
   sur l'offre gratuite réellement active.** Attendre, pas réessayer, dans les
   deux cas ;
3. **le fichier est refusé** — durée, ratio, taille. Se rattrape dans `core`,
   avant l'envoi, pour ne pas payer un téléversement qui finira en 400 ;
4. **l'audit n'est pas passé** — visible seulement à la visibilité du résultat, pas
   dans un code d'erreur. C'est le plus traître, et c'est pour lui que le
   connecteur YouTube n'existe pas avant le lot 3 ;
5. **le compte n'a pas le bon type** — professionnel côté Instagram, rôle sur
   l'app, Page rattachée.

Le message doit nommer laquelle. `src/server/erreurs.ts` porte déjà cette
discipline pour le pipeline, et `secrets.ts` en fait une démonstration : la moitié
de sa valeur est dans ses messages.

## 9. Ce que cette spec change ailleurs

- **`2026-08-17-avolo-shorts-design.md` §3** : « la publication sur les réseaux »
  quitte le hors-périmètre et renvoie ici.
- **`2026-08-18-parcours-utilisateur-design.md` §3.4** : « Julien publie avec ses
  propres outils : ce qu'il lui faut ici est le presse-papiers » n'est plus toute
  la vérité — le presse-papiers reste, il n'est plus seul.
- **`src/server/steps/render.ts`**, commentaire de `texteDePublication` : il cite
  « la publication est hors périmètre (spec §3) », qui devient faux.
- **`ROADMAP.md`** : le lot de publication et les deux audits en attente, puisque
  c'est le point d'entrée pour reprendre le projet.

## 10. Ce qui reste ouvert

- **La péremption du brouillon TikTok** (§2.3) : 24 h selon des sources tierces
  concordantes, aucune source primaire. À mesurer au premier dépôt.
- ~~**Le type de compte Instagram**~~ — **tranché le 23 août 2026** (§2.1) : un
  compte *Créateur* (`MEDIA_CREATOR`) publie des reels sans réserve. Ne pas
  convertir un compte pour cette raison.
- **La portée des publications par API.** On lit régulièrement qu'un reel publié
  par API serait moins recommandé qu'un reel publié depuis l'app. Aucune source
  primaire, aucune mesure, et ce dépôt ne décide pas sur des ouï-dire — mais si
  c'était vrai, cela changerait l'intérêt de tout ce document. Une comparaison sur
  quelques clips vaudra mieux qu'une conviction.
- **L'ordonnanceur (§4, hors périmètre — pas le lot 2 de §5)** : Facebook sait
  planifier tout seul, les trois autres non. Ce chantier décidera si l'on
  planifie chez soi pour tout le monde ou si l'on délègue là où c'est offert.

## 11. Sources

Consultées le 18 août 2026. Les quatre premières sont primaires et priment sur
tout le reste.

- Instagram, publication de contenu :
  <https://developers.facebook.com/docs/instagram-platform/content-publishing/>
- Meta, Standard et Advanced Access :
  <https://developers.facebook.com/docs/graph-api/overview/access-levels/>
- Facebook, publication de reels :
  <https://developers.facebook.com/docs/video-api/guides/reels-publishing/>
- YouTube, `videos.insert` :
  <https://developers.google.com/youtube/v3/docs/videos/insert>
- YouTube, vidéos verrouillées en privé :
  <https://support.google.com/youtube/answer/7300965>
- YouTube, audits de quota et de conformité :
  <https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits>
- TikTok, Content Posting API :
  <https://developers.tiktok.com/doc/content-posting-api-get-started>
- TikTok, dépôt en brouillon :
  <https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content/>
- TikTok, Login Kit for Web :
  <https://developers.tiktok.com/doc/login-kit-web/>
- Upload-Post, comparaison tarifaire :
  <https://www.upload-post.com/pricing-comparison/>
