/**
 * 保护 vendors/loomy/login.ts：微信扫码不依赖用户 AccessKey，短信方法随配置变化、
 * 短信 authorize 先发 sendMsgCode 并返回 method:"code"、callback 空码与失败答复、
 * signInResult 的形状（refresh 为空串、expires 约 14 天、accountId 是掩码手机号），
 * 以及微信扫码的整条状态机（回环页 + 长轮询 + 已绑定账号的一步换 session）。
 * 微信流程用的是**本机回环页**，所有出网请求都走 cannedFetch，不碰真实微信。
 */

import { describe, expect, test } from "bun:test"
import type { AuthMethod, OAuthMethod } from "../src/core/types.ts"
import { LOOMY_CLIENT_ACCESS_KEYS } from "../src/vendors/loomy/bundled-credentials.ts"
import { accountKeys, loginMethods, signInResult } from "../src/vendors/loomy/login.ts"
import {
  LOOMY_SESSION_TTL_SECONDS,
  LOOMY_SMS_SEND_COOLDOWN_MS,
  LOOMY_SMS_SENDS_PER_FLOW,
} from "../src/vendors/loomy/product.ts"
import { at, cannedFetch, fakeClient, headersOf, jpegBytes, jsonOk, textBody, tick } from "./helpers.ts"

const KEYS = { accessKeyId: "ak-test", accessKeySecret: "sk-test" }
const ENV_KEYS = ["LOOMY_XFYUN_ACCESS_KEY_ID", "LOOMY_XFYUN_ACCESS_KEY_SECRET"] as const
const SUCCESS = "https://account.xfinfr.com/login/phone/checkCode"

function oauthMethod(methods: readonly AuthMethod[], index: number): OAuthMethod {
  const method = at(methods, index)
  if (method.type !== "oauth") throw new Error(`方法 ${index} 不是 oauth`)
  return method
}

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => void): void {
  const saved = ENV_KEYS.map((key) => process.env[key])
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value
  }
  try {
    run()
  } finally {
    ENV_KEYS.forEach((key, index) => {
      const value = saved[index]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    })
  }
}

async function withEnvAsync<T>(
  values: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  run: () => Promise<T>,
): Promise<T> {
  const saved = ENV_KEYS.map((key) => process.env[key])
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value
  }
  try {
    return await run()
  } finally {
    ENV_KEYS.forEach((key, index) => {
      const value = saved[index]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    })
  }
}

describe("loginMethods", () => {
  test("什么都不配时两条路都在：短信登录用的是随包客户端常量", () => {
    withEnv({}, () => {
      const methods = loginMethods({ client: fakeClient(), options: {}, fetcher: cannedFetch([]) })
      expect(methods.map((method) => method.label)).toStrictEqual(["微信扫码登录", "短信验证码登录"])
      expect(at(methods, 0).type).toBe("oauth")
      expect(at(methods, 0).prompts).toBeUndefined()
    })
  })

  test("只给一半 AccessKey 时退回随包常量，短信不消失", () => {
    withEnv({}, () => {
      const methods = loginMethods({
        client: fakeClient(),
        options: { accessKeyId: "ak-test" },
        fetcher: cannedFetch([]),
      })
      expect(methods.map((method) => method.label)).toStrictEqual(["微信扫码登录", "短信验证码登录"])
      expect(accountKeys({ accessKeyId: "ak-test" })).toStrictEqual(LOOMY_CLIENT_ACCESS_KEYS)
    })
  })

  test("options 里给全 AccessKey 时用户的键覆盖随包常量", () => {
    withEnv({}, () => {
      const methods = loginMethods({ client: fakeClient(), options: KEYS, fetcher: cannedFetch([]) })
      expect(methods.map((method) => method.label)).toStrictEqual(["微信扫码登录", "短信验证码登录"])
      expect(at(methods, 1).type).toBe("oauth")
      expect(oauthMethod(methods, 1).prompts).toBeUndefined()
      expect(accountKeys(KEYS)).toStrictEqual(KEYS)
    })
  })

  test("环境变量里的 AccessKey 覆盖随包常量", () => {
    withEnv(
      {
        LOOMY_XFYUN_ACCESS_KEY_ID: "env-ak",
        LOOMY_XFYUN_ACCESS_KEY_SECRET: "env-sk",
      },
      () => {
        const methods = loginMethods({ client: fakeClient(), options: {}, fetcher: cannedFetch([]) })
        expect(methods.map((method) => method.label)).toStrictEqual(["微信扫码登录", "短信验证码登录"])
        expect(accountKeys({})).toStrictEqual({ accessKeyId: "env-ak", accessKeySecret: "env-sk" })
      },
    )
  })

  test("options.smsLogin 为 false 时只剩微信扫码，用户配了 AccessKey 也一样", () => {
    withEnv({}, () => {
      const off = { smsLogin: false }
      expect(loginMethods({ client: fakeClient(), options: off, fetcher: cannedFetch([]) })).toHaveLength(1)
      expect(
        loginMethods({ client: fakeClient(), options: { ...off, ...KEYS }, fetcher: cannedFetch([]) }).map(
          (method) => method.label,
        ),
      ).toStrictEqual(["微信扫码登录"])
      expect(accountKeys(off)).toBeUndefined()
    })
  })
})

