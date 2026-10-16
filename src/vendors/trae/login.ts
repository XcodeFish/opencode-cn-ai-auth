/**
 * Trae's one way in: the browser, with the answer handed back over loopback.
 *
 * The console takes the callback URL **from us**, as part of the sign-in URL,
 * and redirects there when the user is done. So the flow is: mint a device
 * identity, start a one-shot page on loopback, build a sign-in URL that names
 * that page, and let the browser do the rest. What comes back on that URL is
 * not an OAuth code — it is the refresh token itself, beside the user in two
 * JSON parameters.
 *
 * Three details were each a defect in an earlier implementation, and each
 * presents as the same two symptoms — the browser sitting on "authorizing"
 * forever, or a legal callback reported as invalid. They are called out where
 * they are handled: the callback parameter is `auth_callback_url` (not
 * `callback_url`), the callback carries a token rather than a code, and the
 * console has a second, PKCE-shaped flow this package does not implement and
 * must not misreport.
 */

import { errorMessage, VendorError } from "../../core/errors.ts"
import { type Fetcher, httpJson } from "../../core/http.ts"
import { asObject, str } from "../../core/json.ts"
import { HTML, notFound, type PageResponse, PageServer } from "../../core/local-page.ts"
import { type VendorLogger, vendorLogger } from "../../core/log.ts"
import { renderLoginPage } from "../../core/login-page.ts"
import type { AuthMethod, PluginClient, SignInResult } from "../../core/types.ts"
import { createSettlement, type Settlement } from "../../core/util.ts"
import {
  applyRefresh,
  buildCredential,
  generateDeviceId,
  generateMachineId,
  jwtExpiresAtMs,
  parseExchange,
  parseUserInfo,
  type TraeCredential,
  type TraeExchange,
} from "./api.ts"
import {
  TRAE_APP_VERSION,
  TRAE_CALLBACK_PATH,
  TRAE_CALLBACK_PORT,
  TRAE_CLIENT_ID,
  TRAE_CONSOLE_BASE,
  TRAE_ID,
  TRAE_IDE_VERSION,
  TRAE_OAUTH_BASE,
  TRAE_PATHS,
  TRAE_PENDING_SIGN_IN_TTL_MS,
  TRAE_PLUGIN_VERSION,
  TRAE_REQUEST_TIMEOUT_MS,
  TRAE_SIGN_IN_TIMEOUT_MS,
  TRAE_USER_AGENT,
} from "./product.ts"

export interface TraeLoginDeps {
  client: PluginClient
  fetcher: Fetcher
  /** How long a sign-in may take; tests shorten it. */
  timeoutMs?: number
  /** The clock the exchange's relative expiry reads; tests pin it. */
  now?: () => number
}

/**
 * The identity this install signs in as.
 *
 * Both values are 32 hex characters, generated once per sign-in and then kept
 * on the account forever: the upstream identifies the device by them, and the
 * check-in is limited per device, so a credential that regenerates them looks
 * like a new machine.
 */
function newDevice(): { machineId: string; deviceId: string } {
  return { machineId: generateMachineId(), deviceId: generateDeviceId() }
}

/**
 * The trace id that lets the console hand the answer back.
 *
 * The callback does not echo the device ids, so they cannot match a redirect
 * to the sign-in that started it; the last 16 characters of the two joined is
 * what the vendor's own client uses as `login_trace_id`.
 */
export function traceIdOf(machineId: string, deviceId: string): string {
  const joined = machineId + deviceId
  return joined.length >= 16 ? joined.slice(-16) : joined.padStart(16, "0")
}

