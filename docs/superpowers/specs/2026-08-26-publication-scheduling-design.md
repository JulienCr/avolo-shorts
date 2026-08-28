# Planning de diffusion : conception

Date : 26 août 2026.
Statut : proposition. Dix-sept décisions tranchées par Julien au cours de deux
tours de questions, à partir d'une lecture du dépôt au commit `ad4d957`.

Ce document décide de **l'ordonnancement des publications**, que la spec du
18 août (`2026-08-18-publication-reseaux-design.md`) a explicitement écarté
trois fois, dont un titre de section : « L'état : une table, pas un
ordonnanceur », et son §10 laissait la question ouverte en notant que Facebook
sait planifier tout seul, les trois autres non. C'est ce chantier-là qui
s'ouvre ici.

Il ne décide ni du pipeline, ni du rendu, ni du cadrage, ni des connecteurs —
ceux-ci existent, fonctionnent, et ne bougent pas.

## 1. La réponse, en trois phrases

Un écran séparé, atteignable de partout, où l'on coche des clips déjà exportés
et où l'on pose une date et une heure ; l'échéance s'écrit sur les quatre
lignes `publications` du clip, avec un cinquième statut `planned`.

Une tâche planifiée de l'hôte Windows réveille toutes les cinq minutes un
script sans serveur, qui publie **une** échéance due — les quatre plateformes à
la suite — et rend la main.

L'ordonnanceur n'encode jamais rien : il publie le fichier qui est sur le
disque, même s'il ne correspond plus au montage courant.

## 2. Ce qui a été vérifié

### 2.1 Le chemin de publication ne touche presque rien

Tracé de bout en bout, de `POST /api/clips/:id/publish` jusqu'aux adaptateurs.
Une publication ouvre SQLite, lit `analysis.json` et l'empreinte du rendu, lit
le MP4, puis appelle `graph.facebook.com`, `rupload.facebook.com`,
`open.tiktokapis.com` et `api.upload-post.com`.

**Aucun processus fils, aucun ffmpeg, aucun ffprobe, aucun Python, aucun GPU,
aucun Ollama, aucun accès au Drive.** Le seul reliquat est un import : la
chaîne de modules tire `@napi-rs/canvas` par `steps/render` → `hook-image`,
mais aucune fonction de dessin n'est appelée — le binding doit être
*chargeable*, pas utilisé.

C'est ce fait qui décide du §6.2 : faire tourner le serveur Next en permanence
ferait payer toute la pile native pour un travail qui n'en utilise aucune
partie.

### 2.2 La couture sans serveur existe déjà

`scripts/dev-publish.ts` appelle `launchPublish` directement, sans serveur
Next, en chargeant `.env.local` puis `.env` lui-même via `chargerEnv()`. Le
script d'ordonnancement se moule dessus ; il n'y a pas de mécanisme à inventer.

### 2.3 `next build` n'a jamais tourné ici

Pas de `BUILD_ID` sous `.next/`, et l'intégration continue ne lance pas la
construction — elle exécute `lint`, `type-check` et `test`. Transformer le
serveur en service aurait donc aussi consisté à emprunter pour la première fois
un chemin que rien ne teste.

### 2.4 Le serveur dédié n'est pas un serveur d'application

`~/dev/avolo-server` est un dépôt Ansible qui provisionne un Debian 12 +
YunoHost. La machine est réelle et bien tenue — Xeon D-1531, 32 Go ECC, IP
publique, 347 jours d'uptime, HTTPS via Cloudflare et Let's Encrypt, vérifié en
lecture le 26 août 2026. Mais en matière de publication elle ne contient que
**deux pages HTML statiques**, les mentions légales exigées par la revue d'app
TikTok et Meta, livrées le 24 août 2026.

N'existent pas : API propre, authentification au-delà d'un Basic nginx, file,
schéma de base, stockage objet, jeton social, chemin de notification
(Alertmanager est déployé mais sans destinataire). **Ni ffmpeg ni GPU** — un
Xeon D sans carte graphique, alors que la chaîne d'ici est configurée contre
une construction NVENC.

