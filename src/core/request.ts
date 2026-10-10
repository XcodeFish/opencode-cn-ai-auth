/**
 * Rewriting the requests the host hands a loader's `fetch`.
 *
 * A vendor whose wire dialect differs from the host's states that difference
 * here rather than asking the host for a hook of its own: magpie builds the
 * chat request from the agent's own words, hands it to the `fetch` the
 * loader returned, and this wrapper is the last place a vendor can turn that
 * body into what its API reads (Raccoon's `extra_body.thinking`, which is
 * its only working way to say "don't think").
 *
 * The body arrives as the string magpie serialized — bytes only when it was
 * not text — so a patch is written against the parsed object. A request the
 * patch leaves alone goes upstream byte for byte: a re-serialization would
 * change key order and spacing, and with them an upstream cache's view of
 * the prompt.
 */

import type { Fetcher } from "./http.ts"
import { asObject } from "./json.ts"

export type JsonBodyPatch = (body: Record<string, unknown>) => Record<string, unknown> | undefined

type FetchInput = Parameters<Fetcher>[0]
type FetchInit = NonNullable<Parameters<Fetcher>[1]>

/** The text of a request body; undefined when there is none or it is not text. */
function bodyText(body: FetchInit["body"]): string | undefined {
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(body)
    } catch {
      return undefined
    }
  }
  if (body instanceof ArrayBuffer) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(body))
    } catch {
      return undefined
    }
  }
  return undefined
}

function patched(init: FetchInit | undefined, patch: JsonBodyPatch): FetchInit | undefined {
  const text = init === undefined ? undefined : bodyText(init.body)
  if (text === undefined || text.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const record = asObject(parsed)
  if (record === undefined) return undefined
  const next = patch(record)
  if (next === undefined) return undefined
  const headers = new Headers(init?.headers)
  // The length of the body that goes out is the serializer's to state, and
  // the one the host wrote describes the body we are replacing.
  headers.delete("content-length")
  return { ...init, headers, body: JSON.stringify(next) }
}

/**
 * A `fetch` that lets `patch` rewrite each JSON request body before it goes
 * out. Returning undefined from the patch keeps the request as it came.
 */
export function patchingJsonBody(fetcher: Fetcher, patch: JsonBodyPatch): Fetcher {
  const wrapped = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const next = patched(init, patch)
    return next === undefined ? fetcher(input, init) : fetcher(input, next)
  }
  return wrapped as Fetcher
}