describe("短信方法的 authorize / callback", () => {
  function smsFlow(options: Record<string, unknown>) {
    let claimStarted: (() => void) | undefined
    const claimStartedPromise = new Promise<void>((resolve) => {
      claimStarted = resolve
    })
    const fetcher = cannedFetch([
      {
        match: "/login/phone/sendMsgCode",
        respond: jsonOk({ code: "000000", desc: "", data: { msgid: "msg-1" } }),
      },
      {
        match: "/login/phone/checkCode",
        respond: jsonOk({
          code: "000000",
          desc: "",
          data: { session: "sess-32hex", userid: "u-1", phone: "13812345678" },
        }),
      },
      {
        match: "/points/first-login",
        respond: () => {
          claimStarted?.()
          return jsonOk({
            code: "000000",
            data: {
              alreadyProcessed: false,
              dailyQuota: 5000,
              dailyConsumed: 0,
              dailyCycleDate: "2026-10-15",
            },
          })
        },
      },
    ])
    const client = fakeClient()
    const method = oauthMethod(loginMethods({ client, options, fetcher, signInTimeoutMs: 50 }), 1)
    return { client, fetcher, method, claimStartedPromise }
  }

  async function postPage(url: string, path: string, body: Record<string, string>): Promise<Response> {
    return await fetch(new URL(path, url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  test("authorize 打开本地页，页面发送验证码并返回 method:'auto'", async () => {
    const { fetcher, method } = smsFlow(KEYS)
    const before = Date.now()
    const started = await method.authorize()
    expect(started.method).toBe("auto")
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/)
    expect((await fetch(started.url ?? "")).status).toBe(200)

    const send = await postPage(started.url ?? "", "sms", { phone: "138 1234 5678" })
    expect(send.status).toBe(200)
    const sentBody = (await send.json()) as { ok: boolean; message: string; retryAfterMs: number }
    expect(sentBody.ok).toBe(true)
    expect(sentBody.message).toContain("验证码已发送到 138****5678")
    expect(sentBody.retryAfterMs).toBe(LOOMY_SMS_SEND_COOLDOWN_MS)

    const sendCall = at(fetcher.calls, 0)
    expect(sendCall.url).toBe("https://account.xfinfr.com/login/phone/sendMsgCode")
    expect(headersOf(sendCall).Authorization).toMatch(/^account ak-test:[A-Za-z0-9+/=]+$/)
    const sent = JSON.parse(String(sendCall.init?.body)) as { param: Record<string, unknown> }
    expect(sent.param).toStrictEqual({ ccode: "86", phone: "13812345678", expire: 300 })

    const empty = await postPage(started.url ?? "", "verify", { code: "   " })
    expect(JSON.parse(await empty.text())).toStrictEqual({ ok: false, message: "请输入短信验证码" })

    const verified = await postPage(started.url ?? "", "verify", { code: " 123456 " })
    expect(JSON.parse(await verified.text())).toStrictEqual({ ok: true })
    const result = await started.callback()
    if (result.type !== "success") throw new Error(`期望成功结果，实际 ${JSON.stringify(result)}`)
    expect(result.access).toBe("sess-32hex")
    expect(result.refresh).toBe("")
    expect(result.userid).toBe("u-1")
    expect(result.phone).toBe("13812345678")
    expect(result.accountId).toBe("138****5678")
    // 登录时拿到的当日配额随登录结果一起交给宿主：新账号的今日窗口因此
    // 立刻有百分比，不用等用户手动签到（`points/records` 不给 dailyQuota）。
    expect(result.dailyQuota).toBe(5000)
    expect(result.dailyCycleDate).toBe("2026-10-15")
    expect(result.expires).toBeGreaterThanOrEqual(before + LOOMY_SESSION_TTL_SECONDS * 1000)
    expect(result.expires).toBeLessThanOrEqual(Date.now() + LOOMY_SESSION_TTL_SECONDS * 1000)

    const checkCall = at(fetcher.calls, 1)
    expect(checkCall.url).toBe(SUCCESS)
    const checked = JSON.parse(String(checkCall.init?.body)) as { param: Record<string, unknown> }
    expect(checked.param).toStrictEqual({
      ccode: "86",
      phone: "13812345678",
      mcode: "123456",
      msgid: "msg-1",
      expire: 1_209_600,
    })
  })

  test("获取验证码按钮在验证码输入框右侧，且页面自带倒计时", async () => {
    const { method } = smsFlow(KEYS)
    const started = await method.authorize()
    const html = await (await fetch(started.url ?? "")).text()

    // 同一行里是「验证码输入框 + 获取验证码按钮」，手机号单独一行。
    const row = html.slice(html.indexOf("cn-row"), html.indexOf("</div>", html.indexOf('id="cn-code"')))
    expect(row).toContain('id="cn-code"')
    expect(row).toContain('id="cn-send"')
    expect(row.indexOf('id="cn-code"')).toBeLessThan(row.indexOf('id="cn-send"'))
    expect(html).not.toMatch(/id="cn-phone"[\s\S]{0,120}id="cn-send"/)

    // 倒计时读服务端给的 retryAfterMs，并且按号码记账。
    expect(html).toContain("秒后可重发")
    expect(html).toContain("data.retryAfterMs")
    expect(html).toContain("notBefore[target]")
    expect(html).toContain('phone.addEventListener("input", paint)')

    await started.callback()
  })

  test("callback 成功后顺手初始化每日额度", async () => {
    const { client, fetcher, method, claimStartedPromise } = smsFlow(KEYS)
    const started = await method.authorize()
    await postPage(started.url ?? "", "sms", { phone: "13812345678" })
    await postPage(started.url ?? "", "verify", { code: "123456" })
    expect((await started.callback()).type).toBe("success")
    await claimStartedPromise
    expect(fetcher.callsMatching("/points/first-login")).toHaveLength(1)
    expect(client.logs).toStrictEqual([])
  })

  test("业务失败翻成 {type:'failed'}", async () => {
    const fetcher = cannedFetch([
      { match: "/login/phone/sendMsgCode", respond: jsonOk({ code: "000000", data: { msgid: "msg-1" } }) },
      { match: "/login/phone/checkCode", respond: jsonOk({ code: "520001", desc: "验证码错误" }) },
    ])
    const method = oauthMethod(
      loginMethods({ client: fakeClient(), options: KEYS, fetcher, signInTimeoutMs: 50 }),
      1,
    )
    const started = await method.authorize()
    await postPage(started.url ?? "", "sms", { phone: "13812345678" })
    const verify = await postPage(started.url ?? "", "verify", { code: "000000" })
    expect(JSON.parse(await verify.text())).toStrictEqual({ ok: false, message: "loomy: 验证码错误" })
    expect((await started.callback()).type).toBe("failed")
  })

  test("手机号非法就不发请求", async () => {
    const fetcher = cannedFetch([])
    const method = oauthMethod(
      loginMethods({ client: fakeClient(), options: KEYS, fetcher, signInTimeoutMs: 50 }),
      1,
    )
    const started = await method.authorize()
    const response = await postPage(started.url ?? "", "sms", { phone: "123" })
    expect(JSON.parse(await response.text())).toStrictEqual({
      ok: false,
      message: "请输入有效的 11 位手机号",
    })
    await started.callback()
    expect(fetcher.calls).toHaveLength(0)
  })

  test("登录额度拿不到时照常登录，只是不带 quota（不阻断登录）", async () => {
    const fetcher = cannedFetch([
      {
        match: "/login/phone/sendMsgCode",
        respond: jsonOk({ code: "000000", desc: "", data: { msgid: "msg-1" } }),
      },
      {
        match: "/login/phone/checkCode",
        respond: jsonOk({
          code: "000000",
          desc: "",
          data: { session: "sess-2", userid: "u-2", phone: "13812345678" },
        }),
      },
      { match: "/points/first-login", respond: jsonOk({ code: "520001", desc: "额度服务抖动" }) },
    ])
    const method = oauthMethod(
      loginMethods({ client: fakeClient(), options: KEYS, fetcher, signInTimeoutMs: 50 }),
      1,
    )
    const started = await method.authorize()
    await postPage(started.url ?? "", "sms", { phone: "13812345678" })
    const verified = await postPage(started.url ?? "", "verify", { code: "123456" })
    expect(JSON.parse(await verified.text())).toStrictEqual({ ok: true })
    const result = await started.callback()
    if (result.type !== "success") throw new Error(`额度失败不该挡住登录，实际 ${JSON.stringify(result)}`)
    expect(result.access).toBe("sess-2")
    // quota 没拿到就不写字段，窗口退回「上限未知」而不是写个假的。
    expect("dailyQuota" in result).toBe(false)
    expect("dailyCycleDate" in result).toBe(false)
  })

  test("额度接口挂住时按超时上限放行，登录不会被拖住", async () => {
    const fetcher = cannedFetch([
      {
        match: "/login/phone/sendMsgCode",
        respond: jsonOk({ code: "000000", desc: "", data: { msgid: "msg-1" } }),
      },
      {
        match: "/login/phone/checkCode",
        respond: jsonOk({
          code: "000000",
          desc: "",
          data: { session: "sess-3", userid: "u-3", phone: "13812345678" },
        }),
      },
      {
        match: "/points/first-login",
        // 永不 resolve：模拟接口挂住，验证 raceQuota 会兜底。
        respond: () => new Promise<never>(() => {}),
      },
    ])
    const method = oauthMethod(
      loginMethods({
        client: fakeClient(),
        options: KEYS,
        fetcher,
        signInTimeoutMs: 60_000,
        // 上限调小，测试不必真等 8 秒。
        quotaDeadlineMs: 300,
      }),
      1,
    )
    const started = await method.authorize()
    await postPage(started.url ?? "", "sms", { phone: "13812345678" })
    const began = Date.now()
    await postPage(started.url ?? "", "verify", { code: "123456" })
    const result = await started.callback()
    const waited = Date.now() - began
    if (result.type !== "success") throw new Error(`应当登录成功，实际 ${JSON.stringify(result)}`)
    expect("dailyQuota" in result).toBe(false)
    expect(waited).toBeLessThan(5_000)
  }, 30_000)

  test("同一号码两次发送之间隔 60 秒，且响应带 retryAfterMs", async () => {
    let clock = 1_700_000_000_000
    const fetcher = cannedFetch([
      {
        match: "/login/phone/sendMsgCode",
        respond: jsonOk({ code: "000000", desc: "", data: { msgid: "msg-1" } }),
      },
    ])
    const method = oauthMethod(
      loginMethods({
        client: fakeClient(),
        options: KEYS,
        fetcher,
        signInTimeoutMs: 50,
        now: () => clock,
      }),
      1,
    )
    const started = await method.authorize()
    const first = await postPage(started.url ?? "", "sms", { phone: "13812345678" })
    expect((await first.json()) as { ok: boolean }).toMatchObject({ ok: true })

    clock += LOOMY_SMS_SEND_COOLDOWN_MS - 1
    const tooSoon = await postPage(started.url ?? "", "sms", { phone: "13812345678" })
    expect(tooSoon.status).toBe(429)
    expect(JSON.parse(await tooSoon.text())).toStrictEqual({
      ok: false,
      message: "验证码刚刚已发送，请稍后再试",
    })

    clock += 1
    const later = await postPage(started.url ?? "", "sms", { phone: "13812345678" })
    expect((await later.json()) as { ok: boolean }).toMatchObject({ ok: true })
    expect(fetcher.callsMatching("/login/phone/sendMsgCode")).toHaveLength(2)

    await started.callback()
  })

  test("换一个号码不受上一个号码的冷却影响（填错了能马上改）", async () => {
    const clock = 1_700_000_000_000
    const fetcher = cannedFetch([
      {
        match: "/login/phone/sendMsgCode",
        respond: jsonOk({ code: "000000", desc: "", data: { msgid: "msg-1" } }),
      },
    ])
    const method = oauthMethod(
      loginMethods({
        client: fakeClient(),
        options: KEYS,
        fetcher,
        signInTimeoutMs: 50,
        now: () => clock,
      }),
      1,
    )
    const started = await method.authorize()
    const wrong = await postPage(started.url ?? "", "sms", { phone: "13800000000" })
    expect((await wrong.json()) as { ok: boolean }).toMatchObject({ ok: true })

    // 立刻改成另一个号码：不该被上一个号码的冷却挡住。
    const right = await postPage(started.url ?? "", "sms", { phone: "13812345678" })
    expect((await right.json()) as { ok: boolean }).toMatchObject({ ok: true })
    expect(fetcher.callsMatching("/login/phone/sendMsgCode")).toHaveLength(2)

    await started.callback()
  })

  test("一次登录最多发 3 条，之后不再请求厂商", async () => {
    let clock = 1_700_000_000_000
    const fetcher = cannedFetch([
      {
        match: "/login/phone/sendMsgCode",
        respond: jsonOk({ code: "000000", desc: "", data: { msgid: "msg-1" } }),
      },
    ])
    const method = oauthMethod(
      loginMethods({
        client: fakeClient(),
        options: KEYS,
        fetcher,
        signInTimeoutMs: 50,
        now: () => clock,
      }),
      1,
    )
    const started = await method.authorize()
    for (let attempt = 0; attempt < LOOMY_SMS_SENDS_PER_FLOW; attempt++) {
      const sent = await postPage(started.url ?? "", "sms", { phone: "13812345678" })
      expect((await sent.json()) as { ok: boolean }).toMatchObject({ ok: true })
      clock += LOOMY_SMS_SEND_COOLDOWN_MS
    }
    const extra = await postPage(started.url ?? "", "sms", { phone: "13812345678" })
    expect(extra.status).toBe(429)
    expect(JSON.parse(await extra.text())).toStrictEqual({
      ok: false,
      message: "验证码发送次数过多，请关闭页面后重新发起登录",
    })
    expect(fetcher.callsMatching("/login/phone/sendMsgCode")).toHaveLength(LOOMY_SMS_SENDS_PER_FLOW)

    await started.callback()
  })
})

describe("signInResult", () => {
  const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)

  test("有手机号时 accountId 是掩码，expires 是 14 天", () => {
    expect(signInResult({ access: "sess-1", userid: "u-1", phone: "13812345678" }, NOW)).toStrictEqual({
      type: "success",
      access: "sess-1",
      refresh: "",
      expires: NOW + 1_209_600_000,
      accountId: "138****5678",
      userid: "u-1",
      phone: "13812345678",
    })
  })

  test("没有手机号时 accountId 用 userid", () => {
    const result = signInResult({ access: "sess-1", userid: "u-1" }, NOW)
    expect(result).toStrictEqual({
      type: "success",
      access: "sess-1",
      refresh: "",
      expires: NOW + 1_209_600_000,
      accountId: "u-1",
      userid: "u-1",
    })
    expect("phone" in result).toBe(false)
  })
})

describe("微信扫码流程", () => {
  const AUTH_PAGE = '<img class="js_qrcode_img" src="/connect/qrcode/QRUUID123456">'
  const BOUND = { code: "000000", desc: "", data: { rcode: "rcode-1", bind: 1 } }

  /** 一整套 canned 路由：授权页 → 二维码图 → 轮询确认 → bind → first-login。 */
  function wechatFetcher(polls: readonly string[], bound = true): ReturnType<typeof cannedFetch> {
    let index = 0
    return cannedFetch([
      { match: "open.weixin.qq.com/connect/qrconnect", respond: textBody(AUTH_PAGE) },
      { match: "open.weixin.qq.com/connect/qrcode/", respond: () => new Response(jpegBytes()) },
      {
        match: "long.open.weixin.qq.com/connect/l/qrconnect",
        respond: async () => {
          const poll = polls[index++]
          if (poll !== undefined) return textBody(poll)
          await tick(5)
          return textBody("wx_errcode=408;")
        },
      },
      {
        match: "/login/thirdAccount/bind/auth",
        respond: jsonOk({ ...BOUND, data: { ...BOUND.data, bind: bound ? 1 : 0 } }),
      },
      {
        match: "/login/thirdAccount/bind/sendMsg",
        respond: jsonOk({ code: "000000", desc: "", data: { msgid: "bind-msg-1" } }),
      },
      {
        match: "/login/thirdAccount/bind/checkCode",
        respond: jsonOk({
          code: "000000",
          desc: "",
          data: { session: "sess-bound", userid: "u-bound", phone: "13812345678" },
        }),
      },
      {
        match: "/login/thirdAccount/bind/skip",
        respond: jsonOk({
          code: "000000",
          desc: "",
          data: { session: "sess-wechat", userid: "u-wx", phone: "13812345678" },
        }),
      },
      {
        match: "/points/first-login",
        respond: jsonOk({
          code: "000000",
          desc: "",
          data: { alreadyProcessed: true, dailyQuota: 5000, dailyConsumed: 0, dailyBalance: 5000 },
        }),
      },
    ])
  }

  test("扫到已绑定的账号：轮询确认后直接换 session 并初始化当日额度", async () => {
    const fetcher = wechatFetcher(["wx_errcode=408;", "wx_errcode=404;", "wx_errcode=405; wx_code='CODE-1';"])
    const client = fakeClient()
    const method = oauthMethod(loginMethods({ client, options: KEYS, fetcher }), 0)

    const started = await method.authorize()
    expect(started.method).toBe("auto")
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/)

    // 页面本身就是本机回环页：先取一次 HTML，再由长轮询推进到 done。
    const page = await fetch(started.url ?? "")
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("cn-qr-img")

    const result = await started.callback()
    if (result.type !== "success") throw new Error(`期望成功，实际 ${JSON.stringify(result)}`)
    expect(result.access).toBe("sess-wechat")
    expect(result.accountId).toBe("138****5678")
    expect(result.refresh).toBe("")

    // A delayed browser action must not mutate the settled flow or send a
    // second binding request after the QR login has completed.
    const late = await fetch(new URL("phone", started.url ?? ""), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "13812345678" }),
    })
    expect(late.status).toBe(409)
    expect(fetcher.callsMatching("/login/thirdAccount/bind/sendMsg")).toHaveLength(0)

    // QR uses its bundled client key even when optional SMS credentials are configured.
    const bindCall = fetcher.callsMatching("/login/thirdAccount/bind/auth")
    expect(bindCall).toHaveLength(1)
    expect(headersOf(at(bindCall, 0)).Authorization).toMatch(/^account [^:]+:[A-Za-z0-9+/=]+$/)
    expect(headersOf(at(bindCall, 0)).Authorization).not.toContain("ak-test")

    // first-login 是**登录后**的额度初始化：微信路径也必须调用（与官方客户端一致）。
    await tick(5)
    expect(fetcher.callsMatching("/points/first-login")).toHaveLength(1)
  })

  test("取消扫码翻成 failed，且不换 session", async () => {
    const fetcher = wechatFetcher(["wx_errcode=403;"])
    const method = oauthMethod(loginMethods({ client: fakeClient(), options: KEYS, fetcher }), 0)
    const started = await method.authorize()
    await expect(started.callback()).resolves.toMatchObject({ type: "failed" })
    expect(fetcher.callsMatching("/login/thirdAccount/bind/skip")).toHaveLength(0)
    expect(fetcher.callsMatching("/points/first-login")).toHaveLength(0)
  })

  test("同一 code 的重复确认帧不再二次花掉这个一次性 code", async () => {
    // 微信的 code 只能用一次：确认那一帧的 code 一旦换到 rcode，后面再来的
    // 405 只能是同一帧的重复，绝不能拿它再打一次 bind/auth（服务会回 270101）。
    // 这个 fetcher 对同一 code 的第二次调用如实回答 270101。
    const AUTH_PAGE = '<img class="js_qrcode_img" src="/connect/qrcode/QRUUID123456">'
    const jpeg = () => new Response(jpegBytes())
    const pollFrames = ["wx_errcode=405; wx_code='CODE-1';", "wx_errcode=405; wx_code='CODE-1';"]
    let pollIndex = 0
    const bindCodes: string[] = []
    const fetcher = cannedFetch([
      { match: "open.weixin.qq.com/connect/qrconnect", respond: textBody(AUTH_PAGE) },
      { match: "open.weixin.qq.com/connect/qrcode/", respond: jpeg },
      {
        match: "long.open.weixin.qq.com/connect/l/qrconnect",
        respond: async () => {
          const frame = pollFrames[pollIndex++]
          if (frame !== undefined) return textBody(frame)
          await tick(5)
          return textBody("wx_errcode=408;")
        },
      },
      {
        match: "/login/thirdAccount/bind/auth",
        respond: (_url, init) => {
          const code = JSON.parse(String(init?.body)).param.tcode.code as string
          bindCodes.push(code)
          const used = bindCodes.filter((item) => item === code).length
          return used > 1
            ? jsonOk({ code: "270101", desc: "第三方鉴权失败" })
            : jsonOk({ code: "000000", desc: "", data: { rcode: "rcode-1", bind: 0 } })
        },
      },
      {
        match: "/login/thirdAccount/bind/skip",
        respond: jsonOk({ code: "000000", data: { session: "sess-wechat", userid: "u-wx" } }),
      },
      { match: "/points/first-login", respond: jsonOk({ code: "000000", data: {} }) },
    ])
    const method = oauthMethod(
      loginMethods({ client: fakeClient(), options: {}, fetcher, signInTimeoutMs: 800 }),
      0,
    )
    const started = await method.authorize()
    // 让流程跑到超时收尾：这两帧确认一定都被消费过了，若还有第二次提交，
    // 它在 callback 落定前就已经发出。
    const result = await started.callback()
    expect(result.type).toBe("failed")
    expect(bindCodes).toStrictEqual(["CODE-1"])
    expect(fetcher.callsMatching("/login/thirdAccount/bind/auth")).toHaveLength(1)
  }, 10_000)

  test("无用户 AccessKey 时，扫码与首次手机号绑定都能完成", async () => {
    await withEnvAsync({}, async () => {
      const fetcher = wechatFetcher(["wx_errcode=405; wx_code='CODE-1';"], false)
      const method = oauthMethod(
        loginMethods({ client: fakeClient(), options: {}, fetcher, signInTimeoutMs: 4_000 }),
        0,
      )
      const started = await method.authorize()
      const pageUrl = started.url
      if (pageUrl === undefined) throw new Error("扫码流程没有返回本地页面地址")

      for (
        let attempt = 0;
        attempt < 50 && fetcher.callsMatching("/login/thirdAccount/bind/auth").length === 0;
        attempt++
      ) {
        await tick(1)
      }
      expect(fetcher.callsMatching("/login/thirdAccount/bind/auth")).toHaveLength(1)
      await tick(10)
      const state = (await (await fetch(new URL("state", pageUrl))).json()) as {
        generation: number
        uuid: string
      }

      const send = await fetch(new URL("phone", pageUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone: "13812345678",
          generation: state.generation,
          uuid: state.uuid,
        }),
      })
      expect(await send.json()).toMatchObject({ ok: true })

      const verify = await fetch(new URL("verify", pageUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "123456",
          generation: state.generation,
          uuid: state.uuid,
        }),
      })
      expect(await verify.json()).toMatchObject({ ok: true })

      const result = await started.callback()
      if (result.type !== "success") throw new Error(`期望成功，实际 ${JSON.stringify(result)}`)
      expect(result.access).toBe("sess-bound")
      expect(result.accountId).toBe("138****5678")

      for (const path of [
        "/login/thirdAccount/bind/auth",
        "/login/thirdAccount/bind/sendMsg",
        "/login/thirdAccount/bind/checkCode",
      ]) {
        const calls = fetcher.callsMatching(path)
        expect(calls).toHaveLength(1)
        expect(headersOf(at(calls, 0)).Authorization).toMatch(/^account [^:]+:[A-Za-z0-9+/=]+$/)
      }
    })
  }, 10_000)

  test("二维码换代后，旧页面的绑定请求返回 409 且不再发短信", async () => {
    const fetcher = wechatFetcher(["wx_errcode=405; wx_code='CODE-1';", "wx_errcode=402;"], false)
    const method = oauthMethod(
      loginMethods({ client: fakeClient(), options: {}, fetcher, signInTimeoutMs: 2_500 }),
      0,
    )
    const started = await method.authorize()
    const pageUrl = started.url
    if (pageUrl === undefined) throw new Error("扫码流程没有返回本地页面地址")

    for (
      let attempt = 0;
      attempt < 100 && fetcher.callsMatching("/login/thirdAccount/bind/auth").length === 0;
      attempt++
    ) {
      await tick(1)
    }
    expect(fetcher.callsMatching("/login/thirdAccount/bind/auth")).toHaveLength(1)
    const oldState = (await (await fetch(new URL("state", pageUrl))).json()) as {
      generation: number
      uuid: string
    }
    for (
      let attempt = 0;
      attempt < 100 && fetcher.callsMatching("long.open.weixin.qq.com").length < 2;
      attempt++
    ) {
      await tick(1)
    }
    await tick(5)

    const late = await fetch(new URL("phone", pageUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phone: "13812345678",
        generation: oldState.generation,
        uuid: oldState.uuid,
      }),
    })
    expect(late.status).toBe(409)
    expect(fetcher.callsMatching("/login/thirdAccount/bind/sendMsg")).toHaveLength(0)
    expect((await started.callback()).type).toBe("failed")
  }, 10_000)
})
