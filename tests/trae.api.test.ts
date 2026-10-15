/**
 * 保护 vendors/trae/api.ts：凭据读写、设备身份派生、目录解析、SSE 分帧。
 * 这些都是纯函数，所以每条规则都能用一份固定数据钉住。
 *
 * 重点在三条「猜错了不会报错」的规则：目录里 is_invisible_to_user / 非
 * chat_completion 的条目必须剔除、同一模型在多个通道里要取信息更全的那条、
 * 登录态的 machineId/deviceId 必须在续期时原样保留。
 */

import { describe, expect, test } from "bun:test"
import {
  applyRefresh,
  buildCredential,
  checkinHeaders,
  credentialOf,
  identityFields,
  jwtExpiresAtMs,
  parseBatchCatalog,
  parseExchange,
  parseUserInfo,
  requestIds,
  soloHeaders,
  takeEvents,
} from "../src/vendors/trae/api.ts"
import { TRAE_CLIENT } from "../src/vendors/trae/product.ts"
import { at } from "./helpers.ts"

const CREDENTIAL = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: 1_800_000_000_000,
  uid: "uid-1",
  nickname: "用户",
  machineId: "a".repeat(32),
  deviceId: "b".repeat(32),
}

describe("凭据读写", () => {
  test("读回时字段名扁平、缺失的 refresh 给空串", () => {
    expect(credentialOf({ accessToken: "t", uid: "u" })).toStrictEqual({
      accessToken: "t",
      refreshToken: "",
      uid: "u",
      machineId: "",
      deviceId: "",
    })
  })

  test("缺少 accessToken 或 uid 就不算一个可用凭据", () => {
    expect(credentialOf({ accessToken: "t" })).toBeUndefined()
    expect(credentialOf({ uid: "u" })).toBeUndefined()
    expect(credentialOf(undefined)).toBeUndefined()
  })

  test("写回账号时只带身份，不重复写 token（宿主自己有 access/refresh/expires）", () => {
    const fields = identityFields(CREDENTIAL)
    expect(fields.machineId).toBe(CREDENTIAL.machineId)
    expect(fields.deviceId).toBe(CREDENTIAL.deviceId)
    expect(fields.uid).toBe(CREDENTIAL.uid)
    // 两个 token 与到期时间不属于这里：写第二遍就多了一份会漂移的记录。
    expect("accessToken" in fields).toBe(false)
    expect("refreshToken" in fields).toBe(false)
    expect("expiresAt" in fields).toBe(false)
  })

  test("续期轮换两个 token，但设备与身份原样保留", () => {
    const next = applyRefresh(
      CREDENTIAL,
      { accessToken: "new-access", refreshToken: "new-refresh", tokenExpireAt: 0, tokenExpireDuration: 3600 },
      1000,
    )
    expect(next.accessToken).toBe("new-access")
    expect(next.refreshToken).toBe("new-refresh")
    expect(next.machineId).toBe(CREDENTIAL.machineId)
    expect(next.deviceId).toBe(CREDENTIAL.deviceId)
    expect(next.uid).toBe("uid-1")
    expect(next.expiresAt).toBe(1000 + 3_600_000)
  })

  test("续期响应没带新 refresh 时保留旧的（否则账号变成不可续期）", () => {
    const next = applyRefresh(
      CREDENTIAL,
      { accessToken: "new-access", refreshToken: "", tokenExpireAt: 0, tokenExpireDuration: 1 },
      0,
    )
    expect(next.refreshToken).toBe("refresh-token")
  })

  test("JWT 的 exp 能被读出来", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1700000000 })).toString("base64url")
    expect(jwtExpiresAtMs(`header.${payload}.signature`)).toBe(1_700_000_000_000)
    expect(jwtExpiresAtMs("nonsense")).toBeUndefined()
  })

  test("ExchangeToken / GetUserInfo 的 Pascal 与 camel 两种信封都认", () => {
    expect(parseExchange({ Result: { Token: "t", RefreshToken: "r", TokenExpireAt: 5 } })).toStrictEqual({
      accessToken: "t",
      refreshToken: "r",
      tokenExpireAt: 5,
      tokenExpireDuration: 0,
    })
    expect(parseExchange({ result: { token: "t" } })).toStrictEqual({
      accessToken: "t",
      refreshToken: "",
      tokenExpireAt: 0,
      tokenExpireDuration: 0,
    })
    expect(parseExchange({})).toBeUndefined()
    expect(parseUserInfo({ Result: { UserID: "u", ScreenName: "名字", EnterpriseID: "e" } })).toStrictEqual({
      uid: "u",
      screenName: "名字",
      enterpriseId: "e",
    })
  })

  test("组装凭据时设备身份来自登录流程，不在响应里", () => {
    const credential = buildCredential(
      { accessToken: "a", refreshToken: "r", tokenExpireAt: 0, tokenExpireDuration: 60 },
      { uid: "u", screenName: "n", enterpriseId: "" },
      { machineId: "m", deviceId: "d" },
      500,
    )
    expect(credential.machineId).toBe("m")
    expect(credential.deviceId).toBe("d")
    expect(credential.expiresAt).toBe(60_500)
  })
})

