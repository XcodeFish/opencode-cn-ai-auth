/**
 * Trae's credits and daily check-in.
 *
 * The credits endpoint answers with **packs**, not a total: each pack says
 * what it granted (`quota.credits_limit`) and what has been spent from it
 * (`usage.credits_amount`). The remainder is the sum of the differences. It
 * never states a ceiling for the account as a whole, so no window here
 * carries a share-used figure and every one of them is `aside: true` — shown
 * on the card, and never a reason for the host to route to or away from this
 * account. Inventing a ceiling (the daily grant is believed to be 150, which
 * the service never says) would let a guess order a user's accounts.
 *
 * The check-in is the one call in this package that changes state on the
 * vendor's side. It runs from `auth.checkin`, which is the host's only write
 * hook and the one a user presses (`Check in now`); it never runs on its own.
 * Three things about it are the vendor's, not this package's, and each one is
 * handled where it happens: the claim answer does **not** carry the amount
 * earned (the status endpoint does), the per-device slot is shared by every
 * account on a machine (so a second account in one day is a fact, not an
 * error), and the status endpoints answer `9074` when the pool is busy.
 */

import { VendorError } from "../../core/errors.ts"
import { type Fetcher, httpJson } from "../../core/http.ts"
import { isObject, num, str } from "../../core/json.ts"
import type { CheckinResult, UsageReport, UsageWindow } from "../../core/types.ts"
import { checkinHeaders, type TraeCredential } from "./api.ts"
import {
  TRAE_CHECKIN_BUSY_CODE,
  TRAE_CLIENT,
  TRAE_ID,
  TRAE_PATHS,
  TRAE_REQUEST_TIMEOUT_MS,
  TRAE_UG_BASE,
} from "./product.ts"

/** One credit pack, as the card shows it. */
interface CreditPack {
  name: string
  remaining: number
  total: number
}

export interface TraeCredits {
  total: number
  packs: CreditPack[]
}

/** The status answer: whether today is taken, and what it is worth. */
export interface TraeCheckinStatus {
  /** The activity is running at all. */
  enabled: boolean
  checkedIn: boolean
  /** Today's reward, as the status endpoint states it (the claim does not). */
  dailyCredit?: number
}

/**
 * Read the account's credit packs.
 *
 * Read-only, and a failure is reported as "no reading" rather than as an
 * empty balance: `undefined` lets the card say it could not read, while a
 * zero would claim the account has nothing left.
 */
export async function fetchCredits(
  fetcher: Fetcher,
  credential: TraeCredential,
  ids: { requestId: string; traceId: string },
): Promise<TraeCredits | undefined> {
  const answer = await httpJson(fetcher, `${TRAE_UG_BASE}${TRAE_PATHS.entitlementUsage}`, {
    method: "POST",
    headers: checkinHeaders(credential, TRAE_CLIENT, ids.requestId, ids.traceId),
    body: JSON.stringify({ require_usage: true, req_source: 2 }),
    timeoutMs: TRAE_REQUEST_TIMEOUT_MS,
  })
  if (!answer.ok || !isObject(answer.json)) return undefined
  const list = answer.json.user_entitlement_pack_list
  if (!Array.isArray(list)) return undefined
  const packs = list.map(readPack).filter((pack): pack is CreditPack => pack !== undefined)
  return { total: packs.reduce((sum, pack) => sum + pack.remaining, 0), packs }
}

/**
 * One entry of `user_entitlement_pack_list`, or undefined when it is not a
 * pack this card can show (no declared allowance, or a negative one).
 */
function readPack(item: unknown): CreditPack | undefined {
  if (!isObject(item)) return undefined
  const base = isObject(item.entitlement_base_info) ? item.entitlement_base_info : undefined
  const quota = base === undefined ? undefined : isObject(base.quota) ? base.quota : undefined
  if (quota === undefined) return undefined
  const limit = num(quota.credits_limit)
  if (limit === undefined || limit <= 0) return undefined
  // A pack with no usage object has spent nothing from it, which is a real
  // state (a grant that has not been touched) rather than a missing reading.
  const usage = isObject(item.usage) ? item.usage : undefined
  const spent = usage === undefined ? 0 : (num(usage.credits_amount) ?? 0)
  return {
    name: (base === undefined ? undefined : str(base.name)) ?? "资源包",
    remaining: limit - spent,
    total: limit,
  }
}

/** The credits as the host's usage card reads them. */
export function usageReport(
  credits: TraeCredits,
  options: { user?: string; extraWindows?: UsageWindow[] } = {},
): UsageReport {
  return {
    ...(options.user === undefined ? {} : { user: options.user }),
    balance: `${credits.total} 积分`,
    windows: [...creditWindows(credits), ...(options.extraWindows ?? [])],
  }
}

