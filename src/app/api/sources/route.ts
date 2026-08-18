import { json, route } from '@/server/http'
import { replayDir } from '@/server/paths'
import { listerSources } from '@/server/sources'

/**
 * `GET /api/sources` — les replays disponibles, et l'état du montage qui les
 * porte.
 *
 * **Un montage muet rend 200, pas 503.** L'écran doit distinguer « ce dossier
 * est vide » de « ce montage n'a pas eu lieu » : c'est l'incident réel
 * d'OpenShorts (spec §12), où les deux rendaient la même page. Un code d'erreur
 * les reconfondrait, et la seule phrase utile — « rouvrir le lecteur côté
 * Windows » — ne pourrait plus s'écrire.
 *
 * Ce qui reste une erreur de serveur, c'est `REPLAY_DIR` absent de
 * l'environnement : le dépôt n'est pas monté, personne n'y peut rien depuis
 * l'écran. `replayDir()` est donc appelé **pour lui-même et hors du corps**,
 * comme dans `POST /api/projects` : sous la garde de `listerSources`, cette
 * erreur de configuration se déguiserait en « montage indisponible » et on
 * chercherait un lecteur Windows là où il manque une ligne de `.env`.
 */
export const GET = route('GET /api/sources', async () => {
  replayDir()
  return json(await listerSources())
})
