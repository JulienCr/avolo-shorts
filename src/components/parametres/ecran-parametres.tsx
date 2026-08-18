'use client'

import { Check, LoaderCircle, TriangleAlert } from 'lucide-react'

import { AppBar } from '@/components/parcours/app-bar'
import { SectionHook } from '@/components/parametres/hook'
import { SectionRepérage } from '@/components/parametres/reperage'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { useRéglages, useÉcrireRéglages } from '@/lib/queries'

/**
 * L'écran des paramètres.
 *
 * **Ce qu'il existe pour éviter** : que des choix structurants continuent à
 * vivre dans `.env` ou en constantes alors qu'ils sont devenus des réglages
 * produit. Cinq d'entre eux sont réglables depuis la PR #64 et n'avaient aucune
 * surface ; ils en ont une.
 *
 * **Un frère de la bibliothèque, pas un quatrième étage.** Les réglages ne
 * décrivent aucune émission : ils se rejoignent depuis n'importe où par la barre
 * d'application, et se quittent par le haut. La profondeur du parcours reste à
 * trois.
 *
 * **Il ne recalcule rien.** Changer un réglage n'invalide aucune émission
 * analysée : un recalcul est une action explicite, depuis l'écran de l'émission.
 * `useÉcrireRéglages` n'invalide d'ailleurs que le cache des réglages, et c'est
 * la règle qui compte.
 *
 * **Il vit ici et non dans le fichier de route**, comme les trois autres écrans.
 * La règle vient d'ailleurs — `use(params)` ne se résout pas sous jsdom — mais
 * une règle qui souffre une exception n'en est plus une, et c'est ce qui rend
 * l'écran montable en test.
 */
export function EcranParametres() {
  const réglages = useRéglages()
  const écrire = useÉcrireRéglages()

  return (
    <div className="flex min-h-full flex-col">
      <AppBar lieu={{ kind: 'parametres' }}>
        <ÉtatDÉcriture
          enVol={écrire.isPending}
          écrit={écrire.isSuccess}
          échoué={écrire.isError}
        />
      </AppBar>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-6">
        <h1 className="text-lg font-semibold tracking-tight">Paramètres</h1>

        {/* **Une écriture refusée se dit, et elle se dit avec le message du
            serveur.** Une valeur hors bornes rend un 400 : sans ce mot, le champ
            reviendrait tout seul à sa valeur d'avant — `useÉcrireRéglages`
            n'écrit pas en optimiste — et on croirait à un écran qui ne réagit
            pas. */}
        {écrire.isError && (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertTitle>Le réglage n’a pas été enregistré.</AlertTitle>
            <AlertDescription>{écrire.error.message}</AlertDescription>
          </Alert>
        )}

        {réglages.isError ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertTitle>Les réglages ne se chargent pas.</AlertTitle>
            <AlertDescription>{réglages.error.message}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void réglages.refetch()}>
                Réessayer
              </Button>
            </AlertAction>
          </Alert>
        ) : réglages.data === undefined ? (
          // **Pas de valeurs par défaut en attendant.** Les afficher ferait voir
          // les constantes du code là où la base porte peut-être autre chose, et
          // le premier geste écrirait alors une valeur que personne n'a choisie.
          <div className="flex flex-col gap-3">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-xl" />
            ))}
          </div>
        ) : (
          <SectionRepérage
            valeurs={réglages.data.selection}
            désactivé={écrire.isPending}
            onChanger={(patch) => écrire.mutate({ selection: patch })}
          />
        )}

        <Separator />

        <SectionHook />
      </main>
    </div>
  )
}

/**
 * L'état de la dernière écriture, dans la barre d'application.
 *
 * **Trois états et pas quatre** : rien tant qu'on n'a rien écrit, « enregistré »
 * après, et l'échec qui a par ailleurs son bandeau. C'est l'emplacement que la
 * barre réserve à chaque écran pour ce qu'il a à dire de son travail en cours —
 * l'écran de projet y met son avancement, celui de clip son enregistrement.
 */
function ÉtatDÉcriture({
  enVol,
  écrit,
  échoué,
}: {
  enVol: boolean
  écrit: boolean
  échoué: boolean
}) {
  if (enVol) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        Enregistrement…
      </span>
    )
  }
  if (échoué || !écrit) return null
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Check className="size-3.5" aria-hidden />
      Enregistré
    </span>
  )
}
