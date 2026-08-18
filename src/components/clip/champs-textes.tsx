'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'

import type { Clip } from '@/core/edl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { ClipPatch } from '@/lib/api'
import { TEMPORISATION_MS } from '@/lib/enregistrement'

/**
 * Le titre et la description, **éditables**.
 *
 * Ce sont des livrables du produit au même titre que le MP4 (spec §3) : c'est ce
 * qui se colle dans le formulaire d'Instagram, et c'est la seule chose qu'on
 * puisse faire avancer quand le proxy manque encore. Ils s'affichaient en
 * lecture seule.
 *
 * **Ils ne passent pas par le store d'édition**, contrairement aux segments, au
 * ratio et au cadrage : ils vivent dans le clip du serveur, et `ChampsSuivis`
 * ne les nomme pas — les y ajouter ferait réconcilier un état qui n'existe pas.
 * Le protocole d'écriture est donc ici, en petit : temporiser, écrire au flou,
 * ne pas perdre la dernière frappe.
 */
export function ChampsTextes({
  clip,
  onEcrire,
}: {
  clip: Clip
  /**
   * Ce que l'écran fait de l'écart. La page y branche `usePatchClip`.
   *
   * **Les suites ne sont pas décoratives.** Sans elles, ce composant ne saurait
   * pas si son écriture a abouti, et il n'a aucun autre moyen de l'apprendre :
   * l'état de la barre d'application ne suit que le montage.
   */
  onEcrire: (
    patch: ClipPatch,
    suites?: { onSuccess?: () => void; onError?: () => void },
  ) => void
}) {
  const identifiant = useId()

  const titre = useTexteDifféré(
    clip.title,
    useCallback<Ecrire>((title, suites) => onEcrire({ title }, suites), [onEcrire]),
  )
  const description = useTexteDifféré(
    clip.description,
    useCallback<Ecrire>(
      (description, suites) => onEcrire({ description }, suites),
      [onEcrire],
    ),
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${identifiant}-titre`}>Titre</Label>
        <Input
          id={`${identifiant}-titre`}
          value={titre.valeur}
          onChange={(e) => titre.saisir(e.target.value)}
          onBlur={titre.vider}
          placeholder="Ce qui s’affichera au-dessus du clip"
        />
        <Echec champ="Le titre" état={titre} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${identifiant}-description`}>Description</Label>
        <Textarea
          id={`${identifiant}-description`}
          value={description.valeur}
          onChange={(e) => description.saisir(e.target.value)}
          onBlur={description.vider}
          rows={3}
          placeholder="La description et les mots-dièse, tels qu’ils seront collés"
        />
        <Echec champ="La description" état={description} />
      </div>

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
function Echec({
  champ,
  état,
}: {
  champ: string
  état: { echec: boolean; vider: () => void }
}) {
  if (!état.echec) return null
  return (
    <p className="flex items-center gap-2 text-[0.75rem] text-destructive">
      {champ} n’a pas été enregistré.
      <Button size="xs" variant="outline" onClick={état.vider}>
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
function useTexteDifféré(valeurServeur: string, écrire: Ecrire) {
  const [valeur, setValeur] = useState(valeurServeur)
  const [echec, setEchec] = useState(false)

  /** Ce que l'utilisateur a tapé en dernier. */
  const dernière = useRef(valeur)
  /** La dernière valeur que le serveur a **confirmée**, ou qu'on a adoptée de lui. */
  const référence = useRef(valeurServeur)
  /** La valeur dont l'écriture est en vol, ou `null`. */
  const envoyé = useRef<string | null>(null)
  const minuterie = useRef<ReturnType<typeof setTimeout> | null>(null)

  // `écrire` change à chaque rendu de la page — c'est une fermeture sur la
  // mutation. Le garder dans un `ref` évite de reprogrammer la temporisation à
  // chaque fois, ce qui la repousserait indéfiniment pendant qu'on tape.
  const écrireRef = useRef(écrire)
  useEffect(() => {
    écrireRef.current = écrire
  }, [écrire])

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
  const vider = useCallback(() => {
    if (minuterie.current !== null) {
      clearTimeout(minuterie.current)
      minuterie.current = null
    }
    const àÉcrire = dernière.current
    // Revenu à ce que le serveur porte : plus d'écart, donc rien à écrire. Sans
    // ce test, corriger une faute puis la remettre enverrait un patch qui ne
    // change rien.
    if (àÉcrire === référence.current) return
    // Déjà en vol sous cette forme : la relancer doublerait l'écriture.
    if (àÉcrire === envoyé.current) return

    envoyé.current = àÉcrire
    écrireRef.current(àÉcrire, {
      onSuccess: () => {
        référence.current = àÉcrire
        if (envoyé.current === àÉcrire) envoyé.current = null
        setEchec(false)
      },
      onError: () => {
        if (envoyé.current === àÉcrire) envoyé.current = null
        setEchec(true)
      },
    })
  }, [])

  const saisir = useCallback(
    (suivant: string) => {
      setValeur(suivant)
      dernière.current = suivant
      if (minuterie.current !== null) clearTimeout(minuterie.current)
      minuterie.current = setTimeout(vider, TEMPORISATION_MS)
    },
    [vider],
  )

  useEffect(() => {
    if (référence.current === valeurServeur) return
    // **Rien ne s'adopte tant qu'une écriture est en vol.** Le cache passe par
    // la valeur qu'on vient d'envoyer — l'écriture est optimiste — puis, si elle
    // échoue, par celle d'avant. Ni l'une ni l'autre ne dit ce que porte la
    // base, et avancer la référence sur la première rend la seconde
    // indiscernable d'une écriture venue d'ailleurs.
    if (envoyé.current !== null) return

    const propre = dernière.current === référence.current
    référence.current = valeurServeur
    // Une frappe non écrite est **postérieure** : personne ne l'a refusée, et
    // l'écraser serait perdre un geste au milieu d'un mot.
    if (!propre) return
    dernière.current = valeurServeur
    setValeur(valeurServeur)
  }, [valeurServeur])

  // Le démontage vide, et le `pagehide` aussi : `patchClip` part en
  // `keepalive`, donc une écriture lancée là est menée à terme après la page.
  useEffect(() => {
    const surMasquage = () => vider()
    window.addEventListener('pagehide', surMasquage)
    return () => {
      window.removeEventListener('pagehide', surMasquage)
      vider()
    }
  }, [vider])

  return { valeur, saisir, vider, echec }
}

type Ecrire = (
  valeur: string,
  suites: { onSuccess: () => void; onError: () => void },
) => void
