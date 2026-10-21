/**
 * AStudio 的积分，作为宿主额度卡片的窗口。
 *
 * 服务给的是**按来源分池**的钱包（会员 / 购买 / 赠送 / 星火），每池自带
 * 到期时刻，没有「每日重置」的概念 —— 与 Loomy 的日池、Raccoon 的月池都
 * 不同。因此这里的窗口规则是：
 *
 * - **全部 `aside: true`**：积分按活动到期、用完即没，没有任何会自动回填的
 *   周期。把「已用百分比」交给宿主路由会让一个「积分即将到期」的账号被
 *   bench 到一个不存在的重置点，所以只展示、不参与选号（与 Raccoon 同款
 *   取舍，理由见 `docs/vendors.md`）。
 * - **主窗口是权威合计** `totalBalance`（不是逐池求和 —— 星火池与主池互不
 *   相通，求和会凭空多出星火那份）；`totalAmount` 在场时给出已用比例。
 * - 每个在场的池各占一行，到期时刻如实显示（上游给不带时区的本地时间串，
 *   按本机时区解析 —— 服务端时区未验证，见 `docs/vendors.md` 未验证边界）。
 */

import type { CheckinResult, UsageReport, UsageWindow } from "../../core/types.ts"
import type { ClaimOutcome, CreditBalance } from "./api.ts"

function round(value: number): number {
  return Math.round(value)
}

/** 到期时刻的展示：`MM-DD 到期`；解析不出就原样透出上游字符串。 */
function expiryText(pool: CreditBalance["pools"][number]): string {
  if (pool.expiresAtMs !== undefined) {
    const date = new Date(pool.expiresAtMs)
    const month = `${date.getMonth() + 1}`.padStart(2, "0")
    const day = `${date.getDate()}`.padStart(2, "0")
    return `${month}-${day} 到期`
  }
  return pool.expiresAtRaw === undefined ? "" : `${pool.expiresAtRaw} 到期`
}

/** 余额读数 → 窗口列表（全部 aside；池缺失就不出那一行）。 */
export function windowsOf(balance: CreditBalance): UsageWindow[] {
  const windows: UsageWindow[] = []
  const totalAmount = balance.totalAmount
  const spent =
    totalAmount !== undefined && totalAmount > 0 ? Math.max(0, totalAmount - balance.total) : undefined
  windows.push({
    name: "可用积分",
    used:
      spent === undefined || totalAmount === undefined || totalAmount <= 0
        ? 0
        : round((100 * spent) / totalAmount),
    aside: true,
    unit: "积分",
    ...(totalAmount === undefined
      ? { display: `可用 ${balance.total}` }
      : { display: `可用 ${balance.total} / 累计 ${totalAmount}` }),
  })
  for (const pool of balance.pools) {
    const expiry = expiryText(pool)
    // display 一行把剩余与到期一起说；到期缺失时只剩剩余。
    const amount =
      pool.total === undefined ? `剩余 ${pool.remaining}` : `剩余 ${pool.remaining} / ${pool.total}`
    windows.push({
      name: pool.name,
      used: 0,
      aside: true,
      unit: "积分",
      display: expiry.length === 0 ? amount : `${amount}（${expiry}）`,
    })
  }
  return windows
}

export function usageReport(balance: CreditBalance, options: { user?: string } = {}): UsageReport {
  return {
    balance: `${balance.total} 积分`,
    ...(options.user === undefined ? {} : { user: options.user }),
    windows: windowsOf(balance),
  }
}

/** 签到（弹窗领取）结果 → 宿主的 CheckinResult。 */
export function checkinResult(claim: ClaimOutcome): CheckinResult {
  switch (claim.outcome) {
    case "done":
      return { outcome: "done", credit: 0, message: claim.message }
    case "claimed":
      return {
        outcome: "claimed",
        ...(claim.credit === undefined ? {} : { credit: claim.credit }),
        message: claim.message,
      }
    default:
      return { outcome: "failed", message: claim.message }
  }
}