Contraintes de disque relevées : `/` à 81 % (~3,5 Go libres), `/home` à 77 %
(~99 Go libres) sur des disques à ~61 000 heures que la fiche recommande déjà
de remplacer par précaution.

Conclusion retenue : « envoyer les clips au serveur » n'est pas une
intégration, c'est un second produit — service HTTP, authentification, file,
état, garde des jetons, observabilité. La question se rouvrira le jour où
l'absence de la machine coûtera quelque chose de mesurable.

### 2.5 Il n'existe aucune surface de notification

Ni bulle, ni bandeau, ni courriel, ni webhook, ni notification système. Les
erreurs de publication ne s'affichent que dans la modale, tronquées avec le
texte complet en `title`. Le sondage `usePublications` ne tourne **que pendant
qu'une page est ouverte**, et son propre commentaire l'admet : « un envoi
détaché écrit son résultat plus tard, et rien d'autre ne prévient l'écran qu'il
est arrivé. » Les erreurs serveur partent dans la console du terminal.

Le dépôt a par ailleurs pris position contre l'éphémère, écrit dans
`review/feed.tsx` : « Ça reste à l'écran. Ni notification, ni bandeau qu'on
referme. » Le courriel retenu au §6.5 n'est pas une notification éphémère — il
s'accumule dans une boîte.

### 2.6 Le temps, tel qu'il est déjà traité

Les horodatages se rangent partout en **millisecondes depuis l'époque**,
`INTEGER` en base, `number` en TypeScript. Une seule déclaration de fuseau
existe dans tout le dépôt, `Europe/Paris`, dans `sources/texts.ts`, posée
exprès pour éviter un écart d'hydratation entre le rendu serveur et le
navigateur — l'émission est tournée à Paris.

`publications.createdAt` et `updatedAt` **ne sont affichés nulle part**. Le
planning sera la première date absolue que cette application montre, et sa
première saisie de date.

## 3. Les décisions à ne pas défaire

Quatre d'entre elles contredisent la recommandation qui avait été faite, et
c'est délibéré. Elles sont notées comme telles pour qu'on ne les « corrige »
pas par réflexe.

| Décision | Le réflexe qu'elle remplace |
|---|---|
| **L'ordonnanceur n'encode jamais** | ré-exporter à l'échéance ce qui a été modifié |
| **Le fichier périmé part quand même** | bloquer quand le rendu ne correspond plus |
| **Une machine publie, pas un humain** | une file « à publier aujourd'hui » qu'on dépile à la main |
| **On rattrape toujours, sans fenêtre de grâce** | abandonner une échéance trop en retard |
| Une date à l'écran, **quatre lignes** en base | une colonne `scheduledAt` sur `clips` |
| Le vivier est une condition **d'entrée**, pas de sortie | retirer du calendrier un clip redevenu `kept` |
| Le vivier **montre** ce qui est parti, il ne le range pas dehors | un vivier réduit à ce qui est programmable |
| Une tâche de l'OS, **pas un démon** | un processus qui veille |
| Un clip **par passage**, pas tous d'un coup | vider la file au premier réveil |

Les quatre premières demandent un mot, parce qu'elles ont été prises **contre**
l'avis donné :

**L'ordonnanceur n'encode jamais** (Q14). La recommandation était de
ré-exporter au moment de l'édition, pour qu'un humain voie le rendu avant qu'il
parte. Julien a tranché autrement : l'ordonnanceur prend le fichier disponible,
point. Le ré-export reste un geste manuel.

**Le fichier périmé part quand même** (Q17). Conséquence directe de la
précédente, et posée séparément parce qu'elle desserre une garde existante — le
chemin de publication vérifie aujourd'hui que le clip est `exported` **et** que
l'empreinte correspond. Le cas concret, écrit ici parce qu'il est
contre-intuitif : *lundi tu exportes ; mercredi tu coupes trois mots ; vendredi
19 h, le fichier de lundi part avec les trois mots dedans.* C'est le
comportement voulu — le dernier export est la dernière version validée.

