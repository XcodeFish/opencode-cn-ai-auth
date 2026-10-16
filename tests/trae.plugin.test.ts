/**
 * 保护 vendors/trae/index.ts 的装配：config / auth / provider 三条钩子的形状，
 * 以及登录态缺失、目录回退、一键签到这三条最容易被写坏的路径。
 *
 * 全部用离线假 fetcher 驱动，不发真实请求（与 loomy / raccoon 的测试同一约定）。
 */

import { describe, expect, test } from "bun:test"
import { SignInExpiredError } from "../src/core/errors.ts"
import { TraeAuthPlugin } from "../src/vendors/trae/index.ts"
import { at, cannedFetch, fakeClient, jsonOk, providerOf } from "./helpers.ts"

describe("装配形状", () => {
  test("provider id / 名称 / 基础地址与两条钩子都在", async () => {
    const hooks = await TraeAuthPlugin({ client: fakeClient() })
    expect(hooks.auth.provider).toBe("trae-cn")
    expect(hooks.auth.methods.length).toBeGreaterThan(0)
    const provider = providerOf(hooks)
    expect(provider.id).toBe("trae-cn")
    expect(hooks.config).toBeDefined()
  })

  test("config 钩子注册 provider 与兜底模型表", async () => {
    const hooks = await TraeAuthPlugin({ client: fakeClient() })
    const config: { provider?: Record<string, { api?: string; models?: Record<string, unknown> }> } = {}
    hooks.config?.(config)
    const entry = config.provider?.["trae-cn"]
    expect(entry?.api).toBe("https://trae-api-cn.mchost.guru")
    expect(Object.keys(entry?.models ?? {}).length).toBeGreaterThan(0)
  })

  test("没有登录态时 loader 报需要重新登录", async () => {
    const hooks = await TraeAuthPlugin({ client: fakeClient() })
    await expect(
      hooks.auth.loader(async () => undefined, { id: "trae-cn", models: {} }),
    ).rejects.toBeInstanceOf(SignInExpiredError)
  })
})

