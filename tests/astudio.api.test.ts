/**
 * 保护 vendors/astudio/api.ts：两种信封的判据（`code !== 0` 失败、`data` 空 =
 * 会话失效、数组形态的 rows）、Cookie 四键、两套请求头、`bot/models/configs`
 * 的 api_key 优先级、`points/balance` 的分池、弹窗的 `componentType` 判据，
 * 以及 SSO 微信扫码的轮询状态机（pending / scanned 的互为兜底 / unbound）。
 * 全部离线：cannedFetch 或纯函数。
 */

import { describe, expect, test } from "bun:test"
import {
  balanceOf,
  chatHeaders,
  claimablePopups,
  controlHeaders,
  cookieHeader,
  createWechatQr,
  generateFd,
  isSessionDead,
  parseEnvelope,
  pickApiKey,
  pollWechatScan,
} from "../src/vendors/astudio/api.ts"
import { ASTUDIO_POPUP_DAILY_REWARD, ASTUDIO_POPUP_NEW_USER } from "../src/vendors/astudio/product.ts"
import { at, cannedFetch, jsonOk } from "./helpers.ts"

describe("parseEnvelope", () => {
  test("code !== 0 即失败（HTTP 200 不代表成功）", () => {
    const result = parseEnvelope({ code: 80000, desc: "登录异常，请重新登录", data: null })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(80000)
      expect(result.sessionDead).toBe(true)
      expect(result.message).toBe("登录异常，请重新登录")
    }
  })

  test("code 缺席不算失败：上游确有不带 code 的端点形态", () => {
    const result = parseEnvelope({ data: { models: [] } })
    expect(result.ok).toBe(true)
  })

  test("code:0 但 data 为 null/空数组 = 终态（会话失效或无凭据）", () => {
    const nulled = parseEnvelope({ code: 0, desc: "成功", data: null })
    expect(nulled.ok).toBe(false)
    if (!nulled.ok) expect(nulled.sessionDead).toBe(true)
    const empty = parseEnvelope({ code: 0, desc: "成功", data: [] })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.sessionDead).toBe(true)
  })

  test("data 为数组时 rows 承载内容（bot/models/configs 的真实形态）", () => {
    const result = parseEnvelope({ code: 0, data: [{ api_key: "k" }] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.rows).toEqual([{ api_key: "k" }])
  })

  test("文案字段 message 与 desc 都认（两级回退）", () => {
    const byMessage = parseEnvelope({ code: 7, message: "完蛋" })
    if (!byMessage.ok) expect(byMessage.message).toBe("完蛋")
    const byDesc = parseEnvelope({ code: 7, desc: "完蛋" })
    if (!byDesc.ok) expect(byDesc.message).toBe("完蛋")
  })
})

describe("isSessionDead", () => {
  test("实测码集合 {1002, 1005, 80000} 命中；500 与未知码不算", () => {
    expect(isSessionDead(1002)).toBe(true)
    expect(isSessionDead(1005)).toBe(true)
    expect(isSessionDead(80000)).toBe(true)
    expect(isSessionDead(500)).toBe(false)
    expect(isSessionDead(99909001, "系统异常")).toBe(false)
  })

  test("明确的登录文案兜底；泛化的「失败/错误」不算", () => {
    expect(isSessionDead(1, "请重新登录")).toBe(true)
    expect(isSessionDead(1, "not logged in")).toBe(true)
    expect(isSessionDead(1, "请求失败")).toBe(false)
  })
})