/**
 * The sign-in URL.
 *
 * Every parameter matters, and the two that were wrong in an earlier
 * implementation cost the same thing — the console has nowhere to send the
 * answer, so the browser never leaves the authorization page:
 *
 * - the callback parameter is **`auth_callback_url`**; `callback_url` and
 *   `redirect_uri` are both ignored;
 * - `auth_from` / `login_channel` / `auth_type` / `redirect` decide which
 *   branch of the console's flow runs, and without them it never reaches the
 *   local-return branch.
 *
 * The `x_*` parameters describe the client the console believes it is talking
 * to; leaving them out invites the risk control instead of the sign-in.
 *
 * **No `code_challenge`.** The console runs one of two flows, and the
 * parameter is what picks it (`page.…js`: `er` = both `code_challenge` and
 * `code_challenge_method` present). Without it the page hands back a
 * **refresh token** — what JetHub's `buildTraeLoginURL` and
 * `@magpie-community/opencode-trae-auth` get, and what this package can
 * exchange (measured: the code exchange answers `10101 无效参数` for our body,
 * and the refresh-token exchange answers `20101` only for a token that is
 * actually spent). Sending it made this package the only one of the three on
 * the code flow, with an exchange it could not complete — see
 * `docs/vendors.md` §4.
 */
export function buildLoginUrl(machineId: string, deviceId: string, callbackUrl: string): string {
  const params = new URLSearchParams({
    login_version: "1",
    auth_from: "solo",
    login_channel: "native_ide",
    plugin_version: TRAE_PLUGIN_VERSION,
    auth_type: "local",
    client_id: TRAE_CLIENT_ID,
    redirect: "0",
    login_trace_id: traceIdOf(machineId, deviceId),
    auth_callback_url: callbackUrl,
    machine_id: machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: machineId,
    x_device_brand: "PC",
    x_device_type: "PC",
    x_os_version: "1.0",
    x_app_version: TRAE_APP_VERSION,
    x_app_type: "stable",
    // The client appends this for `auth_from=solo`; the console hides its
    // SaaS sign-in entry for a SOLO client, and we are one (our client id is
    // `authConfig.SOLO.stable`).
    hide_saas_login: "true",
  })
  return `${TRAE_CONSOLE_BASE}/authorization?${params.toString()}`
}

/** What the callback carried, when it carried a usable token. */
export interface TraeCallback {
  refreshToken: string
  /** Only set when there was no refresh token; a short-lived fallback. */
  accessToken: string
  /** The PKCE authorization code, when the console answered with one. */
  authCode?: string
  uid: string
  nickname: string
  enterpriseId: string
}

export type TraeCallbackResult =
  | { ok: true; callback: TraeCallback }
  | { ok: false; reason: string; authCodeFlow: boolean }

/**
 * Read the callback URL the console redirected to.
 *
 * The answer rides in query parameters: `refreshToken`, and the user in
 * `userInfo` / `userJwt`, each **URL-encoded JSON** — the Chinese nickname is
 * sometimes encoded twice, so both spellings are tried.
 *
 * A callback carrying a `code` / `authCodeInfo` instead is a legal callback on
 * the console's other flow (PKCE), which this package does not implement. It
 * is reported as such rather than as "no token": telling a user their sign-in
 * was invalid when the console simply changed flows sends them to fix the
 * wrong thing.
 */
