import { describe, expect, test } from "bun:test"
import type { AuthMethod, OAuthMethod } from "../src/core/types.ts"
import { loginMethods, signInResult } from "../src/vendors/raccoon/login.ts"
import { cannedFetch, fakeClient, jsonOk, tick } from "./helpers.ts"

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
    const page = await fetch(started.url ?? "")
    const html = await page.text()
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"')
    expect(html).toContain('src="captcha"')
    expect(page.headers.get("content-security-policy")).toContain("frame-src 'self'")
    expect(html).not.toContain('<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha.js"')
    const captcha = await fetch(new URL("captcha", started.url ?? ""))
    expect(captcha.headers.get("content-security-policy")).toContain("sandbox allow-scripts")
    expect(await captcha.text()).toContain(
      '<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>',
    )
    const result = await started.callback()

    expect(result).toStrictEqual({ type: "failed", error: "登录超时，请重新发起登录" })
    if (started.url === undefined) throw new Error("短信登录必须返回本地页 URL")
    await expect(fetch(started.url)).rejects.toThrow()
  })

  test("并发换手机号时，旧的成功响应不能恢复新的失败尝试", async () => {
    let sendCount = 0
    const fetcher = cannedFetch([
      {
        match: "/send_sms",
        respond: async () => {
          const current = sendCount
          sendCount += 1
          if (current === 0) {
            await tick(20)
            return jsonOk({ code: 0 })
          }
          return jsonOk({ code: 100006, message: "captcha failed" })
        },
      },
      { match: "/login_with_sms", respond: jsonOk({ code: 0, data: { access_token: "should-not-run" } }) },
    ])
    const methods = loginMethods({
      options: { phoneCipherSecret: "1234567890123456" },
      client: fakeClient(),
      fetcher,
      signInTimeoutMs: 1_000,
    })
    const started = await oauthMethod(methods, 1).authorize()
    if (started.url === undefined) throw new Error("短信登录必须返回本地页 URL")
    const endpoint = (path: string) => `${started.url}${path}`

    const post = (phone: string) =>
      fetch(endpoint("sms"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, captchaParam: "captcha" }),
      })
    const [oldResponse, newResponse] = await Promise.all([post("13812345678"), post("13912345678")])
    expect(oldResponse.status).toBe(409)
    expect(newResponse.status).toBe(400)
    expect(await newResponse.json()).toMatchObject({ ok: false })

    const verify = await fetch(endpoint("verify"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    })
    expect(verify.status).toBe(400)
    expect(await verify.json()).toStrictEqual({ ok: false, message: "请先获取验证码" })
    expect(fetcher.callsMatching("/login_with_sms")).toHaveLength(0)

    const result = await started.callback()
    expect(result).toStrictEqual({ type: "failed", error: "登录超时，请重新发起登录" })
  })
})
