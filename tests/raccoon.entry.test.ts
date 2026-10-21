/**
 * 保护根 index.ts：magpie 会把入口模块的每个函数导出都当成插件工厂调用
 * （`internal/plugin/host.js` 的 `servers()`），所以入口只允许插件工厂本身
 * （不导出工具函数或常量），且每个工厂都能在没有宿主时装配出各自 provider 的钩子。
 *
 * 每加一家厂商，这一条断言就要多一个名字：漏掉的话，一个辅助函数被导出会被
 * 宿主当成第四家厂商调用。
 */

import { describe, expect, test } from "bun:test"
import * as entry from "../index.ts"
import astudioOpenCode from "../opencode/astudio.ts"
import loomyOpenCode from "../opencode/loomy.ts"
import raccoonOpenCode from "../opencode/raccoon.ts"
import { fakeClient, providerOf } from "./helpers.ts"

describe("插件入口", () => {
  test("只导出插件工厂，不导出工具函数或常量", () => {
    expect(Object.keys(entry).sort()).toStrictEqual([
      "AstudioAuthPlugin",
      "LoomyAuthPlugin",
      "RaccoonAuthPlugin",
      "TraeAuthPlugin",
    ])
    expect(typeof entry.AstudioAuthPlugin).toBe("function")
    expect(typeof entry.LoomyAuthPlugin).toBe("function")
    expect(typeof entry.RaccoonAuthPlugin).toBe("function")
    expect(typeof entry.TraeAuthPlugin).toBe("function")
  })

  test("四个工厂都能装配出各自 provider 的钩子", async () => {
    const input = { client: fakeClient() }
    const [astudio, loomy, raccoon, trae] = await Promise.all([
      entry.AstudioAuthPlugin(input),
      entry.LoomyAuthPlugin(input),
      entry.RaccoonAuthPlugin(input),
      entry.TraeAuthPlugin(input),
    ])
    expect(astudio.auth.provider).toBe("astudio")
    expect(providerOf(astudio).id).toBe("astudio")
    expect(typeof astudio.auth.checkin).toBe("function")
    // AStudio 没有 refresh token 也没有 TTL：不实现假的续期，401 自愈在 loader.fetch 里。
    expect(astudio.auth.refresh).toBeUndefined()
    expect(loomy.auth.provider).toBe("loomy")
    expect(providerOf(loomy).id).toBe("loomy")
    expect(typeof loomy.auth.checkin).toBe("function")
    expect(raccoon.auth.provider).toBe("raccoon")
    expect(providerOf(raccoon).id).toBe("raccoon")
    expect(raccoon.auth.checkin).toBeUndefined()
    expect(typeof raccoon.auth.refresh).toBe("function")
    expect(loomy.auth.refresh).toBeUndefined()
    // Trae 两项写钩子都有：签到是这次接入的目的，续期是轮转型 token 必需的。
    expect(trae.auth.provider).toBe("trae-cn")
    expect(providerOf(trae).id).toBe("trae-cn")
    expect(typeof trae.auth.checkin).toBe("function")
    expect(typeof trae.auth.refresh).toBe("function")
    expect(trae.auth.refreshLead).toBe(5 * 60 * 1000)
  })

  test("OpenCode 子入口遵守 V2 的 id/setup 契约", async () => {
    expect(loomyOpenCode.id).toBe("loomy")
    expect(typeof loomyOpenCode.setup).toBe("function")
    expect("server" in loomyOpenCode).toBe(false)
    expect(astudioOpenCode.id).toBe("astudio")
    expect(typeof astudioOpenCode.setup).toBe("function")
    expect("server" in astudioOpenCode).toBe(false)
    expect(raccoonOpenCode.id).toBe("raccoon")
    expect(typeof raccoonOpenCode.setup).toBe("function")
    expect("server" in raccoonOpenCode).toBe(false)

    const astudioAdded: { info: Record<string, unknown>; models: readonly Record<string, unknown>[] }[] = []
    const loomyAdded: { info: Record<string, unknown>; models: readonly Record<string, unknown>[] }[] = []
    const raccoonAdded: { info: Record<string, unknown>; models: readonly Record<string, unknown>[] }[] = []
    const hooks: ((event: unknown) => void | Promise<void>)[] = []
    const integrationUpdates: {
      integrationID: string
      method: Record<string, unknown>
      authorize?: unknown
    }[] = []
    await astudioOpenCode.setup({
      options: { accessToken: "astudio-bearer" },
      provider: { transform: async (callback) => callback({ add: (input) => astudioAdded.push(input) }) },
      session: { hook: async (_name, callback) => void hooks.push(callback) },
      integration: {
        transform: async (callback) =>
          callback({ method: { update: (input) => integrationUpdates.push(input) } }),
      },
    })
    await loomyOpenCode.setup({
      options: { accessToken: "loomy-session" },
      provider: { transform: async (callback) => callback({ add: (input) => loomyAdded.push(input) }) },
      session: { hook: async (_name, callback) => void hooks.push(callback) },
      integration: {
        transform: async (callback) =>
          callback({ method: { update: (input) => integrationUpdates.push(input) } }),
      },
    })
    await raccoonOpenCode.setup({
      options: { accessToken: "raccoon-token", officeIdentity: "org-1" },
      provider: { transform: async (callback) => callback({ add: (input) => raccoonAdded.push(input) }) },
      session: { hook: async (_name, callback) => void hooks.push(callback) },
      integration: {
        transform: async (callback) =>
          callback({ method: { update: (input) => integrationUpdates.push(input) } }),
      },
    })

    expect(astudioAdded[0]?.info).toMatchObject({
      id: "astudio",
      settings: { baseURL: "https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1" },
      headers: { Authorization: "Bearer astudio-bearer", token: "astudio-bearer" },
    })
    expect(astudioAdded[0]?.models.length).toBeGreaterThan(0)
    expect(loomyAdded[0]?.info).toMatchObject({
      id: "loomy",
      settings: { baseURL: "https://loomyad.xunfei.cn/api/v1" },
      headers: { Authorization: "Bearer loomy-session", token: "loomy-session" },
    })
    expect(loomyAdded[0]?.models.length).toBeGreaterThan(0)
    expect(raccoonAdded[0]?.info).toMatchObject({
      id: "raccoon",
      settings: { baseURL: "https://xiaohuanxiong.com/api/web/llm/v2" },
      headers: {
        Authorization: "Bearer raccoon-token",
        token: "raccoon-token",
        "X-Org-Code": "org-1",
      },
    })
    const raccoonModel = raccoonAdded[0]?.models.find((model) => model.id === "sn-sensenova-6-8-flash")
    expect(raccoonModel?.variants).toContainEqual({
      id: "none",
      body: { extra_body: { thinking: { type: "disabled" } } },
    })
    const astudioOAuth = integrationUpdates.find(
      (update) => update.integrationID === "astudio" && update.method.type === "oauth",
    )
    expect(typeof astudioOAuth?.authorize).toBe("function")
    // astudio: 一个 oauth 方式（微信 SSO 扫码）+ env + key。
    expect(integrationUpdates.filter((update) => update.integrationID === "astudio")).toHaveLength(3)
    expect(hooks).toHaveLength(3)
    // loomy: 两个 oauth 方式（微信 + 短信）+ env + key。
    expect(integrationUpdates.filter((update) => update.integrationID === "loomy")).toHaveLength(4)
    expect(integrationUpdates.filter((update) => update.integrationID === "raccoon")).toHaveLength(3)
    const loomyOAuth = integrationUpdates.find(
      (update) => update.integrationID === "loomy" && update.method.type === "oauth",
    )
    expect(typeof loomyOAuth?.authorize).toBe("function")
    expect(integrationUpdates.some((update) => update.method.type === "env")).toBe(true)
    expect(integrationUpdates.some((update) => update.method.type === "key")).toBe(true)

    const request = {
      request: { url: "https://loomyad.xunfei.cn/api/v1/chat/completions", headers: new Headers() },
    }
    // hooks 按注册顺序是 astudio → loomy → raccoon；lucky 的 bearer 注入属于 loomy。
    await hooks[1]?.(request)
    expect(request.request.headers.get("authorization")).toBe("Bearer loomy-session")
    expect(request.request.headers.get("token")).toBe("loomy-session")
  })
})
