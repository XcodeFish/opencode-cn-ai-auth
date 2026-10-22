/**
 * AStudio 的 HTTP 方言：两种信封、两种鉴权头、每条端点的读写函数，以及
 * 微信扫码（SSO）登录与凭据交换的完整链路。
 *
 * 三条铁律（全部转引自 JetHub 实测，见 `product.ts` 模块头）：
 *
 * 1. **控制面信封先判码再判 data**：HTTP 恒 200，`code !== 0` 即失败；
 *    `code:0` 但 `data` 缺失/空也等价于「会话失效 / 无可用凭据」，只看 `code`
 *    会把它读成「成功但没内容」，随后崩在更远的解引用处。
 * 2. **推理面是 OpenAI 裸体**：成功原样透传，失败是 `{"error":{...}}` 配非 2xx；
 *    唯一的会话失效信号是 HTTP 401（流内 code 不参与凭据轮换）。
 * 3. **Cookie 四键同发**：`ssoSessionId` 与 `sso_sessionid` 同值各发一次是
 *    服务端认的键名集合，缺任一个都可能命中不同校验分支；缺失字段跳过键
 *    而不发空值（空 Cookie 项会让部分网关直接判未登录）。
 *
 * 每个函数都接收 `fetcher`，测试用离线假 fetch 驱动，不发真实请求。
 */

import { errorMessage, VendorError } from "../../core/errors.ts"
import { type Fetcher, httpJson } from "../../core/http.ts"
import { asArray, asObject, num, posInt, str, trimmedStr } from "../../core/json.ts"
import { randomHex } from "../../core/util.ts"
import {
  ASTUDIO_AUTH_BASE,
  ASTUDIO_CATALOG_BASE,
  ASTUDIO_CLIENT_TYPE,
  ASTUDIO_FD_ALPHABET,
  ASTUDIO_ID,
  ASTUDIO_LOGIN_TIMEOUT_MS,
  ASTUDIO_PATHS,
  ASTUDIO_POPUP_DAILY_REWARD,
  ASTUDIO_POPUP_NEW_USER,
  ASTUDIO_REQUEST_TIMEOUT_MS,
  ASTUDIO_SESSION_DEAD_CODES,
  ASTUDIO_SSO_BASE,
  ASTUDIO_STUDIO_VERSION,
} from "./product.ts"

// ── 会话失效判据 ─────────────────────────────────────────────────────────

/**
 * 控制面的「会话已死」判定。两格判据（顺序无关，缺一不可）：
 * ① 业务码命中实测失效码集合；② 文案明确含「登录」措辞（只认**明确**的词，
 * 不用泛化的「失败/错误」，否则一次 500 也会被读成要重新登录）。
 */
export function isSessionDead(code: number, message = ""): boolean {
  if (ASTUDIO_SESSION_DEAD_CODES.has(code)) return true
  return /未登录|重新登录|会话(已)?(过期|失效)|登录(状态)?失效|not\s+logged\s*in|login\s+required/i.test(
    message,
  )
}

// ── 信封 ────────────────────────────────────────────────────────────────

export interface EnvelopeSuccess {
  ok: true
  /** `data` 的对象形态（模型目录 `{models:[…]}` 走这里）。 */
  data: Record<string, unknown>
  /** `data` 的数组形态（`bot/models/configs` 就是数组）。两者必居其一。 */
  rows?: readonly unknown[]
}

export interface EnvelopeFailure {
  ok: false
  /** 业务码；读不出时为 -1。 */
  code: number
  /** 可读原因（`message` → `desc` → `code=N` 三级回退）。 */
  message: string
  /** 本失败是否意味着会话已死（必须人工重新登录）。 */
  sessionDead: boolean
}

export type Envelope = EnvelopeSuccess | EnvelopeFailure

/** 从 JSON 安全读字符串（兼容后端把数字写成 number）。 */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value === "string") return value
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
}

/** 从 JSON 安全读数字（兼容字符串形态；上界防溢出）。 */
function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15) return value
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed) && Math.abs(parsed) <= 1e15) return parsed
  }
  return undefined
}

/**
 * 解析控制面信封 `{code, message|desc, data}`。
 *
 * 四条判据缺一不可（JetHub 同款，逐条对应一类实测事故）：
 * 1. 响应体必须是对象；
 * 2. `code` **缺席**与 `code !== 0` 区分：上游确有不带 code 的端点形态，
 *    把「没有 code」当失败会让将来改形状的端点整体不可用；
 * 3. `code !== 0` 即失败（HTTP 200 不代表成功）；
 * 4. `code:0` 但 `data` 为 null/空对象/空数组 ⇒ 会话失效（终态）：
 *    实测无 Cookie 时回 `{code:99909001,desc:"系统异常",data:null}`，
 *    而 `bot/models/configs` 在无凭据时回 `{code:0,desc:"成功",data:[]}` ——
 *    两个形状都拿不到东西，都按终态报。
 * `data` 为数组时 `data` 给空对象、内容在 `rows`：唯一权威凭据源恰好是数组
 * 形态，只认对象形状的那份判据会让 401 自愈链永远读不到 api_key。
 */
export function parseEnvelope(body: unknown): Envelope {
  const record = asObject(body)
  if (record === undefined) {
    return { ok: false, code: -1, message: "响应不是 JSON 对象", sessionDead: false }
  }
  const rawCode = readNumber(record, "code")
  const message = readString(record, "message") || readString(record, "desc")
  if (rawCode !== undefined && rawCode !== 0) {
    return {
      ok: false,
      code: rawCode,
      message: message.length > 0 ? message : `code=${rawCode}`,
      sessionDead: ASTUDIO_SESSION_DEAD_CODES.has(rawCode) || isSessionDead(rawCode, message),
    }
  }
  const data = record.data
  if (data === null || data === undefined) {
    return {
      ok: false,
      code: rawCode ?? 0,
      message: message.length > 0 ? message : "data 为空（会话可能已失效）",
      sessionDead: true,
    }
  }
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return {
        ok: false,
        code: rawCode ?? 0,
        message: message.length > 0 ? message : "data 为空数组（会话可能已失效）",
        sessionDead: true,
      }
    }
    return { ok: true, data: {}, rows: data }
  }
  if (!asObject(data)) {
    return {
      ok: false,
      code: rawCode ?? 0,
      message: message.length > 0 ? message : "data 不是对象或数组",
      sessionDead: true,
    }
  }
  return { ok: true, data: data as Record<string, unknown> }
}

// ── 凭据形状与请求头 ────────────────────────────────────────────────────

