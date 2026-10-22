/**
 * 保护宠物每日打工（pet-work）的读数与领奖：快照形状（配置版本在
 * `config.version`、领奖请求体里叫 `configVersion`）、按已发档位推进、
 * 封顶不发请求、未达档位不冒充领到、100002 抛失效、读不到时保持沉默，
 * 以及卡片那一行的显示与缓存。
 *
 * 全部离线：快照与回执都按 2026-10-23 的实测形状造（见 docs/vendors.md）。
 */

import { describe, expect, test } from "bun:test"
import { SignInExpiredError } from "../src/core/errors.ts"
import { fetchPetWork } from "../src/vendors/loomy/api.ts"
import {
  claimPetWork,
  forgetPetWorkReadings,
  petWorkStateFor,
  petWorkWindow,
} from "../src/vendors/loomy/petwork.ts"
import { cannedFetch, type FetchInit, type FetchResponse, jsonOk, rejectionError } from "./helpers.ts"

const AUTH = { type: "oauth", access: "sess-1", userid: "u-1" }

const TIERS = [
  { tierId: "tier_1", score: 60 },
  { tierId: "tier_2", score: 100 },
  { tierId: "tier_3", score: 150 },
]

interface SnapshotOptions {
  enabled?: boolean
  rewarded?: string[]
  earned?: number
  capped?: boolean
  tiers?: unknown
}

/** `GET /pet-work` 的实测形状。 */
function snapshot(options: SnapshotOptions = {}) {
  return jsonOk({
    code: "000000",
    desc: "成功",
    data: {
      enabled: options.enabled ?? true,
      businessDate: "2026-10-23",
      config: {
        version: "pet-work-v1",
        dailyMaxPoints: 1000,
        tiers: options.tiers === undefined ? TIERS : options.tiers,
      },
      status: {
        earnedPointsToday: options.earned ?? 0,
        rewardedTierIds: options.rewarded ?? [],
        dailyRewardCapped: options.capped ?? false,
      },
    },
  })
}

/** `POST /pet-work/rewards` 的回执：granted / duplicate / 未达档位三种形态。 */
function grant(options: {
  granted?: boolean
  duplicate?: boolean
  points?: number
  tiers?: string[]
  earned?: number
  capped?: boolean
}) {
  return jsonOk({
    code: "000000",
    desc: "成功",
    data: {
      businessDate: "2026-10-23",
      grantBatchId: options.granted === true ? "pwg_1" : "",
      granted: options.granted ?? false,
      duplicate: options.duplicate ?? false,
      grantedPoints: options.points ?? 0,
      grantedTierIds: options.tiers ?? [],
      status: {
        earnedPointsToday: options.earned ?? 0,
        rewardedTierIds: options.tiers ?? [],
        dailyRewardCapped: options.capped ?? false,
      },
    },
  })
}

/**
 * 按请求体里的 `reachedTierId` 作答：表里没有的档位一律回「未达档位」，
 * 并带上当时已经拿到的累计分（回执里 `status.earnedPointsToday` 是权威值）。
 */
function rewardsByTier(answers: Record<string, FetchResponse>, notReachedEarned: number) {
  return (_url: string, init: FetchInit | undefined): FetchResponse => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { reachedTierId?: string }
    const answer = answers[body.reachedTierId ?? ""]
    return (answer ?? grant({ granted: false, earned: notReachedEarned })).clone() as FetchResponse
  }
}