describe("签到", () => {
  test("活动未开放时报 ineligible，且不发送领取请求", async () => {
    const calls: string[] = []
    const fetcher = cannedFetch([
      {
        match: "/checkin_credits/status",
        respond: () => jsonOk({ code: 0, enable: false, checked_in: false }),
      },
    ])
    // claimCheckin 直接驱动，避免依赖插件内部的全局 fetch。
    const { claimCheckin } = await import("../src/vendors/trae/credits.ts")
    const outcome = await claimCheckin(trackedFetcher(fetcher, calls), credentialOfTest(), idsOfTest())
    expect(outcome.outcome).toBe("ineligible")
    expect(calls.filter((url) => url.includes("claim"))).toHaveLength(0)
  })

  test("今天已签到时返回 done，并带上服务说出的当日奖励", async () => {
    const calls: string[] = []
    const fetcher = cannedFetch([
      {
        match: "/checkin_credits/status",
        respond: () => jsonOk({ code: 0, enable: true, checked_in: true, credits: 150 }),
      },
    ])
    const { claimCheckin } = await import("../src/vendors/trae/credits.ts")
    const outcome = await claimCheckin(trackedFetcher(fetcher, calls), credentialOfTest(), idsOfTest())
    expect(outcome.outcome).toBe("done")
    expect(outcome.credit).toBe(150)
    expect(calls.filter((url) => url.includes("claim"))).toHaveLength(0)
  })

  test("领取成功后再查一次状态拿积分数（claim 响应本身没有积分数）", async () => {
    const calls: string[] = []
    let statusRound = 0
    const fetcher = cannedFetch([
      {
        match: "/checkin_credits/status",
        respond: () => {
          statusRound += 1
          return jsonOk(
            statusRound === 1
              ? { code: 0, enable: true, checked_in: false, credits: 150 }
              : { code: 0, enable: true, checked_in: true, credits: 150 },
          )
        },
      },
      { match: "/checkin_credits/claim", respond: () => jsonOk({ code: 0, message: "success" }) },
    ])
    const { claimCheckin } = await import("../src/vendors/trae/credits.ts")
    const outcome = await claimCheckin(trackedFetcher(fetcher, calls), credentialOfTest(), idsOfTest())
    expect(outcome.outcome).toBe("claimed")
    expect(outcome.credit).toBe(150)
    expect(calls.filter((url) => url.includes("claim"))).toHaveLength(1)
  })

  test("9074 如实报失败并给出重试提示，不伪造成功", async () => {
    const fetcher = cannedFetch([
      {
        match: "/checkin_credits/status",
        respond: () => jsonOk({ code: 0, enable: true, checked_in: false }),
      },
      { match: "/checkin_credits/claim", respond: () => jsonOk({ code: 9074, message: "当前使用人数太多" }) },
    ])
    const { claimCheckin } = await import("../src/vendors/trae/credits.ts")
    const outcome = await claimCheckin(fetcher, credentialOfTest(), idsOfTest())
    expect(outcome.outcome).toBe("failed")
    expect(outcome.message).toContain("当前使用人数太多")
  })

  test("业务码是字符串形式的 9074 也不能当成功", async () => {
    const fetcher = cannedFetch([
      {
        match: "/checkin_credits/status",
        respond: () => jsonOk({ code: 0, enable: true, checked_in: false }),
      },
      { match: "/checkin_credits/claim", respond: () => jsonOk({ code: "9074", message: "忙" }) },
    ])
    const { claimCheckin } = await import("../src/vendors/trae/credits.ts")
    const outcome = await claimCheckin(fetcher, credentialOfTest(), idsOfTest())
    expect(outcome.outcome).toBe("failed")
  })

  test("HTTP 401 时如实报登录态失效", async () => {
    const { jsonFail } = await import("./helpers.ts")
    const fetcher = cannedFetch([
      {
        match: "/checkin_credits/status",
        respond: () => jsonOk({ code: 0, enable: true, checked_in: false }),
      },
      { match: "/checkin_credits/claim", respond: () => jsonFail({}, 401) },
    ])
    const { claimCheckin } = await import("../src/vendors/trae/credits.ts")
    const outcome = await claimCheckin(fetcher, credentialOfTest(), idsOfTest())
    expect(outcome.outcome).toBe("failed")
    expect(outcome.message).toContain("重新登录")
  })
})

describe("积分卡片", () => {
  test("每只包一条 aside 窗口，总额是剩余之和，不声称占比", async () => {
    const fetcher = cannedFetch([
      {
        match: "/ide_user_ent_usage",
        respond: () =>
          jsonOk({
            user_entitlement_pack_list: [
              {
                entitlement_base_info: { name: "签到奖励", quota: { credits_limit: 150 } },
                usage: { credits_amount: 0 },
              },
              {
                entitlement_base_info: { name: "通用", quota: { credits_limit: 2000 } },
                usage: { credits_amount: 500 },
              },
            ],
          }),
      },
    ])
    const { fetchCredits, usageReport } = await import("../src/vendors/trae/credits.ts")
    const credits = await fetchCredits(fetcher, credentialOfTest(), idsOfTest())
    expect(credits?.total).toBe(1650)
    if (credits === undefined) throw new Error("应当读到积分")
    const report = usageReport(credits, { user: "用户1234" })
    expect(report.balance).toBe("1650 积分")
    expect(report.windows).toHaveLength(2)
    for (const window of report.windows ?? []) {
      expect(window.aside).toBe(true)
      expect(window.used).toBe(0)
    }
    expect(at(report.windows ?? [], 0).display).toBe("签到奖励 150 / 150")
  })
})

// ── 小工具 ────────────────────────────────────────────────────────────────────

/** 记录被调用 URL 的包装，用于断言「没有发送某个请求」。 */
function trackedFetcher(fetcher: typeof fetch, calls: string[]): typeof fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    return await fetcher(input, init)
  }
  return wrapped as typeof fetch
}

function credentialOfTest() {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    uid: "uid-1",
    machineId: "a".repeat(32),
    deviceId: "b".repeat(32),
  }
}

function idsOfTest(): { requestId: string; traceId: string } {
  return { requestId: "req-1", traceId: "00-trace-01" }
}