**Une machine publie** (Q1). La recommandation était une file humaine, au motif
qu'un ordonnanceur qui ne se déclenche pas ne dit pas qu'il n'a rien publié.
L'objection est levée par le §6.5 : l'échec parle par courriel.

**On rattrape toujours** (Q9). La recommandation était une fenêtre de grâce,
parce qu'un extrait d'impro publié à 8 h 12 au lieu de 19 h n'est pas moins
performant, il est brûlé — on ne repost pas le même contenu au même public.
Julien a confirmé après que le cas dégénéré lui a été montré. Le §6.4 en
atténue le tranchant sans le contredire : rien n'est sauté, mais rien ne part
en rafale.

## 4. Périmètre

**Dedans** : la date d'échéance et son stockage, l'écran de planning, le
calendrier en lecture, le script d'ordonnancement, la tâche planifiée, le
courriel d'alerte, le desserrement de la garde de fraîcheur sur le seul chemin
ordonnancé.

**Dehors** : les connecteurs et les jetons, qui ne bougent pas. Le multi-compte.
Les statistiques de performance. Le décalage par plateforme — la donnée le
permettra (§6.1) mais aucune interface ne l'exposera. La publication depuis le
serveur dédié (§2.4). Et **la page `https://avolo.fr/meta/oauth-callback`**,
que `.env.example` désigne déjà comme `META_REDIRECT_URI` et qui renvoie 404 :
c'est un défaut de la publication existante, pas du planning.

## 5. La conception

### 5.1 La donnée

Un cinquième statut, et une colonne :

```ts
export type PublicationStatus =
  | 'planned'      // nouveau : échéance posée, rien n'est parti
  | 'in_progress'
  | 'submitted'
  | 'published'
  | 'failed'
```

```sql
ALTER TABLE publications ADD COLUMN scheduledAt INTEGER;
```

`scheduledAt` en millisecondes depuis l'époque, `NULL` pour toute ligne créée
par le chemin manuel — la colonne ne concerne que les publications
ordonnancées. La migration suit le style du dépôt : `PRAGMA table_info` puis
`ALTER TABLE`, sans table de migrations.

**Pourquoi quatre lignes et une seule date.** La table est déjà découpée par
`(clipId, platform)` et porte déjà, par plateforme, son statut, son adresse
distante, son erreur et l'empreinte du rendu publié. Écrire la même date quatre
fois ne coûte rien ; la découper plus tard ne coûtera pas de migration. Une
colonne sur `clips` aurait imposé l'inverse.

Bénéfice acquis sans rien écrire : `replaceClips` sauvegarde et restaure déjà
les lignes `publications` autour de son `DELETE`, donc une échéance survit à une
re-détection.

**Déprogrammer** supprime les lignes encore en `planned` et laisse intactes
celles qui portent un résultat. On ne réécrit pas l'histoire d'une publication
qui a eu lieu.

### 5.2 Le vivier, et ce qu'il ne gouverne pas

Un clip **entre** au planning quand il est `exported` et que son rendu
correspond au montage courant. Quinze clips y sont éligibles à la date de ce
document (42 `candidate`, 6 `kept`, 1 `discarded`, 15 `exported`).

C'est une condition **d'entrée**. Une fois l'échéance posée, elle vit dans les
lignes `publications` : un clip réédité qui retombe en `kept` **reste
programmé** et **part quand même** (§3). Le calendrier lit les publications,
pas le vivier. Implémenter l'inverse — retirer du calendrier ce qui sort du
vivier — serait une régression silencieuse.

