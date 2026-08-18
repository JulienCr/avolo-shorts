import fs from 'node:fs'
import { z } from 'zod'

import { normalizeSegments, type Clip } from '@/core/edl'
import { resolveRatio } from '@/core/framing'
import { getClip, getDb, getProject, plancherDOrdre, putClip, putClipOrdonné } from '@/server/db'
import { corps, introuvable, json, route } from '@/server/http'
import { sortiesDuClip } from '@/server/rendus'
import {
  cheminsRendu,
  texteDePublication,
  écarterRenduPérimé,
  écrireTexteDePublication,
} from '@/server/steps/render'
import { vignettePath } from '@/server/thumbs'
import { lignesAutourDuClip, résuméProjet, transcriptDuProjet, urlProxy } from '@/server/vues'

/**
 * `GET /api/clips/:id` — un clip, de quoi le monter, et ce que l'export en a
 * produit.
 * `PATCH /api/clips/:id` — l'édition de l'EDL, ordonnée par le jeton du geste.
 */

/**
 * Ce que le client a le droit d'écrire.
 *
 * **Un objet strict, et c'est le cœur du contrôle.** Trois champs identifient le
 * clip et sa provenance — `id`, `projectId`, `pass` — et ne se corrigent pas
 * depuis l'interface : les refuser un par un obligerait à penser à chaque
 * nouveau champ, alors qu'un objet strict refuse d'emblée tout ce qui n'est pas
 * nommé ici.
 *
 * **`exported` est absent de `status`, et c'est délibéré.** Un clip devient
 * exporté parce qu'un MP4 a été produit (`POST /api/clips/:id/export`), jamais
 * parce que quelqu'un l'a écrit. Laisser passer ce statut permettrait de marquer
 * exporté un clip dont rien n'a été rendu — et `mergeCandidates` le ferait alors
 * survivre à toutes les passes suivantes, puisqu'il tient tout statut non
 * `candidate` pour une décision humaine.
 */
const ÉDITION = z.strictObject({
  segments: z.array(z.strictObject({ start: z.number().finite(), end: z.number().finite() })).optional(),
  ratio: z.enum(['9:16', '4:5', '1:1', '16:9', 'auto']).optional(),
  // Le centre horizontal du crop : un nombre entre 0 et 1, le crop étant pleine
  // hauteur (spec §2).
  cropX: z.number().min(0).max(1).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  captions: z.boolean().optional(),
  branding: z.boolean().optional(),
  status: z.enum(['candidate', 'kept', 'discarded']).optional(),
  /**
   * Le numéro d'ordre du **geste**, et non de l'arrivée.
   *
   * `usePatchClip` envoie délibérément des écritures qui se chevauchent : deux
   * clics rapides sur la même carte partent en deux requêtes, et rien ne
   * garantit que la première arrive la première. Traitée dans le désordre, la
   * base finit sur la valeur la plus ancienne pendant que l'écran affiche la
   * bonne — l'écart n'apparaît qu'au rechargement (issue #21). Ce numéro est la
   * seule chose que le serveur ne pouvait pas deviner.
   *
   * **Facultatif.** Un appelant qui n'ordonne pas ses écritures — un `curl`, un
   * script — n'entre pas dans cette course : il écrit, et le jeton en base ne
   * bouge pas.
   */
  seq: z.number().int().min(0).optional(),
})

export const GET = route(
  'GET /api/clips/:id',
  async (_requête: Request, contexte: { params: Promise<{ id: string }> }) => {
    const { id } = await contexte.params
    const db = getDb()
    const clip = getClip(db, id)
    if (clip === undefined) throw introuvable(`Clip inconnu : ${id}`)
    const projet = getProject(db, clip.projectId)
    if (projet === undefined) throw introuvable(`Projet inconnu : ${clip.projectId}`)

    const transcript = await transcriptDuProjet(projet)
    return json({
      clip,
      project: résuméProjet(projet),
      // La fenêtre se calcule sur l'étendue **d'origine** du candidat, jamais sur
      // ses segments courants : un clip vidé de tous ses mots n'en a plus, et sa
      // fenêtre disparaîtrait au moment précis où il faut relire le transcript
      // pour le reconstruire. Voir `étendueOrigine`.
      lines: transcript === null ? [] : lignesAutourDuClip(transcript, clip),
      proxyUrl: urlProxy(clip.projectId),
      // Ce que l'export a produit, en URL. Sans elles, un clip affiche
      // « exporté » et son MP4 reste inatteignable depuis le navigateur : la
      // chaîne s'arrête à un mètre de son but.
      outputs: sortiesDuClip(clip),
    })
  },
)

