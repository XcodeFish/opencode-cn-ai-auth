/**
 * Trae (ByteDance) product facts, in one place.
 *
 * Everything here was read out of JetHub's Trae implementation
 * (`src/trae.ts` / `src/trae-product.ts` at JetHub 0.4.2, MIT), which in turn
 * reverse-engineered the SOLO channel from `trae2api` (Go) and `trae-mate`.
 * `docs/vendors.md` records which value came from where and which of them are
 * unverified.
 *
 * Trae is **not** an OpenAI-compatible provider, unlike the other two vendors
 * in this package. Three things differ and each of them is why this vendor has
 * modules the others do not:
 *
 * - **The chat body is transformed, never passed through.** The SOLO endpoint
 *   wants `function` (the "channel"), `config_name`, and a different message
 *   and tool shape (`wire.ts`).
 * - **The answer is a private SSE event stream**, not OpenAI chunks, so it is
 *   rewritten on the way back (`wire.ts`).
 * - **Credentials carry device fingerprints** (`machine_id` / `device_id`)
 *   that must survive renewal unchanged (`api.ts`).
 *
 * This first version ships the **domestic (CN) client only**. JetHub also
 * carries an international one (`trae-intl`, different hosts and client id);
 * it is deliberately left out until someone can check it against the live
 * service, because its check-in path was never verified.
 */

import type { ModelSpec } from "../../core/models.ts"
import type { TraeHeaderConstants } from "./api.ts"

/**
 * The provider's id, and why it is `trae-cn` rather than `trae`.
 *
 * magpie keeps a sign-in under the **provider id** — `plugin-auth.json` holds
 * `trae-cn`, then `trae-cn#<slot>` for a second account — and a provider is
 * served by whichever installed plugin declares that id (magpie's
 * `plugin use <name> <provider>`, kept as `prefer` in `plugins.json`). So the
 * id is the whole of "已有登录直接可用": declare the id the other Trae plugin
 * signs in to and its accounts are already there, with nothing copied.
 *
 * The community package `@magpie-community/opencode-trae-auth` signs in to
 * Trae CN as `trae-cn` (and Trae international as `trae-global`) and keeps the
 * same field set this vendor reads — `access` / `refresh` / `expires` /
 * `accountId` / `uid` / `deviceId` / `machineId` — so an account it created
 * works here unchanged, device fingerprint included. magpie proves the same
 * mechanic with its own `plugin move` (the built-in `zcode` and `workbuddy`
 * subscriptions became community plugins with their accounts still under
 * those ids). See `docs/vendors.md` §4.
 */
export const TRAE_ID = "trae-cn"
export const TRAE_NAME = "TRAE (字节)"

/**
 * The provider's picture, as magpie takes it: an `https` URL of a picture on
 * a public host. This is the one the product's own page declares
 * (`<link rel="icon" href="…favicon.png">`, read on 2026-10-16) — a 48x48 PNG,
 * 488 bytes, well inside the host's 1 MB limit. It is the only mark the vendor
 * publishes at a fetchable URL, and the vendor's picture is used rather than a
 * copy committed here: it stays current on its own, and a URL that stops
 * resolving costs nothing but the icon.
 */
export const TRAE_ICON = "https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae_website_prod_cn/favicon.png"

/**
 * Where a chat request goes: the agent service, which speaks the private SOLO
 * protocol rather than `/chat/completions`. The host appends its own
 * `/chat/completions` to `baseURL`; `bridge.ts` rewrites the path, so the
 * value only has to be a URL the host will accept.
 */
export const TRAE_AGENT_BASE = "https://trae-api-cn.mchost.guru"

/** The site host: credits, check-in status and claim. */
export const TRAE_UG_BASE = "https://api.trae.cn"

/** The auth host: `ExchangeToken` and `GetUserInfo`. */
export const TRAE_OAUTH_BASE = "https://api.trae.com.cn"

/** The console the user signs in on; the browser is sent here. */
export const TRAE_CONSOLE_BASE = "https://www.trae.cn"

