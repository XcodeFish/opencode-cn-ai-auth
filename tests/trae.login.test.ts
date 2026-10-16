/**
 * 保护 vendors/trae/login.ts：登录 URL 的参数集、回调解析、续期。
 *
 * 这些是最容易「看着对、实际把用户卡在授权页」的地方：回调参数名写错、
 * 回调里找 OAuth 的 code、把 PKCE 回调当成非法回调。三条都各有一条断言。
 */

import { describe, expect, test } from "bun:test"
import {
  buildLoginUrl,
  challengeOf,
  completeSignIn,
  fixNickname,
  loginMethods,
  newPkce,
  parseCallback,
  refreshCredential,
  traceIdOf,
} from "../src/vendors/trae/login.ts"
import { cannedFetch, jsonOk } from "./helpers.ts"

const MACHINE = "a".repeat(32)
const DEVICE = "b".repeat(32)
const PKCE = { codeVerifier: "v".repeat(43), codeChallenge: "c".repeat(43) }

describe("登录 URL", () => {
  test("回调参数是 auth_callback_url，并带齐通道与客户端伪装参数", () => {
    const url = new URL(buildLoginUrl(MACHINE, DEVICE, "http://127.0.0.1:18080/authorize", PKCE))
    expect(url.origin + url.pathname).toBe("https://www.trae.cn/authorization")
    const params = url.searchParams
    expect(params.get("auth_callback_url")).toBe("http://127.0.0.1:18080/authorize")
    // 写错名字的那个参数不能出现。
    expect(params.get("callback_url")).toBeNull()
    expect(params.get("redirect_uri")).toBeNull()
    expect(params.get("auth_from")).toBe("solo")
    expect(params.get("login_channel")).toBe("native_ide")
    expect(params.get("auth_type")).toBe("local")
    expect(params.get("machine_id")).toBe(MACHINE)
    expect(params.get("device_id")).toBe(DEVICE)
    expect(params.get("login_trace_id")).toBe(traceIdOf(MACHINE, DEVICE))
    // 当前客户端用 PKCE：少了这一对，控制台会走它已经不再签发令牌的老流程
    // （用户看到的「登录失败 / 网络错误」就是这个）。
    expect(params.get("code_challenge")).toBe(PKCE.codeChallenge)
    expect(params.get("code_challenge_method")).toBe("S256")
    // 版本号取自厂商自己的客户端 bundle，不是旧构建的值。
    expect(params.get("plugin_version")).toBe("2.3.91092")
    expect(params.get("x_app_version")).toBe("3.4.2")
    // solo 客户端才会带这一项（官方客户端同款）。
    expect(params.get("hide_saas_login")).toBe("true")
  })

  test("PKCE 校验串符合 RFC 7636 的 S256 形状", () => {
    const pkce = newPkce()
    expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43)
    expect(pkce.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pkce.codeChallenge).toBe(challengeOf(pkce.codeVerifier))
    expect(pkce.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // 每次都不一样。
    expect(newPkce().codeVerifier).not.toBe(pkce.codeVerifier)
  })
})

