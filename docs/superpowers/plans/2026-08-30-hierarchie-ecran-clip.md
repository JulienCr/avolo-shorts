# La hiérarchie du volet Image — plan d'implémentation (phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Ne pas démarrer avant que les deux conditions suivantes tiennent :**

1. **La PR #286 est fusionnée** sur `main`. Elle porte `clip-screen.tsx` et
   `timeline.tsx`, deux fichiers que ce plan modifie ; brancher avant sa fusion
   perdrait sa fusion de Segments/Cadre dans le pied de bande dans un merge
   sans conflit — même risque, même leçon que la #270 le 28 août.
2. **Le document jumeau,
   [`docs/superpowers/specs/2026-08-30-hierarchie-ecran-clip-design.md`](../specs/2026-08-30-hierarchie-ecran-clip-design.md),
   est approuvé par le propriétaire** — en particulier son §4.2 (la fiche
   éditoriale défile désormais en interne plutôt que de pousser la rangée) et
   son §3.4 (garder le seuil à 1000 px, avec l'option à 904 px en réserve).

**Rebaser sur le nouveau `main` avant de commencer**, et revérifier chaque
repère de ligne cité ici contre le code réel — ce plan a été écrit contre
`02c66ba`, avant la #286 ; ses propres numéros de ligne auront dérivé, comme
ceux du contrat qui a lancé ce chantier ont déjà dérivé une fois (§1.4 de la
spec jumelle).

**Goal:** Régler le débordement mesuré de la rangée source+fiche, redonner un
sens vérifié au seuil `workbench`, grouper la colonne Image en cartes lisibles,
et retirer le pourcentage sans objet affiché sur un plan split ou doublage.

**Architecture:** Trois blocs verticaux dans la colonne Image — Carte Source
(figure + fiche bornée en défilement interne + transport), Carte Montage
(la bande, inchangée dans son contenu), Ligne d'outils (ratio, réglages
montage, réglages rendu fusionnés). La colonne droite (sortie 9:16) ne change
pas.

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
- **Livraison** : un worktree isolé branché depuis le HEAD local, une PR, puis
  la skill `check-reviews` avant le merge.

## File Structure

| Fichier | Responsabilité | Tâche |
|---|---|---|
| `src/components/clip/clip-screen.tsx` | modifié — bornage de la fiche, cartes, fusion de la ligne d'outils | 1, 3 |
| `src/app/globals.css` | modifié — la valeur et le commentaire du seuil `workbench` | 2 |
| `src/components/clip/output-preview.tsx` | modifié — retire le pourcentage sur split/doublage | 4 |
| `src/components/clip/timeline.tsx` | modifié — panneau transcript borné, coexistence au-dessus du seuil | 5 |
| `src/components/clip/shortcuts.tsx` | modifié — `Ctrl+F` fait défiler/focaliser au lieu de basculer, au-dessus du seuil | 5 |
| `tests/components/clip/clip-screen.test.tsx` | modifié — nouvelles assertions de non-chevauchement et de structure | 1, 3 |
| `tests/components/clip/output-preview.test.tsx` | modifié — assertions sur la légende split/doublage | 4 |
| `tests/components/clip/timeline.test.tsx` | modifié — coexistence au-dessus du seuil, bascule conservée en dessous | 5 |

---

### Task 1 : Borner la fiche éditoriale, calculer la hauteur de la rangée

**Files:**
- Modify: `src/components/clip/clip-screen.tsx` — repères à revérifier après
  rebase, relevés le 30 août sur `02c66ba` : la rangée `:626`, la figure
  `:627-646`, le conteneur de la fiche `:648-656`.
- Test: `tests/components/clip/clip-screen.test.tsx`

**Interfaces:**
- Consumes: rien de nouveau.
- Produces: rien de nouveau — c'est une correction de mise en page, pas une
  nouvelle interface.

