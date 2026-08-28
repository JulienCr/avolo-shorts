# Refonte de l'écran de clip — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire de `/clips/:id` un établi à deux volets où la sortie 9:16 domine, où les bornes et les coupes se lisent et se règlent, et où la mécanique du cadrage se tait.

**Architecture:** Deux vues sous un même écran, commutées par des onglets posés dans la barre d'app (`Édition` / `Exports`), l'état de la vue vivant dans l'URL comme celui du vivier. La vue Édition est un `flex` à deux volets qui ne défile pas : à gauche la source 16:9, la fiche éditoriale et la bande de temps ; à droite la sortie 9:16, dimensionnée sur la hauteur du volet. Le rail du bas disparaît et son bouton primaire monte dans la barre. La bande gagne un ruban d'images servi par une nouvelle route, deux familles de glyphes, des poignées franches et des champs de timecode, plus un commutateur `Temps | Mots` qui met le transcript au même rang que la piste.

**Tech Stack:** Next.js (App Router), React 19, TypeScript, Tailwind CSS v4 (variante `workbench`), shadcn/ui sur Base UI, TanStack Query, Zustand, Vitest + Testing Library (jsdom opt-in par fichier), ffmpeg statique.

**Spec:** [`docs/superpowers/specs/2026-08-28-ecran-clip-design.md`](../specs/2026-08-28-ecran-clip-design.md) — et son prédécesseur amendé, [`2026-08-23-hierarchie-ui-design.md`](../specs/2026-08-23-hierarchie-ui-design.md), dont le §3.4 reste en vigueur.

## Références vérifiées le 28 août 2026, contre `f9dfe45`

Les numéros de ligne de ce plan ont été relevés au commit `9361cb7`, avant les
PR #270 et #271. Vérification faite depuis, fichier par fichier :

- **`clip-screen.tsx` fait 852 lignes, pas 849.** La #270 y a ajouté une ligne
  avant `:834` et deux après : **ligne du plan + 1** jusqu'à `:834`, **+ 3**
  au-delà. Les repères corrigés sont écrits en clair dans chaque tâche.
- **`crop-picker.tsx` fait 518 lignes**, allongé de 55 par la #270 : tous les
  repères de la tâche 8 étaient périmés et ont été relevés à nouveau.
- **`timeline.tsx` (695 l), `export-panel.tsx` (719 l), `framing-fields.tsx`
  (266 l) et `hook-fields.tsx` (790 l) sont inchangés** depuis `9361cb7` — leurs
  numéros valent tels quels, à deux exceptions signalées aux tâches 6 et 7.
- La #271 n'a touché **aucun fichier de `src/`** : `worker/detect.py`, des
  scripts, des tests, des docs. `PublishedFraming` ne change pas de forme. Ce
  qui change, c'est le **nombre** de frontières qu'elle porte — voir la tâche 6.

## Global Constraints

- **Préalable levé le 28 août 2026 à 18 h 36 : la PR #270 est fusionnée** (`f647ac6`), suivie de la #271 (`90eab1f`). `paintOutput` compose désormais le doublage (`output-preview.tsx:105`), donc le §4.6 de la spec est fait et ne demande aucune tâche. **Brancher depuis `f9dfe45` ou plus récent**, jamais depuis un état antérieur : la composition du doublage disparaîtrait dans un merge sans conflit.
- **Le code est en anglais, sans exception** : identifiants, noms de fichiers, clés JSON, branches git. Aucun accent dans un identifiant. Les commentaires, les libellés d'interface et les corps de PR sont en français ; les messages de commit et les titres de PR sont en anglais.
- **Trois lignes par commentaire, dix par docstring.** Un plafond, pas une moyenne. `~/.claude/scripts/comment-budget.sh` le mesure sur le diff.
- **Ne pas toucher à `VERSION_FINGERPRINT`** (`src/server/steps/render.ts`). Aucune tâche de ce plan ne change la recette ffmpeg du rendu : la planche du ruban est un artefact d'interface, pas une sortie de rendu. Le monter republierait tous les clips pour rien.
- **Plancher typographique : 0,75 rem / 12 px.** Aucun texte en dessous.
- **Un seul accent dans l'interface** : `--stage` (`#FFA800`), pour ce qui est gardé, sélectionné ou cadré. `--brand-blue` est réservé au chrome — la barre d'app — et n'est jamais un état. `tests/components/brand-contrast.test.ts` vérifie les contrastes et doit rester vert.
- **Vérification après chaque tâche** : `pnpm lint && pnpm type-check && pnpm test`.
- **Livraison** : un worktree isolé branché depuis le HEAD local, une PR par lot, puis la skill `check-reviews` avant le merge.

## File Structure

| Fichier | Responsabilité | Tâche |
|---|---|---|
| `src/components/clip/clip-view.ts` | **créé** — l'état de vue (`edition` / `exports`) lu et écrit dans l'URL | 1 |
| `src/components/clip/clip-screen.tsx` | modifié — onglets et primaire dans la barre, deux volets, rail supprimé | 2, 3 |
| `src/components/clip/exports-view.tsx` | **créé** — la vue Exports : livraison courante, fichiers, textes de publication | 4 |
| `src/components/clip/export-panel.tsx` | modifié — perd son rail et son repli « Détail », ne garde que la logique d'état | 2, 4 |
| `src/core/ffmpeg/args.ts` | modifié — `filmstripArgs` | 5 |
| `src/server/thumbs.ts` | modifié — `filmstripPath`, `filmstrip`, `FILMSTRIP_COUNT` | 5 |
| `src/app/api/clips/[id]/filmstrip/route.ts` | **créé** — sert la planche | 5 |
| `src/app/api/clips/[id]/route.ts` | modifié — évince la planche quand une borne bouge | 5 |
| `src/components/clip/timeline.tsx` | modifié — ruban en fond, deux familles de glyphes, oreilles, mode Mots, champs de bornes | 6, 7 |
| `src/components/clip/crop-picker.tsx` | modifié — sélecteur réduit à `auto`, prose supprimée | 8 |
| `src/components/clip/framing-fields.tsx` | modifié — les cinq nombres du doublage passent en modale | 8 |
| `src/components/clip/hook-fields.tsx` | modifié — les quatorze réglages de style passent en modale | 8 |

---

### Task 1: L'état de vue dans l'URL

**Files:**
- Create: `src/components/clip/clip-view.ts`
- Test: `tests/components/clip/clip-view.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: `type ClipView = 'edition' | 'exports'` ; `readClipView(search: string | URLSearchParams): ClipView` ; `writeClipView(search: string, view: ClipView): string`.

Le vivier du planning fait déjà exactement ça dans `src/components/planning/url-state.ts` : l'onglet actif vit dans l'URL, le reste est local. On suit ce précédent plutôt que d'inventer un second modèle.

- [ ] **Step 1: Write the failing test**

Créer `tests/components/clip/clip-view.test.ts` :

```ts
import { describe, expect, it } from 'vitest'

