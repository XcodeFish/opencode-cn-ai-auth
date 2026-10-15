/**
 * The parts of a Trae account that outlive one hook call.
 *
 * A Trae sign-in is stored as an OAuth one: the result carries a refresh
 * token, so the host keeps the extra fields at the top level. They are read
 * through `core/stored.ts` all the same — an account signed in before that
 * was true, or one the host rebuilt, keeps them under `metadata`.
 *
 * Three of those fields are not the session and must survive a renewal
 * untouched:
 *
 * - `machineId` and `deviceId` are what the upstream identifies this install
 *   by; regenerating them on a renewal looks like a new machine.
 * - `deviceId` is also the check-in's per-device slot, so a fresh value would
 *   let one account check in twice in a day.
 *
 * Every write here starts from the sign-in the host handed over and only adds
 * to it, because `client.auth.set` replaces rather than merges.
 */

import { SignInExpiredError } from "../../core/errors.ts"
import { num, str } from "../../core/json.ts"
import { storedField, storedSession } from "../../core/stored.ts"
import type { StoredAuth } from "../../core/types.ts"
import { credentialOf, type TraeCredential } from "./api.ts"
import { TRAE_ID } from "./product.ts"

/** The access token in a stored sign-in, whichever shape the host saved it in. */
export const accessOf = storedSession

/**
 * The account as a credential, or the error that marks it as needing a new
 * sign-in.
 *
 * A stored sign-in that has a session but no device fingerprint is not
 * repaired here: minting one would break the check-in's once-per-device rule
 * in a way nobody could see, so the account is reported as needing a sign-in
 * it has never had.
 */
export function credentialFor(auth: StoredAuth | undefined, what: string): TraeCredential {
  const credential = credentialOf(readFields(auth))
  if (credential === undefined) {
    throw new SignInExpiredError(TRAE_ID, `账号里没有 Trae 登录态（${what}），请重新登录`)
  }
  return credential
}

/**
 * The credential, or undefined rather than an error.
 *
 * Read-only hooks (`usage`, the model list) use this: a missing sign-in there
 * is reported as `signIn: "expired"` on the card, which is what the host
 * expects from them, not an exception.
 */
export function credentialOrUndefined(auth: StoredAuth | undefined): TraeCredential | undefined {
  return credentialOf(readFields(auth))
}

/**
 * Fold the two storage shapes into the flat record `credentialOf` reads.
 *
 * `core/stored.ts` looks up one field at a time; a credential is six, and
 * doing it here means the shape rule stays in one place without six call
 * sites having to remember it.
 */
function readFields(auth: StoredAuth | undefined): Record<string, unknown> | undefined {
  if (auth === undefined) return undefined
  const accessToken = storedSession(auth)
  if (accessToken === undefined) return undefined
  const expiresAt = num(auth.expires) ?? undefined
  return {
    accessToken,
    refreshToken: str(auth.refresh) ?? storedField(auth, "refreshToken") ?? "",
    uid: storedField(auth, "uid") ?? "",
    machineId: storedField(auth, "machineId") ?? "",
    deviceId: storedField(auth, "deviceId") ?? "",
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(storedField(auth, "nickname") === undefined ? {} : { nickname: storedField(auth, "nickname") }),
    ...(storedField(auth, "enterpriseId") === undefined
      ? {}
      : { enterpriseId: storedField(auth, "enterpriseId") }),
  }
}

/** What the host shows as the account's name. */
export function accountLabel(auth: StoredAuth | undefined): string | undefined {
  return storedField(auth, "nickname") ?? storedField(auth, "uid")
}
