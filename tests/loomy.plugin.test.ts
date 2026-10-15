/**
 * 保护 vendors/loomy/index.ts 的装配：config 声明 provider、两个登录方法、
 * loader 把 session 放进 apiKey 与 headers、没有 session 的入口（loader /
 * checkin）抛 signIn:"expired"、usage 缺 session 时直接报 expired、
 * provider.models 在没有账号时把 given 原样交回，以及 loader 返回的 fetch
 * 真的挂着"锁定永久积分"的门禁。全部不碰网络。
 */

import { describe, expect, test } from "bun:test"
import { SignInExpiredError } from "../src/core/errors.ts"
import type { ConfigProvider, Hooks, ProviderInfo } from "../src/core/types.ts"
import { forgetDailyBalances, rememberDailyBalance } from "../src/vendors/loomy/balance.ts"
import { LoomyAuthPlugin } from "../src/vendors/loomy/index.ts"
import { forgetTaskReadings } from "../src/vendors/loomy/tasks.ts"
import { cannedFetch, fakeClient, jsonFail, jsonOk, providerOf, rejectionError } from "./helpers.ts"

const PROVIDER: ProviderInfo = { id: "loomy", models: {} }
const AUTH = { type: "oauth", access: "sess-1", userid: "u-1", expires: Date.now() + 86_400_000 }

async function loomyHooks(options: Record<string, unknown> = {}): Promise<Hooks> {
  return await LoomyAuthPlugin({ client: fakeClient() }, options)
}

describe("LoomyAuthPlugin 的钩子形状", () => {
  test("provider、checkin 与登录方法都在", async () => {
    const hooks = await loomyHooks()
    expect(hooks.auth.provider).toBe("loomy")
    expect(providerOf(hooks).id).toBe("loomy")
    expect(typeof hooks.auth.checkin).toBe("function")
    expect(hooks.auth.refresh).toBeUndefined()
    expect(hooks.auth.methods.map((method) => method.label)).toStrictEqual(["微信扫码登录", "短信验证码登录"])
  })

  test("icon 是厂商自己托管的 https 图片（裸图标名会被宿主静默丢弃）", async () => {
    const hooks = await loomyHooks()
    // host 的 iconOf 只保留 https:// 与 data:image/；写成 spark-color 这类
    // 内置图标名不会报错，只是没有图标，所以这条要盯住。
    expect(hooks.auth.icon).toBe("https://loomy.xunfei.cn/icon.png")
    expect(hooks.auth.icon?.startsWith("https://")).toBe(true)
  })

  test("config 声明 loomy provider 与内置模型表", async () => {
    const hooks = await loomyHooks()
    const configHook = hooks.config
    if (configHook === undefined) throw new Error("loomy 必须声明 config 钩子")
    const config: { provider?: Record<string, ConfigProvider> } = {}
    await configHook(config)
    expect(config.provider?.loomy?.name).toBe("Loomy (讯飞)")
    expect(config.provider?.loomy?.api).toBe("https://loomyad.xunfei.cn/api/v1")
    expect(Object.keys(config.provider?.loomy?.models ?? {})).toHaveLength(8)
  })
})

