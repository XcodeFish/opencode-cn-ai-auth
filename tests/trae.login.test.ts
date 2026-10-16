/**
 * 保护 vendors/trae/login.ts：登录 URL 的参数集、回调解析、续期。
 *
 * 这些是最容易「看着对、实际把用户卡在授权页」的地方：回调参数名写错、
 * 回调里找 OAuth 的 code、把 PKCE 回调当成非法回调。三条都各有一条断言。
 */

import { describe, expect, test } from "bun:test"
import type { TraeLoginDeps } from "../src/vendors/trae/login.ts"
import {
  buildLoginUrl,
  completeSignIn,
  fixNickname,
  loginMethods,
  parseCallback,
  refreshCredential,
  traceIdOf,
} from "../src/vendors/trae/login.ts"
import { cannedFetch, jsonOk } from "./helpers.ts"

const MACHINE = "a".repeat(32)
const DEVICE = "b".repeat(32)

describe("登录 URL", () => {
  test("回调参数是 auth_callback_url，并带齐通道与客户端伪装参数", () => {
    const url = new URL(buildLoginUrl(MACHINE, DEVICE, "http://127.0.0.1:18080/authorize"))
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
    // 不带 PKCE：控制台用 code_challenge 挑选流程，带上它就切到「回授权码」
    // 那条，而本包（以及 JetHub、社区插件）能换的是刷新令牌那条。
    expect(params.get("code_challenge")).toBeNull()
    expect(params.get("code_challenge_method")).toBeNull()
    // 版本号取自厂商自己的客户端 bundle，不是旧构建的值。
    expect(params.get("plugin_version")).toBe("2.3.91092")
    expect(params.get("x_app_version")).toBe("3.4.2")
    // solo 客户端才会带这一项（官方客户端同款）。
    expect(params.get("hide_saas_login")).toBe("true")
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

  /**
   * 控制台的两条流程：本包的登录 URL 不带 `code_challenge`，所以它走「回刷新
   * 令牌」那条。真收到授权码说明流程变了，这时**一个请求都不发**、如实报出来。
   *
   * 这一条是本次缺陷的核心：0.7.1 给登录 URL 加上了 PKCE，于是控制台切到
   * 「回授权码」，而那个换取端点对官方客户端之外的 body 一律回
   * `10101 无效参数`（实测：官方客户端的 body 形状在这里也复现不出来）。
   * 结果是点登录必然失败 —— 用户第二次看到的 `ERR_CONNECTION_REFUSED` 之前，
   * 真正的失败点就在这儿。
   */
  test("收到授权码时不发请求，如实说走的是另一条流程", async () => {
    const fetcher = cannedFetch([])
    await expect(
      completeSignIn(
        { refreshToken: "", accessToken: "", authCode: "ac-1", uid: "u", nickname: "n", enterpriseId: "" },
        { machineId: MACHINE, deviceId: DEVICE },
        { client: { auth: { set: async () => undefined } }, fetcher },
      ),
    ).rejects.toThrow(/授权码/)
    expect(fetcher.calls).toHaveLength(0)
  })

  test("刷新令牌那条才是登录换令牌的路（无 DeviceProof，与另两家实现一致）", async () => {
    const fetcher = cannedFetch([
      {
        match: "/cloudide/api/v3/trae/oauth/ExchangeToken",
        respond: () => jsonOk({ Result: { Token: "at", RefreshToken: "rt", TokenExpireDuration: 3600 } }),
      },
      { match: "/GetUserInfo", respond: () => jsonOk({ Result: { UserID: "u-9", ScreenName: "张三" } }) },
    ])
    const credential = await completeSignIn(
      { refreshToken: "cb-rt", accessToken: "", uid: "u-1", nickname: "张三", enterpriseId: "" },
      { machineId: MACHINE, deviceId: DEVICE },
      { client: { auth: { set: async () => undefined } }, fetcher, now: () => 1000 },
    )
    expect(credential.accessToken).toBe("at")
    expect(credential.refreshToken).toBe("rt")
    expect(credential.machineId).toBe(MACHINE)
    const exchange = fetcher.callsMatching("/cloudide/api/v3/trae/oauth/ExchangeToken").at(0)
    const body = JSON.parse(String(exchange?.init?.body)) as Record<string, unknown>
    expect(body.RefreshToken).toBe("cb-rt")
    expect(body.ClientID).toBe("en1oxy7wnw8j9n")
    expect(body.ClientSecret).toBe("-")
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
    // 登录 URL 不带 PKCE：带上它控制台就切到「回授权码」那条流程。
    expect(params.get("code_challenge")).toBeNull()
    expect(params.get("code_challenge_method")).toBeNull()
    // 收尾：打一跳回调让这次登录落定，别把服务留在测试进程里。
    const payload = new URLSearchParams({
      loginTraceID: params.get("login_trace_id") ?? "",
      refreshToken: "cb-rt",
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
      refreshToken: "cb-rt",
      userInfo: JSON.stringify({ UserID: "u" }),
    })
    // 不认领的 trace id 不会被拿去换令牌（那是别人的登录），页面会说明要重新
    // 发起 —— 地址是固定的，旧标签页落在这里是常态，给一页说明比 404 有用。
    const foreign = await fetch(`${callback}?${payload}`)
    expect(foreign.status).toBe(200)
    expect(await foreign.text()).toContain("重新发起")
    // 用我们自己的 trace id 再来一次：这一跳才算数（随后会因换令牌失败而落定）。
    const mine = new URLSearchParams({
      loginTraceID: params.get("login_trace_id") ?? "",
      refreshToken: "cb-rt",
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
        refreshToken: "cb-rt",
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
      refreshToken: "cb-rt",
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

  /**
   * 回归（用户第二次报障的同一屏）：浏览器在宿主**已经放弃等待之后**
   * 才跳回来。这一跳必须是 200 并且真的把账号存下来 —— 以前
   * `callback` 的 `finally` 会立刻关掉服务器，于是这一跳打到死端口
   * （`ERR_CONNECTION_REFUSED`），就算授权本身已经成功。
   */
  test("宿主不再等待之后，迟到的回调仍能完成登录并存下账号", async () => {
    const saved: Record<string, unknown>[] = []
    const fetcher = cannedFetch([
      {
        match: "/ExchangeToken",
        respond: () => jsonOk({ Result: { Token: "at", RefreshToken: "rt", TokenExpireDuration: 3600 } }),
      },
      {
        match: "/GetUserInfo",
        respond: () => jsonOk({ Result: { UserID: "u-9", ScreenName: "张三" } }),
      },
    ])
    const started = await startWith({
      client: {
        auth: {
          set: async (input: { body: Record<string, unknown> }) => {
            saved.push(input.body)
          },
        },
      },
      fetcher,
      // 宿主很快放弃等待（真实值是 10 分钟，测试不要等）。
      timeoutMs: 30,
    })
    const params = new URL(started.url ?? "").searchParams
    const callback = params.get("auth_callback_url") ?? ""

    // 宿主先落定为失败（超时 / 关窗），这就是「不再有人等」的那一刻。
    const first = await started.callback()
    expect((first as { type?: string }).type).toBe("failed")

    // 之后浏览器才带着授权码回来。
    const late = await fetch(
      `${callback}?${new URLSearchParams({
        loginTraceID: params.get("login_trace_id") ?? "",
        refreshToken: "cb-rt",
        userInfo: JSON.stringify({ UserID: "u-9", ScreenName: "张三" }),
      })}`,
    )
    expect(late.status).toBe(200)
    expect(await late.text()).toContain("登录成功")
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ type: "oauth", access: "at", refresh: "rt", accountId: "张三" })
  })

  /**
   * 回归（同一屏的另一种触发方式）：第二次点登录会顶掉第一次的**回调地址**
   * ——以前每次 `authorize()` 都自己起一个随机端口、并在自己的流程结束时
   * 关掉它，于是浏览器里还开着的那张旧标签页回跳时必然打到死端口。现在
   * 回调页属于**进程**：两次登录共用同一个地址，`login_trace_id` 决定这一跳
   * 属于谁。
   */
  test("两次登录共用同一个回调地址，旧的那次仍能被认出并完成", async () => {
    const saved: Record<string, unknown>[] = []
    const fetcher = cannedFetch([
      {
        match: "/ExchangeToken",
        respond: () => jsonOk({ Result: { Token: "at", RefreshToken: "rt", TokenExpireDuration: 3600 } }),
      },
      { match: "/GetUserInfo", respond: () => jsonOk({ Result: { UserID: "u-9", ScreenName: "张三" } }) },
    ])
    const deps: TraeLoginDeps = {
      client: {
        auth: {
          set: async (input: { body: Record<string, unknown> }) => {
            saved.push(input.body)
          },
        },
      },
      fetcher,
      timeoutMs: 30,
    }

    const first = await startWith(deps)
    const firstParams = new URL(first.url ?? "").searchParams
    const firstCallback = firstParams.get("auth_callback_url") ?? ""
    await first.callback()

    const second = await startWith(deps)
    const secondParams = new URL(second.url ?? "").searchParams
    // 地址一模一样：固定端口 + 固定路径，第二张标签页打到的是同一个页面。
    expect(secondParams.get("auth_callback_url")).toBe(firstCallback)

    // 旧标签页（第一次登录）此刻带着授权码回来，仍然算数。
    const late = await fetch(
      `${firstCallback}?${new URLSearchParams({
        loginTraceID: firstParams.get("login_trace_id") ?? "",
        refreshToken: "cb-rt",
        userInfo: JSON.stringify({ UserID: "u-9", ScreenName: "张三" }),
      })}`,
    )
    expect(late.status).toBe(200)
    expect(await late.text()).toContain("登录成功")
    expect(saved).toHaveLength(1)
  })

  /**
   * 参数名/形状是厂商的，不由本包决定：控制台某天不回 `loginTraceID` 时，
   * **只有一次**登录在等就直接算它的（截图里的地址被截断，无法排除这一点；
   * 老实现本来就接受无 trace id 的回调）。但两次登录同时等待时不能瞎猜：
   * 那种情况给一页「请重新发起」，绝不把钱花到不知道是谁的授权码上。
   */
  test("回调不带 trace id 时：只有一次登录就认领，多于一次则拒绝", async () => {
    const saved: Record<string, unknown>[] = []
    const fetcher = cannedFetch([
      {
        match: "/ExchangeToken",
        respond: () => jsonOk({ Result: { Token: "at", RefreshToken: "rt", TokenExpireDuration: 3600 } }),
      },
      { match: "/GetUserInfo", respond: () => jsonOk({ Result: { UserID: "u-9", ScreenName: "张三" } }) },
    ])
    const deps: TraeLoginDeps = {
      client: {
        auth: {
          set: async (input: { body: Record<string, unknown> }) => {
            saved.push(input.body)
          },
        },
      },
      fetcher,
    }

    // 只有一次登录在等：不带 trace id 的回调也认。
    const only = await startWith(deps)
    const onlyCallback = new URL(only.url ?? "").searchParams.get("auth_callback_url") ?? ""
    const answer = new URLSearchParams({
      refreshToken: "cb-rt",
      userInfo: JSON.stringify({ UserID: "u-9", ScreenName: "张三" }),
    })
    expect((await fetch(`${onlyCallback}?${answer}`)).status).toBe(200)
    expect((await only.callback()) as { type?: string }).toMatchObject({ type: "success" })
    // 正常运行的那次由宿主存下来（`saved` 记录的是「迟到时插件自己存」那条路）。
    expect(saved).toHaveLength(0)

    // 两次登录同时在等：没有 trace id 就分不清是谁的，拒绝而不是押一个。
    const a = await startWith(deps)
    await startWith(deps)
    const callback = new URL(a.url ?? "").searchParams.get("auth_callback_url") ?? ""
    const ambiguous = await fetch(`${callback}?${answer}`)
    expect(await ambiguous.text()).toContain("重新发起")
    expect(saved).toHaveLength(0)
  })

  /**
   * 回归（**在真实 magpie 上跑出来的**）：旧标签页带着一个早已作废的授权码
   * 回来时，它没有 `login_trace_id`，于是「只有一次登录在等」的兜底把它当成
   * 了本次的答案 —— 换来 401，本次登录被判失败，而真正在等的那个人就这么被
   * 一张僵尸标签页毁掉了。
   *
   * 现在「没有 trace id」只是一次**猜测**：猜错（换令牌失败）就把它放回去，
   * 登录继续等真正的答案。
   */
  test("不带 trace id 的僵尸标签页不能把正在等的登录顶死", async () => {
    let exchangeCalls = 0
    const fetcher = cannedFetch([
      {
        match: "/ExchangeToken",
        respond: () => {
          exchangeCalls += 1
          // 第一跳是那张僵尸标签页的旧码：上游拒绝。第二跳才是真的。
          return exchangeCalls === 1
            ? jsonOk({}, 401)
            : jsonOk({ Result: { Token: "at", RefreshToken: "rt", TokenExpireDuration: 3600 } })
        },
      },
      { match: "/GetUserInfo", respond: () => jsonOk({ Result: { UserID: "u-9", ScreenName: "张三" } }) },
    ])
    const started = await startWith({
      client: { auth: { set: async () => undefined } },
      fetcher,
    })
    const params = new URL(started.url ?? "").searchParams
    const callback = params.get("auth_callback_url") ?? ""

    // 僵尸标签页：没有 trace id，码已经作废；页面仍在等，而不是报失败。
    const stale = await fetch(`${callback}?${new URLSearchParams({ refreshToken: "STALE-RT" })}`)
    expect(stale.status).toBe(200)
    expect(await stale.text()).toContain("等待浏览器完成授权")

    // 真正的回调随后到达，带着本次的 trace id。
    const real = await fetch(
      `${callback}?${new URLSearchParams({
        loginTraceID: params.get("login_trace_id") ?? "",
        refreshToken: "cb-rt",
        userInfo: JSON.stringify({ UserID: "u-9", ScreenName: "张三" }),
      })}`,
    )
    expect(real.status).toBe(200)
    expect(await real.text()).toContain("登录成功")
    expect((await started.callback()) as { type?: string }).toMatchObject({ type: "success" })
  })
})

/** 起一次真实登录流程，返回 authorize() 的结果（含 url 与 callback）。 */
async function start() {
  return await startWith({
    client: { auth: { set: async () => undefined } },
    fetcher: cannedFetch([]),
  })
}

/** 同上，但可以换掉 client / fetcher（迟到回调那条要看到存下来的账号）。 */
async function startWith(deps: TraeLoginDeps) {
  const method = loginMethods(deps)[0]
  if (method === undefined || method.type !== "oauth") throw new Error("Trae 的登录方式应当是 oauth")
  return await method.authorize()
}
