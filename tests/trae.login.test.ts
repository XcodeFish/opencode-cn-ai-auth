/**
 * 保护 vendors/trae/login.ts：登录 URL 的参数集、回调解析、续期。
 *
 * 这些是最容易「看着对、实际把用户卡在授权页」的地方：回调参数名写错、
 * 回调里找 OAuth 的 code、把 PKCE 回调当成非法回调。三条都各有一条断言。
 */

import { describe, expect, test } from "bun:test"
import {
  buildLoginUrl,
  fixNickname,
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

  test("带 PKCE code 的回调如实说是流程不支持，而不是报「缺凭据」", () => {
    const parsed = parseCallback("/authorize?code=abc123")
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.authCodeFlow).toBe(true)
    expect(parsed.reason).toContain("PKCE")
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
