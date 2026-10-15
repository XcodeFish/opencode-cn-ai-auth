/**
 * Loomy's credits, as the host's usage card reads them.
 *
 * The service keeps two pools that are spent differently, and the card says
 * so with two windows:
 *
 * - **The daily pool** — the vendor hands out a quota once a Beijing day and
 *   does not give back what was spent (`dailyBalance = dailyQuota −
 *   dailyConsumed`). This is the window that counts: its share used is real,
 *   and it resets at the next Beijing day, which is what the host wants to
 *   know before it routes a request here.
 * - **The permanent pool** — sign-up credits and the new-user tasks. It has
 *   no cycle and no ceiling, so it is reported `aside: true`: shown, and not
 *   a reason to route to or away from this account.
 *
 * `dailyQuota` only ever comes from the check-in answer (`points/first-login`)
 * and is remembered with the account; a `5000` copied into this file would be
 * a number the vendor never promised, so until a check-in has happened the
 * daily window is shown with amounts and marked aside, and the share-used
 * window appears once the quota is known.
 */

import type { CheckinResult, UsageReport, UsageWindow } from "../../core/types.ts"
import type { LoomyDailyGrant, LoomyOnboardingClaim, LoomyPoints } from "./api.ts"
import { LOOMY_TASK_TITLES } from "./product.ts"

/** The Beijing day's reset, as epoch milliseconds. */
export function beijingResetAt(now: number, cycleDate?: string): number {
  const OFFSET_MS = 8 * 3600 * 1000
  const fromCycle = cycleDate === undefined ? undefined : cycleResetAt(cycleDate)
  if (fromCycle !== undefined && fromCycle > now + 60_000) return fromCycle
  const beijing = new Date(now + OFFSET_MS)
  const midnight = Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate() + 1)
  // 00:05 rather than 00:00: a couple of minutes so a request that lands on
  // the boundary isn't charged to the day the vendor has already closed.
  return midnight - OFFSET_MS + 5 * 60_000
}

function cycleResetAt(cycleDate: string): number | undefined {
  const match = cycleDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (match === null) return undefined
  const [, year, month, day] = match
  return Date.UTC(Number(year), Number(month) - 1, Number(day) + 1) - 8 * 3600 * 1000 + 5 * 60_000
}

/**
 * Whether a quota the account has written down still describes the running
 * Beijing day.
 *
 * `dailyQuota` is only ever stated by the check-in answer, so between
 * check-ins the account can hold a reading from an earlier day — and the
 * amount is the vendor's to change (JetHub's note on the same field: never
 * hard-code it, an activity can move it). A reading whose day has already
 * reset is therefore dropped rather than carried into a day it did not
 * describe; the window waits for today's check-in instead.
 *
 * A reading with no date at all is kept: `dailyCycleDate` is the vendor's
 * field and one answer may omit it, and the alternative — never letting the
 * daily pool count — is the defect this rule exists to avoid.
 */
export function quotaCoversNow(cycleDate: string | undefined, now: number): boolean {
  if (cycleDate === undefined) return true
  const reset = cycleResetAt(cycleDate)
  return reset === undefined || reset > now + 60_000
}

/**
 * The reading with the day's quota filled in from the account's own record.
 *
 * `points/records` — the read-only call `usage` makes — does not state
 * `dailyQuota` (only the check-in answer does), so a reading on its own can
 * only draw the "some left, ceiling unknown" window. The quota the account
 * kept at check-in (`session.ts`'s `rememberQuota`) is what turns that into
 * the share-used window the host routes by, and it is applied here rather
 * than in `windowsOf` so that both read paths — a plain usage read and one
 * that followed a check-in — see the same number.
 */
export function quotaForNow(
  points: LoomyPoints,
  remembered: { dailyQuota?: number; dailyCycleDate?: string },
  now: number,
): LoomyPoints {
  const quota = remembered.dailyQuota
  // The reading's own day wins when it states one: it is the newer fact. The
  // remembered day rides along otherwise so the window's reset time and the
  // write-back both describe the day the quota belongs to.
  const cycleDate = points.dailyCycleDate ?? remembered.dailyCycleDate
  const inherits =
    points.dailyQuota === undefined &&
    quota !== undefined &&
    quota > 0 &&
    quotaCoversNow(remembered.dailyCycleDate, now)
  return {
    ...points,
    ...(inherits ? { dailyQuota: quota } : {}),
    ...(cycleDate === undefined ? {} : { dailyCycleDate: cycleDate }),
  }
}

function round(value: number): number {
  return Math.round(value)
}

