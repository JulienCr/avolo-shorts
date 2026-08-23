'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { FileText, RotateCcw, Wand2 } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'

import { count } from '@/core/phase'
import { ApiError, type CandidateClip, type CorrectionEntry } from '@/lib/api'
import { indexTranscript, wordsToText, type IndexedLine, type TranscriptLine } from '@/lib/editing'
import { formatTimecode } from '@/lib/format'
import { linkProject } from '@/lib/navigation'
import {
  keys,
  useCandidates,
  useCorrectionHistory,
  useCorrectTranscript,
  useProject,
  useRemoveCorrectionEntry,
  useRetry,
  useTranscript,
  useUndoCorrection,
} from '@/lib/queries'
import { agreement } from '@/components/review/template'
import { ButtonRetry } from '@/components/review/retry'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'

/**
 * Le transcript **entier** de l'émission, administré depuis la vue Émission
 * (§2.3) : le voir, le corriger à la main, relancer la transcription.
 *
 * **Une grande surface, pas une modale classique.** Le §2.3 le demande
 * explicitement, et le parcours §3.0 pose la règle plus générale — rien ne
 * s'ouvre en modale sauf une confirmation. L'arbitrage retenu ici : un
 * `Sheet` large (`sm:max-w-3xl`), piloté par `?transcript=1` dans l'URL — pas
 * un état de composant —, pour que l'écran reste rechargeable et l'URL
 * partageable. `useTranscriptPanelUrl` est le seul endroit qui touche cette
 * clé ; `?vue=` (le fil de tri, dans `ecran-projet.tsx`) est une clé
 * différente et les deux cohabitent sans se marcher dessus.
 *
 * **Ce n'est pas la surface d'édition du clip.** `TranscriptSurface`
 * (`src/components/clip/transcript-surface.tsx`) sait retirer des passages
 * et poser des bornes de montage : rien de tout cela n'a de sens ici, où l'on
 * corrige le *texte* d'une émission entière, pas le montage d'un extrait.
 * D'où un module séparé plutôt qu'une variante de celui-là.
 *
 * **Virtualisée par phrase**, comme l'autre surface, et pour la même raison :
 * une émission fait environ 20 000 mots, et `useVirtualizer` mesure la
 * hauteur de son conteneur de défilement réel — jamais `scroll-area`
 * (parcours §6.2), qui interposerait le sien et ferait retomber
 * `scrollToIndex` à côté.
 *
 * **Le clavier reprend le tabindex glissant de `TranscriptSurface`,
 * cette fois-ci réutilisé et pas seulement lu.** La première version posait
 * `tabIndex={0}` sur chaque mot : sous vingt mille mots virtualisés, Tab
 * n'atteignait que ceux déjà montés dans la fenêtre de rendu — une poignée —
 * avant de sauter tout droit au bouton de fermeture, et un défilement à la
 * molette qui démonte le mot focalisé laissait le focus retomber sur le
 * corps du document. Vérifié, pas supposé : une trace de tabulation sur
 * soixante phrases s'arrêtait au septième mot avant de sauter à « Fermer »,
 * et démonter le mot focalisé faisait retomber `document.activeElement` sur
 * `<body>`. Un seul mot — celui du curseur — porte `tabIndex={0}` à la fois ;
 * tous les autres portent `-1`. Les flèches déplacent le curseur, y compris
 * vers un mot pas encore rendu : `virtualizer.scrollToIndex` l'amène dans la
 * fenêtre, puis un effet qui suit chaque rendu lui donne le focus DOM une
 * fois monté — ou, à défaut, au conteneur lui-même, qui ne devient un arrêt
 * de tabulation que lorsque le mot du curseur n'est pas rendu. Entrée ou
 * Espace sélectionne le mot pour le corriger ; majuscule-flèche étend la
 * sélection, bornée à la phrase du curseur.
 */
export function TranscriptTrigger({ projectId }: { projectId: string }) {
  const [open, setOpen] = useTranscriptPanelUrl(projectId)
  return <TranscriptPanel projectId={projectId} open={open} onOpenChange={setOpen} />
}

/**
 * La présence de `?transcript=1` dans l'URL, et le geste qui la pose ou la
 * retire.
 *
 * **Les autres paramètres survivent.** Un `URLSearchParams` reconstruit
 * depuis `useSearchParams().toString()` avant d'ajouter ou de retirer la
 * clé : sans cela, ouvrir le transcript depuis la vue « gardés »
 * (`?vue=gardes`) l'aurait fait disparaître de l'URL.
 */
