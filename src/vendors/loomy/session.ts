/**
 * The parts of a Loomy account that outlive one hook call.
 *
 * The host hands every hook the account's stored sign-in (`getAuth()`), and
 * writes one back with `client.auth.set`, which **replaces** the body rather
 * than merging it. So every write here starts from what the host gave and
 * only adds to it — dropping `access` or `expires` while "remembering" a
 * quota would sign the account out. `core/stored.ts` reads the session back
 * and says why an API-shaped sign-in keeps its extra fields elsewhere.
 */

import { SignInExpiredError } from "../../core/errors.ts"
import { num, str } from "../../core/json.ts"
import { storedField, storedSession } from "../../core/stored.ts"
import type { PluginClient, StoredAuth } from "../../core/types.ts"
import { maskPhone } from "../../core/util.ts"
import { LOOMY_ID } from "./product.ts"

/** The session in a stored sign-in, whichever shape the host saved it in. */
export const sessionOf = storedSession

/** The session, or the error that marks the account as needing a new one. */
export function requireSession(auth: StoredAuth | undefined, what: string): string {
  const access = sessionOf(auth)
  if (access === undefined) {
    throw new SignInExpiredError(LOOMY_ID, `账号里没有 session（${what}），请重新登录`)
  }
  return access
}

/** What the host shows as the account's name. */
export function accountLabel(auth: StoredAuth | undefined): string | undefined {
  const id = storedField(auth, "accountId")
  if (id !== undefined) return id
  const phone = storedField(auth, "phone")
  if (phone !== undefined) return maskPhone(phone)
  return storedField(auth, "userid")
}

/**
 * Remembers the day's quota, which only the check-in answer states.
 *
 * Written only when it changed: the host bumps the account and reloads its
 * sign-in whenever this store changes, and a no-op write would do that on
 * every usage read.
 *
 * This is the **second** way the quota reaches the account: a fresh sign-in
 * carries it inside its result (`login.ts`'s `signInResult`), which is the
 * path that makes a newly signed-in account show a percentage straight away.
 * This one covers everything else — an account signed in before that field
 * existed, or one whose sign-in-time read timed out. `points/records` cannot
 * fill it in on its own: it does not state `dailyQuota` (probed 2026-10-15).
 */
export async function rememberQuota(
  client: PluginClient,
  provider: string,
  auth: StoredAuth | undefined,
  quota: number | undefined,
  cycleDate: string | undefined,
): Promise<void> {
  if (auth === undefined || quota === undefined || quota <= 0) return
  if (num(auth.dailyQuota) === quota && str(auth.dailyCycleDate) === cycleDate) return
  await client.auth
    .set({
      path: { id: provider },
      body: {
        ...auth,
        dailyQuota: quota,
        ...(cycleDate === undefined ? {} : { dailyCycleDate: cycleDate }),
      },
    })
    .catch(() => undefined)
}

/** The quota the account's own record already knows, if any. */
export function rememberedQuota(auth: StoredAuth | undefined): {
  dailyQuota?: number
  dailyCycleDate?: string
} {
  const quota = num(auth?.dailyQuota)
  const cycleDate = str(auth?.dailyCycleDate)
  return {
    ...(quota === undefined ? {} : { dailyQuota: quota }),
    ...(cycleDate === undefined ? {} : { dailyCycleDate: cycleDate }),
  }
}