/** 一次请求所需的登录态：推理侧的 Bearer 与控制面侧的 Cookie 字段。 */
export interface Session {
  /** 活体模型凭据（`Authorization: Bearer <accessToken>`，磁盘 `modelBearerToken` 同值）。 */
  accessToken: string
  /** 账号 id（控制面 Cookie 的 `account_id`；可选）。 */
  accountId?: string
  /** 用户 id（可选；展示与排障用）。 */
  uid?: string
  /** 登录会话 id（Cookie `ssoSessionId` 与 `sso_sessionid` 的同值键）。 */
  ssoSessionId?: string
  /** 账号后端 token（Cookie 第四字段；缺失时回落 ssoSessionId，见 `cookieHeader`）。 */
  token?: string
  /** 昵称（展示用；手机号显示前必须掩码）。 */
  nickname?: string
  /** 手机号（短信登录下发；展示用，显示前必须掩码）。 */
  mobile?: string
}

/**
 * 控制面用的 Cookie 串。实测客户端形态：`ssoSessionId` 与 `sso_sessionid`
 * 同值各发一次，加上 `account_id` 与 `token`；`token` 缺失时回落
 * `ssoSessionId`（JetHub 的 `completeAstudioLogin` 就是这么组装的）。
 * 缺失字段跳过键，不发空值。
 */
export function cookieHeader(session: Pick<Session, "ssoSessionId" | "accountId" | "token">): string {
  const sso = trimmedStr(session.ssoSessionId)
  const account = trimmedStr(session.accountId)
  const token = trimmedStr(session.token) ?? sso
  const pairs: Array<[string, string | undefined]> = [
    ["ssoSessionId", sso],
    ["sso_sessionid", sso],
    ["account_id", account],
    ["token", token],
  ]
  return pairs
    .filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].length > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ")
}

/**
 * 推理请求头。Bearer 是唯一必需项；`X-Account-Id` / `clientType` /
 * `studioVersion` 实测都不带也能 200，带上是为了与真实客户端形状一致
 * （服务端将来加强校验时不受影响）。
 */