describe("cookieHeader / 请求头", () => {
  test("四键同发：ssoSessionId 与 sso_sessionid 同值各一次；token 缺失回落 sso", () => {
    const cookie = cookieHeader({ ssoSessionId: "sid", accountId: "acc" })
    expect(cookie).toBe("ssoSessionId=sid; sso_sessionid=sid; account_id=acc; token=sid")
  })

  test("缺失字段跳过键，不发空值", () => {
    expect(cookieHeader({ ssoSessionId: "sid" })).toBe("ssoSessionId=sid; sso_sessionid=sid; token=sid")
    expect(cookieHeader({})).toBe("")
  })

  test("推理头带 Bearer 与客户端形状；accountId 在场时带 X-Account-Id", () => {
    const headers = chatHeaders({ accessToken: "k1", accountId: "acc" })
    expect(headers.Authorization).toBe("Bearer k1")
    expect(headers.clientType).toBe("21")
    expect(headers.studioVersion).toBe("3.5.2")
    expect(headers["X-Account-Id"]).toBe("acc")
    expect(chatHeaders({ accessToken: "k1" })["X-Account-Id"]).toBeUndefined()
  })

  test("控制面头带 Cookie、不带 Authorization（与客户端逐字一致）", () => {
    const headers = controlHeaders({ ssoSessionId: "sid", accountId: "acc" })
    expect(headers.Cookie).toContain("ssoSessionId=sid")
    expect(headers.Authorization).toBeUndefined()
  })
})

describe("pickApiKey", () => {
  test("is_current 优先；其 api_key 为空串时继续往下找（实测后端偶发空值）", () => {
    const body = {
      code: 0,
      data: [
        { model: "a", api_key: "", is_current: true },
        { model: "b", api_key: "default-key", is_default: true },
        { model: "c", api_key: "first-key" },
      ],
    }
    const pick = pickApiKey(body)
    expect(pick.apiKey).toBe("default-key")
    expect(pick.via).toBe("default")
  })

  test("无 is_current/is_default 时取第一条非空行", () => {
    const pick = pickApiKey({ code: 0, data: [{ model: "c", api_key: "first-key" }] })
    expect(pick.apiKey).toBe("first-key")
  })

  test("全空 → via none + 可读原因", () => {
    const pick = pickApiKey({ code: 0, desc: "成功", data: [] })
    expect(pick.apiKey).toBe("")
    expect(pick.reason).toContain("没有任何可用 api_key")
  })
})

describe("balanceOf", () => {
  test("四个池逐一分桶；total 用权威 totalBalance 而不是逐包求和", () => {
    const balance = balanceOf({
      totalBalance: 1192,
      totalAmount: 1200,
      memberTotal: 100,
      memberBalance: 40,
      memberNextExpireTime: "2026-11-01 00:00:00",
      buyBalance: 52,
      activityBalance: 1100,
      sparkTotalBalance: 5000,
      sparkTotalAmount: 5000,
      sparkNextExpireTime: "2026-12-01 00:00:00",
    })
    expect(balance).toBeDefined()
    if (balance === undefined) return
    expect(balance.total).toBe(1192)
    expect(balance.totalAmount).toBe(1200)
    expect(balance.pools.map((pool) => pool.name)).toStrictEqual([
      "会员积分",
      "购买积分",
      "赠送积分",
      "星火积分（独立池）",
    ])
    const member = at(balance.pools, 0)
    expect(member.remaining).toBe(40)
    expect(member.total).toBe(100)
    expect(member.expiresAtMs).toBeDefined()
  })

  test("星火池缺席时不生成条目（生成 remaining:0 会让用户以为星火没了）", () => {
    const balance = balanceOf({ totalBalance: 100, memberTotal: 100, memberBalance: 100 })
    expect(balance).toBeDefined()
    if (balance === undefined) return
    expect(balance.pools).toHaveLength(1)
  })

  test("没有 totalBalance 的形状返回 undefined（不编造 0）", () => {
    expect(balanceOf({ foo: 1 })).toBeUndefined()
  })
})

