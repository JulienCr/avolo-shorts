'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'

import type { Clip } from '@/core/edl'
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
  /** Ce que l'écran fait de l'écart. La page y branche `usePatchClip`. */
  onEcrire: (patch: ClipPatch) => void
}) {
  const identifiant = useId()

  const titre = useTexteDifféré(
    clip.title,
    useCallback((title: string) => onEcrire({ title }), [onEcrire]),
  )
  const description = useTexteDifféré(
    clip.description,
    useCallback((description: string) => onEcrire({ description }), [onEcrire]),
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
      </div>

      {/* Rien ne se valide pendant la frappe : les deux textes sont libres. La
          seule règle se dit au moment de l'export — un titre vide n'empêche pas
          le rendu, il produit un `.txt` dont la première ligne est vide. */}
    </div>
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
function useTexteDifféré(valeurServeur: string, écrire: (valeur: string) => void) {
  const [valeur, setValeur] = useState(valeurServeur)

  // Ce qui n'a pas encore été écrit. Un `ref` et non un état : le vidage se fait
  // depuis un `setTimeout` et depuis un nettoyage d'effet, deux endroits qui
  // liraient sinon une valeur capturée au rendu d'avant.
  const enAttente = useRef(false)
  const dernière = useRef(valeur)
  const référence = useRef(valeurServeur)
  const minuterie = useRef<ReturnType<typeof setTimeout> | null>(null)

  // `écrire` change à chaque rendu de la page — c'est une fermeture sur la
  // mutation. Le garder dans un `ref` évite de reprogrammer la temporisation à
  // chaque fois, ce qui la repousserait indéfiniment pendant qu'on tape.
  const écrireRef = useRef(écrire)
  useEffect(() => {
    écrireRef.current = écrire
  }, [écrire])

  const vider = useCallback(() => {
    if (minuterie.current !== null) {
      clearTimeout(minuterie.current)
      minuterie.current = null
    }
    if (!enAttente.current) return
    enAttente.current = false
    référence.current = dernière.current
    écrireRef.current(dernière.current)
  }, [])

  const saisir = useCallback(
    (suivant: string) => {
      setValeur(suivant)
      dernière.current = suivant
      // Revenu à ce que le serveur porte : il n'y a plus d'écart, donc plus rien
      // à écrire. Sans ce test, corriger une faute puis la remettre enverrait un
      // patch qui ne change rien.
      enAttente.current = suivant !== référence.current
      if (minuterie.current !== null) clearTimeout(minuterie.current)
      minuterie.current = setTimeout(vider, TEMPORISATION_MS)
    },
    [vider],
  )

  useEffect(() => {
    if (référence.current === valeurServeur) return
    référence.current = valeurServeur
    if (enAttente.current) return
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

  return { valeur, saisir, vider }
}