export function chatHeaders(
  session: Pick<Session, "accessToken" | "accountId">,
  accept = "application/json",
): Record<string, string> {
  return {
    Accept: accept,
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.accessToken}`,
    ...(trimmedStr(session.accountId) === undefined ? {} : { "X-Account-Id": session.accountId as string }),
    clientType: ASTUDIO_CLIENT_TYPE,
    studioVersion: ASTUDIO_STUDIO_VERSION,
  }
}

/**
 * 控制面请求头。⚠️ **不带** `Authorization`：该端点按 Cookie 鉴权，客户端也只发
 * Accept + Cookie + 两个形状头；与客户端逐字一致是唯一不需要证明的选项。
 */
export function controlHeaders(
  session: Pick<Session, "ssoSessionId" | "accountId" | "token">,
): Record<string, string> {
  const cookie = cookieHeader(session)
  return {
    Accept: "application/json",
    ...(cookie.length === 0 ? {} : { Cookie: cookie }),
    clientType: ASTUDIO_CLIENT_TYPE,
    studioVersion: ASTUDIO_STUDIO_VERSION,
  }
}

// ── 模型目录（Bearer）───────────────────────────────────────────────────

/** 目录条目的精简视图（展示用；原始条目不外传）。 */
export interface CatalogModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  /** 远端 `supported_reasoning_levels[].effort`，原样保留下发顺序。 */
  efforts?: string[]
  /** 远端 `default_reasoning_level`（仅在落在 efforts 内时保留，见 models.ts）。 */
  defaultEffort?: string
  /** 远端 `input_modalities` 是否含 image（判据是远端字段，不是实测）。 */
  supportsImage: boolean
}

/** 目录读取结果：成功带条目，失败带可读原因与会话判据。 */
export type CatalogRead =
  | { ok: true; models: CatalogModel[] }
  | { ok: false; message: string; sessionDead: boolean }

/**
 * 读取模型目录 `GET /api/v1/model-manager/models`（Bearer 鉴权）。
 *
 * ⚠️ 不走 `/model-gateway/v1/models`：实测恒 404（三种头组合都试过），
 * 必须用同域的 `/api/v1/model-manager` 前缀。解析交给 `parseCatalog`。
 */
export async function fetchCatalog(
  fetcher: Fetcher,
  session: Pick<Session, "accessToken" | "accountId">,
): Promise<CatalogRead> {
  let result: Awaited<ReturnType<typeof httpJson>>
  try {
    result = await httpJson(fetcher, `${ASTUDIO_CATALOG_BASE}${ASTUDIO_PATHS.catalog}`, {
      headers: chatHeaders(session),
      timeoutMs: ASTUDIO_REQUEST_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, message: `模型目录读取失败（网络异常）：${errorMessage(error)}`, sessionDead: false }
  }
  if (result.status === 401) {
    return { ok: false, message: "模型目录被拒绝（登录态已失效），请重新登录", sessionDead: true }
  }
  if (!result.ok) {
    return { ok: false, message: `模型目录读取失败（HTTP ${result.status}）`, sessionDead: false }
  }
  return parseCatalog(result.json)
}

/** 解析目录信封：`{code:0,data:{models:[…]}}`。解析规则见 `models.ts` 的 `modelsFrom`。 */
export function parseCatalog(body: unknown): CatalogRead {
  const envelope = parseEnvelope(body)
  if (!envelope.ok) {
    return { ok: false, message: `模型目录失败 — ${envelope.message}`, sessionDead: envelope.sessionDead }
  }
  const models = asArray(envelope.data.models)
  if (models === undefined) {
    return { ok: false, message: "模型目录缺少 models 数组", sessionDead: false }
  }
  return { ok: true, models: modelsFrom(models) }
}

/**
 * 解开 acode 内核的内部别名 `builtin/<base64url(slug)>`。
 *
 * ⚠️ base64url 且无填充：`-`/`_` 必须先换成 `+`/`/`，否则含 `-` 的 slug
 * （`spark-x2.6-preview`）会解错。解不出（非 `builtin/` 前缀、解码含控制字符
 * 或 `/`）时**原样返回**：上游目录里本来就有裸 slug 形态，剥不出来就按它自己用。
 */
export function bareSlugOf(slug: string): string {
  if (!slug.startsWith("builtin/")) return slug
  const encoded = slug.slice("builtin/".length)
  try {
    const decoded = Buffer.from(encoded.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8")
    // 只接受「可打印且不含 '/'」的解码结果：替换字符（\uFFFD）与控制字符都说明
    // 这不是内部别名形态，原样返回。
    if (
      decoded.length > 0 &&
      decoded !== encoded &&
      !decoded.includes("\u0000") &&
      !decoded.includes("\uFFFD") &&
      !decoded.includes("/")
    ) {
      return decoded
    }
  } catch {
    // 解不出就原样返回，绝不抛 —— 目录解析失败会让整个 provider 不可用。
  }
  return slug
}

/** 单条目录记录 → 精简视图；`visibility: "hide"`（内部别名）不产出。 */
function catalogModelOf(record: Record<string, unknown>): CatalogModel | undefined {
  const rawSlug = trimmedStr(record.slug)
  if (rawSlug === undefined) return undefined
  if (trimmedStr(record.visibility) === "hide") return undefined
  const id = bareSlugOf(rawSlug)
  const efforts =
    asArray(record.supported_reasoning_levels)
      ?.map((level) => trimmedStr(asObject(level)?.effort))
      .filter((effort): effort is string => effort !== undefined) ?? []
  const defaultEffort = trimmedStr(record.default_reasoning_level)
  const modalities =
    asArray(record.input_modalities)?.filter((item): item is string => typeof item === "string") ?? []
  const contextWindow = readNumber(record, "context_window")
  const maxTokens = readNumber(record, "max_output_tokens")
  return {
    id,
    name: trimmedStr(record.display_name) ?? id,
    ...(contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : {}),
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    ...(efforts.length > 0 ? { efforts } : {}),
    // defaultEffort 只在落在 efforts 集合内时保留：指到集合外会让整条档位声明
    // 被宿主静默丢弃（JetHub 对 DSH 的同款告诫）。
    ...(defaultEffort !== undefined && efforts.includes(defaultEffort) ? { defaultEffort } : {}),
    supportsImage: modalities.some((item) => item.toLowerCase() === "image"),
  }
}

/** 整份目录 → 精简条目，按裸 slug 去重，保持服务返回顺序。 */
export function modelsFrom(entries: readonly unknown[]): CatalogModel[] {
  const out: CatalogModel[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const record = asObject(entry)
    if (record === undefined) continue
    const model = catalogModelOf(record)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    out.push(model)
  }
  return out
}

// ── 活体凭据（控制面，Cookie）────────────────────────────────────────────

export interface ApiKeyPick {
  /** 取到的 `api_key`；没取到为空串。 */
  apiKey: string
  /** 命中方式；`none` = 一条可用 api_key 都没有。 */
  via: "current" | "default" | "first" | "none"
  /** 没取到时的可读原因。 */
  reason?: string
}

/**
 * 从 `bot/models/configs` 的响应里取活体凭据。
 *
 * 优先级与客户端一致：`is_current === true` 的行优先，无则 `is_default === true`，
 * 再无则第一条 `api_key` 非空的行。⚠️ 不是「命中 is_current 就只看那一行」：
 * 实测后端偶发下发 `api_key:""`，此时必须继续往下找，否则把「还能救」的账号
 * 判成「无凭据」。判据是行内标志的**值**，不做任何名单猜测。
 */
export function pickApiKey(body: unknown): ApiKeyPick {
  const envelope = parseEnvelope(body)
  if (!envelope.ok) {
    // code:0 + 空 data 的「成功」信封里拿不到东西：文案用结构化原因，
    // 不把信封的「成功」当失败原因（那是自相矛盾的 UI 文案，JetHub 同款教训）。
    if (envelope.code === 0) {
      return { apiKey: "", via: "none", reason: "账号后端返回 0 条配置但没有任何可用 api_key" }
    }
    return { apiKey: "", via: "none", reason: envelope.message }
  }
  const rows = envelope.rows ?? asArray(envelope.data.configs) ?? []
  const usable: Array<{ apiKey: string; via: ApiKeyPick["via"] }> = []
  for (const row of rows) {
    const record = asObject(row)
    if (record === undefined) continue
    const apiKey = trimmedStr(record.api_key)
    if (apiKey === undefined) continue
    if (record.is_current === true) usable.push({ apiKey, via: "current" })
    else if (record.is_default === true) usable.push({ apiKey, via: "default" })
    else usable.push({ apiKey, via: "first" })
  }
  const current = usable.find((row) => row.via === "current")
  if (current !== undefined) return { apiKey: current.apiKey, via: "current" }
  const fallback = usable.find((row) => row.via === "default")
  if (fallback !== undefined) return { apiKey: fallback.apiKey, via: "default" }
  const first = usable[0]
  if (first !== undefined) return { apiKey: first.apiKey, via: "first" }
  return {
    apiKey: "",
    via: "none",
    reason: `账号后端返回 ${rows.length} 条配置但没有任何可用 api_key`,
  }
}

export type ConfigsRead = { ok: true; apiKey: string } | { ok: false; message: string; sessionDead: boolean }

/**
 * 读一次活体凭据 `GET /bot/models/configs`（Cookie 鉴权，**不带** Bearer）。
 * 这是 401 自愈链与登录收尾共用的唯一权威源；失败时区分「终态」与「可重试」。
 */
export async function fetchApiKeyConfigs(
  fetcher: Fetcher,
  session: Pick<Session, "ssoSessionId" | "accountId" | "token">,
): Promise<ConfigsRead> {
  if (cookieHeader(session).length === 0) {
    return { ok: false, message: "账号里没有登录会话 Cookie，请重新登录", sessionDead: true }
  }
  let result: Awaited<ReturnType<typeof httpJson>>
  try {
    result = await httpJson(fetcher, `${ASTUDIO_AUTH_BASE}${ASTUDIO_PATHS.apiKeyConfigs}`, {
      headers: controlHeaders(session),
      timeoutMs: ASTUDIO_REQUEST_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, message: `凭据重取失败（网络异常）：${errorMessage(error)}`, sessionDead: false }
  }
  if (!result.ok) {
    // 实测正常与「未登录」都回 200；非 2xx 只可能是网关/服务端故障 ⇒ 可重试。
    return { ok: false, message: `凭据重取失败（HTTP ${result.status}）`, sessionDead: false }
  }
  const pick = pickApiKey(result.json)
  if (pick.apiKey.length === 0) {
    const message = pick.reason ?? "账号后端没有可用的推理凭据（api_key）"
    const envelope = parseEnvelope(result.json)
    const dead = !envelope.ok ? envelope.sessionDead : true
    return { ok: false, message, sessionDead: dead }
  }
  return { ok: true, apiKey: pick.apiKey }
}

// ── 登录收尾（init-app → userInfo → configs）────────────────────────────

export interface LoginIdentity {
  /** 用户 id（SSO `uids` 下发的 `uid`；与账号 id 同值时互为兜底）。 */
  uid: string
  /** 登录会话 id。 */
  ssoSessionId: string
  /** 展示名（SSO `username` 或 userInfo 的昵称；手机号显示前必须掩码）。 */
  nickname?: string
  /** 登录方式标记（`wechat` / `sms` / `password`；仅展示与排障）。 */
  loginMethod: string
  /**
   * 账号后端 token（Cookie 第四字段）。短信/密码登录的应答可能下发独立的
   * `token`；缺失时回落 `ssoSessionId`（JetHub `completeAstudioLogin` 同款）。
   */
  token?: string
  /** 账号 id（缺失时回落 `uid`）。 */
  accountId?: string
  /** 手机号（短信登录下发；仅展示，显示前必须掩码）。 */
  mobile?: string
}

export type CompleteLoginResult =
  | { ok: true; session: Session }
  | { ok: false; message: string; sessionDead: boolean }

/**
 * 凭据交换与会话初始化（JetHub `completeAstudioLogin` 同款三步）：
 *
 * 1. `POST /tenant-app/v2/init-app` —— 租户开户初始化，**非阻塞**：
 *    失败可忽略（它对已注册账号是幂等的，对新账号是开户的先手）；
 * 2. `GET /userInfo` —— 昵称（仅微信登录调用；失败降级用 SSO 给的名字）；
 * 3. `GET /bot/models/configs` —— 换取 `api_key`，**唯一硬门槛**：
 *    拿不到就整次登录失败（账号多半还没在客户端里完成首次开通）。
 */
export async function completeLogin(fetcher: Fetcher, identity: LoginIdentity): Promise<CompleteLoginResult> {
  const ssoSessionId = identity.ssoSessionId
  const uid = identity.uid
  const accountId = identity.accountId ?? uid
  const control = { ssoSessionId, accountId, token: identity.token ?? ssoSessionId }

  try {
    await httpJson(fetcher, `${ASTUDIO_AUTH_BASE}${ASTUDIO_PATHS.initApp}`, {
      method: "POST",
      headers: { Accept: "application/json", Cookie: cookieHeader(control) },
      timeoutMs: ASTUDIO_LOGIN_TIMEOUT_MS,
    })
  } catch {
    // init-app 非阻塞：失败不阻断登录（JetHub 同款）。
  }

  let nickname = identity.nickname
  if (identity.loginMethod === "wechat") {
    try {
      const user = await httpJson(fetcher, `${ASTUDIO_AUTH_BASE}${ASTUDIO_PATHS.userInfo}`, {
        headers: controlHeaders(control),
        timeoutMs: ASTUDIO_LOGIN_TIMEOUT_MS,
      })
      if (user.ok) {
        const body = asObject(user.json)
        const data = asObject(body?.data) ?? body ?? {}
        const candidate = trimmedStr(data.nickname) ?? trimmedStr(data.mobile) ?? trimmedStr(data.username)
        if (candidate !== undefined) nickname = candidate
      }
    } catch {
      // userInfo 降级：昵称用 SSO 给的或账号 id。
    }
  }

  const configs = await fetchApiKeyConfigs(fetcher, control)
  if (!configs.ok) return { ok: false, message: configs.message, sessionDead: configs.sessionDead }
  return {
    ok: true,
    session: {
      accessToken: configs.apiKey,
      accountId,
      uid,
      ssoSessionId,
      token: control.token,
      ...(nickname === undefined ? {} : { nickname }),
      ...(identity.mobile === undefined ? {} : { mobile: identity.mobile }),
    },
  }
}

// ── 微信扫码（SSO）──────────────────────────────────────────────────────

/** 生成 8 位随机 `fd`（官方微信扫码唯一凭证，字符表抄自 JetHub）。 */
export function generateFd(bytes = 8): string {
  const raw = new Uint8Array(bytes)
  crypto.getRandomValues(raw)
  let out = ""
  for (const byte of raw) out += ASTUDIO_FD_ALPHABET[byte % ASTUDIO_FD_ALPHABET.length]
  return out
}

export interface WechatQr {
  fd: string
  /** 二维码图片地址（微信 `showqrcode` ticket URL，由登录页下载内联）。 */
  qrUrl: string
  expiresInMs: number
}

/**
 * 申请微信扫码二维码 `GET /SSOService/wx/scanlogin/qrcode?fd=`。
 * 成功信封 `{code:0, data:"https://mp.weixin.qq.com/…showqrcode…"}`。
 */
export async function createWechatQr(
  fetcher: Fetcher,
  fd: string,
): Promise<{ ok: true; qr: WechatQr } | { ok: false; message: string }> {
  let result: Awaited<ReturnType<typeof httpJson>>
  try {
    result = await httpJson(
      fetcher,
      `${ASTUDIO_SSO_BASE}${ASTUDIO_PATHS.ssoQrcode}?fd=${encodeURIComponent(fd)}`,
      {
        headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
        timeoutMs: ASTUDIO_LOGIN_TIMEOUT_MS,
      },
    )
  } catch (error) {
    return { ok: false, message: `获取微信扫码二维码失败（网络异常）：${errorMessage(error)}` }
  }
  if (!result.ok) {
    return { ok: false, message: `获取微信扫码二维码失败（HTTP ${result.status}）` }
  }
  const record = asObject(result.json)
  const code = record?.code
  if (code !== 0 && code !== "0") {
    const reason =
      str(record?.desc) ??
      str(record?.message) ??
      (code === undefined ? "响应缺少 code" : `code=${String(code)}`)
    return { ok: false, message: `获取微信扫码二维码失败：${reason}` }
  }
  const qrUrl = typeof record?.data === "string" ? record.data : ""
  if (qrUrl.length === 0) {
    return { ok: false, message: "获取微信扫码二维码失败：未返回二维码 URL" }
  }
  return { ok: true, qr: { fd, qrUrl, expiresInMs: 300_000 } }
}

export interface WechatAccount {
  uid: string
  ssoSessionId: string
  username?: string
}

export type WechatPoll =
  | { status: "pending"; message?: string }
  | { status: "scanned"; account: WechatAccount; accounts: WechatAccount[] }
  | { status: "unbound"; message: string }
  | { status: "error"; code: number | string; message: string }

/**
 * 轮询扫码状态 `GET /SSOService/wx/scanlogin/uids?fd=`。
 *
 * 状态机（JetHub 实测 + 2026-10-20 报障修正）：
 * - `code:-1` 未扫码 → pending；
 * - `code:0` 且 `data` 数组（或 `data.infoList`）带账号 → scanned；
 *   `uid` 与 `ssoSessionId` **互为兜底**（`ssoSessionId` 缺失时还认 `token`，
 *   最终回落 `uid`）—— 上游在部分路径下只给其中一个，三入口同款容错，
 *   口径不一致会让只有扫码这一条登录失败；
 * - `code:0` 但列表为空 → **unbound**：该微信号尚未开通 AStudio 账号。
 *   ⚠️ 信封的 `desc:"成功"` 只是请求状态，与「有没有开通」无关；文案必须指向
 *   有效动作（先在 AStudio 客户端登录并绑定手机号），叫用户「重新扫码」是假出路；
 * - 其余 → error（原样带码）。
 */
export async function pollWechatScan(fetcher: Fetcher, fd: string): Promise<WechatPoll> {
  let result: Awaited<ReturnType<typeof httpJson>>
  try {
    result = await httpJson(
      fetcher,
      `${ASTUDIO_SSO_BASE}${ASTUDIO_PATHS.ssoUids}?fd=${encodeURIComponent(fd)}`,
      {
        headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
        timeoutMs: ASTUDIO_LOGIN_TIMEOUT_MS,
      },
    )
  } catch (error) {
    return { status: "error", code: -1, message: `轮询扫码状态网络异常：${errorMessage(error)}` }
  }
  if (!result.ok) {
    return { status: "error", code: result.status, message: `轮询扫码状态失败（HTTP ${result.status}）` }
  }
  const record = asObject(result.json)
  if (record === undefined) {
    return { status: "error", code: -1, message: "轮询扫码状态失败（响应不是 JSON 对象）" }
  }
  const rawCode = record.code
  if (rawCode === -1 || rawCode === "-1") {
    const pending = str(record.desc)
    return { status: "pending", ...(pending === undefined ? {} : { message: pending }) }
  }
  if (rawCode === 0 || rawCode === "0") {
    const accounts = accountsOf(record.data)
    if (accounts.length === 0) {
      return {
        status: "unbound",
        message:
          "该微信号尚未开通 AStudio 账号 ⇒ 请先在 AStudio 客户端里用该微信登录并绑定手机号完成开通，再回来扫码",
      }
    }
    return { status: "scanned", account: accounts[0] as WechatAccount, accounts }
  }
  return {
    status: "error",
    code: typeof rawCode === "number" || typeof rawCode === "string" ? rawCode : -1,
    message: str(record.desc) ?? String(rawCode ?? -1),
  }
}

/** 扫码答案的两种形态：`data` 直接是数组，或 `data.infoList` 是数组。 */
function accountsOf(data: unknown): WechatAccount[] {
  const direct = asArray(data)
  const list = direct ?? asArray(asObject(data)?.infoList) ?? []
  const accounts: WechatAccount[] = []
  for (const item of list) {
    const record = asObject(item)
    if (record === undefined) continue
    const uid = trimmedStr(record.uid) ?? trimmedStr(record.accountId) ?? ""
    const ssoSessionId =
      trimmedStr(record.ssoSessionId) ?? trimmedStr(record.sso_session_id) ?? trimmedStr(record.token) ?? uid
    if (uid.length === 0 && ssoSessionId.length === 0) continue
    accounts.push({
      uid: uid.length > 0 ? uid : ssoSessionId,
      ssoSessionId: ssoSessionId.length > 0 ? ssoSessionId : uid,
      ...(str(record.username) === undefined ? {} : { username: str(record.username) as string }),
    })
  }
  return accounts
}

export type WechatBind = { ok: true } | { ok: false; message: string }

/**
 * 确认绑定 `POST /SSOService/wx/scanlogin/bind`（表单）。
 * 成功判据 `code === 0` 或 `flag === true`；响应不是 JSON 时按成功处理
 * （JetHub 同款：该端点在部分网关后回空体，绑定结果由后续 configs 请求验证）。
 */
export async function bindWechatSession(
  fetcher: Fetcher,
  input: { fd: string; account: WechatAccount },
): Promise<WechatBind> {
  const params = new URLSearchParams({
    fd: input.fd,
    accountId: input.account.uid,
    ...(input.account.ssoSessionId.length > 0 ? { ssoSessionId: input.account.ssoSessionId } : {}),
    isNew: "false",
  })
  let result: Awaited<ReturnType<typeof httpJson>>
  try {
    result = await httpJson(fetcher, `${ASTUDIO_SSO_BASE}${ASTUDIO_PATHS.ssoBind}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: params.toString(),
      timeoutMs: ASTUDIO_LOGIN_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, message: `绑定微信登录会话网络异常：${errorMessage(error)}` }
  }
  if (!result.ok) {
    return { ok: false, message: `绑定微信登录会话失败（HTTP ${result.status}）` }
  }
  const record = asObject(result.json)
  if (record === undefined) return { ok: true }
  if (record.code === 0 || record.code === "0" || record.flag === true) return { ok: true }
  return {
    ok: false,
    message: str(record.desc) ?? str(record.message) ?? `code=${String(record.code ?? "")}`,
  }
}

