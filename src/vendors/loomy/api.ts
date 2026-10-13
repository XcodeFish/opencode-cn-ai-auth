/**
 * Loomy's two HTTP dialects, in one place.
 *
 * - The **account** base (`account.xfinfr.com`) wraps every call in
 *   `{ base, param }`, signs it with `sign.ts`, and answers the same
 *   `{ code, desc, data }` envelope the product base uses.
 * - The **product** base answers `{ code, desc, data }` too, but on HTTP
 *   200 whatever happened: `code: "000000"` is the only success. Its
 *   endpoints want a lowercase `token` header, while `/chat/completions`
 *   wants `Authorization: Bearer` — so chat requests carry both.
 *
 * Every function takes the `fetch` to use, so tests drive them with canned
 * answers and no network (see `tests/loomy-api.test.ts`).
 */

import { errorMessage, SignInExpiredError, VendorError } from "../../core/errors.ts"
import { type Fetcher, httpBytes, httpJson } from "../../core/http.ts"
import { asArray, asObject, num, str } from "../../core/json.ts"
import { randomId } from "../../core/util.ts"
import {
  LOOMY_ACCOUNT_BASE,
  LOOMY_ACCOUNT_UA,
  LOOMY_API_BASE,
  LOOMY_APP_ID,
  LOOMY_OK_CODE,
  LOOMY_PATHS,
  LOOMY_REQUEST_TIMEOUT_MS,
  LOOMY_SESSION_TTL_SECONDS,
  LOOMY_SIGNED_OUT_CODE,
  LOOMY_SMS_TTL_SECONDS,
  LOOMY_WECHAT_APP_ID,
  LOOMY_WECHAT_POLL_TIMEOUT_MS,
  LOOMY_WECHAT_REDIRECT_URI,
  LOOMY_WECHAT_UA,
} from "./product.ts"
import { signHeaders } from "./sign.ts"

const VENDOR = "loomy"

/**
 * The third-party sign-in errors the service answers with a bare `desc`. The
 * delivered sentence names a *step*, not a cause, so on its own it reads as
 * "something failed" with nothing to do next — and the one code that stops
 * most users (`270101`) is exactly the one the scanner cannot act on. These
 * keep the vendor's code (the caller may branch on it) while saying what the
 * person in front of the page can do.
 *
 * Verified live on 2026-10-13 with the shipped client credentials
 * (`docs/vendors.md` §2): `bind/auth` → `270101`, `bind/sendMsg` → `270202`,
 * `bind/checkCode` → `270301`, `bind/skip` → `270401`.
 */
const THIRD_PARTY_MESSAGES: Record<string, string> = {
  "270101": "微信授权未通过（第三方鉴权失败）：请重新扫码；若反复失败，请改用短信验证码登录",
  "270202": "授权已过期，请重新扫码",
  "270301": "授权已过期，请重新扫码",
  "270401": "授权已过期，请重新扫码",
}

/** The vendor's own sentence, or a readable one when the code is known. */
function accountErrorText(code: string, message: string): string {
  return THIRD_PARTY_MESSAGES[code] ?? message
}

export interface LoomyEnvelope<T> {
  ok: boolean
  code: string
  message: string
  data: T
}

/**
 * Reads the `{ code, desc, data }` envelope. `code` decides, never the HTTP
 * status: this service answers 200 for signed-out sessions too.
 */
export function parseEnvelope<T = Record<string, unknown>>(payload: unknown): LoomyEnvelope<T | undefined> {
  const record = asObject(payload)
  if (record === undefined) {
    return { ok: false, code: "", message: "响应不是 JSON 对象", data: undefined }
  }
  const code = str(record.code) ?? String(num(record.code) ?? "")
  const message = str(record.desc) ?? str(record.message) ?? ""
  if (code !== LOOMY_OK_CODE) {
    return {
      ok: false,
      code,
      message: message.length > 0 ? message : `业务错误 ${code.length > 0 ? code : "(缺少 code)"}`,
      data: undefined,
    }
  }
  return { ok: true, code, message, data: record.data as T }
}

export interface LoomyAccountKeys {
  accessKeyId: string
  accessKeySecret: string
}

export interface LoomyLogin {
  /** The 32-hex session, the only credential the product base accepts. */
  access: string
  userid: string
  phone?: string
}

