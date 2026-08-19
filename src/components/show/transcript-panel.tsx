'use client'

import { useVirtualizer } from '@tanstack/react-virtual'
import { FileText, RotateCcw } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useRef, useState } from 'react'

import { compter } from '@/core/parcours'
import { ApiError, type CandidateClip } from '@/lib/api'
import type { TranscriptLine } from '@/lib/editing'
import { formatTimecode } from '@/lib/format'
import { lienProjet } from '@/lib/parcours'
import { useCandidats, useCorrectTranscript, useProjet, useRelancer, useTranscript } from '@/lib/queries'
import { accord } from '@/components/tri/modele'
import { BoutonRelance } from '@/components/tri/relance'
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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

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
 * **Le clavier reste plus simple que celui de l'écran de clip.** Chaque mot
 * est un `<button>` réel, dans l'ordre naturel de tabulation : Tab, Entrée et
 * Espace fonctionnent partout sans rien écrire de plus, au prix d'un
 * parcours plus long qu'avec le curseur unique de `TranscriptSurface`.
 * Reprendre ce mécanisme-là — la moitié du fichier qui le porte — pour une
 * surface qui n'a ni retrait, ni bornes, ni restauration de mot n'aurait
 * ajouté que du risque à ce que cette PR livre.
 */
export function TranscriptTrigger({ projectId }: { projectId: string }) {
  const [open, setOpen] = useTranscriptPanelUrl(projectId)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <FileText aria-hidden />
        Voir le transcript
      </Button>
      <TranscriptPanel projectId={projectId} open={open} onOpenChange={setOpen} />
    </>
  )
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
    router.replace(`${lienProjet(projectId)}${query === '' ? '' : `?${query}`}`, { scroll: false })
  }

  return [open, setOpen]
}

/** Une sélection en cours : un empan de mots, dans une seule phrase. */
type Selection = { lineId: string; anchor: number; cursor: number }

