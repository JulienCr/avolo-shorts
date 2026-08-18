'use client'

import { ChevronRight, Film, LoaderCircle, Plus } from 'lucide-react'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateSource, formatOctets } from '@/components/sources/textes'
import type { Source } from '@/lib/api'
import { lienProjet } from '@/lib/parcours'
import { cn } from '@/lib/utils'

/**
 * Une création de projet, vue par la grille.
 *
 * Le hook vit dans la page — c'est elle qui redirige, parce que ce qu'on fait
 * d'un 202 est une décision de parcours (`useCreerProjet` le dit déjà). Ce que
 * les cartes ont besoin de savoir tient en trois choses, et `enCours` porte le
 * **nom** de la source plutôt qu'un booléen : c'est ce qui permet à la carte
 * cliquée d'afficher l'attente et aux autres de se contenter de se taire.
 */
export type Creation = {
  /** Le nom de la source dont la création est en vol, ou `null`. */
  enCours: string | null
  /** Le message **du serveur**, jamais composé depuis une exception. */
  erreur: string | null
  lancer: (source: Source) => void
}

/**
 * La hauteur d'une carte, **écrite une fois**.
 *
 * Le squelette la reprend telle quelle : c'est ce qui fait que la grille ne
 * saute pas quand les cartes arrivent. Deux valeurs qui divergent produiraient
 * exactement le défaut que les squelettes existent pour éviter.
 */
export const HAUTEUR_CARTE = 'h-24'

/**
 * La carte d'un replay : **l'entrée du tunnel**.
 *
 * Nom, taille, date, et rien d'autre. **Pas de vignette dans ce lot** (issue
 * #41), et pour deux raisons dont aucune n'est le coût cumulé : la spec §12
 * prévoit un chargement **à la demande, au défilement**, adossé à un cache
 * local, donc les vingt et une extractions ne seraient jamais la latence d'une
 * page. Ce qui manque est ce dispositif-là — une route, sa clé de cache (nom,
 * taille, date de modification) et le déclenchement à l'entrée dans le champ —,
 * et il ne tient pas dans ce lot. (relevé par Copilot)
 *
 * La seconde raison est plus dérangeante et vaut d'être écrite ici : **les
 * replays de cette émission commencent tous sur le même plateau**. Une vignette
 * tirée d'un instant précoce serait donc identique d'une carte à l'autre, là où
 * le nom du fichier porte déjà la date et l'émission. Elle coûterait 2,7 s par
 * fichier — mesuré, `-ss` avant `-i` — pour ne rien distinguer.
 *
 * L'emplacement, lui, est dessiné. Une image qui arriverait plus tard remplirait
 * la case sans déplacer une ligne de texte — c'est la seule chose qui coûte cher
 * à ajouter après coup, et elle ne coûte rien maintenant.
 *
 * **Deux éléments pour deux gestes.** Une source neuve porte un bouton, qui
 * déclenche une écriture ; une source déjà analysée porte un lien, qui navigue.
 * Le bouton n'a pas de `href` à donner tant que le projet n'existe pas, et le
 * lien n'a rien à déclencher — les confondre en un seul élément demanderait de
 * choisir entre annoncer une navigation qui n'en est pas une et une commande qui
 * n'en est pas une.
 */
export function SourceCard({ source, creation }: { source: Source; creation: Creation }) {
  const enCreation = creation.enCours === source.name
  // **Toutes les cartes, pas seulement celle qu'on vient de cliquer.** Deux
  // créations en vol se disputeraient la redirection : on atterrirait sur celle
  // qui a répondu la dernière, sans que rien ne dise laquelle. Les liens vers un
  // projet existant, eux, restent ouverts — une navigation ne dispute rien, et
  // c'est le seul geste encore utile pendant l'attente.
  const bloquee = creation.enCours !== null

  // **Que des `span`, jamais un `div` ni un `p`.** Le modèle de contenu d'un
  // `button` n'admet que du contenu de phrase, et ce corps-ci sert aussi bien au
  // bouton d'une source neuve qu'au lien d'une source analysée. Les classes
  // Tailwind rendent la disposition, l'élément ne fait que porter le sens.
  const corps = (
    <>
      <EmplacementVignette />
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-3 py-2">
        <span className="truncate text-sm font-medium">{source.name}</span>
        <span className="truncate text-xs text-muted-foreground tabular-nums">
          {formatOctets(source.sizeBytes)} · {formatDateSource(source.modifiedAt)}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs font-medium">
          {source.projectId !== null ? (
            <>
              <Badge variant="secondary">Analysée</Badge>
              <span className="text-muted-foreground">Ouvrir le projet</span>
              <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
            </>
          ) : enCreation ? (
            <>
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              <span>Création…</span>
            </>
          ) : (
            <>
              <Plus className="size-3.5" aria-hidden />
              <span>Créer le projet</span>
            </>
          )}
        </span>
      </span>
    </>
  )

  const carte = cn(
    'flex w-full items-stretch overflow-hidden rounded-xl border bg-card text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
    HAUTEUR_CARTE,
  )

  if (source.projectId !== null) {
    return (
      <Link href={lienProjet(source.projectId)} className={cn(carte, 'hover:bg-muted')}>
        {corps}
      </Link>
    )
  }

  return (
    <button
      type="button"
      // **Deux mécanismes, et le partage est celui de la conception §4.4.**
      //
      // La carte qu'on vient de cliquer garde son `aria-disabled` : `disabled`
      // sort du parcours de tabulation, donc il prendrait le focus à celui qui
      // vient d'appuyer sur Entrée, et il faudrait retraverser la page pour
      // revenir à la carte en cas d'échec. Sa raison est écrite dessus —
      // « Création… » —, jamais dans une bulle d'aide.
      //
      // Les autres, elles, sortent bel et bien : personne n'a le focus dessus, et
      // « une création tourne ailleurs » ne vaut pas d'être découvert au clavier.
      disabled={bloquee && !enCreation}
      aria-disabled={enCreation || undefined}
      onClick={() => {
        if (bloquee) return
        creation.lancer(source)
      }}
      className={cn(
        carte,
        'hover:bg-muted disabled:pointer-events-none',
        enCreation ? 'ring-2 ring-ring/40' : 'disabled:opacity-55',
      )}
    >
      {corps}
    </button>
  )
}

/**
 * L'emplacement d'une vignette, vide.
 *
 * Il occupe la place exacte qu'une image de 16:9 occuperait, pour que l'issue
 * #41 se referme en remplaçant ce bloc et rien d'autre. Le pictogramme dit qu'il
 * s'agit d'une vidéo sans prétendre montrer laquelle : une case grise nue se
 * lirait comme une image qui n'a pas fini de charger, donc comme une attente
 * qui ne finira jamais.
 */
function EmplacementVignette() {
  return (
    <span
      data-slot="vignette"
      aria-hidden
      className="flex aspect-video h-full shrink-0 items-center justify-center border-r bg-muted/50 text-muted-foreground/40"
    >
      <Film className="size-5" />
    </span>
  )
}

/**
 * Le squelette d'une carte, **aux dimensions finales**.
 *
 * C'est tout son intérêt : une grille qui se remplit de cartes plus hautes que
 * ses squelettes fait sauter la page au moment où l'œil s'y pose.
 */
export function SourceCardSquelette() {
  return <Skeleton className={cn('w-full rounded-xl', HAUTEUR_CARTE)} />
}