describe("pet-work 快照", () => {
  test("按实测形状读：配置版本在 config.version，档位与当日累计都拿到", async () => {
    const fetcher = cannedFetch([
      { match: "/pet-work", respond: snapshot({ earned: 300, rewarded: ["tier_1"] }) },
    ])
    const result = await fetchPetWork(fetcher, "sess-1")
    if (!result.ok) throw new Error("快照必须读成功")
    expect(result.data.enabled).toBe(true)
    expect(result.data.businessDate).toBe("2026-10-23")
    // ⚠️ 快照里是 config.version；领奖请求体里是 configVersion。
    expect(result.data.configVersion).toBe("pet-work-v1")
    expect(result.data.dailyMax).toBe(1000)
    expect(result.data.tiers).toStrictEqual([
      { id: "tier_1", score: 60 },
      { id: "tier_2", score: 100 },
      { id: "tier_3", score: 150 },
    ])
    expect(result.data.earnedToday).toBe(300)
    expect(result.data.nextTier).toBe("tier_2")
  })

  test("已发档位决定下一次申请哪一档；全领完就没有可申请的", async () => {
    const partial = await fetchPetWork(
      cannedFetch([{ match: "/pet-work", respond: snapshot({ rewarded: ["tier_1", "tier_2"] }) }]),
      "sess-1",
    )
    expect(partial.ok && partial.data.nextTier).toBe("tier_3")

    const all = await fetchPetWork(
      cannedFetch([{ match: "/pet-work", respond: snapshot({ rewarded: ["tier_1", "tier_2", "tier_3"] }) }]),
      "sess-1",
    )
    expect(all.ok && all.data.nextTier).toBeUndefined()
  })

  test("拿不到档位表时不猜更高档：tier_1 已发就视为完成", async () => {
    const fresh = await fetchPetWork(
      cannedFetch([{ match: "/pet-work", respond: snapshot({ tiers: [] }) }]),
      "sess-1",
    )
    expect(fresh.ok && fresh.data.nextTier).toBe("tier_1")

    const done = await fetchPetWork(
      cannedFetch([{ match: "/pet-work", respond: snapshot({ tiers: [], rewarded: ["tier_1"] }) }]),
      "sess-1",
    )
    expect(done.ok && done.data.nextTier).toBeUndefined()
  })

  test("配置版本平铺在 data 上时也读得到（历史形状）", async () => {
    const fetcher = cannedFetch([
      {
        match: "/pet-work",
        respond: jsonOk({
          code: "000000",
          data: { enabled: true, businessDate: "2026-10-23", configVersion: "pet-work-v9", status: {} },
        }),
      },
    ])
    const result = await fetchPetWork(fetcher, "sess-1")
    expect(result.ok && result.data.configVersion).toBe("pet-work-v9")
    // 没有档位表、也没发过档：兜底申请最低档。
    expect(result.ok && result.data.nextTier).toBe("tier_1")
  })
})

