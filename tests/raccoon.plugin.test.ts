/**
 * 保护 vendors/raccoon/index.ts 的装配：config 声明 provider、loader 装
 * Bearer + 组织头并包一层 thinking 补丁、usage 只读余额（401 就是
 * signIn:"expired"）、refresh 用账号里的 refresh_token 且不轮换时保留旧的、
 * 没有 checkin 钩子。要碰网络的路径都把 globalThis.fetch 换成 cannedFetch，测完还原。
 */

import { describe, expect, test } from "bun:test"
import { SignInExpiredError } from "../src/core/errors.ts"
import type { ConfigProvider, Hooks, ProviderInfo, StoredAuth } from "../src/core/types.ts"
import { RaccoonAuthPlugin } from "../src/vendors/raccoon/index.ts"
import { RACCOON_REFRESH_LEAD_MS } from "../src/vendors/raccoon/product.ts"
import {
  at,
  type CannedFetch,
  cannedFetch,
  fakeClient,
  headersOf,
  jsonFail,
  jsonOk,
  providerOf,
  rejectionError,
} from "./helpers.ts"

const PROVIDER: ProviderInfo = { id: "raccoon", models: {} }
const PHONE = "13812345678"

async function raccoonHooks(options: Record<string, unknown> = {}): Promise<Hooks> {
  return await RaccoonAuthPlugin({ client: fakeClient() }, options)
}

function requireConfig(hooks: Hooks): NonNullable<Hooks["config"]> {
  if (hooks.config === undefined) throw new Error("raccoon 必须声明 config 钩子")
  return hooks.config
}

function requireUsage(hooks: Hooks): NonNullable<Hooks["auth"]["usage"]> {
  if (hooks.auth.usage === undefined) throw new Error("raccoon 必须有 usage 钩子")
  return hooks.auth.usage
}

function requireRefresh(hooks: Hooks): NonNullable<Hooks["auth"]["refresh"]> {
  if (hooks.auth.refresh === undefined) throw new Error("raccoon 必须有 refresh 钩子")
  return hooks.auth.refresh
}

async function withFetch<T>(fetcher: CannedFetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = fetcher
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

function jwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds }), "utf8").toString("base64url")
  return `header.${payload}.signature`
}

describe("RaccoonAuthPlugin 的钩子形状", () => {
  test("provider、refreshLead 与没有 checkin", async () => {
    const hooks = await raccoonHooks()
    expect(hooks.auth.provider).toBe("raccoon")
    expect(providerOf(hooks).id).toBe("raccoon")
    expect(hooks.auth.refreshLead).toBe(RACCOON_REFRESH_LEAD_MS)
    expect(hooks.auth.refreshLead).toBe(300_000)
    expect(hooks.auth.checkin).toBeUndefined()
    expect(hooks.auth.methods.map((method) => method.label)).toStrictEqual(["微信扫码登录"])
  })

  test("icon 是厂商自己托管的 https 图片，且与 Loomy 不同", async () => {
    const hooks = await raccoonHooks()
    // host 的 iconOf 只保留 https:// 与 data:image/；裸图标名（sensenova-color）
    // 会被静默丢弃。两家共用一个包，所以图标只能由各自的 auth.icon 给出——
    // 写作同一个值就等于两个 provider 都画错。
    expect(hooks.auth.icon).toBe("https://sta-volc.xiaohuanxiong.com/raccoon-family/prod/favicon.svg")
    expect(hooks.auth.icon?.startsWith("https://")).toBe(true)
  })

  test("config 声明 raccoon provider 与内置模型表，且不覆盖已有 entry", async () => {
    const hooks = await raccoonHooks()
    const config: { provider?: Record<string, ConfigProvider> } = {}
    await requireConfig(hooks)(config)
    const provided = config.provider?.raccoon
    expect(provided?.name).toBe("Raccoon (商汤)")
    expect(provided?.npm).toBe("@ai-sdk/openai-compatible")
    expect(provided?.api).toBe("https://xiaohuanxiong.com/api/web/llm/v2")
    expect(Object.keys(provided?.models ?? {})).toStrictEqual([
      "sn-sensenova-6-8-flash",
      "sn-sensenova-6-8-flash-lite",
      "sn-glm-5-3",
      "sn-kimi-k3",
      "sn-glm-5-3-flash",
      "sn-deepseek-v4-1-flash",
    ])

    const mine: { provider?: Record<string, ConfigProvider> } = {
      provider: { raccoon: { name: "用户自己的" } },
    }
    await requireConfig(hooks)(mine)
    expect(mine.provider?.raccoon?.name).toBe("用户自己的")
  })
})