export function parseCallback(rawUrl: string): TraeCallbackResult {
  let query: URLSearchParams
  try {
    query = new URL(rawUrl.startsWith("http") ? rawUrl : `http://127.0.0.1${rawUrl}`).searchParams
  } catch {
    return { ok: false, reason: "回调地址无法解析", authCodeFlow: false }
  }

  const userInfo = parseJsonParam(query.get("userInfo"))
  const userJwt = parseJsonParam(query.get("userJwt"))
  const uid = jsonText(userInfo, "UserID")
  const nickname = jsonText(userInfo, "ScreenName")
  // The callback spells it `TenantID`, not `EnterpriseID`.
  const enterpriseId = jsonText(userInfo, "TenantID")

  // The console reports a refusal (a cancelled consent, a policy block) as
  // an error pair on the callback rather than by not sending one. Passing
  // that through as "no credentials" would describe the wrong problem.
  const errorCode = (query.get("error_code") ?? query.get("errorCode") ?? "").trim()
  if (errorCode.length > 0 && errorCode !== "0") {
    const reason = (query.get("error_msg") ?? query.get("errorMsg") ?? "").trim()
    return {
      ok: false,
      authCodeFlow: false,
      reason: `控制台拒绝了这次授权（code=${errorCode}）${reason.length > 0 ? `：${reason}` : ""}`,
    }
  }

  const fromQuery = query.get("refreshToken") ?? ""
  const jwtRefresh = jsonText(userJwt, "RefreshToken")
  const refreshToken = fromQuery.length > 0 ? fromQuery : jwtRefresh
  const accessToken = refreshToken.length > 0 ? "" : jsonText(userJwt, "Token")

  // A code can arrive as the query's own `code`, as `authCode`, or inside an
  // `authCodeInfo` that is either JSON or the bare code.
  const authCodeInfo = parseJsonParam(query.get("authCodeInfo"))
  const authCode =
    authCodeInfo === undefined
      ? undefined
      : jsonText(authCodeInfo, "AuthCode") || jsonText(authCodeInfo, "authCode") || undefined
  const bareCode = [query.get("code") ?? "", query.get("authCode") ?? ""]
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0)

  if (refreshToken.length === 0 && accessToken.length === 0) {
    const code = authCode ?? bareCode
    if (code === undefined) {
      return { ok: false, authCodeFlow: false, reason: "回调未携带登录凭据" }
    }
    // A legal answer on the flow the current client uses: the code is
    // exchanged together with the verifier this sign-in kept.
    return {
      ok: true,
      callback: {
        refreshToken: "",
        accessToken: "",
        authCode: code,
        uid,
        nickname: fixNickname(nickname, uid),
        enterpriseId,
      },
    }
  }

  return {
    ok: true,
    callback: {
      refreshToken,
      accessToken,
      ...(authCode === undefined ? {} : { authCode }),
      uid,
      nickname: fixNickname(nickname, uid),
      enterpriseId,
    },
  }
}

/** A JSON parameter of the callback; decoded once more when it is encoded twice. */
function parseJsonParam(raw: string | null): Record<string, unknown> | undefined {
  if (raw === null || raw.length === 0) return undefined
  const candidates = [raw]
  try {
    const decoded = decodeURIComponent(raw)
    if (decoded !== raw) candidates.push(decoded)
  } catch {
    // Not valid encoding: only the raw form is tried.
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      const record = asObject(parsed)
      if (record !== undefined) return record
    } catch {
      // Try the next spelling.
    }
  }
  return undefined
}

/** A JSON object's string field. */
function jsonText(source: Record<string, unknown> | undefined, key: string): string {
  if (source === undefined) return ""
  return str(source[key]) ?? ""
}

/**
 * Repair the nickname the callback mangles.
 *
 * JetHub repairs this by reinterpreting the string as latin-1 and decoding it
 * as UTF-8. Measured on 2026-10-16, that reinterpretation does neither of the
 * things it is there for, so this package does not do it:
 *
 * - it does **not** repair the documented mojibake (`Óû§8847309959` decodes to
 *   replacement characters, not to a name);
 * - it **corrupts** names it was not meant to touch: `🙂boy` reinterprets to
 *   `=Bboy`, `Москва` to control characters, `José` to a replacement
 *   character — all of which pass the "printable, no replacement" test that
 *   was supposed to mean "the repair worked".
 *
 * So the vendor's own string is kept whenever it is printable, and a readable
 * placeholder is used only when it is not (an empty name, or one carrying
 * control characters). Keeping a garbled name is a smaller cost than
 * fabricating one for every non-Chinese account.
 */
export function fixNickname(raw: string, uid: string): string {
  if (raw.length === 0) return raw
  const printable = [...raw].every((char) => char.charCodeAt(0) >= 32)
  return printable ? raw : `用户${uid.slice(-4)}`
}

/**
 * Exchange the callback's token for a usable credential.
 *
 * When the callback carried a refresh token it is exchanged for an access
 * token and a **rotated** refresh token; when it carried only an access token,
 * that one is used as-is and the account will need a fresh sign-in when it
 * lapses. `GetUserInfo` then fills in the identity, and a failure there is
 * tolerated: the callback already carried a user id and a name, and a sign-in
 * that worked is not undone by a read that did not.
 */