import { readClipView, writeClipView } from '@/components/clip/clip-view'

describe('readClipView', () => {
  it('rend « edition » quand rien n’est demandé', () => {
    expect(readClipView('')).toBe('edition')
  })

  it('lit la vue demandée', () => {
    expect(readClipView('?vue=exports')).toBe('exports')
  })

  it('retombe sur « edition » devant une valeur inconnue', () => {
    expect(readClipView('?vue=montage')).toBe('edition')
  })

  it('accepte un URLSearchParams', () => {
    expect(readClipView(new URLSearchParams('vue=exports'))).toBe('exports')
  })
})

describe('writeClipView', () => {
  it('retire le paramètre pour la vue par défaut', () => {
    expect(writeClipView('?vue=exports&q=a', 'edition')).toBe('?q=a')
  })

  it('rend une chaîne vide quand il ne reste rien', () => {
    expect(writeClipView('?vue=exports', 'edition')).toBe('')
  })

  it('préserve les autres paramètres', () => {
    expect(writeClipView('?q=a', 'exports')).toBe('?q=a&vue=exports')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/clip/clip-view.test.ts`
Expected: FAIL — `Failed to resolve import "@/components/clip/clip-view"`.

- [ ] **Step 3: Write minimal implementation**

Créer `src/components/clip/clip-view.ts` :

```ts
/** Les deux vues de l'écran de clip. `edition` est le défaut, donc absent de l'URL. */
export type ClipView = 'edition' | 'exports'

const VIEWS: readonly ClipView[] = ['edition', 'exports']
const PARAM = 'vue'

/**
 * La vue demandée par l'URL.
 *
 * @param search la chaîne de requête, avec ou sans `?`, ou un `URLSearchParams`
 * @returns la vue lue, ou `edition` devant une valeur inconnue
 */
export function readClipView(search: string | URLSearchParams): ClipView {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const asked = params.get(PARAM)
  return VIEWS.includes(asked as ClipView) ? (asked as ClipView) : 'edition'
}

/**
 * La chaîne de requête portant `view`, les autres paramètres conservés.
 *
 * @returns une chaîne préfixée de `?`, ou vide quand il ne reste aucun paramètre
 */
export function writeClipView(search: string, view: ClipView): string {
  const params = new URLSearchParams(search)
  if (view === 'edition') params.delete(PARAM)
  else params.set(PARAM, view)
  const rendered = params.toString()
  return rendered === '' ? '' : `?${rendered}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/components/clip/clip-view.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/clip/clip-view.ts tests/components/clip/clip-view.test.ts
git commit -m "feat(clip): carry the edit/exports view in the URL"
```

---

### Task 2: Les onglets et le primaire montent dans la barre d'app

**Files:**
- Modify: `src/components/clip/clip-screen.tsx` — repères vérifiés : `<AppBar>` `:329-412`, dont le bloc `children` `:336-411` ; le montage de `PanelExport`, quatrième frère du `flex h-dvh`, `:701-721`
- Modify: `src/components/clip/export-panel.tsx` (extraire l'action primaire du rail)
- Test: `tests/components/clip/clip-screen.test.tsx`

**Interfaces:**
- Consumes: `readClipView`, `writeClipView` de la tâche 1 ; `deriveDeliveryState` (`export-panel.tsx:46`), qui rend `'never' | 'stale' | 'delivered'`.
- Produces: un composant exporté `ClipPrimaryAction` dans `export-panel.tsx`, signature `({ state, onExport, onPublish, disabled }: { state: 'never' | 'stale' | 'delivered'; onExport: () => void; onPublish: () => void; disabled?: boolean }) => ReactElement`.

Le §3.4 de la spec du 23 août tient : le primaire dépend de l'état, et « Publier » **disparaît** quand il n'est pas éligible au lieu d'être grisé. « Une vidéo rendue » se lit `mp4Url !== null || variant9x16Url !== null`, jamais le seul `mp4Url`.

`AppBar` n'a pas besoin de changer : son emplacement `children` est déjà à `ml-auto`, et sa docstring dit qu'il est fait pour ça.

- [ ] **Step 1: Write the failing test**

Ajouter à `tests/components/clip/clip-screen.test.tsx` :

```tsx
it('pose les onglets et le primaire dans la barre d’app, et plus de rail en pied', () => {
  mount(detail())

  const bar = screen.getByRole('banner')
  expect(within(bar).getByRole('tab', { name: 'Édition' })).toHaveAttribute('aria-selected', 'true')
  expect(within(bar).getByRole('tab', { name: 'Exports' })).toBeInTheDocument()
  expect(within(bar).getByRole('button', { name: 'Publier' })).toBeInTheDocument()

  expect(screen.queryByRole('button', { name: 'Détail' })).not.toBeInTheDocument()
})

it('n’offre qu’un seul geste terminal', () => {
  mount(detail())

  const primaries = screen
    .getAllByRole('button')
    .filter((b) => b.getAttribute('data-slot') === 'button' && b.className.includes('bg-primary'))
  expect(primaries).toHaveLength(1)
})
```

`mount` et `detail` existent déjà dans ce fichier ; ne pas les redéfinir.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/clip/clip-screen.test.tsx -t 'barre d’app'`
Expected: FAIL — `Unable to find an accessible element with the role "tab"`.

- [ ] **Step 3: Write minimal implementation**

Dans `export-panel.tsx`, extraire l'action primaire du rail :

```tsx
/** Le seul geste terminal de l'écran. Absent de la barre quand rien n'est publiable. */
export function ClipPrimaryAction({
  state,
  onExport,
  onPublish,
  disabled,
}: {
  state: 'never' | 'stale' | 'delivered'
  onExport: () => void
  onPublish: () => void
  disabled?: boolean
}) {
  if (state === 'delivered') {
    return <Button onClick={onPublish} disabled={disabled}>Publier</Button>
  }
  return (
    <Button onClick={onExport} disabled={disabled}>
      {state === 'stale' ? 'Ré-exporter' : 'Exporter'}
    </Button>
  )
}
```

Dans `clip-screen.tsx`, poser les onglets et le primaire dans `children` d'`AppBar`, après l'état d'enregistrement :

```tsx
<Tabs value={view} onValueChange={(v) => router.replace(`${pathname}${writeClipView(search, v as ClipView)}`)}>
  <TabsList>
    <TabsTrigger value="edition">Édition</TabsTrigger>
    <TabsTrigger value="exports">Exports</TabsTrigger>
  </TabsList>
</Tabs>
<ClipPrimaryAction state={delivery} onExport={onExport} onPublish={onPublish} disabled={busy} />
```

Puis retirer le montage de `PanelExport` en quatrième frère du `flex h-dvh`, et supprimer le repli `Détail` (`export-panel.tsx:275-313`) — son contenu revient en tâche 4.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/components/clip/clip-screen.test.tsx`
Expected: PASS. Plusieurs tests existants vont échouer parce qu'ils cherchent « Détail », « Copier pour publication » ou le rail : les déplacer vers `exports-view.test.tsx` en tâche 4, ou les réécrire ici s'ils portent sur le primaire. **Ne pas les supprimer.**

**Ces tests-là ne sont pas dans `clip-screen.test.tsx`.** Ils sont dans
`tests/components/clip/export-panel.test.tsx` (588 lignes, 34 tests) : « Détail »
à `:96`, « Copier pour publication » à `:462`, `:499` et `:521-525`. Ce fichier
entre donc dans le lot. Dans `clip-screen.test.tsx`, seuls trois tests portent
sur du texte supprimé — la ligne `Cadre` du `<dl>`, aux `describe` de `:197`,
`:207` et `:219`.

- [ ] **Step 5: Vérifier le contraste sur la barre bleue**

Run: `pnpm vitest run tests/components/brand-contrast.test.ts`
Expected: PASS. Le bloc `.bg-brand-blue` de `globals.css` redéfinit `--muted-foreground`, `--border` et `--destructive` ; un bouton primaire posé dessus hérite de ce contexte. Si le test tombe, corriger le jeton, jamais le seuil.

- [ ] **Step 6: Commit**

```bash
git add src/components/clip/clip-screen.tsx src/components/clip/export-panel.tsx tests/components/clip/clip-screen.test.tsx
git commit -m "feat(clip): move the tabs and the primary action into the app bar"
```

---

### Task 3: Les deux volets, la sortie 9:16 dominante

**Files:**
- Modify: `src/components/clip/clip-screen.tsx` — repères vérifiés : `PREVIEW_FRAME` JSDoc `:55-77` et `const` `:78`, ses deux seuls consommateurs `<ClipPlayer frame={…}>` `:538` et `<PreviewOutput frame={…}>` `:556` ; le `<main>` `:463-693` ; la section « Image » `:464-671` ; la section « Contenu » `:673-692`. **La JSDoc de `PREVIEW_FRAME` énonce la règle annulée** (« jamais de largeur ») : elle part avec la constante.
- Test: `tests/components/clip/clip-screen.test.tsx`

**Interfaces:**
- Consumes: la barre sans rail de la tâche 2 ; `deriveDeliveryState` (`export-panel.tsx:46`).
- Produces: `OutputSwitch({ delivered, mode, onMode }: { delivered: boolean; mode: 'preview' | 'export'; onMode: (m: 'preview' | 'export') => void }) => ReactElement`, exporté depuis `clip-screen.tsx`. `PREVIEW_FRAME` **disparaît**, et avec lui la règle « les deux aperçus ont exactement la même hauteur ».

C'est le point cher du lot. La spec §1 annule explicitement la règle d'égalité des hauteurs : la source est l'instrument, la sortie est le produit.

**Ce que la nouvelle mise en page doit tenir**, mesuré à 2560 × 1320 sur `tmp/maquette-montage.html` :

| Région | Aujourd'hui | Visé |
|---|---|---|
| sortie 9:16 | 296 × 526 | ≥ 560 de large (600 × 1067 sur la maquette) |
| source 16:9 | 935 × 526 | ~1322 × 744 |
| bande | ~1200 | ~1912 |
| fiche | 480 | ~574 |

La règle de dimensionnement, en trois lignes de CSS plutôt qu'en JavaScript : le volet droit prend sa largeur de sa hauteur (`aspect-ratio: 9/16` + `height: 100%`), le volet gauche prend le reste, et la fiche vise 30 % du volet gauche, bornée à `min(620px, max(360px, 30cqw))`.

- [ ] **Step 1: Write the failing test**

Ajouter à `tests/components/clip/clip-screen.test.tsx` :

```tsx
it('range la fiche à droite de la source, dans le volet de montage', () => {
  mount(detail())

  const image = screen.getByRole('region', { name: 'Image' })
  expect(within(image).getByLabelText('Titre')).toBeInTheDocument()
  expect(within(image).getByLabelText('Description')).toBeInTheDocument()
  expect(within(image).getByLabelText('Hook')).toBeInTheDocument()
})

it('ne partage plus une hauteur unique entre les deux aperçus', () => {
  mount(detail())

  const source = screen.getByRole('figure', { name: /source/i })
  const sortie = screen.getByRole('figure', { name: /sortie|variante|fichier natif/i })
  expect(source.className).not.toBe(sortie.className)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/clip/clip-screen.test.tsx -t 'fiche à droite'`
Expected: FAIL — le champ Titre est dans la région « Contenu », pas dans « Image ».

- [ ] **Step 3: Write minimal implementation**

Dans `clip-screen.tsx` :

1. Supprimer la constante `PREVIEW_FRAME` et sa docstring.
2. Le `<main>` devient deux volets :

```tsx
<main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 workbench:flex-row workbench:overflow-hidden">
  <section
    aria-labelledby="zone-image"
    className="flex min-w-0 shrink-0 flex-col gap-3 workbench:min-h-0 workbench:flex-1 workbench:overflow-hidden workbench:[container-type:inline-size]"
  >
    <div className="flex min-h-0 flex-1 gap-4">
      <figure className="min-h-0 shrink-0 workbench:h-full workbench:w-auto workbench:[aspect-ratio:16/9]">…</figure>
      <div className="flex min-w-0 flex-1 flex-col gap-3 workbench:max-w-[620px] workbench:min-w-[360px]">
        <FieldsTexts … />
        <HookFields … />
      </div>
    </div>
    <ClipTransport … />
    <Timeline … />
    <RatioPicker … />
  </section>

  <section
    aria-labelledby="zone-sortie"
    className="flex shrink-0 flex-col gap-2 workbench:min-h-0"
  >
    {mode === 'preview'
      ? <PreviewOutput figureClassName="min-h-0 flex-1 workbench:w-auto workbench:[aspect-ratio:9/16]" … />
      : <video src={outputs.variant9x16Url ?? undefined} controls className="min-h-0 flex-1 rounded-lg" />}
    <OutputSwitch delivered={delivery === 'delivered'} mode={mode} onMode={setMode} />
  </section>
</main>
```

3. Déplacer `FieldsTexts` et `HookFields` depuis la section « Contenu », qui disparaît ; le `<h2 id="zone-contenu">` part avec elle.
4. Supprimer le `<dl>` des faits de montage (`:605-631`, dont l'appel `<ShotFrameLine/>` à `:630`) et le composant local `ShotFrameLine` (JSDoc `:815-823`, fonction `:824-852`, fin de fichier) : leurs quatre valeurs reviennent sous la bande en tâche 7. **Trois tests tiennent à ce `<dl>`**, et seulement par sa ligne `Cadre` — `clip-screen.test.tsx:202`, `:213`, `:226-227` ; `Durée`, `Bornes` et `Segments` ne sont assertés nulle part.

- [ ] **Step 4: Écrire le test de la bascule, puis `OutputSwitch`**

```tsx
it('n’offre la bascule Export que lorsqu’un fichier existe', () => {
  render(<OutputSwitch delivered={false} mode="preview" onMode={() => {}} />)
  expect(screen.queryByRole('radio', { name: 'Export' })).not.toBeInTheDocument()

  cleanup()
  render(<OutputSwitch delivered mode="preview" onMode={() => {}} />)
  expect(screen.getByRole('radio', { name: 'Export' })).toBeInTheDocument()
})
```

L'implémentation est un `ToggleGroup` à une ou deux valeurs :

```tsx
/** Le viseur montre l'aperçu vivant, ou le fichier livré, au même endroit. */
export function OutputSwitch({
  delivered,
  mode,
  onMode,
}: {
  delivered: boolean
  mode: 'preview' | 'export'
  onMode: (m: 'preview' | 'export') => void
}) {
  return (
    <ToggleGroup value={[mode]} onValueChange={([m]) => onMode(m as 'preview' | 'export')}>
      <Toggle value="preview">Aperçu</Toggle>
      {/* Absent plutôt que grisé : le §3.4 de la spec du 23 août vaut aussi ici. */}
      {delivered && <Toggle value="export">Export</Toggle>}
    </ToggleGroup>
  )
}
```

Run: `pnpm vitest run tests/components/clip/clip-screen.test.tsx`
Expected: PASS.

- [ ] **Step 5: Mesurer dans un vrai navigateur**

C'est une condition de recette, pas un confort. Lancer `pnpm dev`, ouvrir
`http://localhost:4005/clips/2026-03-08-caro-mdlm_005472883-005518477` à 2560 × 1320, et relever dans la console :

```js
const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)] }
;({ scroll: document.scrollingElement.scrollHeight - innerHeight,
    source: r('[aria-labelledby="zone-image"] figure'),
    sortie: r('[aria-labelledby="zone-sortie"] figure') })
```

Attendu : `scroll` vaut 0, et la largeur de `sortie` est ≥ 560. Un chiffre qui n'a pas bougé est un lot qui n'a pas été fait.

- [ ] **Step 6: Commit**

```bash
git add src/components/clip/clip-screen.tsx tests/components/clip/clip-screen.test.tsx
git commit -m "feat(clip): give the vertical output the right-hand pane"
```

---

### Task 4: La vue Exports

**Files:**
- Create: `src/components/clip/exports-view.tsx`
- Create: `tests/components/clip/exports-view.test.tsx`
- Create: `tests/fixtures/clip.ts` — `clipFixture(overrides?: Partial<Clip>): Clip`, extrait de `detail()` dans `clip-screen.test.tsx` et importé des deux côtés plutôt que dupliqué
- Modify: `src/components/clip/export-panel.tsx` (n'expose plus que sa logique d'état et `ClipPrimaryAction`)
- Modify: `src/components/clip/clip-screen.tsx` (branche la vue sur l'onglet)

**Interfaces:**
- Consumes: `ClipView` (tâche 1), `deriveDeliveryState`, `OutputsList` et `FieldCopyable` (aujourd'hui internes à `export-panel.tsx` — les exporter).
- Produces: `ExportsView({ clip, outputs, framing, descriptionFooter }: { clip: Clip; outputs: ClipOutputs; framing: PublishedFraming; descriptionFooter: string }): ReactElement`. Pas de `publications` : les états par couple clip/plateforme n'ont aucune source, et la spec les laisse hors périmètre.

**Une seule entrée, et la place pour les suivantes.** Le dépôt ne conserve aucune version : quatre tables, aucune pour les rendus, des fichiers nommés par l'identifiant du clip donc écrasés. La vue montre donc la livraison courante et rien d'inventé — le même parti que la publication, préparée à vide avant ses connecteurs. **Ne pas fabriquer un faux historique.**

- [ ] **Step 1: Write the failing test**

Créer `tests/components/clip/exports-view.test.tsx` :

```tsx
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ExportsView } from '@/components/clip/exports-view'
import { framing } from '../../fixtures/framing'

const outputs = {
  mp4Url: null,
  mp4Due: false,
  variant9x16Url: '/api/clips/c1/renders/c1-9x16.mp4',
  variant9x16Due: true,
  textsUrl: '/api/clips/c1/renders/c1.txt',
}

describe('ExportsView', () => {
  it('montre la livraison courante et son lecteur', () => {
    render(<ExportsView clip={clipFixture()} outputs={outputs} framing={framing()} descriptionFooter="" />)

    expect(screen.getByRole('heading', { name: 'Livraison courante' })).toBeInTheDocument()
    expect(screen.getByLabelText('Variante 9:16')).toHaveAttribute('src', outputs.variant9x16Url)
  })

  it('dit qu’il n’y a rien plutôt que d’inventer une version', () => {
    render(
      <ExportsView
        clip={clipFixture()}
        outputs={{ ...outputs, variant9x16Url: null, textsUrl: null }}
        framing={framing()}
        descriptionFooter=""
      />,
    )

    expect(screen.getByText(/aucun fichier livré/i)).toBeInTheDocument()
    expect(screen.queryByRole('video')).not.toBeInTheDocument()
  })
})
```

`clipFixture` : reprendre la fabrique `detail().clip` de `clip-screen.test.tsx` en la déplaçant dans `tests/fixtures/clip.ts` et en l'important des deux côtés — ne pas la dupliquer.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/clip/exports-view.test.tsx`
Expected: FAIL — `Failed to resolve import "@/components/clip/exports-view"`.

- [ ] **Step 3: Write minimal implementation**

Créer `exports-view.tsx`. Le lecteur prend toute la largeur utile — c'est le point du lot : le `max-w-64` de `export-panel.tsx:611` est la raison pour laquelle l'export ne se regardait pas.

```tsx
<video
  aria-label="Variante 9:16"
  src={outputs.variant9x16Url}
  controls
  preload="metadata"
  className="max-h-[70vh] w-auto rounded-lg"
/>
```

Reprendre `OutputsList` et les trois `FieldCopyable` du repli supprimé en tâche 2, plus le bouton « Copier pour publication ». Le titre de section est « Livraison courante » ; en dessous, une ligne dit ce que le dépôt ne garde pas :

```tsx
<p className="text-xs text-muted-foreground">
  Une seule version est conservée : un nouvel export remplace la précédente.
</p>
```

Dans `clip-screen.tsx`, commuter :

```tsx
{view === 'edition' ? <main …>…</main> : <ExportsView … />}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/components/clip/`
Expected: PASS, y compris les tests déplacés depuis `clip-screen.test.tsx` en tâche 2.

- [ ] **Step 5: Commit**

```bash
git add src/components/clip/exports-view.tsx src/components/clip/export-panel.tsx src/components/clip/clip-screen.tsx tests/
git commit -m "feat(clip): give exports their own view with a full-size player"
```

---

### Task 5: La planche du ruban

**Files:**
- Modify: `src/core/ffmpeg/args.ts` (après `thumbArgs`, `:236`)
- Modify: `src/server/thumbs.ts`
- Create: `src/app/api/clips/[id]/filmstrip/route.ts`
- Modify: `src/app/api/clips/[id]/route.ts` (`:337-343`, l'éviction)
- Test: `tests/core/ffmpeg-args.test.ts` (**y ajouter**, ne pas créer un fichier à part : c'est le seul fichier d'arguments du dépôt et il les porte tous), `tests/server/filmstrip.test.ts` (créé)

**Interfaces:**
- Consumes: `GLOBAL` (six éléments — les assertions par index en dépendent), `seconds`, `destination` (internes à `args.ts`, `destination(dst)` rendant `['--', dst]`, donc le chemin est toujours en dernier) ; `runFfmpeg` et `pathTemporary` ; `proxyPath` et `projectDir` (`@/server/paths`) ; `verifyIdClip` (local à `thumbs.ts:36`) ; `clipBounds` (`@/lib/editing`). **Pas `produceArtifact`** — voir l'étape 6.
- Produces: `filmstripArgs({ src, dst, at, duration, count }): string[]` ; `FILMSTRIP_COUNT = 12` ; `filmstripPath(projectId, clipId): string` ; `filmstrip(clip: Clip): Promise<string | null>` ; la route `GET /api/clips/:id/filmstrip`.

**Mesuré le 28 août 2026**, trois passes sur un clip de 50,5 s, `loadavg` 3,41 : 0,45 / 0,44 / 0,43 s, médiane **0,44 s**, planche de **43 Ko** en 1920 × 90. `-ss` avant `-i`, comme `thumbArgs` — inversés, ffmpeg décode depuis le début et la mesure ne tient plus.

- [ ] **Step 1: Write the failing test (les arguments)**

Ajouter à `tests/core/ffmpeg-args.test.ts`, à côté du bloc de `thumbArgs` (`:126`) :

```ts
// `filmstripArgs` s'ajoute à l'import déjà en tête du fichier.

describe('filmstripArgs', () => {
  const args = filmstripArgs({ src: '/p/proxy.mp4', dst: '/p/strip.jpg', at: 100, duration: 50, count: 12 })

  it('cherche avant d’ouvrir', () => {
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
  })

  it('tuile douze vues sur la durée du clip', () => {
    expect(args).toContain('fps=12/50,scale=160:90,tile=12x1')
  })

  it('n’écrit qu’une image', () => {
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1')
  })

  it('refuse une durée nulle', () => {
    expect(() => filmstripArgs({ src: 'a', dst: 'b', at: 0, duration: 0, count: 12 })).toThrow(/durée/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/core/ffmpeg-args.test.ts`
Expected: FAIL — `filmstripArgs is not a function`.

- [ ] **Step 3: Write minimal implementation**

Dans `src/core/ffmpeg/args.ts`, après `thumbArgs` :

```ts
/**
 * La planche d'un clip : `count` vues tuilées sur une seule ligne.
 *
 * @param duration la durée couverte, en secondes ; doit être > 0
 * @throws si `duration` est nulle ou négative — `fps=12/0` sort une planche vide
 *   que la présence du fichier ferait passer pour valide
 */
export function filmstripArgs(o: {
  src: string
  dst: string
  at: number
  duration: number
  count: number
}): string[] {
  if (!(o.duration > 0)) throw new Error(`filmstripArgs : durée invalide (${String(o.duration)}).`)
  return [
    ...GLOBAL,
    '-ss', seconds(Math.max(0, o.at)),
    '-t', seconds(o.duration),
    '-i', o.src,
    '-map', '0:v:0',
    '-an',
    '-vf', `fps=${o.count}/${o.duration},scale=160:90,tile=${o.count}x1`,
    '-frames:v', '1',
    '-q:v', '4',
    '-update', '1',
    ...destination(o.dst),
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/core/ffmpeg-args.test.ts`
Expected: PASS, les 4 nouveaux compris.

- [ ] **Step 5: Write the failing test (l'artefact et la route)**

Créer `tests/server/filmstrip.test.ts` sur le modèle de `tests/server/thumb-route.test.ts:28` et `tests/server/thumbs-poster.test.ts:24`. **Pas `proxy.test.ts`**, qui ne bouchonne ni ffmpeg ni le disque et n'a rien à recopier ici. L'idiome des deux autres :

```ts
vi.mock('@/server/ffmpeg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/ffmpeg')>()
  return { ...actual, runFfmpeg: vi.fn(async (args: string[]) => {
    fs.writeFileSync(args[args.length - 1], Buffer.from('jpeg'))
  }) }
})
const { GET } = await import('@/app/api/clips/[id]/filmstrip/route')
```

Le faux écrit dans `args[args.length - 1]` parce que `destination()` met le
chemin en dernier ; le module sous test s'importe en `await import` **après** le
`vi.mock` hissé. `thumb-route.test.ts` pose aussi `REPLAY_DIR`, `STAGE_DIR` et
`PROJECTS_DIR` sur un `mkdtempSync`, et sème la base par `upsertProject` /
`putClip` / `closeDb` — nécessaire, puisque la production relit le clip avant de
renommer. Les deux cas de chemin :

```ts
import { describe, expect, it, vi } from 'vitest'

import { filmstripPath } from '@/server/thumbs'

describe('filmstripPath', () => {
  it('range la planche à côté des vignettes', () => {
    expect(filmstripPath('p1', 'c1')).toMatch(/projects[/\\]p1[/\\]thumbs[/\\]c1\.strip\.jpg$/)
  })

  it('refuse un identifiant qui remonte l’arborescence', () => {
    expect(() => filmstripPath('p1', '../secret')).toThrow(/invalide/)
  })
})
```

- [ ] **Step 6: Implement `filmstrip` and the route**

Dans `src/server/thumbs.ts` :

```ts
/** Le nombre de vues d'une planche. Douze : 43 Ko et 0,44 s, mesurés le 28 août 2026. */
export const FILMSTRIP_COUNT = 12

/** `projects/<projet>/thumbs/<clip>.strip.jpg`. */
export function filmstripPath(projectId: string, clipId: string): string {
  return path.join(projectDir(projectId), 'thumbs', `${verifyIdClip(clipId)}.strip.jpg`)
}
```

`filmstrip(clip)` suit `vignette` (`thumbs.ts:87`) **pas à pas**, et surtout pas
`produceArtifact` : les deux formes sont incompatibles. `produceArtifact` prend
`args: (destination: string) => string[]` et n'a pas le garde-fou qui compte ici
— `vignette` écrit dans `pathTemporary(destination)`, **relit le clip en base**
et compare avant de renommer, ce qui évite de publier une planche déjà périmée ;
en cas d'échec elle `rm` le temporaire. Ce garde-fou vient d'une revue Copilot et
`renderPoster` le porte aussi.

Le reste suit : `null` si le proxy manque, chemin existant si la planche est là,
l'instant valant `clipBounds(clip.segments).start` et la durée `end - start`. Un
clip vidé de ses segments rend `null` — `clipBounds` rend `null`, et il n'y a pas
de planche d'une durée nulle.

`clipBounds` vit dans `src/lib/editing.ts`, jusqu'ici consommé côté client
seulement : `thumbs.ts` l'importe pour une fonction pure, ce qui est délibéré et
n'ouvre pas `src/server` sur le reste de `src/lib`.

La route reprend mot pour mot la forme de `src/app/api/clips/[id]/thumb/route.ts` : `route('GET /api/clips/:id/filmstrip', …)`, `getClip`, `notFound` si le clip est inconnu ou la planche indisponible, `Content-Type: image/jpeg`, `Cache-Control: public, max-age=60`.

- [ ] **Step 7: Évincer la planche quand une borne bouge**

Dans `src/app/api/clips/[id]/route.ts`, à côté de l'éviction de la vignette (`:337`) — et **pas dans la même condition**. Celle qui est là ne teste que `written.segments[0]?.start !== clip.segments[0]?.start`, ce qui suffit à une vignette prise sur le premier segment et laisse une planche fausse dès que seule la borne de fin bouge :

```ts
// La vignette suit le premier segment ; la planche couvre tout le clip. Une
// borne de fin déplacée laisse donc la vignette juste et la planche fausse.
const boundsMoved =
  written.segments[0]?.start !== clip.segments[0]?.start ||
  written.segments.at(-1)?.end !== clip.segments.at(-1)?.end
if (boundsMoved) {
  try {
    fs.rmSync(filmstripPath(clip.projectId, clip.id), { force: true })
  } catch (cause) {
    console.warn(`Planche non effacée pour ${clip.id} :`, cause)
  }
}
```

Comme pour la vignette : au pire, pas d'erreur. L'écriture en base est déjà validée à ce point.

- [ ] **Step 8: Run the suite**

Run: `pnpm lint && pnpm type-check && pnpm test`
Expected: PASS.

- [ ] **Step 9: Vérifier sur un vrai clip**

```bash
pnpm dev &
curl -s -o /tmp/strip.jpg -w '%{http_code} %{size_download}\n' \
  'http://localhost:4005/api/clips/2026-03-08-caro-mdlm_005472883-005518477/filmstrip'
```

Attendu : `200` et une taille de l'ordre de 40 000 octets. Ouvrir `/tmp/strip.jpg` : douze vues lisibles, les changements de plan visibles à l'œil.

- [ ] **Step 10: Commit**

```bash
git add src/core/ffmpeg/args.ts src/server/thumbs.ts 'src/app/api/clips/[id]' tests/
git commit -m "feat(api): serve a twelve-frame filmstrip for the clip timeline"
```

---

### Task 6: La bande — ruban en fond, deux familles de glyphes

**Files:**
- Modify: `src/components/clip/timeline.tsx` (la piste `:251-310`, les oreilles `:488-540`)
- Test: `tests/components/clip/timeline.test.tsx`

**Interfaces:**
- Consumes: la route de la tâche 5.
- Produces: `Timeline` **gagne une prop `clipId: string`** — elle n'en avait pas (`timeline.tsx:66-82` reçoit `segments`, `framing`, `proxyUrl`, `sourceDuration`, `onScrub`, `onBoundary`). L'URL se construit dans le composant avec `encodeURIComponent`, et **le ruban ne se rend que si `proxyUrl !== null`** — `Timeline` porte déjà cette prop, et la route rend 404 sans proxy. (`urlVignette` n'est pas dans `src/lib/navigation.ts` mais dans `src/server/views.ts:129`, où il *stat* le proxy : un composant ne peut pas faire ça, d'où le garde côté client.) `clip-screen.tsx` passe `clipId` au montage.

**Deux familles, jamais une seule.** Une coupe est un passage retiré par quelqu'un, et ça se défait. Une frontière de plan est un cadrage trouvé par l'analyse, et ça ne se défait pas. Leur donner le même trait promet une action qui n'existe pas.

Ce qui ne bouge pas dans ce fichier, et qui est cher : un seul point d'annulation par geste (`commit`, `:167`), la fenêtre figée pendant un glissé (`:98`), le non-accrochage délibéré aux mots (`:31`), la vignette de survol à une seule requête en vol (`useFramePreview`, `:571`).

- [ ] **Step 1: Write the failing test**

Ajouter à `tests/components/clip/timeline.test.tsx` :

```tsx
it('pose le ruban en fond de piste', () => {
  render(<Timeline {...props({ clipId: 'c1' })} />)

  const film = screen.getByTestId('filmstrip')
  expect(film).toHaveStyle({ backgroundImage: expect.stringContaining('/api/clips/c1/filmstrip') })
})

it('dessine une encoche par coupe, avec sa durée', () => {
  render(<Timeline {...props({ segments: [{ start: 100, end: 105 }, { start: 107.4, end: 120 }] })} />)

  const cuts = screen.getAllByTestId('cut')
  expect(cuts).toHaveLength(1)
  expect(cuts[0]).toHaveTextContent('2,4 s')
})

it('ne nomme pas les frontières de plan', () => {
  render(<Timeline {...props({ framing: framing({ shots: [shot(0, 50, '1:1', 0.5), shot(50, 120, '9:16', 0.5)] }) })} />)

  const marks = screen.getAllByTestId('shot-mark')
  expect(marks).toHaveLength(1)
  expect(marks[0]).toHaveTextContent('')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/clip/timeline.test.tsx -t 'ruban'`
Expected: FAIL — `Unable to find an element by: [data-testid="filmstrip"]`.

- [ ] **Step 3: Write minimal implementation**

Dans la piste, avant les segments :

```tsx
<div
  data-testid="filmstrip"
  className="absolute inset-y-0"
  style={{
    left: `${percent(bounds.start)}%`,
    width: `${percent(bounds.end) - percent(bounds.start)}%`,
    backgroundImage: `url(/api/clips/${encodeURIComponent(clipId)}/filmstrip)`,
    backgroundSize: '100% 100%',
  }}
/>
```

Les segments deviennent un voile teinté plutôt qu'un aplat, sinon le ruban ne se voit plus :

```tsx
className="absolute inset-y-0 bg-stage/30 border-y-[3px] border-stage"
```

Les coupes, une par trou entre segments consécutifs :

```tsx
<div data-testid="cut" className="absolute inset-y-0 grid place-items-center bg-[repeating-linear-gradient(135deg,…)]">
  <b className="rounded bg-background/80 px-1 font-mono text-[0.75rem]">
    {`✂ ${(to - from).toFixed(1).replace('.', ',')} s`}
  </b>
</div>
```

Les frontières de plan gardent leur trait de 1 px et gagnent `data-testid="shot-mark"`, **sans étiquette**. Elles sont dessinées à `:303-310`, une par `framing.shots.slice(1)` — le premier plan commence au bord gauche —, positionnées en temps source.

**Dessiner pour trois fois la densité d'aujourd'hui.** Le clip de référence porte
7 plans sur 50,5 s, mais son `analysis.json` date du 19 août : la #271 a ajouté
un second déclencheur (`composition_ruptures`) qui a fait passer une émission de
562 à 648 frontières, et un clip de 30 s de 1 plan à 6. La ré-analyse n'a pas
encore eu lieu ; le repère doit rester lisible quand elle aura lieu. Second effet
déjà prévu dans le code : `ClipFraming.rejectedOverrides` existe pour le jour où
le détecteur change, les surcharges manuelles étant clés sur `shotStartMs`.

Les oreilles passent de 3 px à 16 px de large, avec le timecode en pastille sous la poignée. Conserver `role="slider"`, `aria-label` (« Borne d'entrée » / « Borne de sortie ») et la gestion des flèches : ce sont eux qui font le clavier. **Elle n'est pas à `:522`**, qui est un `onPointerDown` — c'est `Handle.onKeyDown` (`:534-542`) et `Playhead.onKeyDown` (`:461-469`), tous deux en `e.shiftKey ? COARSE_STEP : FRAME_STEP`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/components/clip/timeline.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/clip/timeline.tsx tests/components/clip/timeline.test.tsx
git commit -m "feat(clip): draw the filmstrip and tell cuts from shot boundaries"
```

---

### Task 7: `Temps | Mots`, et les champs de bornes

**Files:**
- Modify: `src/components/clip/timeline.tsx` (l'entête et le pied de la bande)
- Modify: `src/components/clip/clip-screen.tsx` (le tiroir `TranscriptDrawer` devient le mode Mots)
- Modify: `src/components/clip/transcript-drawer.tsx` (perd son `Sheet`, garde son contenu)
- Test: `tests/components/clip/timeline.test.tsx`, `tests/components/clip/clip-screen.test.tsx`

**Interfaces:**
- Consumes: `setBoundaryAt` et `poserBound` du store (`src/store/editor.ts:180,186`) ; `clipBounds` (`src/lib/editing.ts:205`).
- Produces: `type BandMode = 'time' | 'words'`, état local de `Timeline`.

**Le champ affiche `clipBounds`, jamais la valeur demandée.** `clipBounds` rend les bornes après normalisation : afficher la demande ferait mentir le champ dès que la valeur tombe dans un passage retiré.

Les deux modes ne sont pas deux fonctions : `setBoundaryAt` et `poserBound` écrivent la même liste de segments et empilent le même point d'annulation. C'est la condition pour que le commutateur ne mente pas.

- [ ] **Step 1: Write the failing test**

```tsx
it('commute entre la piste et les mots', async () => {
  const user = userEvent.setup()
  render(<Timeline {...props()} />)

  expect(screen.getByTestId('filmstrip')).toBeInTheDocument()
  await user.click(screen.getByRole('tab', { name: 'Mots' }))

  expect(screen.queryByTestId('filmstrip')).not.toBeInTheDocument()
  expect(screen.getByRole('group', { name: 'Transcript du clip' })).toBeInTheDocument()
})

it('affiche la borne retenue, pas celle qui a été demandée', async () => {
  const user = userEvent.setup()
  // Le clip va de 100 à 120 ; 108 tombe dans le trou retiré de 105 à 110.
  render(<Timeline {...props({ segments: [{ start: 100, end: 105 }, { start: 110, end: 120 }] })} />)

  const start = screen.getByLabelText('A')
  await user.clear(start)
  await user.type(start, '0:01:48{Enter}')

  expect(start).toHaveValue('1:40')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/clip/timeline.test.tsx -t 'commute'`
Expected: FAIL — `Unable to find an accessible element with the role "tab"`.

- [ ] **Step 3: Write minimal implementation**

Entête de la bande : un `ToggleGroup` à deux valeurs, `◷ Temps` et `❞ Mots`. En mode Mots, la piste, la voie des plans et les oreilles ne sont pas rendues ; `TranscriptSurface` prend leur place, sans son `Sheet`.

Pied de la bande, à gauche :

```tsx
<label className="flex items-center gap-1 text-[0.75rem]">
  A
  <input
    className="w-24 rounded border px-1 font-mono text-[0.75rem]"
    value={format(bounds.start)}
    onChange={…}
    onBlur={(e) => commitBound(parse(e.target.value), 'start')}
  />
</label>
```

Idem pour B, puis une durée en lecture seule. Après écriture, relire `clipBounds(segments)` et réafficher **cette** valeur.

`TranscriptDrawer` perd son `SheetTrigger` et son `SheetContent` ; `transcript-surface.tsx` ne change pas. Le raccourci `Ctrl+F` bascule désormais en mode Mots au lieu d'ouvrir un tiroir — le `find:` est à `clip-screen.tsx:314-317`, dans l'appel `useShortcuts({…})` de `:297-320` — et la table des raccourcis (`shortcuts.tsx:172`) le dit.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/components/clip/`
Expected: PASS. **`transcript-drawer.test.tsx` n'existe pas** : le tiroir n'a pas de test dédié, il est couvert par `clip-screen.test.tsx` via son aide `openEditing()` (`:135`), qui clique « modifier le montage » et rend le dialogue. C'est cette aide-là qui se réécrit en cliquant l'onglet Mots. `transcript-surface.test.tsx` (15 tests) porte sur la surface elle-même, qui ne change pas.

- [ ] **Step 5: Commit**

```bash
git add src/components/clip/timeline.tsx src/components/clip/clip-screen.tsx src/components/clip/transcript-drawer.tsx src/components/clip/shortcuts.tsx tests/
git commit -m "feat(clip): make time and words two peer modes of the same edit"
```

---

### Task 8: La soustraction

**Files:**
- Modify: `src/components/clip/crop-picker.tsx` (518 lignes ; la #270 l'a allongé de 55, **les repères du plan initial étaient périmés**)
- Modify: `src/components/clip/framing-fields.tsx`
- Modify: `src/components/clip/hook-fields.tsx` (`:238-254` et la suite)
- Modify: `src/components/clip/clip-screen.tsx` (`RenderSettings` : JSDoc `:727-747`, fonction `:748-813`). Son déclencheur existe déjà — `clip-screen.test.tsx` porte une aide `openRenderSettings()` (`:151`) qui clique « réglages du rendu ».
- Test: `tests/components/clip/crop-picker.test.tsx`, `tests/components/clip/framing-fields.test.tsx`, `tests/components/clip/hook-fields.test.tsx`

**Interfaces:**
- Consumes: `Dialog` de `@/components/ui/dialog`.
- Produces: rien de nouveau.

**La géométrie se dessine, la prose disparaît.** Les cellules du doublage et le rectangle restent tracés sur la source — c'est ce qui sera pris. Ce qui part, c'est le texte qui explique pourquoi.

**Une exception, et elle est écrite dans le code.** Le commentaire de
`crop-picker.tsx:418-424` — et non `:384-390`, périmé — interdit explicitement de
masquer la ligne « Fichier natif · Variante 9:16 », qui est le `<p>` de `:425-439`
et qui avait été restaurée après une séance d'usage. Cette ligne **reste** : elle
dit ce que le clip produit, pas comment le cadrage y est arrivé.

Une nuance dans ce commentaire, à ne pas rater. Sa première moitié — la ligne ne
se cache jamais — reste vraie et **ne se réécrit pas**. Sa seconde moitié décrit
« ce qui folde en dessous », or cette tâche fait précisément disparaître les
`<details>` en question : cette phrase-là suit ce qu'elle décrit. Garder
l'interdiction, pas la description d'un pliage qui n'existe plus.

- [ ] **Step 1: Write the failing test**

```tsx
it('ne garde que « auto », le forçage derrière un déclencheur', () => {
  render(<RatioPicker {...props()} />)

  expect(screen.getByRole('radio', { name: 'auto' })).toBeInTheDocument()
  expect(screen.queryByRole('radio', { name: '4:5' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /forcer un cadrage/i })).toBeInTheDocument()
})

it('ne raconte plus comment chaque sortie se comporte', () => {
  render(<RatioPicker {...props()} />)

  expect(screen.queryByText(/Comment chaque sortie se comporte/)).not.toBeInTheDocument()
  expect(screen.queryByText(/séquence de doublage improvisé/)).not.toBeInTheDocument()
  expect(screen.getByText(/Fichier natif/)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/components/clip/crop-picker.test.tsx -t 'auto'`
Expected: FAIL — les cinq boutons de ratio sont là.

**Attendre plus de casse que le texte n'en annonce.** `crop-picker.test.tsx`
(29 tests) ne cherche presque jamais les titres des `<details>` : il lit leur
**corps**, présent dans le DOM sans que rien ne les ouvre — `/toute la largeur/i`,
`/auto → 4:5/`, `/1:1 · épinglé/`, `/change avec les plans/i`,
`/calculé pour chaque plan/i`, `/en split sur certains plans/`,
`/deux cellules empilées, sans fond/`, `/n'a pas tourné/i`, `/ne se lit pas/i`,
`/aucun plan/i`. Une dizaine de tests tombent donc **même quand le texte
survit**, du seul fait de passer derrière un déclencheur. Ils se réécrivent en
ouvrant la modale, ils ne se suppriment pas.

- [ ] **Step 3: Write minimal implementation**

Dans `crop-picker.tsx`, repères relevés le 28 août sur `f9dfe45` : supprimer les deux `<details>` — « Comment chaque sortie se comporte » `:441-484` et « Repli du cadrage automatique » `:497-503` — et le paragraphe de `cropReason` `:511-514` ; supprimer la ligne résolue `auto → … · natif …` (commentaire `:403-405`, `<p>` `:406-416`). Le `ToggleGroup` ne rend que `auto` ; un `Button variant="ghost"` ouvre un `Dialog` portant les quatre ratios forcés.

Dans `framing-fields.tsx` (266 lignes, inchangé) : les cinq `NumberField` et la ligne « Montage doublage — N plans » (`:95`, plus l'état désactivé `:80` et son `aria-label` `:83`) passent dans un `Dialog` derrière un déclencheur discret. Quatre tests de `framing-fields.test.tsx` portent dessus (`:74`, `:89`, `:90`, `:117`).

Dans `hook-fields.tsx` : les quatorze réglages de style quittent le `Collapsible` pour un `Dialog`. Les champs Hook, Badge et la case « Hook activé » restent visibles.

Dans `clip-screen.tsx` : `RenderSettings` — marques et sous-titres — rejoint le même `Dialog` que le style du hook, ou le sien ; un seul déclencheur `⋯` dans la fiche.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/components/clip/`
Expected: PASS.

- [ ] **Step 5: Mesurer la soustraction**

```bash
~/.claude/scripts/comment-budget.sh origin/main
```

Expected: aucun bloc au-dessus du plafond parmi ceux que le diff touche.

- [ ] **Step 6: Commit**

```bash
git add src/components/clip/ tests/components/clip/
git commit -m "feat(clip): fold the advanced framing and hook settings into dialogs"
```

---

## Recette finale

Les cinq relevés du §9 de la spec, devant l'écran rendu à 2560 × 1320, sur
`http://localhost:4005/clips/2026-03-08-caro-mdlm_005472883-005518477` :

1. `document.scrollingElement.scrollHeight` vaut la hauteur de la fenêtre.
2. La sortie 9:16 mesure au moins 560 px de large — elle en fait 296 avant ce plan.
3. Il existe **un seul** bouton primaire, et c'est l'élément interactif le plus à droite de la première ligne.
4. Sur un clip de doublage, l'image du viseur et une image du fichier rendu au même instant se superposent.
5. Un inconnu peut-il dire en trois secondes ce qu'on vient faire sur cet écran, et où cliquer pour le faire ?

Puis mettre à jour la spec : son statut passe d'« arrêté » à « implémenté », et
les chiffres de sa section 3 se reprennent dans le DOM. Un chiffre qui n'a pas
bougé est un lot qui n'a pas été fait.