describe("pet-work 领奖", () => {
  test("请求体只有三个字段，configVersion 取自快照而不是常量", async () => {
    const fetcher = cannedFetch([
      {
        match: "/pet-work/rewards",
        respond: rewardsByTier(
          { tier_1: grant({ granted: true, points: 200, tiers: ["tier_1"], earned: 200 }) },
          200,
        ),
      },
      { match: "/pet-work", respond: snapshot() },
    ])
    await claimPetWork(fetcher, "sess-1", AUTH)
    const calls = fetcher.callsMatching("/pet-work/rewards")
    // tier_1 领到，tier_2 未达就停手：不会把三档都撞一遍。
    expect(calls).toHaveLength(2)
    expect(JSON.parse(String(calls[0]?.init?.body))).toStrictEqual({
      businessDate: "2026-10-23",
      configVersion: "pet-work-v1",
      reachedTierId: "tier_1",
    })
    expect(calls[0]?.init?.method).toBe("POST")
    expect(JSON.parse(String(calls[1]?.init?.body)).reachedTierId).toBe("tier_2")
  })

  test("granted=true 时把发放额报出来", async () => {
    const fetcher = cannedFetch([
      {
        match: "/pet-work/rewards",
        respond: rewardsByTier(
          { tier_1: grant({ granted: true, points: 200, tiers: ["tier_1"], earned: 200 }) },
          200,
        ),
      },
      { match: "/pet-work", respond: snapshot() },
    ])
    const result = await claimPetWork(fetcher, "sess-1", AUTH)
    expect(result.outcome).toBe("claimed")
    expect(result.points).toBe(200)
    expect(result.message).toBe("宠物打工奖励 +200 分")
  })

  test("一天攒下多档时逐档领完，某档未达就停手", async () => {
    const fetcher = cannedFetch([
      {
        match: "/pet-work/rewards",
        respond: rewardsByTier(
          {
            tier_1: grant({ granted: true, points: 200, tiers: ["tier_1"], earned: 200 }),
            tier_2: grant({ granted: true, points: 300, tiers: ["tier_2"], earned: 500 }),
          },
          500,
        ),
      },
      { match: "/pet-work", respond: snapshot() },
    ])
    const result = await claimPetWork(fetcher, "sess-1", AUTH)
    expect(result.outcome).toBe("claimed")
    expect(result.points).toBe(500)
    expect(result.message).toBe("宠物打工奖励 +500 分")
    // tier_3 没达标：请求发了，但结果不再往上报。
    expect(fetcher.callsMatching("/pet-work/rewards")).toHaveLength(3)
  })

  test("duplicate 是「今天已领过」，不是又领了一次", async () => {
    const fetcher = cannedFetch([
      { match: "/pet-work/rewards", respond: grant({ duplicate: true, earned: 1000, capped: true }) },
      { match: "/pet-work", respond: snapshot({ earned: 500, rewarded: ["tier_1"] }) },
    ])
    const result = await claimPetWork(fetcher, "sess-1", AUTH)
    expect(result.outcome).toBe("done")
    expect(result.points).toBe(0)
    expect(result.message).toBe("今日宠物打工积分已领取（1000 分）")
  })

  test("封顶时一个领奖请求都不发", async () => {
    const fetcher = cannedFetch([
      {
        match: "/pet-work",
        respond: snapshot({ earned: 1000, rewarded: ["tier_1", "tier_2", "tier_3"], capped: true }),
      },
    ])
    const result = await claimPetWork(fetcher, "sess-1", AUTH)
    expect(result.outcome).toBe("done")
    expect(result.message).toContain("已领取")
    expect(fetcher.callsMatching("/pet-work/rewards")).toHaveLength(0)
  })

  test("未达档位如实上报，不冒充领到", async () => {
    const fetcher = cannedFetch([
      { match: "/pet-work/rewards", respond: grant({ granted: false }) },
      { match: "/pet-work", respond: snapshot() },
    ])
    const result = await claimPetWork(fetcher, "sess-1", AUTH)
    expect(result.outcome).toBe("notReached")
    expect(result.points).toBe(0)
    expect(result.message).toContain("未达档位")
  })

  test("有档位但没回填金额时按今日累计差分，不编数字", async () => {
    const fetcher = cannedFetch([
      {
        match: "/pet-work/rewards",
        respond: rewardsByTier({ tier_2: grant({ granted: false, tiers: ["tier_2"], earned: 300 }) }, 300),
      },
      { match: "/pet-work", respond: snapshot({ earned: 100, rewarded: ["tier_1"] }) },
    ])
    const result = await claimPetWork(fetcher, "sess-1", AUTH)
    expect(result.outcome).toBe("claimed")
    expect(result.points).toBe(200)
    expect(result.message).toContain("差分")
  })

  test("业务码失败如实返回 failed，带厂商原话", async () => {
    const fetcher = cannedFetch([
      { match: "/pet-work/rewards", respond: jsonOk({ code: "520001", desc: "额度服务抖动" }) },
      { match: "/pet-work", respond: snapshot() },
    ])
    const result = await claimPetWork(fetcher, "sess-1", AUTH)
    expect(result.outcome).toBe("failed")
    expect(result.message).toBe("宠物打工领取失败：额度服务抖动")
  })

  test("100002 抛 SignInExpiredError，让宿主标记账号", async () => {
    const fetcher = cannedFetch([
      { match: "/pet-work/rewards", respond: jsonOk({ code: "100002", desc: "缺少 token" }) },
      { match: "/pet-work", respond: snapshot() },
    ])
    const error = await rejectionError(() => claimPetWork(fetcher, "sess-1", AUTH))
    expect(error).toBeInstanceOf(SignInExpiredError)
    expect(error.message).toBe("loomy: 宠物打工被拒绝：缺少 token")
  })

  test("快照读不到时保持沉默：只有日志细节，没有给用户的结论", async () => {
    // 没有路由 ⇒ cannedFetch 抛错 ⇒ productRead 归成 NETWORK 失败。
    const fetcher = cannedFetch([])
    const result = await claimPetWork(fetcher, "sess-1", AUTH)
    expect(result.outcome).toBe("failed")
    expect(result.message).toBeUndefined()
    expect(result.detail).toContain("读 pet-work 快照失败")
  })

  test("活动关闭时不发领奖请求", async () => {
    const fetcher = cannedFetch([{ match: "/pet-work", respond: snapshot({ enabled: false }) }])
    const result = await claimPetWork(fetcher, "sess-1", AUTH)
    expect(result.outcome).toBe("inactive")
    expect(result.message).toBe("宠物打工活动当前未开启")
    expect(fetcher.callsMatching("/pet-work/rewards")).toHaveLength(0)
  })
})

