/**
 * Le rendu natif est **désactivé** : seule la variante 9:16 sur fond flouté
 * sert à quelque chose en pratique — Instagram, TikTok, YouTube Shorts la
 * publient tous. Le rendu natif continuait de coûter un encodage complet par
 * clip pour un fichier que personne ne récupérait.
 *
 * **Un clip déjà en 9:16 continue de le produire** : il n'a pas de variante
 * séparée (`pathsRender`), donc son natif EST le livrable, pas un doublon
 * inutile.
 *
 * Un simple bool, pour rester réversible sans détricoter quoi que ce soit :
 * remettre `true` restaure le comportement d'avant à l'identique.
 */
export const RENDER_NATIVE = false
