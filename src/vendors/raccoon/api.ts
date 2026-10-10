/**
 * Raccoon's HTTP dialect, in one place.
 *
 * Everything but chat goes through `{ code, message, details, data }` with
 * `code: 0` for success. A body without a `code` is read by the HTTP status,
 * which is how this service states 401 — and a 401 is the sign-in having
 * lapsed, not a request-level failure.
 *
 * Every function takes the `fetch` to use, so tests drive them with canned
 * answers and no network (see `tests/raccoon-api.test.ts`).
 */

import { createCipheriv, randomBytes } from "node:crypto"
import { errorMessage, SignInExpiredError, VendorError } from "../../core/errors.ts"
import { type Fetcher, httpJson } from "../../core/http.ts"
import { asObject, num, str } from "../../core/json.ts"
import { randomHex } from "../../core/util.ts"
import {
  RACCOON_API_BASE,
  RACCOON_CLIENT_PLATFORM,
  RACCOON_CLIENT_VERSION,
  RACCOON_ID,
  RACCOON_OK_CODE,
  RACCOON_PATHS,
  RACCOON_QR_APP_NAME,
  RACCOON_REQUEST_TIMEOUT_MS,
  RACCOON_SIGNED_OUT_CODES,
} from "./product.ts"

const VENDOR = RACCOON_ID

/** A transport failure's code: no HTTP status was ever read. */
export const RACCOON_NETWORK_CODE = -1

export interface RaccoonEnvelope {
  ok: boolean
  code: number
  message: string
  data: Record<string, unknown> | undefined
}

/**
 * Reads the envelope. `code` decides; a payload that carries none is read by
 * the HTTP status, and a 2xx without one counts as success (the service adds
 * `code` to everything, but an intermediary's empty 200 body is not a
 * business failure this package can name).
 */
export function parseEnvelope(payload: unknown, status = 200): RaccoonEnvelope {
  const record = asObject(payload)
  const code = num(record?.code) ?? (status >= 400 ? status : RACCOON_OK_CODE)
  const message = str(record?.message) ?? str(record?.details) ?? ""
  const data = asObject(record?.data)
  if (record === undefined) {
    return { ok: false, code, message: message.length > 0 ? message : "响应不是 JSON 对象", data }
  }
  if (!Number.isFinite(code) || code !== RACCOON_OK_CODE) {
    const said = [str(record.message), str(record.details)].filter((part) => part !== undefined)
    return {
      ok: false,
      code: Number.isFinite(code) ? code : RACCOON_NETWORK_CODE,
      message: said.length > 0 ? said.join("：") : `业务错误 ${String(code)}`,
      data,
    }
  }
  return { ok: true, code, message, data }
}

/** True when this answer says the sign-in lapsed and no retry helps. */
export function isSignedOut(status: number, code: number): boolean {
  return RACCOON_SIGNED_OUT_CODES.includes(status) || RACCOON_SIGNED_OUT_CODES.includes(code)
}

