import { getClip, getDb } from '@/server/db'
import { notFound, route } from '@/server/http'
import { serveFile } from '@/server/bytes'
import { clipFraming } from '@/server/clip-framing'
import { deliveryToDay, outputNamed } from '@/server/renders'

/**
 * `GET /api/clips/:id/renders/:file` — un fichier produit par l'export.
 *
 * Sans elle, la chaîne s'arrête à un mètre de son but : le MP4 est sur le disque,
 * le clip affiche « exporté », et rien ne permet de le lire depuis le navigateur.
 * `projects/` est un dossier de données, hors de `public/`, et n'a pas à devenir
 * un dossier public — c'est donc à une route de pousser les octets.
 *
 * **Le nom demandé est comparé, jamais concaténé.** `outputNamed` le cherche
 * dans les sorties que ce clip-là produit, et le chemin qui en ressort vient de
 * `pathsRender`, pas de l'URL. Un nom absent de cette liste est un 404, quelle
 * que soit sa forme : la traversée de répertoire n'a rien à traverser.
 *
 * **Elle passe par le wrapper `route()`**, contrairement à la route du proxy qui
 * est un `GET` nu. Ce n'est pas une divergence de style : `src/server/http.ts`
 * n'existait pas quand le proxy a été écrit. Sans le wrapper, une erreur
 * inattendue remonte à la page d'erreur de Next, c'est-à-dire, en développement,
 * la trace complète avec les chemins du serveur dedans — exactement ce que le
 * reste de cette API se donne du mal à ne pas publier.
 */
export const GET = route(
  'GET /api/clips/:id/renders/:file',
  async (request: Request, context: { params: Promise<{ id: string; file: string }> }) => {
    const { id, file } = await context.params

    // Le clip d'abord : c'est lui qui dit quels fichiers existent sous quel nom,
    // et son `projectId` vient de la base, jamais d'un morceau d'URL.
    const clip = getClip(getDb(), id)
    if (clip === undefined) throw notFound(`Clip inconnu : ${id}`)

    // **Un clip sans livraison à jour ne sert rien**, même si le fichier est là.
    //
    // Des fichiers qui survivent sous un clip `kept` — un effacement qui a
    // échoué, les restes d'un montage abandonné — décrivent la version d'avant.
    // `clipOutputs` a cessé de les publier ; les servir quand même à qui a
    // gardé l'URL laisserait exactement le même mensonge sortir par l'autre
    // porte. (relevé par Copilot)
    //
    // **Le même verdict que la publication des URL, par la même fonction.** Le
    // statut ne suffit pas : depuis #48, un clip `exported` dont l'empreinte ne
    // décrit plus le rendu n'a pas de livraison à jour non plus, et l'URL de son
    // MP4 est stable — un lecteur qui l'a gardée continuerait de tirer
    // précisément le fichier que l'autre porte déclare indisponible.
    // (relevé par Codex)
    //
    // **Le message reste générique**, et il l'est volontairement : ce verdict est
    // faux pour un clip jamais exporté, pour une empreinte absente ou illisible,
    // pour une recette antérieure et pour un montage modifié. Nommer une seule
    // de ces causes enverrait chercher le défaut là où il n'est pas trois fois
    // sur quatre. (relevé par Copilot)
    // **Un seul cadrage pour les deux questions.** Il décide du verdict de
    // fraîcheur *et* du nom des fichiers — le ratio natif dit si une variante
    // 9:16 est due. Le résoudre deux fois ouvrirait une fenêtre où une relance
    // d'analyse tomberait entre les deux : la porte se déclarerait ouverte sur
    // un jeu de noms, puis chercherait le fichier dans l'autre.
    const framing = clipFraming(clip)
    if (!deliveryToDay(clip, framing)) {
      throw notFound(`Le clip ${id} n'a pas de rendu à jour à servir sous ce nom.`)
    }

    const output = outputNamed(clip, file, framing)
    if (output === null) {
      throw notFound(`Le clip ${id} ne produit aucun fichier nommé ${JSON.stringify(file)}.`)
    }

    const response = await serveFile(request, output.path, {
      'Content-Type': output.type,
      // Le fichier est remplacé sous la même URL par un ré-export, et rien ici
      // ne porte de validateur : le navigateur doit redemander plutôt que de
      // rejouer le rendu précédent. `no-cache` autorise le stockage et exige la
      // revalidation, ce qui laisse le lecteur vidéo garder ses plages le temps
      // d'une lecture.
      'Cache-Control': 'no-cache',
    })
    // Pas de fichier : l'export n'a pas encore tourné, ou pas avec ce ratio-là.
    // Ce n'est pas une panne, et le message le dit sans nommer de chemin.
    if (response === null) {
      throw notFound(`Pas encore de rendu ${output.name} pour le clip ${id}.`)
    }
    return response
  },
)
