# La hiérarchie du volet Image — plan d'implémentation (phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Ce que ce chantier a obtenu, à dire d'emblée à qui reprend ce plan.** Le
propriétaire voulait deux choses qui semblaient s'exclure : la bande et le
transcript visibles ensemble, **et** l'écran utilisable sur un 1080p réel. Les
avoir ensemble semblait pousser le seuil `workbench` de ~1001 px à ~1167 px —
moins atteignable sur 1080p, pas plus. La résolution n'a pas été un compromis
entre les deux : le propriétaire a retiré la contrainte qui les opposait
(« deux volets fixes où rien ne défile »), en acceptant que le volet gauche
défile au besoin. Ça a dissous la tension plutôt que de la trancher : le
seuil recalculé ne porte plus la question « est-ce que tout tient » mais
« la sortie 9:16 a-t-elle une taille qui vaut le coup », et retombe à
**~640 px** — sous les ~937 px d'un 1080p réel. Les deux demandes du
propriétaire sont satisfaites, sans arbitrage entre elles.

**Ne pas démarrer avant que les deux conditions suivantes tiennent :**

1. **La PR #286 est fusionnée** sur `main`. Elle porte `clip-screen.tsx` et
   `timeline.tsx` — les tâches 1, 3 et 5 de ce plan modifient ces deux
   fichiers, et brancher avant sa fusion perdrait sa fusion de Segments/Cadre
   dans le pied de bande dans un merge sans conflit, même risque et même
   leçon que la #270 le 28 août. **Les tâches 2 et 4 ne touchent ni l'un ni
   l'autre** (`globals.css` et `output-preview.tsx` seulement) : elles
   n'ont pas de dépendance de fichier sur la #286, mais ce plan les séquence
   quand même après sa fusion par défaut, pour ne pas partir en parallèle
   d'un chantier qui reste actif sur l'écran de clip. Un orchestrateur qui
   veut les paralléliser plus tôt le peut, à ses risques.
2. **Le document jumeau,
   [`docs/superpowers/specs/2026-08-30-hierarchie-ecran-clip-design.md`](../specs/2026-08-30-hierarchie-ecran-clip-design.md),
   est approuvé par le propriétaire** — dans sa forme amendée du 30 août
   (nuit) : §2.1/§4.1/§4.2 (le calcul de hauteur de la rangée corrigé à la
   racine, plus de fiche bornée séparément), §2.5/§4.5 (bande et transcript
   coexistent sans condition de seuil) et §3.4 (le seuil recalculé à ~640 px
   sur la question affaiblie). **Ne pas travailler contre une version
   antérieure de la spec** — si le fichier jumeau ne porte pas ces sections
   sous cette forme, la spec a été rouverte depuis et ce plan doit être
   revérifié avant tout commit.

**Rebaser sur le nouveau `main` avant de commencer**, et revérifier chaque
repère de ligne cité ici contre le code réel — ce plan a été écrit contre
`02c66ba`, avant la #286 ; ses propres numéros de ligne auront dérivé, comme
ceux du contrat qui a lancé ce chantier ont déjà dérivé une fois (§1.4 de la
spec jumelle).

**Chaque tâche qui change la mise en page doit son relevé de chevauchement
avant/après, par paire d'éléments nommée, à 1920×1080 et 2560×1320 — pas une
largeur, pas une hauteur de défilement.** C'est la leçon du chantier lui-même :
le coordinateur a vérifié vidéo/bande, déclaré la géométrie propre, et manqué
vidéo/transport en entier — une paire que personne n'avait pensé à nommer.
Une tâche qui dit « vérifier la mise en page » reproduirait le même angle
mort ; une tâche qui nomme ses paires ne le peut pas.

**Goal:** Corriger le calcul de hauteur qui cause les deux débordements
mesurés, recalculer le seuil `workbench` sur la question qu'il pose
réellement (la sortie 9:16 vaut-elle le coup en deux colonnes), grouper la
colonne Image en cartes lisibles, faire coexister la bande et le transcript
sans condition de seuil, et retirer le pourcentage sans objet affiché sur un
plan split ou doublage.

**Architecture:** Trois blocs verticaux dans la colonne Image — Carte Source
(figure + fiche + transport, aucun des trois borné séparément : la colonne
défile comme un tout si besoin), Carte Montage (bande + panneau transcript,
tous deux visibles en permanence), Ligne d'outils (ratio, réglages montage,
réglages rendu fusionnés). La colonne droite (sortie 9:16) ne change pas.

**Tech Stack:** identique au 28 août — Next.js, React 19, TypeScript, Tailwind
CSS v4 (variante `workbench`), shadcn/ui, Vitest + Testing Library.

