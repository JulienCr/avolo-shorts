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
 * demande, mais rien ne les lit. Chacun des deux porte donc son trimmed banner
 * — la forme retenue par `HookSection` pour le même problème, mais **pas la
 * même solution** : là-bas, rien ne s'écrit, parce qu'aucun stockage n'existe
 * encore pour ces valeurs. Ici, le stockage existe — c'est tout l'objet de
 * cette PR — donc les champs restent actifs, réglables et persistés ; seul le
 * banner change, pour ne jamais laisser croire qu'un réglage agit alors
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
 * Le fournisseur par défaut de chaque usage — celui que `db.ts` (`AI_FIELDS`)
 * enregistre. Les trois usages partagent le même défaut, Gemini.
 */
const DEFAULT_PROVIDER: LlmProvider = 'gemini'

/**
 * Le modèle par défaut de chaque usage — celui que `db.ts` (`AI_FIELDS`,
 * `DEFAULT_MODEL.gemini`) enregistre. Une seule valeur, pas une par
 * fournisseur : le fournisseur par défaut est toujours Gemini, donc son
 * modèle par défaut est le seul qui compte pour le bouton « Revenir au
 * défaut ». **Dupliquée à dessein plutôt qu'importée** de
 * `@/server/llm/defaults` : ce fichier est un composant client, et ce module
 * vit sous `src/server/`, dont rien ne devrait traverser vers le navigateur —
 * même une simple constante, pour ne pas ouvrir un chemin d'import que Next
 * se mettrait à couper au premier module serveur qui s'y ajoute.
 */
const DEFAULT_MODEL = 'gemini-3.1-flash-lite'

/**
 * Le modèle typique de chaque fournisseur, affiché à titre indicatif à côté
 * du champ de modèle.
 *
 * **Affiché en toutes lettres, pas seulement en `placeholder`.** Un
 * `placeholder` ne s'affiche que sur un champ vide, et ce champ ne l'est
 * jamais — les trois usages partent avec un modèle par défaut non vide, et
 * `ModelField.commit()` refuse un champ vidé en revenant à la dernière
 * valeur. Le laisser en simple `placeholder` le rendait donc mort en
 * pratique : personne ne pouvait jamais le voir. (relevé en review interne)
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
  banner: { title: string; description: string } | null
}

/**
 * Le contrat le dit en toutes lettres : « ne laisse pas croire qu'un réglage
 * agit ». `correction` et `hook` s'écrivent et se persistent — contrairement
 * aux réglages inertes de `HookSection` — mais rien ne les lit encore, et
 * c'est ce que chacun de ces deux bandeaux annonce.
 *
 * **La forme reprend celle de `HookSection`** (`Alert` + `Info` + un titre et
 * une description), sans le verrou : là-bas rien ne s'écrit parce qu'aucun
 * stockage n'existe ; ici le stockage existe, donc le champ reste actif, et
 * seul le banner change de sens.
 */
