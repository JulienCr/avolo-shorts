/**
 * Compose la planche en HTML autonome — issue #191, lot 2, §6.
 *
 * HTML typé, construit par concaténation de gabarits littéraux : aucun
 * remplacement de `{{}}` sur un fichier copié. `escapeHtml` protège toute
 * valeur interpolée ; `section.html` est la seule exception, injecté
 * verbatim parce que c'est le point d'échappement voulu par la spécification
 * (§1) pour la prose et les tableaux que la planche ne sait pas composer
 * elle-même.
 *
 * Addendum lot 3 : les cartes se rangent sous la section qui déclare leur cas
 * (`BoardCard.caseId`), et le `stake` d'un cas s'affiche une fois pour tous
 * ses états plutôt que répété sur chacun — voir `groupHtml`.
 */

import { BOARD_CSS, STYLE_CSS, renderScript } from './template'
import type { Board } from './card'
import { assertShare, formatShare } from './share'

/**
 * Les chaînes visibles du script embarqué — dupliquées de `verdicts.ts`
 * (même raison : le `T` du script vit dans une chaîne, inatteignable depuis
 * Node) et donc tenues manuellement en accord avec sa grammaire.
 *
 * `copyOutTitle` porte deux lignes (identifiant, commit) : c'est la même
 * astuce que `formatCopyOut`, qui les pousse comme deux lignes distinctes —
 * les deux rendent le même texte pour la même planche.
 */
