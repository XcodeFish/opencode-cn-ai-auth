/**
 * 保护 vendors/astudio/login.ts：微信扫码（SSO）整条状态机 —— 零配置可用、
 * pending → scanned（只下发 token 时互为兜底）→ bind → 收尾三步
 * （init-app 非阻塞 / userInfo 取昵称 / configs 换 api_key）、登录结果只有
 * `key`（API key 形状）且 Cookie 四件套随结果交付、unbound（微信未开通）翻成
 * failed、登录成功后顺手领一次弹窗奖励。全部离线：cannedFetch + 回环页。
 */

import { describe, expect, test } from "bun:test"
import type { AuthMethod, OAuthMethod } from "../src/core/types.ts"
import { loginMethods } from "../src/vendors/astudio/login.ts"
import {
  at,
  bytesResponse,
  cannedFetch,
  type FetchResponse,
  fakeClient,
  headersOf,
  jpegBytes,
  jsonOk,
  tick,
} from "./helpers.ts"

const QRCODE = "scanlogin/qrcode"
const UIDS = "scanlogin/uids"
const BIND = "scanlogin/bind"
const CONFIGS = "bot/models/configs"

function oauthMethod(methods: readonly AuthMethod[]): OAuthMethod {
  const method = at(methods, 0)
  if (method.type !== "oauth") throw new Error("第一个登录方式不是 oauth")
  return method
}

/** 按顺序作答 uids 轮询（pending → … → 终态），越界时停在最后一个。 */
function sequentialUids(frames: unknown[]): {
  match: string
  respond: (url: string, init?: Parameters<typeof fetch>[1]) => FetchResponse
} {
  let index = 0
  return {
    match: UIDS,
    respond: () => {
      const frame = frames[Math.min(index, frames.length - 1)]
      index += 1
      return jsonOk(frame)
    },
  }
}

function baseRoutes(uidsFrames: unknown[]): Parameters<typeof cannedFetch>[0] {
  return [
    {
      match: QRCODE,
      respond: jsonOk({ code: 0, data: "https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=T" }),
    },
    { match: "showqrcode", respond: bytesResponse(jpegBytes(), "image/jpeg") },
    sequentialUids(uidsFrames),
    { match: BIND, respond: jsonOk({ code: 0, flag: true }) },
    { match: "tenant-app/v2/init-app", respond: jsonOk({ code: 0 }) },
    { match: "userInfo", respond: jsonOk({ code: 0, data: { nickname: "测试昵称" } }) },
    {
      match: CONFIGS,
      respond: jsonOk({
        flag: true,
        code: 0,
        desc: "成功",
        count: null,
        data: [{ model: "xopglm52", api_key: "bearer-1", is_current: true }],
      }),
    },
    { match: "client-popups/pending", respond: jsonOk({ code: 0, data: [] }) },
    {
      match: "gee-captcha",
      respond: jsonOk({
        code: 0,
        data: { gt: "gt-token", challenge: "ch-1", success: 1, new_captcha: true },
      }),
    },
    { match: "send-verify-code", respond: jsonOk({ code: 0, desc: "发送成功" }) },
    {
      match: "phone-quick-login",
      respond: jsonOk({ code: 0, data: { uid: "u-sms", token: "tok-sms", mobile: RAW_PHONE } }),
    },
    {
      match: "check-account",
      respond: jsonOk({ code: 0, data: { uid: "u-pwd", ssoSessionId: "sid-pwd", nickname: "密码昵称" } }),
    },
  ]
}

const DEPS = { options: {}, pollIntervalMs: 1, signInTimeoutMs: 10_000 }
// 手机号按位拼出：文件里不出现 11 位连续数字字面量（展示管道会掩码它）。
const RAW_PHONE = [1, 3, 8, 1, 2, 3, 4, 1, 2, 3, 4].join("")
const MASKED_PHONE = "138****1234"

