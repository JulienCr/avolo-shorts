import fs from 'node:fs'
import path from 'node:path'

import type { Clip } from '@/core/edl'
import { outputSize } from '@/core/framing'
import { hookIsBurned, resolveHook, type HookSettings } from '@/core/hook'
import { RENDER_NATIVE } from '@/core/render-flags'
import type { PublishedFraming, ClipOutputs } from '@/lib/api'
import { clipFraming } from '@/server/clip-framing'
import { isAAbsence } from '@/server/bytes'
import { effectiveSettings, getDb } from '@/server/db'
import {
  renderedFraming,
  pathsRender,
  fingerprintToDay,
  renderedShape,
  lireFingerprint,
} from '@/server/steps/render'

/**
 * Les sorties d'un clip : ce que l'export a produit, et sous quel nom on le
 * redemande.
 *
 * **Un seul endroit dérive les deux.** L'URL que `GET /api/clips/:id` publie et
 * le fichier que `GET /api/clips/:id/renders/:file` ouvre sortent de la même
 * table, elle-même construite par `pathsRender` — celle que l'export a suivie
 * pour écrire. Le nom qui arrive du réseau n'est donc jamais joint à un dossier :
 * il est **comparé** à cette liste, et un nom qui n'y figure pas ne désigne
 * aucun fichier. C'est ce qui ferme la traversée de répertoire sans un contrôle
 * de plus à tenir à jour.
 *
 * Voisin de `vues.ts`, et pour la même raison : le contrat de `src/lib/api.ts`
 * est d'abord une liste de choses à ne pas publier, et le chemin absolu d'un
 * rendu en fait partie.
 */

/** Un fichier de sortie : son nom public, son chemin sur le disque, son type. */
export type OutputClip = {
  /** Le nom de fichier, qui est aussi le dernier segment de l'URL. */
  name: string
  path: string
  type: string
}

type Outputs = {
  /**
   * `null` quand `RENDER_NATIVE` est désactivé ET qu'une variante 9:16 existe
   * pour le remplacer — voir `pathsRender`. Reste dû sur un clip déjà en 9:16.
   */
  mp4: OutputClip | null
  /** `null` quand le ratio natif résolu est **déjà** 9:16 : la variante n'est pas due. */
  variant9x16: OutputClip | null
  texts: OutputClip
  /** Le chemin de l'empreinte. **Pas une sortie** : elle ne se publie ni ne se sert. */
  fingerprint: string
}

function output(filePath: string, type: string): OutputClip {
  return { name: path.basename(filePath), path: filePath, type }
}

/**
 * Les sorties **dues** d'un clip, celles que l'export produit.
 *
 * Le `.ass` de `pathsRender` n'en est pas : c'est un intermédiaire, réécrit à
 * chaque passage, gardé sur le disque pour relire ce que libass a incrusté quand
 * un sous-titre surprend. Il n'a rien à faire dans une livraison, et une route
 * qui le servirait laisserait croire l'inverse.
 */
function outputs(clip: Clip, framing: PublishedFraming): Outputs {
  // **Le ratio NATIF résolu, jamais `clip.ratio`.** Un clip en `auto` n'a pas de
  // ratio à lui : c'est `computeFraming` qui le choisit — le plus large de ses
  // plans —, et c'est sous ce ratio-là que l'export a décidé s'il devait une
  // variante. Le lire ailleurs ferait chercher un `-9x16.mp4` sous un clip qui
  // n'en a pas, ou l'inverse.
  const paths = pathsRender(clip.projectId, clip.id, framing.ratio, RENDER_NATIVE)
  return {
    mp4: paths.mp4 === null ? null : output(paths.mp4, 'video/mp4'),
    variant9x16:
      paths.variant9x16 === null ? null : output(paths.variant9x16, 'video/mp4'),
    texts: output(paths.texts, 'text/plain; charset=utf-8'),
    fingerprint: paths.fingerprint,
  }
}

/**
 * L'URL d'une sortie, ou `null` tant que le fichier n'est pas là.
 *
 * `null` a un rendu prévu, une URL morte n'en a pas — c'est la note de `api.ts`,
 * et elle vaut ici comme pour le proxy : l'export dure de dix secondes à une
 * minute, et le clip existe bien avant lui.
 *
 * L'identifiant est encodé : il dérive du nom du replay, accents et espaces
 * compris.
 */
