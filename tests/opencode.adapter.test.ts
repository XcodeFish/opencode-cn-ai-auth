import { describe, expect, test } from "bun:test"
import { openCodePlugin } from "../opencode/adapter.ts"
import type { SignInResult } from "../src/core/types.ts"

type Context = Parameters<ReturnType<typeof openCodePlugin>["setup"]>[0]
type IntegrationEditor = Parameters<Parameters<NonNullable<Context["integration"]>["transform"]>[0]>[0]
type Registration = Parameters<IntegrationEditor["method"]["update"]>[0]

describe("OpenCode V2 登录适配", () => {
  test("auto 回调是凭据 Promise，且无续期令牌时不调用厂商 refresh", async () => {
    let finish: ((result: SignInResult) => void) | undefined
    const done = new Promise<SignInResult>((resolve) => {
      finish = resolve
    })
    let registered: Registration | undefined
    let refreshCalls = 0
    const plugin = openCodePlugin({
      id: "example",
      name: "Example",
      baseURL: "https://example.com/v1",
      env: "EXAMPLE_ACCESS_TOKEN",
      models: [],
      authMethods: () => [
        {
          type: "oauth",
          label: "浏览器登录",
          authorize: () => ({ url: "http://127.0.0.1/login", method: "auto", callback: () => done }),
        },
      ],
      refresh: async () => {
        refreshCalls += 1
        return { access: "renewed", refresh: "refresh", expires: 1_900_000_000_000 }
      },
    })
    await plugin.setup({
      provider: { transform: async (callback) => callback({ add: () => undefined }) },
      integration: {
        transform: async (callback) =>
          callback({
            method: {
              update: (input) => {
                if (input.method.type !== "oauth") return
                registered = input
              },
            },
          }),
      },
    })
    if (registered?.authorize === undefined || registered.refresh === undefined || finish === undefined) {
      throw new Error("登录方法未注册")
    }
    // Authorization returns while sign-in is pending; V2 consumes the Promise
    // itself and never calls it as a Magpie-style function.
    const started = await registered.authorize({})
    expect(started.mode).toBe("auto")
    if (started.mode !== "auto") throw new Error("登录模式错误")
    expect(started.callback).toBeInstanceOf(Promise)
    finish({ type: "success", key: "access", accountId: "account" })
    const credential = await started.callback
    expect(credential).toStrictEqual({
      type: "oauth",
      methodID: "example-0",
      access: "access",
      refresh: "",
      expires: Number.MAX_SAFE_INTEGER,
      metadata: { accountId: "account" },
    })
    expect(await registered.refresh(credential)).toStrictEqual(credential)
    expect(refreshCalls).toBe(0)
  })
})
