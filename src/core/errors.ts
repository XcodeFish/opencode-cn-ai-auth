/**
 * The error taxonomy the host reads.
 *
 * magpie marks an account as needing a new sign-in when a plugin throws an
 * error whose `signIn` is `"expired"` (or returns `signIn: "expired"` from
 * `usage`); everything else is a request-level failure.
 */

export class VendorError extends Error {
  readonly vendor: string
  readonly code: string | number | undefined
  readonly status: number | undefined

  constructor(
    vendor: string,
    message: string,
    options: { code?: string | number; status?: number; cause?: unknown } = {},
  ) {
    super(`${vendor}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "VendorError"
    this.vendor = vendor
    this.code = options.code
    this.status = options.status
  }
}

/** The vendor turned the sign-in away; the account needs a new one. */
export class SignInExpiredError extends Error {
  readonly signIn = "expired" as const
  readonly vendor: string

  constructor(vendor: string, message: string) {
    super(`${vendor}: ${message}`)
    this.name = "SignInExpiredError"
    this.vendor = vendor
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
