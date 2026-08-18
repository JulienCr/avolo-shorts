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
 * conséquence vise l'appelant : les identifiants doivent être uniques *à travers*
 * les passes, jamais renumérotés depuis 1 à chaque lot. Un `clip_01` régénéré à
 * la passe 2 hériterait du refus prononcé sur le `clip_01` de la passe 1, sans
 * erreur et sans trace. Les faire dériver du numéro de passe suffit.
 *
 * La fonction ne modifie ni `existing` ni `incoming`.
 */
export function mergeCandidates(existing: Clip[], incoming: Clip[], pass: number): Clip[] {
  // Les décisions humaines, dans leur ordre d'origine. Ce qui reste de
  // `existing` — les `candidate` — est ce que ce lot vient remplacer.
  const humains = existing.filter((clip) => clip.status !== 'candidate')

  // Les `id` déjà pris. L'ensemble grandit au fil des propositions retenues : il
  // écarte du même geste les collisions avec un clip humain et les doublons
  // internes au lot, qui feraient sinon échouer l'écriture en base sur la clé
  // primaire.
  const pris = new Set(humains.map((clip) => clip.id))

  const nouveaux: Clip[] = []
  for (const clip of incoming) {
    if (pris.has(clip.id)) continue
    pris.add(clip.id)
    // Le numéro de passe vient du lot, pas du clip : le producteur n'a pas à le
    // connaître, et un lot ne peut pas se tromper de passe à moitié.
    nouveaux.push({ ...clip, pass })
  }

  return [...humains, ...nouveaux]
}