// ── 积分余额（控制面，Cookie）────────────────────────────────────────────

/** `points/balance` 的一个积分池（会员 / 购买 / 赠送 / 星火）。 */
export interface CreditPool {
  name: string
  remaining: number
  total?: number
  /** 池的到期时刻（epoch ms；上游给不带时区的本地时间串，按本机时区解析）。 */
  expiresAtMs?: number
  /** 上游到期串原样（展示用）。 */
  expiresAtRaw?: string
}

export interface CreditBalance {
  /** 主池可用合计（上游权威字段 `totalBalance`，**不是**逐包求和）。 */
  total: number
  /** 累计发放（`totalAmount`；缺失时 undefined）。 */
  totalAmount?: number
  pools: CreditPool[]
}

export type BalanceRead =
  | { ok: true; balance: CreditBalance }
  | { ok: false; message: string; sessionDead: boolean }

/** 上游「不带时区的本地时间串」→ epoch ms（按本机时区；未验证服务端时区，如实登记）。 */
function localTimeMs(source: Record<string, unknown>, key: string): number | undefined {
  const raw = str(source[key])
  if (raw === undefined || raw.length === 0) return undefined
  const ms = Date.parse(raw.replaceAll(" ", "T").replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})$/, "$1"))
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

function poolOf(
  data: Record<string, unknown>,
  name: string,
  totalKey: string,
  balanceKey: string,
  expireKey: string,
): CreditPool | undefined {
  const remaining = readNumber(data, balanceKey)
  if (remaining === undefined) return undefined // 该池不下发 ⇒ 不臆造条目
  return {
    name,
    remaining,
    ...(readNumber(data, totalKey) === undefined ? {} : { total: readNumber(data, totalKey) as number }),
    ...(localTimeMs(data, expireKey) === undefined
      ? {}
      : { expiresAtMs: localTimeMs(data, expireKey) as number }),
    ...(str(data[expireKey]) === undefined ? {} : { expiresAtRaw: str(data[expireKey]) as string }),
  }
}

