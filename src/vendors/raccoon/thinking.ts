/**
 * Raccoon's one working way to say "do not think".
 *
 * The service takes `extra_body.thinking.type` as `adaptive`, `enabled` or
 * `disabled`, and only that channel does anything: `{type: "disabled"}`
 * measured zero reasoning tokens in 6/6 and 8/8 samples, `{type: "enabled"}`
 * matched the default, and the shapes that look plausible but do nothing
 * include `extra_body.enable_thinking`, a doubly nested `extra_body`, and
 * `thinking` at the top level.
 *
 * `reasoning_effort` is the awkward one: the service accepts all eight of
 * magpie's levels and does not decide anything by them on its own (an
 * eight-round paired experiment found no effect on the reasoning the
 * service reported). A request that carries both would therefore be asking
 * two channels for two different things, so this patch takes the host's
 * effort, writes the vendor's boolean, and **removes** `reasoning_effort`
 * from the body — the host's word for a tier becomes the vendor's word for
 * on or off, and nothing else is sent.
 *
 * The mapping is by exception: only `none` means off. An agent that asked
 * for nothing sends no effort at all, and the request is left byte for byte
 * as it came — the service's default is thinking on, so the default is not
 * something this package needs to say.
 */

import { asObject, str } from "../../core/json.ts"
import type { JsonBodyPatch } from "../../core/request.ts"

export interface RaccoonThinking {
  thinking: { type: "enabled" | "disabled" }
}

/** The `extra_body` this effort asks for; undefined leaves the request alone. */
export function thinkingOf(effort: unknown): RaccoonThinking | undefined {
  const said = str(effort)
  if (said === undefined) return undefined
  return { thinking: { type: said === "none" ? "disabled" : "enabled" } }
}

/** The patch a chat request goes through (see `core/request.ts`). */
export const raccoonThinkingPatch: JsonBodyPatch = (body) => {
  const extra = thinkingOf(body.reasoning_effort)
  const carried = "reasoning_effort" in body
  if (extra === undefined && !carried) return undefined
  const { reasoning_effort: _dropped, ...rest } = body
  if (extra === undefined) return rest
  // An `extra_body` already on the request keeps whatever else it carried.
  return { ...rest, extra_body: { ...asObject(rest.extra_body), ...extra } }
}