/** The headers a business read carries; every one of them is the client's. */
export function businessHeaders(access: string, orgCode: string | undefined): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${access}`,
    // A personal account sends the empty string, as the client does.
    "X-Org-Code": orgCode ?? "",
    "X-Raccoon-Language": "zh",
  }
}

/**
 * What `/chat/completions` carries. The platform header is the desktop
 * client's own, and the service is known to require it on the desktop
 * endpoints; chat is asked with the same set rather than a subset.
 */
export function chatHeaders(access: string, orgCode: string | undefined): Record<string, string> {
  return {
    ...businessHeaders(access, orgCode),
    Accept: "text/event-stream",
    "X-Client-Platform": RACCOON_CLIENT_PLATFORM,
    "X-Client-Version": RACCOON_CLIENT_VERSION,
  }
}

export type RaccoonRead<T> =
  | { ok: true; data: T }
  | { ok: false; code: number; message: string; signedOut: boolean }

/**
 * One read that reports its failure instead of throwing, for the hooks that
 * should tell the host what went wrong rather than fail the whole account
 * (`usage`, `provider.models`). A signed-out answer keeps its code, and the
 * caller turns it into `signIn: "expired"`.
 */
export async function raccoonRead<T = Record<string, unknown>>(
  fetcher: Fetcher,
  access: string,
  orgCode: string | undefined,
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<RaccoonRead<T | undefined>> {
  let result: Awaited<ReturnType<typeof httpJson>>
  try {
    result = await httpJson(fetcher, `${RACCOON_API_BASE}${path}`, {
      method: init.method ?? "GET",
      headers: businessHeaders(access, orgCode),
      ...(init.body === undefined ? {} : { body: init.body }),
      timeoutMs: RACCOON_REQUEST_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, code: RACCOON_NETWORK_CODE, message: errorMessage(error), signedOut: false }
  }
  const envelope = parseEnvelope(result.json, result.status)
  if (!envelope.ok) {
    return {
      ok: false,
      code: envelope.code,
      message: envelope.message,
      signedOut: isSignedOut(result.status, envelope.code),
    }
  }
  return { ok: true, data: envelope.data as T | undefined }
}

/** One POST whose failure is an error the user must read. */
async function post(fetcher: Fetcher, path: string, body: Record<string, unknown>): Promise<RaccoonEnvelope> {
  let result: Awaited<ReturnType<typeof httpJson>>
  try {
    result = await httpJson(fetcher, `${RACCOON_API_BASE}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: RACCOON_REQUEST_TIMEOUT_MS,
    })
  } catch (error) {
    throw new VendorError(VENDOR, `请求失败：${errorMessage(error)}`, { cause: error })
  }
  const envelope = parseEnvelope(result.json, result.status)
  if (!envelope.ok && isSignedOut(result.status, envelope.code)) {
    throw new SignInExpiredError(VENDOR, `登录态已失效（${envelope.message}），请重新登录`)
  }
  return envelope
}

/** The `exp` of a JWT, in epoch milliseconds; undefined when unreadable. */
export function jwtExpiresAtMs(token: string): number | undefined {
  const parts = token.split(".")
  if (parts.length < 2) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"))
    const exp = num(asObject(payload)?.exp)
    return exp === undefined || exp <= 0 ? undefined : exp * 1000
  } catch {
    // A hand-edited sign-in is not a reason to fail: without an expiry the
    // account is used until the service turns it away, which is louder.
    return undefined
  }
}
// ---- the QR sign-in ----------------------------------------------------------

/** A 32 hex character code, as the client's `WordArray.random(16)` makes. */
export function generateQrCode(): string {
  return randomHex(16)
}

/** What the QR encodes: the vendor's own WeChat landing page for this code. */
export function qrContent(code: string): string {
  const query = new URLSearchParams({ code, appname: RACCOON_QR_APP_NAME })
  return `${RACCOON_API_BASE}/login/mp?${query.toString()}`
}

export type RaccoonQrStatus = "pending" | "logging" | "canceled" | "success"

export interface RaccoonQrPoll {
  status: RaccoonQrStatus
  /** Only on success: the session, and what renews it. */
  access?: string
  refresh?: string
  expires?: number
}

/**
 * One poll of the QR's state.
 *
 * The service answers `data.status` as one of `pending`, `logging`,
 * `canceled`, `success`; anything else — an unknown word, a malformed body,
 * a failed request — is read as still pending. That is deliberate: this runs
 * every two seconds, a flake must not end the flow, a `success` invented out
 * of nothing would hand the host an empty session, and a `canceled` invented
 * out of nothing would throw away a QR the user is still scanning.
 */
export async function pollQrLogin(fetcher: Fetcher, code: string): Promise<RaccoonQrPoll> {
  let envelope: RaccoonEnvelope
  try {
    envelope = await post(fetcher, RACCOON_PATHS.qrLogin, { qrcode_code: code })
  } catch {
    return { status: "pending" }
  }
  if (!envelope.ok || envelope.data === undefined) return { status: "pending" }
  const status = str(envelope.data.status)
  if (status === "canceled") return { status: "canceled" }
  if (status === "logging") return { status: "logging" }
  if (status !== "success") return { status: "pending" }
  const access = str(envelope.data.access_token)
  // A success without a session is not a success: waiting again costs two
  // seconds, believing it costs the sign-in.
  if (access === undefined) return { status: "pending" }
  const refresh = str(envelope.data.refresh_token)
  const expires = jwtExpiresAtMs(access)
  return {
    status: "success",
    access,
    ...(refresh === undefined ? {} : { refresh }),
    ...(expires === undefined ? {} : { expires }),
  }
}

