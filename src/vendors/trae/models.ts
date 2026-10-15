/**
 * Trae's catalog, as the host's model list.
 *
 * A parsed entry (`api.ts`) becomes a `ModelSpec` here, and the one thing
 * that has to survive the trip is the **channel** the model came from: it is
 * not part of `ModelSpec` (the host has no field for it), so it is kept in a
 * side table keyed by model id and read back when a chat request is built
 * (`registry.ts`'s `channelOf`). Losing it would send every model through the
 * default channel and be answered with `4001`.
 *
 * `efforts` are the vendor's own tier names, forwarded as-is: they are what
 * the upstream accepts on the wire, so translating them through a table would
 * only add a way to be wrong.
 */

import type { Fetcher } from "../../core/http.ts"
import type { ModelSpec } from "../../core/models.ts"
import { parseCatalogAnswer, soloHeaders, type TraeCredential, type TraeRemoteModel } from "./api.ts"
import {
  TRAE_AGENT_BASE,
  TRAE_CHANNELS,
  TRAE_CLIENT,
  TRAE_FALLBACK_CHANNEL,
  TRAE_FALLBACK_MAX_OUTPUT_TOKENS,
  TRAE_PATHS,
  TRAE_REQUEST_TIMEOUT_MS,
  traeFallbackModels,
} from "./product.ts"

/** One catalog read: the models the host shows, plus where each one is callable. */
export interface TraeCatalog {
  models: ModelSpec[]
  /** Model id → the channel that listed it. */
  channels: Map<string, string>
}

/** Turn a parsed remote catalog into the host's shape. */
export function modelsFrom(remote: readonly TraeRemoteModel[]): TraeCatalog {
  const models: ModelSpec[] = []
  const channels = new Map<string, string>()
  for (const entry of remote) {
    models.push({
      id: entry.id,
      name: entry.name,
      context: entry.contextWindow ?? 200_000,
      output: entry.maxOutputTokens ?? TRAE_FALLBACK_MAX_OUTPUT_TOKENS,
      // Whether images are accepted is the vendor's own `multimodal` flag,
      // the same one its IDE uses to enable the attach button. A missing flag
      // stays text-only: better to not send than to advertise a capability
      // that cannot be confirmed.
      images: entry.multimodal === true,
      // Only what the vendor stated. An entry with no
      // `reasoning_effort_config` declares no tiers, so it is not shown as a
      // reasoning model: advertising a selector whose value the upstream
      // ignores is worse than not offering one.
      reasoning: (entry.efforts?.length ?? 0) > 0,
      efforts: [...(entry.efforts ?? [])],
      toolCall: true,
      ...(entry.rate === undefined ? {} : { rate: entry.rate }),
      ...(entry.rateWas === undefined ? {} : { rateWas: entry.rateWas }),
    })
    if (entry.channel !== undefined) channels.set(entry.id, entry.channel)
  }
  return { models, channels }
}

/** The catalog shown when the account's own cannot be read. */
export function fallbackCatalog(): TraeCatalog {
  return { models: traeFallbackModels(), channels: new Map() }
}

/**
 * The channel a chat request for this model must use.
 *
 * It is read from the side table, not from a model entry: the host's
 * `ModelSpec` has no channel field, so the only place the channel survives a
 * catalog read is `TraeCatalog.channels`. A model with no entry (the fallback
 * table, or a model the account's catalog no longer lists) falls back to the
 * default channel — the one the upstream served before the multi-channel
 * endpoint existed.
 */
export function channelFor(catalog: TraeCatalog, model: string): string {
  const channel = catalog.channels.get(model)
  return channel !== undefined && channel.length > 0 ? channel : TRAE_FALLBACK_CHANNEL
}

/**
 * Read the account's catalog from the batch endpoint.
 *
 * The batch endpoint is the one the real client uses: it answers each
 * channel's list separately, which is what `api.ts` merges into one catalog
 * and what the channel table is built from. `undefined` means the read did
 * not work — as opposed to a catalog that is merely empty — so the caller
 * knows when to fall back (`core/catalog.ts`'s first two rules).
 */
export async function readCatalog(
  fetcher: Fetcher,
  credential: TraeCredential,
): Promise<TraeCatalog | undefined> {
  const headers = soloHeaders(credential, TRAE_CLIENT, false)
  headers["Content-Type"] = "application/json"
  const response = await fetcher(`${TRAE_AGENT_BASE}${TRAE_PATHS.batchModels}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      functions: [...TRAE_CHANNELS],
      show_custom_model: true,
      agent_type: "",
      current_config_info: { config_name: "", is_custom_model: false },
      mode_type: 0,
      access_type: 0,
      ab_force_vids: "",
      ab_autotest_advanced_mode: 0,
    }),
    signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) return undefined
  const body: unknown = await response.json().catch(() => undefined)
  const parsed = parseCatalogAnswer(body)
  return parsed === undefined ? undefined : modelsFrom(parsed)
}