describe("回调解析", () => {
  test("refreshToken 直传的形态能解出账号", () => {
    const userInfo = encodeURIComponent(
      JSON.stringify({ UserID: "u-1", ScreenName: "张三", TenantID: "t-1" }),
    )
    const parsed = parseCallback(`/authorize?refreshToken=rt&userInfo=${userInfo}`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.callback.refreshToken).toBe("rt")
    expect(parsed.callback.uid).toBe("u-1")
    expect(parsed.callback.nickname).toBe("张三")
    // 回调里的字段名是 TenantID，不是 EnterpriseID。
    expect(parsed.callback.enterpriseId).toBe("t-1")
  })

  test("query 没有 refreshToken 时回退 userJwt 里的", () => {
    const userJwt = encodeURIComponent(JSON.stringify({ RefreshToken: "rt-from-jwt" }))
    const parsed = parseCallback(`/authorize?userJwt=${userJwt}`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.callback.refreshToken).toBe("rt-from-jwt")
  })

  test("只有 userJwt.Token 时用它兜底，参数名标为 accessToken", () => {
    const userJwt = encodeURIComponent(JSON.stringify({ Token: "at-only" }))
    const parsed = parseCallback(`/authorize?userJwt=${userJwt}`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.callback.accessToken).toBe("at-only")
    expect(parsed.callback.refreshToken).toBe("")
  })

  test("PKCE 回调给出 authCodeInfo.AuthCode，且带着用户信息", () => {
    const userInfo = encodeURIComponent(JSON.stringify({ UserID: "u-1", ScreenName: "张三" }))
    const authCodeInfo = encodeURIComponent(JSON.stringify({ AuthCode: "ac-123" }))
    const parsed = parseCallback(`/authorize?authCodeInfo=${authCodeInfo}&userInfo=${userInfo}`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.callback.authCode).toBe("ac-123")
    expect(parsed.callback.refreshToken).toBe("")
    expect(parsed.callback.uid).toBe("u-1")
  })

  test("裸 code 参数也认", () => {
    const parsed = parseCallback("/authorize?code=abc123")
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.callback.authCode).toBe("abc123")
  })

  test("带授权码但没有 PKCE 校验串时明确报错，而不是静默失败", async () => {
    const fetcher = cannedFetch([])
    await expect(
      completeSignIn(
        { refreshToken: "", accessToken: "", authCode: "ac-1", uid: "u", nickname: "n", enterpriseId: "" },
        { machineId: MACHINE, deviceId: DEVICE },
        { client: { auth: { set: async () => undefined } }, fetcher },
      ),
    ).rejects.toThrow(/PKCE/)
    expect(fetcher.calls).toHaveLength(0)
  })

  test("授权码用当前客户端的 PKCE 端点换取令牌，并带上校验串", async () => {
    const fetcher = cannedFetch([
      {
        match: "/trae/api/v3/oauth/ExchangeToken",
        respond: () => jsonOk({ Result: { Token: "at", RefreshToken: "rt", TokenExpireDuration: 3600 } }),
      },
    ])
    const credential = await completeSignIn(
      { refreshToken: "", accessToken: "", authCode: "ac-1", uid: "u-1", nickname: "张三", enterpriseId: "" },
      { machineId: MACHINE, deviceId: DEVICE },
      { client: { auth: { set: async () => undefined } }, fetcher, now: () => 1000 },
      PKCE,
    )
    expect(credential.accessToken).toBe("at")
    expect(credential.refreshToken).toBe("rt")
    expect(credential.machineId).toBe(MACHINE)
    const exchange = fetcher.callsMatching("/trae/api/v3/oauth/ExchangeToken").at(0)
    const body = JSON.parse(String(exchange?.init?.body)) as Record<string, unknown>
    expect(body.AuthCode).toBe("ac-1")
    expect(body.CodeVerifier).toBe(PKCE.codeVerifier)
    expect(body.ClientID).toBe("en1oxy7wnw8j9n")
    expect(body.IDEVersion).toBe("3.4.2")
  })

  test("什么都没有的回调报缺凭据", () => {
    const parsed = parseCallback("/authorize?state=x")
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.authCodeFlow).toBe(false)
  })

  test("昵称只在不可打印时才换成占位，正常名字一律原样保留", () => {
    // 中文、拉丁字母、重音、西里尔、emoji 都是用户真实的名字，必须原样保留：
    // 用 latin-1 回转会把后三种改成乱码或占位（2026-10-16 实测）。
    expect(fixNickname("张三", "u-1")).toBe("张三")
    expect(fixNickname("alice", "u-1")).toBe("alice")
    expect(fixNickname("José", "u-1")).toBe("José")
    expect(fixNickname("Москва", "u-1")).toBe("Москва")
    expect(fixNickname("🙂boy", "u-1")).toBe("🙂boy")
    // 空名字与带控制字符的名字才换成可读占位。
    expect(fixNickname("", "uid-1234")).toBe("")
    expect(fixNickname("bad\u0007name", "uid-1234")).toBe("用户1234")
  })
})

describe("续期", () => {
  test("轮换 token 并保留设备身份", async () => {
    const fetcher = cannedFetch([
      {
        match: "/ExchangeToken",
        respond: () =>
          jsonOk({ Result: { Token: "new-at", RefreshToken: "new-rt", TokenExpireDuration: 3600 } }),
      },
    ])
    const next = await refreshCredential(
      {
        accessToken: "old-at",
        refreshToken: "old-rt",
        uid: "u-1",
        machineId: MACHINE,
        deviceId: DEVICE,
      },
      { client: { auth: { set: async () => undefined } }, fetcher, now: () => 1000 },
    )
    expect(next.accessToken).toBe("new-at")
    expect(next.refreshToken).toBe("new-rt")
    expect(next.machineId).toBe(MACHINE)
    expect(next.deviceId).toBe(DEVICE)
    expect(next.expiresAt).toBe(1000 + 3_600_000)
  })

  test("没有 refresh token 时明确报需要重新登录", async () => {
    await expect(
      refreshCredential(
        { accessToken: "at", refreshToken: "", uid: "u", machineId: MACHINE, deviceId: DEVICE },
        { client: { auth: { set: async () => undefined } }, fetcher: cannedFetch([]) },
      ),
    ).rejects.toThrow(/重新登录/)
  })

  test("ExchangeToken 失败时抛出可读错误", async () => {
    const fetcher = cannedFetch([{ match: "/ExchangeToken", respond: () => jsonOk({}, 400) }])
    await expect(
      refreshCredential(
        { accessToken: "at", refreshToken: "rt", uid: "u", machineId: MACHINE, deviceId: DEVICE },
        { client: { auth: { set: async () => undefined } }, fetcher },
      ),
    ).rejects.toThrow(/换取登录令牌失败/)
  })
})