describe("loader", () => {
  test("没有 session 时抛 SignInExpiredError", async () => {
    const hooks = await raccoonHooks()
    const error = await rejectionError(() => hooks.auth.loader(async () => ({}), PROVIDER))
    expect(error).toBeInstanceOf(SignInExpiredError)
    expect(error.message).toBe("raccoon: 账号里没有 access_token（加载请求头），请重新登录")
  })

  test("装上 Bearer、组织头与 thinking 补丁", async () => {
    const auth: StoredAuth = { access: "acc-1", officeIdentity: "org-9" }
    const received = cannedFetch([{ match: "chat/completions", respond: jsonOk({ ok: true }) }])
    // loader 在调用时就抓 globalThis.fetch，所以换 fetch 必须发生在它之前
    await withFetch(received, async () => {
      const hooks = await raccoonHooks()
      const result = await hooks.auth.loader(async () => auth, PROVIDER)
      expect(result.baseURL).toBe("https://xiaohuanxiong.com/api/web/llm/v2")
      expect(result.apiKey).toBe("acc-1")
      expect(result.headers).toStrictEqual({
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        Authorization: "Bearer acc-1",
        "X-Org-Code": "org-9",
        "X-Raccoon-Language": "zh",
        "X-Client-Platform": "desktop-windows",
        "X-Client-Version": "v1.0.35",
      })
      if (result.fetch === undefined) throw new Error("loader 没有返回 fetch")
      const wrapped = result.fetch

      await wrapped(`${result.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sn-kimi-k3", reasoning_effort: "none" }),
      })
      const rewritten = JSON.parse(String(at(received.calls, 0).init?.body)) as Record<string, unknown>
      expect(rewritten).toStrictEqual({
        model: "sn-kimi-k3",
        extra_body: { thinking: { type: "disabled" } },
      })
      expect("reasoning_effort" in rewritten).toBe(false)

      // 没提 effort 的请求原样转发，连 init 都是同一个对象
      const untouched = { method: "POST", body: JSON.stringify({ model: "sn-kimi-k3" }) }
      await wrapped(`${result.baseURL}/chat/completions`, untouched)
      expect(at(received.calls, 1).init).toBe(untouched)
    })
  })
})

describe("OpenCode 直接 options", () => {
  test("没有 Magpie metadata 时使用 options.officeIdentity", async () => {
    const response = cannedFetch([{ match: "chat/completions", respond: jsonOk({ ok: true }) }])
    await withFetch(response, async () => {
      const hooks = await raccoonHooks({ officeIdentity: "org-options" })
      const loaded = await hooks.auth.loader(async () => ({ access: "acc-1" }), PROVIDER)
      expect(loaded.headers?.["X-Org-Code"]).toBe("org-options")
    })
  })
})

describe("usage", () => {
  test("没有 access 直接报 expired，不发请求", async () => {
    const hooks = await raccoonHooks()
    expect(await requireUsage(hooks)(async () => ({}), PROVIDER)).toStrictEqual({
      signIn: "expired",
      error: "账号里没有 access_token，请重新登录",
    })
  })

  test("key 形状的账号从 metadata 里读组织码与账号名", async () => {
    // host 存 API-key 形状的登录态时会把它重建成 { type, key, metadata }
    // （internal/plugin/host.js 的 save），账号信息只在 metadata 里。
    const response = cannedFetch([
      {
        match: "/api/web/points/v1/balance",
        respond: jsonOk({ code: 0, message: "ok", data: { available_points: 10 } }),
      },
    ])
    const hooks = await raccoonHooks()
    const auth: StoredAuth = {
      type: "api",
      key: "acc-key",
      metadata: { phone: PHONE, officeIdentity: "org-meta", userId: "u-meta" },
    }
    const report = await withFetch(
      response,
      async () => await requireUsage(hooks)(async () => auth, PROVIDER),
    )
    // 账号名取自 metadata 里的手机号；组织码也必须来自 metadata，
    // 否则请求会打到个人账号（X-Org-Code 空）。
    expect(report.user).toBe("138****5678")
    expect(headersOf(at(response.calls, 0))["X-Org-Code"]).toBe("org-meta")
  })

  test("余额读成展示窗口，user 用掩码手机号", async () => {
    const response = cannedFetch([
      {
        match: "/api/web/points/v1/balance",
        respond: jsonOk({
          code: 0,
          message: "ok",
          data: { available_points: 1234, daily_points: 100, reward_points: 30 },
        }),
      },
    ])
    const hooks = await raccoonHooks()
    const auth: StoredAuth = { access: "acc-1", phone: PHONE, officeIdentity: "org-9" }
    const report = await withFetch(
      response,
      async () => await requireUsage(hooks)(async () => auth, PROVIDER),
    )
    expect(report).toStrictEqual({
      user: "138****5678",
      balance: "1234 积分",
      windows: [
        { name: "每日积分", used: 0, aside: true, unit: "积分", display: "每日积分 100" },
        { name: "奖励积分", used: 0, aside: true, unit: "积分", display: "奖励积分 30" },
      ],
    })
    const call = at(response.calls, 0)
    expect(call.url).toBe("https://xiaohuanxiong.com/api/web/points/v1/balance")
    expect(headersOf(call)).toStrictEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer acc-1",
      "X-Org-Code": "org-9",
      "X-Raccoon-Language": "zh",
    })
  })

  test("HTTP 401 就是到期，不是普通失败", async () => {
    const response = cannedFetch([
      { match: "/api/web/points/v1/balance", respond: new Response("", { status: 401 }) },
    ])
    const hooks = await raccoonHooks()
    const report = await withFetch(
      response,
      async () => await requireUsage(hooks)(async () => ({ access: "acc-1" }), PROVIDER),
    )
    expect(report).toStrictEqual({ signIn: "expired", error: "响应不是 JSON 对象" })
  })
})

describe("refresh", () => {
  test("没有 refresh_token 抛 SignInExpiredError", async () => {
    const hooks = await raccoonHooks()
    const error = await rejectionError(() => requireRefresh(hooks)({ access: "acc-1" }, PROVIDER))
    expect(error).toBeInstanceOf(SignInExpiredError)
    expect(error.message).toBe("raccoon: 账号里没有 refresh_token，请重新登录")
  })

  test("换到新 access；refresh 没轮换就保留旧的，exp 读不出就写 0", async () => {
    const rotated = cannedFetch([
      {
        match: "/api/web/auth/v1/refresh",
        respond: jsonOk({ code: 0, data: { access_token: jwt(1_900_000_000), refresh_token: "r-2" } }),
      },
    ])
    const hooks = await raccoonHooks()
    const renewed = await withFetch(
      rotated,
      async () => await requireRefresh(hooks)({ access: "acc-1", refresh: "r-1" }, PROVIDER),
    )
    expect(renewed).toStrictEqual({
      access: jwt(1_900_000_000),
      refresh: "r-2",
      expires: 1_900_000_000_000,
    })
    expect(at(rotated.calls, 0).url).toBe("https://xiaohuanxiong.com/api/web/auth/v1/refresh")
    expect(JSON.parse(String(at(rotated.calls, 0).init?.body))).toStrictEqual({
      refresh_token: "r-1",
    })

    const opaque = cannedFetch([
      { match: "/api/web/auth/v1/refresh", respond: jsonOk({ code: 0, data: { access_token: "opaque" } }) },
    ])
    const kept = await withFetch(
      opaque,
      async () => await requireRefresh(hooks)({ access: "acc-1", refresh: "r-1" }, PROVIDER),
    )
    expect(kept).toStrictEqual({ access: "opaque", refresh: "r-1", expires: 0 })
  })
})

describe("provider.models", () => {
  test("没有账号时把 given 原样交回", async () => {
    const hooks = await raccoonHooks()
    const given = { "sn-kimi-k3": { id: "sn-kimi-k3" } }
    expect(await providerOf(hooks).models({ id: "raccoon", models: given }, { auth: {} })).toBe(given)
    expect(await providerOf(hooks).models({ id: "raccoon", models: given })).toBe(given)
  })

  test("读到账号目录就交回它，倍率与 variants 都在", async () => {
    const response = cannedFetch([
      {
        match: "/api/web/llm/v2/model_catalog",
        respond: jsonOk({
          code: 0,
          data: {
            categories: [
              {
                type: "chat",
                models: [
                  {
                    name: "sn-glm-5-3-flash",
                    description: "GLM 5.3 Flash",
                    billing_effective_multiplier: 0.1,
                    billing_multiplier: 0.2,
                  },
                ],
              },
            ],
          },
        }),
      },
    ])
    const hooks = await raccoonHooks()
    const auth: StoredAuth = { access: "acc-1", officeIdentity: "org-9" }
    const models = await withFetch(
      response,
      async () => await providerOf(hooks).models({ id: "raccoon", models: {} }, { auth }),
    )
    expect(Object.keys(models ?? {})).toStrictEqual(["sn-glm-5-3-flash"])
    expect(models?.["sn-glm-5-3-flash"]?.rate).toBe(0.1)
    expect(models?.["sn-glm-5-3-flash"]?.rateWas).toBe(0.2)
    expect(models?.["sn-glm-5-3-flash"]?.variants).toStrictEqual({ none: {}, high: {} })
    expect(Reflect.get(models ?? {}, Symbol.for("magpie.fellBack"))).toBeUndefined()
  })

  test("目录读失败时交回打了 fellBack 标记的内置表", async () => {
    const response = cannedFetch([
      { match: "/api/web/llm/v2/model_catalog", respond: jsonFail({ code: 500, message: "boom" }, 500) },
    ])
    const hooks = await raccoonHooks()
    const auth: StoredAuth = { access: "acc-1" }
    const models = await withFetch(
      response,
      async () => await providerOf(hooks).models({ id: "raccoon", models: {} }, { auth }),
    )
    // 回退表 6 个模型，且带标记，界面才会说"这不是账号的真实列表"
    expect(Object.keys(models ?? {})).toHaveLength(6)
    expect(Reflect.get(models ?? {}, Symbol.for("magpie.fellBack"))).toBe(true)
  })

  test("账号目录为空时不动宿主原有的列表", async () => {
    const response = cannedFetch([
      {
        match: "/api/web/llm/v2/model_catalog",
        respond: jsonOk({ code: 0, data: { categories: [{ type: "chat", models: [] }] } }),
      },
    ])
    const hooks = await raccoonHooks()
    const given = { "sn-kimi-k3": { id: "sn-kimi-k3" } }
    const models = await withFetch(
      response,
      async () =>
        await providerOf(hooks).models({ id: "raccoon", models: given }, { auth: { access: "acc-1" } }),
    )
    expect(models).toBe(given)
  })
})
