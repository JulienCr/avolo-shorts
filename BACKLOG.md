# Backlog produit

Notes produit à qualifier et prioriser. Ce fichier accueille les besoins encore
trop exploratoires pour devenir immédiatement des issues d’implémentation.

## Publication et distribution

### Descriptions TikTok

**Constat**

Les descriptions TikTok restent bloquées ou absentes dans certains parcours de
publication. Le problème semble notamment apparaître lorsque TikTok et YouTube
sont publiés ensemble via Upload Post.

**Résultat attendu**

- La description TikTok est visible dans le planning.
- Elle est visible et modifiable dans le formulaire d’édition.
- Son absence est signalée clairement avant publication.
- Le bouton de génération de la description est disponible.
- La description réellement envoyée à TikTok correspond au contenu affiché.

**À investiguer**

- Reproduire le blocage dans chacun des parcours : création, édition,
  planification et publication.
- Vérifier si la correction de
  [l’issue #153](https://github.com/JulienCr/avolo-shorts/issues/153) couvre
  l’ensemble du problème ou seulement la publication groupée TikTok/YouTube.
- Vérifier le comportement du connecteur TikTok direct et celui d’Upload Post.

### Remplacer Upload Post pour YouTube Shorts — priorité forte

Suivi dans
[l’issue #168](https://github.com/JulienCr/avolo-shorts/issues/168).

**Risque**

YouTube est actuellement publié via l’offre gratuite d’Upload Post, limitée à
10 publications par mois. Ce volume est incompatible avec l’objectif
d’industrialisation de la distribution d’Avolo Shorts. Upload Post ne doit donc
pas rester une dépendance structurelle du canal YouTube.

**Objectif**

Publier automatiquement les Shorts via un connecteur YouTube direct, puis
retirer Upload Post lorsque TikTok et YouTube disposent tous les deux d’un
chemin autonome suffisamment fiable.

**Point bloquant à instruire fortement**

L’upload technique via l’API YouTube Data et `videos.insert` est possible,
mais un projet Google Cloud non audité impose des vidéos privées verrouillées.
Il faut donc choisir et valider une trajectoire :

- préparer et demander l’audit Google nécessaire à la publication publique ;
- évaluer temporairement un upload privé suivi d’une publication manuelle ;
- confirmer les quotas réels et demander leur augmentation si le rythme cible
  l’exige.

**Travail technique envisagé**

- OAuth 2.0 avec consentement et `refresh_token` durable ;
- upload reprenable par morceaux ;
- titre, description, visibilité et métadonnées YouTube ;
- détection et remontée détaillée des erreurs dans le planning ;
- suivi de l’état après l’envoi ;
- tests de quota, de reprise et d’expiration des jetons ;
- connecteur YouTube direct prioritaire devant Upload Post ;
- suppression finale d’Upload Post et de sa configuration.

**Critère de sortie**

Le système peut planifier et publier les Shorts YouTube au rythme prévu sans
consommer le quota mensuel d’Upload Post, avec un parcours manuel clairement
assumé uniquement si l’audit Google n’est pas encore obtenu.

### Faciliter le repartage des Reels Instagram en story

Suivi dans
[l’issue #221](https://github.com/JulienCr/avolo-shorts/issues/221).

À étudier : comptes tagués par défaut, mention/tag/collaboration, génération
d’un visuel de story 9:16 et publication automatique ou export manuel selon les
possibilités de l’API Meta.

### Ajouter un pied commun aux descriptions des Reels

**Objectif**

Composer chaque description à partir de deux blocs :

1. une description personnalisée, générée ou éditée pour le Reel ;
2. un pied commun présentant La Scène Avolo et redirigeant vers Twitch.

Le pied commun doit notamment pouvoir contenir :

- une présentation en une ligne de La Scène Avolo ;
- un CTA du type « Retrouvez-nous tous les dimanches sur Twitch » ;
- l’adresse exacte de la chaîne Twitch, à confirmer ;
- éventuellement des hashtags ou mentions permanentes.

**À prévoir**

- Configuration du texte commun au niveau du projet ou de la plateforme.
- Aperçu de la description finale avant publication.
- Séparateur et retours à la ligne maîtrisés entre la partie personnalisée et
  le pied commun.
- Possibilité de désactiver ou modifier ponctuellement le pied pour une
  publication.
- Respect des limites et usages propres à Instagram, TikTok, YouTube et
  Facebook.
- Une seule fonction de composition utilisée par l’aperçu, le planning et les
  connecteurs afin que le texte affiché soit celui réellement envoyé.

**Formulation éditoriale à définir**

La Scène Avolo est la chaîne Twitch d’une compagnie de théâtre et
d’improvisation, consacrée à l’impro au sens large : émissions, interviews,
spectacles et musique improvisée. La version finale doit rester courte et être
validée avec l’URL exacte de la chaîne.

### Ajouter un bumper final avec CTA Twitch

**Objectif**

Fermer chaque vidéo par un bumper animé très court, de **1 à 2 secondes
maximum**, afin d’afficher un CTA que les API des plateformes ne permettent pas
d’ajouter programmatiquement.

Contenu envisagé :

- apparition rapide du logo Avolo ou La Scène Avolo ;
- message du type « Retrouvez-nous sur Twitch tous les dimanches » ;
- éventuellement l’identifiant ou l’adresse courte de la chaîne ;
- sortie nette marquant la fin de la vidéo.

**Contraintes produit**

- Le bumper ne doit pas ralentir la chute ni donner l’impression que la vidéo
  continue.
- Le message doit rester lisible malgré une durée très courte.
- Le CTA doit rester dans la zone sûre des interfaces verticales.
- Le rendu doit fonctionner aux différents ratios exportés, notamment 9:16 et
  1:1.
- L’activation, le texte et l’asset doivent être configurables.
- Le logo existant utilisé pour les incrustations doit être réemployé si sa
  définition convient.

**Pistes techniques**

- Traiter le bumper comme un segment final distinct, ajouté après le montage
  principal.
- Produire une animation déterministe plutôt qu’une vidéo dupliquée dans chaque
  export.
- Inclure la configuration et les assets du bumper dans l’empreinte de rendu
  afin de périmer correctement les exports lorsqu’ils changent.
- Tester la concaténation audio/vidéo, le dernier frame, la durée exacte et les
  différents ratios.
- Vérifier si le bumper doit être inclus sur toutes les plateformes ou
  configurable plateforme par plateforme.

**Validation**

- Durée totale comprise entre 1 et 2 secondes.
- Logo et CTA lisibles sur mobile.
- Aucun saut audio ou image à la jonction.
- Le changement de texte ou de logo force bien un nouveau rendu.
- La vidéo publiée contient exactement le bumper prévisualisé.

## Planning

### Afficher le détail des échecs de publication

**Constat**

Lorsqu’une publication échoue, le planning affiche seulement un état d’erreur.
Il ne permet pas d’identifier immédiatement la plateforme concernée ni la
raison. Cette information existe déjà puisqu’elle apparaît dans les emails
d’alerte.

**Résultat attendu**

Pour chaque publication en échec, afficher :

- la plateforme ou le destinataire concerné ;
- la raison compréhensible de l’échec ;
- le message technique brut, accessible en détail si utile ;
- la date et l’heure du dernier essai ;
- l’état des autres plateformes de la même publication ;
- l’action possible : relancer, modifier ou abandonner.

**À investiguer**

- Identifier la source utilisée par les emails et l’exposer au planning sans
  dupliquer la logique de traduction des erreurs.
- Prévoir un affichage compact dans la liste et un détail dépliable.
- Ne pas masquer une réussite partielle derrière un unique état global
  « erreur ».

## Interface

### Appliquer l’identité visuelle Avolo

**Objectif**

Refondre progressivement l’interface pour qu’elle porte clairement l’identité
Avolo, sans densifier les écrans métier.

**Charte**

- Bleu : `#011979`
- Orange : `#FFA800`
- Blanc
- Logo carré par défaut ; variante ronde possible selon l’emplacement.

**À faire**

- Retrouver et réutiliser l’asset déjà employé pour incruster le logo dans les
  shorts.
- Ajouter le logo à la navigation ou à l’en-tête.
- Définir les couleurs comme variables/tokens plutôt que les disperser dans les
  composants.
- Décliner les états fonctionnels sans détourner les couleurs de marque :
  succès, avertissement, erreur, sélection et focus.
- Revoir la hiérarchie, les espacements et la lisibilité des écrans principaux,
  notamment le planning.

## Sous-titres

### Stabiliser le retour à la ligne pendant une même séquence

**Constat**

Pendant un même sous-titre, la répartition du texte varie parfois d’une image à
l’autre : une ligne passe à deux ou trois lignes, puis revient. Ce saut visuel
répété empêche une lecture fluide.

**Résultat attendu**

La mise en lignes d’un sous-titre reste stable pendant toute sa durée
d’affichage. Seule la mise en évidence progressive des mots doit évoluer entre
les images.

**Pistes d’investigation**

- Vérifier si le calcul de largeur dépend du mot actif, de son style ou de sa
  graisse.
- Vérifier que la mesure et le découpage en lignes sont effectués une seule fois
  sur le texte complet du sous-titre.
- Réutiliser ce découpage pour toutes les images de la séquence.
- Comparer l’aperçu navigateur et le rendu exporté.
- Ajouter un test de non-régression avec un sous-titre proche de la limite sur
  deux et trois lignes.

## Règle de promotion en issue

Transformer une entrée en issue lorsqu’elle possède au minimum :

- un comportement attendu assez précis ;
- un périmètre identifiable ;
- une méthode de validation ;
- suffisamment d’éléments pour être prise en charge sans refaire toute
  l’exploration produit.
