import { describe, expect, test } from "bun:test"
import type { AuthMethod, OAuthMethod } from "../src/core/types.ts"
import { loginMethods, signInResult } from "../src/vendors/raccoon/login.ts"
import { cannedFetch, fakeClient } from "./helpers.ts"

function oauthMethod(methods: readonly AuthMethod[], index: number): OAuthMethod {
  const method = methods[index]
  if (method === undefined || method.type !== "oauth") throw new Error(`方法 ${index} 不是 oauth`)
  return method
}

describe("Raccoon 登录生命周期", () => {
  test("opaque access + refresh token 明确禁止自动续期调度", () => {
    expect(signInResult({ access: "opaque-access", refresh: "refresh-token" })).toStrictEqual({
      type: "success",
      access: "opaque-access",
      refresh: "refresh-token",
      expires: 0,
    })
  })

  test("短信登录超时后关闭本地页，不再接受请求", async () => {
    const methods = loginMethods({
      options: { phoneCipherSecret: "1234567890123456" },
      client: fakeClient(),
      fetcher: cannedFetch([]),
      signInTimeoutMs: 20,
    })
    const started = await oauthMethod(methods, 1).authorize()
    const result = await started.callback()

    expect(result).toStrictEqual({ type: "failed", error: "登录超时，请重新发起登录" })
    if (started.url === undefined) throw new Error("短信登录必须返回本地页 URL")
    await expect(fetch(started.url)).rejects.toThrow()
  })
})