/** Paths, one each, as the vendor's own client calls them. */
export const TRAE_PATHS = {
  /** Chat, private SOLO SSE. */
  chat: "/api/agent/v3/llm_utils_chat",
  /** Model catalog for one channel. */
  models: "/api/ide/v1/get_detail_param",
  /** Model catalog for several channels at once; the real client uses this. */
  batchModels: "/api/ide/v1/batch_get_detail_param",
  /** refresh token → access token (rotating). The legacy flow. */
  exchange: "/cloudide/api/v3/trae/oauth/ExchangeToken",
  /**
   * authorization code + PKCE verifier → access token. This is the flow the
   * current client uses (measured from its bundle, 2026-10-16), and it lives
   * at a different path from the legacy one.
   */
  exchangeByCode: "/trae/api/v3/oauth/ExchangeToken",
  /** Account identity after the exchange. */
  userInfo: "/cloudide/api/v3/trae/GetUserInfo",
  /** Is today's check-in already taken? */
  checkinStatus: "/trae/api/v2/ug/checkin_credits/status",
  /** Take today's check-in. */
  checkinClaim: "/trae/api/v2/ug/checkin_credits/claim",
  /** Credit packs and what has been spent from them. */
  entitlementUsage: "/trae/api/v2/pay/ide_user_ent_usage",
} as const

/**
 * The chat "channels" (`function`) the catalog is read from, **in priority
 * order**.
 *
 * A model is only callable in a channel that lists it; sending it through
 * another one is answered in-stream with `4001 param is invalid` (measured by
 * JetHub on 2026-09-19, model by channel). So the channel each model came
 * from is carried along with it and replayed on the request.
 *
 * Order matters for a second reason: the same model can appear in several
 * channels with different completeness, and the merge in `catalog.ts` prefers
 * the earlier one when both declare reasoning tiers.
 */
export const TRAE_CHANNELS: readonly string[] = ["solo_agent", "solo_work_lite", "solo_agent_remote"]

/** The channel used when a model came from no catalog at all (the fallback). */
export const TRAE_FALLBACK_CHANNEL = "solo_work_lite"

/** The model a request names when the host somehow sent none. */
export const TRAE_FALLBACK_MODEL = "glm-5.2"

/**
 * Client identity, as the vendor's own build declares it.
 *
 * `ideVersion` / `ideVersionCode` are not decoration: the upstream decides
 * which models it will serve from them, and an older pair is answered with
 * `4001`.
 */
export const TRAE_CLIENT_ID = "en1oxy7wnw8j9n"
export const TRAE_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8"
export const TRAE_IDE_VERSION = "0.1.52"
export const TRAE_IDE_VERSION_CODE = "20260811"

/**
 * The versions the **current** Trae CN client reports, read from its own
 * bundle on 2026-10-16 (`/Applications/Trae CN.app`, `product.json`):
 * `appVersion` 3.4.2 and `tronBuildVersion` 2.3.91092.
 *
 * They are sent as `x_app_version` and `plugin_version`. JetHub's values
 * (`0.1.52` plugin version, `2.3.62834`) came from an older build and are the
 * reason the console no longer recognises the sign-in this package used to
 * start; the console itself only logs them, but the vendor's client is the
 * only ground truth for what a client should look like.
 */
export const TRAE_APP_VERSION = "3.4.2"
export const TRAE_DEVICE_BRAND = "Apple"
export const TRAE_OS_VERSION = "macOS 15.7.4"
export const TRAE_USER_AGENT = `Trae/${TRAE_IDE_VERSION}`
export const TRAE_PLUGIN_VERSION = "2.3.91092"

/**
 * The client facts a request is stamped with, in the shape the header
 * builders take (`api.ts`). Gathered here so there is exactly one place that
 * spells the client identity, and the builders stay testable with a fixture.
 */
export const TRAE_CLIENT: TraeHeaderConstants = {
  appId: TRAE_APP_ID,
  ideVersion: TRAE_IDE_VERSION,
  ideVersionCode: TRAE_IDE_VERSION_CODE,
  deviceBrand: TRAE_DEVICE_BRAND,
  osVersion: TRAE_OS_VERSION,
  userAgent: TRAE_USER_AGENT,
}

/** Control-plane requests (exchange, catalog, credits). Chat streams are exempt. */
export const TRAE_REQUEST_TIMEOUT_MS = 30_000

/** How long a sign-in may take before the plugin gives up on it. */
export const TRAE_SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000

/** The sign-in callback path, as the vendor's client registers it. */
export const TRAE_CALLBACK_PATH = "/authorize"

/**
 * Business code for "today's check-in already exists" and for "the check-in
 * pool is momentarily empty".
 *
 * JetHub records `9074` as **both** — measured against `trae-mate`, whose
 * claim answers `{"code":9074,"message":"当前使用人数太多"}` — and reports it
 * as a failure with a retry hint rather than dressing it up as a success.
 */