describe("claimablePopups", () => {
  test("真实字段是 componentType（2026-10-20 取证），type 只作兼容", () => {
    const popups = claimablePopups([
      { popupId: 3, componentType: ASTUDIO_POPUP_DAILY_REWARD, instanceKey: "k3" },
      { popupId: 4, type: ASTUDIO_POPUP_NEW_USER, instanceKey: "k4" },
      { popupId: 5, componentType: "BANNER", instanceKey: "k5" },
    ])
    expect(popups.map((popup) => popup.popupId)).toStrictEqual([3, 4])
  })

  test("按 popupId 去重，instanceKey 缺失给空串", () => {
    const popups = claimablePopups([
      { popupId: 3, componentType: ASTUDIO_POPUP_DAILY_REWARD },
      { popupId: 3, componentType: ASTUDIO_POPUP_DAILY_REWARD },
    ])
    expect(popups).toHaveLength(1)
    expect(at(popups, 0).instanceKey).toBe("")
  })
})

describe("generateFd", () => {
  test("8 位、字符表内、两次生成不同", () => {
    const fd = generateFd()
    expect(fd).toHaveLength(8)
    for (const char of fd) expect("ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678").toContain(char)
    expect(generateFd()).not.toBe(fd)
  })
})

describe("SSO 扫码", () => {
  test("createWechatQr：code:0 + data 为 ticket URL", async () => {
    const fetcher = cannedFetch([
      {
        match: "scanlogin/qrcode",
        respond: jsonOk({ code: 0, data: "https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=T" }),
      },
    ])
    const result = await createWechatQr(fetcher, "fd123456")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.qr.qrUrl).toContain("showqrcode")
  })

  test("createWechatQr：非 0 code 带厂商文案失败", async () => {
    const fetcher = cannedFetch([
      { match: "scanlogin/qrcode", respond: jsonOk({ code: -2, desc: "频率限制" }) },
    ])
    const result = await createWechatQr(fetcher, "fd123456")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("频率限制")
  })

  test("pollWechatScan：code -1 是 pending", async () => {
    const fetcher = cannedFetch([{ match: "scanlogin/uids", respond: jsonOk({ code: -1, desc: "未扫码" }) }])
    const poll = await pollWechatScan(fetcher, "fd123456")
    expect(poll.status).toBe("pending")
  })

  test("pollWechatScan：只下发 token 时 uid 与 ssoSessionId 互为兜底", async () => {
    const fetcher = cannedFetch([
      { match: "scanlogin/uids", respond: jsonOk({ code: 0, data: [{ uid: "u-1", token: "tok-1" }] }) },
    ])
    const poll = await pollWechatScan(fetcher, "fd123456")
    expect(poll.status).toBe("scanned")
    if (poll.status !== "scanned") return
    expect(poll.account.uid).toBe("u-1")
    expect(poll.account.ssoSessionId).toBe("tok-1")
  })

  test("pollWechatScan：infoList 形态同样解析", async () => {
    const fetcher = cannedFetch([
      {
        match: "scanlogin/uids",
        respond: jsonOk({
          code: 0,
          data: { infoList: [{ uid: "u-9", ssoSessionId: "s-9", username: "昵称" }] },
        }),
      },
    ])
    const poll = await pollWechatScan(fetcher, "fd123456")
    if (poll.status !== "scanned") throw new Error(`期望 scanned，实际 ${poll.status}`)
    expect(poll.account.username).toBe("昵称")
  })

  test("pollWechatScan：code:0 但列表为空 = unbound（该微信未开通 AStudio）", async () => {
    const fetcher = cannedFetch([
      { match: "scanlogin/uids", respond: jsonOk({ code: 0, desc: "成功", data: [] }) },
    ])
    const poll = await pollWechatScan(fetcher, "fd123456")
    expect(poll.status).toBe("unbound")
    if (poll.status === "unbound") expect(poll.message).toContain("尚未开通")
  })

  test("pollWechatScan：非 0/-1 码按 error 原样带码", async () => {
    const fetcher = cannedFetch([{ match: "scanlogin/uids", respond: jsonOk({ code: 7, desc: "fd 过期" }) }])
    const poll = await pollWechatScan(fetcher, "fd123456")
    expect(poll).toMatchObject({ status: "error", code: 7, message: "fd 过期" })
  })
})