/** `{ base, param }`, the shape the account service expects. */
export function accountBody(param: Record<string, unknown>): Record<string, unknown> {
  return {
    base: {
      appid: LOOMY_APP_ID,
      modelid: "Web",
      version: "1.0.0",
      devid: "web",
      ua: LOOMY_ACCOUNT_UA,
      traceid: randomId(),
    },
    param,
  }
}

/** One signed POST to the account base, with the envelope unwrapped. */
async function postAccount(
  fetcher: Fetcher,
  keys: LoomyAccountKeys,
  path: string,
  param: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Serialized once: the signature covers these bytes, so `fetch` must send
  // the same string rather than one it serialized again.
  const body = JSON.stringify(accountBody(param))
  const headers = signHeaders({
    accessKeyId: keys.accessKeyId,
    accessKeySecret: keys.accessKeySecret,
    method: "POST",
    path,
    body,
  })
  let result: Awaited<ReturnType<typeof httpJson>>
  try {
    result = await httpJson(fetcher, `${LOOMY_ACCOUNT_BASE}${path}`, {
      method: "POST",
      headers,
      body,
      timeoutMs: LOOMY_REQUEST_TIMEOUT_MS,
    })
  } catch (error) {
    throw new VendorError(VENDOR, `讯飞账号请求失败（${path}）：${errorMessage(error)}`, { cause: error })
  }
  const envelope = parseEnvelope(result.json)
  if (!envelope.ok) {
    throw new VendorError(VENDOR, accountErrorText(envelope.code, envelope.message), {
      code: envelope.code,
      status: result.status,
    })
  }
  return asObject(envelope.data) ?? {}
}

/** Sends the SMS code; the returned `msgid` must come back with the code. */
export async function sendSmsCode(fetcher: Fetcher, keys: LoomyAccountKeys, phone: string): Promise<string> {
  const data = await postAccount(fetcher, keys, LOOMY_PATHS.sendSms, {
    ccode: "86",
    phone,
    expire: LOOMY_SMS_TTL_SECONDS,
  })
  const msgid = str(data.msgid)
  if (msgid === undefined) {
    throw new VendorError(VENDOR, "短信接口没有返回 msgid，无法继续登录")
  }
  return msgid
}

export async function loginWithSmsCode(
  fetcher: Fetcher,
  keys: LoomyAccountKeys,
  input: { phone: string; code: string; msgid: string },
): Promise<LoomyLogin> {
  const data = await postAccount(fetcher, keys, LOOMY_PATHS.checkSms, {
    ccode: "86",
    phone: input.phone,
    mcode: input.code,
    msgid: input.msgid,
    expire: LOOMY_SESSION_TTL_SECONDS,
  })
  return loginFrom(data, input.phone)
}

function loginFrom(data: Record<string, unknown>, phone?: string): LoomyLogin {
  const access = str(data.session)
  const userid = str(data.userid)
  if (access === undefined) throw new VendorError(VENDOR, "登录响应缺少 session")
  if (userid === undefined) throw new VendorError(VENDOR, "登录响应缺少 userid")
  const bound = str(data.phone) ?? phone
  return { access, userid, ...(bound === undefined ? {} : { phone: bound }) }
}

/** Step 1 of the WeChat flow: the code for an `rcode`, and whether it's bound. */
export async function bindWechat(
  fetcher: Fetcher,
  keys: LoomyAccountKeys,
  code: string,
): Promise<{ rcode: string; bound: boolean; nickname?: string }> {
  const data = await postAccount(fetcher, keys, LOOMY_PATHS.bindAuth, {
    tcode: { code },
    type: "wx",
  })
  const rcode = str(data.rcode)
  if (rcode === undefined) throw new VendorError(VENDOR, "微信授权响应缺少 rcode")
  const nickname = str(data.nickname)
  // `bind` missing reads as "not bound": the cost of asking a bound user for
  // their phone number is small, the cost of skipping it for an unbound one
  // is an account with no phone number.
  return {
    rcode,
    bound: data.bind === 1,
    ...(nickname === undefined ? {} : { nickname }),
  }
}

/** Step 2: an SMS code for the phone number about to be bound. */
export async function bindSendMsg(
  fetcher: Fetcher,
  keys: LoomyAccountKeys,
  input: { rcode: string; phone: string },
): Promise<string> {
  const data = await postAccount(fetcher, keys, LOOMY_PATHS.bindSend, {
    rcode: input.rcode,
    phone: input.phone,
    ccode: "86",
    expire: LOOMY_SMS_TTL_SECONDS,
  })
  const msgid = str(data.msgid)
  if (msgid === undefined) throw new VendorError(VENDOR, "绑定手机号响应缺少 msgid")
  return msgid
}

