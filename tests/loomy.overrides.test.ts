/**
 * 保护从 JetHub 移植回本包的三条 Loomy 协议修正：
 *
 * 1. **spark-x 上下文覆盖**（IKJW31）：远端虚报 1M、真实墙 262144 ——
 *    兜底表与远端解析**两条路径**都必须过覆盖表（只改兜底表无效），
 *    查表大小写/空白不敏感（上游改大小写即静默失效的教训）。
 * 2. **qwen-3.8-max 图片能力覆盖**（2026-10-14 报障）：远端漏报
 *    input_modalities、实测能读图 —— 同样两条路径都过覆盖表。
 * 3. **200 + 业务码 100002 重建为 401**（JetHub E-1）：聊天链路的登录态失效
 *    恒 HTTP 200，宿主只认状态码 —— 不重建账号永远不会被标记过期。
 */

import { describe, expect, test } from "bun:test"
import { rewriteAuthFailure } from "../src/vendors/loomy/api.ts"
import { fallbackModels, parseModel } from "../src/vendors/loomy/models.ts"
import { contextWindowOf, LOOMY_FALLBACK_MODELS, supportsImageOf } from "../src/vendors/loomy/product.ts"
import { at, cannedFetch, jsonOk, textBody } from "./helpers.ts"

describe("覆盖表（product.ts）", () => {
  test("spark-x 的上下文按真实墙 262144 落地，其余模型不误伤", () => {
    expect(contextWindowOf("spark-x", 1_048_576)).toBe(262_144)
    expect(contextWindowOf("deepseek-v4-flash-0731", 1_048_576)).toBe(1_048_576)
    expect(contextWindowOf("mimo-v2.5", 999)).toBe(999)
  })

  test("查表大小写/空白不敏感（上游改大小写不得静默失效）", () => {
    expect(contextWindowOf("Spark-X", 1_048_576)).toBe(262_144)
    expect(contextWindowOf("  SPARK-X  ", 1_048_576)).toBe(262_144)
    expect(supportsImageOf("Qwen-3.8-Max", false)).toBe(true)
  })

  test("qwen-3.8-max 声明纯文本但实测读图；MiniMax-M3 的假声明刻意不降级", () => {
    expect(supportsImageOf("qwen-3.8-max", false)).toBe(true)
    expect(supportsImageOf("MiniMax-M3", true)).toBe(true)
    expect(supportsImageOf("deepseek-v4-flash-0731", false)).toBe(false)
  })

  test("兜底表的 spark-x 已是 262144（两条真相源不得分叉）", () => {
    const sparkX = LOOMY_FALLBACK_MODELS.find((spec) => spec.id === "spark-x")
    expect(sparkX?.context).toBe(262_144)
  })
})

describe("parseModel 的远端路径", () => {
  test("spark-x 远端声明 1M 也必须落成 262144（远端虚报是本缺陷的成因）", () => {
    const spec = parseModel({
      id: "spark-x",
      type: "chat",
      name: "Spark X2.5 (x0.1)",
      context_length: 1_048_576,
      capabilities: { input_modalities: ["text"] },
    })
    expect(at([spec] as const, 0)?.context).toBe(262_144)
    expect(at([spec] as const, 0)?.images).toBe(false)
  })

  test("qwen-3.8-max 远端漏报 input_modalities 仍判为支持图片", () => {
    const spec = parseModel({
      id: "qwen-3.8-max",
      type: "chat",
      name: "Qwen 3.8 Max (x12.0)",
      context_length: 1_000_000,
      capabilities: { input_modalities: ["text"] },
    })
    expect(at([spec] as const, 0)?.images).toBe(true)
    expect(at([spec] as const, 0)?.context).toBe(1_000_000)
  })

  test("兜底表路径：fallbackModels 的 spark-x 是 262144", () => {
    const sparkX = fallbackModels().find((spec) => spec.id === "spark-x")
    expect(sparkX?.context).toBe(262_144)
  })
})

describe("rewriteAuthFailure（200+100002 → 401）", () => {
  test("200 + 100002 重建为 401，响应体保留厂商原话", async () => {
    const fetcher = cannedFetch([
      { match: "chat/completions", respond: jsonOk({ code: "100002", desc: "缺少 token", data: null }) },
    ])
    const response = await rewriteAuthFailure(fetcher)("https://loomyad.xunfei.cn/api/v1/chat/completions", {
      method: "POST",
    })
    expect(response.status).toBe(401)
    const body = (await response.json()) as { code?: string }
    expect(body.code).toBe("100002")
  })

  test("200 + 其它业务码不重建（认证失败之外的状态码不归这条管）", async () => {
    const fetcher = cannedFetch([
      { match: "chat/completions", respond: jsonOk({ code: "100001", desc: "其它错误", data: null }) },
    ])
    const response = await rewriteAuthFailure(fetcher)("https://loomyad.xunfei.cn/api/v1/chat/completions", {
      method: "POST",
    })
    expect(response.status).toBe(200)
  })

  test("非 JSON 成功响应（HTML/文本）原样交回", async () => {
    const fetcher = cannedFetch([{ match: "chat/completions", respond: textBody("<html>oops</html>") }])
    const response = await rewriteAuthFailure(fetcher)("https://loomyad.xunfei.cn/api/v1/chat/completions", {
      method: "POST",
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("<html>oops</html>")
  })

  test("声明 JSON 但体不是 JSON → 原样交回，绝不锁死或吞掉响应", async () => {
    const fetcher = cannedFetch([
      {
        match: "chat/completions",
        respond: new Response("not-json{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      },
    ])
    const response = await rewriteAuthFailure(fetcher)("https://loomyad.xunfei.cn/api/v1/chat/completions", {
      method: "POST",
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("not-json{")
  })

  test("传输层失败原样上抛（本层不加错误）", async () => {
    const failing = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      void input
      void init
      throw new Error("network down")
    }) as unknown as typeof fetch
    await expect(
      rewriteAuthFailure(failing)("https://loomyad.xunfei.cn/api/v1/chat/completions"),
    ).rejects.toThrow("network down")
  })
})
