# Système visuel — état du code, pas une proposition

Relevé le 31 août 2026, dérivé du code et de rien d'autre. `tmp/maquette-montage.html`
porte une **copie** des jetons OKLCH ci-dessous, recopiée à la main faute d'un
document comme celui-ci — la raison d'être de ce fichier.

## Jetons de couleur (`src/app/globals.css`)

Tout en OKLCH, jamais en hexadécimal. Trois familles :

- **Neutres** (`--background`, `--foreground`, `--card`, `--border`, `--muted`…) :
  chroma 0, un dégradé de gris pur, dupliqué en clair (`:root`) et en sombre (`.dark`).
- **Marque**, deux teintes, jamais interchangeables :
  - `--stage` (orange #FFA800, 72°) — la **seule** couleur d'état de l'interface :
    ce qui est gardé, ce qui est sélectionné, le rectangle de cadrage. Un accent
    qui sert partout n'accentue plus rien (commentaire ligne 121-123).
  - `--brand-blue` (#011979, 264°) — réservé au chrome (barre d'app), jamais à un état.
- **Fonctionnels** (`--success`, `--warning`, `--destructive`) — à 145°/95°/27°,
  loin des deux teintes de marque pour ne jamais s'y confondre.

`.bg-brand-blue` (ligne 156-163) redéfinit localement `--muted-foreground` et
`--destructive` pour le contraste sur fond bleu foncé — portée volontairement
locale, faute de pouvoir toucher les composants qui les consomment (revue
Copilot/Codex, PR #242).

## Le seuil `workbench` (`globals.css:32`)

```css
@custom-variant workbench (@media (min-width: 1024px) and (min-height: 640px));
```

Bascule l'écran de clip entre une colonne qui défile (en dessous du seuil) et
deux volets fixes côte à côte (au-dessus). Le calcul, du commentaire lignes 8-29 :

- Chrome fixe au-dessus des deux colonnes : barre d'app (48) + fresque des
  clips gardés (146) + remplissage de `main` (32) = **226 px**.
- Hauteur minimale pour qu'un aperçu 9:16 serve à quelque chose : **400 px**
  (≈ 225 px de large) — choisie par le propriétaire, pas dérivée d'une mesure.
- Seuil = 226 + 400 = 626, arrondi à **640**.

Choisi pour rester atteignable sous un 1080p réel (~937 px de hauteur utile,
fenêtre et barre des tâches Windows déduites) — le seuil de 1000 px qu'il
remplaçait ne l'était pas.

## Échelles typographique et d'espacement (mesurées, pas les défauts Tailwind)

Relevé par grep sur `src/components/clip/*.tsx` (25 fichiers).

**Texte** : `text-[0.75rem]` domine largement (66 occurrences) — c'est la taille
de fait des libellés, légendes et texte secondaire de l'écran de clip, devant
`text-xs`/`text-sm` du thème par défaut. Deux tailles ad hoc supplémentaires,
rares : `text-[0.8rem]` et `text-[0.97rem]`.

**Espacements** (`gap-*`) : `gap-2` (8px) et `gap-1.5` (6px) dominent, suivis
de `gap-1` (4px) et `gap-3` (12px) — la grille de fait va par pas de 4px.

**Remplissage** (`p-*`/`px-*`/`py-*`) : `px-3` et `py-2.5` sont les plus
fréquents ; `p-4` marque les cartes de premier niveau (`role="group"`,
bordure, coins arrondis) — voir la grammaire des composants ci-dessous.

## Grammaire des composants (`src/components/clip/`, 25 fichiers, 6927 lignes)

### Carte (`role="group"`, `rounded-lg border p-4`)

Un regroupement visuel de premier niveau à l'intérieur de l'écran : bordure,
coins arrondis, remplissage `p-4`. Trois instances sur l'écran d'édition
(`clip-screen.tsx`) :

| `aria-label` | Contenu |
|---|---|
| `Source` | La source vidéo, le transport, les champs de texte du clip |
| `Montage` | La bande de temps + le transcript |
| `Transcript du clip` | Le panneau transcript lui-même (`transcript-drawer.tsx`), niché dans « Montage » |

### Région (`role="region"`)

Un regroupement qui n'est pas une carte au sens ci-dessus mais que le lecteur
d'écran doit pouvoir nommer et sauter :

| `aria-label` | Porté par |
|---|---|
| `Outils de cadrage` | La ligne de déclencheurs (ratio, cadrage, rendu) sous « Montage » |

### Sections nommées par `aria-labelledby` plutôt que `aria-label`

`zone-image` (le volet gauche, la section « Image ») et `zone-sortie` (le
volet droit, la sortie 9:16) — un `<h2>` visible ou `sr-only` porte le texte,
la section le référence.

### `data-slot` — un seul aujourd'hui

`data-slot="source-row"` (`clip-screen.tsx:696`) marque la rangée qui porte la
figure vidéo et les champs de texte, à l'intérieur de la carte « Source ». Le
transport qui suit n'a pas d'attribut propre ; il se sélectionne comme le
frère suivant (`[data-slot="source-row"] + div`) — c'est ainsi que
`scripts/ui/pairs.ts` le vise.

### `data-testid` — la bande de temps

`filmstrip` (les vignettes en fond de piste), `cut` (un passage retiré),
`shot-mark` (une frontière de plan), `band-footer` (le pied A/B/durée) —
tous dans `timeline.tsx`.

### Ce que `scripts/ui/pairs.ts` prend pour acquis

Les sélecteurs de `CLIP_SCREEN_PAIRS` dépendent exactement des attributs
ci-dessus : `role="group"`+`aria-label` pour Source/Montage/Transcript,
`role="region"`+`aria-label` pour Outils de cadrage, `data-slot="source-row"`
et son frère suivant pour figure/transport, `data-testid="filmstrip"` pour le
ruban. Un renommage d'un de ces attributs casse une paire — mettre à jour les
deux fichiers dans le même mouvement.

Absent aujourd'hui, et donc hors de `pairs.ts` : le commutateur Temps/Mots
qu'un plan antérieur visait par `role="tab"`/`aria-pressed` — aucun des deux
n'existe sur l'écran de clip (le seul `role="tab"` réel vient des onglets
Édition/Exports de la barre d'app, sans rapport).