export const PATCH = route(
  'PATCH /api/clips/:id',
  async (requête: Request, contexte: { params: Promise<{ id: string }> }) => {
    const { id } = await contexte.params
    // **Le corps d'abord, la base ensuite.** Lire le clip avant d'attendre le
    // corps ouvre une fenêtre entre la lecture et l'écriture, et l'interface
    // lance délibérément des écritures qui se chevauchent (`usePatchClip`) : deux
    // gestionnaires lisaient alors la même ligne, puis chacun réécrivait sa
    // fusion, et la modification du premier disparaissait sans un mot. Lecture,
    // fusion et écriture se suivent maintenant sans point d'attente, ce qui suffit
    // sur le fil unique de Node. (relevé par Copilot)
    const { seq, ...édition } = await corps(requête, ÉDITION)

    const db = getDb()
    const clip = getClip(db, id)
    if (clip === undefined) throw introuvable(`Clip inconnu : ${id}`)

    const suivant: Clip = {
      ...clip,
      ...édition,
      // **Normalisés avant écriture**, toujours : triés, sans chevauchement,
      // sans segment vide. Ce que le client envoie est une intention, pas une
      // forme canonique — un glissement de sélection produit très bien deux
      // segments qui se touchent, et les garder séparés ouvrirait un décodeur
      // ffmpeg de plus au rendu.
      segments: normalizeSegments(édition.segments ?? clip.segments),
    }

    // Le jeton, quand il y en a un. Les champs comparés sont ceux que le client
    // a **envoyés** — les clés du corps, pas celles qui ont changé de valeur.
    let écrit = suivant
    let appliqué = true
    let plancher = 0
    if (seq === undefined) {
      putClip(db, suivant)
      // `putClip` ne touche pas aux jetons : le plancher est celui d'avant, et
      // c'est lui qu'il faut annoncer. Rendre `0` ici contredirait le contrat de
      // `PatchClipResult.seq` et recalerait l'appelant vers le bas.
      plancher = plancherDOrdre(db, id)
    } else {
      const résultat = putClipOrdonné(db, suivant, Object.keys(édition) as (keyof Clip)[], seq)
      if (résultat === undefined) throw introuvable(`Clip inconnu : ${id}`)
      écrit = résultat.clip
      appliqué = résultat.applied
      plancher = résultat.seq
    }

    // **Un rendu qui ne décrit plus le clip est écarté ici.**
    //
    // Le modèle de l'itération 0 fait foi sur la présence du fichier : un clip
    // exporté puis remonté garde ses MP4 et son statut `exported`, donc
    // `outputs` publierait une vidéo qui montre le montage d'avant, la route des
    // rendus la servirait, et un export sans `force` la sauterait pour cause de
    // fichiers complets. `renderClip` connaît déjà ce cas — il le traite pour un
    // montage modifié *pendant* l'encodage — et c'est exactement la même
    // question posée un instant plus tard. On réutilise donc sa décision plutôt
    // que d'en inventer une seconde. (relevé par Copilot)
    //
    // Les chemins se calculent sur le clip **d'avant** : c'est lui qui dit sous
    // quel ratio les fichiers à écarter ont été écrits, et un passage de 1:1 à
    // 9:16 change le jeu.
    // Sans condition sur le statut : `leRenduEstPérimé` ne se déclenche que
    // lorsqu'un champ qui change l'image a bougé, et un clip que rien n'a rendu
    // n'a pas de fichier à effacer — trois `rmSync` sur des chemins absents. La
    // garder ferait un `écrit.status === 'exported'` mort, puisque le schéma
    // refuse ce statut au client, et laisserait passer le cas d'un rendu produit
    // à la main sur un clip resté `kept`.
    //
    // **Rien ne doit lever d'ici.** L'écriture en base est déjà validée : une
    // erreur de système de fichiers rendrait 500 sur un montage pourtant
    // enregistré, et l'écriture optimiste de l'interface remettrait l'ancienne
    // version à l'écran alors que la base porte la nouvelle. C'est la règle que
    // la vignette suit déjà quelques lignes plus bas, et elle vaut d'autant plus
    // ici que `écarterRenduPérimé` efface trois fichiers : un échec au deuxième
    // laisse un jeu de sorties incomplet, que la réponse décrira tel qu'il est,
    // puisqu'elle relit le disque après coup. (relevé par Copilot)
    const chemins = cheminsRendu(clip.projectId, clip.id, resolveRatio(clip.ratio))
    try {
      const périmé = écarterRenduPérimé(db, id, chemins, clip)

      // **La variante du ratio d'arrivée, en plus de celle du ratio de départ.**
      //
      // `chemins` ne connaît que l'ancien ratio, et c'est ce qu'il faut pour
      // effacer ce qui a été écrit. Mais un clip qui passe de 9:16 à 1:1 n'avait
      // pas de variante due, donc un `-9x16.mp4` abandonné par une période
      // antérieure y survivait — et `sortiesDuClip`, qui résout le ratio
      // *nouveau*, le publiait aussitôt comme la livraison du jour. Le nom de la
      // variante ne dépend pas du ratio, seulement du fait qu'il ne soit pas
      // 9:16 : effacer l'union des deux ferme le cas dans les deux sens.
      // (relevé par Copilot)
      if (périmé) {
        const varianteAprès = cheminsRendu(
          écrit.projectId,
          écrit.id,
          resolveRatio(écrit.ratio),
        ).variant9x16
        if (varianteAprès !== null) fs.rmSync(varianteAprès, { force: true })
      }

      // **Le `.txt` ne suit pas le même sort que les MP4.** Le titre et la
      // description ne changent pas une image, donc `leRenduEstPérimé` les
      // ignore et les vidéos restent bonnes — mais le texte de publication, lui,
      // n'est plus le bon, et `outputs.textsUrl` continuerait de le proposer.
      // On le réécrit plutôt que de l'effacer : `sauterLeRendu` exige les trois
      // sorties, et un `.txt` manquant ferait réencoder quarante secondes de
      // vidéo pour une faute de frappe corrigée. Réécrit **seulement s'il
      // existe** : en fabriquer un pour un clip que rien n'a rendu ferait
      // annoncer une sortie qui n'en est pas une. (relevé par Copilot)
      //
      // **L'écriture elle-même appartient à `renderClip`**, et c'est le troisième
      // point de #48 : les deux chemins écrivaient ce fichier chacun de son
      // côté, sans que rien ne dise laquelle des deux versions survit. La règle
      // est maintenant écrite une fois, dans `écrireTexteDePublication` — le
      // `.txt` porte l'état de la base au moment de son écriture — et les deux
      // appelants s'y tiennent. Ce qui reste ici est la seule chose qui relève
      // du `PATCH` : ne pas fabriquer un `.txt` pour un clip que rien n'a rendu,
      // et ne pas réécrire pour rien.
      if (
        texteDePublication(écrit) !== texteDePublication(clip) &&
        fs.existsSync(chemins.texts)
      ) {
        écrireTexteDePublication(db, id, écrit, chemins.texts)
      }
    } catch (cause) {
      console.warn(`Sorties non mises à jour pour ${clip.id} :`, cause)
      // **Le statut sort d'`exported` même quand l'effacement a échoué.**
      // `écarterRenduPérimé` le repose en dernier, après ses trois `rmSync` : une
      // erreur au milieu laissait un clip qui se dit exporté sur des fichiers
      // qui ne le décrivent plus. Avec le statut remis, `sortiesDuClip` cesse de
      // les publier — ce qui reste sur le disque n'est plus offert comme la
      // livraison du jour. (relevé par Copilot)
      const àJour = getClip(db, id)
      if (àJour !== undefined && àJour.status === 'exported') {
        putClip(db, { ...àJour, status: 'kept' })
      }
    }

    // La vignette est tirée du premier segment : si celui-ci a bougé, l'image en
    // cache ne montre plus le début du clip. On l'efface plutôt que de la
    // laisser mentir — elle se refabrique au prochain affichage de la carte.
    //
    // **Au pire des cas, pas d'erreur.** L'écriture en base est déjà validée à
    // ce point : lever ici rendrait 500 sur un montage pourtant enregistré, et
    // l'écriture optimiste de l'interface remettrait l'ancienne version à
    // l'écran alors que la base porte la nouvelle. Une vignette périmée est un
    // défaut d'affichage, une divergence client/serveur en est un autre.
    // (relevé par Codex)
    //
    // **Sur ce qui a été écrit, pas sur ce qui a été demandé.** Un `segments`
    // écarté parce qu'un geste plus récent l'avait déjà déplacé laisse la
    // vignette juste : l'effacer ferait payer une régénération à une écriture
    // qui n'a pas eu lieu.
    if (écrit.segments[0]?.start !== clip.segments[0]?.start) {
      try {
        fs.rmSync(vignettePath(clip.projectId, clip.id), { force: true })
      } catch (cause) {
        console.warn(`Vignette non effacée pour ${clip.id} :`, cause)
      }
    }

    // **200 même quand un champ a été écarté**, et pas 409. Une écriture plus
    // récente a gagné : c'est un résultat, pas un échec d'enregistrement. Un
    // code d'erreur ferait afficher « la sauvegarde a échoué » sur le clip le
    // mieux enregistré de la session, et pousserait l'interface à réessayer une
    // écriture dont on vient précisément d'établir qu'elle est périmée. Le clip
    // rendu est celui que la base porte, donc l'appelant se remet d'accord avec
    // elle sans une requête de plus.
    // **Les sorties partent avec la réponse**, relues après l'éventuel écart.
    // L'appelant tient son cache à jour sur une écriture optimiste : sans elles,
    // il garderait l'URL d'un rendu que ce `PATCH` vient de faire disparaître, et
    // son lecteur vidéo pointerait sur un 404 jusqu'au prochain rechargement.
    // (relevé par Aristarque)
    const relu = getClip(db, id) ?? écrit
    return json({ applied: appliqué, clip: relu, outputs: sortiesDuClip(relu), seq: plancher })
  },
)
