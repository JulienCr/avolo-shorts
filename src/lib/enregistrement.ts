'use client'

/**
 * Le protocole d'écriture différée de l'écran de clip.
 *
 * Il a vécu 130 lignes durant dans `src/app/clips/[id]/page.tsx`. C'est le code
 * le plus subtil de l'interface — trois défauts y ont été trouvés en revue — et
 * c'était le seul à ne pas être testable sans monter une page. Il en sort donc,
 * et les trois défauts deviennent des tests plutôt que des commentaires.
 *
 * Ce qu'il tient : comparer l'état local au clip du serveur, n'envoyer que
 * l'écart, attendre que le geste se pose, ne pas perdre la dernière
 * modification quand on quitte, ne pas boucler sur un échec, et **se remettre
 * d'accord avec le serveur quand celui-ci refuse une écriture pour jeton
 * périmé**.
 */

import type { Clip, Ratio, Segment } from '@/core/edl'
import type { ClipPatch, PatchClipResult } from '@/lib/api'
import { useEffect, useRef, useState } from 'react'

/** L'état affiché dans la barre : trois valeurs, dont l'échec. */
export type EtatEnregistrement = 'enregistre' | 'en-attente' | 'echec'

/**
 * Les trois champs que le store porte et que cet enregistrement suit.
 *
 * Le titre et la description s'éditent aussi, mais ils vivent dans le clip du
 * serveur et non dans le store : les nommer ici ferait réconcilier un état qui
 * n'existe pas.
 */
export type ChampsSuivis = { segments: Segment[]; ratio: Ratio | 'auto'; cropX: number }

/** Le temps qu'on laisse au geste pour se poser avant d'écrire. */
export const TEMPORISATION_MS = 600

/** Deux listes de segments décrivent-elles le même montage ? */
function mêmesSegments(a: Segment[], b: Segment[]): boolean {
  return a.length === b.length && a.every((s, i) => s.start === b[i].start && s.end === b[i].end)
}

/** Ce qui a changé depuis la version connue du serveur, ou `null` si rien. */
export function differences(
  reference: Clip,
  segments: Segment[],
  ratio: Ratio | 'auto',
  cropX: number,
): ClipPatch | null {
  const segmentsIdentiques = mêmesSegments(segments, reference.segments)
  if (segmentsIdentiques && ratio === reference.ratio && cropX === reference.cropX) return null

  // Champ par champ, et pas le clip entier : le serveur ordonne les écritures
  // champ par champ, et réenvoyer un champ inchangé le ferait écarter en son
  // nom — ou, pire, écraser un geste plus récent porté sur lui.
  return {
    ...(segmentsIdentiques ? {} : { segments }),
    ...(ratio === reference.ratio ? {} : { ratio }),
    ...(cropX === reference.cropX ? {} : { cropX }),
  }
}

/**
 * Ce qu'il faut adopter du serveur après un `PATCH` refusé, ou `null` s'il n'y a
 * rien à faire.
 *
 * **`applied: false` est un cas nominal** : « une écriture plus récente a
 * gagné », pas « la sauvegarde a échoué ». Le cache de TanStack Query fait déjà
 * le bon geste et adopte le clip rendu. Mais le montage, lui, vit dans un store
 * séparé, et l'enregistrement différé compare *ce store* au clip du serveur :
 * sans rien faire de plus, il voit à nouveau un écart, renvoie l'intention
 * qu'on vient de refuser — **avec un jeton neuf, donc gagnant** — et la
 * garantie d'ordre qu'on a payée ne sert plus à rien. Aucune donnée perdue ; la
 * garantie annulée.
 *
 * **Pourquoi cette réconciliation-là, et pas une relecture.** Trois formes
 * étaient possibles et deux sont fausses.
 *
 * 1. *Relire le clip.* C'est ce qu'une version de la conception proposait, et
 *    elle est sans effet : `useEditeur.charger` sort immédiatement quand
 *    l'identifiant n'a pas changé, et cette garde est bonne — elle empêche un
 *    refetch d'écraser le montage en cours et sa pile d'annulation. Le cache
 *    serait rafraîchi, le store resterait sur l'intention refusée.
 * 2. *Recharger de force en contournant la garde.* Cela jette le montage en
 *    cours **et** la pile d'annulation, pour un refus qui, dans le mode
 *    d'emploi prévu — un utilisateur, une machine, un onglet —, n'est pas une
 *    anomalie mais le croisement de deux de vos propres écritures.
 * 3. *Adopter, champ par champ, la valeur du gagnant — et seulement sur les
 *    champs qui portent encore l'intention refusée.* C'est celle-ci.
 *
 * Le « seulement » est ce qui la rend sûre. Entre l'envoi et la réponse il
 * s'écoule un aller-retour réseau, pendant lequel l'utilisateur continue de
 * monter. Un champ qui a bougé depuis porte une intention **postérieure** au
 * refus : personne ne l'a refusée, et l'écraser serait perdre un geste. Un
 * champ resté sur la valeur refusée, lui, n'a plus aucune chance d'être écrit —
 * l'adopter est exactement ce que « la version du serveur fait foi » veut dire.
 *
 * Rien n'est empilé dans l'historique : ce n'est pas un geste de l'utilisateur,
 * et un `Ctrl+Z` qui défait une réconciliation remettrait l'intention refusée.
 */