**Spec:** [`docs/superpowers/specs/2026-08-30-hierarchie-ecran-clip-design.md`](../specs/2026-08-30-hierarchie-ecran-clip-design.md)
— et son prédécesseur, [`2026-08-28-ecran-clip-design.md`](../specs/2026-08-28-ecran-clip-design.md),
dont l'ossature à deux volets tient.

## Global Constraints

- **Le code est en anglais, sans exception** : identifiants, noms de fichiers,
  clés JSON, branches git. Aucun accent dans un identifiant. Commentaires,
  libellés d'interface et corps de PR en français ; messages de commit et
  titres de PR en anglais.
- **Trois lignes par commentaire, dix par docstring.** Mesuré par
  `~/.claude/scripts/comment-budget.sh origin/main` après chaque tâche.
- **Ne pas toucher à `VERSION_FINGERPRINT`** (`src/server/steps/render.ts`) :
  aucune tâche de ce plan ne change la recette ffmpeg.
- **Aucune surface de l'écran de clip n'annonce un ratio ou un pourcentage de
  crop sur un plan split ou doublage.** Rompu trois fois avant ce chantier ;
  la tâche 4 corrige la quatrième instance trouvée en marge de la phase 1.
  `tests/components/clip/clip-screen.test.tsx` affirme les chaînes exactes
  « cadre doublage » et « cadre split » — ne pas les reformuler.
- **Vérification après chaque tâche** : `pnpm lint && pnpm type-check && pnpm test`.
- **Mesurer dans un vrai moteur de rendu, jamais déduire de jsdom** —
  `getBoundingClientRect` y rend des zéros, donc aucun test unitaire ne peut
  voir une régression de superposition. Utiliser Playwright (voir §1 de la
  spec jumelle pour la méthode) ou, à défaut, un Chrome piloté depuis WSL en
  suivant les pièges déjà payés (fenêtre bloquée à 5120×1440, mesurer dans une
  iframe pincée, `localhost` jamais `127.0.0.1`).
- **Nommer les paires, jamais mesurer « la mise en page ».** Voir la note
  d'ouverture. Chaque relevé de chevauchement dit contre quels deux éléments
  il mesure, avec leur sélecteur ou leur rôle ARIA.
- **Livraison** : un worktree isolé branché depuis le HEAD local, une PR, puis
  la skill `check-reviews` avant le merge.

## File Structure

| Fichier | Responsabilité | Tâche |
|---|---|---|
| `src/components/clip/clip-screen.tsx` | modifié — calcul de hauteur de la rangée corrigé, cartes, fusion de la ligne d'outils | 1, 3 |
| `src/app/globals.css` | modifié — la valeur et le commentaire du seuil `workbench` | 2 |
| `src/components/clip/output-preview.tsx` | modifié — retire le pourcentage sur split/doublage | 4 |
| `src/components/clip/timeline.tsx` | modifié — bande et transcript coexistent sans condition de seuil | 5 |
| `src/components/clip/shortcuts.tsx` | modifié — `Ctrl+F` focalise le transcript déjà visible, sans condition de seuil | 5 |
| `tests/components/clip/clip-screen.test.tsx` | modifié — nouvelles assertions de structure et cartes | 1, 3 |
| `tests/components/clip/output-preview.test.tsx` | modifié — assertions sur la légende split/doublage | 4 |
| `tests/components/clip/timeline.test.tsx` | modifié — coexistence sans condition de seuil | 5 |

---

### Task 1 : Corriger le calcul de hauteur de la rangée source+fiche, à la racine

**Files:**
- Modify: `src/components/clip/clip-screen.tsx` — repères à revérifier après
  rebase, relevés le 30 août sur `02c66ba` : la rangée `:626`, la figure
  `:627-646`, le conteneur de la fiche `:648-656`, la section `:610-615`
  (porte déjà `workbench:overflow-y-auto`).
- Test: `tests/components/clip/clip-screen.test.tsx`

**Interfaces:**
- Consumes: rien de nouveau.
- Produces: rien de nouveau — c'est une correction de mise en page, pas une
  nouvelle interface.

**Ce que ça corrige** : §1.1/§4.1/§4.2 de la spec jumelle. Sous Chromium, la
ligne `flex min-h-0 flex-wrap items-start gap-4 workbench:flex-nowrap
workbench:max-h-[58vh]` (`:626`) peut rendre la rangée **plus courte** que son
plus grand enfant (la figure, dérivée d'un `aspect-ratio`, ou la fiche, dérivée
de son contenu) sans qu'aucune règle ne le clippe — le contenu déborde
silencieusement sur les frères suivants dans le flux. **Ce n'est plus une
fiche à border individuellement** (la première passe de ce document le
proposait ; devenu inutile, §4.2 de la spec) : le correctif attendu est que la
rangée rende toujours la hauteur réelle de son plus grand enfant, et que
`workbench:overflow-y-auto` — déjà posé sur la section, jusqu'ici sans effet
utile — absorbe le reste si le total dépasse la fenêtre.

