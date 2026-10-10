/**
 * The parts of a Raccoon account that outlive one hook call.
 *
 * The host hands every hook the account's stored sign-in (`getAuth()`), and
 * writes one back with `client.auth.set`, which **replaces** the body rather
 * than merging it. So every write here starts from what the host gave and
 * only adds to it — dropping `access` while "remembering" an organisation
 * code would sign the account out.
 *
 * Where the session lives depends on what the sign-in could promise: an
 * account with a refresh token is stored the OAuth way (`access`), one
 * without is stored as a key (`key`) with no expiry the host could act on.
 * Both are read here, so a hook never has to know which it got;
 * `core/stored.ts` holds the storage-shape rule and why it reaches every
 * field, not just the session.
 */

import { SignInExpiredError } from "../../core/errors.ts"
import { str } from "../../core/json.ts"
import { storedField, storedSession } from "../../core/stored.ts"
import type { StoredAuth } from "../../core/types.ts"
import { maskPhone } from "../../core/util.ts"
import { RACCOON_ID } from "./product.ts"

/** The session in a stored sign-in, whichever shape the host saved it in. */
export const accessOf = storedSession

/** The session, or the error that marks the account as needing a new one. */
export function requireAccess(auth: StoredAuth | undefined, what: string): string {
  const access = accessOf(auth)
  if (access === undefined) {
    throw new SignInExpiredError(RACCOON_ID, `账号里没有 access_token（${what}），请重新登录`)
  }
  return access
}

/** The organisation a request is made in; personal accounts have none. */
export function officeOf(auth: StoredAuth | undefined): string | undefined {
  return storedField(auth, "officeIdentity")
}

/** The refresh token, when this account has one. */
export function refreshOf(auth: StoredAuth | undefined): string | undefined {
  return str(auth?.refresh)
}

/**
 * What the host shows as the account's name.
 *
 * The phone number comes first because it is the only field that tells two
 * accounts apart: the service's `name` is an automatically generated default
 * (`RaccoonAva`), so two accounts can carry the same one, and a WeChat
 * sign-in carries no WeChat nickname at all.
 */
export function accountLabel(auth: StoredAuth | undefined): string | undefined {
  const phone = storedField(auth, "phone")
  if (phone !== undefined) return maskPhone(phone)
  const id = storedField(auth, "accountId")
  if (id !== undefined) return id
  const nickname = storedField(auth, "nickname")
  if (nickname !== undefined) return nickname
  return storedField(auth, "userId")
}
