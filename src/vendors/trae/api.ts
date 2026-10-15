/**
 * Trae's HTTP dialect and wire parsing, as pure functions.
 *
 * Everything here takes its inputs and returns its outputs: no host, no
 * clock read unless one is passed in, and `createHash` from `node:crypto` is
 * the only side effect. That is what lets the tests drive each rule with a
 * fixture instead of a network, and what will let the OpenCode entry reuse
 * the same bytes when it is written.
 *
 * Facts and their provenance live in `product.ts`; this module only encodes
 * them. Where a rule is counter-intuitive the comment says why, because most
 * of them were found by JetHub tripping over the opposite assumption.
 */

import { createHash, randomUUID } from "node:crypto"
import { bool, isObject, num, str, trimmedStr } from "../../core/json.ts"
import { TRAE_CHANNELS } from "./product.ts"

// ── credential ────────────────────────────────────────────────────────────────

/**
 * A Trae account, as this package stores it.
 *
 * Field names are snake_case to match the host's `metadata` bag, which is
 * where an API-key-shaped sign-in keeps everything that is not the key
 * (`core/stored.ts`). The two device fields are the reason this vendor needs
 * its own session module: they are generated once at sign-in and must come
 * back unchanged forever after.
 */
export interface TraeCredential {
  accessToken: string
  /** Rotated by every exchange; the new value must be written back. */
  refreshToken: string
  /** Epoch milliseconds, or undefined when the token does not say. */
  expiresAt?: number
  uid: string
  nickname?: string
  /**
   * 32 hex characters. The upstream identifies the device by this, so
   * regenerating it can look like a new machine and invite a re-sign-in.
   */
  machineId: string
  /**
   * 32 hex characters, distinct per account. The check-in is limited per
   * device per day, so sharing one across accounts makes the second account
   * read as "this device already checked in" (`checkin.ts`).
   */
  deviceId: string
  enterpriseId?: string
}

/** Read a stored account defensively; undefined when it is not usable. */
export function credentialOf(source: Record<string, unknown> | undefined): TraeCredential | undefined {
  if (source === undefined) return undefined
  const accessToken = str(source.accessToken)
  const uid = str(source.uid)
  if (accessToken === undefined || uid === undefined) return undefined
  return {
    accessToken,
    refreshToken: str(source.refreshToken) ?? "",
    ...(num(source.expiresAt) === undefined ? {} : { expiresAt: num(source.expiresAt) as number }),
    uid,
    ...(str(source.nickname) === undefined ? {} : { nickname: str(source.nickname) as string }),
    machineId: str(source.machineId) ?? "",
    deviceId: str(source.deviceId) ?? "",
    ...(str(source.enterpriseId) === undefined ? {} : { enterpriseId: str(source.enterpriseId) as string }),
  }
}

/**
 * The parts of a credential that are **not** the session.
 *
 * This is what a hook merges back over the stored sign-in. The tokens are
 * deliberately absent: the host keeps those under its own names (`access`,
 * `refresh`, `expires`), and writing them a second time under this vendor's
 * names would create two records of the same secret that can drift apart.
 * What is here is what the host has no field for — the identity — and what
 * must survive a renewal untouched: the two device fingerprints.
 */
export function identityFields(credential: TraeCredential): Record<string, unknown> {
  return {
    uid: credential.uid,
    machineId: credential.machineId,
    deviceId: credential.deviceId,
    ...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
    ...(credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId }),
  }
}

/**
 * Read a JWT's `exp` claim without verifying it.
 *
 * The signature is not checkable here and does not need to be: the claim is
 * only used to schedule a renewal, and a wrong answer costs one extra request.
 */
export function jwtExpiresAtMs(token: string): number | undefined {
  const parts = token.split(".")
  if (parts.length < 2) return undefined
  const payload = parts[1]
  if (payload === undefined) return undefined
  try {
    const padded = payload.replaceAll("-", "+").replaceAll("_", "/")
    const decoded = Buffer.from(padded, "base64").toString("utf8")
    const parsed: unknown = JSON.parse(decoded)
    if (!isObject(parsed)) return undefined
    const exp = num(parsed.exp)
    return exp === undefined ? undefined : exp * 1000
  } catch {
    return undefined
  }
}

