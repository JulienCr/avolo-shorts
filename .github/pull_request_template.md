## Ce que ça change

<!-- Le résultat observable, pas la liste des fichiers touchés. -->

## Pourquoi

<!-- Si une mesure motive le changement, cite-la : c'est ce qui permettra de ne pas
     la défaire par réflexe dans six mois. Lien vers l'issue s'il y en a une. -->

## Comment c'est vérifié

<!-- La commande lancée et son résultat. « Ça a l'air de marcher » n'en est pas un.
     Si une partie n'est pas vérifiée, le dire ici plutôt que de l'omettre. -->

- [ ] les tests passent (`pnpm test`)
- [ ] le build passe (`pnpm build`)
- [ ] vérifié à l'œil sur un vrai extrait — si le rendu est touché

## Décisions de conception

<!-- Cocher seulement si la PR touche à l'une d'elles, et dire pourquoi elle bouge.
     Chacune est adossée à une mesure dans la spec, section 2. -->

- [ ] le clip reste une **liste de segments**, jamais un couple début/fin
- [ ] on raccourcit **par le milieu**, pas par les bouts
- [ ] le **ratio reste choisi par clip** (9:16, 4:5, 1:1, 16:9), pas figé
- [ ] le **crop reste fixe à l'intérieur d'un plan**
- [ ] on détecte des **corps**, pas des visages
- [ ] la surface d'édition reste le **transcript**, pas une timeline
- [ ] la correction renvoie des **substitutions indexées**, pas du texte
- [ ] la logique testable reste **hors des modules qui importent torch**

## Reste à faire

<!-- Ce qui est volontairement laissé de côté, et pourquoi. -->