export async function completeSignIn(
  callback: TraeCallback,
  device: { machineId: string; deviceId: string },
  deps: TraeLoginDeps,
): Promise<TraeCredential> {
  const now = deps.now?.() ?? Date.now()
  let exchange: TraeExchange
  if (callback.authCode !== undefined) {
    // The console's other flow. This package does not ask for it (its sign-in
    // URL carries no `code_challenge`) and does not implement its exchange —
    // the body the official client sends there (`AuthCode` + `CodeVerifier` +
    // `DeviceInfo`) is answered `10101 无效参数` when replayed from here, so
    // guessing at it would spend a real authorization code on a wrong shape.
    // Saying so is the honest answer; a retry goes down the flow that works.
    throw new VendorError(
      TRAE_ID,
      "控制台返回了授权码（PKCE 流程），本包走的是刷新令牌那条流程；请重新发起登录",
    )
  } else if (callback.refreshToken.length > 0) {
    exchange = await exchangeTokens(callback.refreshToken, deps)
  } else {
    exchange = {
      accessToken: callback.accessToken,
      refreshToken: "",
      tokenExpireAt: 0,
      tokenExpireDuration: 0,
    }
  }

  let userInfo = {
    uid: callback.uid,
    screenName: callback.nickname,
    enterpriseId: callback.enterpriseId,
  }
  const answer = await httpJson(deps.fetcher, `${TRAE_OAUTH_BASE}${TRAE_PATHS.userInfo}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": TRAE_USER_AGENT,
      "X-Cloudide-Token": exchange.accessToken,
    },
    body: JSON.stringify({ ReqSource: "IDE", IDEVersion: TRAE_IDE_VERSION }),
    timeoutMs: TRAE_REQUEST_TIMEOUT_MS,
  }).catch(() => undefined)
  const fetched = answer === undefined || !answer.ok ? undefined : parseUserInfo(answer.json)
  if (fetched !== undefined) {
    userInfo = {
      uid: fetched.uid,
      screenName: fetched.screenName.length > 0 ? fetched.screenName : userInfo.screenName,
      enterpriseId: fetched.enterpriseId.length > 0 ? fetched.enterpriseId : userInfo.enterpriseId,
    }
  }

  if (userInfo.uid.length === 0) {
    throw new VendorError(TRAE_ID, "登录未能确定账号 ID，请重试")
  }
  return buildCredential(exchange, userInfo, device, now)
}

/** One `ExchangeToken` call, shared by sign-in and renewal. */
async function exchangeTokens(refreshToken: string, deps: TraeLoginDeps): Promise<TraeExchange> {
  const answer = await httpJson(deps.fetcher, `${TRAE_OAUTH_BASE}${TRAE_PATHS.exchange}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": TRAE_USER_AGENT,
    },
    body: JSON.stringify({
      ClientID: TRAE_CLIENT_ID,
      RefreshToken: refreshToken,
      ClientSecret: "-",
      UserID: "",
    }),
    timeoutMs: TRAE_REQUEST_TIMEOUT_MS,
  })
  if (!answer.ok) {
    throw new VendorError(TRAE_ID, `换取登录令牌失败（HTTP ${answer.status}）`, { status: answer.status })
  }
  const parsed = parseExchange(answer.json)
  if (parsed === undefined) throw new VendorError(TRAE_ID, "登录令牌响应缺少 Token")
  return parsed
}

/**
 * Renew an account, keeping its device identity.
 *
 * The device fields and the identity are carried through by `applyRefresh`;
 * only the two tokens change, and the refresh token only when the answer
 * carried a new one.
 */
export async function refreshCredential(
  previous: TraeCredential,
  deps: TraeLoginDeps,
): Promise<TraeCredential> {
  if (previous.refreshToken.length === 0) {
    throw new VendorError(TRAE_ID, "该账号没有续期令牌，请重新登录")
  }
  const now = deps.now?.() ?? Date.now()
  return applyRefresh(previous, await exchangeTokens(previous.refreshToken, deps), now)
}