**Ce que ça corrige** : le débordement mesuré au §1.1 de la spec jumelle — la
fiche (470 px de contenu naturel) et la figure (dérivée d'un `aspect-ratio`)
peuvent chacune dépasser la hauteur que leur accorde la rangée, sans qu'aucune
règle CSS ne les retienne aujourd'hui.

- [ ] **Step 1: Write the failing test**

Un test de non-chevauchement, en jsdom cette fois **seulement pour vérifier la
présence des classes attendues** — jsdom ne peut pas mesurer un vrai
débordement (`getBoundingClientRect` y rend des zéros), donc ce test vérifie la
**structure** (les bonnes classes sont posées), pas la géométrie. La géométrie
se vérifie à la main, en Step 5.

```tsx
it('borne la fiche en hauteur avec son propre défilement, pas celui de la rangée', () => {
  mount(detail())

  const image = screen.getByRole('region', { name: 'Image' })
  const ficheContainer = within(image).getByLabelText('Titre').closest('[data-slot="fiche-editoriale"]')
  expect(ficheContainer).toHaveClass('overflow-y-auto')
})
```

`data-slot="fiche-editoriale"` est un ajout : le conteneur de la fiche n'avait
jusqu'ici pas d'identifiant propre, seulement des classes de layout.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/clip/clip-screen.test.tsx -t 'borne la fiche'`
Expected: FAIL — la classe n'existe pas encore.

- [ ] **Step 3: Write minimal implementation**

Dans `clip-screen.tsx`, le conteneur de la fiche (aujourd'hui
`<div className="flex min-w-0 shrink-0 flex-col gap-3 workbench:w-[clamp(360px,30cqw,620px)]">`,
`:648`) devient :

```tsx
<div
  data-slot="fiche-editoriale"
  className="flex min-w-0 shrink-0 flex-col gap-3 overflow-y-auto workbench:h-full workbench:w-[clamp(360px,30cqw,620px)]"
>
```

La figure garde son overflow en filet de sécurité — jamais le mécanisme
principal, voir §2.1 de la spec :

```tsx
<figure className="flex min-w-0 flex-1 flex-col gap-1.5 overflow-hidden">
```

La rangée elle-même (`:626`) remplace `workbench:max-h-[58vh]` par une valeur
calculée contre le chrome fixe réel de la tâche 2 :

```tsx
className="flex min-h-0 flex-wrap items-start gap-4 workbench:flex-nowrap workbench:max-h-[calc(100dvh-var(--image-column-chrome))]"
```

`--image-column-chrome` est posée en tâche 2, à côté de la constante du seuil,
pour que les deux valeurs se lisent et se corrigent ensemble.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/components/clip/clip-screen.test.tsx`
Expected: PASS.

- [ ] **Step 5: Mesurer dans un vrai navigateur — condition de recette, pas un confort**

```bash
pnpm dev &
```

Avec Playwright (voir la méthode au §1 de la spec jumelle) ou un Chrome piloté
depuis WSL :

```js
const rectOf = (sel) => {
  const el = document.querySelector(sel)
  const r = el.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, height: r.height }
}
const row = rectOf('[data-slot="fiche-editoriale"]').top // point de départ
;({
  ficheOverflowsRow: (() => {
    const row = document.querySelector('[aria-labelledby="zone-image"] > div:nth-child(2)')
    const fiche = document.querySelector('[data-slot="fiche-editoriale"]')
    return fiche.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom
  })(),
  figureOverlapsTransport: (() => {
    const fig = document.querySelector('[aria-labelledby="zone-image"] figure').getBoundingClientRect()
    const transport = document.querySelector('[aria-labelledby="zone-image"] > div:nth-child(3)').getBoundingClientRect()
    return Math.max(0, Math.min(fig.bottom, transport.bottom) - Math.max(fig.top, transport.top))
  })(),
})
```

Attendu, à 2560 × 1320, 1920 × 1080 et 1024 × 1000 (le plancher) : les deux
valeurs à **0**. Une valeur positive est le lot qui n'a pas été fait — pas un
détail à ajuster après coup.

- [ ] **Step 6: Commit**

```bash
git add src/components/clip/clip-screen.tsx tests/components/clip/clip-screen.test.tsx
git commit -m "fix(clip): bound the editorial card's height instead of letting it overflow the row"
```

---

### Task 2 : Recalculer et documenter le seuil `workbench`

**À exécuter en dernier, après les tâches 3 et 5** — pas dans l'ordre de
numérotation. Le chiffre dépend du DOM des cartes (tâche 3) **et** du panneau
transcript (tâche 5) ; la mesurer avant l'un des deux referait exactement
l'erreur du 23 août — un budget fixé avant que tout ce qu'il doit porter
n'existe. Le numéro de tâche reste 2 pour que le nom de fichier et l'historique
de commit suivent l'ordre du plan ; l'ordre d'exécution réel est 1, 3, 5, 2, 4
(la tâche 4 est indépendante des trois autres et peut partir à tout moment).

**Files:**
- Modify: `src/app/globals.css` — le commentaire et la déclaration `:8-30`.

**Interfaces:**
- Produces: `--image-column-chrome`, une variable CSS consommée par la tâche 1.

**Ne pas relever le seuil sans le recalculer, et ne jamais le remplacer par une
container query** — les deux raisons sont écrites en toutes lettres au §3.5 de
la spec jumelle ; les reproduire ici referait dériver le commentaire du code
loin de sa justification, exactement le problème que ce chantier corrige
ailleurs.

**Trancher d'abord le choix du §3.6 de la spec jumelle avec le propriétaire**
— seuil relevé à ~1170-1200 px (la coexistence prime, le volet fixe se réserve
aux grands écrans), ou panneau transcript réduit sous 150 px pour limiter la
hausse. Ce plan suppose la première option ; si le propriétaire choisit la
seconde, le Step 2 en reprend l'arithmétique avec le panneau réduit.

- [ ] **Step 1: Mesurer le chrome réel de la nouvelle mise en page, transcript compris**

Une fois les tâches 3 (les cartes) et 5 (le panneau transcript) posées,
reprendre la méthode du §3.1 et du §3.6 de la spec jumelle : sommer barre
d'app, fresque, remplissage de `main`, transport, carte Montage (bande +
panneau transcript borné), ligne d'outils fusionnée, et les espacements —
**dans le vrai DOM construit**, pas en recopiant les estimations des §3.2 et
§3.6 de la spec (respectivement +52 px et +166 px, à confirmer ou corriger
ici).