**Relevé AVANT correction — chevauchement mesuré sur `main`, paires nommées**
(reconcilié entre l'orchestrateur et l'implémenteur de la phase 1, deux
méthodes indépendantes, `deviceScaleFactor=1`, `domcontentloaded` + 3,5 s de
repos, clip `2026-03-08-caro-mdlm_005472883-005518477`) :

| Paire | 2560×1320 | 1920×1080 |
|---|---|---|
| `figure` (source) vs le bloc transport (`ClipTransport`, frère suivant) | **28 px** | **28 px** |
| `figure` (source) vs le conteneur de la bande (`Timeline`, second frère) | 0 | **32 px** |
| `figure` (source) vs l'onglet `role="tab"` « Temps » | 0 | **25 px** |
| `figure` (source) vs le ruban `[data-testid="filmstrip"]` | 0 | 0 |

Ce tableau est la référence de régression de cette tâche — pas à reproduire
à l'identique en aveugle (le DOM aura changé après la #286), mais chaque paire
doit repasser par un relevé après correction, à ces deux viewports.

- [ ] **Step 1: Write the failing test (structure, pas géométrie)**

jsdom ne peut pas mesurer un vrai débordement — `getBoundingClientRect` y rend
des zéros. Ce test pin seulement la structure attendue (les classes qui
causaient le bug ont disparu) ; la géométrie réelle se vérifie au Step 5, dans
un vrai navigateur, et c'est **cette étape-là qui fait foi**.

```tsx
it('ne pose plus items-start ni max-h-[58vh] sur la rangée source+fiche', () => {
  mount(detail())

  const image = screen.getByRole('region', { name: 'Image' })
  const row = within(image).getByLabelText('Titre').closest('[data-slot="source-row"]')
  expect(row?.className).not.toMatch(/items-start/)
  expect(row?.className).not.toMatch(/max-h-\[58vh\]/)
})
```

`data-slot="source-row"` est un ajout : la rangée n'avait jusqu'ici pas
d'identifiant propre.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/clip/clip-screen.test.tsx -t 'items-start'`
Expected: FAIL — les deux classes sont encore présentes.

- [ ] **Step 3: Write minimal implementation**

Dans `clip-screen.tsx`, la rangée (`:626`) :

```tsx
<div
  data-slot="source-row"
  className="flex min-h-0 flex-wrap items-stretch gap-4 workbench:flex-nowrap"
>
```

`items-stretch` remplace `items-start` : les deux enfants (figure, fiche)
reçoivent alors la même hauteur, celle du plus grand, au lieu que la rangée se
mesure à une valeur indépendante d'eux. **Si `items-stretch` produit un effet
de bord** (par exemple la fiche étirée à une hauteur qu'elle ne remplit pas,
avec un vide visuel) — à vérifier au Step 5 — la disposition de repli est de
séparer le calcul de hauteur du `flex-wrap` : par exemple poser la figure et
la fiche en `grid grid-template-columns` plutôt qu'en `flex`, une disposition
où la hauteur de ligne ne dépend pas de l'ordre de résolution entre
`aspect-ratio` et le calcul de flexbox. **Le choix exact entre les deux
options est à trancher ici, au Step 5, sur ce qui se mesure réellement — pas
à deviner avant.**

`max-h-[58vh]` disparaît sans remplacement (§4.1 de la spec — pas de
`calc(100dvh - X)`, aucune variable CSS à poser).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/components/clip/clip-screen.test.tsx`
Expected: PASS.

- [ ] **Step 5: Mesurer dans un vrai navigateur — condition de recette, pas un confort**

```bash
pnpm dev &
```

Avec Playwright (voir la méthode au §1 de la spec jumelle) ou un Chrome piloté
depuis WSL, reprendre **exactement les quatre paires du tableau AVANT**, aux
mêmes deux viewports, plus le viewport plancher du seuil recalculé en tâche 2 :

```js
const rectOf = (el) => el ? el.getBoundingClientRect() : null
const overlap = (a, b) => (!a || !b) ? null : Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))

const image = document.querySelector('[aria-labelledby="zone-image"]')
const figure = image.querySelector('[data-slot="source-row"] figure')
const transport = image.querySelector('[data-slot="source-row"]').nextElementSibling
const band = transport.nextElementSibling
const tab = Array.from(band.querySelectorAll('[role="tab"]')).find((t) => /Temps/.test(t.textContent))
const filmstrip = band.querySelector('[data-testid="filmstrip"]')

