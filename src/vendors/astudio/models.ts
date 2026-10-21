/**
 * AStudio 的模型列表：远端目录 → `ModelSpec[]`，以及离线回退表。
 *
 * 三条来自实测的规则（JetHub 2026-10-15，见 `product.ts` 模块头）：
 *
 * 1. **对外只暴露裸 slug**：`visibility: "hide"` 的条目是 acode 内核的内部
 *    别名（`builtin/<base64url(slug)>`），不能出现在选择器里；发给上游推理
 *    端点会 502 `model_not_found` 的是别名形态，裸 slug 才是唯一被认的。
 *    `api.ts` 的 `modelsFrom` 已按裸 slug 去重（list 优先于 hide），这里只做
 *    规格转换。
 * 2. **思考档位只声明远端下发过的**：上游对非法档位不报错、按最大档静默
 *    执行（实测 `reasoning_effort:"bogus"` 以最大档计费跑完）—— 编造档位
 *    等于让用户选一个「看起来生效、实际按最大档计费」的值。
 * 3. **图片能力以远端 `input_modalities` 为判据**（实测六个模型全是
 *    `['text']`，因此恒 false）：判据是远端字段而不是实测结论，上游哪天加
 *    视觉模型，不改这行就自动生效。
 */

import type { ModelSpec } from "../../core/models.ts"
import type { CatalogModel } from "./api.ts"
import { ASTUDIO_FALLBACK_MODELS } from "./product.ts"

/** 一条目录条目 → `ModelSpec`（字段缺失就省键，不写 0/undefined）。 */
export function specOf(model: CatalogModel): ModelSpec {
  const efforts = model.efforts ?? []
  return {
    id: model.id,
    name: model.name,
    ...(model.contextWindow === undefined ? {} : { context: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { output: model.maxTokens }),
    images: model.supportsImage,
    reasoning: efforts.length > 0,
    ...(efforts.length > 0 ? { efforts: [...efforts] } : {}),
  }
}

/** 整份远端目录（`api.ts` 已解析与去重）→ 规格列表。 */
export function specsFrom(models: readonly CatalogModel[]): ModelSpec[] {
  return models.map(specOf)
}

/** 这份包自带的离线回退表（JetHub 2026-10-15 实测的全量 6 模型）。 */
export function fallbackModels(): ModelSpec[] {
  return ASTUDIO_FALLBACK_MODELS.map((spec) => ({ ...spec }))
}