export const TRAE_CHECKIN_BUSY_CODE = 9074

/**
 * How long before the access token lapses the host should renew it.
 *
 * The exchange rotates both tokens, so renewal is cheap and worth doing
 * early; five minutes mirrors what the other vendors' refresh windows do.
 */
export const TRAE_REFRESH_LEAD_MS = 5 * 60 * 1000

/**
 * The catalog shown when the account's own catalog cannot be read.
 *
 * Source: JetHub's `TRAE_FALLBACK_MODELS` (`handler.go`'s `staticModels`,
 * a 2026-08 snapshot), with the entries JetHub marks `isHidden` dropped —
 * those are internal (`summary`, `explore_sub_agent_*`, `browser_use_subagent`)
 * and have no business appearing in a user's model picker. The list is
 * **marked as a fallback** by `core/catalog.ts`, so the host says on screen
 * that it is not the account's own list.
 *
 * The remote catalog is authoritative whenever it answers; this is only what
 * is left when it does not.
 */
const TRAE_FALLBACK_MODELS: readonly ModelSpec[] = [
  { id: "DeepSeek-V4-Flash-Official", name: "DeepSeek V4 Flash Official", context: 200_000, output: 32_000 },
  { id: "Doubao-Seed-2.1-Pro", name: "Doubao Seed 2.1 Pro", context: 200_000, output: 32_000 },
  { id: "seed-code-pro-0430", name: "Seed Code Pro 0430", context: 200_000, output: 32_000 },
  { id: "Doubao-Seed-2.1-Turbo", name: "Doubao Seed 2.1 Turbo", context: 200_000, output: 32_000 },
  { id: "Doubao-Seed-2.0-Code", name: "Doubao Seed 2.0 Code", context: 200_000, output: 32_000 },
  { id: "glm-5.2", name: "GLM-5.2", context: 200_000, output: 32_000 },
  { id: "glm-5-turbo", name: "GLM-5 Turbo", context: 200_000, output: 32_000 },
  { id: "glm-5", name: "GLM-5", context: 200_000, output: 32_000 },
  { id: "DeepSeek-V4-Pro", name: "DeepSeek V4 Pro", context: 200_000, output: 32_000 },
  { id: "DeepSeek-V4-Flash", name: "DeepSeek V4 Flash", context: 200_000, output: 32_000 },
  { id: "kimi-k3", name: "Kimi K3", context: 200_000, output: 32_000 },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", context: 200_000, output: 32_000 },
  { id: "kimi-k2.6", name: "Kimi K2.6", context: 200_000, output: 32_000 },
  { id: "minimax-m3", name: "MiniMax M3", context: 200_000, output: 32_000 },
  { id: "qwen-3.7-plus", name: "Qwen 3.7 Plus", context: 200_000, output: 32_000 },
  { id: "sagitta", name: "Sagitta", context: 200_000, output: 32_000 },
  { id: "aquila", name: "Aquila", context: 200_000, output: 32_000 },
]

/** The fallback catalog, in the vendor's own order. */
export function traeFallbackModels(): ModelSpec[] {
  return TRAE_FALLBACK_MODELS.map((spec) => ({ ...spec }))
}

/**
 * The highest `max_tokens` the fallback rows declare.
 *
 * JetHub measured the main models at 32000 on the live service (2026-09-19)
 * and recorded that older values of 131072 / 128000 were estimates that had
 * been disproved; the remote catalog overrides this whenever it answers.
 */
export const TRAE_FALLBACK_MAX_OUTPUT_TOKENS = 32_000

/**
 * The largest `max_tokens` a request may ask for.
 *
 * JetHub found that a client asking for 131072 was answered with a 4xx, and
 * clamped outgoing requests to a safe line; this is that line. It sits above
 * every output limit the catalog declares, so it only ever trims a value the
 * host made up rather than one the model promised.
 */
export const TRAE_MAX_COMPLETION_TOKENS = 64_000

/**
 * A cap on how much conversation history is sent, in characters.
 *
 * JetHub measures the upstream cutting a request off silently at roughly
 * 480K characters of flattened history; this stays under it. Trimming is
 * done in whole rounds and never drops a system message (`wire.ts`).
 */
export const TRAE_MAX_HISTORY_CHARS = 480_000
