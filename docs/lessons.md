# Les leçons qui ont coûté cher

Ce document porte les démonstrations. Les règles qu'elles fondent tiennent en
quelques lignes dans `CLAUDE.md`, qui est lu au démarrage de chaque session ;
ici on peut prendre la place d'expliquer pourquoi elles ne sont pas
négociables. Chacune a coûté une mesure, une revue ou un aller-retour.

## Une spec est datée, et le code peut l'avoir rattrapée

Avant d'implémenter ce qu'une spec réclame, regarde à quel commit elle a été
écrite et ce qui a été fusionné depuis. Le 18 août 2026, deux demandes de la
spec de conception étaient déjà satisfaites : les zones de cadrage interdites,
qu'un constat ultérieur a réduites à un cas unique, et un champ de fraîcheur des
rendus que la vague de l'export avait rendu inutile.

Obéir au texte y aurait ajouté une seconde source de vérité sur une question
déjà tranchée, et deux sources sur la même question finissent par diverger.
Quand tu constates l'écart, corrige la spec dans le même mouvement : elle fait
autorité, donc la laisser fausse coûte au suivant ce qu'elle vient de te coûter.

Un troisième cas, le 24 août 2026 : la spec publication §2.3 affirmait, d'après
la documentation TikTok, qu'un domaine vérifié était obligatoire pour l'URL de
retour OAuth et ne mentionnait pas PKCE. Un appel réel contre l'app de Julien a
montré l'inverse des deux — la boucle locale est acceptée, PKCE est obligatoire
et absent de tout ce qui avait été lu avant. La documentation d'un tiers décrit
une plateforme en général ; seul un appel contre l'app réelle dit ce qui est
vrai d'elle.

## Un commentaire cité comme s'il était une spec mesurée

Une variante plus coûteuse que « la documentation d'un tiers ment » : un
commentaire de code non mesuré, cité comme s'il venait de la spec. Le docbloc
de `planChunks` (`tiktok.ts`) affirmait que seule la valeur déclarée devait
rester dans les bornes 5-64 Mo — jamais vérifié contre le vrai réseau, comme le
disait déjà l'avertissement du connecteur deux lignes plus haut. L'issue #213
l'a relu comme sorti de la spec §2.3, et le correctif a failli s'appuyer dessus.
La spec ne l'affirmait pas ; TikTok recalcule le nombre de morceaux lui-même
(`floor(video_size / chunk_size)`) et rejette toute valeur incohérente — c'est
ce qui a fait échouer un envoi réel le 27 août 2026. Un commentaire porte
l'intention de qui a écrit le code, pas une mesure ; il se lit comme tel avant
de fonder un correctif dessus.

## Pourquoi les identifiants se francisent tout seuls

Le glissement s'explique, et il se reproduira sinon. La prose de ce dépôt est
française, ses specs et ses commentaires le sont, et un agent francise les
identifiants par mimétisme sans que personne ne l'ait demandé.

Une consigne « le français est la langue du dépôt » doit donc **énumérer ce
qu'elle couvre** et exclure le code, faute de quoi elle est lue comme couvrant
tout. C'est la raison pour laquelle la règle de `CLAUDE.md` liste les identifiants,
les fichiers, les clés JSON et les branches plutôt que de dire « le code ».

## Un correctif compris comme local revient au champ suivant

**Un arrondi comparé à un seuil inclusif s'est réintroduit deux fois, à un an
d'écart de code.** L'issue #40 avait remplacé `round(score, 3)` par une
troncature vers le bas, pour que le seuil de confiance dise ce qu'il dit —
sinon `0,4996` passe un seuil de `0,5`. La PR #83 a ajouté la confiance des
points de pose, arrondie au plus proche, comparée au même genre de seuil : le
même défaut, un champ plus loin, retrouvé en review.

La leçon n'est pas « faire attention aux arrondis ». C'est que **la correction
précédente avait été comprise comme locale à son champ**, alors qu'elle énonçait
une règle : *une valeur notée qu'on compare à un seuil inclusif se tronque vers
le bas, jamais ne s'arrondit*. Un correctif qui n'énonce pas sa règle se
réapplique à la main, donc s'oublie.

