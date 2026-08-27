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

### Faciliter le repartage des Reels Instagram en story

Suivi dans
[l’issue #221](https://github.com/JulienCr/avolo-shorts/issues/221).

À étudier : comptes tagués par défaut, mention/tag/collaboration, génération
d’un visuel de story 9:16 et publication automatique ou export manuel selon les
possibilités de l’API Meta.

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
