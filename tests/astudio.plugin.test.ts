/**
 * 保护 vendors/astudio/index.ts 的装配与 401 自愈链：loader 的头与 apiKey、
 * 401 → 重取 configs → 换新凭据重试一次（同凭据不重试、重取失败原样上抛）、
 * usage 的会话失效与 aside 窗口、checkin 的弹窗领取、listModels 的三条宿主规则。
 *
 * fetcher 注入方式：插件在构造时捕获全局 `fetch`，所以每个用例先装
 * cannedFetch 再构造插件，finally 里还原 —— 全部离线。
 */

import { describe, expect, test } from "bun:test"
import type { Hooks, ProviderInfo, StoredAuth } from "../src/core/types.ts"
import { AstudioAuthPlugin, shouldRetryUnauthorized } from "../src/vendors/astudio/index.ts"
import { ASTUDIO_API_BASE } from "../src/vendors/astudio/product.ts"
import { at, type CannedFetch, cannedFetch, fakeClient, headersOf, jsonOk, providerOf } from "./helpers.ts"

// 手机号按位拼出：测试文件里不出现 11 位连续数字字面量（展示管道会掩码它）。
const RAW_PHONE = [1, 3, 8, 1, 2, 3, 4, 1, 2, 3, 4].join("")
const MASKED_PHONE = "138****1234"

const AUTH: StoredAuth = {
  type: "api",
  key: "old-bearer",
  metadata: { ssoSessionId: "sid-1", accountId: "acc-1", token: "tok-1" },
}

interface Rig {
  hooks: Hooks
  client: ReturnType<typeof fakeClient>
  driver: CannedFetch
  loader: () => ReturnType<Hooks["auth"]["loader"]>
  usage: () => ReturnType<NonNullable<Hooks["auth"]["usage"]>>
  checkin: () => ReturnType<NonNullable<Hooks["auth"]["checkin"]>>
  readModels: (auth: StoredAuth | undefined) => Promise<Record<string, unknown> | undefined>
  restore: () => void
}

/** 在「全局 fetch = cannedFetch」的窗口里构造插件；用例结束时还原。 */
async function rigWith(
  auth: StoredAuth | undefined,
  routes: Parameters<typeof cannedFetch>[0],
): Promise<Rig> {
  const driver = cannedFetch(routes)
  const realFetch = globalThis.fetch
  globalThis.fetch = driver as typeof fetch
  const client = fakeClient()
  const hooks = await AstudioAuthPlugin({ client })
  // 宿主视角的 provider 信息：id 由装配给出，models 是宿主已装配的（空表起步）。
  const provider: ProviderInfo = { id: providerOf(hooks).id, models: {} }
  return {
    hooks,
    client,
    driver,
    loader: () => hooks.auth.loader(async () => auth, provider),
    usage: async () => (await hooks.auth.usage?.(async () => auth, provider)) ?? {},
    checkin: async () =>
      (await hooks.auth.checkin?.(async () => auth, provider)) ?? { outcome: "failed" as const },
    readModels: async (modelsAuth) =>
      (await providerOf(hooks).models?.(provider, modelsAuth === undefined ? {} : { auth: modelsAuth })) ??
      undefined,
    restore: () => {
      globalThis.fetch = realFetch
    },
  }
}