// ── request headers ──────────────────────────────────────────────────────────

/**
 * The headers a chat or catalog request carries.
 *
 * The access token is written three times on purpose: JetHub's own client
 * sends all three and dropping any one of them was observed to be refused.
 */
export function soloHeaders(
  credential: TraeCredential,
  product: TraeHeaderConstants,
  stream: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": product.userAgent,
    Authorization: `Cloud-IDE-JWT ${credential.accessToken}`,
    "X-Cloudide-Token": credential.accessToken,
    "X-Ide-Token": credential.accessToken,
    "X-Uid": credential.uid,
    "X-App-Id": product.appId,
    // The vendor's own client sends a literal `default` here; the flags that
    // gate model availability are the two version fields below.
    "X-App-Version": "default",
    "X-Ide-Version": product.ideVersion,
    "X-Ide-Version-Code": product.ideVersionCode,
    "X-App-Version-Code": product.ideVersionCode,
    "X-Ide-Version-Type": "stable",
    "X-Device-Type": "macos",
    "X-OS-Version": product.osVersion,
    "X-Device-Brand": product.deviceBrand,
    "Request-Traffic-Type": "prod",
  }
  if (credential.machineId.length > 0) headers["X-Machine-Id"] = credential.machineId
  if (credential.deviceId.length > 0) headers["X-Device-Id"] = credential.deviceId
  return headers
}

/** The product facts the header builders read; passed in to keep this module pure. */
export interface TraeHeaderConstants {
  appId: string
  ideVersion: string
  ideVersionCode: string
  deviceBrand: string
  osVersion: string
  userAgent: string
}

/**
 * The headers the check-in endpoints want.
 *
 * They are a **different, much longer** set than the chat ones. JetHub found
 * that the simplified set (the same one the credit endpoints take) was
 * refused, and that the version which actually claims is the ~20-header
 * client shape reproduced here.
 */
export function checkinHeaders(
  credential: TraeCredential,
  product: TraeHeaderConstants,
  requestId: string,
  traceId: string,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "zh-CN",
    "User-Agent": "VSCode 1.107.1 (TRAE SOLO CN)",
    Authorization: `Cloud-IDE-JWT ${credential.accessToken}`,
    "X-Market-Client-Id": "VSCode 1.107.1",
    "X-Market-User-Id": marketUserId(credential.uid),
    "X-User-Region": "CN",
    "X-Device-Id": deviceId15(credential.uid),
    "X-Lgw-Req-Sdk-Type": "3",
    "Package-Type": "stable_cn",
    "X-Lscbd-Aid": "787976",
    "X-Lscbd-Platform": "windows",
    "App-Version": product.ideVersion,
    "X-Tt-Trace-Id": traceId,
    "Vscode-Sessionid": sessionId(credential.uid),
    "X-Request-Id": requestId,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "none",
  }
}

// ── deterministic device identity ───────────────────────────────────────────

/**
 * SHA-256 in counter mode, so one seed always yields the same byte stream.
 *
 * This is how the check-in's device identity is derived from the account id
 * rather than stored: the same account keeps the same identity across
 * restarts and machines, and two accounts never collide. It also means the
 * plugin has nothing to persist for the check-in at all.
 */
function seededStream(seed: string, salt: string, length: number): number[] {
  const prefix = `${salt}:${seed}`
  const out: number[] = []
  let counter = 0
  while (out.length < length) {
    const header = new Uint8Array(4)
    header[0] = (counter >> 24) & 0xff
    header[1] = (counter >> 16) & 0xff
    header[2] = (counter >> 8) & 0xff
    header[3] = counter & 0xff
    const hash = createHash("sha256")
    hash.update(prefix, "utf8")
    hash.update(header)
    for (const byte of hash.digest()) {
      out.push(byte)
      if (out.length >= length) break
    }
    counter += 1
  }
  return out.slice(0, length)
}

/** A 15 digit string, stable per account. */
function deviceId15(uid: string): string {
  return seededStream(uid, "devid", 15)
    .map((byte) => (byte % 10).toString())
    .join("")
}

