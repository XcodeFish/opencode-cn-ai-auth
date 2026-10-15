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
import { fetchOnboarding, type LoomyOnboarding } from "./api.ts"

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

/**
 * The account's task state, from the cache when it is fresh and from the
 * service otherwise. A read that fails returns undefined rather than
 * throwing: the card is not worth failing a usage read over.
 */
export async function taskStateFor(
  fetcher: Fetcher,
  auth: StoredAuth | undefined,
  access: string,
  now = Date.now(),
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
  if (key !== undefined) readings.set(key, { at: now, data: result.data })
  return { data: result.data, stale: false }
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
