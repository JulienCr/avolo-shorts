import { getClip, getDb } from '@/server/db'
import { introuvable, route } from '@/server/http'
import { servirFichier } from '@/server/octets'
import { sortieNommée } from '@/server/rendus'

/**
 * `GET /api/clips/:id/renders/:file` — un fichier produit par l'export.
 *
 * Sans elle, la chaîne s'arrête à un mètre de son but : le MP4 est sur le disque,
 * le clip affiche « exporté », et rien ne permet de le lire depuis le navigateur.
 * `projects/` est un dossier de données, hors de `public/`, et n'a pas à devenir
 * un dossier public — c'est donc à une route de pousser les octets.
 *
 * **Le nom demandé est comparé, jamais concaténé.** `sortieNommée` le cherche
 * dans les sorties que ce clip-là produit, et le chemin qui en ressort vient de
 * `cheminsRendu`, pas de l'URL. Un nom absent de cette liste est un 404, quelle
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
  async (requête: Request, contexte: { params: Promise<{ id: string; file: string }> }) => {
    const { id, file } = await contexte.params

    // Le clip d'abord : c'est lui qui dit quels fichiers existent sous quel nom,
    // et son `projectId` vient de la base, jamais d'un morceau d'URL.
    const clip = getClip(getDb(), id)
    if (clip === undefined) throw introuvable(`Clip inconnu : ${id}`)

    const sortie = sortieNommée(clip, file)
    if (sortie === null) {
      throw introuvable(`Le clip ${id} ne produit aucun fichier nommé ${JSON.stringify(file)}.`)
    }

    const réponse = await servirFichier(requête, sortie.chemin, {
      'Content-Type': sortie.type,
      // Le fichier est remplacé sous la même URL par un ré-export, et rien ici
      // ne porte de validateur : le navigateur doit redemander plutôt que de
      // rejouer le rendu précédent. `no-cache` autorise le stockage et exige la
      // revalidation, ce qui laisse le lecteur vidéo garder ses plages le temps
      // d'une lecture.
      'Cache-Control': 'no-cache',
    })
    // Pas de fichier : l'export n'a pas encore tourné, ou pas avec ce ratio-là.
    // Ce n'est pas une panne, et le message le dit sans nommer de chemin.
    if (réponse === null) {
      throw introuvable(`Pas encore de rendu ${sortie.nom} pour le clip ${id}.`)
    }
    return réponse
  },
)