function stringsFor(spec: Board['spec'], commit: string) {
  return {
    progressNoun: 'tranchés',
    copyOutTitle: `Planche : ${spec.id}\nCommit : ${commit}`,
    settledHeading: 'Réglé',
    undecided: 'sans réponse',
    noteLabel: 'note',
    remarksHeading: 'Remarques',
    copied: 'Copié.',
    copyRefused: 'La copie automatique a été refusée ; sélectionnez le texte à la main.',
    cleared: 'Effacé.',
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderBoardPage(board: Board): string {
  const { spec, cards, commit } = board
  const total = cards.length
  const T = stringsFor(spec, commit)

  // Vérifié une fois, à part, avant tout regroupement par section ou par cas
  // ci-dessous : une clé en double doit sauter avant la composition.
  const seenKeys = new Set<string>()
  for (const card of cards) {
    if (seenKeys.has(card.key)) {
      throw new Error(`renderBoardPage : data-key en double "${card.key}".`)
    }
    seenKeys.add(card.key)
    // Jamais de <img> sans sa part : la vérification précède la composition.
    assertShare(card.state.share, card.key)
  }
  const indexOf = new Map(cards.map((c, i) => [c.key, i + 1]))

  const settledItems = spec.settled
    .map(
      ([label, text]) =>
        `    <li><span class="tick">✓</span><span><b>${escapeHtml(label)}</b> — ${escapeHtml(text)}</span></li>`,
    )
    .join('\n')

  const calloutHtml = spec.callout
    ? `<div class="settled"><h2>${escapeHtml(spec.callout.title)}</h2><p>${escapeHtml(spec.callout.body)}</p></div>\n`
    : ''

  /**
   * Une carte, seule — `n` porte son rang dans `board.cards`, indépendant de
   * l'endroit où elle atterrit ensuite (section de son cas, ou hors-section).
   * Le `stake` n'y figure plus : `groupHtml` ci-dessous le montre une fois par
   * cas, jamais par état.
   */
  function cardHtml(card: Board['cards'][number]): string {
    const n = indexOf.get(card.key)
    if (n === undefined) throw new Error(`renderBoardPage : carte "${card.key}" hors index.`)
    const label = `${card.projectId} ${card.shot.start}-${card.shot.end} @${card.instant}`
    const framesHtml = card.images
      .map((img) => {
        if (!img.alt.trim()) {
          throw new Error(`renderBoardPage : alt vide (variante "${img.variantId}", carte "${card.key}").`)
        }
        return `      <figure class="variant">
        <span class="variant-label">${escapeHtml(img.variantLabel)}</span>
        <img src="${img.dataUri}" alt="${escapeHtml(img.alt)}">
        <figcaption class="share">${escapeHtml(formatShare(card.state.share))} · plage continue ${escapeHtml(formatShare(card.state.run.share))}</figcaption>
      </figure>`
      })
      .join('\n')

    return `<section class="q q--board" data-q="${n}" data-key="${escapeHtml(card.key)}" data-label="${escapeHtml(label)}">
  <div class="q-head">
    <div class="q-num">Cadrage ${n} / ${total}</div>
    <h3 class="q-title">${escapeHtml(card.projectId)} — ${escapeHtml(card.state.state.label)}</h3>
  </div>
  <div class="frames">
${framesHtml}
  </div>
  <div class="opts">
    <label class="opt"><input type="radio" name="q${n}" value="garder"><span><span class="opt-t">Garder</span></span></label>
    <label class="opt"><input type="radio" name="q${n}" value="écarter"><span><span class="opt-t">Écarter</span></span></label>
    <label class="opt"><input type="radio" name="q${n}" value="je ne sais pas"><span><span class="opt-t">Je ne sais pas</span></span></label>
  </div>
  <div class="note"><textarea data-note="${n}" placeholder="Remarque"></textarea></div>
</section>`
  }

  /**
   * Une liste de cartes déjà en ordre de planche, avec un sous-titre à chaque
   * changement de cas — jamais par état, un plan bimodal partage un seul
   * `stake` entre ses états. `card.stake` porte celui du cas, pas besoin de le
   * relire ailleurs.
   */
  function groupHtml(list: readonly Board['cards'][number][]): string {
    const parts: string[] = []
    let lastCaseId: string | null = null
    for (const card of list) {
      if (card.caseId !== lastCaseId) {
        parts.push(
          `<div class="case-heading"><h3>${escapeHtml(card.caseId)} — ${escapeHtml(`${card.shot.start}-${card.shot.end}`)}</h3><p class="q-stake">${escapeHtml(card.stake)}</p></div>`,
        )
        lastCaseId = card.caseId
      }
      parts.push(cardHtml(card))
    }
    return parts.join('\n\n')
  }

  // Une carte se range sous la section qui déclare son cas (`section.cases`),
  // en ordre de spec. Une carte dont le cas n'apparaît dans aucune section —
  // planche mal formée, ou jeu de test qui ne câble pas `cases` — reste
  // affichée quand même, hors section plutôt que perdue.
  const sectionOfCase = new Map<string, number>()
  spec.sections.forEach((section, i) => {
    for (const c of section.cases ?? []) sectionOfCase.set(c.id, i)
  })
  const bySection: Board['cards'][number][][] = spec.sections.map(() => [])
  const orphanCards: Board['cards'][number][] = []
  for (const card of cards) {
    const idx = sectionOfCase.get(card.caseId)
    if (idx === undefined) orphanCards.push(card)
    else bySection[idx].push(card)
  }

  const sectionsHtml = spec.sections
    .map((section, i) => {
      const lede = section.lede ? `\n  <p class="lede">${escapeHtml(section.lede)}</p>` : ''
      const html = section.html ? `\n  ${section.html}` : ''
      const sectionCards = bySection[i]
      const cardsBlock = sectionCards.length > 0 ? `\n${groupHtml(sectionCards)}` : ''
      return `<section class="board-section">
  <h2>${escapeHtml(section.title)}</h2>${lede}${html}
${cardsBlock}
</section>`
    })
    .join('\n\n')

  const orphanHtml = orphanCards.length > 0 ? groupHtml(orphanCards) : ''

  const script = renderScript({
    key: `avolo-board:${spec.id}`,
    commit,
    settled: spec.settled,
    strings: T,
  })

  return `<title>${escapeHtml(spec.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=JetBrains+Mono:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">

<style>
${STYLE_CSS}
${BOARD_CSS}
</style>

<div class="bar">
  <div class="bar-in">
    <span class="bar-label" id="prog">0 / ${total} ${T.progressNoun}</span>
    <span class="track"><span class="fill" id="fill"></span></span>
  </div>
</div>

<div class="wrap">
<div class="col">

<header>
  <p class="eyebrow">${escapeHtml(spec.eyebrow)}</p>
  <h1>${escapeHtml(spec.title)}</h1>
  <p class="lede">${escapeHtml(spec.lede)}</p>
</header>

${calloutHtml}<section class="settled">
  <h2>${T.settledHeading}</h2>
  <ul>
${settledItems}
  </ul>
</section>

${sectionsHtml}

${orphanHtml}

<section class="out">
  <h2>Copier la planche</h2>
  <p class="sub">Coche, commente, puis copie le bloc pour le registre.</p>
  <textarea id="remarks" placeholder="Remarques générales"></textarea>
  <div class="actions">
    <button type="button" id="copy">Copier</button>
    <button type="button" class="ghost" id="reset">Effacer</button>
    <span class="status" id="status" role="status" aria-live="polite"></span>
  </div>
  <pre id="preview"></pre>
</section>

<footer>Généré le ${escapeHtml(board.generatedAt)} — commit ${escapeHtml(commit)}</footer>

</div>
</div>

<script>
${script}
</script>`
}