**Mise à jour du 28 août 2026 : entrer au planning et s'afficher au vivier ne
sont plus la même question.** `GET /api/planning/pool` rendait les seuls clips
programmables, et un clip publié sur ses quatre plateformes quittait donc
l'écran — au-delà des cinq semaines du bandeau, plus rien ne disait ce qui
était sorti. La route rend désormais **tous les clips `exported`**, avec
`stale` et le détail de leurs publications, et six onglets les rangent : « À
publier », « Programmés », « Publié », « Partiels », « Erreurs », « Tout ».
Ils **se recoupent** — deux plateformes publiées, une en échec et une vierge
donnent un clip présent dans trois d'entre eux —, et « déposé » y compte
comme abouti, faute de quoi le brouillon TikTok interdirait à tout clip
d'entrer dans « Publié ».

La condition d'entrée, elle, n'a pas bougé d'un mot : elle vit dans
`hasSchedulablePlatform` et dans le refus de `POST /api/planning/schedule`.
Ce que la carte du vivier en montre, c'est l'absence de case à cocher sur un
clip qui n'a plus rien à programmer. **Le prix du périmètre retenu** : un clip
publié puis réédité repasse à `kept` (`src/server/steps/render.ts`) et quitte
l'écran, son historique de publication avec lui.

**Ce scénario tient parce que `discardRenderStale` épargne les sorties d'un
clip qui porte encore une échéance `planned`** (`keepScheduledOutputs`,
`src/server/db.ts:hasPendingSchedule`, issue #205). Sans cette réserve, la
route d'édition efface le MP4, sa variante et l'empreinte dès qu'un montage
devient périmé — exactement le geste que l'exemple du §3 décrit — et le
fichier de lundi n'existe plus le vendredi où il devait partir : deux
relecteurs l'ont trouvé indépendamment sur la PR #204. La réserve ne s'étend
jamais à `renderClip` lui-même, qui continue d'effacer l'empreinte pour
décider de ré-encoder.

### 5.3 L'écran

Route `/planning`, cinquième membre du type `Lieu`, entrée permanente dans la
barre à côté de la roue crantée, fil d'Ariane de profondeur 1. Pas de barre
latérale : il n'y en a pas dans ce dépôt, et les jetons `sidebar` de
`globals.css` ne sont lus par rien.

Le sens de circulation est **clip d'abord** : une liste des clips exportés non
encore programmés, transversale à toutes les émissions, où l'on coche puis
l'on date. Le calendrier est une **vue de contrôle**, en lecture.

**Transversal** parce que la cadence est hebdomadaire et ne connaît pas le
découpage en émissions : la question du lundi matin est « qu'est-ce qui sort
mardi », pas « qu'est-ce qui sort mardi parmi les clips du 24 avril ». Il faut
donc une requête sur `clips` sans filtre de projet — nouvelle, `GET
/api/projects/:id/candidates` étant aujourd'hui le seul point d'entrée. Le tri
par `id` suffit : un `projectId` commence par la date de tournage, et l'`id`
d'un clip préfixe celui de son projet, donc l'ordre lexicographique est l'ordre
(date d'émission, instant dans l'émission).

**Bandeau de cinq semaines**, pas grille de mois. À trois publications par
semaine, un mois porte douze à treize cartes pour vingt-huit à trente et une
cases ; un bandeau porte la même information sans frontière de mois, donc sans
rupture entre fin septembre et début octobre — exactement là où tombe la
question « qu'est-ce qui sort la semaine prochaine ». Aucune des formes
envisagées n'impose de dépendance : il n'y a ni bibliothèque de dates ni
composant de calendrier dans le dépôt, et il n'en faut pas.

**L'heure est libre, avec des heures par défaut** mémorisées. Une heure par
défaut *est* un créneau, simplement pas contraignant.

**La carte signale un rendu périmé sans le bloquer** — « ce qui partira vendredi
est la version de lundi » se lit, mais rien n'arrête.

### 5.4 L'ordonnanceur

Une tâche planifiée de l'hôte Windows, **toutes les cinq minutes**, invoquant
`wsl.exe` pour exécuter un script Node sans serveur, sur le modèle de
`scripts/dev-publish.ts`.

À chaque passage : prendre **une** échéance due, la plus ancienne, publier ses
quatre plateformes **à la suite, en série**, rendre la main.

**Pourquoi une tâche et pas un démon.** Un démon mort ne dit rien et laisse les
échéances passer en silence ; une tâche périodique qui échoue est consignée par
le planificateur qui l'a lancée. C'est le critère que `CLAUDE.md` énonce sous
« les échecs qui coûtent le plus cher sont ceux qui n'échouent pas ».

**Pourquoi un clip par passage.** Rien n'est sauté ni abandonné — cinq clips en
retard sortent sur vingt-cinq minutes, dans l'ordre de leurs échéances. La
rafale devient un filet sans que « rattraper toujours » soit contredit, et sans
une ligne de code de plus puisque la tâche est déjà périodique. Prix : une
publication à l'heure sort dans les cinq minutes qui suivent.

**Pourquoi en série et pas en parallèle.** Aucune mesure ne montre qu'un
décalage délibéré entre plateformes serve à quoi que ce soit, et aucune n'a été
inventée pour justifier le contraire. En revanche quatre envois simultanés
pouvant aller jusqu'à 500 Mio se partagent la même montée et peuvent expirer
ensemble. D'où « à la suite » : ni simultané, ni décalé.

**Le desserrement de la garde.** `launchPublish` refuse aujourd'hui un clip qui
n'est pas `exported` ou dont l'empreinte ne correspond pas
(`deliveryToDay`). Le chemin ordonnancé passe outre. **La modale manuelle garde
son refus** : il y a un humain devant elle, qui peut ré-exporter, et rien n'a
demandé de changer ce comportement. L'asymétrie est assumée et se justifie par
la présence ou l'absence d'un humain, pas par un oubli.

À vérifier par un essai, pas à décréter : le comportement de `wsl.exe` invoqué
par une tâche planifiée quand la session Windows est verrouillée ou fermée.

### 5.5 Les échecs, et ce qu'ils doivent dire

**Trois tentatives espacées, puis abandon signalé.** Un jeton expiré, une
coupure réseau et une limite de débit se réparent d'eux-mêmes ; une vidéo
refusée pour sa durée, son format ou son contenu ne se réparera jamais, et
chaque tentative est une requête de plus contre un compte qu'on a intérêt à
garder en règle.

**Un courriel à `julien@avolo.fr`**, par un service d'envoi transactionnel
(Resend, sauf compte préexistant ailleurs). Pas le SMTP du serveur dédié : la
pile mail y appartient à YunoHost, que le `CLAUDE.md` de ce dépôt-là déclare
source de vérité et interdit d'écraser. Pas le mot de passe d'application Gmail
du coffre : un compte personnel ne devient pas une dépendance
d'infrastructure. Une alerte qui tombe en indésirable est exactement l'échec
qui n'échoue pas.

Le courriel part sur abandon après réessais, et sur toute échéance qui n'a pas
pu être honorée.

## 6. Ce que cette spec change ailleurs

`2026-08-18-publication-reseaux-design.md` affirme trois fois que
l'ordonnancement est hors périmètre, dont le titre de son §6.3 — « L'état : une
table, pas un ordonnanceur » — et son §10 le laisse ouvert. **Ces passages sont
à corriger dans le même mouvement que l'implémentation**, comme `CLAUDE.md` le
demande : deux sources qui se contredisent sur la même question finissent par
diverger. Le §6.3 reste vrai de la table ; c'est sa portée qui change.

## 7. Ce qui reste ouvert

- Le comportement de `wsl.exe` sous tâche planifiée, session fermée (§5.4).
- Le fournisseur d'envoi de courriel, si un compte existe déjà ailleurs.
- Le décalage par plateforme : la donnée le permet, aucune interface ne
  l'expose. À rouvrir seulement sur une mesure, jamais sur une intuition.
- La publication depuis le serveur dédié, à rouvrir quand l'absence de la
  machine coûtera quelque chose de mesurable (§2.4).
