/**
 * Loomy's model list, as the host wants it.
 *
 * `/models` answers a list of entries; only `type: "chat"` is a model this
 * package may route to. Two details of the service shape this file:
 *
 * - A model's credit rate is written **inside its display name** and nowhere
 *   else, in three bracket styles at once (`MiniMax M3 （x4.0）`,
 *   `Qwen 3.8 Max (x12.0)`, `GLM 5.3 Flash(x0.8)`). It is parsed out here and
 *   reported as `rate`, which is where the host renders it (a `0.8×` badge),
 *   so the name is left clean rather than saying the price twice.
 * - `input_modalities` says what a model can read, not whether it is a chat
 *   model: five of the eight chat models take images, and filtering on it
 *   would drop them.
 */

import { asArray, asObject, num, str, stringList } from "../../core/json.ts"
import type { ModelSpec } from "../../core/models.ts"
import { LOOMY_FALLBACK_MODELS } from "./product.ts"

/** The tiers the host knows how to send; anything else it drops silently. */
const KNOWN_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max", "minimal"])

export interface RawModel {
  name: string
  /** The multiple parsed out of the name, when the name carried one. */
  rate?: number
}

/**
 * Splits the rate off a display name. Idempotent: a name this package
 * already normalized has nothing left to split.
 */
export function splitRate(rawName: string): RawModel {
  const original = rawName.trim()
  if (original.length === 0) return { name: "" }
  const bracketed = original.match(/^(.*?)\s*[（(]\s*(?:x\s*)?([\d.]+)\s*[)）]\s*$/i)
  const suffixed = original.match(/^(.*?)\s*·\s*(?:x\s*)?([\d.]+)\s*$/i)
  const match = bracketed ?? suffixed
  if (match === null) return { name: original }
  const name = (match[1] ?? "").trim()
  const rate = Number(match[2])
  // An empty head means the whole name was a price: keep it as it came.
  if (name.length === 0 || !Number.isFinite(rate) || rate <= 0) return { name: original }
  return { name, rate }
}

/** The display name without its price, for the host's own rate badge. */
export function displayName(rawName: string): string {
  return splitRate(rawName).name
}

function effortsOf(entry: Record<string, unknown>): string[] {
  return stringList(entry.reasoning_efforts).filter((effort) => KNOWN_EFFORTS.has(effort))
}

function imagesOf(entry: Record<string, unknown>): boolean {
  const capabilities = asObject(entry.capabilities)
  const modalities = stringList(capabilities?.input_modalities).map((value) => value.toLowerCase())
  return modalities.includes("image")
}

/** One `/models` entry as a `ModelSpec`; undefined for anything else. */
export function parseModel(entry: unknown): ModelSpec | undefined {
  const record = asObject(entry)
  if (record === undefined) return undefined
  const id = str(record.id)?.trim()
  // A whitespace-only id trims to "": it is no more usable than a missing one
  // (it would be registered as a model whose id and name are both empty).
  if (id === undefined || id.length === 0 || record.type !== "chat") return undefined
  const { name, rate } = splitRate(str(record.name) ?? id)
  const efforts = effortsOf(record)
  const context = num(record.context_length)
  const output = num(record.max_tokens) ?? num(record.max_output_tokens)
  return {
    id,
    name: name.length > 0 ? name : id,
    ...(context === undefined || context <= 0 ? {} : { context }),
    ...(output === undefined || output <= 0 ? {} : { output }),
    ...(rate === undefined ? {} : { rate }),
    images: imagesOf(record),
    reasoning: efforts.length > 0,
    efforts,
  }
}

/** The whole answer, in the service's own order, chat models only. */
export function modelsFrom(payload: unknown): ModelSpec[] {
  const root = asObject(payload)
  const list = asArray(payload) ?? asArray(root?.data) ?? asArray(root?.models) ?? []
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

/** The catalog this package carries, for when `/models` cannot be read. */
export function fallbackModels(): ModelSpec[] {
  return LOOMY_FALLBACK_MODELS.map((spec) => ({ ...spec }))
}