Le motif dépasse l'arrondi. Quand une revue trouve un défaut de forme dans un
champ, demander **« quels autres champs ont cette forme »** coûte une minute.
Dans la même PR #83, un bornage qui ne couvrait qu'une extrémité existait en
**trois exemplaires**, et les deux derniers ont été trouvés dans du code que les
correctifs du premier venaient de toucher.

## Distinguer l'absence d'information de son ambiguïté

**Un défaut choisi pour l'une devient un choix actif dans l'autre.** « À égalité,
la valeur la plus prudente gagne » est juste quand l'information manque : aucune
hypothèse n'est mieux fondée qu'une autre, et la plus prudente est un choix
honnête. Appliqué à deux hypothèses concurrentes qui ne comptent chacune qu'une
voix, ce même défaut ne se contente pas d'échouer — il **tranche**, et rend un
faux résultat avec l'aplomb d'un vrai, puisque rien dans sa sortie ne dit qu'il
a deviné.

Le cas qui l'a révélé, au chantier des bascules de composition le 19 août 2026 :
avec deux comédiens, `collective_shift` n'avait que quatre appariements possibles
— deux vrais, deux croisés, sans réalité physique. Quand les deux vrais
déplacements différaient de plus que la tolérance d'appariement, les quatre
candidats se retrouvaient à une voix chacun, et le départage « plus petit
déplacement gagne » — juste pour dire « rien n'a bougé » face à une simple
absence de signal — élisait une paire croisée, rendant un déplacement de 0,007 là
où la scène avait bougé de 0,3.

Le correctif n'est pas un meilleur départage : c'est un appariement par rang qui
rend les paires croisées impossibles à construire quand l'effectif est stable,
pour que la question qui reste ne soit plus « quelle paire est réelle » mais « le
groupe est-il d'accord ». Le même principe a rouvert un second cas dans le même
chantier : une bascule dont le second signal ne confirme pas le premier était
posée au milieu de sa fenêtre — un défaut prudent, juste face à une fenêtre vide,
faux face à deux hypothèses (bascule réelle ou comédiens qui bougent de concert)
à une voix chacune. Elle est désormais rejetée, pas posée au hasard entre les
deux.

**Sur ce sujet, une lecture d'image a renversé une conclusion chiffrée cinq
fois.** La dernière portait sur un chiffre qui allait dans le sens de l'équipe.
Ce n'est pas le chiffre nu qui est dangereux, c'est **le chiffre déjà expliqué** :
une explication plausible n'appelle plus de vérification, et c'est précisément là
qu'elle en aurait le plus besoin.

## Le transcript reste la surface d'édition, la bande de temps ne le contredit pas

La ligne « la surface d'édition est le transcript » se lit mal depuis le 19 août
2026, parce que l'écran de clip porte désormais une bande de temps sous l'aperçu
source. Les deux ne se contredisent pas : la bande n'a ni pistes, ni forme
d'onde, ni montage des mots. Elle sert trois choses que le texte ne sait pas
exprimer — promener la lecture, tirer les deux bornes à l'image près, voir où le
cadre change de plan — et elle monte du temps là où le transcript monte des mots.

Le transcript, lui, a cessé d'être *visible en permanence* : il s'ouvre dans un
tiroir, avec ses six gestes intacts. Ce qui reste interdit est ce qui l'a toujours
été : remplacer le texte par une timeline comme surface de montage.

## Ce qu'une mesure vaut sur cette machine

**Une mesure prise dans WSL ici porte 40 à 80 % de variance**, et ce n'est ni
thermique ni réglable. Le planificateur de Windows place les vCPU de la machine
virtuelle où il veut sur une topologie hybride : d'une exécution à l'autre, le
même travail tombe sur des P-cores à 5,1 GHz ou sur des E-cores à 4,1 GHz, dont
l'IPC est nettement inférieur en AVX2. `.wslconfig` n'a aucune clé d'affinité,
vérifié dans la source de WSL et non déduit de la documentation.

Conséquence pour un dépôt qui décide sur des mesures : relever `/proc/loadavg` à
côté de chaque chiffre, refuser toute mesure prise sous charge, faire trois
passes et garder la médiane. **Un écart inférieur à ~10 % n'est pas établi**, ce
qui vise nommément les 7 % qui font préférer x264 à NVENC sur le proxy (13,8x
contre 12,8x) : la conclusion n'est pas démentie, elle n'a simplement jamais été
mesurable en une passe.

