# Les marques de chaîne

Dépose ici les deux images que le rendu incruste en haut du clip. Elles
t'appartiennent, donc git les ignore : `.gitignore` couvre `assets/brand/*` et
n'excepte que ce fichier. Un dépôt fraîchement cloné n'en a donc aucune, et
**l'export d'un clip qui en demande échoue alors, en le disant** — `branding`
vaut `true` sur tout clip repéré. Le rendu est la dernière étape avant qu'un
fichier parte sur Instagram : y livrer un MP4 sans logo sans un mot ne se
rattrape qu'en dépubliant (#37). Pour rendre volontairement sans marque, passe
`branding` à `false` sur le clip.

| Fichier | Ce que c'est | Où il se pose | Largeur |
|---|---|---|---|
| `logo.png` | le logo de la chaîne | en haut à gauche | 22 % de la largeur du clip |
| `twitch.png` | la mention Twitch | en haut à droite | 16 % |

Chacune se rend seule : un logo sans mention, ou l'inverse, sont deux
installations légitimes. **L'une des deux suffit** à faire passer un clip qui
demande des marques — rien ne distingue « je n'ai qu'un logo » de « la mention a
disparu », alors que zéro marque, lui, ne se confond avec rien.

## Le format

- **PNG à fond transparent.** Le rendu superpose l'image telle quelle ; un fond
  blanc apparaîtra en blanc.
- **Au moins deux fois la largeur finale**, soit environ 480 px pour le logo et
  350 px pour la mention sur un clip 1080. Le rendu ne fait que réduire.
- Le rapport d'aspect est libre. Il décide de la hauteur de la bande, et c'est
  précisément pour ça que la position est épinglée par le haut (voir plus bas).
- Tout ce que ffmpeg sait décoder passe, mais reste sur du PNG : le nom de
  fichier est en dur, et la transparence est le seul point qui compte.

## Où la bande se pose, et pourquoi là

Trois zones sont déjà prises sur un clip vertical : le chrome de la plateforme en
haut — les onglets de TikTok, les icônes de Shorts — jusque vers 12 % de la
hauteur, la colonne d'icônes à droite à partir de 52 %, et les sous-titres
incrustés à partir de 59 %. Il reste la bande entre 13 % et 52 %, et la marque
s'accroche en haut de celle-ci.

**La position donnée est le bord supérieur de la bande, jamais son centre.** La
hauteur dépend du rapport d'aspect de ton image, que le code ne choisit pas :
ancrer le centre laisserait un lockup plus haut remonter sous la barre
d'interface. Mesuré dans openshorts, un logo 3:1 ancré par son centre à 0,13
remettait son bord supérieur à 0,109.

Deux garde-fous suivent de là :

- la hauteur d'une marque est plafonnée à 6 % de la hauteur du clip, **par marque
  et non pour la bande entière** — une image carrée rétrécit sans entraîner la
  mention avec elle ;
- la marge latérale vaut 5 % de la largeur.

Un logo très large est donc le cas confortable, et une image carrée ou haute sera
réduite jusqu'à tenir plutôt que refusée : une marque un peu petite reste une
marque.

## Vérifier

Après un export, ouvre le MP4 et regarde le haut de l'image. La marque ne doit
mordre ni sur le bord supérieur, ni sur le premier carton de sous-titres. Si elle
mord en haut, ton image est plus haute que large et le plafond de 6 % l'a déjà
réduite au maximum : recadre-la.
