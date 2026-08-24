import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { authorizationUrl, createPkcePair } from '@/server/publication/tiktok-pkce'

describe('createPkcePair', () => {
  /**
   * TikTok s'écarte de la RFC 7636 : le challenge est le SHA256 du vérifieur
   * encodé en **hex**, pas en base64url. Une régression vers base64url passe
   * l'autorisation (dont la forme n'est pas vérifiée) et casse l'échange —
   * ce test doit rougir dans ce cas précis. La règle est documentée sur
   * `createPkcePair` (login-kit-desktop) ; elle est répétée ici pour que
   * changer cette assertion sans la lire reste visible.
   */
  it('rend un challenge qui est le SHA256 hex du vérifieur, pas un hasard indépendant', () => {
    const { verifier, challenge } = createPkcePair()
    const expected = createHash('sha256').update(verifier).digest('hex')
    expect(challenge).toBe(expected)
  })

  it('rend un vérifieur différent à chaque appel', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier)
  })
})

describe('authorizationUrl', () => {
  /**
   * Critère d'acceptation : sans `code_challenge`/`code_challenge_method`,
   * TikTok rend `error=param_error&errCode=10007&error_type=code_challenge`
   * (mesuré le 24 août 2026, spec §2.3) — ce test rougit si PKCE disparaît.
   */
  it('porte code_challenge et code_challenge_method=S256', () => {
    const url = new URL(
      authorizationUrl({
        clientKey: 'ck',
        redirectUri: 'http://127.0.0.1:4005/tiktok/oauth-callback/',
        scope: 'video.upload',
        state: 'state1',
        challenge: 'chal1',
      }),
    )
    expect(url.searchParams.get('code_challenge')).toBe('chal1')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('accepte la boucle locale sans encoder ni rejeter le redirect_uri', () => {
    const url = new URL(
      authorizationUrl({
        clientKey: 'ck',
        redirectUri: 'http://127.0.0.1:4005/tiktok/oauth-callback/',
        scope: 'video.upload',
        state: 'state1',
        challenge: 'chal1',
      }),
    )
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4005/tiktok/oauth-callback/')
  })
})
