/**
 * 保护 vendors/raccoon/usage.ts：服务只报每个池子还剩多少、从不报额度，
 * 所以每条窗口都是 `aside: true`（只展示、不参与选号），顺序是服务自己的
 * 每日 / 月度 / 奖励 / 充值，没有报的池子不造窗口，没有 total 就不编总账。
 */

import { describe, expect, test } from "bun:test"
import { balanceWindows, usageReport } from "../src/vendors/raccoon/usage.ts"
import { at } from "./helpers.ts"

const BALANCE = { available: 1234, daily: 100, monthly: 200, reward: 30, topup: 900 }

describe("balanceWindows", () => {
  test("按服务的顺序给四条窗口，全部 aside 且不声称占比", () => {
    expect(balanceWindows(BALANCE)).toStrictEqual([
      { name: "每日积分", used: 0, aside: true, unit: "积分", display: "每日积分 100" },
      { name: "月度积分", used: 0, aside: true, unit: "积分", display: "月度积分 200" },
      { name: "奖励积分", used: 0, aside: true, unit: "积分", display: "奖励积分 30" },
      { name: "充值积分", used: 0, aside: true, unit: "积分", display: "充值积分 900" },
    ])
    for (const window of balanceWindows(BALANCE)) {
      expect(window.aside).toBe(true)
      expect(window.used).toBe(0)
      expect("limit" in window).toBe(false)
      expect("amount" in window).toBe(false)
      expect("resetsAt" in window).toBe(false)
    }
  })

  test("服务没报的池子不造窗口", () => {
    expect(balanceWindows({ available: 7 })).toStrictEqual([])
    expect(balanceWindows({})).toStrictEqual([])
    expect(balanceWindows({ daily: 0 })).toStrictEqual([
      { name: "每日积分", used: 0, aside: true, unit: "积分", display: "每日积分 0" },
    ])
  })
})

describe("usageReport", () => {
  test("available 给 balance，user 只在给定时出现", () => {
    expect(usageReport(BALANCE, { user: "138****5678" })).toStrictEqual({
      user: "138****5678",
      balance: "1234 积分",
      windows: [
        { name: "每日积分", used: 0, aside: true, unit: "积分", display: "每日积分 100" },
        { name: "月度积分", used: 0, aside: true, unit: "积分", display: "月度积分 200" },
        { name: "奖励积分", used: 0, aside: true, unit: "积分", display: "奖励积分 30" },
        { name: "充值积分", used: 0, aside: true, unit: "积分", display: "充值积分 900" },
      ],
    })
    const bare = usageReport(BALANCE)
    expect(bare.balance).toBe("1234 积分")
    expect("user" in bare).toBe(false)
  })

  test("没有 available 时不编总账", () => {
    const report = usageReport({ daily: 100 })
    expect("balance" in report).toBe(false)
    expect(report.windows).toHaveLength(1)
    expect(at(report.windows ?? [], 0).name).toBe("每日积分")
  })
})