/**
 * What a finished sign-in hands the host.
 *
 * `refresh` is present on purpose: it is what tells the host to store this as
 * an OAuth sign-in, which in turn is what lets the account be renewed instead
 * of needing a browser every time. The device fields ride along beside it and
 * are read back through `core/stored.ts`.
 */
export function signInResult(credential: TraeCredential): SignInResult {
  const expires = credential.expiresAt ?? jwtExpiresAtMs(credential.accessToken)
  return {
    type: "success",
    access: credential.accessToken,
    refresh: credential.refreshToken,
    ...(expires === undefined ? {} : { expires }),
    accountId: credential.nickname ?? credential.uid,
    uid: credential.uid,
    machineId: credential.machineId,
    deviceId: credential.deviceId,
    ...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
    ...(credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId }),
  }
}

/**
 * Save a sign-in the host is no longer waiting for.
 *
 * Usually the plugin only *returns* the account (`AuthMethod.callback`'s
 * result) and the host stores it. By the time a late redirect arrives, the
 * host has already taken the flow's failure and stopped listening, so
 * nothing would carry this result anywhere: the page writes it itself, into
 * the account key the host uses for this provider's first account
 * (`plugin-auth.json`).
 *
 * A failure is only logged: the host has reported the flow's own outcome by
 * then, and writing a second one would go nowhere.
 */
async function saveLateSignIn(deps: TraeLoginDeps, result: SignInResult, log: VendorLogger): Promise<void> {
  if (result.type !== "success") return
  const { type: _type, provider: _provider, ...body } = result
  try {
    await deps.client.auth.set({ path: { id: TRAE_ID }, body: { type: "oauth", ...body } })
    await log.info("浏览器回来得比这次登录的等待更晚：登录态已直接保存")
  } catch (error) {
    await log.warn(`迟到的登录结果没能保存：${errorMessage(error)}`)
  }
}

/**
 * The page the browser lands on after the console is done with it.
 *
 * It is deliberately static: everything the browser needs to know has already
 * happened by the time it gets here, and the plugin's own side of the flow is
 * settled by the same request. There is nothing left to poll.
 */
function donePage(message: string): PageResponse {
  return {
    contentType: HTML,
    body: renderLoginPage({
      title: "登录 TRAE",
      note: message,
      accent: "#1f6feb",
      body: '<p class="cn-hint">可以关闭此页面，回到插件继续。</p>',
      script: `cnStatus("cn-status", ${JSON.stringify("登录流程已结束")});`,
    }),
  }
}

/**
 * Whether a request on the callback path actually carries the console's
 * answer.
 *
 * Anything else — a reachability probe, a reload, a favicon — is answered and
 * ignored: settling on one would end the sign-in and close the server, and
 * the real redirect that follows would land on a dead port.
 */
function carriesAnswer(query: URLSearchParams): boolean {
  const keys = [
    "authCodeInfo",
    "code",
    "authCode",
    "refreshToken",
    "userJwt",
    "userInfo",
    "error_code",
    "errorCode",
  ]
  return keys.some((key) => (query.get(key) ?? "").length > 0)
}

/** What a request with nothing in it sees: the flow is still open. */
function waitingPage(): PageResponse {
  return {
    contentType: HTML,
    body: renderLoginPage({
      title: "登录 TRAE",
      note: "等待浏览器完成授权",
      accent: "#1f6feb",
      body: '<p class="cn-hint">这一步只是确认本机回调可达，请回到授权页继续。</p>',
      script: `cnStatus("cn-status", ${JSON.stringify("等待授权结果…")});`,
    }),
  }
}

/**
 * What an answer nobody is waiting for sees.
 *
 * The address is fixed, so a browser can arrive with a trace id this process
 * has no sign-in for: a tab from a session that ended, another magpie's
 * sign-in, a bookmark. Redeeming it would need a device identity and a PKCE
 * verifier that no longer exist, so it is refused and the user is told to
 * start again — which is the one thing that will work.
 */