/**
 * `points/balance` 的 data → 池列表。
 *
 * 口径与客户端一致：`total` 用上游权威字段 `totalBalance`（主池可用合计），
 * **不**逐包求和 —— 实测 `totalBalance === activityBalance`，而星火池是
 * 互不相通的独立池，求和会凭空多出星火那份。星火池缺席时**不生成**条目
 * （生成一个 `remaining: 0` 的星火包会让用户以为星火没了）。
 */
export function balanceOf(data: Record<string, unknown>): CreditBalance | undefined {
  const total = readNumber(data, "totalBalance")
  if (total === undefined) return undefined // 形状不认识 ⇒ 调用侧报「未包含余额字段」，不编造 0
  const pools: CreditPool[] = []
  const member = poolOf(data, "会员积分", "memberTotal", "memberBalance", "memberNextExpireTime")
  if (member !== undefined) pools.push(member)
  const buy = poolOf(data, "购买积分", "buyTotal", "buyBalance", "buyNextExpireTime")
  if (buy !== undefined) pools.push(buy)
  const activity = poolOf(data, "赠送积分", "activityTotal", "activityBalance", "activityNextExpireTime")
  if (activity !== undefined) pools.push(activity)
  const spark = poolOf(
    data,
    "星火积分（独立池）",
    "sparkTotalAmount",
    "sparkTotalBalance",
    "sparkNextExpireTime",
  )
  if (spark !== undefined) pools.push(spark)
  return {
    total,
    ...(readNumber(data, "totalAmount") === undefined
      ? {}
      : { totalAmount: readNumber(data, "totalAmount") as number }),
    pools,
  }
}

