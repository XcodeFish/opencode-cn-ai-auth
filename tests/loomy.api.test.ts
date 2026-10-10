/**
 * 保护 vendors/loomy/api.ts：信封以 code 而非 HTTP 状态判定、
 * 二维码 uuid 的两种 HTML 形态、微信长轮询的状态映射、
 * productRead 把 100002 报成 code、签到读 alreadyProcessed/dailyQuota，
 * 以及缺 session 的登录答复抛错。全部用 cannedFetch 驱动，不联网。
 */

import { describe, expect, test } from "bun:test"
import { SignInExpiredError, VendorError } from "../src/core/errors.ts"
import {
  claimDailyQuota,
  extractUuid,
  fetchCatalog,
  type LoomyQrStatus,
  loginWithSmsCode,
  parseEnvelope,
  pollWechat,
  productRead,
  sendSmsCode,
} from "../src/vendors/loomy/api.ts"
import { at, cannedFetch, headersOf, jsonOk, rejectionError, textBody } from "./helpers.ts"

const ACCESS = "sess-1"
const KEYS = { accessKeyId: "ak-test", accessKeySecret: "sk-test" }

describe("parseEnvelope", () => {
  test("成功信封解出 data", () => {
    expect(parseEnvelope({ code: "000000", desc: "ok", data: { a: 1 } })).toStrictEqual({
      ok: true,
      code: "000000",
      message: "ok",
      data: { a: 1 },
    })
    expect(parseEnvelope({ code: "000000" })).toStrictEqual({
      ok: true,
      code: "000000",
      message: "",
      data: undefined,
    })
  })

  test("业务失败只看 code，desc 优先于 message", () => {
    expect(parseEnvelope({ code: "100002", desc: "缺少 token" })).toStrictEqual({
      ok: false,
      code: "100002",
      message: "缺少 token",
      data: undefined,
    })
    expect(parseEnvelope({ code: "1", message: "只有 message" })).toStrictEqual({
      ok: false,
      code: "1",
      message: "只有 message",
      data: undefined,
    })
  })

  test("非 JSON 对象与缺 code 都有话说", () => {
    expect(parseEnvelope("nope")).toStrictEqual({
      ok: false,
      code: "",
      message: "响应不是 JSON 对象",
      data: undefined,
    })
    expect(parseEnvelope(undefined)).toStrictEqual({
      ok: false,
      code: "",
      message: "响应不是 JSON 对象",
      data: undefined,
    })
    expect(parseEnvelope({})).toStrictEqual({
      ok: false,
      code: "",
      message: "业务错误 (缺少 code)",
      data: undefined,
    })
    expect(parseEnvelope({ code: 0 })).toStrictEqual({
      ok: false,
      code: "0",
      message: "业务错误 0",
      data: undefined,
    })
  })
})

describe("extractUuid", () => {
  test("从二维码图片路径取 uuid", () => {
    expect(extractUuid('<img src="/connect/qrcode/AbCdEf123456">')).toBe("AbCdEf123456")
  })

  test("从长轮询地址取 uuid，图片形态优先", () => {
    expect(
      extractUuid("https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=Zx9_-=abc123&last=408"),
    ).toBe("Zx9_-=abc123")
    expect(
      extractUuid(
        '<script>var u="l/qrconnect?uuid=FromPoll123";</script><img src="/connect/qrcode/FromImage1">',
      ),
    ).toBe("FromImage1")
  })

  test("垃圾输入与过短的 id 给空串", () => {
    expect(extractUuid("no uuid here")).toBe("")
    expect(extractUuid("/connect/qrcode/abc")).toBe("")
    expect(extractUuid(42)).toBe("")
    expect(extractUuid(undefined)).toBe("")
  })
})