// ---- the SMS sign-in ---------------------------------------------------------

/**
 * A phone number as the service takes it: AES-128-CFB, keyed with the
 * client's own constant, `base64(iv ‖ ciphertext)`.
 *
 * The mode is written out because the key is 16 bytes: `aes-256-cfb` would
 * throw instead of padding it. CFB is a stream cipher, so switching
 * auto-padding off changes nothing — it is there to match the client's
 * `NoPadding` and to save a reader the question.
 */
export function encryptPhone(secret: string, phone: string, iv?: Uint8Array): string {
  const key = Buffer.from(secret, "utf8")
  if (key.length !== 16) {
    throw new VendorError(
      VENDOR,
      `手机号加密密钥必须是 16 字节（AES-128），当前是 ${key.length} 字节；` +
        "请检查插件选项 phoneCipherSecret 或环境变量 RACCOON_PHONE_CIPHER_SECRET",
    )
  }
  const nonce = iv ?? randomBytes(16)
  const cipher = createCipheriv("aes-128-cfb", key, nonce)
  cipher.setAutoPadding(false)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(phone, "utf8")), cipher.final()])
  return Buffer.concat([Buffer.from(nonce), ciphertext]).toString("base64")
}

export interface RaccoonLogin {
  access: string
  refresh?: string
  expires?: number
  officeIdentity?: string
}

function loginFrom(data: Record<string, unknown> | undefined): RaccoonLogin {
  const access = str(data?.access_token)
  if (access === undefined) throw new VendorError(VENDOR, "登录响应缺少 access_token")
  const refresh = str(data?.refresh_token)
  const officeIdentity = str(data?.office_identity)
  const expires = jwtExpiresAtMs(access)
  return {
    access,
    ...(refresh === undefined ? {} : { refresh }),
    ...(expires === undefined ? {} : { expires }),
    ...(officeIdentity === undefined ? {} : { officeIdentity }),
  }
}

/**
 * Sends an SMS code. The phone is encrypted here, and the captcha parameter
 * is what the page's Aliyun slider produced: the service answers
 * `100006 captcha_verify_error` when it is missing or stale, and
 * `100003 params_encryted_error` when the phone was not encrypted with the
 * key the client uses.
 */
export async function sendSmsCode(
  fetcher: Fetcher,
  secret: string,
  phone: string,
  captchaParam: string,
): Promise<void> {
  const envelope = await post(fetcher, RACCOON_PATHS.sendSms, {
    captcha_param: captchaParam,
    nation_code: "86",
    phone: encryptPhone(secret, phone),
  })
  if (envelope.ok) return
  if (envelope.code === 100006) {
    throw new VendorError(VENDOR, "图形验证码校验失败，请重新完成滑块验证", { code: envelope.code })
  }
  throw new VendorError(VENDOR, envelope.message, { code: envelope.code })
}

export async function loginWithSmsCode(
  fetcher: Fetcher,
  secret: string,
  input: { phone: string; code: string },
): Promise<RaccoonLogin> {
  const envelope = await post(fetcher, RACCOON_PATHS.smsLogin, {
    nation_code: "86",
    phone: encryptPhone(secret, input.phone),
    sms_code: input.code,
  })
  if (!envelope.ok) throw new VendorError(VENDOR, envelope.message, { code: envelope.code })
  return loginFrom(envelope.data)
}

// ---- renewal and identity ----------------------------------------------------

export interface RaccoonRenewal {
  access: string
  /** The rotated refresh token, when the service sent a new one. */
  refresh?: string
  expires?: number
}