describe("登录流程的回调形状", () => {
  /**
   * 回归：控制台用 `^http://127.0.0.1:(\d+)/authorize$` 校验回调地址，带
   * 随机路径前缀时它会直接显示「登录失败 / 网络错误」（2026-10-16 无头 Chrome
   * 实测：换成根路径 /authorize 就出现正常登录界面）。这条断言就是那次回归。
   */

  test("回调地址是源站根路径的 /authorize，没有随机前缀", async () => {
    const started = await start()
    const params = new URL(started.url ?? "").searchParams
    const callback = params.get("auth_callback_url") ?? ""
    expect(callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/authorize$/)
    // 同一次修复的另一半：URL 必须带 PKCE 参数，否则控制台走的是老分支。
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(params.get("code_challenge_method")).toBe("S256")
    // 收尾：打一跳回调让这次登录落定，别把服务留在测试进程里。
    const payload = new URLSearchParams({
      loginTraceID: params.get("login_trace_id") ?? "",
      authCodeInfo: JSON.stringify({ AuthCode: "x" }),
      userInfo: JSON.stringify({ UserID: "u" }),
    })
    expect((await fetch(`${callback}?${payload}`)).status).toBe(200)
    const result = (await started.callback()) as { type?: string }
    expect(result.type).toBe("failed")
  })

  test("回调里的 loginTraceID 与我们发出的不一致时不接受", async () => {
    const started = await start()
    const params = new URL(started.url ?? "").searchParams
    const callback = params.get("auth_callback_url") ?? ""
    const payload = new URLSearchParams({
      loginTraceID: "someone-elses-trace",
      authCodeInfo: JSON.stringify({ AuthCode: "x" }),
      userInfo: JSON.stringify({ UserID: "u" }),
    })
    expect((await fetch(`${callback}?${payload}`)).status).toBe(404)
    // 用我们自己的 trace id 再来一次：这一跳才算数（随后会因换令牌失败而落定）。
    const mine = new URLSearchParams({
      loginTraceID: params.get("login_trace_id") ?? "",
      authCodeInfo: JSON.stringify({ AuthCode: "x" }),
      userInfo: JSON.stringify({ UserID: "u" }),
    })
    expect((await fetch(`${callback}?${mine}`)).status).toBe(200)
    const result = (await started.callback()) as { type?: string }
    expect(result.type).toBe("failed")
  })
})

describe("回调路径的健壮性", () => {
  /**
   * 回归：一次「不带答案」的请求（浏览器可达性探测、刷新、favicon）曾被
   * 当成回调处理，于是登录被判失败、服务器被关掉；随后浏览器真正带着
   * authCodeInfo 跳回来时，端口已经没人监听（用户截图里的
   * ERR_CONNECTION_REFUSED）。
   */
  test("不带答案的探测请求不结束登录，真正带授权码的那一跳才算数", async () => {
    const started = await start()
    const params = new URL(started.url ?? "").searchParams
    const callback = params.get("auth_callback_url") ?? ""

    const probe = await fetch(callback)
    expect(probe.status).toBe(200)
    expect(await probe.text()).toContain("等待浏览器完成授权")

    const ok = await fetch(
      `${callback}?${new URLSearchParams({
        loginTraceID: params.get("login_trace_id") ?? "",
        authCodeInfo: JSON.stringify({ AuthCode: "x" }),
        userInfo: JSON.stringify({ UserID: "u" }),
      })}`,
    )
    expect(ok.status).toBe(200)
    const result = (await started.callback()) as { type?: string }
    expect(result.type).toBe("failed")
  })

  test("控制台拒绝授权时把错误码与原因如实说出来", () => {
    const parsed = parseCallback("/authorize?error_code=20401&error_msg=%E8%AE%BE%E5%A4%87%E8%B6%85%E9%99%90")
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain("20401")
    expect(parsed.reason).toContain("设备超限")
  })

  test("浏览器连不上本机时，宿主把地址粘回来也能完成（走授权码那条）", async () => {
    const started = await start()
    const params = new URL(started.url ?? "").searchParams
    const pasted = `${params.get("auth_callback_url") ?? ""}?${new URLSearchParams({
      loginTraceID: params.get("login_trace_id") ?? "",
      authCodeInfo: JSON.stringify({ AuthCode: "x" }),
      userInfo: JSON.stringify({ UserID: "u" }),
    })}`
    const result = (await started.callback(pasted)) as { type?: string }
    // 换取令牌会失败（码是假的、假 fetcher 没有路由），但关键是它**走到了**
    // 授权码那条路：说明粘贴回来的地址被当成一次真实回调处理了。
    expect(result.type).toBe("failed")
  })

  test("粘回来的是别人的地址时拒绝，而不是拿它去登录", async () => {
    const started = await start()
    const pasted =
      "http://127.0.0.1:1/authorize?loginTraceID=someone-else&authCodeInfo=%7B%22AuthCode%22%3A%22x%22%7D"
    const result = (await started.callback(pasted)) as { type?: string; error?: string }
    expect(result.type).toBe("failed")
    expect(result.error).toContain("不属于本次登录")
  })
})

/** 起一次真实登录流程，返回 authorize() 的结果（含 url 与 callback）。 */
async function start() {
  const method = loginMethods({
    client: { auth: { set: async () => undefined } },
    fetcher: cannedFetch([]),
  })[0]
  if (method === undefined || method.type !== "oauth") throw new Error("Trae 的登录方式应当是 oauth")
  return await method.authorize()
}