**Le throttling thermique a été cherché et n'existe pas** (18 août 2026). Sous
six minutes de charge AVX2 tous cœurs, les P-cores tiennent 5,12 à 5,15 GHz sans
décroître, `PerformanceLimitFlags` reste à 0, et le journal Windows ne porte
aucun événement 37. Le GPU tient 67 °C à 448 W, compteurs de ralentissement
thermique à zéro. Une lenteur observée ici est de la **contention**, pas de la
chaleur : ne pas rouvrir la question sans un fait nouveau.

## Pourquoi pas de Docker

Le raisonnement complet est en section 5 de la spec de conception. En bref :
openshorts se conteneurise parce qu'il s'installe chez des inconnus, ce projet
tourne sur une machine dont l'environnement est déjà monté, et conteneuriser
réimporterait la fragilité des binds sur le Drive.

## Ce que Meta ne dit pas quand on publie un reel

Quatre faits mesurés le 23 août 2026 en branchant Instagram pour de vrai, sur le
compte `cie.avolo`. Aucun n'est dans la documentation, et trois ont coûté un
aller-retour chacun.

**`upload_type=resumable` n'existe que par Facebook Login.** Meta expose deux
configurations dans la même app, et le parcours qu'il met en avant — « connexion
Instagram », jeton `IGA…` sur `graph.instagram.com` — **n'accepte que
`video_url`, une URL publique**. Testé en v21, v22 et v23 : toujours
`The parameter video_url is required`. Le téléversement depuis le disque, que la
conception impose pour ne pas exposer la machine, n'est donc réalisable que par
« connexion Facebook » (jeton `EAA…` sur `graph.facebook.com`, puis binaire vers
`rupload.facebook.com/ig-api-upload/{v}/{container}`). Choisir le mauvais
appairage, c'est découvrir la contrainte après avoir tout câblé.

**Un `error_subcode: 2207085` sur `media_publish` veut dire « droit manquant sur
l'actif », pas « erreur serveur ».** Meta rend « Une erreur de serveur interne
est survenue, veuillez réessayer plus tard », qui invite précisément à la
mauvaise action. La cause réelle : dans le portefeuille business, le compte
Instagram n'avait **aucune personne affectée**. La portée `business_management`
suffit à lire le compte, à créer le conteneur et à téléverser le fichier — seule
la publication exige un droit sur l'actif lui-même. Trois des quatre étapes
réussissent donc, ce qui fait chercher au mauvais endroit.

**Ce qui a trouvé la cause est la comparaison, pas le raisonnement.** Deux
comptes du même portefeuille, même code, même fichier, même jeton : l'un
publiait, l'autre non. La seule différence lisible dans l'interface était le
nombre de personnes affectées. Devant un échec que l'API refuse d'expliquer,
chercher un actif voisin qui fonctionne coûte moins cher que relire la
documentation — deux hypothèses plausibles avaient déjà été écartées à tort
avant celle-là, dont la liaison à une Page Facebook, qui n'avait rien à voir.

**`rupload.facebook.com` rend des 400 transitoires.** Le même fichier, sur le
même conteneur, avec les mêmes en-têtes, échoue puis réussit à la reprise. Un
connecteur qui traite ce 400 comme définitif abandonnera des publications qui
n'avaient besoin que d'un second essai.

Ça n'entame pas le « ni file, ni réessai automatique » de la conception, et la
distinction vaut d'être posée une fois : **reprendre un octet perdu à
l'intérieur d'une tentative n'est pas réessayer la tentative**. Le premier est
du transport, il se décide dans le connecteur, il est borné et immédiat. Le
second est de l'ordonnancement — relancer plus tard une publication qui a
échoué —, il suppose une file et des horaires, et il reste hors périmètre.

Accessoirement, deux questions que la conception laissait ouvertes sont
tranchées : un compte de type **Créateur** (`MEDIA_CREATOR`) publie des reels
sans réserve, et l'identifiant du compte diffère selon le chemin — un identifiant
cadré par l'app en connexion Instagram, un identifiant business en `17841…` par
connexion Facebook. Le même compte, deux nombres sans rapport visible.

## Ce qu'une doublure injectée ne peut pas voir

