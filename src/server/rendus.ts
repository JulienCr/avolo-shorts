import fs from 'node:fs'
import path from 'node:path'

import type { Clip } from '@/core/edl'
import { resolveRatio } from '@/core/framing'
import type { ClipOutputs } from '@/lib/api'
import { estUneAbsence } from '@/server/octets'
import { cheminsRendu, empreinteÀJour, lireEmpreinte } from '@/server/steps/render'

/**
 * Les sorties d'un clip : ce que l'export a produit, et sous quel nom on le
 * redemande.
 *
 * **Un seul endroit dérive les deux.** L'URL que `GET /api/clips/:id` publie et
 * le fichier que `GET /api/clips/:id/renders/:file` ouvre sortent de la même
 * table, elle-même construite par `cheminsRendu` — celle que l'export a suivie
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
export type SortieClip = {
  /** Le nom de fichier, qui est aussi le dernier segment de l'URL. */
  nom: string
  chemin: string
  type: string
}

type Sorties = {
  mp4: SortieClip
  /** `null` quand le ratio résolu est **déjà** 9:16 : la variante n'est pas due. */
  variant9x16: SortieClip | null
  texts: SortieClip
  /** Le chemin de l'empreinte. **Pas une sortie** : elle ne se publie ni ne se sert. */
  empreinte: string
}

function sortie(chemin: string, type: string): SortieClip {
  return { nom: path.basename(chemin), chemin, type }
}

/**
 * Les sorties **dues** d'un clip, celles que l'export produit.
 *
 * Le `.ass` de `cheminsRendu` n'en est pas : c'est un intermédiaire, réécrit à
 * chaque passage, gardé sur le disque pour relire ce que libass a incrusté quand
 * un sous-titre surprend. Il n'a rien à faire dans une livraison, et une route
 * qui le servirait laisserait croire l'inverse.
 */
function sorties(clip: Clip): Sorties {
  const chemins = cheminsRendu(clip.projectId, clip.id, resolveRatio(clip.ratio))
  return {
    mp4: sortie(chemins.mp4, 'video/mp4'),
    variant9x16:
      chemins.variant9x16 === null ? null : sortie(chemins.variant9x16, 'video/mp4'),
    texts: sortie(chemins.texts, 'text/plain; charset=utf-8'),
    empreinte: chemins.empreinte,
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
function urlSiProduit(clip: Clip, fichier: SortieClip): string | null {
  // **Un fichier ordinaire, pas seulement une entrée qui existe.** `existsSync`
  // dit oui à un dossier nommé `<clip>.mp4`, et Linux accepte même de l'ouvrir —
  // c'est pourquoi `servirFichier` contrôle `isFile()` avant de pousser des
  // octets. Sans le même contrôle ici, les deux côtés du contrat se
  // contrediraient : `GET /api/clips/:id` annoncerait une sortie que la route
  // des rendus refuse aussitôt en 404. (relevé par Copilot)
  let info: fs.Stats
  try {
    info = fs.statSync(fichier.chemin)
  } catch (erreur) {
    // **Seule une absence vaut `null`.** Un refus de droits ou un montage mort
    // n'est pas « pas encore exporté » : l'avaler ferait annoncer un projet
    // vierge à un serveur en panne, et enverrait chercher le défaut à l'exact
    // opposé de là où il est. `servirFichier` fait la même distinction sur les
    // mêmes codes — les deux bouts du contrat doivent tomber d'accord.
    // (relevé par Copilot)
    if (estUneAbsence(erreur)) return null
    throw erreur
  }
  if (!info.isFile()) return null
  return `/api/clips/${encodeURIComponent(clip.id)}/renders/${encodeURIComponent(fichier.nom)}`
}

/**
 * Ce que `GET /api/clips/:id` dit des sorties.
 *
 * **`variant9x16Due` sépare deux `null` qui ne veulent pas dire la même chose.**
 * Un clip déjà en 9:16 n'a pas de variante à fond flouté et n'en aura jamais :
 * son absence est le fonctionnement normal. Un clip en 1:1 qui n'en a pas encore
 * n'est pas fini. Sans ce booléen, une interface affiche « rendu manquant » sur
 * le premier — sur le clip le mieux livré de la bibliothèque.
 */
/**
 * Ce clip a-t-il une livraison à jour, c'est-à-dire des fichiers qui le
 * décrivent encore ?
 *
 * **Une seule question, deux portes.** `sortiesDuClip` publie les URL et
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
 * **Sans sonder le dossier des marques** : un `GET` se sert à chaque affichage
 * de carte et ne lance pas deux ffprobe pour cela. C'est la même fonction que
 * celle du rendu, avec un critère de moins — voir `écartDeLEmpreinte`.
 */
export function livraisonÀJour(clip: Clip): boolean {
  if (clip.status !== 'exported') return false
  return empreinteÀJour(lireEmpreinte(sorties(clip).empreinte), clip, null)
}

export function sortiesDuClip(clip: Clip): ClipOutputs {
  const { mp4, variant9x16, texts } = sorties(clip)
  if (!livraisonÀJour(clip)) {
    return { mp4Url: null, variant9x16Url: null, variant9x16Due: variant9x16 !== null, textsUrl: null }
  }
  return {
    mp4Url: urlSiProduit(clip, mp4),
    variant9x16Url: variant9x16 === null ? null : urlSiProduit(clip, variant9x16),
    variant9x16Due: variant9x16 !== null,
    textsUrl: urlSiProduit(clip, texts),
  }
}

/**
 * La sortie que ce nom désigne, ou `null` si ce clip n'en produit aucune sous ce
 * nom-là.
 *
 * Le nom arrive du réseau. Il n'entre dans aucun `path.join` : la comparaison se
 * fait sur des noms déjà construits par `cheminsRendu`, donc `../` et compagnie
 * ne désignent rien — pas parce qu'ils sont filtrés, mais parce qu'ils ne
 * figurent pas dans la liste.
 *
 * **Ni le `.ass` ni l'empreinte n'y figurent**, pour la même raison qu'ils ne
 * sont pas des sorties : ce sont des pièces internes, et une route qui les
 * servirait laisserait croire qu'elles font partie de la livraison.
 */
export function sortieNommée(clip: Clip, nom: string): SortieClip | null {
  const { mp4, variant9x16, texts } = sorties(clip)
  return [mp4, variant9x16, texts].find((s) => s !== null && s.nom === nom) ?? null
}
