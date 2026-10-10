/**
 * Small shared helpers: identifiers, masking, HTML escaping and settlement.
 */

import { randomBytes, randomUUID } from "node:crypto"

/** A lowercase hex string of `bytes` random bytes. */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex")
}

/** A random UUID without dashes, 32 lowercase hex characters. */
export function randomId(): string {
  return randomUUID().replaceAll("-", "")
}

/** 138****5678, for showing an account without publishing the number. */
export function maskPhone(phone: string): string {
  if (phone.length < 7) return phone
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
}

/**
 * A mainland mobile number, as the vendors here take one: eleven digits, or
 * the same written with spaces, dashes or a `+86`/`86` prefix. Anything else
 * is not a number to send — a wrong one costs a user a sign-in attempt, so
 * the callers ask again instead of forwarding it.
 */
export function mainlandPhone(input: string | undefined): string | undefined {
  const digits = (input ?? "").replace(/[\s-]/g, "").replace(/^\+?86/, "")
  return /^1[3-9]\d{9}$/.test(digits) ? digits : undefined
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      default:
        return "&#39;"
    }
  })
}

export interface Settlement<T> {
  readonly promise: Promise<T>
  readonly settled: boolean
  settle(value: T): void
  fail(error: unknown): void
}

/**
 * One-shot settlement: the first call wins, later ones are ignored. The
 * promise has a no-op catch attached so an unconsumed failure is not an
 * unhandled rejection while the flow is still starting.
 */
export function createSettlement<T>(): Settlement<T> {
  let done = false
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  return {
    promise,
    get settled() {
      return done
    },
    settle(value: T) {
      if (done) return
      done = true
      resolve(value)
    },
    fail(error: unknown) {
      if (done) return
      done = true
      reject(error instanceof Error ? error : new Error(String(error)))
    },
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    timer.unref?.()
  })
}