Le dépôt teste ses dépendances externes en les injectant : un lecteur de secret
dans `secrets.ts`, un `fetch` dans `upload-post.ts` et `meta.ts`, des
adaptateurs littéraux dans les tests de route. C'est une bonne convention, elle
tient le réseau hors des tests, et elle a un angle mort systématique qu'il faut
connaître : **elle valide ce que le consommateur fait d'une dépendance, jamais
la façon dont la production la fabrique.**

Le cas mesuré, le 23 août 2026. `publicationAdapters()` construisait une
instance neuve à chaque appel. `groupByAdapter` regroupe les plateformes **par
identité d'objet**, si bien que deux plateformes du même connecteur
n'atterrissaient jamais dans le même groupe : chaque publication partait en
autant d'appels que de plateformes, ce que le connecteur Upload Post facture en
téléversements — exactement ce que le regroupement existait pour éviter. Le
test du regroupement passait pourtant, et il était bon : il construit des
adaptateurs littéraux, donc à identité stable, et il mocke le module de registre
en entier. La fabrique réelle ne s'exécutait jamais sous lui. Le correctif tient
en un `??=`, et le docbloc de `src/server/publication/index.ts` porte désormais
la raison.

La règle qui en sort : dès qu'un code compare des dépendances **par identité**
plutôt que par valeur — une `Map`, un `Set`, un `===`, un `includes` sur des
objets —, la stabilité de l'instance devient une propriété du système, et
aucun test à doublures ne la vérifiera. Elle se teste en appelant deux fois la
vraie fabrique, ou elle ne se teste pas.

Le corollaire de conduite vaut autant. Une revue interne qui lit le diff contre
un contrat ne trouve pas ça : le diff est correct, le test est correct, et le
défaut vit dans la couture entre les deux. Sur #148 comme sur #149, la revue interne
a validé le fond, puis la boucle externe a tourné quatre passes et corrigé des
défauts réels à chacune des trois premières. Les deux étages ne se remplacent
pas, et supposer que le premier couvre le second est ce qui coûte cher.

## Un réglage validé des deux côtés ferme son propre trou

Quand deux PR parallèles doivent se rejoindre sur une énumération — l'une pose le
choix dans les réglages, l'autre livre ce que ce choix désigne —, la question qui
vient est : que se passe-t-il entre les deux fusions, quand le réglage propose une
valeur que rien ne sert encore ?

Rien, et c'est une propriété du dépôt plutôt qu'une chance. `applySettings` et
`effectiveSettings` (`src/server/db.ts`) valident tous deux contre la **même** liste
de valeurs : une valeur hors liste est refusée à l'écriture et ramenée au défaut à
la lecture. Une préférence ne peut donc jamais nommer autre chose qu'un identifiant
connu, et le résolveur n'a qu'à retomber sur son ordre de priorité quand cet
identifiant n'a pas encore de porteur.

Ce que ça permet, et qui décide d'un séquencement : **la valeur d'énumération peut
précéder de plusieurs jours ce qu'elle désigne.** La PR des réglages a livré un choix
« TikTok » alors qu'aucun connecteur TikTok n'existait ; celle du connecteur l'a
rendu réel une nuit plus tard. Aucune migration, aucun commit de nettoyage, aucun
état transitoire à garder en tête — le trou se referme au moment où la seconde
fusionne. Sans cette symétrie il aurait fallu séquencer les deux PR, donc perdre le
parallélisme, ou introduire un drapeau que quelqu'un aurait dû penser à retirer.

Le corollaire pour les tests est moins agréable : le jour où le second connecteur
existe, **le scénario « préférence sans porteur » cesse d'être atteignable par l'API
publique**, et le test qui le couvrait paraît mort. Il ne l'est pas — le repli
protège toujours un état réel, celui d'un connecteur retiré du registre alors que sa
valeur traîne dans les réglages. Il se réécrit en simulant le trou dans le registre,
il ne se supprime pas. Confondre « plus atteignable par le chemin normal » et « plus
utile » est la façon dont une garde défensive perd sa couverture sans que personne
ne décide de la retirer.

## Un signal qui se déclenche toujours n'est pas un signal

Le registre de cas de cadrage (`scripts/framing/cases.ts`) rapporte, à chaque
`verify`, ce qui a bougé depuis l'étiquetage. La première version signalait comme
**dérive** tout instant tombant à moins d'une image d'une frontière de plan. Sur
les treize cas, elle en signalait **huit**, en permanence, à distance 0,000 s.

