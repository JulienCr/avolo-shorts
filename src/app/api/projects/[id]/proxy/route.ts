import { servirFichier } from '@/server/octets'
import { projectsDir, proxyPath } from '@/server/paths'

/**
 * `GET /api/projects/:id/proxy` — le proxy 960x540, servi en requêtes
 * partielles.
 *
 * Le proxy pèse plus d'un gigaoctet et vit dans `PROJECTS_DIR`, hors de
 * `public/` : Next ne le sert pas tout seul, et il n'en est pas question — un
 * dossier de données n'a pas à devenir un dossier public.
 *
 * Cette route existe surtout pour l'en-tête `Range`. **Sans réponse aux requêtes
 * partielles, la barre de lecture d'un `<video>` ne fonctionne pas** : faute de
 * pouvoir demander un morceau au milieu, le navigateur ne peut pas sauter, et
 * l'éditeur de clip (tâche 13) scrube en permanence.
 *
 * **Tout ce qui touche aux octets est dans `@/server/octets`**, avec la route des
 * rendus. Cette route-ci en portait une copie, écrite avant que le module
 * n'existe, et la copie a vieilli séparément : la correction de l'issue #75 y
 * aurait été à faire deux fois, sur un défaut que le commentaire local déclarait
 * justement impossible. Il ne reste ici que ce que l'autre route ne partage pas —
 * trouver le chemin, et raconter l'absence.
 */

/** Le proxy est toujours du H.264 en conteneur MP4 (tâche 8). */
const TYPE = 'video/mp4'

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params

  // Appelé pour lui-même, et **avant** le `try` qui suit : `projectsDir()` lève
  // si `PROJECTS_DIR` manque ou est vide. Sous le `try`, cette erreur de
  // configuration deviendrait un 404 sur *toutes* les requêtes — un serveur mal
  // monté annonçant tranquillement qu'aucun projet n'existe, ce qui enverrait
  // chercher le bug à l'exact opposé de là où il est. (relevé par Copilot)
  projectsDir()

  let chemin: string
  try {
    chemin = proxyPath(id)
  } catch {
    // Reste donc le seul refus possible ici : celui de `vérifierId`, dans
    // `src/server/paths.ts`. C'est lui qui garde la traversée de répertoire, et
    // il le fait sur la seule chose qui compte, les séparateurs. Un identifiant
    // qui ne peut nommer aucun chemin ne désigne aucun proxy : 404, comme un
    // projet inexistant. Répondre 400 dirait au demandeur que sa syntaxe était
    // presque bonne.
    return new Response(null, { status: 404 })
  }

  // Pas de fichier : tant que l'étape d'encodage n'a pas tourné, il n'y a rien à
  // servir. Ce n'est pas une panne, et tout le reste — droits refusés, montage
  // mort — remonte en 500 par `servirFichier`, qui ne déguise que l'absence.
  const response = await servirFichier(request, chemin, { 'Content-Type': TYPE })
  return response ?? new Response(null, { status: 404 })
}
