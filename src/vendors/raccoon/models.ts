/**
 * Raccoon's model catalog, as the host wants it.
 *
 * `/model_catalog` answers `data.categories[]`, and only the category whose
 * `type` is `chat` holds the models this package may route to. Three
 * details of that shape decide this file:
 *
 * - A model's **id is its `name`** field (the `chat/completions` body's
 *   `model`), and its display name is `description`. The rate is *not* in
 *   either: it comes from `billing_multiplier` /
 *   `billing_effective_multiplier`, and it is reported as `rate`/`rateWas`,
 *   where the host draws it as a badge — so the name stays a name.
 * - `visible: false` is the service hiding a model from its own picker
 *   (three `raccoon-*` internals). A model the vendor hides is not one this
 *   package offers.
 * - `tags` under-report image support: GLM-5-3-Flash and
 *   DeepSeek-V4.1-Flash both read images and neither says so (measured), so
 *   the two are added by `RACCOON_IMAGE_MODELS` rather than by guessing from
 *   names.
 */

import { asArray, asObject, num, str, stringList } from "../../core/json.ts"
import type { ModelSpec } from "../../core/models.ts"
import { RACCOON_EFFORTS, RACCOON_FALLBACK_MODELS, RACCOON_IMAGE_MODELS } from "./product.ts"

function positiveInt(value: unknown): number | undefined {
  const parsed = num(value)
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function readsImages(entry: Record<string, unknown>, id: string): boolean {
  const tags = stringList(entry.tags).map((tag) => tag.toLowerCase())
  const said = tags.some((tag) => tag === "vision" || tag === "image" || tag === "image-understanding")
  return said || RACCOON_IMAGE_MODELS.includes(id)
}

/** One catalog entry as a `ModelSpec`; undefined for anything else. */
export function parseModel(entry: unknown): ModelSpec | undefined {
  const record = asObject(entry)
  if (record === undefined) return undefined
  const id = str(record.name)?.trim()
  // A whitespace-only name trims to "": registering it would put a model with
  // an empty id in the catalog, which the host cannot route to.
  if (id === undefined || id.length === 0) return undefined
  if (record.visible === false) return undefined
  const params = asObject(record.params)
  const context = positiveInt(params?.context_window) ?? positiveInt(record.context_window)
  const output = positiveInt(params?.max_tokens)
  const description = str(record.description)?.trim()
  const effective = num(record.billing_effective_multiplier)
  const base = num(record.billing_multiplier)
  const rate = effective !== undefined && effective >= 0 ? effective : undefined
  const rateWas = base !== undefined && rate !== undefined && base > rate ? base : undefined
  return {
    id,
    name: description !== undefined && description.length > 0 ? description : id,
    ...(context === undefined ? {} : { context }),
    ...(output === undefined ? {} : { output }),
    ...(rate === undefined ? {} : { rate }),
    ...(rateWas === undefined ? {} : { rateWas }),
    ...(rate === 0 ? { free: true } : {}),
    images: readsImages(record, id),
    reasoning: true,
    efforts: [...RACCOON_EFFORTS],
  }
}

/** The chat models in an answer, in the service's own order. */
export function modelsFrom(payload: unknown): ModelSpec[] {
  const root = asObject(payload)
  const data = asObject(root?.data) ?? root
  const categories = asArray(data?.categories) ?? []
  const chat = categories.find((entry) => asObject(entry)?.type === "chat")
  const list = asArray(asObject(chat)?.models) ?? asArray(data?.models) ?? []
  const out: ModelSpec[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const spec = parseModel(item)
    if (spec === undefined || seen.has(spec.id)) continue
    seen.add(spec.id)
    out.push(spec)
  }
  return out
}

/** The catalog this package carries, for when `/model_catalog` cannot be read. */
export function fallbackModels(): ModelSpec[] {
  return RACCOON_FALLBACK_MODELS.map((spec) => ({ ...spec }))
}
