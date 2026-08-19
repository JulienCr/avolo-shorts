'use client'

import { CircleAlert, Info, RotateCcw } from 'lucide-react'
import { useId, useState } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { type AiSettings, type LlmAvailability, type LlmProvider, LLM_PROVIDERS } from '@/lib/api'

/**
 * La section « Intelligence artificielle » des réglages (retour d'usage §6.1) :
 * le fournisseur et le modèle de chaque usage — repérage, correction du
 * transcript, génération du hook —, plus l'adresse d'un serveur Ollama.
 *
 * **Seul le repérage agit.** La correction du transcript et le hook n'existent
 * pas encore : leurs réglages se posent et se persistent, comme le contrat le
 * demande, mais rien ne les lit. Chacun des deux porte donc son propre bandeau
 * — la forme retenue par `HookSection` pour le même problème, mais **pas la
 * même solution** : là-bas, rien ne s'écrit, parce qu'aucun stockage n'existe
 * encore pour ces valeurs. Ici, le stockage existe — c'est tout l'objet de
 * cette PR — donc les champs restent actifs, réglables et persistés ; seul le
 * bandeau change, pour ne jamais laisser croire qu'un réglage agit alors
 * qu'aucun code ne le lit.
 *
 * **Changer un réglage ne recalcule rien** (retour d'usage §6.1 et §11), comme
 * le reste de cet écran : un recalcul reste une action explicite, depuis
 * l'écran de l'émission.
 */

const PROVIDER_LABELS: Record<LlmProvider, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  ollama: 'Ollama (local)',
}

/**
 * Le modèle suggéré par défaut, par fournisseur — recopié de `DEFAULT_MODEL`
 * (`@/server/llm/defaults`). **Dupliqué à dessein plutôt qu'importé** : ce
 * fichier est un composant client, et `@/server/llm/defaults` vit sous
 * `src/server/`, dont rien ne devrait traverser vers le navigateur — même une
 * simple constante, pour ne pas ouvrir un chemin d'import que Next se mettrait
 * à couper au premier module serveur qui s'y ajoute.
 */
const MODEL_HINT: Record<LlmProvider, string> = {
  gemini: 'gemini-3.1-flash-lite',
  openai: 'gpt-4.1-mini',
  ollama: 'llama3.1',
}

type Usage = {
  key: 'selection' | 'correction' | 'hook'
  providerField: keyof AiSettings
  modelField: keyof AiSettings
  title: string
  help: string
  /** `null` : l'usage est branché, rien à dire de plus. */
  bandeau: string | null
}

const USAGES: readonly Usage[] = [
  {
    key: 'selection',
    providerField: 'selectionProvider',
    modelField: 'selectionModel',
    title: 'Repérage',
    help: 'Le modèle qui note les fenêtres du transcript et détaille les propositions de clips.',
    bandeau: null,
  },
  {
    key: 'correction',
    providerField: 'correctionProvider',
    modelField: 'correctionModel',
    title: 'Correction du transcript',
    help: 'Le modèle qui corrigerait les fautes de reconnaissance vocale du transcript.',
    bandeau:
      'Ce réglage se persiste, mais rien ne le lit : la correction du transcript n’existe pas encore.',
  },
  {
    key: 'hook',
    providerField: 'hookProvider',
    modelField: 'hookModel',
    title: 'Hook',
    help: 'Le modèle qui écrirait le texte d’accroche affiché en début de clip.',
    bandeau:
      'Ce réglage se persiste, mais rien ne le lit : la génération automatique du hook n’existe pas encore.',
  },
]

export function AiSection({
  values,
  availability,
  disabled = false,
  onChange,
}: {
  values: AiSettings
  /** `undefined` tant que la disponibilité n'a pas fini de se charger. */
  availability: LlmAvailability | undefined
  disabled?: boolean
  onChange: (patch: Partial<AiSettings>) => void | Promise<unknown>
}) {
  return (
    <section aria-labelledby="titre-ai" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="titre-ai" className="text-base font-semibold tracking-tight">
          Intelligence artificielle
        </h2>
        <p className="text-sm text-muted-foreground">
          Le fournisseur et le modèle de chaque usage. Ils se règlent
          séparément : Gemini pour le repérage, Ollama pour la correction du
          transcript par exemple. Changer un réglage ne recalcule rien.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {USAGES.map((usage) => (
          <UsageRow
            key={usage.key}
            usage={usage}
            provider={values[usage.providerField] as LlmProvider}
            model={values[usage.modelField] as string}
            availability={availability}
            disabled={disabled}
            onChange={onChange}
          />
        ))}
      </div>

      <OllamaUrlField value={values.ollamaBaseUrl} disabled={disabled} onChange={onChange} />
    </section>
  )
}