/** 余额只读：`points/balance` 无副作用。失败区分「会话已死」与「可重试」。 */
export async function fetchBalance(
  fetcher: Fetcher,
  session: Pick<Session, "ssoSessionId" | "accountId" | "token">,
): Promise<BalanceRead> {
  if (cookieHeader(session).length === 0) {
    return { ok: false, message: "账号里没有登录会话 Cookie，请重新登录", sessionDead: true }
  }
  let result: Awaited<ReturnType<typeof httpJson>>
  try {
    result = await httpJson(fetcher, `${ASTUDIO_AUTH_BASE}${ASTUDIO_PATHS.pointsBalance}`, {
      headers: controlHeaders(session),
      timeoutMs: ASTUDIO_REQUEST_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, message: `积分查询失败（网络异常）：${errorMessage(error)}`, sessionDead: false }
  }
  if (!result.ok) {
    return { ok: false, message: `积分查询失败（HTTP ${result.status}）`, sessionDead: false }
  }
  const envelope = parseEnvelope(result.json)
  if (!envelope.ok) {
    if (envelope.sessionDead) {
      return { ok: false, message: "AStudio 登录会话已失效，请重新登录", sessionDead: true }
    }
    return { ok: false, message: `积分查询失败：${envelope.message}`, sessionDead: false }
  }
  const balance = balanceOf(envelope.data)
  if (balance === undefined) {
    return { ok: false, message: "积分查询失败：响应未包含余额字段", sessionDead: false }
  }
  return { ok: true, balance }
}

// ── 弹窗奖励（每日签到 + 新手礼包）───────────────────────────────────────

export interface ClaimablePopup {
  popupId: number
  instanceKey: string
  type: string
}

/**
 * 弹窗的类型字段。⚠️ 真实字段是 **`componentType`** 而不是 `type`
 * （JetHub 2026-10-20 真机取证：响应里没有 `type` 键，读它会一个可领弹窗
 * 都识别不出来 ⇒ 界面显示「今天已领取」而积分一动不动）。仍兼容 `type`，
 * 但优先 `componentType`。
 */
function popupTypeOf(record: Record<string, unknown>): string {
  return trimmedStr(record.componentType) ?? trimmedStr(record.type) ?? ""
}

/** 待领取的每日签到 / 新手礼包弹窗（按 popupId 去重，保持返回顺序）。 */
export function claimablePopups(data: unknown): ClaimablePopup[] {
  const list = asArray(data) ?? []
  const out: ClaimablePopup[] = []
  const seen = new Set<number>()
  for (const item of list) {
    const record = asObject(item)
    if (record === undefined) continue
    const type = popupTypeOf(record)
    if (type !== ASTUDIO_POPUP_DAILY_REWARD && type !== ASTUDIO_POPUP_NEW_USER) continue
    const popupId = posInt(record.popupId)
    if (popupId === undefined || seen.has(popupId)) continue
    seen.add(popupId)
    out.push({ popupId, instanceKey: str(record.instanceKey) ?? "", type })
  }
  return out
}

export type ClaimOutcome =
  | { outcome: "done"; message: string }
  | { outcome: "claimed"; credit?: number; message: string }
  | { outcome: "failed"; message: string }
  | { outcome: "captcha"; message: string }

/**
 * 每日签到与福利领取（JetHub `claimAstudioDailyReward` 同款两步）：
 *
 * 1. `GET /client-popups/pending` —— 空数组 = 今日已领（`done`，不发写请求）；
 * 2. 对每个可领弹窗 `POST /client-popups/complete {popupId, instanceKey}`。
 *
 * 积分数读弹窗 `payload` 的尽力而为（上游不保证下发）；失败不中断整次领取
 * （一个弹窗被拒不影响其余），会话失效立即停手。
 */
export async function claimDaily(
  fetcher: Fetcher,
  session: Pick<Session, "ssoSessionId" | "accountId" | "token">,
): Promise<ClaimOutcome> {
  if (cookieHeader(session).length === 0) {
    return { outcome: "failed", message: "账号里没有登录会话 Cookie，请重新登录" }
  }
  let pending: Awaited<ReturnType<typeof httpJson>>
  try {
    pending = await httpJson(fetcher, `${ASTUDIO_AUTH_BASE}${ASTUDIO_PATHS.popupsPending}`, {
      headers: controlHeaders(session),
      timeoutMs: ASTUDIO_REQUEST_TIMEOUT_MS,
    })
  } catch (error) {
    return { outcome: "failed", message: `每日签到查询失败（网络异常）：${errorMessage(error)}` }
  }
  if (!pending.ok) {
    return { outcome: "failed", message: `每日签到查询失败（HTTP ${pending.status}）` }
  }
  const envelope = parseEnvelope(pending.json)
  // ⚠️ 与 configs/balance 不同：`data: []` 在这里是**合法的空结果**（当日已领），
  // 不是会话失效 —— 「空 data = 终态」那条规则只对凭据源成立。所以 code:0 的
  // 空数据落到「无可领弹窗」，只有 code !== 0 才进失败分支。
  if (!envelope.ok && envelope.code !== 0) {
    if (envelope.sessionDead) {
      return { outcome: "failed", message: "AStudio 登录会话已失效，请重新登录" }
    }
    return { outcome: "failed", message: `每日签到查询失败：${envelope.message}` }
  }
  const popups = claimablePopups(envelope.ok ? (envelope.rows ?? asArray(envelope.data) ?? []) : [])
  if (popups.length === 0) {
    return { outcome: "done", message: "今日奖励已领取（或暂无可领福利）" }
  }
  let credit = 0
  const claimed: string[] = []
  const failed: string[] = []
  for (const popup of popups) {
    let complete: Awaited<ReturnType<typeof httpJson>>
    try {
      complete = await httpJson(fetcher, `${ASTUDIO_AUTH_BASE}${ASTUDIO_PATHS.popupsComplete}`, {
        method: "POST",
        headers: { ...controlHeaders(session), "Content-Type": "application/json" },
        body: JSON.stringify({ popupId: popup.popupId, instanceKey: popup.instanceKey }),
        timeoutMs: ASTUDIO_REQUEST_TIMEOUT_MS,
      })
    } catch (error) {
      failed.push(`${popupTypeLabel(popup.type)}（网络异常：${errorMessage(error)}）`)
      continue
    }
    const record = asObject(complete.json)
    const code = num(record?.code)
    if (!complete.ok || (code !== undefined && code !== 0) || record?.flag === false) {
      failed.push(
        `${popupTypeLabel(popup.type)}（${
          str(record?.message) ?? str(record?.desc) ?? `HTTP ${complete.status}`
        }）`,
      )
      continue
    }
    claimed.push(popupTypeLabel(popup.type))
    credit += popupCredit(popup, record)
  }
  if (claimed.length === 0) {
    return { outcome: "failed", message: `领取失败：${failed.join("；")}` }
  }
  const parts = [`已领取 ${claimed.join("、")}`]
  if (credit > 0) parts.push(`+${credit} 积分`)
  if (failed.length > 0) parts.push(`；${failed.join("；")} 未成功，下次签到再试`)
  return { outcome: "claimed", ...(credit > 0 ? { credit } : {}), message: parts.join("") }
}

function popupTypeLabel(type: string): string {
  return type === ASTUDIO_POPUP_DAILY_REWARD
    ? "每日签到"
    : type === ASTUDIO_POPUP_NEW_USER
      ? "新手礼包"
      : type
}

/** 弹窗积分数的尽力读取：payload.points → 顶层 points/credit/rewardPoints。 */
function popupCredit(popup: ClaimablePopup, complete: Record<string, unknown> | undefined): number {
  const candidates = [complete?.data, complete?.payload, popup]
  for (const candidate of candidates) {
    const record = asObject(candidate)
    if (record === undefined) continue
    for (const key of ["points", "credit", "rewardPoints", "reward_points"]) {
      const value = num(record[key])
      if (value !== undefined && value > 0) return Math.floor(value)
    }
    const payload = asObject(record.payload)
    if (payload !== undefined) {
      const inner = num(payload.points)
      if (inner !== undefined && inner > 0) return Math.floor(inner)
    }
  }
  return 0
}

// ── 短信 / 密码登录（极验 GeeTest）─────────────────────────────────────────

/** 极验初始化配置（页面侧 `initGeetest` 的入参）。 */
export interface GeeTestConfig {
  gt: string
  challenge: string
  success: boolean
  newCaptcha: boolean
}

/** 页面完成滑块后的极验回执三件套。 */
export interface GeeTestResult {
  geetestChallenge: string
  geetestValidate: string
  geetestSeccode: string
}

/**
 * multipart 表单体构造。四条登录端点都吃 multipart 表单（JetHub 用 FormData）；
 * 字段全为 ASCII（手机号 / 国家码 / 极验 hex 与 base64 串），可安全按字符串拼装。
 * `geetest_seccode` 与 JetHub 同款先 base64 再入表单。
 */
function multipartOf(fields: Record<string, string>): { body: string; contentType: string } {
  const boundary = `----cn-ai-${randomHex(12)}`
  const parts: string[] = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${name}"`, "", value)
  }
  parts.push(`--${boundary}--`, "")
  return { body: parts.join("\r\n"), contentType: `multipart/form-data; boundary=${boundary}` }
}