describe("没有账号的入口", () => {
  test("loader 抛 SignInExpiredError", async () => {
    const hooks = await loomyHooks()
    const error = await rejectionError(() => hooks.auth.loader(async () => undefined, PROVIDER))
    expect(error).toBeInstanceOf(SignInExpiredError)
    expect(error.message).toBe("loomy: 账号里没有 session（加载请求头），请重新登录")
  })

  test("checkin 抛 SignInExpiredError", async () => {
    const hooks = await loomyHooks()
    const checkin = hooks.auth.checkin
    if (checkin === undefined) throw new Error("loomy 必须有 checkin 钩子")
    const error = await rejectionError(() => checkin(async () => undefined, PROVIDER))
    expect(error).toBeInstanceOf(SignInExpiredError)
    expect(error.message).toBe("loomy: 账号里没有 session（签到），请重新登录")
  })

  test("usage 直接给 signIn expired", async () => {
    const hooks = await loomyHooks()
    const usage = hooks.auth.usage
    if (usage === undefined) throw new Error("loomy 必须有 usage 钩子")
    expect(await usage(async () => undefined, PROVIDER)).toStrictEqual({
      signIn: "expired",
      error: "账号里没有 session，请重新登录",
    })
  })

  test("provider.models 把 given 原样交回", async () => {
    const hooks = await loomyHooks()
    const given = { "MiniMax-M3": { id: "MiniMax-M3" } }
    expect(await providerOf(hooks).models({ id: "loomy", models: given }, { auth: {} })).toBe(given)
  })

  test("目录读失败时交回打了 fellBack 标记的内置表，且倍率已解析", async () => {
    const response = cannedFetch([{ match: "/models", respond: jsonFail({ code: "500", desc: "boom" }) }])
    const hooks = await loomyHooks()
    const original = globalThis.fetch
    globalThis.fetch = response
    try {
      const models = await providerOf(hooks).models(
        { id: "loomy", models: {} },
        { auth: { access: "sess-1" } },
      )
      expect(Object.keys(models ?? {})).toHaveLength(8)
      expect(Reflect.get(models ?? {}, Symbol.for("magpie.fellBack"))).toBe(true)
      expect(models?.["MiniMax-M3"]?.name).toBe("MiniMax M3")
      expect(models?.["MiniMax-M3"]?.rate).toBe(4)
    } finally {
      globalThis.fetch = original
    }
  })

  test("登录态被拒的目录读取标记账号，不回退内置表", async () => {
    const response = cannedFetch([
      { match: "/models", respond: jsonOk({ code: "100002", desc: "缺少 token" }) },
    ])
    const hooks = await loomyHooks()
    const original = globalThis.fetch
    globalThis.fetch = response
    try {
      const error = await rejectionError(() =>
        providerOf(hooks).models({ id: "loomy", models: {} }, { auth: { access: "sess-1" } }),
      )
      expect(error).toBeInstanceOf(SignInExpiredError)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe("usage 的接线", () => {
  async function withFetch<T>(fetcher: ReturnType<typeof cannedFetch>, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch
    globalThis.fetch = fetcher
    try {
      return await run()
    } finally {
      globalThis.fetch = original
    }
  }

  test("还有没领的新手任务时，额度卡片多一行 aside 的进度", async () => {
    forgetTaskReadings()
    const fetcher = cannedFetch([
      {
        match: "/points/records",
        respond: jsonOk({
          code: "000000",
          data: { balance: 500, dailyBalance: 4000, availableBalance: 4500 },
        }),
      },
      {
        match: "/onboarding/tasks",
        respond: jsonOk({
          code: "000000",
          data: { tasks: { first_message: true, pick_skill: true }, earned: 0, total: 10_000 },
        }),
      },
    ])
    // 关掉自动领取，看的才是「读到未完成时长什么样」这件事本身。
    const hooks = await loomyHooks({ claimTasks: false })
    const usage = hooks.auth.usage
    if (usage === undefined) throw new Error("loomy 必须有 usage 钩子")
    const report = await withFetch(fetcher, () =>
      usage(async () => ({ ...AUTH, dailyQuota: 5000, dailyCycleDate: "2026-10-15" }), PROVIDER),
    )
    const tasks = report.windows?.find((window) => window.name === "新手任务")
    expect(tasks?.aside).toBe(true)
    // first_message 500 + pick_skill 1000 = 1500 已领。
    expect(tasks?.display).toBe("新手任务 2/8 · 已领 1500 / 还有 8500 分可领")
    // 插在钞池之后：今日 + 永久 + 新手任务。
    expect(report.windows?.map((window) => window.name)).toStrictEqual(["今日积分", "永久积分", "新手任务"])
  })

  test("默认自动领取：卡片读到未完成就领掉，那一行随即消失", async () => {
    forgetTaskReadings()
    let claimed = false
    const fetcher = cannedFetch([
      {
        match: "/onboarding/tasks/complete",
        respond: () => {
          claimed = true
          return jsonOk({ code: "000000", data: { alreadyCompleted: false, balance: 500 } })
        },
      },
      {
        match: "/onboarding/tasks",
        respond: () =>
          jsonOk({
            code: "000000",
            data: {
              tasks: claimed ? { first_message: true, share_soul: true } : {},
              earned: 0,
              total: 10_000,
            },
          }),
      },
      {
        match: "/points/records",
        respond: jsonOk({
          code: "000000",
          data: { balance: 500, dailyBalance: 4000, availableBalance: 4500 },
        }),
      },
    ])
    const hooks = await loomyHooks()
    const usage = hooks.auth.usage
    if (usage === undefined) throw new Error("loomy 必须有 usage 钩子")
    const report = await withFetch(fetcher, () => usage(async () => AUTH, PROVIDER))

    // 领过了，所以卡片上不再有那一行；请求发的是 complete，不是空转。
    expect(report.windows?.find((window) => window.name === "新手任务")).toBeUndefined()
    expect(fetcher.callsMatching("/onboarding/tasks/complete")).toHaveLength(8)
  })

  test("任务都领完时卡片上不多这一行", async () => {
    forgetTaskReadings()
    const all = Object.fromEntries(
      [
        "first_message",
        "pick_skill",
        "generate_ppt",
        "set_schedule",
        "install_skill",
        "configure_remote",
        "create_soul",
        "share_soul",
      ].map((key) => [key, true]),
    )
    const fetcher = cannedFetch([
      {
        match: "/points/records",
        respond: jsonOk({
          code: "000000",
          data: { balance: 500, dailyBalance: 4000, availableBalance: 4500 },
        }),
      },
      {
        match: "/onboarding/tasks",
        respond: jsonOk({ code: "000000", data: { tasks: all, earned: 10_000, total: 10_000 } }),
      },
    ])
    const hooks = await loomyHooks()
    const usage = hooks.auth.usage
    if (usage === undefined) throw new Error("loomy 必须有 usage 钩子")
    const report = await withFetch(fetcher, () => usage(async () => AUTH, PROVIDER))
    expect(report.windows?.map((window) => window.name)).not.toContain("新手任务")
  })

  test("任务表读不到时额度照常返回，只是少一行", async () => {
    forgetTaskReadings()
    const fetcher = cannedFetch([
      {
        match: "/points/records",
        respond: jsonOk({
          code: "000000",
          data: { balance: 500, dailyBalance: 4000, availableBalance: 4500 },
        }),
      },
      { match: "/onboarding/tasks", respond: jsonFail({ code: "500", desc: "boom" }) },
    ])
    const hooks = await loomyHooks()
    const usage = hooks.auth.usage
    if (usage === undefined) throw new Error("loomy 必须有 usage 钩子")
    const report = await withFetch(fetcher, () => usage(async () => AUTH, PROVIDER))
    expect(report.balance).toBe("4500 积分")
    expect(report.windows?.map((window) => window.name)).toStrictEqual(["今日积分", "永久积分"])
  })
})

describe("checkin 的接线", () => {
  const DAILY = jsonOk({
    code: "000000",
    desc: "成功",
    data: { alreadyProcessed: false, dailyQuota: 5000, dailyConsumed: 1000, dailyBalance: 4000 },
  })
  const TASKS_PARTIAL = jsonOk({
    code: "000000",
    desc: "成功",
    data: { tasks: { first_message: true }, earned: 500, total: 10_000 },
  })
  const COMPLETE_OK = jsonOk({
    code: "000000",
    desc: "成功",
    data: { alreadyCompleted: false, balance: 500 },
  })

  async function withFetch<T>(fetcher: ReturnType<typeof cannedFetch>, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch
    globalThis.fetch = fetcher
    try {
      return await run()
    } finally {
      globalThis.fetch = original
    }
  }

  test("一次签到顺手把没领的新手任务领完，credit 只算当日额度", async () => {
    const fetcher = cannedFetch([
      { match: "/onboarding/tasks/complete", respond: COMPLETE_OK },
      { match: "/onboarding/tasks", respond: TASKS_PARTIAL },
      { match: "/points/first-login", respond: DAILY },
    ])
    const hooks = await loomyHooks()
    const checkin = hooks.auth.checkin
    if (checkin === undefined) throw new Error("loomy 必须有 checkin 钩子")
    const result = await withFetch(fetcher, () => checkin(async () => AUTH, PROVIDER))

    expect(result.outcome).toBe("claimed")
    // 4000 是当日额度（5000−1000）；新手任务的 9500 分不进 credit。
    expect(result.credit).toBe(4000)
    expect(result.message).toContain("今日额度已发放（今日 4000/5000）")
    expect(result.message).toContain("新手任务补领 7 项")
    expect(result.message).toContain("累计 10000/10000（8/8 项）")

    // 已有的一条不重发，剩下七条各发一次。
    expect(fetcher.callsMatching("/onboarding/tasks/complete")).toHaveLength(7)
    expect(fetcher.callsMatching("/points/first-login")).toHaveLength(1)
  })

  test("签到领完之后，卡片的下一次读拿到的是新状态（缓存已失效）", async () => {
    forgetTaskReadings()
    forgetDailyBalances()
    const all = Object.fromEntries(
      [
        "first_message",
        "pick_skill",
        "generate_ppt",
        "set_schedule",
        "install_skill",
        "configure_remote",
        "create_soul",
        "share_soul",
      ].map((key) => [key, true]),
    )
    let claimed = false
    const fetcher = cannedFetch([
      { match: "/onboarding/tasks/complete", respond: COMPLETE_OK },
      {
        match: "/onboarding/tasks",
        respond: () =>
          jsonOk({ code: "000000", data: { tasks: claimed ? all : {}, earned: 0, total: 10_000 } }),
      },
      { match: "/points/first-login", respond: DAILY },
      {
        match: "/points/records",
        respond: jsonOk({
          code: "000000",
          data: { balance: 500, dailyBalance: 4000, availableBalance: 4500 },
        }),
      },
    ])
    // 关掉自动领取，这条验的是「签到领完之后缓存有没有失效」，
    // 不然卡片那次读自己就把任务领了，测不到 checkin 的那条路径。
    const hooks = await loomyHooks({ claimTasks: false })
    const usage = hooks.auth.usage
    const checkin = hooks.auth.checkin
    if (usage === undefined || checkin === undefined) throw new Error("loomy 必须有 usage 与 checkin")

    // 卡片先读一次：还没领，进缓存。
    const before = await withFetch(fetcher, () => usage(async () => AUTH, PROVIDER))
    expect(before.windows?.find((w) => w.name === "新手任务")?.display).toContain("0/8")

    // 签到把任务领了。
    const result = await withFetch(fetcher, () => checkin(async () => AUTH, PROVIDER))
    expect(result.message).toContain("新手任务补领 8 项")
    claimed = true

    // 卡片紧接着再读：不能还是「0/8 可领」，否则就是用户看到的那个矛盾。
    const after = await withFetch(fetcher, () => usage(async () => AUTH, PROVIDER))
    expect(after.windows?.find((w) => w.name === "新手任务")).toBeUndefined()
  })

  test("任务表读不到也不影响签到本身（当日额度照发）", async () => {
    const fetcher = cannedFetch([
      { match: "/onboarding/tasks", respond: jsonOk({ code: "500", desc: "boom" }) },
      { match: "/points/first-login", respond: DAILY },
    ])
    const hooks = await loomyHooks()
    const checkin = hooks.auth.checkin
    if (checkin === undefined) throw new Error("loomy 必须有 checkin 钩子")
    const result = await withFetch(fetcher, () => checkin(async () => AUTH, PROVIDER))
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(4000)
    // 读不到任务表时不写任何任务文案（不让「读不到」假装成「没问题」）。
    expect(result.message).toBe("今日额度已发放（今日 4000/5000）")
  })

  test("任务端点回 100002 时抛 SignInExpiredError，让宿主标记账号", async () => {
    const fetcher = cannedFetch([
      { match: "/onboarding/tasks", respond: jsonOk({ code: "100002", desc: "缺少 token" }) },
      { match: "/points/first-login", respond: DAILY },
    ])
    const hooks = await loomyHooks()
    const checkin = hooks.auth.checkin
    if (checkin === undefined) throw new Error("loomy 必须有 checkin 钩子")
    const error = await withFetch(fetcher, () => rejectionError(() => checkin(async () => AUTH, PROVIDER)))
    expect(error).toBeInstanceOf(SignInExpiredError)
    expect(error.message).toBe("loomy: 新手任务被拒绝：缺少 token")
  })
})

describe("loader 的门禁接线", () => {
  test("锁定时今日余额为 0 的请求不下发，直接 429", async () => {
    forgetDailyBalances()
    rememberDailyBalance(AUTH, 0)
    const hooks = await loomyHooks({ lockPermanent: true })
    const loaded = await hooks.auth.loader(async () => AUTH, PROVIDER)
    const fetcher = loaded.fetch
    if (fetcher === undefined) throw new Error("loader 必须带上 fetch 包装")
    const response = await fetcher("https://loomyad.xunfei.cn/api/v1/chat/completions", {
      method: "POST",
      body: "{}",
    })
    expect(response.status).toBe(429)
  })

  test("不锁定时同一个缓存读数照常放行（fetch 仍是网络实现）", async () => {
    forgetDailyBalances()
    rememberDailyBalance(AUTH, 0)
    const hooks = await loomyHooks()
    const loaded = await hooks.auth.loader(async () => AUTH, PROVIDER)
    expect(loaded.fetch).toBeFunction()
    // 不锁定时包装器只问一次理由就透传：用一个必然失败的地址证明它真的去发了，
    // 而不是本地拒绝。
    const error = await rejectionError(() =>
      (loaded.fetch as typeof fetch)("http://127.0.0.1:9/v1/chat/completions", {
        method: "POST",
        body: "{}",
      }),
    )
    expect(error).toBeInstanceOf(Error)
    expect(String(error.message)).not.toContain("额度")
  })
})