export function reconciliation(
  refuse: ClipPatch,
  gagnant: Clip,
  local: ChampsSuivis,
): Partial<ChampsSuivis> | null {
  const àAdopter: Partial<ChampsSuivis> = {}

  if (
    refuse.segments !== undefined &&
    mêmesSegments(local.segments, refuse.segments) &&
    !mêmesSegments(local.segments, gagnant.segments)
  ) {
    àAdopter.segments = gagnant.segments
  }
  if (refuse.ratio !== undefined && local.ratio === refuse.ratio && local.ratio !== gagnant.ratio) {
    àAdopter.ratio = gagnant.ratio
  }
  if (refuse.cropX !== undefined && local.cropX === refuse.cropX && local.cropX !== gagnant.cropX) {
    àAdopter.cropX = gagnant.cropX
  }

  return Object.keys(àAdopter).length === 0 ? null : àAdopter
}

/** Ce que `usePatchClip` attend comme variables, réduit à ce qu'on lui donne ici. */
type Variables = { clipId: string; projectId: string; patch: ClipPatch }

/** `mutate` de TanStack Query, référentiellement stable — donc utilisable en dépendance. */
type Ecrire = (
  variables: Variables,
  options?: { onSuccess?: (resultat: PatchClipResult) => void; onError?: () => void },
) => void

/**
 * L'enregistrement, en différé.
 *
 * Un `PATCH` par mot cliqué ferait une écriture toutes les deux secondes pendant
 * un montage. On attend donc que le geste se pose, et on n'envoie que ce qui a
 * réellement changé par rapport à la version connue du serveur — sans quoi la
 * réponse de l'écriture, qui met à jour cette version, relancerait une écriture.
 *
 * **Trois défauts trouvés en review vivent ici, et ils tiennent tous à la même
 * cause : un différé est une promesse d'écrire plus tard, et rien ne garantit
 * qu'il y ait un plus tard.**
 *
 * - *Quitter dans les 600 ms perdait la modification.* Le nettoyage de l'effet
 *   annulait le seul `PATCH` programmé, et l'écran affichait « enregistré ». Le
 *   dernier état en attente est donc gardé dans une ref et **vidé au
 *   démontage** — au démontage seulement, pas à chaque changement de
 *   dépendance, sinon on écrirait à chaque frappe.
 * - *Un échec bouclait sans fin.* Le rollback remet l'ancienne version en
 *   cache, la comparaison redevient donc inégale, et le même `PATCH` repartait
 *   600 ms plus tard, indéfiniment. On retient la signature de la tentative
 *   ratée et on ne la rejoue pas telle quelle : il faut un nouveau geste.
 * - *« Enregistré » mentait.* `isPending` n'est vrai qu'une fois le minuteur
 *   écoulé, donc la barre affirmait « enregistré » pendant l'attente et après
 *   un échec. D'où cet état à trois valeurs.
 */