function unknownSignInPage(): PageResponse {
  return {
    contentType: HTML,
    body: renderLoginPage({
      title: "登录 TRAE",
      note: "这次授权已经过期",
      accent: "#d1242f",
      body: '<p class="cn-hint">请在插件里重新发起一次登录。</p>',
      script: `cnStatus("cn-status", ${JSON.stringify("请重新发起登录")});`,
    }),
  }
}

/** Same, for an answer older than the TTL. */
function expiredPage(): PageResponse {
  return unknownSignInPage()
}

/**
 * Finish a sign-in from text the user handed over instead of a browser hop.
 *
 * Accepts the whole callback address, so a browser that cannot reach loopback
 * is not a dead end: the address carries the answer (`refreshToken` and the
 * user), and it is parsed exactly like a delivered callback. A bare string is
 * refused with a reason — the answer is a URL, and guessing at a fragment of
 * one would spend a real credential on a wrong guess.
 */
async function finishFromText(
  text: string,
  device: { machineId: string; deviceId: string },
  deps: TraeLoginDeps,
  traceId: string,
): Promise<SignInResult> {
  const looksLikeUrl = text.includes("?") || text.startsWith("http")
  const parsed = looksLikeUrl ? parseCallback(text) : undefined
  if (parsed !== undefined) {
    if (!parsed.ok) return { type: "failed", error: parsed.reason }
    const query = new URL(text.startsWith("http") ? text : `http://127.0.0.1${text}`).searchParams
    const echoed = query.get("loginTraceID")
    if (echoed !== null && echoed !== traceId) {
      return { type: "failed", error: "这段地址不属于本次登录，请重新发起" }
    }
    try {
      return signInResult(await completeSignIn(parsed.callback, device, deps))
    } catch (error) {
      return { type: "failed", error: errorMessage(error) }
    }
  }
  return {
    type: "failed",
    error: "请粘贴浏览器最后停在的那一整串地址（含 ? 之后的参数），只给一段代码无法完成登录",
  }
}

/**
 * The callback page, one per plugin process.
 *
 * Every sign-in names the same address (`TRAE_CALLBACK_PORT`), so the page
 * cannot belong to one sign-in: a tab left over from an earlier attempt, a
 * browser that follows the console's redirect minutes later, a second sign-in
 * started before the first was finished — all arrive at the same URL, and the
 * `login_trace_id` the console echoes back says which attempt an answer is
 * for.
 *
 * The page therefore outlives every sign-in it serves. That is the point: a
 * listener that stops when the host stops waiting is exactly what produced
 * `ERR_CONNECTION_REFUSED` for authorizations that had already succeeded. A
 * pending sign-in is forgotten after `TRAE_PENDING_SIGN_IN_TTL_MS`, so an
 * answer found much later is refused rather than redeemed against a device
 * and a PKCE verifier this process no longer holds.
 *
 * A sign-in that is redeemed after its flow ended (`settled`) is saved by the
 * page itself — see `saveLateSignIn`. Nothing else is watching by then.
 */
interface PendingSignIn {
  /** The trace id the console was given, and the key this claim is held under. */
  traceId: string
  deps: TraeLoginDeps
  log: VendorLogger
  device: { machineId: string; deviceId: string }
  settlement: Settlement<SignInResult>
  startedAt: number
}

/** The process-wide callback page and the sign-ins it is holding. */
interface CallbackHub {
  server: PageServer
  pending: Map<string, PendingSignIn>
}

/**
 * Keyed by the host client: one plugin instance is handed one client, so this
 * is "one page per plugin process" without the page being something a second
 * instance (another host, another vendor's deps in a test) can claim from.
 */
const hubs = new WeakMap<PluginClient, CallbackHub>()
const hubsStarting = new WeakMap<PluginClient, Promise<CallbackHub>>()

async function callbackHub(client: PluginClient): Promise<CallbackHub> {
  const existing = hubs.get(client)
  if (existing?.server.listening === true) return existing
  let starting = hubsStarting.get(client)
  if (starting === undefined) {
    starting = startHub(client)
    hubsStarting.set(client, starting)
  }
  try {
    return await starting
  } finally {
    hubsStarting.delete(client)
  }
}