describe("请求头", () => {
  test("聊天头三处都带 token，并带上两个设备指纹", () => {
    const headers = soloHeaders(CREDENTIAL, TRAE_CLIENT, true)
    expect(headers.Authorization).toBe("Cloud-IDE-JWT access-token")
    expect(headers["X-Ide-Token"]).toBe("access-token")
    expect(headers["X-Cloudide-Token"]).toBe("access-token")
    expect(headers["X-Machine-Id"]).toBe(CREDENTIAL.machineId)
    expect(headers["X-Device-Id"]).toBe(CREDENTIAL.deviceId)
    expect(headers["X-App-Id"]).toBe(TRAE_CLIENT.appId)
  })

  test("设备指纹为空时不发该头（而不是发空值）", () => {
    const headers = soloHeaders({ ...CREDENTIAL, machineId: "", deviceId: "" }, TRAE_CLIENT, false)
    expect("X-Machine-Id" in headers).toBe(false)
    expect("X-Device-Id" in headers).toBe(false)
  })

  test("签到头是按账号确定性派生的设备身份，与登录态的 deviceId 无关", () => {
    const first = checkinHeaders(CREDENTIAL, TRAE_CLIENT, "req-1", "00-trace-01")
    const second = checkinHeaders(CREDENTIAL, TRAE_CLIENT, "req-2", "00-trace-02")
    // 同一个 uid ⇒ 同一套稳定身份；只有每次请求级的 id 会变。
    expect(first["X-Device-Id"]).toBe(second["X-Device-Id"])
    expect(first["X-Market-User-Id"]).toBe(second["X-Market-User-Id"])
    expect(first["X-Request-Id"]).toBe("req-1")
    expect(second["X-Request-Id"]).toBe("req-2")
    // 不同账号 ⇒ 不同设备身份（设备级签到配额靠这一点分开）。
    const other = checkinHeaders({ ...CREDENTIAL, uid: "uid-2" }, TRAE_CLIENT, "req-1", "00-trace-01")
    expect(other["X-Device-Id"]).not.toBe(first["X-Device-Id"])
    expect(first["X-User-Region"]).toBe("CN")
  })

  test("每次请求级 id 都是新的", () => {
    expect(requestIds().requestId).not.toBe(requestIds().requestId)
  })
})