/** Step 3: the code verified, the phone bound, the session issued. */
export async function bindCheckCode(
  fetcher: Fetcher,
  keys: LoomyAccountKeys,
  input: { rcode: string; code: string; msgid: string },
): Promise<LoomyLogin> {
  const data = await postAccount(fetcher, keys, LOOMY_PATHS.bindCheck, {
    rcode: input.rcode,
    mcode: input.code,
    msgid: input.msgid,
    expire: LOOMY_SESSION_TTL_SECONDS,
  })
  return loginFrom(data)
}

/** Step 4, for an account WeChat already bound: the session, no phone needed. */
export async function bindSkip(fetcher: Fetcher, keys: LoomyAccountKeys, rcode: string): Promise<LoomyLogin> {
  const data = await postAccount(fetcher, keys, LOOMY_PATHS.bindSkip, {
    rcode,
    expire: LOOMY_SESSION_TTL_SECONDS,
  })
  return loginFrom(data)
}

/** What the product base wants: a lowercase `token` header, no Bearer. */
export function businessHeaders(access: string): Record<string, string> {
  return { Accept: "application/json", token: access }
}

/** What `/chat/completions` wants. Both headers: the client sends both. */
export function chatHeaders(access: string): Record<string, string> {
  return {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${access}`,
    token: access,
  }
}

export type LoomyRead<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

/**
 * A product call that reports failure instead of throwing, for the read-only
 * hooks (`usage`) that should tell the host what went wrong rather than fail
 * the whole account. A signed-out answer is still reported as its code, and
 * the caller turns it into `signIn: "expired"`.
 */
export async function productRead<T = Record<string, unknown>>(
  fetcher: Fetcher,
  access: string,
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<LoomyRead<T | undefined>> {
  let result: Awaited<ReturnType<typeof httpJson>>
  try {
    result = await httpJson(fetcher, `${LOOMY_API_BASE}${path}`, {
      method: init.method ?? "GET",
      headers:
        init.body === undefined
          ? businessHeaders(access)
          : { ...businessHeaders(access), "Content-Type": "application/json" },
      ...(init.body === undefined ? {} : { body: init.body }),
      timeoutMs: LOOMY_REQUEST_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, code: "NETWORK", message: errorMessage(error) }
  }
  const envelope = parseEnvelope<T>(result.json)
  if (!envelope.ok) return { ok: false, code: envelope.code, message: envelope.message }
  return { ok: true, data: envelope.data }
}

/** Every chat model the account may use, as the service lists it. */
export async function fetchCatalog(fetcher: Fetcher, access: string): Promise<unknown[]> {
  let result: Awaited<ReturnType<typeof httpJson<unknown>>>
  try {
    result = await httpJson<unknown>(fetcher, `${LOOMY_API_BASE}${LOOMY_PATHS.models}`, {
      headers: businessHeaders(access),
      timeoutMs: LOOMY_REQUEST_TIMEOUT_MS,
    })
  } catch (error) {
    throw new VendorError(VENDOR, `模型列表读取失败：${errorMessage(error)}`, {
      code: "NETWORK",
      cause: error,
    })
  }

  // The catalog moved to OpenAI's {object, data} shape, while business
  // endpoints still use {code, desc, data}. Classify the HTTP result before
  // accepting either success shape. A non-legacy 401 must never look like an
  // empty catalog: the host needs the signed-out signal to request sign-in.
  const payload = result.json
  const root = asObject(payload)
  const legacy = root?.code !== undefined
  if (!result.ok) {
    const envelope = legacy ? parseEnvelope<unknown>(payload) : undefined
    if (result.status === 401 || envelope?.code === LOOMY_SIGNED_OUT_CODE) {
      throw new SignInExpiredError(
        VENDOR,
        `模型列表被拒绝：${envelope?.message ?? "登录态已失效，请重新登录"}`,
      )
    }
    const message = envelope !== undefined && !envelope.ok ? envelope.message : `HTTP ${result.status}`
    throw new VendorError(VENDOR, `模型列表读取失败：${message}`, {
      ...(envelope?.code === undefined ? {} : { code: envelope.code }),
      status: result.status,
    })
  }

  const envelope = legacy ? parseEnvelope<unknown>(payload) : { ok: true as const, data: payload }

  if (!envelope.ok) {
    if (envelope.code === LOOMY_SIGNED_OUT_CODE) {
      throw new SignInExpiredError(VENDOR, `模型列表被拒绝：${envelope.message}`)
    }
    throw new VendorError(VENDOR, `模型列表读取失败：${envelope.message}`, {
      code: envelope.code,
      status: result.status,
    })
  }
  const data = envelope.data
  const list = asArray(data) ?? asArray(asObject(data)?.data) ?? asArray(asObject(data)?.list)
  return list ?? []
}

export interface LoomyPoints {
  /** The permanent pool: sign-up credits and the new-user tasks. */
  permanent?: number
  /** The daily pool, which refills each Beijing day and is not given back. */
  daily?: number
  /** Both pools, as the service totals them. */
  available?: number
  /** Only the first-login answer carries these three. */
  dailyQuota?: number
  dailyConsumed?: number
  dailyCycleDate?: string
}

function readPoints(data: Record<string, unknown> | undefined): LoomyPoints {
  if (data === undefined) return {}
  const pick = (key: string): number | undefined => {
    const value = num(data[key])
    return value === undefined ? undefined : value
  }
  const permanent = pick("balance")
  const daily = pick("dailyBalance")
  const available = pick("availableBalance")
  const dailyQuota = pick("dailyQuota")
  const dailyConsumed = pick("dailyConsumed")
  const dailyCycleDate = str(data.dailyCycleDate)
  return {
    ...(permanent === undefined ? {} : { permanent }),
    ...(daily === undefined ? {} : { daily }),
    ...(available === undefined ? {} : { available }),
    ...(dailyQuota === undefined ? {} : { dailyQuota }),
    ...(dailyConsumed === undefined ? {} : { dailyConsumed }),
    ...(dailyCycleDate === undefined ? {} : { dailyCycleDate }),
  }
}

/** The balances, read-only: `points/records` has no side effects. */
export async function fetchPoints(fetcher: Fetcher, access: string): Promise<LoomyRead<LoomyPoints>> {
  const result = await productRead<Record<string, unknown>>(fetcher, access, LOOMY_PATHS.points)
  if (!result.ok) return result
  return { ok: true, data: readPoints(result.data) }
}

export interface LoomyDailyGrant extends LoomyPoints {
  /** True when the day's quota was already handed out. */
  alreadyProcessed: boolean
}

/**
 * Asks for the day's quota (`points/first-login`). It is what the vendor's
 * own client calls after a sign-in, and what its check-in button presses; it
 * is idempotent, and the answer carries the `dailyQuota` nothing else tells.
 */
export async function claimDailyQuota(fetcher: Fetcher, access: string): Promise<LoomyRead<LoomyDailyGrant>> {
  const result = await productRead<Record<string, unknown>>(fetcher, access, LOOMY_PATHS.firstLogin, {
    method: "POST",
    body: "{}",
  })
  if (!result.ok) return result
  return {
    ok: true,
    data: { ...readPoints(result.data), alreadyProcessed: result.data?.alreadyProcessed === true },
  }
}

// ---- WeChat's own pages ------------------------------------------------------

export function wechatAuthUrl(state: string): string {
  const query = new URLSearchParams({
    appid: LOOMY_WECHAT_APP_ID,
    redirect_uri: LOOMY_WECHAT_REDIRECT_URI,
    response_type: "code",
    scope: "snsapi_login",
    state,
  })
  return `https://open.weixin.qq.com/connect/qrconnect?${query.toString()}#wechat_redirect`
}

/** The uuid the authorization page carries, from either of its two forms. */
export function extractUuid(html: unknown): string {
  if (typeof html !== "string") return ""
  const pattern = /^[A-Za-z0-9_\-=+/]{6,64}$/
  const fromImage = html.match(/\/connect\/qrcode\/([A-Za-z0-9_\-=+/]+)/)
  if (fromImage?.[1] !== undefined && pattern.test(fromImage[1])) return fromImage[1]
  const fromPoll = html.match(/l\/qrconnect\?uuid=([A-Za-z0-9_\-=+/]+)/)
  if (fromPoll?.[1] !== undefined && pattern.test(fromPoll[1])) return fromPoll[1]
  return ""
}

export function wechatQrUrl(uuid: string): string {
  return `https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(uuid)}`
}

export interface LoomyQr {
  uuid: string
  /** The QR as a `data:` URL: the page inlines it, so it loads nothing. */
  image: string
}

/**
 * Fetches the authorization page, takes its uuid, and downloads the QR the
 * page would have shown. The page itself is never loaded in a browser: the
 * code comes from the long poll below.
 */
export async function fetchWechatQr(fetcher: Fetcher, state: string): Promise<LoomyQr> {
  const page = await httpJson(fetcher, wechatAuthUrl(state), {
    headers: { "User-Agent": LOOMY_WECHAT_UA, Referer: "https://open.weixin.qq.com/" },
    timeoutMs: 30_000,
  })
  if (!page.ok) throw new VendorError(VENDOR, `微信授权页返回 HTTP ${page.status}`)
  const uuid = extractUuid(page.text)
  if (uuid.length === 0) {
    throw new VendorError(VENDOR, "微信授权页里没有二维码 uuid（页面结构可能变了）")
  }
  const image = await httpBytes(fetcher, wechatQrUrl(uuid), {
    headers: { "User-Agent": LOOMY_WECHAT_UA, Referer: "https://open.weixin.qq.com/" },
    timeoutMs: 30_000,
  })
  if (!image.ok) throw new VendorError(VENDOR, `微信二维码返回 HTTP ${image.status}`)
  const mime = imageMime(image.bytes)
  if (mime === "" || image.bytes.length < 200) {
    throw new VendorError(VENDOR, "微信二维码不是图片（多半是错误页）")
  }
  return { uuid, image: `data:${mime};base64,${Buffer.from(image.bytes).toString("base64")}` }
}

/** By magic number: the service answers JPEG, but a PNG or GIF is still a QR. */
function imageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif"
  return ""
}