describe("loader", () => {
  test("apiKey 是活体凭据；显式头只补客户端形状；没有账号时抛 SignInExpiredError", async () => {
    const rig = await rigWith(AUTH, [])
    try {
      const loader = await rig.loader()
      expect(loader?.baseURL).toBe(ASTUDIO_API_BASE)
      expect(loader?.apiKey).toBe("old-bearer")
      expect(headersOf({ url: ASTUDIO_API_BASE, init: { headers: loader?.headers } }).clientType).toBe("21")
      expect(headersOf({ url: ASTUDIO_API_BASE, init: { headers: loader?.headers } })["X-Account-Id"]).toBe(
        "acc-1",
      )
      expect(typeof loader?.fetch).toBe("function")
    } finally {
      rig.restore()
    }

    const empty = await rigWith(undefined, [])
    try {
      await expect(empty.loader()).rejects.toMatchObject({ signIn: "expired" })
    } finally {
      empty.restore()
    }
  })

  test("401 → 重取 configs 换新凭据 → 写回账号并重试一次", async () => {
    let chatCalls = 0
    const rig = await rigWith(AUTH, [
      {
        match: "astronstudio-api-volces-prod.xf-yun.com",
        respond: (_url, init) => {
          chatCalls += 1
          const authorization = String(new Headers(init?.headers).get("authorization"))
          if (authorization === "Bearer old-bearer" && chatCalls === 1) return jsonOk({ error: "gone" }, 401)
          return jsonOk({ choices: [] })
        },
      },
      {
        match: "bot/models/configs",
        respond: (_url, init) => {
          const cookie = String(new Headers(init?.headers).get("cookie"))
          expect(cookie).toContain("ssoSessionId=sid-1")
          expect(cookie).toContain("account_id=acc-1")
          return jsonOk({
            flag: true,
            code: 0,
            desc: "成功",
            data: [{ api_key: "new-bearer", is_current: true }],
          })
        },
      },
    ])
    try {
      const loader = await rig.loader()
      const fetcher = loader?.fetch
      if (fetcher === undefined) throw new Error("loader 必须给 fetch")
      const response = await fetcher(`${ASTUDIO_API_BASE}/chat/completions`, {
        method: "POST",
        headers: { Authorization: "Bearer old-bearer", "content-type": "application/json" },
        body: "{}",
      })
      expect(response.status).toBe(200)
      // 新凭据写回账号（整体复制 + 只改 key），metadata 原样保留。
      expect(rig.client.writes).toHaveLength(1)
      const write = at(rig.client.writes, 0)
      expect(write.body.key).toBe("new-bearer")
      expect(write.body.type).toBe("api")
      expect(write.body.metadata).toBeDefined()
      // 自愈链恰好多打一次 chat（重试），外加一次 configs。
      expect(rig.driver.callsMatching("/chat/completions")).toHaveLength(2)
      expect(rig.driver.callsMatching("bot/models/configs")).toHaveLength(1)
    } finally {
      rig.restore()
    }
  })

  test("401 但换到的凭据没变 = 确定性失败，不重试也不写回", async () => {
    const rig = await rigWith(AUTH, [
      { match: "chat/completions", respond: jsonOk({ error: { code: "Unauthorized" } }, 401) },
      {
        match: "bot/models/configs",
        respond: jsonOk({ code: 0, data: [{ api_key: "old-bearer", is_current: true }] }),
      },
    ])
    try {
      const loader = await rig.loader()
      const fetcher = loader?.fetch
      if (fetcher === undefined) throw new Error("loader 必须给 fetch")
      const response = await fetcher(`${ASTUDIO_API_BASE}/chat/completions`, {
        method: "POST",
        headers: { Authorization: "Bearer old-bearer" },
        body: "{}",
      })
      expect(response.status).toBe(401)
      expect(rig.driver.callsMatching("/chat/completions")).toHaveLength(1)
      expect(rig.client.writes).toHaveLength(0)
    } finally {
      rig.restore()
    }
  })

  test("401 且重取失败（可重试故障）→ 原样交还 401，不吞失效信号", async () => {
    const rig = await rigWith(AUTH, [
      { match: "chat/completions", respond: jsonOk({}, 401) },
      { match: "bot/models/configs", respond: jsonOk({}, 503) },
    ])
    try {
      const loader = await rig.loader()
      const fetcher = loader?.fetch
      if (fetcher === undefined) throw new Error("loader 必须给 fetch")
      const response = await fetcher(`${ASTUDIO_API_BASE}/chat/completions`, {
        method: "POST",
        headers: { Authorization: "Bearer old-bearer" },
        body: "{}",
      })
      expect(response.status).toBe(401)
      expect(rig.client.writes).toHaveLength(0)
    } finally {
      rig.restore()
    }
  })
})

describe("shouldRetryUnauthorized", () => {
  test("三格判据：非 401 不重试；已试过不重试；换到不同凭据才重试", () => {
    expect(shouldRetryUnauthorized(500, false, "new", "old")).toBe(false)
    expect(shouldRetryUnauthorized(401, true, "new", "old")).toBe(false)
    expect(shouldRetryUnauthorized(401, false, "old", "old")).toBe(false)
    expect(shouldRetryUnauthorized(401, false, undefined, "old")).toBe(false)
    expect(shouldRetryUnauthorized(401, false, "new", "old")).toBe(true)
  })
})

describe("usage", () => {
  test("分池全部 aside；主窗口用权威 totalBalance；昵称是手机号时掩码", async () => {
    const rig = await rigWith(
      {
        type: "api",
        key: "bearer",
        metadata: { ssoSessionId: "sid", accountId: "acc", nickname: RAW_PHONE },
      },
      [
        {
          match: "points/balance",
          respond: jsonOk({
            code: 0,
            data: {
              totalBalance: 1192,
              totalAmount: 1200,
              memberTotal: 100,
              memberBalance: 40,
              memberNextExpireTime: "2026-11-01 00:00:00",
              sparkTotalBalance: 5000,
            },
          }),
        },
      ],
    )
    try {
      const report = await rig.usage()
      expect(report.balance).toBe("1192 积分")
      expect(report.user).toBe(MASKED_PHONE)
      const windows = report.windows ?? []
      expect(windows.length).toBeGreaterThan(1)
      expect(windows.every((window) => window.aside === true)).toBe(true)
      const main = at(windows, 0)
      expect(main.name).toBe("可用积分")
      expect(main.used).toBe(1) // (1200-1192)/1200 ≈ 0.67%
      expect(main.display).toContain("可用 1192")
      // 池窗口带到期展示；星火池没有总量，只显示剩余。
      const member = at(windows.slice(1), 0)
      expect(member.name).toBe("会员积分")
      expect(member.display).toContain("剩余 40 / 100")
      expect(member.display).toContain("11-01 到期")
    } finally {
      rig.restore()
    }
  })

  test("code 80000（会话失效）→ signIn expired", async () => {
    const rig = await rigWith(AUTH, [
      { match: "points/balance", respond: jsonOk({ code: 80000, desc: "登录异常，请重新登录", data: null }) },
    ])
    try {
      const report = await rig.usage()
      expect(report.signIn).toBe("expired")
    } finally {
      rig.restore()
    }
  })

  test("没有 Cookie 的账号 → signIn expired（Bearer 帮不上控制面）", async () => {
    const rig = await rigWith({ type: "api", key: "bearer" }, [])
    try {
      const report = await rig.usage()
      expect(report.signIn).toBe("expired")
    } finally {
      rig.restore()
    }
  })
})