/** A UUID-v4-shaped id, stable per account. */
function marketUserId(uid: string): string {
  const bytes = seededStream(uid, "market", 16)
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 64 hex characters, stable per account. */
function sessionId(uid: string): string {
  return seededStream(uid, "sess", 32)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/** 32 hex characters; 16 random bytes as the vendor's client writes them. */
export function generateDeviceId(): string {
  return randomHex32()
}

/** Same shape as `generateDeviceId`; kept apart so the two never get swapped. */
export function generateMachineId(): string {
  return randomHex32()
}

function randomHex32(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

// ── auth response parsing ────────────────────────────────────────────────────

export interface TraeExchange {
  accessToken: string
  refreshToken: string
  tokenExpireAt: number
  tokenExpireDuration: number
}

/**
 * Read an `ExchangeToken` answer.
 *
 * The envelope is PascalCase (`{Result:{Token,...}}`) and JetHub also accepts
 * the camelCase spelling, because a proxy in front of the service was seen
 * rewriting it.
 */
export function parseExchange(data: unknown): TraeExchange | undefined {
  if (!isObject(data)) return undefined
  const result = isObject(data.Result) ? data.Result : isObject(data.result) ? data.result : undefined
  if (result === undefined) return undefined
  const accessToken = str(result.Token) ?? str(result.token) ?? str(result.accessToken)
  if (accessToken === undefined) return undefined
  return {
    accessToken,
    refreshToken: str(result.RefreshToken) ?? str(result.refreshToken) ?? "",
    tokenExpireAt: num(result.TokenExpireAt) ?? num(result.tokenExpireAt) ?? 0,
    tokenExpireDuration: num(result.TokenExpireDuration) ?? num(result.tokenExpireDuration) ?? 0,
  }
}

export interface TraeUserInfo {
  uid: string
  screenName: string
  enterpriseId: string
}

/** Read a `GetUserInfo` answer; undefined when it does not name a user. */
export function parseUserInfo(data: unknown): TraeUserInfo | undefined {
  if (!isObject(data)) return undefined
  const result = isObject(data.Result) ? data.Result : isObject(data.result) ? data.result : undefined
  if (result === undefined) return undefined
  const uid = str(result.UserID) ?? str(result.userId) ?? str(result.uid)
  if (uid === undefined) return undefined
  return {
    uid,
    screenName: str(result.ScreenName) ?? str(result.screenName) ?? uid,
    enterpriseId: str(result.EnterpriseID) ?? str(result.enterpriseId) ?? "",
  }
}

/**
 * Turn an exchange answer into an expiry, in epoch milliseconds.
 *
 * Three sources, in the order the vendor's own client reads them: an absolute
 * value (seconds or milliseconds, told apart by magnitude), a duration
 * relative to now, and the access token's own `exp`. An answer that states
 * nothing leaves the expiry unknown rather than inventing one.
 */
export function expiresAtOf(
  exchange: { tokenExpireAt: number; tokenExpireDuration: number; accessToken: string },
  now: number,
): number | undefined {
  if (exchange.tokenExpireAt > 1e12) return Math.trunc(exchange.tokenExpireAt)
  if (exchange.tokenExpireAt > 0) return Math.trunc(exchange.tokenExpireAt * 1000)
  if (exchange.tokenExpireDuration > 0) return now + Math.trunc(exchange.tokenExpireDuration * 1000)
  return jwtExpiresAtMs(exchange.accessToken)
}

/**
 * The credential a finished exchange plus identity describes.
 *
 * The device fields are passed in rather than minted here: they were created
 * once when the sign-in started and are already on their way into the
 * account, and a renewal must carry the old ones through untouched.
 */
export function buildCredential(
  exchange: TraeExchange,
  userInfo: TraeUserInfo,
  device: { machineId: string; deviceId: string },
  now: number,
): TraeCredential {
  const expiresAt = expiresAtOf(exchange, now)
  return {
    accessToken: exchange.accessToken,
    refreshToken: exchange.refreshToken,
    uid: userInfo.uid,
    machineId: device.machineId,
    deviceId: device.deviceId,
    ...(userInfo.screenName.length === 0 ? {} : { nickname: userInfo.screenName }),
    ...(userInfo.enterpriseId.length === 0 ? {} : { enterpriseId: userInfo.enterpriseId }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

/**
 * The credential a renewal answers.
 *
 * The exchange rotates the refresh token, so the new one replaces the old
 * **only when it is non-empty**; an answer that omits it (some proxies strip
 * it) must not turn a renewable account into a dead one. The device fields
 * and the identity are carried through unchanged, which is the whole point of
 * keeping them on the account rather than regenerating them.
 */
export function applyRefresh(previous: TraeCredential, exchange: TraeExchange, now: number): TraeCredential {
  const expiresAt = expiresAtOf(exchange, now)
  return {
    ...previous,
    accessToken: exchange.accessToken,
    refreshToken: exchange.refreshToken.length > 0 ? exchange.refreshToken : previous.refreshToken,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

// ── catalog parsing ──────────────────────────────────────────────────────────

export interface TraeRemoteModel {
  id: string
  name: string
  /** The channel that listed it; replayed on the chat request. */
  channel?: string
  contextWindow?: number
  maxOutputTokens?: number
  /**
   * `display_config.is_custom_model`: a model the user has to bind to a real
   * supplier inside the IDE before it works. JetHub measured 5/5 of these
   * being refused in-stream with `4001`, so they are filtered out rather than
   * offered and then failing.
   *
   * The flag is the criterion, **not the model name** — the same names later
   * came back with the flag cleared and were perfectly callable, and a list
   * of names frozen into code would have deleted working models.
   */
  isCustomModel?: boolean
  /** `is_invisible_to_user`: the official picker hides it. */
  isHidden?: boolean
  /** `config_switch`: the upstream has turned it off. */
  isEnabled?: boolean
  /** What the entry is for; only `chat_completion` belongs in a chat picker. */
  usage?: string
  multimodal?: boolean
  /** Reasoning tiers as the vendor names them, in its own order. */
  efforts?: string[]
  /** Credits one request costs, as a multiple. */
  rate?: number
  /** What it cost before the running discount, when one is active. */
  rateWas?: number
}

/**
 * Parse one `config_info_list` entry.
 *
 * Absent flags stay absent rather than becoming `false`: the filters only
 * reject an explicit "no", so a field the upstream stops sending cannot
 * silently empty the catalog.
 */
function parseConfigEntry(
  entry: Record<string, unknown>,
  channel: string | undefined,
): TraeRemoteModel | undefined {
  const id = str(entry.config_name) ?? str(entry.ConfigName)
  if (id === undefined) return undefined
  const display = isObject(entry.display_config) ? entry.display_config : undefined
  const name = display === undefined ? undefined : str(display.display_name)
  const isCustomModel = display === undefined ? undefined : bool(display.is_custom_model)
  const isHidden = bool(entry.is_invisible_to_user)
  const isEnabled = bool(entry.config_switch)
  const usage = str(entry.usage) ?? str(entry.Usage)
  const contextWindow = readContextWindow(entry)
  const maxOutputTokens = readDetailMaxTokens(entry)
  const multimodal = display === undefined ? undefined : bool(display.multimodal)
  const efforts = readEfforts(entry)
  const rate = readConsumptionRate(entry)
  const rateWas = readDiscountRate(entry)
  return {
    id,
    name: name ?? id,
    ...(channel === undefined ? {} : { channel }),
    ...(isCustomModel === undefined ? {} : { isCustomModel }),
    ...(isHidden === undefined ? {} : { isHidden }),
    ...(isEnabled === undefined ? {} : { isEnabled }),
    ...(usage === undefined ? {} : { usage }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(multimodal === undefined ? {} : { multimodal }),
    ...(efforts === undefined ? {} : { efforts }),
    ...(rate === undefined ? {} : { rate }),
    ...(rateWas === undefined ? {} : { rateWas }),
  }
}

/**
 * `context_window_tokens.dev` — the window a normal request gets.
 *
 * `max` is deliberately only a last resort: it is the 1M window that
 * requires the Max mode switch, and trusting it would promise the host a
 * context the upstream refuses.
 */
function readContextWindow(entry: Record<string, unknown>): number | undefined {
  const raw = entry.context_window_tokens
  if (!isObject(raw)) return undefined
  const value = num(raw.dev) ?? num(raw.max)
  return value === undefined || value <= 0 ? undefined : Math.trunc(value)
}

/**
 * `model_detail_list[].max_tokens`, preferring the `__dev` row.
 *
 * A model can list several rows (a normal one and a `__max` one); without the
 * suffix preference the first row wins, which is not always the regular one.
 */
function readDetailMaxTokens(entry: Record<string, unknown>): number | undefined {
  const raw = entry.model_detail_list
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const details = raw.filter(isObject)
  const preferred = details.find((item) => (str(item.model_name) ?? "").endsWith("__dev"))
  const chosen = preferred ?? details[0]
  if (chosen === undefined) return undefined
  const value = num(chosen.max_tokens)
  return value === undefined || value <= 0 ? undefined : Math.trunc(value)
}

/**
 * `reasoning_effort_config.options` — the tiers this model accepts.
 *
 * An entry with a config but no options declares nothing usable, so it is
 * reported as having no tiers at all; that keeps the model picker from
 * offering a selector whose value the upstream ignores.
 */
function readEfforts(entry: Record<string, unknown>): string[] | undefined {
  const raw = entry.reasoning_effort_config
  if (!isObject(raw)) return undefined
  if (bool(raw.support_thinking) === false) return undefined
  const options = raw.options
  if (!Array.isArray(options)) return undefined
  const out: string[] = []
  for (const item of options) {
    const level = typeof item === "string" ? trimmedStr(item) : readLevelOf(item)
    if (level === undefined || out.includes(level)) continue
    out.push(level)
  }
  return out.length === 0 ? undefined : out
}

/** An option written as an object rather than a bare string. */
function readLevelOf(item: unknown): string | undefined {
  if (!isObject(item)) return undefined
  return trimmedStr(item.openclawLevel) ?? trimmedStr(item.level)
}

/**
 * The credit multiple from `display_contact_config`.
 *
 * That field is a **JSON string**, not an object, so reading it as a nested
 * property always yields nothing. `rate: 0` is a real value (a free model),
 * which is why the check is `>= 0` and not `> 0`.
 */
function readConsumptionRate(entry: Record<string, unknown>): number | undefined {
  const config = parseJsonObject(entry.display_contact_config)
  if (config === undefined) return undefined
  const rate = config.consumption_rate
  if (!isObject(rate)) return undefined
  if (bool(rate.enable) === false) return undefined
  const data = isObject(rate.data) ? rate.data : undefined
  if (data === undefined) return undefined
  const value = num(data.rate)
  return value === undefined || value < 0 ? undefined : value
}

/**
 * The pre-discount multiple, but only while a discount is genuinely running.
 *
 * `enable: true` is not enough: the `off_peak` shape carries
 * `{discount_type:"none", before:0.13, after:0.13}`, which would render as
 * "x0.13 → x0.13" and tell the user there is a sale when there is not. A
 * discount counts only when the type is named, the before-price is positive,
 * it is strictly higher than the current one, and it has not expired.
 */
function readDiscountRate(
  entry: Record<string, unknown>,
  nowSec: number = Math.floor(Date.now() / 1000),
): number | undefined {
  const config = parseJsonObject(entry.display_contact_config)
  if (config === undefined) return undefined
  const discount = config.activity_discount
  if (!isObject(discount)) return undefined
  if (bool(discount.enable) === false) return undefined
  const data = isObject(discount.data) ? discount.data : undefined
  const current = data === undefined ? undefined : isObject(data.current) ? data.current : undefined
  if (current === undefined) return undefined
  const type = (str(current.discount_type) ?? "").trim().toLowerCase()
  if (type.length === 0 || type === "none") return undefined
  const before = num(current.before_consumption_rate)
  const after = num(current.consumption_rate)
  if (before === undefined || before <= 0) return undefined
  if (after !== undefined && before <= after) return undefined
  const endsAt = data === undefined ? undefined : findEndAt(data)
  if (endsAt !== undefined && endsAt <= nowSec) return undefined
  return before
}

/** The first `end_at` on any child object of `data`; the shape varies by activity type. */
function findEndAt(data: Record<string, unknown>): number | undefined {
  for (const value of Object.values(data)) {
    if (!isObject(value)) continue
    const end = num(value.end_at) ?? num(value.endAt)
    if (end !== undefined && end > 0) return end
  }
  return undefined
}

function parseJsonObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse the batch catalog, one entry per model.
 *
 * The batch endpoint answers with the catalog of **each channel separately**
 * (`function_configs[]`), and the same model can appear in several of them
 * with different completeness. Three filters run here, and they are the same
 * three the vendor's own picker applies: the entry has to be a chat entry,
 * enabled, and visible to the user. A hidden entry is a real model that the
 * official picker does not show (an internal sub-agent, a title generator),
 * so leaving it in would fill the picker with machinery.
 *
 * When a model appears twice, the more informative entry wins: one that can
 * name reasoning tiers beats one that cannot, and between two that can, the
 * channel order in `product.ts` decides. JetHub's original "last one wins"
 * was the opposite of what the data looked like — the upstream puts its
 * emptiest entries last — and cost 13 models their reasoning selector.
 */
export function parseBatchCatalog(
  body: unknown,
  channelPriority: readonly string[] = TRAE_CHANNELS,
): TraeRemoteModel[] {
  if (!isObject(body)) return []
  const groups = body.function_configs
  if (!Array.isArray(groups)) return []

  const rankOf = (channel: string | undefined): number => {
    if (channel === undefined) return Number.MAX_SAFE_INTEGER
    const index = channelPriority.indexOf(channel)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }

  const chosen = new CatalogMerge(rankOf)
  for (const group of groups) {
    if (!isObject(group)) continue
    const channel = str(group.function)
    const list = group.config_info_list
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (!isObject(item)) continue
      chosen.offer(parseConfigEntry(item, channel))
    }
  }
  return chosen.values()
}

/**
 * The pick-one-per-model rule, kept apart from the walk over the response so
 * neither half has to be read through the other.
 *
 * Filters first (a chat entry, enabled, user-visible — the three the vendor's
 * own picker applies), then the choice between two entries for one model: an
 * entry that can name reasoning tiers beats one that cannot, and between two
 * that can, the lower channel rank wins. The `Number.MAX_SAFE_INTEGER` cases
 * mean "this channel is not in the priority list", and there the original
 * last-one-wins behaviour is kept rather than inventing an order.
 */
class CatalogMerge {
  private readonly byId = new Map<string, TraeRemoteModel>()
  private readonly ranks = new Map<string, number>()

  constructor(private readonly rankOf: (channel: string | undefined) => number) {}

  offer(model: TraeRemoteModel | undefined): void {
    if (model === undefined) return
    if (model.usage !== undefined && model.usage !== "chat_completion") return
    if (model.isEnabled === false) return
    if (model.isHidden === true) return
    const incumbent = this.byId.get(model.id)
    if (incumbent !== undefined && !this.replaces(incumbent, model)) return
    this.byId.set(model.id, model)
    this.ranks.set(model.id, this.rankOf(model.channel))
  }

  values(): TraeRemoteModel[] {
    return [...this.byId.values()]
  }

  /** Whether the candidate is the better entry for the same model. */
  private replaces(incumbent: TraeRemoteModel, candidate: TraeRemoteModel): boolean {
    const incumbentHasEfforts = (incumbent.efforts?.length ?? 0) > 0
    const candidateHasEfforts = (candidate.efforts?.length ?? 0) > 0
    if (incumbentHasEfforts && !candidateHasEfforts) return false
    if (!incumbentHasEfforts || !candidateHasEfforts) return true
    const current = this.ranks.get(incumbent.id) ?? Number.MAX_SAFE_INTEGER
    if (current === Number.MAX_SAFE_INTEGER) return true
    return this.rankOf(candidate.channel) < current
  }
}

/**
 * The per-request ids the check-in and credit endpoints expect.
 *
 * Each call carries a fresh `X-Request-Id` and a fresh trace id, the way the
 * vendor's own client does; reusing one across calls was not observed to be
 * refused, but it would make the service see a single request where the user
 * made several.
 */
export function requestIds(): { requestId: string; traceId: string } {
  return { requestId: randomUUID(), traceId: `00-${randomHex32()}-01` }
}

/**
 * Parse the catalog from the batch endpoint's answer.
 *
 * Returns `undefined` — not an empty list — when the answer is not a catalog
 * at all, so the caller can tell "the account serves nothing this package
 * knows" from "the read did not work" and fall back only for the latter.
 */
export function parseCatalogAnswer(body: unknown): TraeRemoteModel[] | undefined {
  if (!isObject(body)) return undefined
  const groups = body.function_configs
  if (!Array.isArray(groups)) return undefined
  return parseBatchCatalog(body)
}

// ── SOLO SSE → OpenAI SSE ────────────────────────────────────────────────────

export interface TraeEvent {
  event: string
  content?: string
  reasoning?: string
  toolCalls?: unknown[]
  usage?: Record<string, unknown>
  finishReason?: string
  errorCode?: number
  errorMessage?: string
}

/**
 * One SOLO event.
 *
 * The body text arrives in `output.response`, thinking in
 * `output.reasoning_content`, and tool calls inside the same `output` event —
 * note that their function is spelled `function_call` here while OpenAI
 * spells it `function`, and they carry two SOLO-only keys (`namespace`,
 * `partial_arguments`) that have to go.
 */
export function parseEvent(eventName: string, data: string): TraeEvent | undefined {
  const event = eventName.trim()
  if (data.length === 0) return { event }
  let raw: unknown
  try {
    raw = JSON.parse(data)
  } catch {
    return { event }
  }
  if (!isObject(raw)) return { event }
  const parsed: TraeEvent = { event }
  switch (event) {
    case "output": {
      const response = str(raw.response)
      if (response !== undefined) parsed.content = response
      const reasoning = str(raw.reasoning_content)
      if (reasoning !== undefined) parsed.reasoning = reasoning
      if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
        parsed.toolCalls = raw.tool_calls.map(normalizeToolCall)
      }
      return parsed
    }
    case "token_usage":
      parsed.usage = raw
      return parsed
    case "done": {
      const reason = str(raw.finish_reason)
      if (reason !== undefined) parsed.finishReason = reason
      return parsed
    }
    case "error": {
      const code = num(raw.code)
      if (code !== undefined) parsed.errorCode = code
      const message = str(raw.message)
      if (message !== undefined) parsed.errorMessage = message
      return parsed
    }
    default:
      return parsed
  }
}

/** SOLO's tool-call field names into OpenAI's, with the SOLO-only keys dropped. */
function normalizeToolCall(call: unknown): unknown {
  if (!isObject(call)) return call
  const out: Record<string, unknown> = { ...call }
  if (isObject(out.function_call)) {
    const fn = { ...out.function_call }
    delete fn.namespace
    delete fn.partial_arguments
    out.function = fn
    delete out.function_call
  }
  return out
}

/**
 * Split an SSE buffer into complete events.
 *
 * Returns the events that were complete and whatever tail is still waiting,
 * so the caller can keep reading a stream that splits events at any byte.
 * Both `event:` and `data:` accept the vendor's spacing — the data line
 * arrives as `data:{...}` with no space, which a naive split misses.
 */
export function takeEvents(buffer: string): { events: TraeEvent[]; rest: string } {
  const events: TraeEvent[] = []
  let rest = buffer
  for (;;) {
    const boundary = rest.indexOf("\n\n")
    if (boundary < 0) break
    const block = rest.slice(0, boundary)
    rest = rest.slice(boundary + 2)
    const parsed = parseBlock(block)
    if (parsed !== undefined) events.push(parsed)
  }
  return { events, rest }
}

function parseBlock(block: string): TraeEvent | undefined {
  let eventName = ""
  const dataLines: string[] = []
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd()
    if (line.length === 0) continue
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim()
      continue
    }
    if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart())
  }
  if (eventName.length === 0 && dataLines.length === 0) return undefined
  return parseEvent(eventName, dataLines.join("\n"))
}

/**
 * One OpenAI chunk carrying `delta`.
 *
 * `id` is the caller's, so a single response keeps one id across its chunks
 * the way a real OpenAI stream does.
 */
export function openAiChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason?: string,
  usage?: Record<string, unknown>,
): string {
  const choice: Record<string, unknown> = { index: 0, delta }
  if (finishReason !== undefined) choice.finish_reason = finishReason
  const chunk: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [choice],
  }
  if (usage !== undefined) chunk.usage = usage
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/** The end of an OpenAI stream. */
export const OPENAI_DONE = "data: [DONE]\n\n"
