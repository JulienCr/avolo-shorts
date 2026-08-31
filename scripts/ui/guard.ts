/**
 * Les deux gardes de `ui-shot.ts` qui n'ont pas besoin du réseau pour se
 * tester : la décision « ce port sert-il bien ce dépôt » (garantie 3 du
 * contrat) et la réécriture `127.0.0.1` → `localhost` (garantie 4). Le
 * reste — trouver le PID à l'écoute, lire `/proc/<pid>/cwd` — est de l'I/O
 * et vit dans `ui-shot.ts`.
 */

import path from 'node:path'

export type PortGuardDecision = { readonly ok: true } | { readonly ok: false; readonly message: string }

/**
 * @param procCwd Le `cwd` du process qui écoute le port (`/proc/<pid>/cwd`).
 * @param repoRoot La racine du dépôt courant.
 * @param force Ignore le désaccord — passé par `--force`.
 * @returns `ok: false` avec un message nommant `procCwd` quand les deux
 *   chemins résolus diffèrent et que `force` ne vaut pas `true`.
 */
export function decidePortGuard(o: { procCwd: string; repoRoot: string; force: boolean }): PortGuardDecision {
  if (o.force) return { ok: true }
  if (path.resolve(o.procCwd) === path.resolve(o.repoRoot)) return { ok: true }
  return {
    ok: false,
    message:
      `le serveur qui répond sur ce port tourne depuis "${o.procCwd}", pas depuis ce dépôt ` +
      `("${o.repoRoot}") — relancer avec --force pour l'ignorer.`,
  }
}

export type UrlRewrite = { readonly url: string; readonly rewritten: boolean }

/** `127.0.0.1` → `localhost` : le serveur de dev rend 403 sur l'adresse littérale. */
export function resolveHostUrl(rawUrl: string): UrlRewrite {
  const u = new URL(rawUrl)
  if (u.hostname !== '127.0.0.1') return { url: rawUrl, rewritten: false }
  u.hostname = 'localhost'
  return { url: u.toString(), rewritten: true }
}