function UsageRow({
  usage,
  provider,
  model,
  availability,
  disabled,
  onChange,
}: {
  usage: Usage
  provider: LlmProvider
  model: string
  availability: LlmAvailability | undefined
  disabled: boolean
  onChange: (patch: Partial<AiSettings>) => void | Promise<unknown>
}) {
  const providerId = useId()
  const modelId = useId()
  const état = availability?.[provider]

  return (
    <div className="flex flex-col gap-3 rounded-xl border px-4 py-3">
      {/* **Un `<p>`, pas un `<h3>`.** Le libellé de l'usage — « Hook », par
          exemple — répéterait sinon le titre de `HookSection` plus bas dans
          le même document : deux titres identiques dans l'arbre
          d'accessibilité, que `getByRole('heading', { name })` ne peut plus
          départager. Ce n'est pas une rubrique de la page, c'est le nom
          d'une ligne dans une liste. */}
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{usage.title}</p>
        <p className="text-xs text-muted-foreground">{usage.help}</p>
      </div>

      {usage.bandeau !== null && (
        <Alert>
          <Info aria-hidden />
          <AlertDescription>{usage.bandeau}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={providerId} className="text-sm font-normal">
            Fournisseur
          </Label>
          <Select
            value={provider}
            disabled={disabled}
            onValueChange={(valeur) => {
              const suivant = valeur as LlmProvider
              // **Le fournisseur seul change, jamais le modèle à sa place.**
              // Un modèle valable chez l'un part en 404 chez l'autre
              // (`CLAUDE.md`) ; forcer une valeur ici écraserait une saisie
              // que la personne vient peut-être de faire exprès. L'indice
              // sous la boîte de modèle dit ce qui marche chez ce
              // fournisseur, sans se substituer au choix.
              void onChange({ [usage.providerField]: suivant })
            }}
          >
            <SelectTrigger id={providerId} className="w-40">
              <SelectValue>{PROVIDER_LABELS[provider]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {LLM_PROVIDERS.map((p) => (
                <SelectItem key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <ModelField
          id={modelId}
          label="Modèle"
          value={model}
          hint={MODEL_HINT[provider]}
          disabled={disabled}
          onCommit={(valeur) => onChange({ [usage.modelField]: valeur })}
        />
      </div>

      {état !== undefined && !état.available && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>{PROVIDER_LABELS[provider]} n’a pas de clé configurée.</AlertTitle>
          <AlertDescription>
            {état.reason ?? 'La clé de ce fournisseur est absente.'} Un repérage avec ce
            fournisseur échouera avant le premier appel.
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

/**
 * Une boîte de texte pour un nom de modèle. **Un brouillon local, validé en
 * quittant le champ** — même geste que `SelectionSection` (`selection-section.tsx`)
 * pour ses champs numériques, et pour la même raison : un modèle tapé lettre
 * par lettre n'a rien à envoyer avant la dernière lettre.
 */
function ModelField({
  id,
  label,
  value,
  hint,
  disabled,
  onCommit,
}: {
  id: string
  label: string
  value: string
  hint: string
  disabled: boolean
  onCommit: (value: string) => void | Promise<unknown>
}) {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }

  function commit() {
    const propre = draft.trim()
    if (propre === '') return setDraft(value)
    if (propre === value) return
    void Promise.resolve(onCommit(propre)).catch(() => setDraft(value))
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <Input
        id={id}
        disabled={disabled}
        value={draft}
        placeholder={hint}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
        className="h-8 w-56 font-mono text-sm"
      />
    </div>
  )
}

function OllamaUrlField({
  value,
  disabled,
  onChange,
}: {
  value: string
  disabled: boolean
  onChange: (patch: Partial<AiSettings>) => void | Promise<unknown>
}) {
  const id = useId()
  const helpId = `${id}-help`
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }

  function commit() {
    const propre = draft.trim()
    if (propre === value) return
    void Promise.resolve(onChange({ ollamaBaseUrl: propre })).catch(() => setDraft(value))
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Label htmlFor={id} className="text-sm font-medium">
          Adresse du serveur Ollama
        </Label>
        <Input
          id={id}
          disabled={disabled}
          aria-describedby={helpId}
          value={draft}
          placeholder="vide = résolue automatiquement"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          className="h-8 w-64 font-mono text-sm"
        />
        {value !== '' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => void onChange({ ollamaBaseUrl: '' })}
            className="ml-auto text-xs"
          >
            <RotateCcw aria-hidden />
            Revenir à la résolution automatique
          </Button>
        )}
      </div>
      <p id={helpId} className="text-xs text-muted-foreground">
        Laisser vide résout la passerelle WSL vers l’hôte Windows à chaque
        appel — l’adresse change au redémarrage, elle ne se code pas en dur. Ne
        renseigner que si Ollama tourne ailleurs, ou si cette résolution
        échoue.
      </p>
    </div>
  )
}