;({
  'figure vs transport': overlap(rectOf(figure), rectOf(transport)),
  'figure vs bande': overlap(rectOf(figure), rectOf(band)),
  'figure vs onglet Temps': overlap(rectOf(figure), rectOf(tab)),
  'figure vs ruban': overlap(rectOf(figure), rectOf(filmstrip)),
})
```

Attendu, aux deux viewports larges et au plancher du seuil : **les quatre
valeurs à 0.** Une valeur positive est le lot qui n'a pas été fait.

**Vérifier aussi que le défilement engagé fonctionne**, pas seulement qu'il ne
reste plus de chevauchement : allonger artificiellement la description du
clip de test (plusieurs paragraphes) et confirmer que
`document.querySelector('[aria-labelledby="zone-image"]').scrollHeight` dépasse
son `clientHeight` — c'est `workbench:overflow-y-auto`, déjà présent, qui doit
absorber le supplément, sans qu'aucun élément ne déborde sur son voisin en
chemin.

- [ ] **Step 6: Commit**

```bash
git add src/components/clip/clip-screen.tsx tests/components/clip/clip-screen.test.tsx
git commit -m "fix(clip): make the source row report its true height instead of overflowing its children"
```

---

### Task 2 : Recalculer et documenter le seuil `workbench` sur la question affaiblie

**Indépendante des tâches 1, 3 et 5** — elle ne touche pas `clip-screen.tsx`
ni `timeline.tsx`, et le chiffre qu'elle pose (chrome au-dessus de `main`,
plus une hauteur de sortie 9:16 jugée confortable) ne dépend d'aucune des
trois. Peut donc s'exécuter à tout moment après la fusion de la #286, sans
attendre les autres tâches de ce plan.

**Files:**
- Modify: `src/app/globals.css` — le commentaire et la déclaration `:8-30`.

**Interfaces:**
- Produces: rien de nouveau — **pas de `--image-column-chrome`** : cette
  variable n'a plus d'objet, la rangée ne calcule plus sa hauteur contre un
  budget (tâche 1).

**Ce que le seuil décide a changé** (§3.4 de la spec jumelle) : il ne
garantit plus que tout le volet gauche tient sans défiler — le défilement
s'en charge (tâche 1). Il décide seulement si la fenêtre donne à la sortie
9:16 une taille qui vaut la peine d'un affichage à deux colonnes plutôt qu'une
colonne unique empilée.

**Ne pas relever le seuil sans le recalculer, et ne jamais le remplacer par une
container query** — les deux raisons sont écrites en toutes lettres au §3.5 de
la spec jumelle ; les reproduire ici referait dériver le commentaire du code
loin de sa justification.

- [ ] **Step 1: Vérifier le chrome mesuré, indépendant de la largeur**

Reprendre le relevé du §3.4 de la spec jumelle dans le DOM réel : barre d'app
(48), fresque des clips (146), remplissage vertical de `main` (32) — ces trois
valeurs ne dépendent d'aucune tâche de ce plan, elles se revérifient telles
quelles. Somme attendue : **226 px**.

- [ ] **Step 2: Confirmer ou ajuster le chiffre de confort avec le propriétaire**

Le seuil de la spec (§3.4) pose 400 px comme hauteur de sortie 9:16 « en
dessous de laquelle un aperçu vertical cesse de rendre service » — **un
jugement, pas un calcul**, écrit comme tel dans la spec. Avant d'écrire la
valeur dans le code, confirmer ce chiffre avec le propriétaire plutôt que de
le figer silencieusement : c'est la seule donnée non mesurée de ce calcul.

- [ ] **Step 3: Poser la valeur et mettre à jour le commentaire**

```css
/**
 * L'établi de l'écran de clip. Deux colonnes côte à côte, à condition que la
 * sortie 9:16 y ait une taille qui vaille le coup — plus, depuis
 * l'amendement du 30 août (nuit), la garantie que tout tienne sans défiler :
 * le volet gauche défile au besoin (`workbench:overflow-y-auto`,
 * `clip-screen.tsx:615`).
 *
 * **Recalculé le 30 août 2026** (spec `2026-08-30-hierarchie-ecran-clip-design.md`,
 * §3.4) : 226 px de chrome fixe au-dessus de `main` (barre d'app, fresque des
 * clips, remplissage), mesurés et robustes à la largeur, plus 400 px jugés
 * confortables pour la sortie 9:16 — un choix, pas une dérivation, à
 * resserrer ou desserrer sans que rien d'autre n'en dépende. Seuil : 640 px,
 * arrondi. **Choisi pour rester sous un 1080p réel** (~937 px de hauteur
 * utile mesurés, fenêtre et barre des tâches Windows déduites) — le volet
 * fixe à deux colonnes y est donc atteignable, contrairement au seuil de
 * 1000 px qu'il remplace.
 */
