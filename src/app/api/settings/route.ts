import { z } from 'zod'

import { applySettings, effectiveSettings, getDb } from '@/server/db'
import { body, json, route } from '@/server/http'

/**
 * `GET` et `PUT /api/settings` — les réglages effectifs, et leur modification.
 *
 * **Ce que la route ne fait pas est ce qui compte le plus.** Changer un réglage
 * ne recalcule rien : les émissions déjà analysées gardent leurs propositions,
 * et un recalcul reste une action explicite — `POST /api/projects/:id/run`
 * (retour d'usage §6.1 et §11). Une route de réglages qui invaliderait des
 * artefacts ferait perdre une heure de GPU à qui vient corriger une faute de
 * frappe dans un libellé.
 *
 * **La validation vit dans le registre, pas ici.** `src/server/db.ts` décrit
 * chaque champ — famille, type, plancher, défaut — et `applySettings`
 * en déduit ce qu'il accepte. Écrire un schéma Zod par famille aurait recréé
 * exactement la seconde source de vérité que le registre existe pour éviter :
 * les familles à venir — le fournisseur d'IA par usage, les défauts du hook —
 * porteront des chaînes et des booléens, et chacune aurait réinventé ses bornes.
 *
 * D'où `z.unknown()` : ce que `body` garantit ici est que le corps est du JSON
 * lisible, rien de plus. Une clé inconnue et une valeur hors bornes ressortent
 * en 400 par `InvalidSettingError`, avec un message qui nomme la clé.
 */
// Aucun paramètre : `route` est générique sur ses arguments, et un
// `_request` déclaré serait le seul argument de la fonction — donc signalé
// comme inutilisé, contrairement à celui des routes qui lisent leur contexte
// derrière lui (`no-unused-vars` ne rapporte qu'après le dernier argument
// utilisé).
export const GET = route('GET /api/settings', async () => json(effectiveSettings(getDb())))

export const PUT = route('PUT /api/settings', async (request: Request) => {
  // **Un corps vide vaut `{}`**, donc un `PUT` nu ne change rien et rend l'état
  // courant. C'est le comportement qu'on veut d'un formulaire qui se soumet
  // sans qu'aucun champ n'ait bougé, et `body` le porte déjà pour l'export.
  const patch = await body(request, z.unknown())
  // Les réglages **résultants**, pas le patch : l'écran affiche ce qui
  // s'applique vraiment, y compris les champs que le patch n'a pas touchés.
  return json(applySettings(getDb(), patch))
})