describe("目录解析", () => {
  const catalog = {
    function_configs: [
      {
        function: "solo_agent",
        config_info_list: [
          {
            config_name: "glm-5.2",
            usage: "chat_completion",
            config_switch: true,
            is_invisible_to_user: false,
            display_config: { display_name: "GLM-5.2", is_custom_model: false, multimodal: false },
            context_window_tokens: { dev: 200_000, max: 1_000_000 },
            model_detail_list: [{ model_name: "glm-5.2__dev", max_tokens: 32_000 }],
            reasoning_effort_config: { options: ["light", "high"], support_thinking: true },
          },
          {
            config_name: "内部标题",
            usage: "chat_completion",
            is_invisible_to_user: true,
            display_config: { display_name: "内部标题" },
          },
          {
            config_name: "摘要工具",
            usage: "summary",
            display_config: { display_name: "摘要工具" },
          },
          {
            config_name: "已停用",
            usage: "chat_completion",
            config_switch: false,
            display_config: { display_name: "已停用" },
          },
          {
            config_name: "自定义模型",
            usage: "chat_completion",
            display_config: { display_name: "自定义模型", is_custom_model: true },
          },
        ],
      },
    ],
  }

  test("只留 chat_completion、启用、用户可见的条目", () => {
    const ids = parseBatchCatalog(catalog).map((model) => model.id)
    expect(ids).toStrictEqual(["glm-5.2", "自定义模型"])
  })

  test("上下文取 dev 而不是 max（max 需要另开开关）", () => {
    const model = at(parseBatchCatalog(catalog), 0)
    expect(model.contextWindow).toBe(200_000)
    expect(model.maxOutputTokens).toBe(32_000)
    expect(model.efforts).toStrictEqual(["light", "high"])
    expect(model.multimodal).toBe(false)
  })

  test("同一模型出现在多个通道时，有档位的条目胜出", () => {
    const merged = parseBatchCatalog({
      function_configs: [
        {
          function: "solo_work_lite",
          config_info_list: [
            {
              config_name: "glm-5.2",
              usage: "chat_completion",
              display_config: { display_name: "GLM-5.2" },
              reasoning_effort_config: { options: [], support_thinking: false },
            },
          ],
        },
        {
          function: "solo_agent",
          config_info_list: [
            {
              config_name: "glm-5.2",
              usage: "chat_completion",
              display_config: { display_name: "GLM-5.2" },
              reasoning_effort_config: { options: ["high"], support_thinking: true },
            },
          ],
        },
      ],
    })
    expect(at(merged, 0).channel).toBe("solo_agent")
    expect(at(merged, 0).efforts).toStrictEqual(["high"])
  })

  test("折扣只在真的降价时才报，off_peak 的 before===after 不算", () => {
    const of = (rate: string): number | undefined =>
      at(
        parseBatchCatalog({
          function_configs: [
            {
              function: "solo_agent",
              config_info_list: [
                {
                  config_name: "glm-5.2",
                  usage: "chat_completion",
                  display_config: { display_name: "GLM-5.2" },
                  display_contact_config: rate,
                },
              ],
            },
          ],
        }),
        0,
      ).rateWas
    expect(of('{"consumption_rate":{"enable":true,"data":{"rate":0.08}}}')).toBeUndefined()
    expect(
      of(
        '{"consumption_rate":{"enable":true,"data":{"rate":0.08}},"activity_discount":{"enable":true,"data":{"current":{"discount_type":"none","before_consumption_rate":0.13,"consumption_rate":0.13}}}}',
      ),
    ).toBeUndefined()
    expect(
      of(
        '{"consumption_rate":{"enable":true,"data":{"rate":0.08}},"activity_discount":{"enable":true,"data":{"current":{"discount_type":"limited","before_consumption_rate":0.16,"consumption_rate":0.08}}}}',
      ),
    ).toBe(0.16)
  })

  test("rate:0（免费模型）是有效倍率，不能当成缺失", () => {
    const model = at(
      parseBatchCatalog({
        function_configs: [
          {
            function: "solo_agent",
            config_info_list: [
              {
                config_name: "free",
                usage: "chat_completion",
                display_config: { display_name: "Free" },
                display_contact_config: '{"consumption_rate":{"enable":true,"data":{"rate":0}}}',
              },
            ],
          },
        ],
      }),
      0,
    )
    expect(model.rate).toBe(0)
  })

  test("没有 function_configs 就不是一个目录（返回空数组，交给上层回退）", () => {
    expect(parseBatchCatalog({})).toStrictEqual([])
    expect(parseBatchCatalog(undefined)).toStrictEqual([])
  })
})

describe("SSE 分帧", () => {
  test("data: 无空格也能解析，且跨块残片保留", () => {
    const first = takeEvents('event:output\ndata:{"response":"a"}\n\nevent:output\ndata:{"res')
    expect(first.events).toHaveLength(1)
    expect(at(first.events, 0).content).toBe("a")
    const second = takeEvents(`${first.rest}ponse":"b"}\n\n`)
    expect(at(second.events, 0).content).toBe("b")
    expect(second.rest).toBe("")
  })

  test("无法解析的 JSON 退化成只有事件名，不抛错", () => {
    const parsed = takeEvents("event:output\ndata:not-json\n\n")
    expect(at(parsed.events, 0).event).toBe("output")
    expect(at(parsed.events, 0).content).toBeUndefined()
  })
})