- [ ] **Step 2: Poser la variable et mettre à jour le commentaire**

```css
/**
 * L'établi de l'écran de clip. Deux volets fixes, à condition d'avoir la
 * place — la largeur seule ne suffit pas, voir le commentaire original du
 * 23 août pour le raisonnement complet.
 *
 * **Recalculé le 30 août 2026** (spec `2026-08-30-hierarchie-ecran-clip-design.md`,
 * §3.1-§3.6), après le ruban de bande, la fusion de la ligne d'outils et le
 * panneau transcript permanent (§2.5) : <SOMME MESURÉE> px de chrome fixe à
 * 1024 px de large (le plancher du seuil, pas 1416 — c'est là que la fiche
 * mange le plus de place face à la figure), plus une figure jugée confortable
 * à 347 px de haut. **Ce seuil ne s'atteint plus sur un écran 1080p réel**
 * (~937 px de hauteur utile mesurés) — choix assumé au §3.6 de la spec :
 * la coexistence bande/transcript prime sur la couverture du seuil. En
 * dessous, l'écran repasse en colonne qui défile, bascule Temps/Mots
 * comprise (§2.5).
 */
@custom-variant workbench (@media (min-width: 1024px) and (min-height: <SEUIL>px));
```

Remplacer `<SOMME MESURÉE>` et `<SEUIL>` par les valeurs relevées en Step 1 —
**jamais recopier le 1001 estimé de la spec sans le revérifier contre le DOM
réel**, exactement le défaut que ce chantier reproche au budget du 28 août.

Poser `--image-column-chrome` dans le même bloc, à la même valeur que le calcul
du seuil moins la marge accordée à la rangée (`<SOMME MESURÉE>`, en `px`) :

```css
@theme inline {
  --image-column-chrome: <SOMME MESURÉE>px;
}
```

- [ ] **Step 3: Run the suite**

Run: `pnpm lint && pnpm type-check && pnpm test`
Expected: PASS. `tests/components/brand-contrast.test.ts` n'est pas concerné
par ce changement, mais reste dans le filet de la commande.

- [ ] **Step 4: Commit**

```bash
git add src/app/globals.css
git commit -m "fix(clip): recompute the workbench threshold against the merged layout"
```

---

### Task 3 : Grouper en cartes, fusionner la ligne d'outils

**Files:**
- Modify: `src/components/clip/clip-screen.tsx` — repères à revérifier après
  rebase sur la #286.
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

