/**
 * OpenCode V2 entry point for TRAE.
 *
 * Trae is the one vendor here whose endpoint is not OpenAI-compatible: the
 * request has to be rebuilt into the SOLO shape and the answer has to be
 * rewritten from SOLO's private SSE back into OpenAI chunks. Neither can be
 * done with headers alone, so this entry uses the adapter's bridge: the host's
 * request hook rewrites the outgoing request, and its response hook rewrites
 * what comes back.
 *
 * The rewriting itself is the same code the Magpie entry runs
 * (`src/vendors/trae/wire.ts`) — that is why those functions take and return
 * plain `Request`/`Response` values.
 *
 * Two host facts are load-bearing, and neither is verified against a live
 * OpenCode yet (see `docs/vendors.md` §5):
 *
 * - the request/response hooks must let the plugin **replace** what they are
 *   handed, not merely observe it;
 * - the credential's `metadata` must survive a round trip through the
 *   integration store, because that is where the device fingerprints live.
 */

import type { Fetcher } from "../src/core/http.ts"
import { credentialOf, soloHeaders } from "../src/vendors/trae/api.ts"
import { loginMethods, refreshCredential } from "../src/vendors/trae/login.ts"
import { channelFor, fallbackCatalog, readCatalog, type TraeCatalog } from "../src/vendors/trae/models.ts"
import { TRAE_AGENT_BASE, TRAE_CLIENT, TRAE_ID, TRAE_NAME, TRAE_PATHS } from "../src/vendors/trae/product.ts"
import { bridgeResponse, toSoloBody } from "../src/vendors/trae/wire.ts"
import { type OpenCodeContext, type OpenCodeCredential, openCodePlugin } from "./adapter.ts"

/** The credential a bridge call works from, or undefined when it cannot be built. */
function credentialFor(credential: OpenCodeCredential) {
  return credentialOf({
    accessToken: credential.access,
    ...credential.metadata,
  })
}

/**
 * What a rewritten request tells the response hook.
 *
 * The two hooks are separate calls, so the response half has to know which
 * model was asked for and whether the host wanted one JSON answer. Both are
 * carried on the request object itself rather than in a module-level map
 * keyed by nothing: a host may run several sessions at once.
 */
const rewrites = new WeakMap<Request, { model: string; streamed: boolean }>()

export interface TraeEntryDeps {
  /** The network implementation; tests supply a fake, the host the real one. */
  fetcher: Fetcher
}

/**
 * The entry, built around one fetcher.
 *
 * A factory rather than a bare module so the fetcher is stated once and the
 * catalog below belongs to this entry alone — a module-level cache would be
 * shared by every host instance in one process.
 */
export function traeOpenCodeEntry(deps: TraeEntryDeps): {
  id: string
  setup(context: OpenCodeContext): Promise<void>
} {
  /**
   * The catalog the channel table comes from.
   *
   * A chat request needs to know which channel lists its model, and only the
   * catalog says. It is read once and re-read when a model it does not know
   * shows up — the same lazy read the Magpie entry does.
   */
  let catalog: TraeCatalog | undefined
  /**
   * Whether a read has succeeded. It is what stops a model the catalog does
   * not list from triggering a fresh read on every request.
   */
  let catalogLoaded = false

  const channelForModel = async (credential: OpenCodeCredential, model: string): Promise<string> => {
    if (!catalogLoaded && (catalog === undefined || !catalog.channels.has(model))) {
      const trae = credentialFor(credential)
      if (trae !== undefined) {
        const read = await readCatalog(deps.fetcher, trae).catch(() => undefined)
        if (read !== undefined) {
          catalog = read
          catalogLoaded = true
        }
      }
    }
    return channelFor(catalog ?? fallbackCatalog(), model)
  }

  return openCodePlugin({
    id: TRAE_ID,
    name: TRAE_NAME,
    baseURL: TRAE_AGENT_BASE,
    env: "TRAE_ACCESS_TOKEN",
    // A pasted token carries no device identity, and Trae's requests need one;
    // these name where the rest is read from when options do not carry it.
    credentialEnv: { uid: "TRAE_UID", machineId: "TRAE_MACHINE_ID", deviceId: "TRAE_DEVICE_ID" },
    models: fallbackCatalog().models,
    authMethods: (_options, client) => loginMethods({ client, fetcher: deps.fetcher }),

    /** The exchange rotates both tokens; the device identity stays put. */
    async refresh(credential) {
      const trae = credentialOf({
        accessToken: credential.access,
        refreshToken: credential.refresh,
        ...credential.metadata,
      })
      if (trae === undefined) throw new Error("TRAE 续期失败：登录态不完整，请重新登录")
      const next = await refreshCredential(trae, {
        client: { auth: { set: async () => undefined } },
        fetcher: fetch,
      })
      return {
        access: next.accessToken,
        refresh: next.refreshToken,
        expires: next.expiresAt ?? 0,
      }
    },

    bridge: {
      /**
       * Rebuild the host's chat request as a SOLO one.
       *
       * The URL is replaced rather than extended: the host appends
       * `/chat/completions` to the provider's base URL, and this vendor serves
       * chat at a different path on the same origin.
       */
      async request(request, credential) {
        const trae = credentialFor(credential)
        if (trae === undefined) return undefined
        const body = await readJson(request)
        if (body === undefined) return undefined
        const model = typeof body.model === "string" ? body.model : ""
        const channel = await channelForModel(credential, model)
        const note = { model, streamed: body.stream !== false }
        // Recorded against both requests on purpose: the response hook is
        // handed whichever of the two this host considers "the" request, and
        // guessing wrong costs the model id and turns a non-streaming request
        // into an event stream.
        rewrites.set(request, note)

        const headers = new Headers(request.headers)
        headers.delete("authorization")
        headers.delete("content-length")
        for (const [name, value] of Object.entries(soloHeaders(trae, TRAE_CLIENT, true)))
          headers.set(name, value)
        const rewritten = new Request(`${new URL(request.url).origin}${TRAE_PATHS.chat}`, {
          method: request.method,
          headers,
          body: JSON.stringify(toSoloBody(body, { model, channel })),
        })
        rewrites.set(rewritten, note)
        return rewritten
      },

      /**
       * Turn SOLO's event stream into the OpenAI one the host parses.
       *
       * A request that asked for a single answer is aggregated here, since the
       * upstream only ever streams.
       */
      async response(response, request) {
        const note = rewrites.get(request)
        return await bridgeResponse(response, {
          model: note?.model ?? "",
          streamed: note?.streamed ?? true,
        })
      },
    },
  })
}

export default traeOpenCodeEntry({ fetcher: fetch })

/** The host's JSON request body. */
async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  const text = await request.clone().text()
  if (text.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