async function startHub(client: PluginClient): Promise<CallbackHub> {
  const pending = new Map<string, PendingSignIn>()
  const server = await PageServer.start(
    async (request): Promise<PageResponse> => {
      if (!request.path.endsWith(TRAE_CALLBACK_PATH)) return notFound()
      const traceId = request.query.get("loginTraceID") ?? ""
      // The console echoes the trace id we issued, and that is what says which
      // attempt an answer belongs to. Its shape is the vendor's to change, so
      // an answer that names none is still accepted **when there is only one
      // sign-in it could be for** — refusing it would fail a legitimate
      // sign-in over a parameter name this package does not control.
      const byTrace = traceId.length > 0
      const claim = byTrace
        ? pending.get(traceId)
        : pending.size === 1
          ? pending.values().next().value
          : undefined
      if (claim !== undefined && Date.now() - claim.startedAt > TRAE_PENDING_SIGN_IN_TTL_MS) {
        pending.delete(claim.traceId)
        return expiredPage()
      }
      if (!carriesAnswer(request.query)) return waitingPage()
      if (claim === undefined) return unknownSignInPage()
      const page = await redeem(claim, request.query, { inferred: !byTrace })
      // A claim matched by trace id belongs to this answer and is spent. One
      // that was only *inferred* (the answer named no trace id) is a guess:
      // when it fails, the guess was probably a stale tab's, so the claim is
      // kept and the sign-in stays claimable by the answer still coming. A
      // stale tab must not be able to kill the sign-in a person is waiting on.
      if (byTrace || page !== undefined) pending.delete(claim.traceId)
      return page ?? waitingPage()
    },
    { raw: true, port: TRAE_CALLBACK_PORT, unref: true },
  )
  const hub: CallbackHub = { server, pending }
  hubs.set(client, hub)
  return hub
}

/**
 * An answer, turned into a sign-in. Runs on the page's behalf.
 *
 * `undefined` means "this answer was not this sign-in's": it is returned only
 * for a guess that failed, and the caller keeps the claim (see the handler).
 */
async function redeem(
  claim: PendingSignIn,
  query: URLSearchParams,
  options: { inferred: boolean } = { inferred: false },
): Promise<PageResponse | undefined> {
  const { inferred } = options
  try {
    const parsed = parseCallback(`/?${query.toString()}`)
    if (!parsed.ok) {
      // A malformed answer is only this sign-in's if it named its trace id.
      // A guessed one is ignored, like any other answer that isn't ours.
      if (inferred) {
        await claim.log.warn(`一个不认识的回调被忽略了：${parsed.reason}`)
        return undefined
      }
      claim.settlement.settle({ type: "failed", error: parsed.reason })
      return donePage(parsed.reason)
    }
    // The host stops waiting after its own timeout; a browser can arrive well
    // past it. The flow is over, so this page stores the account itself.
    const late = claim.settlement.settled
    const credential = await completeSignIn(parsed.callback, claim.device, claim.deps)
    const result = signInResult(credential)
    if (late) await saveLateSignIn(claim.deps, result, claim.log)
    claim.settlement.settle(result)
    return donePage("登录成功")
  } catch (error) {
    const message = errorMessage(error)
    await claim.log.warn(
      inferred ? `一个不认识的回调被拒绝了（它没带 login_trace_id）：${message}` : `登录失败：${message}`,
    )
    // Guessed from a single pending sign-in, and wrong: this is not that
    // sign-in's answer, so it is not failed on its behalf.
    if (inferred) return undefined
    claim.settlement.settle({ type: "failed", error: message })
    return donePage(`登录失败：${message}`)
  }
}

/**
 * Forget sign-ins nobody came back for.
 *
 * The page lives as long as the host does, so an abandoned sign-in would
 * otherwise be kept for the life of the process — each one holding a
 * settlement, a device identity and a PKCE verifier. Called when a sign-in
 * starts, which is the only moment the map grows.
 */