describe("checkin", () => {
  test("pending 为空 = 今天已领（done，不发写请求）", async () => {
    const rig = await rigWith(AUTH, [
      { match: "client-popups/pending", respond: jsonOk({ code: 0, data: [] }) },
    ])
    try {
      const result = await rig.checkin()
      expect(result.outcome).toBe("done")
      expect(rig.driver.callsMatching("client-popups/complete")).toHaveLength(0)
    } finally {
      rig.restore()
    }
  })

  test("每日签到与新手礼包逐个领取；请求体带 popupId 与 instanceKey", async () => {
    const rig = await rigWith(AUTH, [
      {
        match: "client-popups/pending",
        respond: jsonOk({
          code: 0,
          data: [
            {
              popupId: 3,
              componentType: "DAILY_REWARD_DIALOG",
              instanceKey: "k3",
              payload: { points: "100" },
            },
            { popupId: 4, componentType: "NEW_USER_DIALOG", instanceKey: "k4" },
          ],
        }),
      },
      { match: "client-popups/complete", respond: jsonOk({ code: 0, flag: true, data: { points: 100 } }) },
    ])
    try {
      const result = await rig.checkin()
      expect(result.outcome).toBe("claimed")
      expect(result.message).toContain("每日签到")
      expect(result.message).toContain("新手礼包")
      expect(rig.driver.callsMatching("client-popups/complete")).toHaveLength(2)
      const body = String(at(rig.driver.callsMatching("client-popups/complete"), 0).init?.body)
      expect(body).toContain('"popupId":3')
      expect(body).toContain('"instanceKey":"k3"')
    } finally {
      rig.restore()
    }
  })
})

describe("listModels", () => {
  test("远端目录按裸 slug 出规格；目录读失败回退内置表并标记", async () => {
    const rig = await rigWith(AUTH, [
      {
        match: "model-manager/models",
        respond: jsonOk({
          code: 0,
          data: {
            models: [
              {
                slug: `builtin/${Buffer.from("xopglm52").toString("base64url")}`,
                display_name: "GLM-5.2",
                visibility: "list",
              },
              { slug: "xopglm52", display_name: "GLM-5.2", visibility: "hide" },
              { slug: "spark-x2.5", display_name: "Spark-X2.5", visibility: "list" },
            ],
          },
        }),
      },
    ])
    try {
      const record = (await rig.readModels(AUTH)) ?? {}
      expect(Object.keys(record).sort()).toStrictEqual(["spark-x2.5", "xopglm52"])
      const entry = record.xopglm52 as { variants?: Record<string, unknown> } | undefined
      expect(entry?.variants).toBeDefined()
    } finally {
      rig.restore()
    }

    const failing = await rigWith(AUTH, [{ match: "model-manager/models", respond: jsonOk({}, 500) }])
    try {
      const record = (await failing.readModels(AUTH)) ?? {}
      // 回退表带着「这不是账号的真实列表」的标记。
      expect((record as Record<symbol, unknown>)[Symbol.for("magpie.fellBack")]).toBe(true)
      expect(Object.keys(record)).toHaveLength(6)
    } finally {
      failing.restore()
    }
  })

  test("目录被拒（code 80000）→ 上抛 SignInExpiredError，不回退", async () => {
    const rig = await rigWith(AUTH, [
      { match: "model-manager/models", respond: jsonOk({ code: 80000, desc: "登录异常", data: null }) },
    ])
    try {
      await expect(rig.readModels(AUTH)).rejects.toMatchObject({ signIn: "expired" })
    } finally {
      rig.restore()
    }
  })

  test("没有登录态的账号 → 原样交还宿主已装配的列表（不给空目录）", async () => {
    const rig = await rigWith(undefined, [])
    try {
      const given = { xopglm52: { id: "xopglm52" } }
      const provider = providerOf(rig.hooks)
      const record = await provider.models?.({ ...provider, models: given }, {})
      expect(record).toBe(given)
    } finally {
      rig.restore()
    }
  })
})