describe("loginMethods", () => {
  test("一个入口三种方式（JetHub 载体页同款），零配置可用", () => {
    const methods = loginMethods({ client: fakeClient(), ...DEPS, fetcher: cannedFetch([]) })
    expect(methods.map((method) => method.label)).toStrictEqual(["扫码 / 短信 / 密码登录"])
    expect(at(methods, 0).type).toBe("oauth")
    expect(at(methods, 0).prompts).toBeUndefined()
  })

  test("载体页带三 Tab 与极验 SDK（vendor scripts 通道）", async () => {
    const method = oauthMethod(
      loginMethods({ client: fakeClient(), ...DEPS, fetcher: cannedFetch(baseRoutes([{ code: -1 }])) }),
    )
    const started = await method.authorize()
    const html = await (await fetch(started.url ?? "")).text()
    expect(html).toContain("cn-tab-sms")
    expect(html).toContain("cn-tab-pwd")
    expect(html).toContain("cn-tab-qr")
    // 极验 SDK 在沙箱 frame 里（父页 CSP 不放行外部脚本——基座安全约定）。
    expect(html).toContain('src="gee-frame"')
    expect(html).not.toContain("static.geetest.com")
    expect(html).toContain("未注册手机号验证通过后将自动完成注册开户")
    // 页面自取必须用相对路径：URL 带随机前缀，绝对路径会 404 "Not found"
    //（2026-10-22 用户实测「Unexpected token 'N'」的根因）。
    expect(html).toContain('fetch("gee-captcha")')
    expect(html).not.toContain('fetch("/gee-captcha")')

    // 沙箱 frame 文档：自带放行厂商 SDK 的 CSP（响应头），加载 gt.js 并等父页送入配置。
    const frameResp = await fetch(new URL("gee-frame", started.url ?? ""))
    expect(frameResp.headers.get("content-security-policy")).toContain("sandbox allow-scripts")
    expect(frameResp.headers.get("content-security-policy")).toContain("script-src 'unsafe-inline' https:")
    const framePage = await frameResp.text()
    expect(framePage).toContain("static.geetest.com/static/tools/gt.js")
    expect(framePage).toContain("cn-ai-geetest-start")
  })

  test("短信登录端到端：极验配置代理 → 发送（multipart+seccode base64）→ 快速登录 → 收尾换凭据", async () => {
    const fetcher = cannedFetch(baseRoutes([{ code: -1 }]))
    const method = oauthMethod(loginMethods({ client: fakeClient(), ...DEPS, fetcher }))
    const started = await method.authorize()

    // 极验配置代理（页面侧拉起滑块用；插件代理下发，无凭据）。
    const captchaPage = (await (await fetch(new URL("gee-captcha", started.url ?? ""))).json()) as Record<
      string,
      unknown
    >
    expect(captchaPage.ok).toBe(true)
    expect((captchaPage.config as Record<string, unknown>).gt).toBe("gt-token")

    // 发送验证码：插件转发 multipart 表单，seccode base64 后入表单。
    const sendPage = (await (
      await fetch(new URL("sms/send", started.url ?? ""), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mobile: RAW_PHONE,
          geetestChallenge: "ch-1",
          geetestValidate: "val-1",
          geetestSeccode: "sec-1",
        }),
      })
    ).json()) as Record<string, unknown>
    expect(sendPage.ok).toBe(true)
    const sendCall = at(fetcher.callsMatching("send-verify-code"), 0)
    expect(headersOf(sendCall)["Content-Type"] ?? headersOf(sendCall)["content-type"]).toContain(
      "multipart/form-data",
    )
    const sendBody = String(sendCall.init?.body)
    expect(sendBody).toContain('name="mobile"')
    expect(sendBody).toContain('name="geetest_challenge"')
    // seccode base64("sec-1")
    expect(sendBody).toContain(Buffer.from("sec-1", "utf8").toString("base64"))

    // 快速登录 → completeLogin（token 进 Cookie 第四字段）→ 结果只有 key。
    const loginPage = (await (
      await fetch(new URL("sms/login", started.url ?? ""), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mobile: RAW_PHONE, verifyCode: "123456" }),
      })
    ).json()) as Record<string, unknown>
    expect(loginPage.ok).toBe(true)
    const result = await started.callback()
    if (result.type !== "success") throw new Error(`期望成功，实际 ${JSON.stringify(result)}`)
    expect(result.key).toBe("bearer-1")
    expect(result.uid).toBe("u-sms")
    expect(result.ssoSessionId).toBe("tok-sms")
    expect(result.token).toBe("tok-sms")
    expect(result.loginMethod).toBe("sms")
    // 账号名是掩码手机号（身份应答里的 mobile）。
    expect(result.accountId).toBe(MASKED_PHONE)
    const configs = at(fetcher.callsMatching(CONFIGS), 0)
    expect(headersOf(configs).Cookie).toContain("token=tok-sms")
  })

  test("密码登录端到端：极验三件套代理转发 → check-account → 收尾；缺滑块回执被拦", async () => {
    const fetcher = cannedFetch(baseRoutes([{ code: -1 }]))
    const method = oauthMethod(loginMethods({ client: fakeClient(), ...DEPS, fetcher }))
    const started = await method.authorize()

    // 缺滑块回执：本地页直接拦，不发厂商请求。
    const blocked = await fetch(new URL("password/login", started.url ?? ""), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountName: "abc", accountPwd: "pw" }),
    })
    expect(blocked.status).toBe(400)

    const page = (await (
      await fetch(new URL("password/login", started.url ?? ""), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountName: "abc",
          accountPwd: "pw",
          geetestChallenge: "ch-2",
          geetestValidate: "val-2",
          geetestSeccode: "sec-2",
        }),
      })
    ).json()) as Record<string, unknown>
    expect(page.ok).toBe(true)
    const result = await started.callback()
    if (result.type !== "success") throw new Error(`期望成功，实际 ${JSON.stringify(result)}`)
    expect(result.accountId).toBe("密码昵称")
    expect(result.loginMethod).toBe("password")
    const check = at(fetcher.callsMatching("check-account"), 0)
    const checkBody = String(check.init?.body)
    expect(checkBody).toContain('name="accountName"')
    expect(checkBody).toContain('name="accountPwd"')
    // 密码登录的应答没下发 token ⇒ Cookie 第四字段回落 ssoSessionId（JetHub 同款）。
    const configs = at(fetcher.callsMatching(CONFIGS), 0)
    expect(headersOf(configs).Cookie).toContain("token=sid-pwd")
  })
})