const USAGES: readonly Usage[] = [
  {
    key: 'selection',
    providerField: 'selectionProvider',
    modelField: 'selectionModel',
    title: 'Repérage',
    help: 'Le modèle qui note les fenêtres du transcript et détaille les propositions de clips.',
    banner: null,
  },
  {
    key: 'correction',
    providerField: 'correctionProvider',
    modelField: 'correctionModel',
    title: 'Correction du transcript',
    help: 'Le modèle qui corrigerait les fautes de reconnaissance vocale du transcript.',
    banner: {
      title: 'Pas encore branché.',
      description:
        'Ce réglage se persiste, mais rien ne le lit : la correction du transcript n’existe pas encore.',
    },
  },
  {
    key: 'hook',
    providerField: 'hookProvider',
    modelField: 'hookModel',
    title: 'Hook',
    help: 'Le modèle qui écrirait le texte d’accroche affiché en début de clip.',
    banner: {
      title: 'Pas encore branché.',
      description:
        'Ce réglage se persiste, mais rien ne le lit : la génération automatique du hook n’existe pas encore.',
    },
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
    <section aria-labelledby="ai-title" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="ai-title" className="text-base font-semibold tracking-tight">
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
  const availabilityState = availability?.[provider]

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

      {usage.banner !== null && (
        <Alert>
          <Info aria-hidden />
          <AlertTitle>{usage.banner.title}</AlertTitle>
          <AlertDescription>{usage.banner.description}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={providerId} className="text-sm font-normal">
            Fournisseur
          </Label>
          <Select
            value={provider}
            disabled={disabled}
            onValueChange={(value) => {
              const next = value as LlmProvider
              // **Le fournisseur seul change, jamais le modèle à sa place.**
              // Un modèle valable chez l'un part en 404 chez l'autre
              // (`CLAUDE.md`) ; forcer une valeur ici écraserait une saisie
              // que la personne vient peut-être de faire exprès. L'indice
              // sous la boîte de modèle dit ce qui marche chez ce
              // fournisseur, sans se substituer au choix.
              void onChange({ [usage.providerField]: next })
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
          {/* **Même geste que `SelectionSection`** (§6.2 du retour d'usage) :
              un bouton de retour au défaut, qui ne s'affiche que s'il y a
              quelque chose à défaire. */}
          {provider !== DEFAULT_PROVIDER && (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => void onChange({ [usage.providerField]: DEFAULT_PROVIDER })}
              className="h-auto justify-start px-0 text-xs text-muted-foreground"
            >
              <RotateCcw aria-hidden />
              Revenir à {PROVIDER_LABELS[DEFAULT_PROVIDER]}
            </Button>
          )}
        </div>

        <ModelField
          id={modelId}
          label="Modèle"
          value={model}
          hint={MODEL_HINT[provider]}
          defaultValue={DEFAULT_MODEL}
          disabled={disabled}
          onCommit={(value) => onChange({ [usage.modelField]: value })}
        />
      </div>

      {availabilityState !== undefined && !availabilityState.available && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>{PROVIDER_LABELS[provider]} n’a pas de clé configurée.</AlertTitle>
          <AlertDescription>
            {availabilityState.reason ?? 'La clé de ce fournisseur est absente.'} Un repérage avec ce
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
  defaultValue,
  disabled,
  onCommit,
}: {
  id: string
  label: string
  value: string
  /** Le modèle typique du fournisseur actuellement réglé — indicatif seulement. */
  hint: string
  /** Le modèle qu'enregistre le registre pour ce champ. Cible du bouton de retour. */
  defaultValue: string
  disabled: boolean
  onCommit: (value: string) => void | Promise<unknown>
}) {
  const helpId = `${id}-help`
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }

  function commit() {
    const trimmed = draft.trim()
    if (trimmed === '') return setDraft(value)
    if (trimmed === value) return
    void Promise.resolve(onCommit(trimmed)).catch(() => setDraft(value))
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          disabled={disabled}
          aria-describedby={helpId}
          value={draft}
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
        {value !== defaultValue && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => void onCommit(defaultValue)}
            className="h-auto px-1.5 py-1 text-xs text-muted-foreground"
          >
            <RotateCcw aria-hidden />
            Revenir à {defaultValue}
          </Button>
        )}
      </div>
      {/* **En toutes lettres, pas seulement en `placeholder`** — voir la doc
          de `MODEL_HINT` : ce champ n'est jamais vide, donc un `placeholder`
          n'aurait jamais eu l'occasion de s'afficher. */}
      <p id={helpId} className="text-xs text-muted-foreground">
        Typique chez ce fournisseur : {hint}
      </p>
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
    const trimmed = draft.trim()
    if (trimmed === value) return
    void Promise.resolve(onChange({ ollamaBaseUrl: trimmed })).catch(() => setDraft(value))
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
        Laisser vide résout la passerelle WSL vers l’hôte Windows au démarrage
        de chaque repérage — l’adresse change au redémarrage, elle ne se code
        pas en dur. Ne renseigner que si Ollama tourne ailleurs, ou si cette
        résolution échoue.
      </p>
    </div>
  )
}
