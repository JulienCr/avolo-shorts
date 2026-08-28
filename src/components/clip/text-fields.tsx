'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'

import type { Clip } from '@/core/edl'
import { wordsHash } from '@/components/clip/texts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { ClipPatch } from '@/lib/api'
import { DEBOUNCE_MS } from '@/lib/autosave'

/**
 * Le titre et la description, **éditables**.
 *
 * Ce sont des livrables du produit au même titre que le MP4 (spec §3) : c'est ce
 * qui se colle dans le formulaire d'Instagram, et c'est la seule chose qu'on
 * puisse faire avancer quand le proxy manque encore. Ils s'affichaient en
 * lecture seule.
 *
 * **Ils ne passent pas par le store d'édition**, contrairement aux segments, au
 * ratio et au cadrage : ils vivent dans le clip du serveur, et `FieldsTracked`
 * ne les nomme pas — les y ajouter ferait réconcilier un état qui n'existe pas.
 * Le protocole d'écriture est donc ici, en petit : temporiser, écrire au flou,
 * ne pas perdre la dernière frappe.
 */
export function FieldsTexts({
  clip,
  onWrite,
  onFailure,
}: {
  clip: Clip
  /**
   * Ce que l'écran fait de l'écart. La page y branche `usePatchClip`.
   *
   * **Les suites ne sont pas décoratives.** Sans elles, ce composant ne saurait
   * pas si son écriture a abouti, et il n'a aucun autre moyen de l'apprendre :
   * l'état de la barre d'application ne suit que le montage.
   */
  onWrite: (patch: ClipPatch) => Promise<unknown> | void
  /**
   * Ce champ-là a-t-il une écriture restée en échec ?
   *
   * **L'export en a besoin, et il ne peut pas le déduire.** `patch.isError` ne
   * décrit que le dernier appel de l'observateur partagé : une écriture de
   * marques qui aboutit le remet à faux alors que le titre, lui, n'est toujours
   * pas écrit — et le rendu produirait un `.txt` portant le texte d'avant
   * pendant que l'écran affiche le nouveau. (relevé par Codex et par Copilot)
   */
  onFailure?: (field: 'title' | 'description', inFailure: boolean) => void
}) {
  const identifier = useId()

  const title = useTextDeferred(
    clip.title,
    useCallback<Write>((title) => onWrite({ title }), [onWrite]),
    useCallback((inFailure: boolean) => onFailure?.('title', inFailure), [onFailure]),
  )
  const description = useTextDeferred(
    clip.description,
    useCallback<Write>((description) => onWrite({ description }), [onWrite]),
    useCallback((inFailure: boolean) => onFailure?.('description', inFailure), [onFailure]),
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${identifier}-titre`}>Titre</Label>
        <Input
          id={`${identifier}-titre`}
          value={title.value}
          onChange={(e) => title.input(e.target.value)}
          onBlur={title.clear}
          placeholder="Ce qui s’affichera au-dessus du clip"
        />
        <Failure field="Le titre" state={title} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${identifier}-description`}>Description</Label>
        <Textarea
          id={`${identifier}-description`}
          value={description.value}
          onChange={(e) => description.input(e.target.value)}
          onBlur={description.clear}
          rows={3}
          placeholder="La description et les mots-dièse, tels qu’ils seront collés"
        />
        <Failure field="La description" state={description} />
      </div>

      <label className="flex items-start gap-2 text-[0.75rem]">
        <input
          type="checkbox"
          className="mt-0.5 size-3.5 accent-stage"
          checked={clip.footer}
          onChange={(e) =>
            void Promise.resolve(onWrite({ footer: e.target.checked })).catch(() => {})
          }
        />
        <span>
          Pied de page
          <span className="block text-muted-foreground">
            Ajoute le pied de page commun (réglages → Publication) à la description envoyée.
          </span>
        </span>
      </label>

      {/* **Extraits, pas saisis** : `wordsHash` les lit dans le titre et la
          description, ils ne s'écrivent nulle part d'autre. Montrés ici, sous
          le champ qui les porte, plutôt qu'au moment de les copier (retour
          d'usage §3.2) — on les voit apparaître en tapant, au lieu de les
          découvrir dans le panneau de livraison trois champs plus loin. */}
      <p className="text-[0.75rem] text-muted-foreground">
        Mots-dièse :{' '}
        <span className="font-mono">
          {wordsHash(`${title.value}\n${description.value}`).join(' ') || '—'}
        </span>
      </p>

      {/* Rien ne se valide pendant la frappe : les deux textes sont libres. La
          seule règle se dit au moment de l'export — un titre vide n'empêche pas
          le rendu, il produit un `.txt` dont la première ligne est vide. */}
    </div>
  )
}

/**
 * L'échec d'une écriture de texte, et son geste de reprise.
 *
 * Il vit ici et non dans la barre d'application : celle-ci porte l'état du
 * montage, qui ne sait rien de ces deux champs-là. Un échec muet ferait fermer
 * l'onglet en croyant le titre enregistré.
 */
function Failure({
  field,
  state,
}: {
  field: string
  state: { failure: boolean; clear: () => void }
}) {
  if (!state.failure) return null
  return (
    <p className="flex items-center gap-2 text-[0.75rem] text-destructive">
      {field} n’a pas été enregistré.
      <Button size="xs" variant="outline" onClick={state.clear}>
        Réessayer
      </Button>
    </p>
  )
}

