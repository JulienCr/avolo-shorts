/**
 * L'appairage TikTok — OAuth avec PKCE, ou jetons collés une fois pour toutes.
 *
 *     pnpm tsx scripts/dev-connect-tiktok.ts
 *     pnpm tsx scripts/dev-connect-tiktok.ts --code=<code renvoyé par TikTok> --state=<state renvoyé par TikTok>
 *     TIKTOK_ACCESS_TOKEN=<jeton> TIKTOK_REFRESH_TOKEN=<jeton> TIKTOK_OPEN_ID=<id> \
 *       pnpm tsx scripts/dev-connect-tiktok.ts
 *
 * Les jetons ci-dessus passent par l'environnement, jamais par `argv`
 * (`/proc/<pid>/cmdline`) — même règle que `META_SYSTEM_USER_TOKEN`
 * (`dev-connect-meta.ts`). Boucle locale et PKCE : `tiktok-pkce.ts`, §2.3.
 */

import { randomUUID } from 'node:crypto'

import { authorizationUrl, createPkcePair } from '@/server/publication/tiktok-pkce'
import {
  claimPendingPkce,
  exchangeTikTokCode,
  pairAndPersistTikTok,
  persistPkce,
  tiktokRedirectUri,
  type ExchangedTokens,
} from '@/server/publication/tiktok-oauth'
import { requireSecret } from '@/server/secrets'
import { chargerEnv, quit } from './dev-common'

/**
 * `user.info.basic` sert uniquement à `availability()` (`tiktok.ts`) pour
 * confirmer qu'un jeton persisté fonctionne encore, sans dépôt réel — au-delà
 * de `video.upload`, seule portée nommée par la spec §2.3.
 */
const SCOPES = 'user.info.basic,video.upload'

async function pairAndPersist(tokens: ExchangedTokens): Promise<void> {
  await pairAndPersistTikTok(tokens)
  console.log(`Compte ${tokens.openId}, jeton persisté dans projects/tiktok-tokens.json.`)
  console.log(
    `  Accès : ${Math.round(tokens.expiresIn / 3600)} h. Rafraîchissement : ${Math.round(tokens.refreshExpiresIn / 86_400)} j.`,
  )
}

function flag(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length)
}

/** Refuse une durée non finie ou non positive plutôt que de persister un jeton corrompu (`NaN` → `null` en JSON). */
function positiveDuration(envName: string, fallback: number): number {
  const raw = process.env[envName]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${envName} vaut « ${raw} », ce n'est pas une durée en secondes valide.`)
  }
  return value
}

async function main(): Promise<number> {
  await chargerEnv()

  const pastedAccessToken = process.env.TIKTOK_ACCESS_TOKEN
  const pastedRefreshToken = process.env.TIKTOK_REFRESH_TOKEN
  if (pastedAccessToken !== undefined && pastedAccessToken !== '') {
    if (pastedRefreshToken === undefined || pastedRefreshToken === '') {
      throw new Error('TIKTOK_ACCESS_TOKEN est posé sans TIKTOK_REFRESH_TOKEN : les deux sont requis.')
    }
    const openId = process.env.TIKTOK_OPEN_ID ?? ''
    const expiresIn = positiveDuration('TIKTOK_EXPIRES_IN_SECONDS', 86_400)
    const refreshExpiresIn = positiveDuration('TIKTOK_REFRESH_EXPIRES_IN_SECONDS', 31_536_000)
    await pairAndPersist({
      openId,
      accessToken: pastedAccessToken,
      refreshToken: pastedRefreshToken,
      expiresIn,
      refreshExpiresIn,
    })
    return 0
  }

  const clientKey = requireSecret('TIKTOK_CLIENT_KEY')
  const clientSecret = requireSecret('TIKTOK_CLIENT_SECRET')
  const code = flag('code')

  if (code === undefined) {
    const { verifier, challenge } = createPkcePair()
    const state = randomUUID()
    await persistPkce(verifier, state)
    console.log('Ouvrir cette URL dans un navigateur connecté au compte TikTok qui gère @cie.avolo :\n')
    console.log(authorizationUrl({ clientKey, redirectUri: tiktokRedirectUri(), scope: SCOPES, state, challenge }))
    console.log(
      `\nTikTok redirige automatiquement vers ${tiktokRedirectUri()}, qui termine le pairage — ou, à défaut,` +
        ` recopier code et state dans pnpm tsx scripts/dev-connect-tiktok.ts --code=<code> --state=<state>.`,
    )
    return 0
  }

  const state = flag('state')
  if (state === undefined) {
    throw new Error(
      '--state=<state> est requis avec --code : sans lui, un second lancement en attente écraserait' +
        ' silencieusement le vérifieur de celui-ci en recopiant un code périmé.',
    )
  }
  const claim = await claimPendingPkce(state)
  if (!claim.ok) {
    throw new Error(
      claim.reason === 'none'
        ? 'Aucun vérifieur PKCE en attente. Relancer pnpm tsx scripts/dev-connect-tiktok.ts sans --code pour en obtenir un.'
        : 'Le state fourni ne correspond pas au pairage en attente : relancer sans --code pour en ouvrir un nouveau.',
    )
  }

  const { verifier } = claim
  const tokens = await exchangeTikTokCode(clientKey, clientSecret, code, verifier)
  await pairAndPersist(tokens)
  return 0
}

main()
  .then((code) => quit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    quit(1)
  })