Envelopper la figure+fiche+transport dans un `<div role="group" aria-label="Source" className="rounded-lg border p-4">`, et la bande dans un `<div role="group" aria-label="Montage" className="rounded-lg border p-4">`. Le message d'état vide (`:705-713`) reste hors des deux cartes, entre elles, comme aujourd'hui.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/components/clip/`
Expected: PASS.

- [ ] **Step 5: Mesurer la vraie hauteur de chrome, pour la tâche 2**

C'est le moment où le Step 1 de la tâche 2 devient possible : les cartes
existent, leur remplissage réel se mesure. Reprendre le script de mesure du
§3.1 de la spec jumelle contre le DOM construit, pas contre l'estimation du
§3.2.

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

### Task 5 : La bande et le transcript coexistent, au-dessus du seuil `workbench`

**Amendement du 30 août (soir)**, décrit au §2.5 de la spec jumelle. Exécuter
avant la tâche 2 (voir sa note en tête) et après la tâche 3 (les deux touchent
la structure de la carte Montage).

**Files:**
- Modify: `src/components/clip/timeline.tsx` — le `Tabs`/`TabsContent`
  `:294-318`.
- Modify: `src/components/clip/shortcuts.tsx` — le raccourci `Ctrl+F`,
  `:172` (repère à revérifier après rebase).
- Test: `tests/components/clip/timeline.test.tsx`

**Interfaces:**
- Consumes: `TranscriptDrawer`/`TranscriptSurface` — signature inchangée,
  seul l'emplacement où elle est montée change.
- Produces: rien de nouveau côté données ; côté rendu, le panneau transcript
  n'est plus conditionné par `mode`, seulement par la variante `workbench`.

**Ce que ça corrige** : le §2.5 de la spec jumelle — basculer sur « Mots »
démonte aujourd'hui la bande entière (ruban, oreilles, tête de lecture), donc
perd tout repère temporel pendant qu'on choisit un mot. Vérifié à la main sur
`main` avant ce chantier : `role="slider"` passe de 3 à 0 lors du basculement.

- [ ] **Step 1: Write the failing test**

```tsx
it('garde la bande visible en mode Mots, au-dessus du seuil workbench', () => {
  setWorkbenchViewport() // helper à ajouter : simule matchMedia('workbench') → true
  render(<Timeline {...props()} />)

  expect(screen.getByTestId('filmstrip')).toBeInTheDocument()
  expect(screen.getAllByRole('slider')).toHaveLength(3)
  expect(screen.getByRole('group', { name: 'Transcript du clip' })).toBeInTheDocument()
})

it('borne le panneau transcript en hauteur, avec défilement interne', () => {
  setWorkbenchViewport()
  render(<Timeline {...props({ words: longClipWords() /* 284 mots, fixture du clip le plus long */ })} />)

  const panel = screen.getByRole('group', { name: 'Transcript du clip' })
  expect(panel).toHaveClass('overflow-y-auto')
})

it('sous le seuil, la bascule reste exclusive comme aujourd’hui', () => {
  setNonWorkbenchViewport()
  render(<Timeline {...props()} />)

  expect(screen.getByTestId('filmstrip')).toBeInTheDocument()
  expect(screen.queryByRole('group', { name: 'Transcript du clip' })).not.toBeInTheDocument()
})
```

`setWorkbenchViewport`/`setNonWorkbenchViewport` : jsdom ne peut pas évaluer
une vraie `@media (min-height: …)`, donc `matchMedia` s'y bouchonne — suivre
le patron déjà utilisé pour tester d'autres comportements dépendant de
`workbench` dans ce dépôt, si un tel bouchon existe déjà (`grep -rn
"matchMedia" tests/`) ; sinon l'introduire ici, une seule fois, réutilisable
par les tests suivants qui en auront besoin.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/clip/timeline.test.tsx -t 'coexist'`
Expected: FAIL — le transcript et la bande ne sont montés qu'un à la fois,
quel que soit le viewport simulé.

- [ ] **Step 3: Write minimal implementation**

Remplacer le `Tabs` exclusif par un rendu conditionné sur `workbench` :

