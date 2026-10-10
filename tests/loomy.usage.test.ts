/**
 * 保护 vendors/loomy/usage.ts：知道 quota 与 consumed 时今日窗口参与选号、
 * 不知道 quota 时只是 aside 展示、永久积分恒 aside、resetsAt 落在下一个
 * 北京时间 00:05（跨日边界也对），以及签到的 done / claimed 与 credit 算法。
 * `quotaForNow` 一节保护"签到记住的 quota 真的被 usage 读回"这条接线：
 * 曾经它只写不读，今日窗口因此永远停在"上限未知"，永远不参与选号。
 * 末尾一节保护 `balance.ts` 的锁永久积分门禁（缓存 TTL、fail-open、按账号）。
 */

import { describe, expect, test } from "bun:test"
import {
  forgetDailyBalances,
  LOOMY_BALANCE_TTL_MS,
  LOOMY_LOCKED_REFUSAL,
  lockedRefusal,
  rememberDailyBalance,
} from "../src/vendors/loomy/balance.ts"
import {
  beijingResetAt,
  checkinResult,
  quotaForNow,
  usageReport,
  windowsOf,
} from "../src/vendors/loomy/usage.ts"
import { at } from "./helpers.ts"

// 北京时间 2026-10-09 20:00
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)
// 下一个北京时间零点（2026-10-10 00:05）对应的 UTC 时刻
const NEXT_RESET = Date.UTC(2026, 9, 9, 16, 5, 0)

describe("windowsOf", () => {
  test("quota 与 consumed 都有时是参与选号的窗口", () => {
    const windows = windowsOf({ dailyQuota: 5000, dailyConsumed: 1250, daily: 3750 }, NOW)
    expect(windows).toStrictEqual([
      {
        name: "今日积分",
        used: 25,
        resetsAt: NEXT_RESET,
        amount: 1250,
        limit: 5000,
        unit: "积分",
        display: "今日 3750 / 5000",
      },
    ])
    expect("aside" in at(windows, 0)).toBe(false)
    expect(at(windows, 0).resetsAt).toBeGreaterThan(NOW)
  })

  test("used 是四舍五入的百分比", () => {
    const windows = windowsOf({ dailyQuota: 3000, dailyConsumed: 1000 }, NOW)
    expect(at(windows, 0).used).toBe(33)
    expect(at(windows, 0).display).toBe("今日 2000 / 3000")
  })

  test("quota 未知时只做 aside 展示，不说占比", () => {
    const windows = windowsOf({ daily: 3800 }, NOW)
    expect(windows).toStrictEqual([
      {
        name: "今日积分",
        used: 0,
        aside: true,
        resetsAt: NEXT_RESET,
        display: "今日剩余 3800",
        unit: "积分",
      },
    ])
    expect("limit" in at(windows, 0)).toBe(false)
    expect("amount" in at(windows, 0)).toBe(false)
  })

  test("永久积分恒 aside 且没有 resetsAt", () => {
    const windows = windowsOf({ permanent: 120 }, NOW)
    expect(windows).toStrictEqual([
      { name: "永久积分", used: 0, aside: true, unit: "积分", display: "永久积分 120" },
    ])
    expect("resetsAt" in at(windows, 0)).toBe(false)
  })

  test("只知道 quota 时不造窗口", () => {
    expect(windowsOf({ dailyQuota: 5000 }, NOW)).toStrictEqual([])
  })

  test("两个池都给时是两条窗口，只有今日那条参与选号", () => {
    const windows = windowsOf(
      { dailyQuota: 5000, dailyConsumed: 1000, daily: 4000, permanent: 120, available: 4120 },
      NOW,
    )
    expect(windows.map((window) => window.name)).toStrictEqual(["今日积分", "永久积分"])
    expect(at(windows, 0).aside).toBeUndefined()
    expect(at(windows, 1).aside).toBe(true)
  })
})

