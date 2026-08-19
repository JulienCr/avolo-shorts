import type { Clip } from '@/core/edl'

/**
 * La fusion des passes de repérage — « une nouvelle passe n'écrase jamais un
 * travail humain » (spec §5).
 *
 * Relancer le repérage doit rester bon marché *pour l'utilisateur*, pas
 * seulement pour la machine : si une deuxième passe balayait les clips déjà
 * montés, personne ne la lancerait, et le tri de 25 candidats serait à refaire.
 */

/**
 * Fusionne un nouveau lot de propositions avec l'état existant.
 *
 * Trois règles, et elles se réduisent à une seule frontière — celle entre ce que
 * la machine propose et ce dont un humain a déjà décidé :
 *
 * - un clip dont le statut n'est plus `candidate` est **humain** (gardé, écarté
 *   ou déjà exporté) et survit toujours, tel quel, numéro de passe compris ;
 * - les propositions non encore traitées sont remplacées — elles ne portent
 *   aucune décision, les garder ne ferait qu'empiler des doublons ;
 * - chaque lot porte son numéro de passe, ce qui distingue à l'écran les
 *   nouvelles propositions des anciennes.
 *
 * **Un clip écarté à la main ne revient jamais.** C'est le cas qui fait le plus
 * de dégât s'il est raté : le repérage reproposerait à chaque passe exactement
 * ce qu'on vient de refuser. Une proposition entrante qui porte l'`id` d'un clip
 * humain est donc jetée, et l'humain conservé.
 *
 * **L'`id` est ce qui identifie un clip d'une passe à l'autre**, et la
 * conséquence vise le producteur : il doit le dériver de *ce que le clip
 * désigne* — projet et bornes calées sur les mots — et surtout pas du numéro de
 * passe ni d'un compteur reparti de 1. Un `clip_01` renuméroté à chaque lot rend
 * la garantie ci-dessus inopérante dans un sens comme dans l'autre : la même
 * proposition écartée revient sous un nouvel `id`, et une proposition sans
 * rapport hérite du refus prononcé sur le `clip_01` de la passe précédente.
 * Un identifiant dérivé du contenu règle les deux d'un coup, et donne du même
 * geste l'unicité entre projets que la base attend (`src/server/db.ts`).
 *
 * La reconnaissance est donc **exacte, pas approchée** : une proposition qui
 * recouvre largement un clip écarté sans tomber sur les mêmes bornes est un
 * clip différent, et elle passe. Rapprocher deux bornes voisines demande un
 * seuil que personne n'a arrêté ; c'est une question de qualité du repérage,
 * donc l'itération 3.
 *
 * La fonction ne modifie ni `existing` ni `incoming`.
 *
 * @throws si une proposition entrante porte déjà un statut humain — elle
 * franchirait la frontière que toute la fonction sert à tenir, et serait
 * conservée pour toujours sans que personne n'ait rien décidé.
 */
export function mergeCandidates(existing: Clip[], incoming: Clip[], pass: number): Clip[] {
  // Les décisions humaines, dans leur ordre d'origine. Ce qui reste de
  // `existing` — les `candidate` — est ce que ce lot vient remplacer.
  const humans = existing.filter((clip) => clip.status !== 'candidate')

  // Les `id` déjà pris. L'ensemble grandit au fil des propositions retenues : il
  // écarte du même geste les collisions avec un clip humain et les doublons
  // internes au lot, qui feraient sinon échouer l'écriture en base sur la clé
  // primaire.
  const taken = new Set(humans.map((clip) => clip.id))

  const freshClips: Clip[] = []
  for (const clip of incoming) {
    if (clip.status !== 'candidate') {
      throw new Error(
        `Le clip ${clip.id} entre avec le statut « ${clip.status} » : un lot de repérage ne propose que des candidats.`,
      )
    }
    if (taken.has(clip.id)) continue
    taken.add(clip.id)
    // Le numéro de passe vient du lot, pas du clip : le producteur n'a pas à le
    // connaître, et un lot ne peut pas se tromper de passe à moitié.
    freshClips.push({ ...clip, pass })
  }

  return [...humans, ...freshClips]
}
