/**
 * 保护 vendors/astudio/models.ts 与 api.ts 的目录解析：builtin/ 别名解码
 * （含 `-`/`_` 的 base64url）、hide 条目不产出、裸 slug 去重、efforts 只声明
 * 远端下发过的集合、defaultEffort 越界被丢、图片能力以 input_modalities 为判据。
 */

import { describe, expect, test } from "bun:test"
import { bareSlugOf, modelsFrom } from "../src/vendors/astudio/api.ts"
import { fallbackModels, specOf, specsFrom } from "../src/vendors/astudio/models.ts"
import { at } from "./helpers.ts"

const b64url = (value: string): string => Buffer.from(value, "utf8").toString("base64url")

describe("bareSlugOf", () => {
  test("builtin/<base64url(slug)> 解回裸 slug", () => {
    expect(bareSlugOf(`builtin/${b64url("xopglm52")}`)).toBe("xopglm52")
  })

  test("含 - 的 slug（spark-x2.6-preview）也能解：- 与 _ 必须先换回 + 与 /", () => {
    expect(bareSlugOf(`builtin/${b64url("spark-x2.6-preview")}`)).toBe("spark-x2.6-preview")
  })

  test("非 builtin/ 前缀原样返回", () => {
    expect(bareSlugOf("xopglm52")).toBe("xopglm52")
  })

  test("解不出可打印内容时原样返回，绝不抛", () => {
    expect(bareSlugOf("builtin/____")).toBe("builtin/____")
  })
})

describe("modelsFrom", () => {
  test("visibility: hide（内部别名）不产出；同一裸 slug 去重", () => {
    const models = modelsFrom([
      { slug: `builtin/${b64url("xopglm52")}`, display_name: "GLM-5.2", visibility: "list" },
      { slug: "xopglm52", display_name: "GLM-5.2", visibility: "hide" },
      { slug: "spark-x2.5", display_name: "Spark-X2.5", visibility: "list" },
    ])
    expect(models.map((model) => model.id)).toStrictEqual(["xopglm52", "spark-x2.5"])
  })

  test("字段映射：context_window / max_output_tokens / efforts / default_reasoning_level", () => {
    const models = modelsFrom([
      {
        slug: "xopglm52",
        display_name: "GLM-5.2",
        context_window: 1_000_000,
        max_output_tokens: 128_000,
        supported_reasoning_levels: [{ effort: "none" }, { effort: "high" }, { effort: "max" }],
        default_reasoning_level: "high",
        input_modalities: ["text"],
      },
    ])
    const model = models[0]
    expect(model).toBeDefined()
    if (model === undefined) return
    expect(model.contextWindow).toBe(1_000_000)
    expect(model.maxTokens).toBe(128_000)
    expect(model.efforts).toStrictEqual(["none", "high", "max"])
    expect(model.defaultEffort).toBe("high")
    expect(model.supportsImage).toBe(false)
  })

  test("defaultEffort 不在 efforts 集合内时丢弃（指到集合外会被宿主静默丢弃）", () => {
    const models = modelsFrom([
      {
        slug: "m1",
        display_name: "M1",
        supported_reasoning_levels: [{ effort: "high" }],
        default_reasoning_level: "medium",
      },
    ])
    expect(at(models, 0).defaultEffort).toBeUndefined()
  })

  test("input_modalities 含 image 时 supportsImage 为真（判据是远端字段）", () => {
    const models = modelsFrom([{ slug: "vision-1", display_name: "V", input_modalities: ["text", "image"] }])
    expect(at(models, 0).supportsImage).toBe(true)
  })

  test("slug 缺失的条目跳过", () => {
    expect(modelsFrom([{ display_name: "无名" }, "junk", null])).toStrictEqual([])
  })
})

describe("specsFrom / specOf", () => {
  test("目录条目 → ModelSpec：efforts 原样、无 efforts 不声明 reasoning", () => {
    const specs = specsFrom([
      {
        id: "xopglm52",
        name: "GLM-5.2",
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        efforts: ["none", "high", "max"],
        defaultEffort: "high",
        supportsImage: false,
      },
      { id: "plain", name: "Plain", supportsImage: false },
    ])
    expect(at(specs, 0)).toMatchObject({
      id: "xopglm52",
      name: "GLM-5.2",
      context: 1_000_000,
      output: 128_000,
      reasoning: true,
      efforts: ["none", "high", "max"],
    })
    const plain = at(specs, 1)
    expect(plain.reasoning).toBe(false)
    expect(plain.efforts).toBeUndefined()
    expect(plain.context).toBeUndefined()
  })

  test("specOf 不为缺失字段写 0/undefined（exactOptionalPropertyTypes 下也不合法）", () => {
    const spec = specOf({ id: "m", name: "M", supportsImage: false })
    expect("context" in spec).toBe(false)
    expect("output" in spec).toBe(false)
  })
})

describe("fallbackModels", () => {
  test("2026-10-15 实测的全量 6 模型；没有 glm5.3flash（上游目录里不存在）", () => {
    const models = fallbackModels()
    expect(models.map((model) => model.id)).toStrictEqual([
      "xopglm52",
      "astronclaw-auto",
      "xopdsv4flash0731in",
      "xopdeepseekv4pro0813",
      "spark-x2.5",
      "spark-x2.6-preview",
    ])
    expect(models.some((model) => model.id.includes("glm5.3"))).toBe(false)
  })
})