describe("pollWechat", () => {
  const cases: { body: string; status: LoomyQrStatus; code: string; errcode: string }[] = [
    { body: "window.wx_errcode = 408;", status: "waiting", code: "", errcode: "408" },
    { body: "wx_errcode=404;", status: "scanned", code: "", errcode: "404" },
    {
      body: "wx_errcode=405; wx_code='CODE-123';",
      status: "confirmed",
      code: "CODE-123",
      errcode: "405",
    },
    { body: "wx_errcode=405;", status: "scanned", code: "", errcode: "405" },
    { body: "wx_errcode=403;", status: "cancelled", code: "", errcode: "403" },
    { body: "wx_errcode=402;", status: "expired", code: "", errcode: "402" },
    { body: "wx_errcode=500;", status: "waiting", code: "", errcode: "500" },
  ]

  for (const item of cases) {
    test(`${item.body} → ${item.status}`, async () => {
      const fetcher = cannedFetch([{ match: "long.open.weixin.qq.com", respond: textBody(item.body) }])
      expect(await pollWechat(fetcher, { uuid: "uuid-1" })).toStrictEqual({
        status: item.status,
        code: item.code,
        errcode: item.errcode,
      })
    })
  }

  test("把 uuid 与 last 放进查询串", async () => {
    const fetcher = cannedFetch([{ match: "qrconnect", respond: textBody("wx_errcode=408;") }])
    await pollWechat(fetcher, { uuid: "uuid-1", last: "404" })
    const url = new URL(at(fetcher.calls, 0).url)
    expect(url.host).toBe("long.open.weixin.qq.com")
    expect(url.searchParams.get("uuid")).toBe("uuid-1")
    expect(url.searchParams.get("last")).toBe("404")
    expect(url.searchParams.get("_")).not.toBeNull()
  })

  test("传输异常是 error，不是流程失败", async () => {
    const fetcher = cannedFetch([
      {
        match: "qrconnect",
        respond: () => {
          throw new Error("offline")
        },
      },
    ])
    expect(await pollWechat(fetcher, { uuid: "uuid-1" })).toStrictEqual({
      status: "error",
      code: "",
      errcode: "",
    })
  })
})

describe("productRead", () => {
  test("成功时解出 data，并带 token 头", async () => {
    const fetcher = cannedFetch([
      { match: "/points/records", respond: jsonOk({ code: "000000", data: { balance: 12 } }) },
    ])
    expect(await productRead(fetcher, ACCESS, "/points/records")).toStrictEqual({
      ok: true,
      data: { balance: 12 },
    })
    const call = at(fetcher.calls, 0)
    expect(call.url).toBe("https://loomyad.xunfei.cn/api/v1/points/records")
    expect(call.init?.method).toBe("GET")
    expect(headersOf(call)).toStrictEqual({ Accept: "application/json", token: ACCESS })
  })

  test("把 100002 报成 code，不抛错", async () => {
    const fetcher = cannedFetch([
      { match: "loomyad.xunfei.cn", respond: jsonOk({ code: "100002", desc: "缺少 token" }) },
    ])
    expect(await productRead(fetcher, ACCESS, "/models")).toStrictEqual({
      ok: false,
      code: "100002",
      message: "缺少 token",
    })
  })

  test("非 JSON 正文报 code 空", async () => {
    const fetcher = cannedFetch([{ match: "loomyad.xunfei.cn", respond: textBody("<html>502</html>") }])
    expect(await productRead(fetcher, ACCESS, "/models")).toStrictEqual({
      ok: false,
      code: "",
      message: "响应不是 JSON 对象",
    })
  })

  test("传输失败报 NETWORK", async () => {
    const fetcher = cannedFetch([
      {
        match: "loomyad.xunfei.cn",
        respond: () => {
          throw new Error("offline")
        },
      },
    ])
    const result = await productRead(fetcher, ACCESS, "/points/records")
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("期望失败结果")
    expect(result.code).toBe("NETWORK")
    expect(result.message).toContain("loomyad.xunfei.cn")
  })
})

describe("fetchCatalog", () => {
  test("读取新的 OpenAI 形态模型目录", async () => {
    const fetcher = cannedFetch([
      {
        match: "/models",
        respond: jsonOk({
          object: "list",
          data: [
            {
              id: "DeepSeek-V4.1-Flash",
              name: "DeepSeek V4.1 Flash(x2.0)",
              type: "chat",
              context_length: 1_048_576,
              max_output_tokens: 384_000,
              reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
              capabilities: { input_modalities: ["text", "image"] },
            },
          ],
        }),
      },
    ])
    const catalog = await fetchCatalog(fetcher, ACCESS)
    expect(catalog).toHaveLength(1)
    expect(at(catalog, 0)).toMatchObject({
      id: "DeepSeek-V4.1-Flash",
      name: "DeepSeek V4.1 Flash(x2.0)",
      type: "chat",
      context_length: 1_048_576,
      max_output_tokens: 384_000,
    })
  })

  test("100002 抛 SignInExpiredError", async () => {
    const fetcher = cannedFetch([
      { match: "/models", respond: jsonOk({ code: "100002", desc: "缺少 token" }) },
    ])
    const error = await rejectionError(() => fetchCatalog(fetcher, ACCESS))
    expect(error).toBeInstanceOf(SignInExpiredError)
    expect(error.message).toBe("loomy: 模型列表被拒绝：缺少 token")
  })
})