function urlIfProduced(clip: Clip, file: OutputClip): string | null {
  // **Un fichier ordinaire, pas seulement une entrée qui existe.** `existsSync`
  // dit oui à un dossier nommé `<clip>.mp4`, et Linux accepte même de l'ouvrir —
  // c'est pourquoi `serveFile` contrôle `isFile()` avant de pousser des
  // octets. Sans le même contrôle ici, les deux côtés du contrat se
  // contrediraient : `GET /api/clips/:id` annoncerait une sortie que la route
  // des rendus refuse aussitôt en 404. (relevé par Copilot)
  let info: fs.Stats
  try {
    info = fs.statSync(file.path)
  } catch (error) {
    // **Seule une absence vaut `null`.** Un refus de droits ou un montage mort
    // n'est pas « pas encore exporté » : l'avaler ferait annoncer un projet
    // vierge à un serveur en panne, et enverrait chercher le défaut à l'exact
    // opposé de là où il est. `serveFile` fait la même distinction sur les
    // mêmes codes — les deux bouts du contrat doivent tomber d'accord.
    // (relevé par Copilot)
    if (isAAbsence(error)) return null
    throw error
  }
  if (!info.isFile()) return null
  return `/api/clips/${encodeURIComponent(clip.id)}/renders/${encodeURIComponent(file.name)}`
}

/**
 * Ce clip a-t-il une livraison à jour, c'est-à-dire des fichiers qui le
 * décrivent encore ?
 *
 * **Une seule question, deux portes.** `clipOutputs` publie les URL et
 * `GET /api/clips/:id/renders/:file` pousse les octets ; les deux doivent
 * répondre pareil, sinon la porte qui reste ouverte laisse sortir exactement ce
 * que l'autre déclare indisponible — un consommateur qui a gardé l'URL continue
 * de tirer le rendu périmé. (relevé par Codex)
 *
 * **Le statut d'abord**, et c'est un invariant, pas une précaution : `status` ne
 * devient `exported` que dans `renderClip`, une fois les fichiers écrits — la
 * route d'édition refuse ce statut au client. Des fichiers présents sous un clip
 * qui ne le porte pas décrivent donc autre chose que sa livraison : un rendu
 * qu'une édition vient de périmer et dont l'effacement a échoué, ou les restes
 * d'un montage abandonné. (relevé par Copilot)
 *
 * **Et le statut ne suffit pas non plus** (#48). Un clip peut le porter sur des
 * fichiers qui ne le décrivent plus : ceux qui étaient sur le disque avant que
 * l'empreinte existe, ou ceux qu'un rendu antérieur a produits sous une autre
 * recette. C'est ici que le rendu « se dit à jour », donc c'est ici qu'il doit
 * avoir de quoi le prouver. Le contrat le dit déjà : `mp4Url: null` veut dire
 * « pas de livraison à jour », pas « jamais exporté » (`src/lib/api.ts`), et
 * l'écran propose alors l'export — qui refera ce qu'il faut plutôt que de sauter
 * dessus.
 *
 * **Sans sonder le dossier des marques ni le look des sous-titres** : un `GET` se
 * sert à chaque affichage de carte et ne lance pas deux ffprobe pour cela. C'est
 * la même fonction que celle du rendu, avec deux critères de moins — voir
 * `ObservedBurnIn`.
 *
 * **Le hook, lui, EST sondé — le cas sans précédent.** Un `PUT /api/settings`
 * qui change un réglage global de hook ne recalcule rien (`applySettings`
 * n'a pas à savoir que `render.ts` existe), et ne doit rien effacer non plus
 * — `docs/retour-ui-and-next-steps.md` (le PR 1 en a déjà la phrase, sous la
 * section des réglages). La péremption est donc **paresseuse**, posée ici, à
 * la porte qui pose déjà la question. Elle ne coûte qu'une lecture de la
 * table `settings` et deux appels purs — `resolveHook`, `outputSize` —, pas de
 * rasterisation PNG : ce qui détermine l'image (le hook résolu, sa géométrie,
 * les dimensions des deux canevas) suffit à la comparaison, voir
 * `hookFingerprint` dans `src/server/steps/render.ts`. Pas de `ffprobe`, pas
 * de Drive, ce que les trois autres critères ne peuvent pas dire.
 */