export type LoomyQrStatus = "waiting" | "scanned" | "confirmed" | "cancelled" | "expired" | "error"

export interface LoomyQrPoll {
  status: LoomyQrStatus
  /** Only when confirmed: the one-time WeChat code. */
  code: string
  /** The numeric `wx_errcode` from this frame; it is WeChat's `last` cursor. */
  errcode: string
}

/**
 * One long poll of WeChat's page.
 *
 * The statuses are the authorization page's own `switch(wx_errcode)`:
 * 408 waiting, 404 scanned and waiting for confirmation, 405 confirmed with
 * the code in that very frame, 403 cancelled, 402 the QR expired. Reading
 * 404 and 405 the other way round is a bug the vendor's own page disproves:
 * a user who confirms leaves the poll at 405, so waiting for a 404 with a
 * code waits forever (JetHub shipped that bug once).
 */
export async function pollWechat(
  fetcher: Fetcher,
  input: { uuid: string; last?: string },
): Promise<LoomyQrPoll> {
  const query = new URLSearchParams({ uuid: input.uuid, _: String(Date.now()) })
  if (input.last !== undefined && input.last.length > 0) query.set("last", input.last)
  let body: string
  try {
    const result = await httpJson<unknown>(
      fetcher,
      `https://long.open.weixin.qq.com/connect/l/qrconnect?${query.toString()}`,
      {
        headers: { "User-Agent": LOOMY_WECHAT_UA, Referer: wechatAuthUrl("") },
        timeoutMs: LOOMY_WECHAT_POLL_TIMEOUT_MS,
      },
    )
    body = result.text
  } catch {
    // A poll that failed is not the flow failing: the caller asks again.
    return { status: "error", code: "", errcode: "" }
  }
  const errcode = body.match(/wx_errcode\s*=\s*(\d+)/)?.[1] ?? ""
  const code = body.match(/wx_code\s*=\s*'([^']*)'/)?.[1] ?? ""
  switch (errcode) {
    case "405":
      // 405 without a code is the odd answer, not a success: keep waiting
      // rather than trade an empty code for a session.
      return code.length > 0
        ? { status: "confirmed", code, errcode }
        : { status: "scanned", code: "", errcode }
    case "404":
      return { status: "scanned", code: "", errcode }
    case "403":
      return { status: "cancelled", code: "", errcode }
    case "402":
      return { status: "expired", code: "", errcode }
    default:
      return { status: "waiting", code: "", errcode }
  }
}