@custom-variant workbench (@media (min-width: 1024px) and (min-height: 640px));
```

Remplacer `640` si le Step 2 a mené à une autre valeur de confort — ne pas
recopier ce chiffre sans l'avoir confirmé.

- [ ] **Step 4: Run the suite**

Run: `pnpm lint && pnpm type-check && pnpm test`
Expected: PASS. `tests/components/brand-contrast.test.ts` n'est pas concerné,
mais reste dans le filet de la commande.

- [ ] **Step 5: Vérifier le point de bascule dans un vrai navigateur**

```js
matchMedia('(min-width: 1024px) and (min-height: 640px)').matches
```

Attendu : `false` à 1024×639, `true` à 1024×640, et `true` à 1920×937 (un
1080p réel) — ce dernier point est le critère de recette de tout ce chantier
sur la question du seuil.

- [ ] **Step 6: Commit**

```bash
git add src/app/globals.css
git commit -m "fix(clip): recompute the workbench threshold on whether the output pane is worth it"
```

---

### Task 3 : Grouper en cartes, fusionner la ligne d'outils

**Files:**
- Modify: `src/components/clip/clip-screen.tsx` — repères à revérifier après
  rebase sur la #286 et après la tâche 1 (qui touche la même rangée).
- Test: `tests/components/clip/clip-screen.test.tsx`

**Interfaces:**
- Consumes: `RatioPicker`, `FramingFields`, `RenderSettings` — signatures
  inchangées, seul leur emplacement dans le JSX bouge.
- Produces: rien de nouveau.

**Ce qui bouge : l'emballage, pas le contenu.** Voir §2.1-§2.3 de la spec
jumelle. Trois `<div className="shrink-0">` (`:692-703` et `:715-721`, plus le
message d'état vide `:705-713` qui reste conditionnel et hors carte) deviennent
une seule rangée `flex flex-wrap items-center gap-x-3`.

- [ ] **Step 1: Write the failing test**

```tsx
it('pose ratio, montage et rendu sur une seule rangée d’outils', () => {
  mount(detail())

  const tools = screen.getByRole('region', { name: 'Outils de cadrage' })
  expect(within(tools).getByRole('radio', { name: 'auto' })).toBeInTheDocument()
  expect(within(tools).getByRole('button', { name: /forcer un cadrage/i })).toBeInTheDocument()
  expect(within(tools).getByRole('button', { name: /réglages du rendu/i })).toBeInTheDocument()
})

