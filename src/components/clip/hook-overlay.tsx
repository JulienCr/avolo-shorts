import { hookIsBurned, hookLayout, hookRgba, type ResolvedHook } from '@/core/hook'
import { hookFont } from '@/components/clip/hook-font'

/**
 * Le calque de preview du hook, dans l'aperçu 9:16 (`output-preview.tsx`).
 *
 * **Un calque DOM, frère du `<canvas>`, jamais peint dedans.** Le `<canvas>`
 * ne porte que l'image vidéo cadrée — il occupe `part * 100 %` de la boîte,
 * la part que le ratio choisi laisse au contenu — alors que le hook s'incruste
 * sur le 9:16 **complet**, bandes floutées comprises. Peindre le hook dans le
 * canvas l'enfermerait dans la bande centrale et le ferait sauter de place à
 * chaque changement de ratio, ce que ce calque évite en couvrant toute la
 * boîte, indépendamment du canvas qu'il recouvre.
 *
 * **Les unités sont `cqw`/`cqh`, jamais des pixels — et depuis le 20 août
 * 2026, presque toujours `cqw`.** `hookLayout` (`@/core/hook`) rend
 * désormais des fractions de la **largeur** du canevas, pas de `PlayResX`
 * ni de `PlayResY` : la boîte 9:16 qui porte ce calque a `containerType:
 * 'size'` posé par `output-preview.tsx`, et sa largeur `cqw` correspond
 * exactement à la largeur du canevas que le rasteriseur PNG utilise
 * (`src/server/hook-image.ts`) — 1080 dans les deux cas pour toute sortie
 * qui n'est pas le natif 16:9. `cqh` couvre toute la hauteur de la boîte
 * (`inset-0`), **et porte aussi la marge basse** : `marginYFraction` est
 * une fraction de la hauteur, pas de la largeur, quand `position` vaut
 * `bottom` — la seule fraction de `hookLayout` dans ce cas, voir la doc de
 * `HOOK_MARGIN_BOTTOM_FRACTION` dans `@/core/hook`.
 *
 * **`data-hook="card"` et `data-hook="badge"` sont là pour les tests**, et
 * c'est leur seule fonction — aucun style ne s'y accroche. Depuis que le
 * calque porte deux boîtes, un `querySelector('span')` attrape le conteneur
 * du composite plutôt que celle qu'on visait : nommer les deux vaut mieux que
 * de faire dépendre une assertion de l'ordre du DOM.
 *
 * **Toutes les valeurs viennent de `hookLayout(hook)`** — la même fonction
 * que le rasteriseur PNG du rendu consomme pour poser le hook dans le
 * fichier réellement encodé. C'est la garantie de cette preview : pas une
 * géométrie parallèle qui lui ressemblerait, la même.
 *
 * **Ce que ce calque ne peut pas promettre.** Il est exact sur la position, le
 * fond, les couleurs, l'arrondi et la taille de police : ce sont des nombres,
 * traduits sans approximation, et la même fraction de largeur que le
 * rasteriseur. Il reste **approché sur la largeur exacte de la boîte** : le
 * rasteriseur mesure le texte avec les vraies métriques d'Anton
 * (`measureText`) pour que la boîte épouse le mot au pixel, alors que ce
 * calque laisse le navigateur composer sa propre boîte autour d'un `<span>`
 * en `inline-block` — la même police, mais un moteur de mise en page
 * différent. L'écart est sous le pixel visible sur un hook d'un mot ; il peut
 * se voir de quelques pixels sur un hook qui revient à la ligne, où les deux
 * moteurs ne coupent pas forcément au même endroit. Ce n'est pas un défaut de
 * ce calque, c'est une limite qu'il faut connaître avant de traiter le
 * moindre écart de largeur comme un bug. **Depuis le badge (20 août 2026),
 * l'approximation porte sur la largeur du COMPOSITE** — le plus large des deux
 * boîtes —, donc sur deux mesures plutôt qu'une. La HAUTEUR de la pastille,
 * elle, est exacte : `badgeHeightFraction` la calcule au lieu de la mesurer,
 * précisément pour que les deux camps posent le même nombre.
 */

/** `u`, une fraction (0 à 1) de la largeur du conteneur, en `cqw`. */
function cqw(fraction: number): string {
  return `calc(${fraction * 100}cqw)`
}

/**
 * `u`, une fraction (0 à 1) de la hauteur du conteneur, en `cqh` — pour la
 * seule fraction de `hookLayout` qui suit la hauteur plutôt que la
 * largeur : `marginYFraction` en position `bottom`. Voir la doc de
 * `HOOK_MARGIN_BOTTOM_FRACTION` dans `@/core/hook`.
 */
function cqh(fraction: number): string {
  return `calc(${fraction * 100}cqh)`
}

