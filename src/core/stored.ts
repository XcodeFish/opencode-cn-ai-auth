/**
 * Reading an account out of the sign-in the host stores.
 *
 * The host hands every hook one stored sign-in and takes one back with
 * `client.auth.set`, which **replaces** the body rather than merging it
 * (`internal/plugin/host.js`). Two shapes come back, and the shape decides
 * where the fields a vendor learned about the account live:
 *
 * - an **OAuth** sign-in — one whose result carried a `refresh` — keeps
 *   everything the sign-in handed over at the top level (`access`, `expires`,
 *   and whatever else the plugin added);
 * - an **API-key** sign-in is rebuilt to `{ type: "api", key, metadata }`
 *   before it is saved, so a phone number, an organisation code or a user id
 *   set on it is only reachable under `metadata`.
 *
 * Both readers here look in both places, so a hook never has to know which
 * shape it was given. That is not a nicety: a vendor that signs an account in
 * without a refresh token (Raccoon does, when the service sends none) would
 * otherwise lose the organisation its requests are made in, and read as a
 * personal account from the first request on.
 *
 * Nothing here writes: an account is written back whole, from the sign-in the
 * host gave, by each vendor's own `session.ts`.
 */

import { asObject, str } from "./json.ts"
import type { StoredAuth } from "./types.ts"

/** The session in a stored sign-in: `access` for OAuth, `key` for an API one. */
export function storedSession(auth: StoredAuth | undefined): string | undefined {
  return str(auth?.access) ?? str(auth?.key)
}

/** A field of the sign-in: its own, else the one the host kept under `metadata`. */
export function storedField(auth: StoredAuth | undefined, key: string): string | undefined {
  return str(auth?.[key]) ?? str(asObject(auth?.metadata)?.[key])
}
