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

import { useEffect, useRef, useState } from 'react'

import type { Clip, Ratio, Segment } from '@/core/edl'
import type { ClipPatch, PatchClipResult } from '@/lib/api'

/** L'état affiché dans la barre : trois valeurs, dont l'échec. */
export type AutosaveState = 'saved' | 'pending' | 'failed'

/**
 * Les trois champs que le store porte et que cet enregistrement suit.
 *
 * Le titre et la description s'éditent aussi, mais ils vivent dans le clip du
 * serveur et non dans le store : les nommer ici ferait réconcilier un état qui
 * n'existe pas.
 */
export type FieldsTracked = { segments: Segment[]; ratio: Ratio | 'auto'; cropX: number }

/** Le temps qu'on laisse au geste pour se poser avant d'écrire. */
export const DEBOUNCE_MS = 600

/** Deux listes de segments décrivent-elles le même montage ? */
function sameSegments(a: Segment[], b: Segment[]): boolean {
  return a.length === b.length && a.every((s, i) => s.start === b[i].start && s.end === b[i].end)
}

/** Ce qui a changé depuis la version connue du serveur, ou `null` si rien. */
export function differences(
  reference: Clip,
  segments: Segment[],
  ratio: Ratio | 'auto',
  cropX: number,
): ClipPatch | null {
  const segmentsIdentical = sameSegments(segments, reference.segments)
  if (segmentsIdentical && ratio === reference.ratio && cropX === reference.cropX) return null

  // Champ par champ, et pas le clip entier : le serveur ordonne les écritures
  // champ par champ, et réenvoyer un champ inchangé le ferait écarter en son
  // nom — ou, pire, écraser un geste plus récent porté sur lui.
  return {
    ...(segmentsIdentical ? {} : { segments }),
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
 *    elle est sans effet : `useEditor.charger` sort immédiatement quand
 *    l'identifiant n'a pas changé, et cette garde est bonne — elle empêche un
 *    refetch d'écraser le montage en cours et sa pile d'annulation. Le cache
 *    serait rafraîchi, le store resterait sur l'intention refusée.
 * 2. *Recharger de force en contournant la garde.* Cela jette le montage en
 *    cours **et** la pile d'annulation, pour un refus qui, dans le mode
 *    d'emploi prévu — un utilisateur, une machine, un onglet —, n'est pas une
 *    anomalie mais le croisement de deux de vos propres écritures.
 * 3. *Adopter, champ par champ, la valeur du gagnant — et seulement sur les
 *    champs qui portent encore l'intention refusée et sur lesquels quelqu'un a
 *    réellement écrit.* C'est celle-ci.
 *
 * **Deux conditions, et chacune ferme une façon de perdre un geste.**
 *
 * *Le champ porte encore l'intention refusée.* Entre l'envoi et la réponse il
 * s'écoule un aller-retour réseau, pendant lequel l'utilisateur continue de
 * monter. Un champ qui a bougé depuis porte une intention **postérieure** au
 * refus : personne ne l'a refusée, et l'écraser serait perdre un geste.
 *
 * *Le gagnant en dit autre chose que la référence.* Un refus ne veut pas
 * toujours dire qu'une écriture concurrente a gagné : les jetons viennent de
 * l'horloge du navigateur, et une horloge remise en arrière produit des numéros
 * inférieurs à ce que la base a déjà appliqué — le serveur refuse alors une
 * modification parfaitement fraîche, et rend la valeur d'avant, c'est-à-dire
 * celle qu'on avait déjà en référence. `usePatchClip` se recale sur le plancher
 * annoncé et la tentative suivante passe : adopter ici tuerait ce
 * rétablissement, puisque la comparaison retomberait à zéro et que rien ne
 * repartirait. Comparer au **clip contre lequel on a calculé l'écart** distingue
 * les deux cas sans rien demander de plus au serveur.
 *
 * S'y ajoute un filtre sans mystère : un champ dont le gagnant porte déjà la
 * valeur locale n'a rien à adopter. C'est le cas d'un patch partiellement
 * appliqué — `applied` est faux à cause d'un *autre* champ — et écrire dans le
 * store n'y apprendrait rien.
 *
 * Rien n'est empilé dans l'historique : ce n'est pas un geste de l'utilisateur,
 * et un `Ctrl+Z` qui défait une réconciliation remettrait l'intention refusée.
 */
export function reconciliation(
  rejected: ClipPatch,
  winner: Clip,
  local: FieldsTracked,
  reference: Clip,
): Partial<FieldsTracked> | null {
  const toAdopt: Partial<FieldsTracked> = {}

  if (
    rejected.segments !== undefined &&
    sameSegments(local.segments, rejected.segments) &&
    !sameSegments(winner.segments, reference.segments) &&
    !sameSegments(winner.segments, local.segments)
  ) {
    toAdopt.segments = winner.segments
  }
  if (
    rejected.ratio !== undefined &&
    local.ratio === rejected.ratio &&
    winner.ratio !== reference.ratio &&
    winner.ratio !== local.ratio
  ) {
    toAdopt.ratio = winner.ratio
  }
  if (
    rejected.cropX !== undefined &&
    local.cropX === rejected.cropX &&
    winner.cropX !== reference.cropX &&
    winner.cropX !== local.cropX
  ) {
    toAdopt.cropX = winner.cropX
  }

  return Object.keys(toAdopt).length === 0 ? null : toAdopt
}

/** Ce que `usePatchClip` attend comme variables, réduit à ce qu'on lui donne ici. */
type Variables = { clipId: string; projectId: string; patch: ClipPatch }

/**
 * `mutateAsync` de TanStack Query, référentiellement stable — donc utilisable en
 * dépendance.
 *
 * **Une promesse, et surtout pas des rappels.** Les rappels passés à `mutate`
 * sont attachés à la **dernière** mutation de l'observateur, que l'écran de clip
 * partage entre cet enregistrement différé et les écritures directes de titre,
 * de description et de marques. Une écriture de champ partie entre le départ du
 * montage et sa réponse emportait donc le sort de celui-ci — sans exception,
 * sans trace, et avec elle la réconciliation d'un `PATCH` refusé pour jeton
 * périmé, c'est-à-dire la garantie d'ordre que tout ce fichier existe pour
 * tenir. `ecran-clip.tsx` porte le même raisonnement sur les écritures
 * directes, où le défaut avait été trouvé en premier. (issue #55)
 */
type Write = (variables: Variables) => Promise<PatchClipResult>

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
export function useAutosave({
  ready,
  reference,
  segments,
  ratio,
  cropX,
  write,
  reconcile,
}: {
  /** Faux tant que le store n'a pas chargé ce clip : il n'y a alors rien de vrai à comparer. */
  ready: boolean
  /** Le clip tel que le serveur le connaît : la référence de comparaison. */
  reference: Clip
  segments: Segment[]
  ratio: Ratio | 'auto'
  cropX: number
  write: Write
  /**
   * Remet le montage local d'accord avec le serveur après un refus de jeton.
   * Voir `reconciliation` pour la forme retenue et pourquoi c'est celle-là.
   */
  reconcile: (clipId: string, values: Partial<FieldsTracked>) => void
}): AutosaveState {
  // L'état visible se **déduit**, il ne se stocke pas : « il reste quelque chose
  // à écrire » est exactement « la comparaison n'est pas vide ». Seul l'échec
  // est un fait extérieur, donc lui seul est un état, et il n'est posé que
  // depuis une réponse — jamais dans le corps d'un effet.
  const change = ready ? differences(reference, segments, ratio, cropX) : null
  const signature = change ? JSON.stringify(change) : null
  const [failure, setFailure] = useState<string | null>(null)
  const blocked = signature !== null && failure === signature

  /** Ce qui est promis mais pas encore parti. Vidé au départ de la page. */
  const inWait = useRef<Variables | null>(null)

  /**
   * Le rang de la dernière écriture **partie**, et le prix de `mutateAsync`.
   *
   * Deux enregistrements du montage se chevauchent dès qu'un aller-retour dure
   * plus que les 600 ms de temporisation : un geste de plus fait repartir une
   * écriture pendant que la précédente vole encore. Tant que les rappels
   * vivaient sur l'observateur, la mutation dépassée en était détachée et sa
   * réponse ne disait plus rien — c'était le défaut, mais c'était aussi, par
   * accident, un ordre. Depuis que chaque promesse tient son propre sort, la
   * réponse dépassée parle, et rien ne garantit qu'elle parle en premier.
   *
   * Deux façons de s'y tromper, symétriques et toutes deux silencieuses : le
   * succès tardif d'une écriture dépassée effacerait l'échec de la plus récente
   * — qui repartirait alors toute seule, garde-fou anti-boucle contourné par le
   * chemin même qu'il surveille —, et l'échec tardif d'une écriture dépassée
   * retiendrait une signature que le serveur n'a jamais refusée, minant la
   * valeur correspondante jusqu'au prochain chargement.
   *
   * Une réponse dépassée ne décide donc plus de rien — ni de `failure`, ni de la
   * réconciliation. Cette seconde moitié n'allait pas de soi, et les deux
   * relecteurs ont d'abord conclu l'inverse : la réconciliation semble
   * s'autoprotéger, puisqu'elle n'adopte que sur un champ qui *porte encore*
   * l'intention refusée. Mais « porte encore la même valeur » n'est pas « n'a
   * pas bougé » : l'utilisateur qui ramène le cadrage là où il était pendant que
   * la réponse dépassée voyage repasse cette condition avec un geste qui, lui,
   * est le plus récent de tous — et se le fait écraser par un gagnant que la
   * tentative suivante a déjà réglé. Rien n'est perdu à s'en abstenir : c'est
   * précisément parce qu'une tentative plus récente est partie que celle-ci est
   * dépassée, et c'est la réponse de celle-là qui dit l'état du serveur.
   *
   * **Le compteur appartient à une instance du hook, et la promesse lui
   * survit.** Rouvrir le même clip donne donc un compteur neuf, incapable de
   * dépasser une écriture partie sous l'écran précédent — laquelle se croirait
   * encore la dernière et écrirait dans un montage qui n'est plus le sien : la
   * garde du store ne compare que l'identifiant du clip, et c'est le même. Le
   * démontage incrémente donc le compteur une dernière fois, ce qui périme d'un
   * coup tout ce qui est encore en vol.
   * (relevé par Copilot puis, pour la réconciliation et le démontage, par Codex)
   */
  const lastAttempt = useRef(0)
  const writeRef = useRef(write)
  const reconcileRef = useRef(reconcile)

  /**
   * L'état local **au moment où la réponse arrive**, et non celui du rendu qui a
   * lancé l'écriture. C'est toute la différence entre « ce champ porte encore
   * l'intention refusée » et « l'utilisateur a monté autre chose depuis », et la
   * réconciliation ne tient qu'à cette distinction.
   */
  const current = useRef<FieldsTracked>({ segments, ratio, cropX })

  useEffect(() => {
    writeRef.current = write
    reconcileRef.current = reconcile
  }, [write, reconcile])

  useEffect(() => {
    current.current = { segments, ratio, cropX }
  }, [segments, ratio, cropX])

  useEffect(() => {
    if (signature === null || blocked) {
      inWait.current = null
      return
    }

    const variables: Variables = {
      clipId: reference.id,
      projectId: reference.projectId,
      patch: differences(reference, segments, ratio, cropX) ?? {},
    }
    inWait.current = variables

    const timer = setTimeout(() => {
      // `clear()` n'a pas la main sur ce minuteur et ne peut pas l'annuler ;
      // un retour de bfcache le réveille quand même. Ce garde vérifie que
      // l'écriture qu'il porte est toujours celle en attente.
      if (inWait.current !== variables) return
      inWait.current = null
      const attempt = ++lastAttempt.current
      const isLast = () => attempt === lastAttempt.current
      // Un `then` à deux arguments, et non un `catch` en aval : celui-ci
      // rattraperait aussi ce que lève la branche de succès — une réconciliation
      // en défaut deviendrait un « échec réseau » affiché à l'utilisateur, avec
      // le blocage qui va avec.
      writeRef.current(variables).then(
        (result) => {
          if (!isLast()) return
          setFailure(null)
          // **Le refus n'est pas un échec, mais il n'est pas rien non plus.**
          if (result.applied) return
          // `reference` est bien le clip contre lequel cet écart-là a été
          // calculé : l'effet le capture avec les variables qu'il programme.
          // `actuel.current`, lui, se lit **maintenant** — l'état local au
          // moment où la réponse arrive, et non celui du rendu qui a lancé
          // l'écriture. Toute la réconciliation tient à cette distinction.
          const toAdopt = reconciliation(
            variables.patch,
            result.clip,
            current.current,
            reference,
          )
          if (toAdopt) reconcileRef.current(result.clip.id, toAdopt)
        },
        () => {
          if (isLast()) setFailure(signature)
        },
      )
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [signature, blocked, reference, segments, ratio, cropX])

  // Le départ : démontage du composant **et** fermeture de l'onglet.
  //
  // Les deux, parce qu'aucun des deux ne couvre l'autre. React n'exécute pas
  // toujours son nettoyage quand la page se ferme ; et `pagehide` ne se
  // déclenche pas quand on passe simplement d'un clip à l'autre. Les trois
  // départs — `pagehide`, démontage, et le minuteur lui-même — vérifient tous
  // `inWait` avant d'écrire, donc celui qui vide en premier empêche les autres.
  //
  // **Ce vidage-là n'attend pas de réponse**, et c'est volontaire : il part au
  // moment où la page s'en va. Un refus qui reviendrait après n'a plus de
  // composant pour le réconcilier, et `reconcile` refuserait de toute façon de
  // toucher un autre clip que celui que le store porte.
  //
  // Ne pas attendre n'est pas ne pas reprendre, en revanche : depuis que
  // `write` rend une promesse, la laisser tomber ferait d'un échec de départ un
  // **rejet non géré** — une suite de tests qui rougit ailleurs qu'à l'endroit
  // du défaut, et une console de production salie à chaque fermeture d'onglet
  // sur un réseau capricieux. D'où le `catch` vide plus bas, qui est une
  // décision et non un oubli.
  //
  // La conséquence, qu'il vaut mieux écrire que découvrir : si l'on **revient
  // sur le même clip** avant que le store n'ait changé de clip, la garde de
  // `charger` le laisse tel quel — c'est sa raison d'être —, la comparaison
  // retrouve l'écart contre la nouvelle référence, et l'intention repart avec un
  // jeton neuf, donc gagnante. C'est un « dernier auteur gagne », et il est
  // correct dans le mode d'emploi prévu — un utilisateur, une machine, un
  // onglet : l'auteur en question est le même que celui du gagnant précédent, et
  // ce qu'il voit à l'écran est ce qu'il veut garder. Le jour où deux onglets
  // deviendraient un usage, c'est ici qu'il faudrait demander avant d'écraser.
  // (relevé par Aristarque)
  //
  // Dépendances vides, rien d'autre que des refs à l'intérieur : une dépendance
  // ici rejouerait le vidage à chaque rendu, ce qui annulerait la temporisation.
  useEffect(() => {
    const clear = () => {
      const variables = inWait.current
      inWait.current = null
      if (!variables) return
      // **Ce vidage prend un rang comme n'importe quelle écriture.** Il porte
      // une intention plus récente que ce qui vole encore, donc les réponses en
      // attente ne sont plus d'actualité — et sur une page restaurée depuis le
      // bfcache, elles auraient tout le temps de croire le contraire.
      // Ici et non plus haut : un `pagehide` qui n'a rien à écrire ne périme
      // rien. (relevé par Copilot)
      lastAttempt.current += 1
      writeRef.current(variables).catch(() => {})
    }
    window.addEventListener('pagehide', clear)
    return () => {
      window.removeEventListener('pagehide', clear)
      clear()
      // **Inconditionnel, celui-ci** : `clear` ne prend un rang que s'il écrit,
      // et l'écran qui s'en va périme ses réponses même sans rien avoir à
      // envoyer.
      lastAttempt.current += 1
    }
  }, [])

  if (blocked) return 'failed'
  return signature === null ? 'saved' : 'pending'
}