export function HookOverlay({ hook }: { hook: ResolvedHook }) {
  // Rien à incruster : le hook est désactivé, ou son texte est vide — l'état
  // initial de tout clip nouvellement gardé, avant que le repérage ou une
  // saisie manuelle ne pose `hookText`. Un badge seul ne s'affiche pas plus
  // ici qu'il ne s'incruste : voir la doc de `hookIsBurned`.
  if (!hookIsBurned(hook)) return null

  const layout = hookLayout(hook)
  const text = hook.uppercase ? hook.text.toUpperCase() : hook.text
  const rawBadge = hook.badge.trim()
  const badge = hook.uppercase ? rawBadge.toUpperCase() : rawBadge

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex flex-col"
      style={{
        justifyContent:
          hook.position === 'top' ? 'flex-start' : hook.position === 'bottom' ? 'flex-end' : 'center',
      }}
    >
      <div
        style={{
          width: '100%',
          textAlign: hook.alignment,
          paddingLeft: cqw(layout.marginXFraction),
          paddingRight: cqw(layout.marginXFraction),
          paddingTop: hook.position === 'top' ? cqw(layout.marginYFraction) : undefined,
          paddingBottom: hook.position === 'bottom' ? cqh(layout.marginYFraction) : undefined,
        }}
      >
        {/* **Le composite, décalque de celui du PNG.** Une colonne `inline-flex`
            fait épouser chaque enfant à son propre contenu et le conteneur au
            plus large des deux — exactement `max(cardWidth, badgeSpan)` du
            rasteriseur (`src/server/hook-image.ts`) —, et `align-items` traduit
            `alignment` sur la même arête que `cardX`/`badgeX` y font. Aucune
            position absolue : elle re-dériverait une géométrie que ce fichier
            existe précisément pour ne pas recalculer. */}
        <span
          style={{
            display: 'inline-flex',
            flexDirection: 'column',
            alignItems:
              hook.alignment === 'left'
                ? 'flex-start'
                : hook.alignment === 'right'
                  ? 'flex-end'
                  : 'center',
          }}
        >
          {badge !== '' && (
            <span
              data-hook="badge"
              className={hookFont.className}
              style={{
                display: 'inline-flex',
                // Décalque de `ctx.textBaseline = 'middle'` : le texte est
                // centré sur la hauteur de la pastille, qui est imposée par
                // `badgeHeightFraction` et non déduite de la ligne.
                alignItems: 'center',
                boxSizing: 'content-box',
                height: cqw(layout.badgeHeightFraction),
                paddingLeft: cqw(layout.badgePaddingXFraction),
                paddingRight: cqw(layout.badgePaddingXFraction),
                fontSize: cqw(layout.badgeFontSizeFraction),
                color: hook.badgeColor,
                // **Nu, jamais `hookRgba`** : `backgroundOpacity` est le
                // réglage du carton, et le rasteriseur fait pareil.
                backgroundColor: hook.badgeBackground,
                borderRadius: cqw(layout.badgeRadiusFraction),
                // Le retrait aligne la première lettre de la pastille sur
                // celle du carton, pas les deux bords de boîte — les deux
                // rembourrages diffèrent. `center` n'a pas de bord de départ,
                // donc pas de retrait, comme dans le rasteriseur.
                marginLeft:
                  hook.alignment === 'left' ? cqw(layout.badgeInsetFraction) : undefined,
                marginRight:
                  hook.alignment === 'right' ? cqw(layout.badgeInsetFraction) : undefined,
                // Le chevauchement. Posé en marge NÉGATIVE SOUS la pastille
                // plutôt qu'au-dessus du carton : sans badge, il n'y a rien à
                // défaire.
                marginBottom: cqw(-layout.badgeOverlapFraction),
                // **`zIndex`, et il est indispensable.** Les deux moteurs
                // empilent à l'envers l'un de l'autre : dans le canevas, le
                // dernier peint gagne — donc la pastille, peinte après le
                // carton ; dans le DOM, c'est le frère SUIVANT qui recouvre —
                // donc le carton, qui vient après. Sans ce `zIndex`, cette
                // preview montrerait l'inverse exact du fichier rendu, et rien
                // ne le signalerait.
                position: 'relative',
                zIndex: 1,
                // Le rasteriseur ne fait jamais revenir la pastille à la
                // ligne ; le navigateur le ferait. Même classe de défaut que
                // le `pre-wrap` corrigé sur la PR #117, passe 4.
                whiteSpace: 'nowrap',
              }}
            >
              {badge}
            </span>
          )}
          <span
            data-hook="card"
            className={hookFont.className}
            style={{
              display: 'inline-block',
              // Le contenu, pas la boîte : `max-width` porte sur le texte en
              // `box-sizing: content-box`, donc il faut lui retirer le
              // rembourrage des deux côtés pour viser la même largeur maximale
              // de boîte que `maxTextWidthPx` dans le rasteriseur PNG
              // (`src/server/hook-image.ts`). **`content-box` n'est plus le
              // défaut ici** : le preflight Tailwind de `globals.css` pose
              // `box-sizing: border-box` globalement, sous quoi `max-width`
              // inclurait déjà le rembourrage — le soustraire une seconde fois
              // réduirait la largeur utile en double. Posé explicitement pour
              // annuler le preflight sur ce seul span (relevé par Copilot,
              // PR #117, passe 4).
              boxSizing: 'content-box',
              maxWidth: cqw(layout.maxBoxWidthFraction - 2 * layout.paddingXFraction),
              fontSize: cqw(layout.fontSizeFraction),
              lineHeight: cqw(layout.lineHeightFraction),
              color: hook.textColor,
              backgroundColor: hookRgba(hook.backgroundColor, hook.backgroundOpacity),
              borderRadius: cqw(layout.radiusFraction),
              paddingLeft: cqw(layout.paddingXFraction),
              paddingRight: cqw(layout.paddingXFraction),
              paddingTop: cqw(layout.paddingYFraction),
              paddingBottom: cqw(layout.paddingYFraction),
              // `normal`, pas `pre-wrap` : `wrapLines` (`src/server/hook-image.ts`)
              // coupe sur `' '` et filtre les chaînes vides, donc des espaces
              // répétés dans un `hookText` saisi à la main se réduisent à un
              // seul dans le PNG. `pre-wrap` les aurait conservés tels quels
              // dans cette preview, désaccordant sa largeur de boîte de celle
              // du rendu réel (relevé par Copilot, PR #117, passe 4).
              whiteSpace: 'normal',
            }}
          >
            {text}
          </span>
        </span>
      </div>
    </div>
  )
}