function prunePending(pending: Map<string, PendingSignIn>): void {
  const cutoff = Date.now() - TRAE_PENDING_SIGN_IN_TTL_MS
  for (const [key, claim] of pending) {
    if (claim.startedAt < cutoff) pending.delete(key)
  }
}

/**
 * The sign-in method, as the host wants it.
 *
 * The work happens between `authorize()` returning and its `callback`
 * resolving: the page server accepts the console's redirect, exchanges what
 * it carried, and settles the promise the host is waiting on.
 */
export function loginMethods(deps: TraeLoginDeps): AuthMethod[] {
  return [
    {
      type: "oauth",
      label: "浏览器登录",
      async authorize() {
        const device = newDevice()
        const log = vendorLogger(deps.client, TRAE_ID)
        const settlement = createSettlement<SignInResult>()

        // The console validates the callback URL against
        // `^http://127.0.0.1:(\d+)/authorize$` and refuses the sign-in — with
        // the "登录失败 / 网络错误" screen — for anything else. A random path
        // prefix therefore cannot be used here: the server serves the root
        // path, which is why `raw` exists (`core/local-page.ts`).
        const traceId = traceIdOf(device.machineId, device.deviceId)
        // The page belongs to the process, not to this sign-in: that is what
        // makes the address the same every time, and what keeps a slow
        // browser hop from landing on a port nobody is listening to. The
        // trace id decides which attempt an answer belongs to.
        const shared = await callbackHub(deps.client)
        prunePending(shared.pending)
        shared.pending.set(traceId, { traceId, deps, log, device, settlement, startedAt: Date.now() })
        const callbackUrl = new URL(TRAE_CALLBACK_PATH.replace(/^\//, ""), shared.server.url).toString()
        // Worth a line when the preferred port was taken: the address a stale
        // browser tab holds then has nothing behind it.
        if (new URL(callbackUrl).port !== String(TRAE_CALLBACK_PORT)) {
          await log.info(`回调端口 ${TRAE_CALLBACK_PORT} 被占用，本次登录改用 ${new URL(callbackUrl).port}`)
        }

        const timer = setTimeout(() => {
          // The page keeps listening and the sign-in stays claimable, so a
          // browser that arrives after this still finishes it (`redeem` saves
          // it itself). The host is only told that its own wait is over.
          void log.warn("登录超时；回调页仍在监听，浏览器稍后回来仍可完成登录")
          settlement.settle({ type: "failed", error: "登录超时，请重新发起" })
        }, deps.timeoutMs ?? TRAE_SIGN_IN_TIMEOUT_MS)
        timer.unref?.()

        return {
          url: buildLoginUrl(device.machineId, device.deviceId, callbackUrl),
          instructions: "在浏览器中完成 TRAE 授权，页面会自动完成登录",
          method: "auto",
          /**
           * The host waits here for the browser hop.
           *
           * `pasted` is the recovery path magpie offers when the browser
           * cannot reach loopback ("paste its whole address here"): the
           * address always carries the answer, so it is parsed exactly like a
           * delivered callback. That is what makes `ERR_CONNECTION_REFUSED`
           * recoverable — the console did its part and the code is in the URL.
           */
          callback: async (pasted?: string) => {
            const text = typeof pasted === "string" ? pasted.trim() : ""
            if (text.length > 0) {
              clearTimeout(timer)
              shared.pending.delete(traceId)
              return await finishFromText(text, device, deps, traceId)
            }
            // The page is not closed when this returns. Closing it the moment
            // the host stops waiting is what turns a slow-but-real
            // authorization into `ERR_CONNECTION_REFUSED` in the browser: the
            // console had already handed the answer to a page that was gone.
            try {
              return await settlement.promise
            } finally {
              clearTimeout(timer)
              // The attempt is **not** forgotten here. A host that stopped
              // waiting — its own timeout, a closed window — is exactly the
              // case where the browser still arrives later, and the claim is
              // what lets that answer be redeemed (`redeem` deletes it when
              // it does, the TTL when nobody comes).
            }
          },
        }
      },
    },
  ]
}
