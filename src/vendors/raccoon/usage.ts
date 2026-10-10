/**
 * Raccoon's points, as the host's usage card reads them.
 *
 * The balance endpoint answers four pools plus a total (`available_points`,
 * `reward_points`, `daily_points`, `monthly_points`, `topup_points`), and it
 * answers nothing else: the service states how much is left in each pool and
 * never how much it started with, so no pool can be turned into the share of
 * an allowance that the host routes by.
 *
 * Every window here is therefore `aside: true` — shown on the card, and not
 * a reason to route to or away from this account. The alternative would be
 * to assume a ceiling (the daily grant is believed to be 300, which is not
 * something the service says) and let that assumption order a user's
 * accounts; the numbers are reported, the claim is not made.
 *
 * `docs/vendors.md` records what the fields are read from and which of them
 * are still assumptions.
 */

import type { UsageReport, UsageWindow } from "../../core/types.ts"
import type { RaccoonBalance } from "./api.ts"

/** A pool as the card shows it: the amount, named, and nothing inferred. */
function pool(name: string, points: number | undefined): UsageWindow | undefined {
  if (points === undefined) return undefined
  return { name, used: 0, aside: true, unit: "积分", display: `${name} ${points}` }
}

/** The pools the service answered, in the order it lists them. */
export function balanceWindows(balance: RaccoonBalance): UsageWindow[] {
  const windows: UsageWindow[] = []
  const pools = [
    pool("每日积分", balance.daily),
    pool("月度积分", balance.monthly),
    pool("奖励积分", balance.reward),
    pool("充值积分", balance.topup),
  ]
  for (const window of pools) {
    if (window !== undefined) windows.push(window)
  }
  return windows
}

export function usageReport(balance: RaccoonBalance, options: { user?: string } = {}): UsageReport {
  return {
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(balance.available === undefined ? {} : { balance: `${balance.available} 积分` }),
    windows: balanceWindows(balance),
  }
}
