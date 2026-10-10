/**
 * 保护 vendors/loomy/models.ts：把服务写在名字里的倍率拆成 rate 且幂等、
 * parseModel 只收 type==="chat" 且有 id 的条目、modelsFrom 支持三种外壳并按 id 去重、
 * fallbackModels 给的是副本。
 */

import { describe, expect, test } from "bun:test"
import { fallbackModels, modelsFrom, parseModel, splitRate } from "../src/vendors/loomy/models.ts"
import { LOOMY_FALLBACK_MODELS } from "../src/vendors/loomy/product.ts"
import { at } from "./helpers.ts"

describe("splitRate", () => {
  test("三种括号形态与 · 后缀都拆得干净", () => {
    expect(splitRate("MiniMax M3 （x4.0）")).toStrictEqual({ name: "MiniMax M3", rate: 4 })
    expect(splitRate("Qwen 3.8 Max (x12.0)")).toStrictEqual({ name: "Qwen 3.8 Max", rate: 12 })
    expect(splitRate("GLM 5.3 Flash(x0.8)")).toStrictEqual({ name: "GLM 5.3 Flash", rate: 0.8 })
    expect(splitRate("foo · x0.8")).toStrictEqual({ name: "foo", rate: 0.8 })
    expect(splitRate("foo（x3）")).toStrictEqual({ name: "foo", rate: 3 })
  })

  test("幂等：拆过的名字再拆没有变化", () => {
    for (const raw of ["MiniMax M3 （x4.0）", "Qwen 3.8 Max (x12.0)", "GLM 5.3 Flash(x0.8)", "foo · x0.8"]) {
      const once = splitRate(raw)
      expect(splitRate(once.name)).toStrictEqual({ name: once.name })
    }
  })

  test("无倍率的名字原样返回，且没有 rate 键", () => {
    expect(splitRate("DeepSeek V4 Flash 0731")).toStrictEqual({ name: "DeepSeek V4 Flash 0731" })
    expect(splitRate("  Kimi k2.6  ")).toStrictEqual({ name: "Kimi k2.6" })
  })

  test("纯价格、空名字、非法倍率都不误伤", () => {
    expect(splitRate("")).toStrictEqual({ name: "" })
    expect(splitRate("   ")).toStrictEqual({ name: "" })
    expect(splitRate("(x4.0)")).toStrictEqual({ name: "(x4.0)" })
    expect(splitRate(" · x0.8")).toStrictEqual({ name: "· x0.8" })
    expect(splitRate("foo (x0)")).toStrictEqual({ name: "foo (x0)" })
    expect(splitRate("foo (x1.2.3)")).toStrictEqual({ name: "foo (x1.2.3)" })
    expect(splitRate("foo · 3")).toStrictEqual({ name: "foo", rate: 3 })
  })
})

describe("parseModel", () => {
  test("chat 模型解出倍率、上下文、图片与已知推理档", () => {
    const spec = parseModel({
      id: "MiniMax-M3",
      type: "chat",
      name: "MiniMax M3 （x4.0）",
      context_length: 1_048_576,
      max_tokens: 65_536,
      reasoning_efforts: ["low", "bogus", "high"],
      capabilities: { input_modalities: ["text", "Image"] },
    })
    expect(spec).toStrictEqual({
      id: "MiniMax-M3",
      name: "MiniMax M3",
      rate: 4,
      context: 1_048_576,
      output: 65_536,
      images: true,
      reasoning: true,
      efforts: ["low", "high"],
    })
  })

  test("max_output_tokens 兜底 max_tokens，非法值不进 spec", () => {
    const spec = parseModel({
      id: "m1",
      type: "chat",
      name: "m1",
      context_length: 0,
      max_output_tokens: 8_192,
    })
    expect(spec).toStrictEqual({
      id: "m1",
      name: "m1",
      output: 8_192,
      images: false,
      reasoning: false,
      efforts: [],
    })
  })

  test("只收 type==='chat' 且有 id 的条目", () => {
    expect(parseModel({ id: "m1", type: "embedding" })).toBeUndefined()
    expect(parseModel({ id: "m1" })).toBeUndefined()
    expect(parseModel({ type: "chat", name: "no id" })).toBeUndefined()
    expect(parseModel("m1")).toBeUndefined()
    expect(parseModel(null)).toBeUndefined()
  })

  test("纯空白的 id 与缺失等价，一并丢弃", () => {
    expect(parseModel({ id: "   ", type: "chat" })).toBeUndefined()
    expect(parseModel({ id: "\t\n", type: "chat", name: "x" })).toBeUndefined()
  })
})

describe("modelsFrom", () => {
  const entries = [
    { id: "a", type: "chat", name: "A (x1.5)" },
    { id: "a", type: "chat", name: "A 重复" },
    { id: "b", type: "chat" },
    { id: "c", type: "embedding" },
  ]

  test("数组 / {data} / {models} 三种外壳都认，并按 id 去重", () => {
    const expected = [
      { id: "a", name: "A", rate: 1.5, images: false, reasoning: false, efforts: [] },
      { id: "b", name: "b", images: false, reasoning: false, efforts: [] },
    ]
    expect(modelsFrom(entries)).toStrictEqual(expected)
    expect(modelsFrom({ data: entries })).toStrictEqual(expected)
    expect(modelsFrom({ models: entries })).toStrictEqual(expected)
  })

  test("垃圾外壳给空数组", () => {
    expect(modelsFrom("nope")).toStrictEqual([])
    expect(modelsFrom({ data: {} })).toStrictEqual([])
    expect(modelsFrom(undefined)).toStrictEqual([])
  })
})

describe("fallbackModels", () => {
  test("返回副本，改一个不影响常量", () => {
    const list = fallbackModels()
    expect(list.map((spec) => spec.id)).toStrictEqual([
      "deepseek-v4-flash-0731",
      "MiniMax-M3",
      "Kimi-k2.6",
      "qwen-3.8-max",
      "GLM-5.3-Flash",
      "qwen3.8-flash",
      "spark-x",
      "mimo-v2.5",
    ])
    expect(list).not.toBe(LOOMY_FALLBACK_MODELS)
    at(list, 0).name = "改过了"
    expect(at(LOOMY_FALLBACK_MODELS, 0).name).toBe("DeepSeek V4 Flash 0731")
    expect(at(fallbackModels(), 0).name).toBe("DeepSeek V4 Flash 0731")
  })
})