export function useTranscriptPanelUrl(projectId: string): [boolean, (open: boolean) => void] {
  const router = useRouter()
  const searchParams = useSearchParams()
  const open = searchParams.get('transcript') === '1'

  function setOpen(next: boolean) {
    const params = new URLSearchParams(searchParams.toString())
    if (next) params.set('transcript', '1')
    else params.delete('transcript')
    const query = params.toString()
    router.replace(`${linkProject(projectId)}${query === '' ? '' : `?${query}`}`, { scroll: false })
  }

  return [open, setOpen]
}

/**
 * Une sélection en cours : un empan de mots. Les deux bornes sont des index
 * **globaux** — dans la liste plate de tous les mots de l'émission, comme le
 * rend `indexTranscript` — jamais des index locaux à une phrase : c'est ce
 * qui permet au curseur clavier de désigner n'importe quel mot, y compris un
 * qui n'est pas encore rendu.
 *
 * **Toujours bornée à la phrase de l'ancre.** L'API de correction est
 * bornée à une phrase (`WordCorrection`, `src/lib/editing.ts`) ; laisser la
 * sélection déborder visuellement dans une autre poserait une sélection que
 * la correction ne pourrait jamais accepter. `clampToLine` referme le cas à
 * la source plutôt que de le rejeter après coup.
 */
type Selection = { anchor: number; cursor: number }

/** Une référence stable, pour ne pas recréer `[]` à chaque rendu. */
const EMPTY_LINES: TranscriptLine[] = []

function selectionBounds(selection: Selection): { from: number; to: number } {
  return {
    from: Math.min(selection.anchor, selection.cursor),
    to: Math.max(selection.anchor, selection.cursor),
  }
}

/** La phrase qui porte le mot `word`, par recherche dichotomique sur ses bornes. */
function lineOfWord(indexedLines: IndexedLine[], word: number): number {
  let low = 0
  let high = indexedLines.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (word < indexedLines[mid].from) high = mid - 1
    else if (word >= indexedLines[mid].to) low = mid + 1
    else return mid
  }
  return -1
}

/** Ramène `word` à l'intérieur de la phrase `lineIndex`, sans jamais en sortir. */
function clampToLine(indexedLines: IndexedLine[], lineIndex: number, word: number): number {
  const line = indexedLines[lineIndex]
  if (line === undefined) return word
  return Math.min(Math.max(word, line.from), line.to - 1)
}

