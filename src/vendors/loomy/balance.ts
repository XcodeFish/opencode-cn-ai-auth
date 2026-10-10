/**
 * The day's quota as last read, and the gate that spends only it.
 *
 * Loomy keeps two pools: the daily one, which refills every Beijing day, and
 * the permanent one, which does not. A user may **lock** the permanent pool
 * (`options.lockPermanent`, the same switch JetHub's account pool calls
 * `allowPermanent: false`), meaning "when the day's quota is gone, this
 * account is out" rather than "quietly spend my sign-up credits".
 *
 * The host cannot express that rule: an account's windows order it, and a
 * window with no ceiling cannot stop it (`core`'s rule is that only a known
 * limit may). So the refusal happens in the loader's `fetch`, before the
 * request leaves (`core/gate.ts` shapes it so the host benches the account
 * until the window in `usage` renews).
 *
 * The reading is cached because the check runs on every request: the `usage`
 * hook fills it (`points/records`, read-only), and the cache is deliberately
 * short-lived (JetHub's own 60s). A cache that is **missing or stale lets the
 * request through**: being wrong about "no quota" costs a request that would
 * have worked, while being wrong about "quota left" costs only permanent
 * credits the user can see on the card.
 */

import { str } from "../../core/json.ts"
import type { StoredAuth } from "../../core/types.ts"

/** How long a reading may be used, in milliseconds (JetHub's own TTL). */
export const LOOMY_BALANCE_TTL_MS = 60_000

/** The `options` key that locks the permanent pool. */
export const LOOMY_LOCK_PERMANENT_OPTION = "lockPermanent"

interface Reading {
  at: number
  /** The daily pool's balance, as `points/records` stated it. */
  daily: number
}

/**
 * One reading per account, in memory only. Keyed by the vendor's own user id
 * (stable across re-sign-ins) and falling back to the session: the host
 * stores nothing this package asks for, and a plugin's cache has to be
 * rebuildable from the account alone (see `docs/architecture.md` §6).
 */
const readings = new Map<string, Reading>()

/** The key a stored sign-in's quota is remembered under; undefined when it has none. */
function keyOf(auth: StoredAuth | undefined): string | undefined {
  return str(auth?.userid) ?? str(auth?.access) ?? str(auth?.key)
}

/** Remembers what `points/records` (or a check-in) just said about the daily pool. */
export function rememberDailyBalance(auth: StoredAuth | undefined, daily: number | undefined): void {
  const key = keyOf(auth)
  if (key === undefined || daily === undefined) return
  readings.set(key, { at: Date.now(), daily })
}

/** The cached reading, when there is one and it is not stale. */
function freshReading(auth: StoredAuth | undefined, now: number): Reading | undefined {
  const key = keyOf(auth)
  if (key === undefined) return undefined
  const reading = readings.get(key)
  if (reading === undefined) return undefined
  if (now - reading.at > LOOMY_BALANCE_TTL_MS) {
    readings.delete(key)
    return undefined
  }
  return reading
}

/** Whether the user locked the permanent pool. Anything but `true` leaves it unlocked. */
export function lockPermanent(options: Record<string, unknown>): boolean {
  return options[LOOMY_LOCK_PERMANENT_OPTION] === true
}

/** What the user is told when a locked account's day is spent. */
export const LOOMY_LOCKED_REFUSAL =
  "今日赠送额度已用完，且永久积分已被锁定（插件选项 lockPermanent）。" +
  "请在插件设置里解锁永久积分，或等今日额度重置后再试"

/**
 * The message a request must be refused with, or undefined to let it through.
 *
 * Pure but for the cache read, so the rule is testable without a host: it
 * refuses only when the pool is locked **and** a fresh reading says the day is
 * spent (`daily <= 0`). A reading that says nothing useful is not a refusal.
 */
export function lockedRefusal(
  auth: StoredAuth | undefined,
  options: Record<string, unknown>,
  now = Date.now(),
): string | undefined {
  if (!lockPermanent(options)) return undefined
  const reading = freshReading(auth, now)
  if (reading === undefined) return undefined
  return reading.daily <= 0 ? LOOMY_LOCKED_REFUSAL : undefined
}

/** Drops every reading; the host calls this nowhere, tests call it between cases. */
export function forgetDailyBalances(): void {
  readings.clear()
}
