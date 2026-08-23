/**
 * L'appairage OAuth Meta (Facebook Login for Business) — à rejouer environ
 * une fois par an.
 *
 *     pnpm tsx scripts/dev-connect-meta.ts
 *     pnpm tsx scripts/dev-connect-meta.ts --code=<code renvoyé par Meta>
 *
 * Facebook Login, pas Instagram Login (`docs/lessons.md`). Le jeton de Page
 * n'expire pas : affiché ici pour 1Password (lecture seule) ; le jeton
 * Instagram tourne et se persiste dans `projects/meta-tokens.json`.
 */

import { requireSecret } from '@/server/secrets'
import { writeMetaTokens } from '@/server/publication/meta-tokens'
import { chargerEnv, quit } from './dev-common'

const GRAPH_VERSION = 'v23.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

/**
 * `instagram_basic`/`instagram_content_publish`, pas les `instagram_business_*`
 * qui les remplacent — **uniquement côté Instagram Login** ; ce script
 * appaire par Facebook Login, qui veut encore les noms dépréciés (mesuré,
 * `docs/lessons.md`). `business_management` suffit à créer le conteneur et à
 * téléverser ; la publication exige en plus un droit sur l'actif lui-même
 * (voir `MetaAssetPermissionError`).
 */
const SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'business_management',
].join(',')

function redirectUri(): string {
  return process.env.META_REDIRECT_URI ?? 'https://avolo.fr/meta/oauth-callback'
}

function authorizationUrl(appId: string): string {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri(),
    scope: SCOPES,
    response_type: 'code',
  })
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`
}

type GraphErrorBody = { error?: { message?: string } }

async function requireOk<T>(response: Response): Promise<T> {
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!response.ok) {
    const message = (parsed as GraphErrorBody | null)?.error?.message ?? text
    throw new Error(`Meta a répondu ${response.status} : ${message}`)
  }
  return parsed as T
}

async function exchangeCode(appId: string, appSecret: string, code: string): Promise<string> {
  const params = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: redirectUri(),
    code,
  })
  const response = await fetch(`${GRAPH_BASE}/oauth/access_token?${params.toString()}`)
  const body = await requireOk<{ access_token: string }>(response)
  return body.access_token
}

async function exchangeForLongLivedToken(appId: string, appSecret: string, shortLived: string): Promise<{ token: string; expiresIn: number }> {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLived,
  })
  const response = await fetch(`${GRAPH_BASE}/oauth/access_token?${params.toString()}`)
  const body = await requireOk<{ access_token: string; expires_in: number }>(response)
  return { token: body.access_token, expiresIn: body.expires_in }
}

type PageAccount = { id: string; name: string; access_token: string; instagram_business_account?: { id: string } }

async function findPageWithInstagram(userToken: string): Promise<PageAccount> {
  const params = new URLSearchParams({
    fields: 'id,name,access_token,instagram_business_account',
    access_token: userToken,
  })
  const response = await fetch(`${GRAPH_BASE}/me/accounts?${params.toString()}`)
  const body = await requireOk<{ data: PageAccount[] }>(response)
  const withInstagram = body.data.filter((page) => page.instagram_business_account !== undefined)
  if (withInstagram.length === 0) {
    throw new Error(
      `Aucune des ${body.data.length} Page(s) de ce compte ne porte de compte Instagram professionnel rattaché.`,
    )
  }
  // La sélection multi-compte est hors périmètre (spec) : rejeter le cas
  // ambigu plutôt que choisir arbitrairement la première — `/me/accounts` ne
  // classe pas ses résultats par pertinence pour @cie.avolo.
  if (withInstagram.length > 1) {
    throw new Error(
      `${withInstagram.length} Pages de ce compte portent un Instagram professionnel rattaché ` +
        `(${withInstagram.map((page) => page.name).join(', ')}) : sélection multi-compte hors périmètre, ` +
        'relancer avec un compte Meta qui ne gère que @cie.avolo.',
    )
  }
  return withInstagram[0]
}

async function main(): Promise<number> {
  await chargerEnv()

  const appId = requireSecret('META_APP_ID')
  const appSecret = requireSecret('META_APP_SECRET')
  const code = process.argv.slice(2).find((a) => a.startsWith('--code='))?.slice('--code='.length)

  if (code === undefined) {
    console.log('Ouvrir cette URL dans un navigateur connecté au compte Meta qui gère @cie.avolo :\n')
    console.log(authorizationUrl(appId))
    console.log(
      `\nMeta redirige ensuite vers ${redirectUri()}?code=... : recopier ce code dans` +
        ' pnpm tsx scripts/dev-connect-meta.ts --code=<code>',
    )
    return 0
  }

  const shortLived = await exchangeCode(appId, appSecret, code)
  const { token: userToken, expiresIn } = await exchangeForLongLivedToken(appId, appSecret, shortLived)
  const page = await findPageWithInstagram(userToken)
  const instagramUserId = page.instagram_business_account?.id
  if (instagramUserId === undefined) {
    throw new Error(`La Page ${page.name} n'a plus de compte Instagram rattaché depuis l'appel précédent.`)
  }

  await writeMetaTokens({
    instagramUserId,
    instagramAccessToken: userToken,
    instagramTokenExpiresAt: Date.now() + expiresIn * 1000,
  })

  console.log(`Instagram : compte ${instagramUserId}, jeton persisté dans projects/meta-tokens.json (${Math.round(expiresIn / 86_400)} j).`)
  console.log(`Facebook  : Page « ${page.name} » (${page.id}).`)
  console.log('\nÀ coller à la main, une fois pour toutes — ces valeurs ne rafraîchissent jamais :')
  console.log(`  META_PAGE_ID=${page.id}`)
  console.log(`  META_PAGE_TOKEN=${page.access_token}`)
  console.log('Le premier va dans .env, le second dans 1Password (op:// dans .env, la valeur dans le coffre).')
  return 0
}

main()
  .then((code) => quit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    quit(1)
  })