export function deliveryToDay(
  clip: Clip,
  framing: PublishedFraming = clipFraming(clip),
  hookGlobals: HookSettings = effectiveSettings(getDb()).hook,
): boolean {
  if (clip.status !== 'exported') return false
  const produced = outputs(clip, framing)
  const resolvedHook = resolveHook(hookGlobals, clip)
  return fingerprintToDay(
    lireFingerprint(produced.fingerprint),
    renderedShape(clip, renderedFraming(framing)),
    // `texte: undefined` pour la même raison que les deux champs au-dessus :
    // sonder le texte suppose de lire le transcript, sur le Drive, et un `GET`
    // ne paie pas cet aller-retour à chaque affichage de carte.
    {
      markers: null,
      look: null,
      text: undefined,
      hook: hookIsBurned(resolvedHook)
        ? {
            resolved: resolvedHook,
            canvases: {
              native: outputSize(framing.ratio),
              variant: produced.variant9x16 === null ? null : outputSize('9:16'),
            },
          }
        : null,
    },
  )
}

/**
 * Ce que `GET /api/clips/:id` dit des sorties.
 *
 * **`variant9x16Due` sépare deux `null` qui ne veulent pas dire la même chose.**
 * Un clip dont le ratio natif est déjà 9:16 n'a pas de variante à fond flouté et
 * n'en aura jamais : son absence est le fonctionnement normal. Un clip en 1:1 qui
 * n'en a pas encore n'est pas fini. Sans ce booléen, une interface affiche
 * « rendu manquant » sur le premier — sur le clip le mieux livré de la
 * bibliothèque.
 *
 * **`hookGlobals` se transmet à `deliveryToDay`, jamais ne se relit.** Un
 * second appel à `effectiveSettings` entre les deux poserait la question deux
 * fois — une fois ici, une fois dans son propre défaut — et une écriture
 * concurrente entre les deux ferait dire à l'un « à jour » et à l'autre
 * « périmé » sur le même appel.
 */
export function clipOutputs(
  clip: Clip,
  framing: PublishedFraming = clipFraming(clip),
  hookGlobals: HookSettings = effectiveSettings(getDb()).hook,
): ClipOutputs {
  const { mp4, variant9x16, texts } = outputs(clip, framing)
  if (!deliveryToDay(clip, framing, hookGlobals)) {
    return {
      mp4Url: null,
      mp4Due: mp4 !== null,
      variant9x16Url: null,
      variant9x16Due: variant9x16 !== null,
      textsUrl: null,
    }
  }
  return {
    mp4Url: mp4 === null ? null : urlIfProduced(clip, mp4),
    mp4Due: mp4 !== null,
    variant9x16Url: variant9x16 === null ? null : urlIfProduced(clip, variant9x16),
    variant9x16Due: variant9x16 !== null,
    textsUrl: urlIfProduced(clip, texts),
  }
}

/**
 * La sortie que ce nom désigne, ou `null` si ce clip n'en produit aucune sous ce
 * nom-là.
 *
 * Le nom arrive du réseau. Il n'entre dans aucun `path.join` : la comparaison se
 * fait sur des noms déjà construits par `pathsRender`, donc `../` et compagnie
 * ne désignent rien — pas parce qu'ils sont filtrés, mais parce qu'ils ne
 * figurent pas dans la liste.
 *
 * **Ni le `.ass` ni l'empreinte n'y figurent**, pour la même raison qu'ils ne
 * sont pas des sorties : ce sont des pièces internes, et une route qui les
 * servirait laisserait croire qu'elles font partie de la livraison.
 */
export function outputNamed(
  clip: Clip,
  name: string,
  framing: PublishedFraming = clipFraming(clip),
): OutputClip | null {
  const { mp4, variant9x16, texts } = outputs(clip, framing)
  return [mp4, variant9x16, texts].find((s) => s !== null && s.name === name) ?? null
}