describe("beijingResetAt", () => {
  test("落在下一个北京时间 00:05", () => {
    expect(beijingResetAt(NOW)).toBe(NEXT_RESET)
    // 北京 23:59 时下一个零点仍是同一时刻
    expect(beijingResetAt(Date.UTC(2026, 9, 9, 15, 59, 0))).toBe(NEXT_RESET)
  })

  test("未来一天的 cycleDate 以它为准", () => {
    expect(beijingResetAt(NOW, "2026-10-11")).toBe(Date.UTC(2026, 9, 11, 16, 5, 0))
  })

  test("跨日边界：cycleDate 到点后退回下一个北京零点", () => {
    // 北京 2026-10-10 00:04，cycleDate 写的是前一天 2026-10-09
    const justBefore = Date.UTC(2026, 9, 9, 16, 4, 0)
    expect(beijingResetAt(justBefore, "2026-10-09")).toBe(Date.UTC(2026, 9, 10, 16, 5, 0))
    expect(beijingResetAt(NOW, "not-a-date")).toBe(NEXT_RESET)
  })
})

describe("usageReport", () => {
  test("balance 用 available，带上 user", () => {
    const report = usageReport(
      { permanent: 10, daily: 3800, available: 3810 },
      { user: "138****5678", now: NOW },
    )
    expect(report.balance).toBe("3810 积分")
    expect(report.user).toBe("138****5678")
    expect(report.windows).toHaveLength(2)
  })

  test("没有 available 时 balance 是两池之和", () => {
    expect(usageReport({ permanent: 10, daily: 3800 }, { now: NOW }).balance).toBe("3810 积分")
    const empty = usageReport({}, { now: NOW })
    expect(empty.balance).toBe("0 积分")
    expect("user" in empty).toBe(false)
    expect(empty.windows).toStrictEqual([])
  })
})

describe("quotaForNow", () => {
  test("读数没带 quota 时补上账号记住的那份，今日窗口参与选号", () => {
    const points = quotaForNow({ daily: 3750 }, { dailyQuota: 5000, dailyCycleDate: "2026-10-09" }, NOW)
    expect(points.dailyQuota).toBe(5000)
    // 读数没带 consumed，用服务端自己的算式补出来：5000 - 3750 = 1250
    expect(windowsOf(points, NOW)).toStrictEqual([
      {
        name: "今日积分",
        used: 25,
        resetsAt: NEXT_RESET,
        amount: 1250,
        limit: 5000,
        unit: "积分",
        display: "今日 3750 / 5000",
      },
    ])
  })

  test("读数自己带 quota 时不覆盖，只补 cycleDate", () => {
    const points = quotaForNow(
      { dailyQuota: 3000, dailyConsumed: 1000, dailyCycleDate: "2026-10-09" },
      { dailyQuota: 5000, dailyCycleDate: "2026-10-10" },
      NOW,
    )
    expect(points.dailyQuota).toBe(3000)
    expect(points.dailyCycleDate).toBe("2026-10-09")
    expect(at(windowsOf(points, NOW), 0).limit).toBe(3000)
  })

  test("记住的 quota 属于已经重置的昨天时不继承", () => {
    // NOW 是北京 2026-10-09 20:00；cycleDate 2026-10-08 的重置早就过了
    const points = quotaForNow({ daily: 3750 }, { dailyQuota: 5000, dailyCycleDate: "2026-10-08" }, NOW)
    expect(points.dailyQuota).toBeUndefined()
    expect(windowsOf(points, NOW)).toStrictEqual([
      {
        name: "今日积分",
        used: 0,
        aside: true,
        resetsAt: NEXT_RESET,
        display: "今日剩余 3750",
        unit: "积分",
      },
    ])
  })

  test("没有记住的 quota、或它不是正数时，读数原样不动", () => {
    expect(quotaForNow({ daily: 10 }, {}, NOW)).toStrictEqual({ daily: 10 })
    expect(quotaForNow({ daily: 10 }, { dailyQuota: 0 }, NOW)).toStrictEqual({ daily: 10 })
    expect(quotaForNow({ daily: 10 }, { dailyQuota: -1 }, NOW)).toStrictEqual({ daily: 10 })
  })

  test("记住的 cycleDate 在没有读数日期时也带上（重置时间按它算）", () => {
    const points = quotaForNow({ daily: 1000 }, { dailyQuota: 5000, dailyCycleDate: "2026-10-10" }, NOW)
    expect(points.dailyCycleDate).toBe("2026-10-10")
    expect(beijingResetAt(NOW, points.dailyCycleDate)).toBe(Date.UTC(2026, 9, 10, 16, 5, 0))
  })
})