function vendorMessage(record: Record<string, unknown> | undefined, fallback: string): string {
  const message = trimmedStr(record?.desc) ?? trimmedStr(record?.message) ?? trimmedStr(record?.msg)
  return message ?? fallback
}

/** 业务码判据：`code` 缺席也算成功（JetHub 三条登录端点同款容错）。 */
function businessOk(record: Record<string, unknown> | undefined): boolean {
  const code = num(record?.code)
  return code === undefined || code === 0
}

/**
 * 拉极验配置 `GET /chat/gee-captcha?t=`（无 Cookie）。
 * 成功信封 `{code:0|缺席, data:{gt, challenge, success, new_captcha}}`。
 */
export async function fetchGeetestConfig(
  fetcher: Fetcher,
): Promise<{ ok: true; config: GeeTestConfig } | { ok: false; message: string }> {
  let result: Awaited<ReturnType<typeof httpJson>>
  try {
    result = await httpJson(fetcher, `${ASTUDIO_AUTH_BASE}${ASTUDIO_PATHS.geeCaptcha}?t=${Date.now()}`, {
      headers: { Accept: "application/json" },
      timeoutMs: ASTUDIO_LOGIN_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, message: `获取安全验证配置失败（网络异常）：${errorMessage(error)}` }
  }
  if (!result.ok) {
    return { ok: false, message: `获取安全验证配置失败（HTTP ${result.status}）` }
  }
  const record = asObject(result.json)
  if (!businessOk(record)) {
    return { ok: false, message: `获取安全验证配置失败：${vendorMessage(record, "业务码非 0")}` }
  }
  const data = asObject(record?.data) ?? record ?? {}
  const gt = trimmedStr(data.gt)
  const challenge = trimmedStr(data.challenge)
  if (gt === undefined || challenge === undefined) {
    return { ok: false, message: "安全验证配置响应缺失 gt 或 challenge 字段" }
  }
  const success = data.success === undefined ? true : data.success !== false && data.success !== 0
  return {
    ok: true,
    config: { gt, challenge, success, newCaptcha: data.new_captcha === true },
  }
}

/** 极验三件套完整性校验（发送短信与密码登录共用）。 */
export function geeTestComplete(captcha: GeeTestResult): boolean {
  return (
    captcha.geetestChallenge.length > 0 &&
    captcha.geetestValidate.length > 0 &&
    captcha.geetestSeccode.length > 0
  )
}

/**
 * 发送短信验证码 `POST /login/mobile/send-verify-code`（multipart + 极验三件套，
 * `geetest_seccode` base64 后入表单 —— 与 JetHub 逐字一致）。
 */
export async function sendSmsCode(
  fetcher: Fetcher,
  input: { mobile: string; countryCode?: string; captcha: GeeTestResult },
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  if (input.mobile.trim().length === 0) return { ok: false, message: "手机号不能为空" }
  if (!geeTestComplete(input.captcha)) return { ok: false, message: "缺少安全验证参数，请先完成人机验证" }
  const form = multipartOf({
    mobile: input.mobile.trim(),
    countryCode: input.countryCode ?? "86",
    geetest_challenge: input.captcha.geetestChallenge,
    geetest_validate: input.captcha.geetestValidate,
    geetest_seccode: Buffer.from(input.captcha.geetestSeccode, "utf8").toString("base64"),
  })
  let result: Awaited<ReturnType<typeof httpJson>>
  try {
    result = await httpJson(fetcher, `${ASTUDIO_AUTH_BASE}${ASTUDIO_PATHS.sendVerifyCode}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": form.contentType },
      body: form.body,
      timeoutMs: ASTUDIO_LOGIN_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, message: `发送短信验证码失败（网络异常）：${errorMessage(error)}` }
  }
  if (!result.ok) return { ok: false, message: `发送短信验证码失败（HTTP ${result.status}）` }
  const record = asObject(result.json)
  if (!businessOk(record)) {
    return { ok: false, message: `发送短信验证码失败：${vendorMessage(record, "业务码非 0")}` }
  }
  return { ok: true, message: vendorMessage(record, "短信验证码已发送") }
}

/**
 * 从短信/密码登录应答里取会话标识：`uid` 与 `ssoSessionId` **互为兜底**
 * （`ssoSessionId` 缺失时还认 `token`；与扫码同款容错 —— 上游在部分路径下
 * 只给其中一个，三入口口径不一致会让只有某一条登录失败）。
 */
function identityFrom(
  record: Record<string, unknown>,
  input: { loginMethod: string; mobile?: string; username?: string },
): LoginIdentity {
  const data = asObject(record.data) ?? record
  const uid = trimmedStr(data.uid) ?? trimmedStr(data.account_id) ?? ""
  const ssoSessionId = trimmedStr(data.ssoSessionId) ?? trimmedStr(data.token) ?? (uid.length > 0 ? uid : "")
  if (uid.length === 0 && ssoSessionId.length === 0) {
    throw new VendorError(ASTUDIO_ID, "登录响应缺少必要的会话标识（uid 或 ssoSessionId）")
  }
  const nickname = trimmedStr(data.nickname)
  const mobile = trimmedStr(data.mobile) ?? input.mobile
  return {
    uid: uid.length > 0 ? uid : ssoSessionId,
    ssoSessionId: ssoSessionId.length > 0 ? ssoSessionId : uid,
    ...(nickname === undefined ? {} : { nickname }),
    ...(mobile === undefined ? {} : { mobile }),
    loginMethod: input.loginMethod,
    ...(trimmedStr(data.token) === undefined ? {} : { token: trimmedStr(data.token) as string }),
    ...(trimmedStr(data.accountId) === undefined && trimmedStr(data.account_id) === undefined
      ? {}
      : {
          accountId: (trimmedStr(data.accountId) ?? trimmedStr(data.account_id)) as string,
        }),
  }
}

/**
 * 手机短信快速登录 `POST /login/phone-quick-login`（multipart；**无极验** ——
 * JetHub 同款，极验只在发送短信一步）。
 */
export async function loginWithSms(
  fetcher: Fetcher,
  input: { mobile: string; verifyCode: string; countryCode?: string },
): Promise<{ ok: true; identity: LoginIdentity } | { ok: false; message: string }> {
  if (input.mobile.trim().length === 0 || input.verifyCode.trim().length === 0) {
    return { ok: false, message: "手机号和验证码不能为空" }
  }
  const form = multipartOf({
    mobile: input.mobile.trim(),
    verifyCode: input.verifyCode.trim(),
    countryCode: input.countryCode ?? "86",
  })
  let result: Awaited<ReturnType<typeof httpJson>>
  try {
    result = await httpJson(fetcher, `${ASTUDIO_AUTH_BASE}${ASTUDIO_PATHS.phoneQuickLogin}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": form.contentType },
      body: form.body,
      timeoutMs: ASTUDIO_LOGIN_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, message: `短信登录失败（网络异常）：${errorMessage(error)}` }
  }
  if (!result.ok) return { ok: false, message: `短信登录失败（HTTP ${result.status}）` }
  const record = asObject(result.json)
  if (!businessOk(record)) {
    return { ok: false, message: `短信登录失败：${vendorMessage(record, "业务码非 0")}` }
  }
  if (record === undefined) return { ok: false, message: "登录响应不是 JSON 对象" }
  try {
    return { ok: true, identity: identityFrom(record, { loginMethod: "sms", mobile: input.mobile.trim() }) }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

/**
 * 账号密码登录 `POST /login/check-account`（multipart + 极验三件套，seccode
 * base64 后入表单 —— 与 JetHub 逐字一致）。
 */
export async function loginWithPassword(
  fetcher: Fetcher,
  input: { accountName: string; accountPwd: string; captcha: GeeTestResult },
): Promise<{ ok: true; identity: LoginIdentity } | { ok: false; message: string }> {
  if (input.accountName.trim().length === 0 || input.accountPwd.length === 0) {
    return { ok: false, message: "账号与密码不能为空" }
  }
  if (!geeTestComplete(input.captcha)) return { ok: false, message: "缺少安全验证参数，请先完成人机验证" }
  const form = multipartOf({
    accountName: input.accountName.trim(),
    accountPwd: input.accountPwd,
    geetest_challenge: input.captcha.geetestChallenge,
    geetest_validate: input.captcha.geetestValidate,
    geetest_seccode: Buffer.from(input.captcha.geetestSeccode, "utf8").toString("base64"),
  })
  let result: Awaited<ReturnType<typeof httpJson>>
  try {
    result = await httpJson(fetcher, `${ASTUDIO_AUTH_BASE}${ASTUDIO_PATHS.checkAccount}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": form.contentType },
      body: form.body,
      timeoutMs: ASTUDIO_LOGIN_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, message: `密码登录失败（网络异常）：${errorMessage(error)}` }
  }
  if (!result.ok) return { ok: false, message: `密码登录失败（HTTP ${result.status}）` }
  const record = asObject(result.json)
  if (!businessOk(record)) {
    return { ok: false, message: `密码登录失败：${vendorMessage(record, "业务码非 0")}` }
  }
  if (record === undefined) return { ok: false, message: "登录响应不是 JSON 对象" }
  try {
    return {
      ok: true,
      identity: identityFrom(record, { loginMethod: "password", username: input.accountName.trim() }),
    }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}
