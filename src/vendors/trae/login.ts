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

import { createHash, randomBytes } from "node:crypto"
import { errorMessage, VendorError } from "../../core/errors.ts"
import { type Fetcher, httpJson } from "../../core/http.ts"
import { asObject, str } from "../../core/json.ts"
import { HTML, notFound, type PageResponse, PageServer } from "../../core/local-page.ts"
import { vendorLogger } from "../../core/log.ts"
import { renderLoginPage } from "../../core/login-page.ts"
import type { AuthMethod, PluginClient, SignInResult } from "../../core/types.ts"
import { createSettlement } from "../../core/util.ts"
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
  TRAE_CLIENT_ID,
  TRAE_CONSOLE_BASE,
  TRAE_ID,
  TRAE_IDE_VERSION,
  TRAE_OAUTH_BASE,
  TRAE_PATHS,
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
 * One PKCE pair: the verifier kept here, the challenge sent to the console.
 *
 * The current client signs in with PKCE (`code_challenge` +
 * `code_challenge_method=S256`, measured from its bundle on 2026-10-16) and
 * exchanges the returned authorization code together with this verifier.
 * Without the pair the console falls back to a flow it no longer mints
 * tokens for — which is what the "登录失败 / 网络错误" screen was.
 */
export interface TraePkce {
  codeVerifier: string
  codeChallenge: string
}

export function newPkce(): TraePkce {
  const codeVerifier = randomBytes(32).toString("base64url")
  return { codeVerifier, codeChallenge: challengeOf(codeVerifier) }
}

/** `BASE64URL(SHA256(ASCII(code_verifier)))`, as RFC 7636 defines S256. */
export function challengeOf(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url")
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
 */
export function buildLoginUrl(
  machineId: string,
  deviceId: string,
  callbackUrl: string,
  pkce: TraePkce,
): string {
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
    // The pair that makes the console hand back an authorization code instead
    // of trying to mint a refresh token for a legacy client.
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
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
  pkce?: TraePkce,
): Promise<TraeCredential> {
  const now = deps.now?.() ?? Date.now()
  let exchange: TraeExchange
  if (callback.authCode !== undefined) {
    if (pkce === undefined) {
      throw new VendorError(TRAE_ID, "收到授权码但没有本次登录的 PKCE 校验串，请重新发起登录")
    }
    exchange = await exchangeByAuthCode(callback.authCode, pkce.codeVerifier, deps)
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

/**
 * Trade the authorization code for tokens, with the PKCE verifier.
 *
 * This is the flow the current client uses: a different path from the legacy
 * refresh-token exchange, and the verifier is what proves the same client
 * that started the sign-in is finishing it. The body carries the client id,
 * the code, the verifier and the app version; the vendor's client also sends
 * a `DeviceInfo` block, which is not reproduced here — if the service turns
 * out to require it, this call is where the failure will show up.
 */
async function exchangeByAuthCode(
  authCode: string,
  codeVerifier: string,
  deps: TraeLoginDeps,
): Promise<TraeExchange> {
  const answer = await httpJson(deps.fetcher, `${TRAE_OAUTH_BASE}${TRAE_PATHS.exchangeByCode}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": TRAE_USER_AGENT,
    },
    body: JSON.stringify({
      ClientID: TRAE_CLIENT_ID,
      AuthCode: authCode,
      CodeVerifier: codeVerifier,
      IDEVersion: TRAE_APP_VERSION,
    }),
    timeoutMs: TRAE_REQUEST_TIMEOUT_MS,
  })
  if (!answer.ok) {
    throw new VendorError(TRAE_ID, `授权码换取令牌失败（HTTP ${answer.status}）`, { status: answer.status })
  }
  const parsed = parseExchange(answer.json)
  if (parsed === undefined) throw new VendorError(TRAE_ID, "授权码换取令牌的响应缺少 Token")
  return parsed
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
        const pkce = newPkce()
        const log = vendorLogger(deps.client, TRAE_ID)
        const settlement = createSettlement<SignInResult>()

        const server = await PageServer.start(async (request): Promise<PageResponse> => {
          if (!request.path.endsWith(TRAE_CALLBACK_PATH)) return notFound()
          try {
            const parsed = parseCallback(`/?${request.query.toString()}`)
            if (!parsed.ok) {
              settlement.settle({ type: "failed", error: parsed.reason })
              return donePage(parsed.reason)
            }
            const credential = await completeSignIn(parsed.callback, device, deps, pkce)
            settlement.settle(signInResult(credential))
            return donePage("登录成功")
          } catch (error) {
            const message = errorMessage(error)
            await log.warn(`登录失败：${message}`)
            settlement.settle({ type: "failed", error: message })
            return donePage(`登录失败：${message}`)
          }
        })

        const timer = setTimeout(() => {
          void log.warn("登录超时，已关闭本地回调页")
          settlement.settle({ type: "failed", error: "登录超时，请重新发起" })
          server.close()
        }, deps.timeoutMs ?? TRAE_SIGN_IN_TIMEOUT_MS)
        timer.unref?.()

        const callbackUrl = new URL(TRAE_CALLBACK_PATH.replace(/^\//, ""), server.url).toString()
        return {
          url: buildLoginUrl(device.machineId, device.deviceId, callbackUrl, pkce),
          instructions: "在浏览器中完成 TRAE 授权，页面会自动完成登录",
          method: "auto",
          callback: async () => {
            try {
              return await settlement.promise
            } finally {
              clearTimeout(timer)
              server.close()
            }
          },
        }
      },
    },
  ]
}