function creditWindows(credits: TraeCredits): UsageWindow[] {
  const windows = credits.packs.map((pack) => ({
    name: pack.name,
    used: 0,
    aside: true,
    unit: "积分",
    display: `${pack.name} ${pack.remaining} / ${pack.total}`,
  }))
  if (windows.length === 0) {
    windows.push({ name: "积分", used: 0, aside: true, unit: "积分", display: `积分 ${credits.total}` })
  }
  return windows
}

/**
 * Ask whether today's check-in is still available, and what it pays.
 *
 * The reward is only ever stated here — the claim answers `{"code":0,
 * "message":"success"}` and nothing else — which is why claiming comes back
 * to this endpoint afterwards to report what was actually earned instead of
 * printing a confident "+0".
 */
export async function fetchCheckinStatus(
  fetcher: Fetcher,
  credential: TraeCredential,
  ids: { requestId: string; traceId: string },
): Promise<TraeCheckinStatus | undefined> {
  const answer = await httpJson(fetcher, `${TRAE_UG_BASE}${TRAE_PATHS.checkinStatus}`, {
    method: "POST",
    headers: checkinHeaders(credential, TRAE_CLIENT, ids.requestId, ids.traceId),
    body: "{}",
    timeoutMs: TRAE_REQUEST_TIMEOUT_MS,
  })
  if (answer.status === 401 || answer.status === 403) {
    throw new VendorError(TRAE_ID, "签到状态被拒绝：登录态可能已失效", { status: answer.status })
  }
  if (!answer.ok || !isObject(answer.json)) return undefined
  const code = readCode(answer.json.code)
  if (code !== 0) return undefined
  const reward = num(answer.json.credits)
  return {
    enabled: answer.json.enable === true,
    checkedIn: answer.json.checked_in === true,
    ...(reward === undefined ? {} : { dailyCredit: reward }),
  }
}

/**
 * Take today's check-in, and report it honestly.
 *
 * The order matters: the status endpoint is asked first, so an account that
 * already claimed today never sends a claim at all, and one whose activity is
 * not running is reported as such instead of as a failure. After a successful
 * claim the status endpoint is read again, because the claim itself does not
 * say what was earned.
 *
 * `9074` is surfaced as a failure with a retry hint. It is not retried here:
 * JetHub removed its automatic device rotation for it, and a package that
 * mints a second device identity on demand would be describing "this device
 * already claimed" as a success.
 */
export async function claimCheckin(
  fetcher: Fetcher,
  credential: TraeCredential,
  ids: { requestId: string; traceId: string },
): Promise<CheckinResult> {
  const status = await fetchCheckinStatus(fetcher, credential, ids).catch(() => undefined)
  if (status !== undefined && !status.enabled) {
    return { outcome: "ineligible", message: "今天的签到活动未开放" }
  }
  if (status?.checkedIn === true) {
    return {
      outcome: "done",
      ...(status.dailyCredit === undefined ? {} : { credit: status.dailyCredit }),
      message: "今天已经签到过了",
    }
  }

  const answer = await httpJson(fetcher, `${TRAE_UG_BASE}${TRAE_PATHS.checkinClaim}`, {
    method: "POST",
    headers: checkinHeaders(credential, TRAE_CLIENT, ids.requestId, ids.traceId),
    body: "{}",
    timeoutMs: TRAE_REQUEST_TIMEOUT_MS,
  })
  if (answer.status === 401) {
    return { outcome: "failed", message: "签到被拒绝：登录态已失效，请重新登录" }
  }
  if (!answer.ok || !isObject(answer.json)) {
    return { outcome: "failed", message: `签到失败（HTTP ${answer.status}）` }
  }

  const code = readCode(answer.json.code)
  const message = str(answer.json.message) ?? str(answer.json.msg)
  if (code === TRAE_CHECKIN_BUSY_CODE) {
    return {
      outcome: "failed",
      message: message ?? "当前使用人数太多，请稍后再试（本机每天只能签到一次）",
    }
  }
  if (code !== 0) {
    return { outcome: "failed", message: message ?? `签到失败（code=${code}）` }
  }

  // The claim says nothing about the amount, so it is read back — one extra
  // request, in exchange for reporting what was actually earned.
  const after = await fetchCheckinStatus(fetcher, credential, ids).catch(() => undefined)
  return {
    outcome: "claimed",
    ...(after?.dailyCredit === undefined ? {} : { credit: after.dailyCredit }),
    message: "签到成功",
  }
}

/**
 * A business code, whether the service wrote it as a number or a string.
 *
 * Some gateways answer `"9074"` where others answer `9074`; reading only the
 * number would take the string form for success.
 */
function readCode(raw: unknown): number {
  const value = num(raw)
  if (value !== undefined) return value
  const text = str(raw)
  if (text === undefined) return raw === undefined ? 0 : -1
  const parsed = Number(text.trim())
  return Number.isFinite(parsed) ? parsed : -1
}

/** Whether the credits endpoint answered anything usable; used by the card to decide on an error line. */
export function creditsMissing(credits: TraeCredits | undefined): boolean {
  return credits === undefined || (credits.packs.length === 0 && credits.total === 0)
}