it('donne à la carte Source et à la carte Montage une bordure et un rôle propres', () => {
  mount(detail())

  expect(screen.getByRole('group', { name: 'Source' })).toBeInTheDocument()
  expect(screen.getByRole('group', { name: 'Montage' })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/clip/clip-screen.test.tsx -t 'rangée d’outils'`
Expected: FAIL — les trois blocs sont encore séparés, sans `role="region"`
commun.

- [ ] **Step 3: Write minimal implementation**

```tsx
<div role="region" aria-label="Outils de cadrage" className="flex flex-wrap items-center gap-x-3 gap-y-1">
  <RatioPicker framing={framing} ratio={editor.ratio} onRatio={editor.chooseRatio} cropReasonId={cropReasonId} />
  <FramingFields clip={clip} globals={framingGlobals} framing={framing} onWrite={write} />
  <RenderSettings clip={clip} onBranding={(b) => write({ branding: b })} onCaptions={(c) => write({ captions: c })} />
</div>
```

`RatioPicker` porte déjà `flex flex-wrap items-center gap-x-3 gap-y-1`
(`crop-picker.tsx:378`) — vérifier au Step 5 que l'imbrication ne double pas
l'espacement, et retirer l'un des deux niveaux si c'est le cas.

Envelopper la rangée source+fiche+transport de la tâche 1
(`[data-slot="source-row"]` et le transport qui le suit) dans
`<div role="group" aria-label="Source" className="rounded-lg border p-4">`,
et la bande (et, après la tâche 5, le panneau transcript) dans
`<div role="group" aria-label="Montage" className="rounded-lg border p-4">`.
Le message d'état vide (`:705-713`) reste hors des deux cartes, entre elles,
comme aujourd'hui.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/components/clip/`
Expected: PASS.

- [ ] **Step 5: Relevé de chevauchement — les bordures ne doivent rien toucher**

Nouvelle paire à surveiller, introduite par cette tâche : les cartes ajoutent
un remplissage (`p-4`) et une bordure autour de contenu qui, avant, touchait
directement les bords de la section. Reprendre la méthode de la tâche 1,
avec ces paires-ci, à 1920×1080 et 2560×1320 :

```js
const rectOf = (el) => el ? el.getBoundingClientRect() : null
const overlap = (a, b) => (!a || !b) ? null : Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))

const sourceCard = document.querySelector('[role="group"][aria-label="Source"]')
const montageCard = document.querySelector('[role="group"][aria-label="Montage"]')
const tools = document.querySelector('[role="region"][aria-label="Outils de cadrage"]')

;({
  'carte Source vs carte Montage': overlap(rectOf(sourceCard), rectOf(montageCard)),
  'carte Montage vs ligne d’outils': overlap(rectOf(montageCard), rectOf(tools)),
  // Les deux paires de la tâche 1, à revérifier : les cartes ne doivent pas
  // réintroduire le bug en changeant le contexte de la rangée.
  'figure vs transport (dans la carte Source)': overlap(
    rectOf(sourceCard.querySelector('figure')),
    rectOf(sourceCard.querySelector('[data-slot="source-row"]').nextElementSibling),
  ),
})
```

Attendu : les trois valeurs à 0, aux deux viewports.

- [ ] **Step 6: Commit**

```bash
git add src/components/clip/clip-screen.tsx tests/components/clip/clip-screen.test.tsx
git commit -m "feat(clip): group the image column into bordered cards and one tools row"
```

---

### Task 4 : Retirer le pourcentage sans objet sur split et doublage

**Files:**
- Modify: `src/components/clip/output-preview.tsx` — la légende, `:353-359`.
- Test: `tests/components/clip/output-preview.test.tsx` (ou le fichier
  existant qui couvre `PreviewOutput`, à vérifier — pas de fichier de ce nom
  trouvé en phase 1, à créer si besoin).

**Interfaces:**
- Consumes: `split`, `dubbing`, `part`, `effective` — variables locales
  existantes de `PreviewOutput`, aucune signature ne change.

**Ce que ça corrige** : §1.3 et §4.4 de la spec jumelle — `part` vaut toujours
1 en split ou en doublage, donc le pourcentage affiché est constant, jamais une
mesure, et c'est une annonce de pourcentage de crop sur un plan où le rendu
n'en suit aucun — la contrainte absolue de ce chantier, rompue en direct sur le
clip de référence.

**Ne change aucune géométrie** — c'est un texte, pas une mise en page. Pas de
relevé de chevauchement dû pour cette tâche.

- [ ] **Step 1: Write the failing test**

```tsx
it('ne montre pas de pourcentage sur un plan split ou doublage', () => {
  const cells = dubbingCellsFor(DUBBING_ANCHORS[0], DUBBING_ANCHORS[0].pip.y0)
  render(
    <PreviewOutput
      video={null}
      framing={framing({ shots: [shot(0, 200, '4:5', 0.5, 'auto', undefined, cells)] })}
      ratio="auto"
      cropX={0.5}
      frame=""
      figureClassName=""
      segments={[{ start: 0, end: 10 }]}
    />,
  )

  const caption = screen.getByText(/cadre doublage/).closest('figcaption')
  expect(caption?.textContent).not.toMatch(/%/)
})

it('garde le pourcentage sur un plan cadré normalement', () => {
  render(
    <PreviewOutput
      video={null}
      framing={framing({ shots: [shot(0, 200, '4:5', 0.5)] })}
      ratio="auto"
      cropX={0.5}
      frame=""
      figureClassName=""
      segments={[{ start: 0, end: 10 }]}
    />,
  )

  expect(screen.getByText(/%/)).toBeInTheDocument()
})
```

Adapter les imports (`dubbingCellsFor`, `DUBBING_ANCHORS`, `framing`, `shot`)
à ceux déjà utilisés par `clip-screen.test.tsx` pour les mêmes fixtures — ne
pas les dupliquer, les importer depuis leur module partagé si un existe déjà,
sinon l'extraire à cette occasion.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/clip/output-preview.test.tsx -t 'sans objet'`
Expected: FAIL — le `%` est toujours affiché.

- [ ] **Step 3: Write minimal implementation**

```tsx
<figcaption className="shrink-0 truncate text-[0.75rem] text-muted-foreground">
  {isVariant ? 'variante 9:16' : 'fichier natif 9:16'} ·{' '}
  {split === undefined && dubbing === undefined && (
    <>
      <span className="font-mono tabular-nums">{Math.round(part * 100)} %</span> ·{' '}
    </>
  )}
  cadre{' '}
  <span className="font-mono">
    {split !== undefined ? 'split' : dubbing !== undefined ? 'doublage' : effective}
  </span>
</figcaption>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/components/clip/`
Expected: PASS, y compris `clip-screen.test.tsx:236-255` qui ne cherche que
« cadre split »/« cadre doublage », jamais le `%` — ce test ne peut donc pas
casser.

- [ ] **Step 5: Commit**

```bash
git add src/components/clip/output-preview.tsx tests/
git commit -m "fix(clip): drop the meaningless crop percentage on split and dubbing shots"
```

---

### Task 5 : La bande et le transcript coexistent, sans condition de seuil

**Amendé le 30 août (nuit)** : la version précédente de cette tâche
conditionnait la coexistence au seuil `workbench` (visible au-dessus,
bascule exclusive en dessous). **Cette condition tombe** — le défilement
étant acceptable partout (tâche 1), la raison de la réserver à un régime
disparaît avec elle. Bande et transcript coexistent **toujours**, que
l'écran affiche deux colonnes ou une seule qui défile.

Exécuter après la tâche 3 (les deux touchent la structure de la carte
Montage) ; indépendante de la tâche 2.

**Files:**
- Modify: `src/components/clip/timeline.tsx` — le `Tabs`/`TabsContent`
  `:294-318`, à supprimer.
- Modify: `src/components/clip/shortcuts.tsx` — le raccourci `Ctrl+F`,
  `:172` (repère à revérifier après rebase).
- Test: `tests/components/clip/timeline.test.tsx`

**Interfaces:**
- Consumes: `TranscriptDrawer`/`TranscriptSurface` — signature inchangée,
  seul l'emplacement où elle est montée change.
- Produces: rien de nouveau côté données ; côté rendu, le panneau transcript
  n'est plus conditionné par `mode` ni par la variante `workbench` — il est
  toujours monté.

**Ce que ça corrige** : §2.5 de la spec jumelle — basculer sur « Mots »
démonte aujourd'hui la bande entière (ruban, oreilles, tête de lecture), donc
perd tout repère temporel pendant qu'on choisit un mot. Vérifié à la main sur
`main` avant ce chantier : `role="slider"` passe de 3 à 0 lors du basculement.

**Borner le panneau transcript, pour une raison de confort — plus de budget à
tenir** (§2.5 de la spec) : ~150 px avec défilement interne, pour que la carte
Montage garde une forme stable d'un clip à l'autre plutôt que de grandir avec
la durée du clip. Vérifié sur le clip le plus long de l'émission
(`2026-03-08-caro-mdlm_007212212-007300496`, 88,3 s, 284 mots) : son panneau
non borné mesure 287 px.

- [ ] **Step 1: Write the failing test**

```tsx
it('garde la bande visible en mode Mots', () => {
  render(<Timeline {...props()} />)

  expect(screen.getByTestId('filmstrip')).toBeInTheDocument()
  expect(screen.getAllByRole('slider')).toHaveLength(3)
  expect(screen.getByRole('group', { name: 'Transcript du clip' })).toBeInTheDocument()
})

it('borne le panneau transcript en hauteur, avec défilement interne', () => {
  render(<Timeline {...props({ words: longClipWords() /* 284 mots, fixture du clip le plus long */ })} />)

  const panel = screen.getByRole('group', { name: 'Transcript du clip' })
  expect(panel).toHaveClass('overflow-y-auto')
})
```

Pas de test « sous le seuil, la bascule reste exclusive » — cette
distinction n'existe plus. Si `tests/components/clip/timeline.test.tsx`
porte encore un tel test de la version précédente de ce plan, le supprimer
ici plutôt que de le laisser rouge.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/clip/timeline.test.tsx -t 'visible en mode Mots'`
Expected: FAIL — le ruban et les oreilles disparaissent au basculement.

- [ ] **Step 3: Write minimal implementation**

Remplacer le `Tabs` exclusif par les deux blocs toujours montés :

```tsx
<div className="flex flex-col gap-1">
  <div className="flex items-center gap-3 text-[0.75rem] text-muted-foreground">
    <button type="button" onClick={() => bandRef.current?.scrollIntoView({ block: 'nearest' })}>
      <span aria-hidden>◷</span> Temps
    </button>
    <button type="button" onClick={() => transcriptRef.current?.querySelector('input')?.focus()}>
      <span aria-hidden>❞</span> Mots
    </button>
  </div>
  <div ref={bandRef}>{/* ruban, piste, oreilles, pied — contenu actuel du panneau Temps, inchangé */}</div>
  <div
    ref={transcriptRef}
    role="group"
    aria-label="Transcript du clip"
    className="max-h-[150px] overflow-y-auto"
  >
    <TranscriptDrawer clipId={clipId} lines={lines} words={words} firstLine={firstLine} duration={duration} search={search} onSearch={onSearch} onPlay={onPlay} />
  </div>
</div>
```

Les deux boutons `Temps`/`Mots` ne pilotent plus un état `mode` — ils
défilent et focalisent, rien de plus ; `mode` et `BandMode` disparaissent du
composant si plus rien ne les lit.

Dans `shortcuts.tsx`, le geste de `Ctrl+F` (`:172` et son appel
`clip-screen.tsx:314-317`) focalise toujours le champ de recherche du panneau
transcript, désormais monté en permanence — plus de branche conditionnelle.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/components/clip/`
Expected: PASS.

- [ ] **Step 5: Relevé de chevauchement, sur le clip le plus long**

```bash
pnpm dev &
```

Ouvrir `http://localhost:4014/clips/2026-03-08-caro-mdlm_007212212-007300496`
(88,3 s, 284 mots) à 1920×1080 et 2560×1320. Nommer les paires :

```js
const rectOf = (el) => el ? el.getBoundingClientRect() : null
const overlap = (a, b) => (!a || !b) ? null : Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))

const montageCard = document.querySelector('[role="group"][aria-label="Montage"]')
const band = montageCard.querySelector('[data-testid="filmstrip"]').closest('div')
const transcript = document.querySelector('[role="group"][aria-label="Transcript du clip"]')
const tools = document.querySelector('[role="region"][aria-label="Outils de cadrage"]')

;({
  'panneau transcript vs bande': overlap(rectOf(transcript), rectOf(band)),
  'panneau transcript vs ligne d’outils': overlap(rectOf(transcript), rectOf(tools)),
  'carte Montage vs ligne d’outils (revérifié après ajout du panneau)': overlap(rectOf(montageCard), rectOf(tools)),
})
```

Attendu : les trois valeurs à 0, aux deux viewports — et le panneau
transcript défile en interne (`transcript.scrollHeight > transcript.clientHeight`)
plutôt que de pousser la carte Montage plus bas que sa hauteur normale.

- [ ] **Step 6: Commit**

```bash
git add src/components/clip/timeline.tsx src/components/clip/shortcuts.tsx tests/components/clip/timeline.test.tsx
git commit -m "feat(clip): keep the band and the transcript both visible at all times"
```

---

## Recette finale

Devant l'écran rendu, à 2560 × 1320, 1920 × 1080 et 1024 × 640 (le seuil
recalculé) :

1. **Zéro sur toutes les paires nommées des tâches 1, 3 et 5** — figure vs
   transport, figure vs bande, figure vs onglet Temps, figure vs ruban, carte
   Source vs carte Montage, carte Montage vs ligne d'outils, panneau
   transcript vs bande, panneau transcript vs ligne d'outils. Mesuré par
   `getBoundingClientRect`, jamais par capture d'écran seule (une capture
   confirme, elle ne mesure pas).
2. `matchMedia('(min-width: 1024px) and (min-height: 640px)')` vaut `true` à
   1920×937 (un 1080p réel, chrome de fenêtre déduit) — le critère de recette
   du seuil.
3. La colonne Image montre visuellement trois blocs distincts (Source,
   Montage, Outils), chacun avec une bordure — la question du §8 de la spec du
   28 août (« un inconnu peut-il dire en trois secondes ce qu'on vient faire
   ici ? ») se repose, humaine, non tranchée automatiquement.
4. Sur le clip de référence (un plan de doublage), la légende du viseur ne
   contient aucun `%`.
5. La bande (ruban, oreilles, tête de lecture) et le panneau transcript sont
   visibles ensemble, à tout moment, à toute hauteur de fenêtre — pas
   seulement au-dessus d'un seuil. Sur le clip le plus long
   (`007212212-007300496`, 284 mots), le panneau transcript défile en
   interne sans repousser la ligne d'outils.
6. Le seuil `workbench` recalculé (tâche 2) est documenté dans `globals.css`
   avec la somme qui le justifie — un chiffre qui n'a pas de calcul à côté
   est un chiffre deviné, pas mesuré.

Puis mettre à jour la spec jumelle : son statut passe d'« arrêté » à
« implémenté », et ses chiffres estimés (§3.2 : +52 px sur le chrome ; §3.4 :
226 px de chrome mesuré, 400 px de confort choisi) se reprennent contre les
chiffres mesurés dans le DOM réel. Un chiffre qui n'a pas bougé de la case
« estimé »/« choisi » à la case « mesuré » est un lot qui n'a pas été
vérifié.
