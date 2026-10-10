/**
 * Builders for the two model shapes the host reads.
 *
 * `config` declares a provider's default models in the config-model shape;
 * `provider.models` answers with OpenCode `Model` objects. Both come from one
 * `ModelSpec`, so a vendor states its catalog once.
 */

import type { GatewayModel, ModelRecord } from "./types.ts"

export interface ModelSpec {
  id: string
  /** Shown in pickers. Narration such as a rate belongs in `rate`. */
  name: string
  context?: number
  output?: number
  input?: number
  images?: boolean
  reasoning?: boolean
  /** Reasoning tiers, by id, in display order. Must be ids the host knows. */
  efforts?: string[]
  toolCall?: boolean
  temperature?: boolean
  /** Plan credits one request costs, as a multiple. */
  rate?: number
  /** The multiple before a discount now running. */
  rateWas?: number
  free?: boolean
  /** The AI SDK package this model speaks; defaults to the provider's. */
  npm?: string
}

/** The host's config-model shape (what a `config` hook declares). */
export function toConfigModel(spec: ModelSpec): Record<string, unknown> {
  return {
    name: spec.name,
    reasoning: spec.reasoning ?? false,
    tool_call: spec.toolCall ?? true,
    attachment: spec.images ?? false,
    modalities: { input: spec.images === true ? ["text", "image"] : ["text"], output: ["text"] },
    limit: { context: spec.context ?? 0, output: spec.output ?? 0 },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    variants: variantsOf(spec),
  }
}

export function variantsOf(spec: ModelSpec): Record<string, Record<string, never>> {
  const out: Record<string, Record<string, never>> = {}
  for (const effort of spec.efforts ?? []) out[effort] = {}
  return out
}

export interface ModelContext {
  providerID: string
  npm: string
  api: string
}

/** The host's `provider.models` shape, carrying rate and free where it reads them. */
export function toGatewayModel(spec: ModelSpec, context: ModelContext): GatewayModel {
  const images = spec.images === true
  return {
    id: spec.id,
    providerID: context.providerID,
    name: spec.name,
    api: { id: spec.id, url: context.api, npm: spec.npm ?? context.npm },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: {
      context: spec.context ?? 0,
      output: spec.output ?? 0,
      ...(spec.input === undefined ? {} : { input: spec.input }),
    },
    capabilities: {
      temperature: spec.temperature ?? true,
      reasoning: spec.reasoning ?? false,
      attachment: images,
      toolcall: spec.toolCall ?? true,
      input: { text: true, image: images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    variants: variantsOf(spec),
    release_date: "",
    ...(spec.free === true ? { free: true } : {}),
    ...(spec.rate === undefined ? {} : { rate: spec.rate }),
    ...(spec.rateWas === undefined ? {} : { rateWas: spec.rateWas }),
  }
}

export function toModelRecord(specs: ModelSpec[], context: ModelContext): ModelRecord {
  const out: ModelRecord = {}
  for (const spec of specs) out[spec.id] = toGatewayModel(spec, context)
  return out
}

/** Every spec in the config-model shape, by id, for a `config` hook. */
export function toConfigModels(specs: ModelSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const spec of specs) out[spec.id] = toConfigModel(spec)
  return out
}

/**
 * Says the list is the package's own, not the vendor's: a `provider.models`
 * hook that returns one marks the account's list as fallen back
 * (`host.js`'s `info()` reads `Symbol.for("magpie.fellBack")` and shows why).
 */
export function markFallback(record: ModelRecord): ModelRecord {
  Object.defineProperty(record, Symbol.for("magpie.fellBack"), {
    value: true,
    enumerable: false,
  })
  return record
}

/**
 * The host's rate parser: numbers and vendor strings such as `"x0.75"`.
 * Returns undefined when the value says nothing usable.
 */
export function parseRate(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
  if (typeof value !== "string") return undefined
  const match = value
    .trim()
    .toLowerCase()
    .match(/^x?\s*([0-9]+(?:\.[0-9]+)?)$/)
  if (!match) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}
