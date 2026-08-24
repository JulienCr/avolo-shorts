import { completeTikTokCallback } from '@/server/publication/tiktok-oauth'
import { requireSecret } from '@/server/secrets'

/**
 * La route de retour OAuth TikTok. Remplace le copier-coller du code depuis
 * `localhost:4005` mort — les codes TikTok sont de courte durée, et chaque
 * seconde passée à les recopier en coûte une partie.
 */
export default async function TikTokOAuthCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const one = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value

  let result: Awaited<ReturnType<typeof completeTikTokCallback>>
  try {
    result = await completeTikTokCallback({
      code: one(params.code),
      state: one(params.state),
      tiktokError: one(params.error_description) ?? one(params.error),
      clientKey: requireSecret('TIKTOK_CLIENT_KEY'),
      clientSecret: requireSecret('TIKTOK_CLIENT_SECRET'),
    })
  } catch (error) {
    result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-lg flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      {result.ok ? (
        <>
          <h1 className="text-lg font-medium">Compte TikTok connecté</h1>
          <p className="text-sm text-muted-foreground">
            Pairage terminé pour le compte {result.openId}. Cette page peut être fermée.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-lg font-medium">Le pairage TikTok a échoué</h1>
          <p className="text-sm text-muted-foreground">{result.reason}</p>
        </>
      )}
    </main>
  )
}
