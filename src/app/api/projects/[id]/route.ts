import { getDb, getProject } from '@/server/db'
import { notFound, json, route } from '@/server/http'
import { lireStatus, progression, readingPresence } from '@/server/run'
import { summaryProject } from '@/server/views'

/**
 * `GET /api/projects/:id` — l'état d'un projet : ce qui est là, et ce qui tourne.
 *
 * **`steps` se relit sur le disque à chaque appel**, il n'est jamais servi
 * depuis une mémoire de processus. C'est ce qui fait qu'un redémarrage de Next —
 * et il y en a un à chaque édition en développement — ne perd que le suivi
 * d'avancement, jamais la vérité.
 */
export const GET = route(
  'GET /api/projects/:id',
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params
    const project = getProject(getDb(), id)
    if (project === undefined) throw notFound(`Projet inconnu : ${id}`)

    // **Le relevé d'abord, l'avancement ensuite.** `readingPresence` attend une
    // sonde de montage, et une exécution lancée pendant cette attente serait
    // manquée : la réponse annoncerait `running: null`, `useProject` couperait
    // son interrogation, et l'écran raterait l'analyse entière — sa progression,
    // son échec, et l'invalidation des candidats qui la suit. (relevé par Copilot)
    const steps = await readingPresence(project)
    const running = progression(id)
    // Une seule lecture du fichier pour les deux champs qui en sortent : il est
    // petit et local, mais le lire deux fois laisserait la porte ouverte à une
    // réponse qui mêle deux versions.
    const status = lireStatus(id)
    return json({
      project: summaryProject(project),
      steps,
      running,
      // **Le seul chemin de retour d'un échec de tâche de fond.** `lancer` a
      // répondu 202 quarante minutes plus tôt, et son rejet part dans une
      // promesse que personne n'attend : sans ce champ, une analyse qui échoue
      // est indiscernable d'une analyse qui n'a rien trouvé. On le lit dans
      // `status.json`, le seul à en garder trace, et seulement au repos —
      // pendant qu'une exécution tourne, l'échec affiché serait celui d'avant.
      // (relevé par Copilot)
      error: running === null ? (status?.error ?? null) : null,
      // Même champ, même relevé, même contrat de repos qu'`error` — voir
      // `ProjectStatus.warning`.
      warning: running === null ? (status?.warning ?? null) : null,
      // **Publié même pendant qu'une exécution tourne**, contrairement à
      // `error`. Le décompte d'une passe en cours n'est pas celui d'avant — le
      // lanceur l'oublie au lancement —, et il porte `partial` pour dire
      // exactement ce qu'il vaut. C'est la seule information de cet écran qui
      // change la confiance qu'on accorde à la liste : la cacher pendant les
      // trente minutes où elle se construit serait la cacher au moment utile.
      selectionReport: status?.selectionReport ?? null,
      // **Le même champ que celui de la bibliothèque, tiré du même relevé.** Un
      // arrêt ne laisse ni `running`, ni `error`, ni artefact particulier : il
      // n'est pas dérivable, et deux écrans qui le déduiraient chacun de leur
      // côté finiraient par diverger. Il se tait pendant qu'une exécution
      // tourne, comme `error`.
      stopped: running === null ? (status?.stopped ?? false) : false,
      // Distingue `neuf` d'`interrompu` — voir spec §12.
      everRan: status !== null,
      // La taille de la source, pour la seule chose qui en dépende :
      // `stepDurationRange` s'en sert pour suppléer la durée, qui manque
      // précisément quand le panneau d'avancement apparaît. Elle vient de la
      // ligne déjà lue, sans un accès disque de plus.
      sizeBytes: project.sizeBytes,
    })
  },
)