describe("claimDailyQuota", () => {
  test("读出 alreadyProcessed 与 dailyQuota，POST 空对象体", async () => {
    const fetcher = cannedFetch([
      {
        match: "/points/first-login",
        respond: jsonOk({
          code: "000000",
          data: {
            alreadyProcessed: true,
            balance: 10,
            dailyBalance: 3800,
            availableBalance: 3810,
            dailyQuota: 5000,
            dailyConsumed: 1200,
            dailyCycleDate: "2026-10-09",
          },
        }),
      },
    ])
    expect(await claimDailyQuota(fetcher, ACCESS)).toStrictEqual({
      ok: true,
      data: {
        permanent: 10,
        daily: 3800,
        available: 3810,
        dailyQuota: 5000,
        dailyConsumed: 1200,
        dailyCycleDate: "2026-10-09",
        alreadyProcessed: true,
      },
    })
    const call = at(fetcher.calls, 0)
    expect(call.url).toBe("https://loomyad.xunfei.cn/api/v1/points/first-login")
    expect(call.init?.method).toBe("POST")
    expect(call.init?.body).toBe("{}")
    expect(headersOf(call)).toStrictEqual({
      Accept: "application/json",
      token: ACCESS,
      "Content-Type": "application/json",
    })
  })
})

describe("签名接口", () => {
  test("sendSmsCode 带上账号信封参数并取出 msgid", async () => {
    const fetcher = cannedFetch([
      { match: "/login/phone/sendMsgCode", respond: jsonOk({ code: "000000", data: { msgid: "msg-1" } }) },
    ])
    expect(await sendSmsCode(fetcher, KEYS, "13812345678")).toBe("msg-1")
    const call = at(fetcher.calls, 0)
    expect(call.url).toBe("https://account.xfinfr.com/login/phone/sendMsgCode")
    expect(call.init?.method).toBe("POST")
    expect(headersOf(call).Authorization).toMatch(/^account ak-test:[A-Za-z0-9+/=]+$/)
    const sent = JSON.parse(String(call.init?.body)) as {
      base: Record<string, unknown>
      param: Record<string, unknown>
    }
    expect(sent.param).toStrictEqual({ ccode: "86", phone: "13812345678", expire: 300 })
    expect(sent.base.appid).toBe("GM3LOOMY")
    expect(sent.base.traceid).toMatch(/^[0-9a-f]{32}$/)
  })

  test("没有 msgid 就抛错", async () => {
    const fetcher = cannedFetch([
      { match: "/login/phone/sendMsgCode", respond: jsonOk({ code: "000000", data: {} }) },
    ])
    const error = await rejectionError(() => sendSmsCode(fetcher, KEYS, "13812345678"))
    expect(error).toBeInstanceOf(VendorError)
    expect(error.message).toBe("loomy: 短信接口没有返回 msgid，无法继续登录")
  })

  test("loginWithSmsCode 缺 session 抛错", async () => {
    const fetcher = cannedFetch([
      { match: "/login/phone/checkCode", respond: jsonOk({ code: "000000", data: { userid: "u-1" } }) },
    ])
    const error = await rejectionError(() =>
      loginWithSmsCode(fetcher, KEYS, { phone: "13812345678", code: "123456", msgid: "msg-1" }),
    )
    expect(error).toBeInstanceOf(VendorError)
    expect(error.message).toBe("loomy: 登录响应缺少 session")
  })

  test("loginWithSmsCode 成功时带着 phone 返回 session 与 userid", async () => {
    const fetcher = cannedFetch([
      {
        match: "/login/phone/checkCode",
        respond: jsonOk({
          code: "000000",
          data: { session: "sess-32hex", userid: "u-1", phone: "13812345678" },
        }),
      },
    ])
    expect(
      await loginWithSmsCode(fetcher, KEYS, {
        phone: "13812345678",
        code: "123456",
        msgid: "msg-1",
      }),
    ).toStrictEqual({ access: "sess-32hex", userid: "u-1", phone: "13812345678" })
    const sent = JSON.parse(String(at(fetcher.calls, 0).init?.body)) as { param: Record<string, unknown> }
    expect(sent.param).toStrictEqual({
      ccode: "86",
      phone: "13812345678",
      mcode: "123456",
      msgid: "msg-1",
      expire: 1_209_600,
    })
  })
})
