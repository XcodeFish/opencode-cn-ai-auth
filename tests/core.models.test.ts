/**
 * 保护 core/models.ts 的两种模型形状：config 模型始终带默认 limit / cost / variants，
 * gateway 模型只在给了值时才带 limit.input、free、rate、rateWas；
 * parseRate 的接受面与 markFallback 的不可枚举标记。
 */

import { describe, expect, test } from "bun:test"
import {
  type ModelContext,
  markFallback,
  parseRate,
  toConfigModel,
  toGatewayModel,
  variantsOf,
} from "../src/core/models.ts"
import type { ModelRecord } from "../src/core/types.ts"

const CONTEXT: ModelContext = {
  providerID: "loomy",
  npm: "@ai-sdk/openai-compatible",
  api: "https://loomyad.xunfei.cn/api/v1",
}

describe("toConfigModel / variantsOf", () => {
  test("最小 spec 得到完整形状与零成本占位", () => {
    expect(toConfigModel({ id: "m1", name: "M1" })).toStrictEqual({
      name: "M1",
      reasoning: false,
      tool_call: true,
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 0, output: 0 },
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      variants: {},
    })
  })

  test("images / reasoning / efforts / context / output 都写进 config 模型", () => {
    const model = toConfigModel({
      id: "m2",
      name: "M2",
      images: true,
      reasoning: true,
      efforts: ["low", "high"],
      context: 128_000,
      output: 8_192,
      toolCall: false,
    })
    expect(model).toStrictEqual({
      name: "M2",
      reasoning: true,
      tool_call: false,
      attachment: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 128_000, output: 8_192 },
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      variants: { low: {}, high: {} },
    })
  })

  test("variantsOf 按 efforts 顺序造空变体", () => {
    expect(variantsOf({ id: "m", name: "M", efforts: ["none", "xhigh"] })).toStrictEqual({
      none: {},
      xhigh: {},
    })
    expect(variantsOf({ id: "m", name: "M" })).toStrictEqual({})
  })
})

describe("toGatewayModel", () => {
  test("没给可选项时不含 free / rate / rateWas / limit.input", () => {
    const model = toGatewayModel({ id: "m1", name: "M1" }, CONTEXT)
    expect(Object.keys(model)).toStrictEqual([
      "id",
      "providerID",
      "name",
      "api",
      "status",
      "headers",
      "options",
      "cost",
      "limit",
      "capabilities",
      "variants",
      "release_date",
    ])
    expect(Object.keys(model.limit ?? {})).toStrictEqual(["context", "output"])
    expect("free" in model).toBe(false)
    expect("rate" in model).toBe(false)
    expect("rateWas" in model).toBe(false)
    expect(model.api).toStrictEqual({
      id: "m1",
      url: "https://loomyad.xunfei.cn/api/v1",
      npm: "@ai-sdk/openai-compatible",
    })
    expect(model.cost).toStrictEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
    expect(model.limit).toStrictEqual({ context: 0, output: 0 })
  })

  test("给了可选项时才出现，且能力位跟着 spec 走", () => {
    const model = toGatewayModel(
      {
        id: "m2",
        name: "M2",
        context: 1_048_576,
        output: 65_536,
        input: 1_000_000,
        images: true,
        reasoning: true,
        efforts: ["medium"],
        temperature: false,
        toolCall: false,
        free: true,
        rate: 0.8,
        rateWas: 4,
        npm: "@ai-sdk/openai",
      },
      CONTEXT,
    )
    expect(Object.keys(model)).toStrictEqual([
      "id",
      "providerID",
      "name",
      "api",
      "status",
      "headers",
      "options",
      "cost",
      "limit",
      "capabilities",
      "variants",
      "release_date",
      "free",
      "rate",
      "rateWas",
    ])
    expect(model.free).toBe(true)
    expect(model.rate).toBe(0.8)
    expect(model.rateWas).toBe(4)
    expect(model.limit).toStrictEqual({ context: 1_048_576, output: 65_536, input: 1_000_000 })
    expect(model.variants).toStrictEqual({ medium: {} })
    expect(model.api?.npm).toBe("@ai-sdk/openai")
    expect(model.capabilities).toStrictEqual({
      temperature: false,
      reasoning: true,
      attachment: true,
      toolcall: false,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    })
  })
})

describe("parseRate", () => {
  test("接受非负数字与 x 前缀字符串", () => {
    expect(parseRate(0)).toBe(0)
    expect(parseRate(0.75)).toBe(0.75)
    expect(parseRate("x0.75")).toBe(0.75)
    expect(parseRate("0.75")).toBe(0.75)
    expect(parseRate("1")).toBe(1)
    expect(parseRate("X 12")).toBe(12)
    expect(parseRate(" x4.0 ")).toBe(4)
  })

  test("垃圾输入一律 undefined", () => {
    expect(parseRate(-1)).toBeUndefined()
    expect(parseRate("-1")).toBeUndefined()
    expect(parseRate("abc")).toBeUndefined()
    expect(parseRate("")).toBeUndefined()
    expect(parseRate("1e3")).toBeUndefined()
    expect(parseRate("0.75x")).toBeUndefined()
    expect(parseRate("x")).toBeUndefined()
    expect(parseRate(Number.NaN)).toBeUndefined()
    expect(parseRate(true)).toBeUndefined()
    expect(parseRate(null)).toBeUndefined()
    expect(parseRate({})).toBeUndefined()
  })
})

describe("markFallback", () => {
  test("原位打上不可枚举的 Symbol.for('magpie.fellBack')", () => {
    const record: ModelRecord = { m1: toGatewayModel({ id: "m1", name: "M1" }, CONTEXT) }
    const returned = markFallback(record)
    expect(returned).toBe(record)
    expect(Object.keys(record)).toStrictEqual(["m1"])
    expect(Object.getOwnPropertySymbols(record)).toStrictEqual([Symbol.for("magpie.fellBack")])
    const descriptor = Object.getOwnPropertyDescriptor(record, Symbol.for("magpie.fellBack"))
    expect(descriptor?.value).toBe(true)
    expect(descriptor?.enumerable).toBe(false)
    expect(Reflect.get(record, Symbol.for("magpie.fellBack"))).toBe(true)
    expect(Object.values(record)).toHaveLength(1)
    expect(JSON.stringify(record)).not.toContain("fellBack")
  })
})
