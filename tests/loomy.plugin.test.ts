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
    expect(hooks.auth.methods.map((method) => method.label)).toStrictEqual(["微信扫码登录"])
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
