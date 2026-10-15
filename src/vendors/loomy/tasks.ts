/**
 * The new-user tasks as the usage card shows them.
 *
 * The claim itself rides on `auth.checkin` (`index.ts`), but its result is
 * only visible in the check-in message — and magpie prints that only when a
 * check-in fails (`CheckinResult.message` on `claimed`/`done` never reaches
 * the CLI or the card, verified in magpie 0.1.1254's plugin host and UI
 * strings). So a user who claimed nothing has no way to see where the tasks
 * stand, and one whose claim half-failed is told nothing either.
 *
 * This module reads the flags for the card instead: `GET /onboarding/tasks`
 * is read-only, and the answer is cached per account because `usage` runs
 * often (every quota refresh) while the flags change only when a claim
 * happens. The card gets one `aside` window — shown, never routed by, so an
 * unfinished task list cannot make magpie send requests elsewhere.
 */

import type { Fetcher } from "../../core/http.ts"
import type { StoredAuth, UsageWindow } from "../../core/types.ts"
import { claimKnownTasks, fetchOnboarding, type LoomyOnboarding, type LoomyOnboardingClaim } from "./api.ts"
import { LOOMY_CLAIM_TASKS_OPTION } from "./product.ts"

/**
 * How long a task reading may be used.
 *
 * The flags move only when this package claims them (the check-in) or the
 * user finishes one in Loomy's own client, so a long TTL costs nothing but a
 * stale "7/8" for a while. Long enough that the card's periodic refreshes
 * rarely touch the endpoint, short enough that a claim is visible soon after.
 */
export const LOOMY_TASKS_TTL_MS = 10 * 60 * 1000

interface Reading {
  at: number
  data: LoomyOnboarding
}

const readings = new Map<string, Reading>()

/** The key a reading is remembered under; undefined when the account has none. */
function keyOf(auth: StoredAuth | undefined): string | undefined {
  const userid = auth?.userid
  if (typeof userid === "string" && userid.length > 0) return userid
  const access = auth?.access ?? auth?.key
  return typeof access === "string" && access.length > 0 ? access : undefined
}

/** Forgets every reading; tests use it, the host never needs to. */
export function forgetTaskReadings(): void {
  readings.clear()
}

/** Whether the card may claim unfinished tasks. Anything but `false` lets it. */
export function claimTasksEnabled(options: Record<string, unknown>): boolean {
  return options[LOOMY_CLAIM_TASKS_OPTION] !== false
}

/**
 * Drops one account's reading, so the next `usage` reads the service again.
 *
 * Called after a claim: the cached flags are the pre-claim ones, and the
 * card would otherwise keep showing "0/8, 10000 分可领" for the rest of the
 * TTL right after the tasks were actually claimed — the check-in and the
 * card refresh land seconds apart, so the stale window is the normal case,
 * not an edge one.
 */
export function forgetTaskReading(auth: StoredAuth | undefined): void {
  const key = keyOf(auth)
  if (key !== undefined) readings.delete(key)
}

/**
 * The account's task state, from the cache when it is fresh and from the
 * service otherwise. A read that fails returns undefined rather than
 * throwing: the card is not worth failing a usage read over.
 *
 * When the read says some tasks are still unclaimed, they are claimed right
 * away — this is the package's only way to complete them without a user
 * gesture. The host draws the usage card itself and offers no button a plugin
 * could hook (magpie 0.1.1254: windows are `{name, used, display, …}` with
 * nothing actionable, and the only check-in buttons disappear once the
 * account has checked in today), so "claim when noticed" is what a button
 * would have been. The claim is idempotent and free, and the answer replaces
 * the reading, so the card's line goes away in the same refresh that would
 * have shown it.
 */
export async function taskStateFor(
  fetcher: Fetcher,
  auth: StoredAuth | undefined,
  access: string,
  now = Date.now(),
  claim = true,
): Promise<{ data: LoomyOnboarding; stale: boolean } | undefined> {
  const key = keyOf(auth)
  if (key !== undefined) {
    const cached = readings.get(key)
    if (cached !== undefined && now - cached.at <= LOOMY_TASKS_TTL_MS) {
      return { data: cached.data, stale: true }
    }
  }
  const result = await fetchOnboarding(fetcher, access)
  if (!result.ok) return undefined
  const remaining = Object.keys(result.data.tasks).some((taskKey) => result.data.tasks[taskKey] !== true)
  if (!claim || !remaining) {
    if (key !== undefined) readings.set(key, { at: now, data: result.data })
    return { data: result.data, stale: false }
  }
  const claimed = await claimKnownTasks(fetcher, access, result.data)
  // A refusal leaves the reading as it was; only what was actually handed out
  // is written down, so the line shows the real remainder (and is retried
  // when the reading expires).
  const settled = claimed.ok ? readingAfter(result.data, claimed.data) : result.data
  if (key !== undefined) readings.set(key, { at: now, data: settled })
  return { data: settled, stale: false }
}

/**
 * The reading as it stands after a claim: the keys it handed out (plus the
 * ones it skipped) are done, everything else is not.
 */
function readingAfter(state: LoomyOnboarding, claim: LoomyOnboardingClaim): LoomyOnboarding {
  const done = new Set([...claim.claimed, ...claim.skipped])
  const tasks: Record<string, boolean> = {}
  for (const key of Object.keys(state.tasks)) tasks[key] = done.has(key)
  return { tasks, done: done.size, earned: claim.earned, total: claim.total }
}

/**
 * The card's line for the tasks, or nothing when there is nothing to say.
 *
 * Nothing to say means every task is done: that is the steady state, and a
 * permanent "8/8" on the card is noise. While some are left, the window says
 * how many and what they are worth, and names the reset-less nature of the
 * pool it belongs to.
 */
export function tasksWindow(data: LoomyOnboarding | undefined): UsageWindow | undefined {
  if (data === undefined) return undefined
  const total = Object.keys(data.tasks).length
  if (total === 0 || data.done >= total) return undefined
  const left = data.total - data.earned
  return {
    name: "新手任务",
    used: 0,
    // Shown, never routed by: an unfinished task list is not a reason to
    // stop sending requests here (the same reason the permanent pool is
    // `aside`), and only a known ceiling may order an account.
    aside: true,
    unit: "分",
    display: `新手任务 ${data.done}/${total} · 已领 ${data.earned} / 还有 ${left} 分可领`,
    // No `limit`/`amount`: the card would draw a progress bar from them, and
    // the tasks are a one-off list, not a pool being spent down.
  }
}