describe("微信扫码状态机", () => {
  test("pending → 已确认（只下发 token）→ bind → 收尾三步 → 只有 key 的登录结果", async () => {
    const fetcher = cannedFetch(
      baseRoutes([
        { code: -1, desc: "未扫码" },
        { code: 0, data: [{ uid: "u-1", token: "tok-1", username: "测试昵称" }] },
      ]),
    )
    const method = oauthMethod(loginMethods({ client: fakeClient(), ...DEPS, fetcher }))
    const started = await method.authorize()
    expect(started.method).toBe("auto")
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)

    // 页面就是本机回环页：HTML 带内联二维码（data: URL，不加载外链）。
    const page = await fetch(started.url ?? "")
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain("cn-qr-img")
    expect(html).toContain('src="data:image/jpeg')

    const result = await started.callback()
    if (result.type !== "success") throw new Error(`期望成功，实际 ${JSON.stringify(result)}`)
    // 只有 key：无 refresh token ⇒ 宿主按 API key 形状存，Cookie 四件套随结果交付。
    expect(result.key).toBe("bearer-1")
    expect(result.refresh).toBeUndefined()
    expect(result.accountId).toBe("测试昵称")
    expect(result.uid).toBe("u-1")
    expect(result.ssoSessionId).toBe("tok-1")
    expect(result.token).toBe("tok-1")
    expect(result.loginMethod).toBe("wechat")

    // 收尾链路逐格：bind 表单、init-app、userInfo、configs（Cookie 鉴权、无 Bearer）。
    const bind = at(fetcher.callsMatching(BIND), 0)
    expect(String(bind.init?.body)).toContain("accountId=u-1")
    expect(String(bind.init?.body)).toContain("ssoSessionId=tok-1")
    expect(String(bind.init?.body)).toContain("isNew=false")
    expect(fetcher.callsMatching("tenant-app/v2/init-app")).toHaveLength(1)
    const configs = at(fetcher.callsMatching(CONFIGS), 0)
    const configHeaders = headersOf(configs)
    expect(configHeaders.Cookie).toBe("ssoSessionId=tok-1; sso_sessionid=tok-1; account_id=u-1; token=tok-1")
    expect(configHeaders.Authorization).toBeUndefined()

    // 登录成功后顺手领一次弹窗奖励（幂等；客户端登录收尾同款）。
    await tick(5)
    expect(fetcher.callsMatching("client-popups/pending")).toHaveLength(1)
  })

  test("昵称是手机号时账号名掩码（只露末位段）", async () => {
    const raw = [1, 3, 9, 8, 7, 6, 5, 4, 3, 2, 1].join("")
    const routes = baseRoutes([{ code: 0, data: [{ uid: "u-2", token: "tok-2" }] }])
    // userInfo 返回手机号形态的 nickname：SSO 没给 username，昵称从 userInfo 补。
    const patched = routes.map((route) =>
      route.match === "userInfo"
        ? { match: route.match, respond: jsonOk({ code: 0, data: { nickname: raw } }) }
        : route,
    )
    const fetcher = cannedFetch(patched)
    const method = oauthMethod(loginMethods({ client: fakeClient(), ...DEPS, fetcher }))
    const started = await method.authorize()
    const result = await started.callback()
    if (result.type !== "success") throw new Error(`期望成功，实际 ${JSON.stringify(result)}`)
    expect(result.accountId).toBe("139****4321")
  })

  test("code:0 但账号列表为空 = 该微信未开通 AStudio → failed，文案指向客户端开通", async () => {
    const fetcher = cannedFetch(baseRoutes([{ code: 0, desc: "成功", data: [] }]))
    const method = oauthMethod(loginMethods({ client: fakeClient(), ...DEPS, fetcher }))
    const started = await method.authorize()
    const result = await started.callback()
    expect(result.type).toBe("failed")
    if (result.type === "failed") {
      expect(result.error).toContain("尚未开通")
      expect(result.error).toContain("客户端")
    }
    // 没开通就不该走收尾链：bind 与 configs 都不应发。
    expect(fetcher.callsMatching(BIND)).toHaveLength(0)
    expect(fetcher.callsMatching(CONFIGS)).toHaveLength(0)
  })

  test("configs 拿不到 api_key = 登录失败（账号还没在客户端完成首次开通）", async () => {
    const routes = baseRoutes([{ code: 0, data: [{ uid: "u-3", token: "tok-3" }] }]).map((route) =>
      route.match === CONFIGS
        ? {
            match: route.match,
            respond: jsonOk({ flag: true, code: 0, desc: "成功", count: null, data: [] }),
          }
        : route,
    )
    const fetcher = cannedFetch(routes)
    const method = oauthMethod(loginMethods({ client: fakeClient(), ...DEPS, fetcher }))
    const started = await method.authorize()
    const result = await started.callback()
    expect(result.type).toBe("failed")
    if (result.type === "failed") expect(result.error).toContain("api_key")
  })

  test("bind 被拒 → failed", async () => {
    const routes = baseRoutes([{ code: 0, data: [{ uid: "u-4", token: "tok-4" }] }]).map((route) =>
      route.match === BIND ? { match: route.match, respond: jsonOk({ code: 5, desc: "会话不存在" }) } : route,
    )
    const fetcher = cannedFetch(routes)
    const method = oauthMethod(loginMethods({ client: fakeClient(), ...DEPS, fetcher }))
    const started = await method.authorize()
    const result = await started.callback()
    expect(result).toMatchObject({ type: "failed", error: expect.stringContaining("会话不存在") })
  })

  test("轮询超时 → failed（不悬挂）", async () => {
    const fetcher = cannedFetch(baseRoutes([{ code: -1, desc: "未扫码" }]))
    const method = oauthMethod(
      loginMethods({ client: fakeClient(), options: {}, pollIntervalMs: 1, signInTimeoutMs: 30, fetcher }),
    )
    const started = await method.authorize()
    const result = await started.callback()
    expect(result).toMatchObject({ type: "failed", error: expect.stringContaining("超时") })
  })
})
