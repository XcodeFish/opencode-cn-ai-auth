/**
 * 保护 vendors/raccoon/models.ts：目录只认 `categories[].type === "chat"`、
 * 模型 id 取 `name` 且丢弃空 id / `visible: false` 的条目、倍率来自
 * `billing_*`（0 倍率标记 free）、图片白名单在两处都生效、fallbackModels 给副本。
 */

import { describe, expect, test } from "bun:test"
import { fallbackModels, modelsFrom, parseModel } from "../src/vendors/raccoon/models.ts"
import {
  RACCOON_FALLBACK_MODELS,
  RACCOON_TEXT_ONLY_MODELS,
  supportsImageOf,
  supportsImageWith,
} from "../src/vendors/raccoon/product.ts"

describe("parseModel", () => {
  test("id 取 name，展示名取 description，倍率与折扣各自成字段", () => {
    expect(
      parseModel({
        name: "sn-glm-5-3-flash",
        description: "GLM-5-3-Flash",
        billing_multiplier: 0.2,
        billing_effective_multiplier: 0.1,
        params: { context_window: 1_000_000, max_tokens: 100_000 },
        tags: ["chat"],
      }),
    ).toStrictEqual({
      id: "sn-glm-5-3-flash",
      name: "GLM-5-3-Flash",
      context: 1_000_000,
      output: 100_000,
      rate: 0.1,
      rateWas: 0.2,
      images: true,
      reasoning: true,
      efforts: ["none", "high"],
    })
  })

  test("折扣到 0 就是 free，且不会把 0 写成 rateWas", () => {
    const spec = parseModel({
      name: "sn-sensenova-6-8-flash",
      billing_multiplier: 0.5,
      billing_effective_multiplier: 0,
    })
    expect(spec?.free).toBe(true)
    expect(spec?.rate).toBe(0)
    expect(spec?.rateWas).toBe(0.5)
  })

  test("没有折扣时不给 rateWas，description 缺失时名字退回 id", () => {
    const spec = parseModel({ name: "sn-kimi-k3", description: "   ", billing_multiplier: 1 })
    expect(spec).toStrictEqual({
      id: "sn-kimi-k3",
      name: "sn-kimi-k3",
      images: true,
      reasoning: true,
      efforts: ["none", "high"],
    })
  })

  test("visible:false 的隐藏模型、空 id 与非对象一律丢弃", () => {
    expect(parseModel({ name: "raccoon-internal", visible: false })).toBeUndefined()
    expect(parseModel({ name: "   " })).toBeUndefined()
    expect(parseModel({ description: "没有 name" })).toBeUndefined()
    expect(parseModel("sn-glm-5-3")).toBeUndefined()
    expect(parseModel(null)).toBeUndefined()
  })

  test("上下文只认正整数，params 缺省时回落到顶层字段", () => {
    expect(parseModel({ name: "a", params: { context_window: 0, max_tokens: -1 } })).toStrictEqual({
      id: "a",
      name: "a",
      images: true,
      reasoning: true,
      efforts: ["none", "high"],
    })
    expect(parseModel({ name: "b", context_window: 256_000 })?.context).toBe(256_000)
  })
})

describe("图片能力：默认支持 + 纯文本黑名单（2026-10-22 自 JetHub 2227e9b 移植）", () => {
  test("不在黑名单的模型一律默认支持图片——不看 tags", () => {
    expect(parseModel({ name: "x", tags: [] })?.images).toBe(true)
    expect(parseModel({ name: "x", tags: ["general", "code"] })?.images).toBe(true)
    expect(supportsImageOf("sn-kimi-k3")).toBe(true)
  })

  test("同族滚版本不再被打回纯文本（2227e9b 的回归用例）", () => {
    // sn-deepseek-v4-1-flash-1017：旧精确白名单查不到 ⇒ 被判 text ⇒ 图片没发出去。
    expect(parseModel({ name: "sn-deepseek-v4-1-flash-1017" })?.images).toBe(true)
    expect(supportsImageOf("sn-deepseek-v4-1-flash-1017")).toBe(true)
  })

  test("黑名单：完整 id 与基础 id（剥 4 位数字后缀）都命中", () => {
    const textOnly = new Set(["sn-text-only"])
    expect(supportsImageWith(textOnly, "sn-text-only")).toBe(false)
    expect(supportsImageWith(textOnly, "sn-text-only-1001")).toBe(false)
  })

  test("非 4 位数字后缀不剥：-next / -text 变体不被误禁", () => {
    const textOnly = new Set(["sn-text-only"])
    expect(supportsImageWith(textOnly, "sn-text-only-next")).toBe(true)
    expect(supportsImageWith(textOnly, "sn-other")).toBe(true)
  })

  test("生产集合当前为空（当前目录没有实测确认的纯文本模型）", () => {
    expect(RACCOON_TEXT_ONLY_MODELS.size).toBe(0)
  })

  test("兜底表与远端判定共用一个判据，不得分叉", () => {
    for (const spec of RACCOON_FALLBACK_MODELS) {
      expect(spec.images).toBe(supportsImageOf(spec.id))
    }
  })
})

describe("modelsFrom", () => {
  const payload = {
    data: {
      categories: [
        { type: "image", models: [{ name: "hidden-by-category" }] },
        {
          type: "chat",
          models: [
            { name: "sn-glm-5-3", description: "GLM-5-3" },
            { name: "sn-glm-5-3", description: "重复" },
            { name: "   " },
            { name: "sn-kimi-k3", visible: false },
          ],
        },
      ],
    },
  }

  test("只取 chat 分类，按 id 去重，顺序不变", () => {
    expect(modelsFrom(payload).map((spec) => spec.id)).toStrictEqual(["sn-glm-5-3"])
  })

  test("习惯的外壳都在：没有 categories 时读 data.models / 顶层 models", () => {
    expect(modelsFrom({ data: { models: [{ name: "m1" }] } }).map((spec) => spec.id)).toStrictEqual(["m1"])
    expect(modelsFrom({ models: [{ name: "m2" }] }).map((spec) => spec.id)).toStrictEqual(["m2"])
    expect(modelsFrom("nope")).toStrictEqual([])
    expect(modelsFrom(undefined)).toStrictEqual([])
  })
})

describe("fallbackModels", () => {
  test("给的是副本，条数与展示顺序与服务一致", () => {
    const list = fallbackModels()
    expect(list.map((spec) => spec.id)).toStrictEqual(RACCOON_FALLBACK_MODELS.map((spec) => spec.id))
    const first = list[0]
    expect(first).toBeDefined()
    if (first !== undefined) first.name = "改过的名字"
    expect(fallbackModels()[0]?.name).not.toBe("改过的名字")
  })
})