function selectionBounds(selection: Selection): { from: number; to: number } {
  return {
    from: Math.min(selection.anchor, selection.cursor),
    to: Math.max(selection.anchor, selection.cursor),
  }
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

  const lines = transcript.data ?? []

  const [selection, setSelection] = useState<Selection | null>(null)
  const [draft, setDraft] = useState('')
  const [retranscrireOuvert, setRetranscrireOuvert] = useState(false)
  // **Accumulés pour la séance, jamais persistés.** Ce n'est pas un état du
  // serveur — le mécanisme d'empreinte de rendu ne compare pas encore le
  // texte pour décider qu'un rendu est périmé (voir le rapport de cette
  // PR) —, c'est une trace de ce qu'on vient de faire, pour que la
  // conséquence reste visible sans qu'il faille la retenir soi-même.
  const [clipsTouchés, setClipsTouchés] = useState<Map<string, string>>(new Map())
  const [correctionsEffectuées, setCorrectionsEffectuées] = useState(0)

  const conteneur = useRef<HTMLDivElement>(null)
  const virtualiseur = useVirtualizer({
    count: lines.length,
    getScrollElement: () => conteneur.current,
    estimateSize: () => 60,
    overscan: 6,
  })

  function choisirMot(line: TranscriptLine, index: number, étendre: boolean) {
    setSelection((précédente) => {
      if (étendre && précédente !== null && précédente.lineId === line.id) {
        return { ...précédente, cursor: index }
      }
      return { lineId: line.id, anchor: index, cursor: index }
    })
    const bornes = étendre && selection !== null && selection.lineId === line.id
      ? { from: Math.min(selection.anchor, index), to: Math.max(selection.anchor, index) }
      : { from: index, to: index }
    setDraft(line.words.slice(bornes.from, bornes.to + 1).map((w) => w.word).join(' '))
  }

  function annulerSélection() {
    setSelection(null)
    setDraft('')
  }

  function valider() {
    if (selection === null) return
    const line = lines.find((l) => l.id === selection.lineId)
    if (line === undefined) return
    const { from, to } = selectionBounds(selection)
    const expected = line.words.slice(from, to + 1).map((w) => w.word)
    const replacement = draft.trim() === '' ? [] : draft.trim().split(/\s+/)

    correction.mutate(
      { projectId, correction: { lineId: line.id, from, to, expected, replacement } },
      {
        onSuccess(résultat) {
          annulerSélection()
          setCorrectionsEffectuées((n) => n + 1)
          if (résultat.clipsTouched.length > 0) {
            setClipsTouchés((précédent) => {
              const suivant = new Map(précédent)
              for (const c of résultat.clipsTouched) suivant.set(c.id, c.title)
              return suivant
            })
          }
        },
      },
    )
  }

  const items = virtualiseur.getVirtualItems()
  const clipsTouchésListe = Array.from(clipsTouchés.values())

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
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
            open={retranscrireOuvert}
            onOpenChange={setRetranscrireOuvert}
            projectId={projectId}
          />
        </div>

        {correctionsEffectuées > 0 && (
          <div className="shrink-0 border-b px-4 py-2">
            <Alert>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {accord(correctionsEffectuées, 'correction appliquée', 'corrections appliquées')} dans
                  cette séance. Le repérage lit encore l’ancien texte tant qu’il n’a pas repris.
                </span>
                <RelancerRepérage projectId={projectId} />
              </AlertDescription>
            </Alert>
            {clipsTouchésListe.length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                {accord(clipsTouchésListe.length, 'Clip concerné', 'Clips concernés')} :{' '}
                {clipsTouchésListe.join(', ')}. Leurs sous-titres incrustés ne reflètent la
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
                  valider()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  annulerSélection()
                }
              }}
              placeholder="Texte corrigé…"
              className="max-w-xs"
            />
            <Button size="sm" onClick={valider} aria-disabled={correction.isPending}>
              Corriger
            </Button>
            <Button size="sm" variant="ghost" onClick={annulerSélection}>
              Annuler
            </Button>
            {correction.isError && (
              <span role="alert" className="text-xs text-destructive">
                {messageDeRefus(correction.error)}
              </span>
            )}
          </div>
        )}

        {transcript.isError && (
          <Alert variant="destructive" className="m-4">
            <AlertDescription>
              Le transcript ne se charge pas : {messageDErreur(transcript.error)}
            </AlertDescription>
          </Alert>
        )}

        {!transcript.isPending && lines.length === 0 && transcript.isSuccess && (
          <p className="p-4 text-sm text-muted-foreground">
            Cette émission n’a pas encore de transcript. La transcription arrive avant le repérage.
          </p>
        )}

        <div
          ref={conteneur}
          data-surface-transcript-émission
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-4"
        >
          <div className="relative w-full" style={{ height: virtualiseur.getTotalSize() }}>
            {items.map((item) => {
              const line = lines[item.index]
              const bornes =
                selection !== null && selection.lineId === line.id ? selectionBounds(selection) : null
              return (
                <div
                  key={line.id}
                  ref={virtualiseur.measureElement}
                  data-index={item.index}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <div className="flex gap-3 px-3 py-1.5">
                    <span className="w-14 shrink-0 pt-[0.3rem] text-right font-mono text-[0.75rem] text-muted-foreground/70 tabular-nums select-none">
                      {formatTimecode(line.start)}
                    </span>
                    <p className="flex-1 text-[0.97rem] leading-[1.95] text-pretty">
                      {line.words.map((mot, index) => (
                        <button
                          key={index}
                          type="button"
                          data-mot={`${line.id}-${index}`}
                          onClick={(e) => choisirMot(line, index, e.shiftKey)}
                          className={`-mx-0.5 cursor-pointer rounded-[3px] px-0.5 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${
                            bornes !== null && index >= bornes.from && index <= bornes.to
                              ? 'bg-stage/35 text-foreground'
                              : ''
                          }`}
                        >
                          {mot.word}{' '}
                        </button>
                      ))}
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

function messageDErreur(erreur: unknown): string {
  return erreur instanceof Error ? erreur.message : 'cause inconnue'
}

function messageDeRefus(erreur: Error): string {
  if (erreur instanceof ApiError && erreur.status === 409) {
    return 'Le texte a changé sous vos yeux. Fermez et rouvrez le transcript avant de corriger à nouveau.'
  }
  return `La correction n’est pas passée : ${erreur.message}`
}

/**
 * Relancer le repérage, après une ou plusieurs corrections.
 *
 * **Le même bouton que celui de l'écran de tri**, importé plutôt que
 * réécrit : `BoutonRelance` (`src/components/tri/relance.tsx`) force déjà
 * `candidates` avec la confirmation qui énonce le partage — exactement le
 * geste qui fait relire le texte corrigé par le repérage. Il a besoin des
 * comptes de la grille (gardés, écartés, en attente), donc de la liste des
 * candidats, chargée ici pour cette seule raison.
 */
function RelancerRepérage({ projectId }: { projectId: string }) {
  const candidats = useCandidats(projectId)
  const projet = useProjet(projectId)
  const clips: CandidateClip[] = candidats.data ?? []
  return (
    <BoutonRelance
      projectId={projectId}
      compte={compter(clips)}
      enCours={(projet.data?.running ?? null) !== null}
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
  const relance = useRelancer()
  const bloqué = relance.isPending

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant="outline"
        size="sm"
        aria-disabled={bloqué}
        onClick={() => {
          if (bloqué) return
          onOpenChange(true)
        }}
      >
        <RotateCcw aria-hidden />
        Retranscrire l’émission
      </Button>
      {relance.isError && (
        <span role="alert" className="text-xs text-destructive">
          La retranscription n’est pas partie : {relance.error.message}
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
                relance.mutate({ projectId, targets: 'candidates', force: ['transcript'] })
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