export function useEnregistrementAuto({
  pret,
  reference,
  segments,
  ratio,
  cropX,
  ecrire,
  reconcilier,
}: {
  /** Faux tant que le store n'a pas chargé ce clip : il n'y a alors rien de vrai à comparer. */
  pret: boolean
  /** Le clip tel que le serveur le connaît : la référence de comparaison. */
  reference: Clip
  segments: Segment[]
  ratio: Ratio | 'auto'
  cropX: number
  ecrire: Ecrire
  /**
   * Remet le montage local d'accord avec le serveur après un refus de jeton.
   * Voir `reconciliation` pour la forme retenue et pourquoi c'est celle-là.
   */
  reconcilier: (clipId: string, valeurs: Partial<ChampsSuivis>) => void
}): EtatEnregistrement {
  // L'état visible se **déduit**, il ne se stocke pas : « il reste quelque chose
  // à écrire » est exactement « la comparaison n'est pas vide ». Seul l'échec
  // est un fait extérieur, donc lui seul est un état, et il n'est posé que
  // depuis une réponse — jamais dans le corps d'un effet.
  const modif = pret ? differences(reference, segments, ratio, cropX) : null
  const signature = modif ? JSON.stringify(modif) : null
  const [echec, setEchec] = useState<string | null>(null)
  const bloque = signature !== null && echec === signature

  /** Ce qui est promis mais pas encore parti. Vidé au départ de la page. */
  const enAttente = useRef<Variables | null>(null)
  const ecrireRef = useRef(ecrire)
  const reconcilierRef = useRef(reconcilier)

  /**
   * L'état local **au moment où la réponse arrive**, et non celui du rendu qui a
   * lancé l'écriture. C'est toute la différence entre « ce champ porte encore
   * l'intention refusée » et « l'utilisateur a monté autre chose depuis », et la
   * réconciliation ne tient qu'à cette distinction.
   */
  const actuel = useRef<ChampsSuivis>({ segments, ratio, cropX })

  useEffect(() => {
    ecrireRef.current = ecrire
    reconcilierRef.current = reconcilier
  }, [ecrire, reconcilier])

  useEffect(() => {
    actuel.current = { segments, ratio, cropX }
  }, [segments, ratio, cropX])

  useEffect(() => {
    if (signature === null || bloque) {
      enAttente.current = null
      return
    }

    const variables: Variables = {
      clipId: reference.id,
      projectId: reference.projectId,
      patch: differences(reference, segments, ratio, cropX) ?? {},
    }
    enAttente.current = variables

    const minuteur = setTimeout(() => {
      enAttente.current = null
      ecrireRef.current(variables, {
        onSuccess: (resultat) => {
          setEchec(null)
          // **Le refus n'est pas un échec, mais il n'est pas rien non plus.**
          if (resultat.applied) return
          const àAdopter = reconciliation(variables.patch, resultat.clip, actuel.current)
          if (àAdopter) reconcilierRef.current(resultat.clip.id, àAdopter)
        },
        onError: () => setEchec(signature),
      })
    }, TEMPORISATION_MS)

    return () => clearTimeout(minuteur)
  }, [signature, bloque, reference, segments, ratio, cropX])

  // Le départ : démontage du composant **et** fermeture de l'onglet.
  //
  // Les deux, parce qu'aucun des deux ne couvre l'autre. React n'exécute pas
  // toujours son nettoyage quand la page se ferme ; et `pagehide` ne se
  // déclenche pas quand on passe simplement d'un clip à l'autre. Le drapeau
  // `enAttente` est remis à `null` par celui qui vide en premier, donc le second
  // ne double pas l'écriture.
  //
  // **Ce vidage-là n'attend pas de réponse**, et c'est volontaire : il part au
  // moment où la page s'en va. Un refus qui reviendrait après n'aurait plus de
  // montage local à réconcilier, et `reconcilier` refuserait de toute façon de
  // toucher un autre clip que celui qu'il porte.
  //
  // Dépendances vides, rien d'autre que des refs à l'intérieur : une dépendance
  // ici rejouerait le vidage à chaque rendu, ce qui annulerait la temporisation.
  useEffect(() => {
    const vider = () => {
      const variables = enAttente.current
      enAttente.current = null
      if (variables) ecrireRef.current(variables)
    }
    window.addEventListener('pagehide', vider)
    return () => {
      window.removeEventListener('pagehide', vider)
      vider()
    }
  }, [])

  if (bloque) return 'echec'
  return signature === null ? 'enregistre' : 'en-attente'
}