/**
 * Un champ de texte dont l'écriture est différée.
 *
 * Trois règles, et chacune ferme une façon de perdre quelque chose.
 *
 * **La temporisation.** Une frappe n'est pas une écriture : quarante requêtes
 * pour un titre sont quarante occasions de se croiser, sur un serveur qui
 * ordonne champ par champ.
 *
 * **Le vidage.** Au flou, et au démontage. On quitte l'écran de clip bien plus
 * souvent qu'on ne ferme l'onglet — « clip suivant à monter » est une des deux
 * issues du sous-parcours —, et la dernière frappe ne doit pas rester dans une
 * temporisation qui n'arrivera jamais.
 *
 * **L'adoption.** La valeur du serveur remplace la valeur locale **tant que rien
 * n'est en attente**. Une écriture venue d'ailleurs revient ainsi à l'écran sans
 * rechargement ; une frappe en cours, elle, est postérieure — personne ne l'a
 * refusée, et l'écraser serait perdre un geste au milieu d'un mot.
 */
/**
 * **Exporté pour `hook-fields.tsx`.** Le hook du clip suit exactement le même
 * protocole d'écriture que le titre et la description — brouillon local,
 * temporisation, vidage au démontage et sur `pagehide`, référence qui n'avance
 * qu'au succès — et le réécrire y ouvrirait une seconde version du même
 * protocole, vouée à diverger de celle-ci.
 */
export function useTextDeferred(
  valueServer: string,
  write: Write,
  flag?: (inFailure: boolean) => void,
) {
  const [value, setValue] = useState(valueServer)
  const [failure, setFailure] = useState(false)

  /** Ce que l'utilisateur a tapé en dernier. */
  const last = useRef(value)
  /** La dernière valeur que le serveur a **confirmée**, ou qu'on a adoptée de lui. */
  const reference = useRef(valueServer)
  /** La valeur dont l'écriture est en vol, ou `null`. */
  const sent = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // `écrire` change à chaque rendu de la page — c'est une fermeture sur la
  // mutation. Le garder dans un `ref` évite de reprogrammer la temporisation à
  // chaque fois, ce qui la repousserait indéfiniment pendant qu'on tape.
  const writeRef = useRef(write)
  const flagRef = useRef(flag)
  useEffect(() => {
    writeRef.current = write
    flagRef.current = flag
  }, [write, flag])

  /**
   * Envoie ce qui reste à écrire, et **n'avance la référence qu'au succès**.
   *
   * C'était le défaut : la référence avançait au départ de la requête. Un
   * `PATCH` en échec fait remettre l'ancienne version en cache par
   * `usePatchClip` — c'est son rollback, et il est correct — l'adoption ne
   * voyait alors plus rien de local en attente, et remplaçait le texte tapé par
   * celui d'avant. **Perdu en silence**, la barre affichant « enregistré »
   * puisqu'elle ne suit que le montage. (relevé par Codex)
   */
  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const toWrite = last.current
    // Revenu à ce que le serveur porte : plus d'écart, donc rien à écrire. Sans
    // ce test, corriger une faute puis la remettre enverrait un patch qui ne
    // change rien.
    if (toWrite === reference.current) return
    // Déjà en vol sous cette forme : la relancer doublerait l'écriture.
    if (toWrite === sent.current) return

    sent.current = toWrite
    // `Promise.resolve` enveloppe aussi bien une écriture qui ne rend rien :
    // le contrat reste « la promesse se règle », pas « l'appelant en rend une ».
    Promise.resolve(writeRef.current(toWrite)).then(
      () => {
        reference.current = toWrite
        if (sent.current === toWrite) sent.current = null
        setFailure(false)
        // Depuis le règlement de la promesse, donc depuis un événement : jamais
        // depuis un effet, qui ferait écrire l'état d'un parent pendant un rendu.
        flagRef.current?.(false)
      },
      () => {
        if (sent.current === toWrite) sent.current = null
        setFailure(true)
        flagRef.current?.(true)
      },
    )
  }, [])

  const input = useCallback(
    (next: string) => {
      setValue(next)
      last.current = next
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(clear, DEBOUNCE_MS)
    },
    [clear],
  )

  useEffect(() => {
    if (reference.current === valueServer) return
    // **Rien ne s'adopte tant qu'une écriture est en vol.** Le cache passe par
    // la valeur qu'on vient d'envoyer — l'écriture est optimiste — puis, si elle
    // échoue, par celle d'avant. Ni l'une ni l'autre ne dit ce que porte la
    // base, et avancer la référence sur la première rend la seconde
    // indiscernable d'une écriture venue d'ailleurs.
    if (sent.current !== null) return

    const clean = last.current === reference.current
    reference.current = valueServer
    // Une frappe non écrite est **postérieure** : personne ne l'a refusée, et
    // l'écraser serait perdre un geste au milieu d'un mot.
    if (!clean) return
    last.current = valueServer
    setValue(valueServer)
  }, [valueServer])

  // Le démontage vide, et le `pagehide` aussi : `patchClip` part en
  // `keepalive`, donc une écriture lancée là est menée à terme après la page.
  useEffect(() => {
    const onMasking = () => clear()
    window.addEventListener('pagehide', onMasking)
    return () => {
      window.removeEventListener('pagehide', onMasking)
      clear()
    }
  }, [clear])

  return { value, input, clear, failure }
}

/**
 * Écrire une valeur, et **rendre une promesse qui se règle pour cette
 * écriture-là**.
 *
 * Les rappels passés à `mutate` sont attachés à la *dernière* mutation de
 * l'observateur : une écriture de marques partie entre-temps efface ceux du
 * titre, dont l'écriture ne se règle alors jamais. Le champ reste « en vol » à
 * jamais, refuse toute écriture suivante, et n'affiche aucun échec. La promesse,
 * elle, appartient à la mutation et non à l'observateur. (relevé par Copilot)
 */
export type Write = (value: string) => Promise<unknown> | void