describe("checkinResult", () => {
  test("alreadyProcessed 是 done，不是 claimed", () => {
    expect(checkinResult({ alreadyProcessed: true, dailyQuota: 5000, daily: 3800 })).toStrictEqual({
      outcome: "done",
      credit: 0,
      message: "今日额度已初始化（今日 3800/5000）",
    })
    expect(checkinResult({ alreadyProcessed: true })).toStrictEqual({
      outcome: "done",
      credit: 0,
      message: "今日额度已初始化",
    })
  })

  test("新发放时 credit = quota - consumed，且不为负", () => {
    expect(
      checkinResult({ alreadyProcessed: false, dailyQuota: 5000, dailyConsumed: 1200, daily: 3800 }),
    ).toStrictEqual({
      outcome: "claimed",
      credit: 3800,
      message: "今日额度已发放（今日 3800/5000）",
    })
    expect(
      checkinResult({ alreadyProcessed: false, dailyQuota: 5000, dailyConsumed: 6000, daily: 0 }),
    ).toStrictEqual({
      outcome: "claimed",
      credit: 0,
      message: "今日额度已发放（今日 0/5000）",
    })
    expect(checkinResult({ alreadyProcessed: false, dailyQuota: 5000 })).toStrictEqual({
      outcome: "claimed",
      credit: 5000,
      message: "今日额度已发放（今日 0/5000）",
    })
    expect(checkinResult({ alreadyProcessed: false })).toStrictEqual({
      outcome: "claimed",
      credit: 0,
      message: "今日额度已发放",
    })
  })
})

describe("锁永久积分的门禁", () => {
  const AUTH = { userid: "u-1", access: "sess-1" }

  test("未锁定时永不拒绝", () => {
    forgetDailyBalances()
    rememberDailyBalance(AUTH, 0)
    expect(lockedRefusal(AUTH, {})).toBeUndefined()
    expect(lockedRefusal(AUTH, { lockPermanent: false })).toBeUndefined()
  })

  test("锁定但不知道余额时放行（fail-open，宁可少拦不可误伤）", () => {
    forgetDailyBalances()
    expect(lockedRefusal(AUTH, { lockPermanent: true })).toBeUndefined()
  })

  test("锁定 + 今日余额为 0 → 拒绝，文案不带余额/充值字样", () => {
    forgetDailyBalances()
    rememberDailyBalance(AUTH, 0)
    const refusal = lockedRefusal(AUTH, { lockPermanent: true })
    expect(refusal).toBe(LOOMY_LOCKED_REFUSAL)
    expect(refusal).toContain("额度")
    expect(refusal).not.toMatch(/余额|充值|余额不足/)
    expect(refusal).toContain("lockPermanent")
  })

  test("锁定 + 今日还有余额 → 放行（哪怕永久积分也是 0）", () => {
    forgetDailyBalances()
    rememberDailyBalance(AUTH, 1)
    expect(lockedRefusal(AUTH, { lockPermanent: true })).toBeUndefined()
  })

  test("读数过期就当作不知道：过期后放行", () => {
    forgetDailyBalances()
    // 写入时间由实现自己盖章，所以基准取系统的现在：紧挨着 TTL 内仍算新，
    // 超过 TTL 就当作不知道。
    const at = Date.now()
    rememberDailyBalance(AUTH, 0)
    expect(lockedRefusal(AUTH, { lockPermanent: true }, at + LOOMY_BALANCE_TTL_MS - 1)).toBe(
      LOOMY_LOCKED_REFUSAL,
    )
    expect(lockedRefusal(AUTH, { lockPermanent: true }, at + LOOMY_BALANCE_TTL_MS + 5_000)).toBeUndefined()
  })

  test("两个账号各记各的", () => {
    forgetDailyBalances()
    rememberDailyBalance(AUTH, 0)
    rememberDailyBalance({ userid: "u-2", access: "sess-2" }, 500)
    expect(lockedRefusal(AUTH, { lockPermanent: true })).toBe(LOOMY_LOCKED_REFUSAL)
    expect(lockedRefusal({ userid: "u-2", access: "sess-2" }, { lockPermanent: true })).toBeUndefined()
  })

  test("没有 userid 时用会话做键；两者都没有则不记", () => {
    forgetDailyBalances()
    rememberDailyBalance({ access: "sess-9" }, 0)
    expect(lockedRefusal({ access: "sess-9" }, { lockPermanent: true })).toBe(LOOMY_LOCKED_REFUSAL)
    forgetDailyBalances()
    rememberDailyBalance({}, 0)
    expect(lockedRefusal({}, { lockPermanent: true })).toBeUndefined()
  })
})
