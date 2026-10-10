/**
 * Constants a vendor's own client ships with.
 *
 * Two of the flows this package implements are signed or encrypted with a
 * value that lives inside a vendor's shipped client: Loomy's China Telecom
 * account endpoints (account.xfinfr.com) are signed with an AccessKey the
 * Loomy client carries in its bundle, and Raccoon's SMS endpoints take the
 * phone number encrypted under a key from its renderer bundle. Neither is a
 * user secret — both are readable by anyone with the client.
 *
 * Raccoon's is left to the user, because nothing here needs it until someone
 * asks for SMS sign-in. Loomy's is not optional that way — QR sign-in has to
 * work on a fresh install — so that one pair is baked in on purpose, in
 * `vendors/loomy/bundled-credentials.ts`, and is the single exception to
 * "a vendor's constants are never baked in"; `docs/conventions.md` §7 records
 * what that exception costs.
 *
 * Every other vendor constant is resolved in this order:
 *
 * 1. `options` — the object magpie stores on the plugin entry
 *    (`magpie plugin options <name> '{"accessKeyId": "…"}'`, one object shared
 *    by every provider this package exports) or the options an OpenCode plugin
 *    entry passes.
 * 2. the environment — handy for a shell where magpie was started.
 *
 * Nothing is invented: a credential that resolves nowhere disables the one
 * flow that needs it (see `definitions` in each vendor's `login.ts`) instead
 * of sending a request that can only fail. `docs/vendors.md` says where each
 * value comes from and how to read it out of the vendor's own client.
 */

import { trimmedStr } from "./json.ts"

export interface CredentialSpec {
  /** The key this credential takes in the vendor's plugin options. */
  option: string
  /** The environment variable a host without options can set instead. */
  env: string
  /** What the value is, in the words a user reading an error needs. */
  what: string
}

function environment(): Record<string, string | undefined> | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return typeof env === "object" && env !== null ? env : undefined
}

/** The credential's value, from options then the environment. */
export function readCredential(
  spec: CredentialSpec,
  options: Record<string, unknown> = {},
): string | undefined {
  return trimmedStr(options[spec.option]) ?? trimmedStr(environment()?.[spec.env])
}

/** Thrown when a flow needs a credential that was never configured. */
export class MissingCredentialError extends Error {
  readonly spec: CredentialSpec

  constructor(spec: CredentialSpec) {
    super(
      `${spec.what}未配置：请把它写进插件选项 ${spec.option}，` +
        `或设置环境变量 ${spec.env}（见 docs/vendors.md）`,
    )
    this.name = "MissingCredentialError"
    this.spec = spec
  }
}