```tsx
{isWorkbench ? (
  <div className="flex flex-col gap-1">
    <div className="flex items-center gap-3 text-[0.75rem] text-muted-foreground">
      <button type="button" onClick={() => bandRef.current?.scrollIntoView({ block: 'nearest' })}>
        <span aria-hidden>◷</span> Temps
      </button>
      <button type="button" onClick={() => transcriptRef.current?.querySelector('input')?.focus()}>
        <span aria-hidden>❞</span> Mots
      </button>
    </div>
    <div ref={bandRef}>{/* ruban, piste, oreilles — contenu actuel du panneau Temps, inchangé */}</div>
    <div
      ref={transcriptRef}
      role="group"
      aria-label="Transcript du clip"
      className="max-h-[150px] overflow-y-auto"
    >
      <TranscriptDrawer clipId={clipId} lines={lines} words={words} firstLine={firstLine} duration={duration} search={search} onSearch={onSearch} onPlay={onPlay} />
    </div>
  </div>
) : (
  <Tabs value={mode} onValueChange={/* inchangé */}>
    {/* contenu actuel, exclusif, tel quel */}
  </Tabs>
)}
```

`isWorkbench` se lit par un hook léger sur `matchMedia`, posé une fois et
partagé si un tel hook existe déjà ailleurs dans le dépôt (`grep -rn
"matchMedia" src/`) — ne pas le dupliquer s'il existe.

Dans `shortcuts.tsx`, le geste de `Ctrl+F` (`:172` et son appel
`clip-screen.tsx:314-317`) devient conditionnel au même `isWorkbench` :
au-dessus du seuil, focaliser le champ de recherche du panneau transcript déjà
monté ; en dessous, basculer `mode` en `'words'` comme aujourd'hui.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/components/clip/`
Expected: PASS.

- [ ] **Step 5: Mesurer sur le clip le plus long**

```bash
pnpm dev &
```

Ouvrir `http://localhost:4014/clips/2026-03-08-caro-mdlm_007212212-007300496`
(88,3 s, 284 mots) à 2560 × 1320 (ou à la hauteur du seuil recalculé en tâche
2, une fois connue). Vérifier à l'œil : le panneau transcript défile en
interne, sans pousser la carte Montage plus bas que sa hauteur bornée, et sans
chevaucher la ligne d'outils sous elle — même vérification de non-chevauchement
qu'à la tâche 1, appliquée ici.

- [ ] **Step 6: Commit**

```bash
git add src/components/clip/timeline.tsx src/components/clip/shortcuts.tsx tests/components/clip/timeline.test.tsx
git commit -m "feat(clip): keep the band and the transcript both visible above the workbench threshold"
```

---

## Recette finale

Devant l'écran rendu, à 2560 × 1320, 1920 × 1080 et 1024 × <SEUIL recalculé> :

1. Aucun chevauchement entre la figure source et le transport, ni entre la
   fiche et le bord de sa carte — mesuré par `getBoundingClientRect`, jamais
   par capture d'écran seule (§1.1 de la spec jumelle : la capture confirme,
   elle ne mesure pas).
2. `document.scrollingElement.scrollHeight - innerHeight` vaut 0 au-dessus du
   seuil, et l'écran défile normalement en dessous.
3. La colonne Image montre visuellement trois blocs distincts (Source,
   Montage, Outils), chacun avec une bordure — la question du §8 de la spec du
   28 août (« un inconnu peut-il dire en trois secondes ce qu'on vient faire
   ici ? ») se repose, humaine, non tranchée automatiquement.
4. Sur le clip de référence (un plan de doublage), la légende du viseur ne
   contient aucun `%`.
5. Le seuil `workbench` recalculé (tâche 2) est documenté dans `globals.css`
   avec la somme qui le justifie — un chiffre qui n'a pas de calcul à côté est
   un chiffre deviné, pas mesuré.
6. Au-dessus du seuil, basculer sur « Mots » ne fait disparaître ni le ruban
   ni les oreilles : `role="slider"` reste à 3 avant et après le clic. Sur le
   clip le plus long (`007212212-007300496`, 284 mots), le panneau transcript
   défile en interne sans repousser la ligne d'outils. En dessous du seuil, la
   bascule reste exclusive comme avant ce chantier.

Puis mettre à jour la spec jumelle : son statut passe d'« arrêté » à
« implémenté », ses estimations du §3.2 (52 px), du §3.4 (1001 px) et du §3.6
(1167 px) se reprennent contre les chiffres mesurés dans le DOM réel. Un
chiffre qui n'a pas bougé de la case « estimé » à la case « mesuré » est un
lot qui n'a pas été vérifié.