/**
 * Exchanges the refresh token for a new session.
 *
 * The service may answer with a new access token and no new refresh token;
 * the old refresh token then stays in force, and dropping it would make the
 * account unrenewable after one renewal. A 401 (or business code 200003)
 * means the refresh token itself is gone: the account needs a sign-in, and
 * the host is told so rather than being handed a failure it would retry.
 */
export async function refreshAccess(fetcher: Fetcher, refreshToken: string): Promise<RaccoonRenewal> {
  const envelope = await post(fetcher, RACCOON_PATHS.refresh, { refresh_token: refreshToken })
  if (!envelope.ok) throw new VendorError(VENDOR, envelope.message, { code: envelope.code })
  const access = str(envelope.data?.access_token)
  if (access === undefined) throw new VendorError(VENDOR, "续期响应缺少 access_token")
  const refresh = str(envelope.data?.refresh_token)
  const expires = jwtExpiresAtMs(access)
  return {
    access,
    ...(refresh === undefined ? {} : { refresh }),
    ...(expires === undefined ? {} : { expires }),
  }
}

export interface RaccoonUserInfo {
  userId?: string
  nickname?: string
  officeIdentity?: string
  phone?: string
}

/**
 * The account's own name, id, organisation and phone number. Best effort:
 * it is used to tell two accounts apart, and failing to read it is not a
 * reason for the sign-in that just succeeded to fail.
 *
 * The `name` the service answers is an automatically generated default
 * (`RaccoonAva` was measured), and a WeChat sign-in carries no WeChat
 * nickname, so the phone number is the only field that reliably tells two
 * accounts apart.
 */
export async function fetchUserInfo(
  fetcher: Fetcher,
  access: string,
  orgCode: string | undefined,
): Promise<RaccoonUserInfo> {
  const result = await raccoonRead(fetcher, access, orgCode, RACCOON_PATHS.userInfo)
  if (!result.ok || result.data === undefined) return {}
  const data = result.data
  const userId = str(data.id)
  const nickname = str(data.name)
  const officeIdentity = str(data.office_identity)
  const phone = str(data.phone)
  return {
    ...(userId === undefined ? {} : { userId }),
    ...(nickname === undefined ? {} : { nickname }),
    ...(officeIdentity === undefined ? {} : { officeIdentity }),
    ...(phone === undefined ? {} : { phone }),
  }
}

// ---- the reads the hooks use -------------------------------------------------

export interface RaccoonBalance {
  /** The service's own total; the one field the card cannot be drawn without. */
  available?: number
  reward?: number
  daily?: number
  monthly?: number
  topup?: number
}

/** The four pools, read-only (`GET /points/v1/balance`). */
export async function fetchBalance(
  fetcher: Fetcher,
  access: string,
  orgCode: string | undefined,
): Promise<RaccoonRead<RaccoonBalance>> {
  const result = await raccoonRead(fetcher, access, orgCode, RACCOON_PATHS.balance)
  if (!result.ok) return result
  const data = result.data ?? {}
  const pick = (key: string): number | undefined => num(data[key])
  const available = pick("available_points")
  const reward = pick("reward_points")
  const daily = pick("daily_points")
  const monthly = pick("monthly_points")
  const topup = pick("topup_points")
  return {
    ok: true,
    data: {
      ...(available === undefined ? {} : { available }),
      ...(reward === undefined ? {} : { reward }),
      ...(daily === undefined ? {} : { daily }),
      ...(monthly === undefined ? {} : { monthly }),
      ...(topup === undefined ? {} : { topup }),
    },
  }
}

/** The account's own catalog, as answered. Throws when the sign-in lapsed. */
export async function fetchCatalog(
  fetcher: Fetcher,
  access: string,
  orgCode: string | undefined,
): Promise<unknown> {
  const result = await raccoonRead(fetcher, access, orgCode, RACCOON_PATHS.models)
  if (!result.ok) {
    if (result.signedOut) throw new SignInExpiredError(VENDOR, `模型列表被拒绝：${result.message}`)
    throw new VendorError(VENDOR, `模型列表读取失败：${result.message}`, { code: result.code })
  }
  return result.data
}

/** A vendor error, a transport error or anything else, as one line. */