/** The two windows, built from one reading of the pools. */
export function windowsOf(points: LoomyPoints, now: number): UsageWindow[] {
  const windows: UsageWindow[] = []
  const quota = points.dailyQuota
  const daily = points.daily
  // The vendor's own arithmetic is `dailyBalance = dailyQuota − dailyConsumed`
  // (JetHub's reading of the same fields), so a reading that states the quota
  // and the day's balance but not the consumed amount still says how much of
  // the day is gone. Without this the window would fall back to "ceiling
  // unknown" on every read that followed a check-in, and the daily pool would
  // never order the account — the thing this window is for.
  const consumed =
    points.dailyConsumed ??
    (quota !== undefined && quota > 0 && daily !== undefined ? Math.max(0, quota - daily) : undefined)
  if (quota !== undefined && quota > 0 && consumed !== undefined) {
    windows.push({
      name: "今日积分",
      used: round((100 * consumed) / quota),
      resetsAt: beijingResetAt(now, points.dailyCycleDate),
      amount: consumed,
      limit: quota,
      unit: "积分",
      display: `今日 ${daily ?? Math.max(0, quota - consumed)} / ${quota}`,
    })
  } else if (daily !== undefined) {
    // The quota is not known yet (no check-in this sign-in): say what is
    // left without claiming a share of something that was never stated.
    windows.push({
      name: "今日积分",
      used: 0,
      aside: true,
      resetsAt: beijingResetAt(now, points.dailyCycleDate),
      display: `今日剩余 ${daily}`,
      unit: "积分",
    })
  }
  if (points.permanent !== undefined) {
    windows.push({
      name: "永久积分",
      used: 0,
      aside: true,
      unit: "积分",
      display: `永久积分 ${points.permanent}`,
    })
  }
  return windows
}

export function usageReport(points: LoomyPoints, options: { user?: string; now?: number } = {}): UsageReport {
  const now = options.now ?? Date.now()
  const total = points.available ?? (points.permanent ?? 0) + (points.daily ?? 0)
  return {
    balance: `${total} 积分`,
    ...(options.user === undefined ? {} : { user: options.user }),
    windows: windowsOf(points, now),
  }
}

/**
 * The check-in answer as the host's outcomes: `alreadyProcessed` is the
 * vendor saying the day's quota was handed out already, which is `done` and
 * not `claimed` — a `claimed` there would read as credits just earned.
 *
 * `onboarding` is the new-user task claim that rides along with the check-in.
 * Its credits are deliberately kept out of `credit`: that number is read as
 * the day's handout, and 10 000 permanent credits reported there would look
 * like a daily quota. They are named in the message instead, and the outcome
 * only stays `claimed` when the day's own quota was handed out — finishing a
 * task is not the day's check-in.
 */
export function checkinResult(grant: LoomyDailyGrant, onboarding?: LoomyOnboardingClaim): CheckinResult {
  const quota = grant.dailyQuota
  const left = grant.daily
  const detail = quota === undefined ? "" : `（今日 ${left ?? 0}/${quota}）`
  const tasks = onboardingMessage(onboarding)
  if (grant.alreadyProcessed) {
    return { outcome: "done", credit: 0, message: `今日额度已初始化${detail}${tasks}` }
  }
  const consumed = grant.dailyConsumed
  const credit = quota === undefined ? 0 : consumed === undefined ? quota : Math.max(0, quota - consumed)
  return { outcome: "claimed", credit, message: `今日额度已发放${detail}${tasks}` }
}

/**
 * What to say about the task claim, or nothing when it has nothing to say.
 *
 * Every task the account can finish is reported once, by title, so the row
 * says what the credits were for; a partial run names what stopped it, since
 * the next check-in would otherwise look like it had simply done nothing.
 */
function onboardingMessage(claim: LoomyOnboardingClaim | undefined): string {
  if (claim === undefined) return ""
  if (claim.claimed.length === 0 && claim.error === undefined) return ""
  const titles = claim.claimed.map((key) => LOOMY_TASK_TITLES[key] ?? key).join("、")
  const total = Object.keys(LOOMY_TASK_TITLES).length
  const parts = [`新手任务补领 ${claim.claimed.length} 项 +${claim.earned}`]
  if (titles.length > 0) parts.push(`（${titles}）`)
  parts.push(`，累计 ${claim.earned}/${claim.total}（${claim.done}/${total} 项）`)
  if (claim.error !== undefined) {
    parts.push(`；因「${claim.error.message}」中断，还剩未领的，下次签到再试`)
  }
  return `；${parts.join("")}`
}