describe("宠物打工的卡片行", () => {
  test("一分没有时说清原因，且不参与选号", () => {
    const window = petWorkWindow({
      enabled: true,
      businessDate: "2026-10-23",
      configVersion: "pet-work-v1",
      dailyMax: 1000,
      tiers: [{ id: "tier_1", score: 60 }],
      earnedToday: 0,
      rewardedTiers: [],
      capped: false,
      nextTier: "tier_1",
    })
    expect(window?.aside).toBe(true)
    expect(window?.used).toBe(0)
    expect(window?.display).toBe("宠物打工 今日 0/1000 · 未达档位")
    // 不带 limit/amount：卡片不该把它画成「池子被花掉多少」。
    expect(window?.limit).toBeUndefined()
    expect(window?.amount).toBeUndefined()
  })

  test("已领部分档位时显示进度", () => {
    const window = petWorkWindow({
      enabled: true,
      dailyMax: 1000,
      tiers: [
        { id: "tier_1", score: 60 },
        { id: "tier_2", score: 100 },
        { id: "tier_3", score: 150 },
      ],
      earnedToday: 300,
      rewardedTiers: ["tier_1"],
      capped: false,
      nextTier: "tier_2",
    })
    expect(window?.display).toBe("宠物打工 今日 300/1000 · 已领 1/3 档")
  })

  test("封顶与活动关闭都不显示", () => {
    const base = {
      enabled: true,
      dailyMax: 1000,
      tiers: [{ id: "tier_1", score: 60 }],
      earnedToday: 1000,
      rewardedTiers: ["tier_1"],
    }
    expect(petWorkWindow({ ...base, capped: true })).toBeUndefined()
    expect(petWorkWindow({ ...base, capped: false, enabled: false })).toBeUndefined()
    expect(petWorkWindow(undefined)).toBeUndefined()
  })

  test("读数按账号缓存：同一次刷新里不重复打上游", async () => {
    forgetPetWorkReadings()
    const fetcher = cannedFetch([{ match: "/pet-work", respond: snapshot() }])
    const now = 1_000_000
    const first = await petWorkStateFor(fetcher, AUTH, "sess-1", now)
    const second = await petWorkStateFor(fetcher, AUTH, "sess-1", now + 60_000)
    expect(first?.enabled).toBe(true)
    expect(second?.enabled).toBe(true)
    expect(fetcher.calls.filter((call) => call.url.endsWith("/pet-work"))).toHaveLength(1)
  })

  test("领奖之后缓存作废，下一次读拿到新进度", async () => {
    forgetPetWorkReadings()
    let claimed = false
    const fetcher = cannedFetch([
      {
        match: "/pet-work/rewards",
        respond: () => {
          claimed = true
          return grant({ granted: true, points: 200, tiers: ["tier_1"], earned: 200 })
        },
      },
      {
        match: "/pet-work",
        respond: () => snapshot({ earned: claimed ? 200 : 0, rewarded: claimed ? ["tier_1"] : [] }),
      },
    ])
    const before = await petWorkStateFor(fetcher, AUTH, "sess-1", 1_000_000)
    expect(before?.earnedToday).toBe(0)

    await claimPetWork(fetcher, "sess-1", AUTH)

    const after = await petWorkStateFor(fetcher, AUTH, "sess-1", 1_000_100)
    expect(after?.earnedToday).toBe(200)
    // 三次快照：卡片第一次读、领奖自己要先读一次、卡片第二次读（缓存已作废）。
    // 只数快照那一路：`/pet-work/rewards` 也含 `/pet-work` 这个子串。
    const snapshots = fetcher.calls.filter((call) => call.url.endsWith("/pet-work"))
    expect(snapshots).toHaveLength(3)
  })
})