La cause n'était pas un seuil trop large : les huit viennent de l'issue #190, qui
avait listé le début du plan comme instant. Un instant posé pile sur `shot.start`
se résout de façon déterministe par le prédicat semi-ouvert `start <= t < end` —
il ne peut pas basculer. Ce qui peut basculer, c'est un instant à quelques
dizaines de millisecondes **après** une frontière, et il y en avait exactement
deux : `cqlp` 2 138 s et `caro-mdlm` 652,5 s, tous deux à 33 ms, enregistrés
précisément pour éprouver le décalage d'horloge du piège 6 de la skill `cadrage`.

Huit alertes permanentes noyaient les deux vraies, et rendaient `--strict`
inutilisable : il aurait sorti en 1 sans que rien n'ait jamais bougé. La
séparation retenue est celle du sens, pas du seuil — une **dérive** (quelque
chose a bougé, `--strict` échoue) et une **note** (une observation, ignorée par
`--strict`). Le compte final le dit d'une ligne : « 13 cas vérifiés — 2 en
dérive, 8 ancrés sur une frontière (sans conséquence), 0 absents ».

La règle générale : **avant de livrer un détecteur, compter combien de fois il se
déclenche sur les données qu'on a.** S'il se déclenche sur la majorité, ce n'est
pas un détecteur, c'est une propriété du corpus qu'on vient de redécouvrir.

## Un chiffre cité dans une issue n'est pas un chiffre stable

L'issue #190 construit toute sa table de distribution de la frontalité sur
**489 plans splittés**. Le tamis de l'issue #191, écrit six jours plus tard et
balayant le même corpus par le même chemin (`computeFraming` sur un
pseudo-segment couvrant toute la vidéo), en trouve **499**.

Personne n'a truqué quoi que ce soit : entre les deux, le corpus et le code du
cadrage ont bougé. Mais la table de #190 n'est plus assise sur la population
qu'elle nomme, et rien dans l'issue ne le dira jamais — un chiffre en prose ne
vieillit pas bruyamment.

C'est l'argument le plus court pour le registre de cas : une planche perdue se
régénère, un verdict humain perdu se repaie en temps humain, et **un chiffre
recopié en prose dérive sans prévenir**. La skill `cadrage` porte déjà la règle
sous une autre forme — « compare toujours au code en service, pas à un état
antérieur ». Elle vaut aussi pour les populations, pas seulement pour les gains.

## Un segment n'est pas une entrée

L'issue #212 porte une section « une hypothèse mesurée puis écartée, **à ne pas
reprendre** » : `concat` enchaînerait des entrées mal recalées. Elle l'écarte en
constatant que les deux clips fautifs ont « exactement un segment chacun,
vérifié en base », donc aucune jonction.

C'était pourtant la cause. `splitByShot` (`src/core/shot-split.ts`) coupe chaque
segment aux frontières de plans avant que `renderArgs` ne le voie : un segment
qui traverse sept plans devient **sept entrées** et un `concat=n=7:v=1:a=1`. Le
clip nommé dans l'issue en portait sept. La base dit le montage, le graphe dit
autre chose, et c'est le graphe qui rend.

La corrélation était parfaite une fois le bon compte fait — sur les quinze
rendus du dépôt, un morceau donne zéro paquet audio irrégulier, plusieurs
morceaux en donnent 117, toujours les mêmes. Ni la version d'empreinte, ni le
hook, ni les marques, ni la source, ni la date ne séparaient les deux
populations.

Deux leçons, et la seconde coûte plus cher que la première :

- **Toute mesure sur le rendu compte les morceaux après `splitByShot`, jamais
  les segments en base.** Les deux nombres diffèrent dès qu'un clip traverse une
  coupe, c'est-à-dire presque toujours.
- **Une piste écartée dans une issue s'écarte avec sa prémisse, pas avec sa
  conclusion.** « Un segment, donc pas de jonction » se vérifiait en une
  commande. Trois hypothèses de remplacement ont été instruites et mesurées
  fausses (`-ss` avant `-i`, l'amorçage AAC, `-hwaccel cuda`) avant que la
  quatrième, celle qu'on avait défense de rouvrir, ne se révèle juste.