export function TranscriptPanel({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // **`enabled: open`** : `TranscriptPanel` est monté en permanence par
  // `TranscriptTrigger`, donc ses hooks tournent à chaque rendu qu'il soit
  // visible ou non. Rien ne justifie de tirer ~20 000 mots avant que quelqu'un
  // ait effectivement ouvert le transcript.
  const transcript = useTranscript(projectId, { enabled: open })
  const correction = useCorrectTranscript()
  const project = useProject(projectId, { enabled: open })
  const history = useCorrectionHistory(projectId, { enabled: open })
  const undo = useUndoCorrection()
  const remove = useRemoveCorrectionEntry()
  const client = useQueryClient()

  // Une référence stable : `[]` recréé à chaque rendu casserait le useMemo
  // juste en dessous, qui recalculerait indexTranscript à chaque frappe.
  const lines = transcript.data ?? EMPTY_LINES

  // **Aplati une fois, pour l'indexation globale que le clavier exige.**
  // `segments: []` : `indexTranscript` calcule aussi un statut « monté »
  // hérité de l'écran de clip, sans objet ici — jamais aucun mot n'est
  // « monté » au sens de cette fonction, et ce champ n'est simplement pas lu.
  const indexed = useMemo(() => indexTranscript(lines, []), [lines])
  const words = indexed.words
  const indexedLines = indexed.lines

  const [cursor, setCursor] = useState(0)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [draft, setDraft] = useState('')
  const [retranscribeOpen, setRetranscribeOpen] = useState(false)
  // **Accumulés pour la séance, jamais persistés.** Ce n'est pas un état du
  // serveur — ni la correction manuelle ni la correction par modèle
  // n'appellent `discardRenderStale`, donc un rendu déjà exporté ne se
  // périme pas tout seul ici, même si l'empreinte sait comparer le texte
  // depuis #87 (`captionsContent`) —, c'est une trace de ce qu'on vient de
  // faire, pour que la conséquence reste visible sans qu'il faille la
  // retenir soi-même.
  const [touchedClips, setTouchedClips] = useState<Map<string, string>>(new Map())
  const [correctionsApplied, setCorrectionsApplied] = useState(0)

  // **La retranscription efface les corrections manuelles, sur le sidecar
  // comme sur cet écran.** WhisperX remplace le fichier entier : le bandeau
  // « corrections appliquées » et les clips « concernés » qu'il affiche ne
  // correspondraient plus à rien une fois le nouveau texte chargé. On ne se
  // fie ni à `indexed` ni à la réponse de correction pour le détecter — les deux
  // changent aussi après une correction manuelle, dont ce bandeau doit au
  // contraire survivre — mais à la transition `running → null` de ce projet,
  // le même signal que `useProject` utilise pour invalider le cache du
  // transcript. Une sélection ouverte est également abandonnée : son ancre
  // porterait l'ancien texte. (relevé par Copilot)
  //
  // **Seulement quand l'étape `transcript` a tourné**, pas à la fin de
  // n'importe quelle exécution. Le bouton « Relancer le repérage » du
  // bandeau lance un repérage seul (`target: 'candidates'`, sans
  // `force: ['transcript']`) : cette passe ne réexporte aucun clip, et
  // « corrections appliquées »/« clips concernés » restent exacts à sa fin.
  // Les effacer là aurait fait disparaître un avertissement encore vrai.
  // (relevé par Copilot)
  //
  // **L'historique s'invalide à la fin de toute exécution observée, jamais
  // sur une étape déduite.** Avant cette PR, l'invalidation ne suivait que
  // `sawCorrectionStep` (et `sawTranscriptStep`, pour la même raison) : un
  // sondage de deux secondes qui manque une étape `correction` courte —
  // démarrée et finie entre deux tours — ne la voit jamais, et l'écran garde
  // son cache jusqu'au prochain rechargement manuel (issue #135). Suivre la
  // seule transition `wasRunning → !isRunning` ferme le cas sans avoir à
  // deviner quelles étapes sont passées : un aller-retour de trop sur une
  // exécution qui n'a rien changé au journal coûte moins qu'un affichage en
  // retard.
  const wasRunning = useRef(false)
  // **Restreint aux clips touchés, pas à l'historique.** `transcript.json`
  // repart entier après une retranscription : le bandeau « corrections
  // appliquées »/« clips concernés » ne correspondrait plus à rien une fois
  // le nouveau texte chargé. Un repérage seul (`target: 'candidates'`, sans
  // `force: ['transcript']`) ne réexporte aucun clip, et l'effacer là ferait
  // disparaître un avertissement encore vrai — cette portion reste donc
  // gardée par l'étape `transcript` réellement observée. (relevé par Copilot)
  const sawTranscriptStep = useRef(false)
  useEffect(() => {
    const running = project.data?.running ?? null
    if (running?.step === 'transcript') sawTranscriptStep.current = true
    const isRunning = running != null
    if (wasRunning.current && !isRunning) {
      if (sawTranscriptStep.current) {
        setTouchedClips(new Map())
        setCorrectionsApplied(0)
        setSelection(null)
        setDraft('')
      }
      void client.invalidateQueries({ queryKey: keys.correctionHistory(projectId) })
      sawTranscriptStep.current = false
    }
    wasRunning.current = isRunning
  }, [project.data?.running, client, projectId])

  const container = useRef<HTMLDivElement>(null)
  // Le compilateur React signale ici qu'il renonce à mémoïser ce composant :
  // `useVirtualizer` rend des fonctions dont le résultat change à chaque
  // défilement. C'est le comportement voulu, comme dans `TranscriptSurface`,
  // dont le commentaire porte la raison de le rendre muet ici aussi.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => container.current,
    estimateSize: () => 60,
    overscan: 6,
  })

  /**
   * Ouvre la phrase qui porte `word` et lui donne le focus, une fois montée.
   *
   * **`toFocus` porte l'intention d'une image à l'autre.** `scrollToIndex`
   * ne monte le mot que dans un rendu ultérieur ; le focaliser tout de suite
   * viserait un nœud qui n'existe pas encore. L'effet plus bas s'exécute
   * après chaque rendu et referme la boucle : si le drapeau est levé, il
   * cherche `[data-word="${cursor}"]` et le focalise, ou retombe sur le
   * conteneur si ce mot précis n'est toujours pas monté.
   */
  function moveCursorTo(word: number, extend: boolean) {
    const clamped = Math.min(Math.max(word, 0), Math.max(0, words.length - 1))
    let target = clamped

    if (extend) {
      const anchor = selection?.anchor ?? cursor
      const anchorLine = lineOfWord(indexedLines, anchor)
      target = clampToLine(indexedLines, anchorLine, clamped)
      const bounds = { from: Math.min(anchor, target), to: Math.max(anchor, target) }
      setSelection({ anchor, cursor: target })
      setDraft(words.slice(bounds.from, bounds.to + 1).map((w) => w.word).join(' '))
    } else {
      setSelection(null)
      setDraft('')
    }

    setCursor(target)
    toFocus.current = true
    const line = lineOfWord(indexedLines, target)
    if (line >= 0) virtualizer.scrollToIndex(line, { align: 'center' })
  }

  function onWordKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowRight') moveCursorTo(cursor + 1, e.shiftKey)
    else if (e.key === 'ArrowLeft') moveCursorTo(cursor - 1, e.shiftKey)
    else if (e.key === 'ArrowDown') {
      const line = lineOfWord(indexedLines, cursor)
      moveCursorTo(indexedLines[line + 1]?.from ?? words.length - 1, e.shiftKey)
    } else if (e.key === 'ArrowUp') {
      const line = lineOfWord(indexedLines, cursor)
      moveCursorTo(indexedLines[line - 1]?.from ?? 0, e.shiftKey)
    } else if (e.key === 'Home') moveCursorTo(0, false)
    else if (e.key === 'End') moveCursorTo(words.length - 1, false)
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      selectWord(cursor, false)
      return
    } else return
    e.preventDefault()
  }

  // **Le mot du curseur reçoit le focus une fois monté, jamais avant.**
  // Sans effet séparé, `moveCursorTo` focaliserait un nœud qui n'existe pas
  // encore — `scrollToIndex` ne fait que programmer le défilement, le mot
  // n'est monté qu'au rendu suivant. Sans dépendances : il tourne après
  // *chaque* rendu, et se tait dès que le drapeau retombe.
  const toFocus = useRef(false)
  useEffect(() => {
    if (!toFocus.current) return
    toFocus.current = false
    const target = container.current?.querySelector<HTMLElement>(`[data-word="${cursor}"]`)
    if (target) target.focus()
    else container.current?.focus()
  })

  function selectWord(word: number, extend: boolean) {
    setCursor(word)
    if (extend && selection !== null) {
      const anchorLine = lineOfWord(indexedLines, selection.anchor)
      const target = clampToLine(indexedLines, anchorLine, word)
      const bounds = { from: Math.min(selection.anchor, target), to: Math.max(selection.anchor, target) }
      setSelection({ anchor: selection.anchor, cursor: target })
      setDraft(words.slice(bounds.from, bounds.to + 1).map((w) => w.word).join(' '))
    } else {
      setSelection({ anchor: word, cursor: word })
      setDraft(words[word]?.word ?? '')
    }
  }

  function clearSelection() {
    setSelection(null)
    setDraft('')
  }

  function submitCorrection() {
    // `aria-disabled` seul ne bloque rien : le bouton reste cliquable, et
    // Entrée l'appelle aussi. Sans ce garde, un second appel part avant la
    // réponse du premier et finit en 409 — voire prend part à la course
    // d'écriture que `correctTranscript` sérialise déjà côté serveur, mais
    // pour rien de plus qu'un double envoi réseau. (relevé par Copilot et par
    // Aristarque)
    if (correction.isPending) return
    if (selection === null) return
    const { from, to } = selectionBounds(selection)
    const lineIndex = lineOfWord(indexedLines, from)
    const line = indexedLines[lineIndex]
    if (line === undefined) return
    const expected = words.slice(from, to + 1).map((w) => w.word)
    const replacement = draft.trim() === '' ? [] : draft.trim().split(/\s+/)

    correction.mutate(
      {
        projectId,
        correction: { lineId: line.id, from: from - line.from, to: to - line.from, expected, replacement },
      },
      {
        onSuccess(result) {
          clearSelection()
          setCorrectionsApplied((n) => n + 1)
          if (result.clipsTouched.length > 0) {
            setTouchedClips((previous) => {
              const next = new Map(previous)
              for (const c of result.clipsTouched) next.set(c.id, c.title)
              return next
            })
          }
        },
      },
    )
  }

  /**
   * Défait une entrée de l'historique — l'inverse, par le même chemin
   * d'écriture que la correction manuelle.
   * @remarks Pas d'écriture optimiste, comme `submitCorrection` : un défaire
   * refusé (409, le texte a changé sous les yeux) doit laisser l'historique
   * tel qu'il est vraiment sur le disque.
   */
  function undoEntry(entry: CorrectionEntry) {
    if (undo.isPending) return
    undo.mutate(
      { projectId, id: entry.id },
      {
        onSuccess(result) {
          setCorrectionsApplied((n) => n + 1)
          if (result.clipsTouched.length > 0) {
            setTouchedClips((previous) => {
              const next = new Map(previous)
              for (const c of result.clipsTouched) next.set(c.id, c.title)
              return next
            })
          }
        },
      },
    )
  }

  /**
   * Retire une entrée sans toucher au transcript — le rattrapage de dernier
   * recours (issues #134, #138) quand son ancre est devenue périmée et que
   * `undoEntry` ne peut plus rien pour elle.
   */
  function removeEntry(entry: CorrectionEntry) {
    if (remove.isPending) return
    remove.mutate({ projectId, id: entry.id })
  }

  const items = virtualizer.getVirtualItems()
  const touchedClipsList = Array.from(touchedClips.values())
  const cursorLine = lineOfWord(indexedLines, cursor)
  const cursorRendered = items.some((item) => item.index === cursorLine)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* **`SheetTrigger`, pas un bouton qui bascule un booléen à côté.**
          C'est lui que la primitive refocalise à la fermeture — le même
          contrat que `TranscriptDrawer` documente pour le tiroir de montage
          (`src/components/clip/transcript-drawer.tsx:53-55,133-140`). Un
          bouton extérieur au `Sheet` ne le garantit pas. (relevé par Copilot) */}
      <SheetTrigger render={<Button variant="outline" size="sm" />}>
        <FileText aria-hidden />
        Voir le transcript
      </SheetTrigger>

      <SheetContent side="right" className="w-full sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>Le transcript de l’émission</SheetTitle>
          <SheetDescription>
            Cliquer un mot pour le corriger, ou majuscule-cliquer le dernier d’un empan pour en
            corriger plusieurs à la fois.
          </SheetDescription>
        </SheetHeader>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
          <RetranscribeButton
            open={retranscribeOpen}
            onOpenChange={setRetranscribeOpen}
            projectId={projectId}
          />
          <RerunCorrectionButton
            projectId={projectId}
            inCurrent={(project.data?.running ?? null) !== null}
          />
        </div>

        {/* **La panne tolérée de la correction automatique, si la dernière
            analyse en a signalé une — `project.data.warning`, distinct
            d'`error` depuis les issues #137/#140.** L'étape avale une panne
            du modèle plutôt que de bloquer tout le plan (`src/server/run.ts`) ;
            ce bandeau est le rattrapage explicite promis en échange — le
            bouton juste au-dessus le fait. */}
        {project.data?.warning !== null &&
          project.data?.warning !== undefined &&
          (project.data?.running ?? null) === null && (
            <div className="shrink-0 border-b px-4 py-2">
              <Alert>
                <AlertDescription>{project.data.warning}</AlertDescription>
              </Alert>
            </div>
          )}

        {/* **`transcript.data !== undefined`, pas seulement `history.data`.**
            L'historique se charge indépendamment du transcript, souvent plus
            vite : sans cette garde, `lines` vaut encore `EMPTY_LINES` le temps
            que la requête du transcript réponde, et `stale` (ci-dessous)
            classe alors chaque entrée valide comme périmée — un bouton
            destructif immédiatement cliquable sur un historique qui ne l'est
            pas (relevé par Copilot et Codex). */}
        {history.data !== undefined && history.data.length > 0 && transcript.data !== undefined && (
          <CorrectionHistory
            entries={history.data}
            lines={lines}
            undoing={undo.isPending}
            onUndo={undoEntry}
            removing={remove.isPending}
            onRemove={removeEntry}
          />
        )}

        {/* **Les deux échouaient en silence.** `history.data` indéfini ressemble à
            une liste vide, et un « Défaire » refusé (409 ancre changée, ou
            retranscription en cours) ne rendait rien : le bouton semblait n'avoir
            aucun effet. Même traitement que la correction manuelle un peu plus
            bas. (relevé par Copilot et Codex) */}
        {history.isError && (
          <div className="shrink-0 border-b px-4 py-2">
            <span role="alert" className="text-xs text-destructive">
              L’historique de correction ne se charge pas : {errorMessage(history.error)}
            </span>
          </div>
        )}
        {undo.isError && (
          <div className="shrink-0 border-b px-4 py-2">
            <span role="alert" className="text-xs text-destructive">
              {rejectionMessage(undo.error)}
            </span>
          </div>
        )}
        {remove.isError && (
          <div className="shrink-0 border-b px-4 py-2">
            <span role="alert" className="text-xs text-destructive">
              {rejectionMessage(remove.error)}
            </span>
          </div>
        )}

        {correctionsApplied > 0 && (
          <div className="shrink-0 border-b px-4 py-2">
            <Alert>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {agreement(correctionsApplied, 'correction appliquée', 'corrections appliquées')} dans
                  cette séance. Le repérage lit encore l’ancien texte tant qu’il n’a pas repris.
                </span>
                <RerunDetectionBanner projectId={projectId} />
              </AlertDescription>
            </Alert>
            {touchedClipsList.length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                {agreement(touchedClipsList.length, 'Clip concerné', 'Clips concernés')} :{' '}
                {touchedClipsList.join(', ')}. Leurs sous-titres incrustés ne reflètent la
                correction qu’après un nouvel export.
              </p>
            )}
          </div>
        )}

        {selection !== null && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2">
            <Input
              autoFocus
              aria-label="Texte corrigé"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitCorrection()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  clearSelection()
                }
              }}
              placeholder="Texte corrigé…"
              className="max-w-xs"
            />
            <Button size="sm" onClick={submitCorrection} aria-disabled={correction.isPending}>
              Corriger
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              Annuler
            </Button>
            {correction.isError && (
              <span role="alert" className="text-xs text-destructive">
                {rejectionMessage(correction.error)}
              </span>
            )}
          </div>
        )}

        {transcript.isError && (
          <Alert variant="destructive" className="m-4">
            <AlertDescription>
              Le transcript ne se charge pas : {errorMessage(transcript.error)}
            </AlertDescription>
          </Alert>
        )}

        {!transcript.isPending && lines.length === 0 && transcript.isSuccess && (
          <p className="p-4 text-sm text-muted-foreground">
            Cette émission n’a pas encore de transcript. La transcription arrive avant le repérage.
          </p>
        )}

        <div
          ref={container}
          data-surface-transcript-show
          // Un seul arrêt de tabulation entre les mots et le conteneur : celui-ci
          // ne le devient que lorsque le mot du curseur n'est pas rendu, sans quoi
          // la surface aurait deux arrêts de tabulation au lieu d'un.
          tabIndex={cursorRendered ? -1 : 0}
          onKeyDown={onWordKeyDown}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const line = indexedLines[item.index]
              if (line === undefined) return null
              const lineWords = words.slice(line.from, line.to)
              const bounds = selection !== null ? selectionBounds(selection) : null
              return (
                <div
                  key={line.id}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <div className="flex gap-3 px-3 py-1.5">
                    <span className="w-14 shrink-0 pt-[0.3rem] text-right font-mono text-[0.75rem] text-muted-foreground/70 tabular-nums select-none">
                      {formatTimecode(line.start)}
                    </span>
                    <p className="flex-1 text-[0.97rem] leading-[1.95] text-pretty">
                      {lineWords.map((word) => {
                        // `aria-pressed` reprend le contrat déjà posé par
                        // `TranscriptSurface` (`src/components/clip/transcript-surface.tsx`) :
                        // la sélection n'était portée que par la couleur, donc
                        // invisible à un lecteur d'écran. (relevé par Copilot)
                        const isSelected =
                          bounds !== null && word.index >= bounds.from && word.index <= bounds.to
                        return (
                          <Fragment key={word.index}>
                            {/* L'espace est hors du bouton : un `inline-block`
                                supprime l'espace final de son contenu, là où le
                                `<span>` inline de `transcript-surface.tsx` le
                                garde. Ni `px-` ni `-mx-` ici : l'un élargit
                                l'espace, l'autre le mange. */}
                            <button
                              type="button"
                              data-word={word.index}
                              tabIndex={word.index === cursor ? 0 : -1}
                              aria-pressed={isSelected}
                              onClick={(e) => selectWord(word.index, e.shiftKey)}
                              className={`cursor-pointer rounded-[3px] outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${
                                isSelected ? 'bg-stage/35 text-foreground' : ''
                              }`}
                            >
                              {word.word}
                            </button>{' '}
                          </Fragment>
                        )
                      })}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * Relance la correction automatique, forcée — spec §9, correction du
 * 23 août 2026 : « une seule façon de corriger, pas deux ». Ce bouton ne
 * fait rien d'autre que ce que fait l'étape `correction` du graphe pendant
 * une analyse ; il ne réécrit rien lui-même.
 *
 * **`force: ['correction']` entraîne `candidates` avec lui** — c'est
 * `planSteps` qui le fait (`src/core/graph.ts`, « forced descend dans
 * l'aval ») : le repérage doit relire le texte que cette passe vient de
 * corriger.
 *
 * **Exporté et réutilisé par `ProjectScreen`** (`@/components/review/project-screen`),
 * dont le bandeau d'avertissement de correction propose le même geste. Un
 * seul endroit sait lancer ce `force`, plutôt que deux boutons qui pourraient
 * diverger.
 */
export function RerunCorrectionButton({ projectId, inCurrent }: { projectId: string; inCurrent: boolean }) {
  const retry = useRetry()
  const [open, setOpen] = useState(false)
  const blocked = inCurrent || retry.isPending

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        aria-disabled={blocked}
        onClick={() => {
          if (blocked) return
          setOpen(true)
        }}
      >
        <Wand2 aria-hidden />
        Relancer la correction automatique
      </Button>
      {retry.isError && (
        <span role="alert" className="text-xs text-destructive">
          {retry.error.message}
        </span>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Relancer la correction automatique ?</DialogTitle>
            <DialogDescription>
              Le modèle relit le transcript et applique de nouvelles substitutions, qui s’ajoutent à
              l’historique plutôt que de le remplacer.
            </DialogDescription>
          </DialogHeader>

          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            <li>Le repérage repart derrière, sur le texte à jour : c’est lui qui prend du temps.</li>
          </ul>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Annuler</DialogClose>
            <Button
              onClick={() => {
                setOpen(false)
                retry.mutate({ projectId, targets: 'candidates', force: ['correction'] })
              }}
            >
              Relancer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * L'historique de la correction automatique : ce qu'elle a changé, et de
 * quoi le défaire (spec §9, correction du 23 août 2026).
 *
 * **Remplace la relecture avant écriture de #128**, qui n'a plus d'objet : la
 * correction est déjà appliquée quand cet écran s'ouvre.
 * @remarks Virtualisée comme le reste du panneau (§2.3) : une émission
 * entière peut accumuler plusieurs centaines d'entrées, d'une passe à l'autre.
 */
function CorrectionHistory({
  entries,
  lines,
  undoing,
  onUndo,
  removing,
  onRemove,
}: {
  entries: CorrectionEntry[]
  lines: TranscriptLine[]
  undoing: boolean
  onUndo: (entry: CorrectionEntry) => void
  removing: boolean
  onRemove: (entry: CorrectionEntry) => void
}) {
  const lineById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines])
  const container = useRef<HTMLDivElement>(null)
  // Même raison que le virtualiseur du transcript lui-même : voir son commentaire.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => container.current,
    estimateSize: () => 56,
    overscan: 8,
  })
  const items = virtualizer.getVirtualItems()
  // Une seule file d'écriture sur `correction.json` : voir le commentaire au
  // point d'appel des deux boutons.
  const busy = undoing || removing

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b px-4 py-2">
      <p className="text-sm text-muted-foreground">
        {agreement(entries.length, 'substitution appliquée', 'substitutions appliquées')} par la
        correction automatique.
      </p>

      <div ref={container} className="max-h-64 overflow-y-auto rounded-md border">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const entry = entries[item.index]
            if (entry === undefined) return null
            const line = lineById.get(entry.lineId)
            // **Le même calcul que `applyWordCorrection` fait avant d'écrire un
            // défaire** (`@/lib/editing`), pour décider quel bouton offrir —
            // jamais pour se dispenser de la vraie garde côté serveur. Une
            // phrase absente ou un mot qui ne correspond plus dit que
            // `onUndo` échouerait en `anchor-mismatch`, pour toujours : la
            // seule sortie qui reste est de retirer l'entrée (issues #134,
            // #138).
            const stale = line === undefined || line.words[entry.from]?.word !== entry.replacement
            return (
              <div
                key={entry.id}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="absolute top-0 left-0 flex w-full items-start justify-between gap-2 px-2 py-1.5"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <div className="min-w-0 flex-1">
                  <span className="mr-2 font-mono text-[0.75rem] text-muted-foreground/70 tabular-nums">
                    {formatTimecode(entry.timecode)}
                  </span>
                  {line !== undefined && (
                    <p className="truncate text-xs text-muted-foreground">{wordsToText(line.words)}</p>
                  )}
                  <p className="text-sm">
                    <span className="text-muted-foreground line-through">{entry.expected.join(' ')}</span>
                    {' → '}
                    <span className="font-medium">{entry.replacement}</span>
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {/* **`busy`, pas seulement la mutation propre à ce bouton.**
                      Les deux routes réécrivent le même `correction.json` : un
                      retrait lancé pendant un défaire (ou l'inverse) lirait le
                      journal avant l'écriture de l'autre, puis écraserait sa
                      mise à jour (relevé par Copilot). */}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-disabled={busy}
                    onClick={() => {
                      if (busy) return
                      onUndo(entry)
                    }}
                  >
                    Défaire
                  </Button>
                  {/* **Toujours là quand l'ancre ne correspond plus** — jamais
                      en repli après un « Défaire » refusé, qui échouerait de
                      la même façon indéfiniment. */}
                  {stale && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs text-muted-foreground"
                      aria-disabled={busy}
                      onClick={() => {
                        if (busy) return
                        onRemove(entry)
                      }}
                    >
                      Retirer de l’historique
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'cause inconnue'
}

function rejectionMessage(error: Error): string {
  // **Le message du serveur, pas un texte générique par code HTTP.** Un 409
  // porte deux causes distinctes — l'ancre a changé, ou une retranscription
  // est en cours (`src/app/api/projects/[id]/transcript/route.ts`) — et
  // chacune a déjà son propre message côté serveur. Un texte fixe pour tout
  // 409 écrasait le second sous le premier. (relevé par Copilot)
  if (error instanceof ApiError) return error.message
  return `La correction n’est pas passée : ${error.message}`
}

/**
 * Relancer le repérage, après une ou plusieurs corrections.
 *
 * **Le même bouton que celui de l'écran de tri**, importé plutôt que
 * réécrit : `BoutonRelance` (`src/components/review/retry.tsx`) force déjà
 * `candidates` avec la confirmation qui énonce le partage — exactement le
 * geste qui fait relire le texte corrigé par le repérage. Il a besoin des
 * comptes de la grille (gardés, écartés, en attente), donc de la liste des
 * candidats, chargée ici pour cette seule raison.
 */
function RerunDetectionBanner({ projectId }: { projectId: string }) {
  const candidates = useCandidates(projectId)
  const project = useProject(projectId)
  const clips: CandidateClip[] = candidates.data ?? []
  return (
    <ButtonRetry
      projectId={projectId}
      count={count(clips)}
      inCurrent={(project.data?.running ?? null) !== null}
    />
  )
}

/**
 * Retranscrire l'émission : WhisperX reprend l'audio depuis le début.
 *
 * **Ce n'est plus une décision qu'on redoute** (ROADMAP, mesure du 19 août
 * 2026) : 1 min 41 pour 1 h 39, 59× le temps réel — neuf à quinze fois plus
 * vite que ce que la spec annonçait. Le coût réel est ailleurs : c'est le
 * repérage qui repart derrière, sur le nouveau texte, et c'est ce que le
 * dialogue doit dire plutôt que faire peur d'une opération qui ne coûte plus
 * grand-chose.
 *
 * **Passe par le graphe, jamais par une logique d'invalidation locale** :
 * `target: 'candidates', force: ['transcript']` refait le transcript *et* le
 * repérage en un seul appel — c'est `planSteps` qui fait descendre `force`
 * vers l'aval (`src/core/graph.ts`), pas cet écran.
 *
 * **Reprend la forme de `BoutonRelance`** plutôt que le composant lui-même :
 * les cibles, le texte de confirmation et ce qu'il faut dire du coût
 * diffèrent complètement d'un repérage forcé.
 */
export function RetranscribeButton({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const rerun = useRetry()
  const blocked = rerun.isPending

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant="outline"
        size="sm"
        aria-disabled={blocked}
        onClick={() => {
          if (blocked) return
          onOpenChange(true)
        }}
      >
        <RotateCcw aria-hidden />
        Retranscrire l’émission
      </Button>
      {rerun.isError && (
        <span role="alert" className="text-xs text-destructive">
          La retranscription n’est pas partie : {rerun.error.message}
        </span>
      )}

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Retranscrire l’émission ?</DialogTitle>
            <DialogDescription>
              WhisperX reprend l’audio depuis le début et remplace le transcript, corrections
              manuelles comprises.
            </DialogDescription>
          </DialogHeader>

          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            <li>
              La transcription elle-même est rapide — environ 1 min 40 pour 1 h 40 de replay — et
              n’est plus la partie qui coûte.
            </li>
            <li>Le repérage repart derrière, sur le nouveau texte : c’est lui qui prend du temps.</li>
          </ul>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Annuler</DialogClose>
            <Button
              onClick={() => {
                onOpenChange(false)
                rerun.mutate({ projectId, targets: 'candidates', force: ['transcript'] })
              }}
            >
              Retranscrire
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
