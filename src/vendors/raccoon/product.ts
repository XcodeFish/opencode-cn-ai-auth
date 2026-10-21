/**
 * Raccoon (商汤小浣熊) product facts, in one place.
 *
 * Everything here was read out of the Raccoon desktop client and confirmed
 * against the live service from JetHub's port of the same protocol
 * (`src/raccoon*.ts` at JetHub 0.4.2). `docs/vendors.md` records which value
 * came from where and which of them are assumptions.
 *
 * One base, four prefixes, one envelope:
 *
 * - `xiaohuanxiong.com` — everything hangs off it: sign-in under
 *   `/api/web/auth/v1`, chat and the model catalog under `/api/web/llm/v2`,
 *   points under `/api/web/points/v1`. The answer is
 *   `{ code, message, details, data }` with `code: 0` for success; a body
 *   with no `code` is read by the HTTP status, which is how the service
 *   says 401.
 * - `/api/web/llm/v2` is also the base a chat request is sent to, which is
 *   why it is exported twice: once as a prefix for the reads above, once as
 *   the `baseURL` the host appends `/chat/completions` to.
 */

import type { CredentialSpec } from "../../core/credentials.ts"
import type { ModelSpec } from "../../core/models.ts"

export const RACCOON_ID = "raccoon"
export const RACCOON_NAME = "Raccoon (商汤)"

/**
 * The provider's picture, as magpie takes it: an `https` URL of a picture on
 * a public host, which the host fetches once and keeps. Anything else — a
 * bare name such as `sensenova-color` — is silently dropped (`host.js`'s
 * `iconOf` only keeps `https://` and `data:image/`). This is the mark the
 * product's own page declares for `<link rel="icon">` (the same URL as
 * `RACCOON_ICON` below), read on 2026-10-09: SVG, 1.7 KB, dark on a
 * transparent field, so it stays visible on either theme. The site's own
 * `/favicon.svg` serves the same bytes.
 *
 * The vendor's published picture is used rather than a copy committed here:
 * it stays current on its own, and this package carries no brand asset. A
 * URL that stops resolving costs nothing but the icon — the host falls back
 * to the plugin market's mark.
 */
export const RACCOON_ICON = "https://sta-volc.xiaohuanxiong.com/raccoon-family/prod/favicon.svg"

/** The site every endpoint hangs off. */
export const RACCOON_API_BASE = "https://xiaohuanxiong.com"

/** Sign-in: QR polling, SMS, renewal, user info. */
export const RACCOON_AUTH_PREFIX = "/api/web/auth/v1"

/** Chat and the model catalog. */
export const RACCOON_LLM_PREFIX = "/api/web/llm/v2"

/** Points balance and bills. */
export const RACCOON_POINTS_PREFIX = "/api/web/points/v1"

/** What a chat request goes to: this plus `/chat/completions`. */
export const RACCOON_CHAT_BASE = `${RACCOON_API_BASE}${RACCOON_LLM_PREFIX}`

/** The product's success code: every other value is a failure. */
export const RACCOON_OK_CODE = 0

/**
 * The sign-in lapsed. The service states it as HTTP 401, and as business
 * code 200003 on the renewal endpoint.
 */
export const RACCOON_SIGNED_OUT_CODES: readonly number[] = [401, 200003]

export const RACCOON_REQUEST_TIMEOUT_MS = 60_000

/** The QR is polled every 2 seconds, as the vendor's own client does. */
export const RACCOON_QR_POLL_INTERVAL_MS = 2_000

/** How long a sign-in may take before the plugin gives up on it. */
export const RACCOON_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

/**
 * How long before `expires` a sign-in is renewed.
 *
 * The vendor's own client renews inside a 300 second window
 * (`scheduleAuth.js`'s `TOKEN_REFRESH_WINDOW_SECONDS`), and an access token
 * lives about three hours (measured: `exp - nbf = 10805s`). The host's own
 * default is the same five minutes; it is stated here because the number is
 * the vendor's, not the host's.
 */
export const RACCOON_REFRESH_LEAD_MS = 300_000

/**
 * The client platform the service sees. `desktop/v1` endpoints require this
 * header and accept only `desktop-windows` / `desktop-macos` /
 * `desktop-linux`; the client it was read from runs on Windows.
 */
export const RACCOON_CLIENT_PLATFORM = "desktop-windows"

/** The client version the same headers carry. */
export const RACCOON_CLIENT_VERSION = "v1.0.35"

/** The app name the WeChat landing page is opened with. */
export const RACCOON_QR_APP_NAME = "商汤小浣熊官网"

/**
 * The Aliyun slider in front of the SMS endpoints, as the client configures
 * it. Two constants of the vendor's page, used by the page this package
 * serves for the SMS sign-in (`login.ts`).
 */
export const RACCOON_ALIYUN_CAPTCHA = Object.freeze({
  script: "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js",
  sceneId: "1pkmy0x3",
  prefix: "hk1r5l",
})

/**
 * The key the client encrypts a phone number with before it sends it.
 *
 * It lives in the client's renderer bundle and is readable by anyone who
 * has the client, so it is not a user secret — but it is **the vendor's**
 * constant, not this package's, so it is never baked in here: SMS sign-in
 * needs it and is not offered until the user provides it (see
 * `core/credentials.ts` and `docs/vendors.md`).
 */
export const RACCOON_PHONE_CIPHER_SECRET: CredentialSpec = {
  option: "phoneCipherSecret",
  env: "RACCOON_PHONE_CIPHER_SECRET",
  what: "商汤小浣熊手机号加密密钥",
}

/** Optional organization code for direct OpenCode, whose auth store lacks Magpie metadata. */
export const RACCOON_OFFICE_IDENTITY_OPTION = "officeIdentity"

/**
 * The reasoning tiers every chat model offers, in display order.
 *
 * Raccoon has exactly two states, and they reach it through one channel:
 * `extra_body.thinking.type`, measured to be the only thing that works
 * (`{type: "disabled"}` produced zero reasoning tokens in 6/6 and 8/8
 * samples, while `{type: "enabled"}` matched the default). `reasoning_effort`
 * is accepted by the service and does not decide anything on its own, so
 * this package never leaves it on the request (see `thinking.ts`).
 *
 * The ids are the **host's**, not the vendor's. magpie drops a tier id it
 * does not know (`ir.go`'s `effortOf` returns "" for anything outside its
 * list), so a plugin that named them `on` and `off` would offer two tiers
 * that both collapse to none. `high` is the host's word for "think", `none`
 * is its word for "do not", and `thinking.ts` is where they become the
 * vendor's boolean.
 */
export const RACCOON_EFFORTS: readonly string[] = ["none", "high"]

/**
 * **实测确认不能读图**的模型（**基础 id**）—— 图片能力「默认支持」策略的唯一刹车。
 *
 * ## 为什么判据是「默认支持 + 黑名单」而不是白名单（2026-10-22 自 JetHub 2227e9b 移植）
 *
 * 判据演进有三步，每步都是真机报障逼出来的：
 *
 * 1. **`tags.vision` 不是能力契约**（2026-10-03 报障）：远端 `model_catalog`
 *    **从未下发**任何模态字段（穷举键并集、按模态词扫描命中 0 个）；唯一的信号
 *    `tags.vision` 是客户端「Raccoon-Auto 选模」的**偏好标签**——2026-10-03 实测
 *    6 个可见模型全部能读图（`usage.prompt_tokens_details.image_tokens = 64`），
 *    其中 `sn-deepseek-v4-1-flash` / `sn-glm-5-3-flash` 的 tags 根本不含 vision。
 *    当时的修法是精确 id 白名单（旧 `RACCOON_IMAGE_MODELS`）。
 * 2. **白名单必然腐坏**（2026-10-21 报障）：远端滚动上架同族版本
 *    `sn-deepseek-v4-1-flash-1017`，tags 与无后缀版逐字相同（仍无 vision）⇒
 *    精确 id 查不到 ⇒ 又被打回纯文本 ⇒ 宿主把图片替换成文本占位符，图片根本
 *    没发出去。实测该 id 带图 200、四象限纯色全对。
 * 3. ⇒ 判据翻转为「**默认 image**」：不在本集合里的模型一律返回 true；真正的
 *    纯文本模型登记进集合**显式禁掉**。
 *
 * ## ⚠️ 代价（必须知道）
 *
 * 若远端上线一个真正的纯文本模型而没及时登记，宿主会放行图片，上游可能
 * **静默忽略**（不是报错）⇒ 模型凭文字幻觉作答。本集合是唯一刹车：**新增条目
 * 必须先实测**，判据是「带图请求被明确拒绝（4xx / 明确错误码）」，而不是
 * 「200 但答非所问」。
 *
 * ⚠️ **不要**把网关节点不一致登记进来：`sn-glm-5-3` 实测 3 次只对 1 次、错误体
 * 暴露 3 个 fallback 组、部分节点纯文本——那是节点问题不是模型能力，登记会把
 * 正常节点一起禁掉。当前目录没有实测确认的纯文本模型 ⇒ 空集。
 */
export const RACCOON_TEXT_ONLY_MODELS: ReadonlySet<string> = Object.freeze(new Set<string>([]))

/**
 * 远端同族模型的**版本后缀**（如 `sn-deepseek-v4-1-flash-1017` 的 `-1017`）。
 *
 * ⚠️ 只在「查纯文本集合」时剥离，**不用于展示名 / 请求 id**：请求必须用远端
 * 下发的完整 id（剥了会 404）。后缀限定 4 位纯数字，避免误禁 `-next` / `-text`
 * 一类变体。这是一条**局部归一化**，不是全局 id 改写。
 */
const RACCOON_MODEL_VERSION_SUFFIX = /-\d{4}$/

/**
 * 图片能力判定的**纯函数内核**（集合入参化）。
 *
 * ⚠️ 为什么要入参化：生产集合是**空集**（当前目录没有实测确认的纯文本模型），
 * 判据若直接闭包读常量，「纯文本模型被禁」这条分支永远测不到——只能测到恒 true。
 * 集合入参让测试可以注入非空集合，把两格分支都锁住。
 */
export function supportsImageWith(textOnly: ReadonlySet<string>, modelId: string): boolean {
  if (textOnly.has(modelId)) return false
  // 同族滚版本：`sn-deepseek-v4-1-flash-1017` → `sn-deepseek-v4-1-flash`。
  // 纯文本模型同样会滚版本，必须按基础 id 命中，否则新版会漏禁。
  const baseId = modelId.replace(RACCOON_MODEL_VERSION_SUFFIX, "")
  if (baseId !== modelId && textOnly.has(baseId)) return false
  return true
}

/**
 * 远端目录条目的图片能力判定 —— **默认支持**，只有 {@link RACCOON_TEXT_ONLY_MODELS}
 * 里的模型才返回 false。兜底表与远端解析**共用这一个判据**（单测锁死不分叉）。
 */
export function supportsImageOf(modelId: string): boolean {
  return supportsImageWith(RACCOON_TEXT_ONLY_MODELS, modelId)
}

/**
 * The catalog for a moment when `/model_catalog` cannot be read.
 *
 * Read from the live service on 2026-09-26 by JetHub, same order as the
 * service returned (the order matters when a user compares this list with
 * the vendor's own). Only the six `visible: true` models are here:
 * `Raccoon-Auto` is a client-side picker entry that the service does not
 * know, and three `raccoon-*` internal models are hidden from the client.
 *
 * The billing columns behind these numbers are the service's own
 * (`billing_multiplier` / `billing_effective_multiplier`): a model that
 * costs nothing now reads `free` with the price it had before the discount,
 * which is what the host's rate badge draws — including Kimi-K3's plain
 * `x1`, since a model with no badge at all reads as a model whose rate was
 * never read.
 */
export const RACCOON_FALLBACK_MODELS: readonly ModelSpec[] = [
  {
    id: "sn-sensenova-6-8-flash",
    name: "SenseNova-6.8-Flash",
    rate: 0,
    rateWas: 0.5,
    free: true,
    context: 256_000,
    output: 63_999,
    images: true,
    reasoning: true,
    efforts: [...RACCOON_EFFORTS],
  },
  {
    id: "sn-sensenova-6-8-flash-lite",
    name: "SenseNova-6.8-Flash-Lite",
    rate: 0,
    rateWas: 0.5,
    free: true,
    context: 256_000,
    output: 63_999,
    images: true,
    reasoning: true,
    efforts: [...RACCOON_EFFORTS],
  },
  {
    id: "sn-glm-5-3",
    name: "GLM-5-3",
    rate: 0.75,
    context: 1_000_000,
    output: 100_000,
    images: true,
    reasoning: true,
    efforts: [...RACCOON_EFFORTS],
  },
  {
    id: "sn-kimi-k3",
    name: "Kimi-K3",
    rate: 1,
    context: 1_000_000,
    output: 100_000,
    images: true,
    reasoning: true,
    efforts: [...RACCOON_EFFORTS],
  },
  {
    id: "sn-glm-5-3-flash",
    name: "GLM-5-3-Flash",
    rate: 0.1,
    rateWas: 0.2,
    context: 1_000_000,
    output: 100_000,
    images: true,
    reasoning: true,
    efforts: [...RACCOON_EFFORTS],
  },
  {
    id: "sn-deepseek-v4-1-flash",
    name: "DeepSeek-V4.1-Flash",
    rate: 0.25,
    context: 1_000_000,
    output: 100_000,
    images: true,
    reasoning: true,
    efforts: [...RACCOON_EFFORTS],
  },
]

/** Endpoints, so no path is written twice. */
export const RACCOON_PATHS = Object.freeze({
  qrLogin: `${RACCOON_AUTH_PREFIX}/login_with_qrcode_code`,
  sendSms: `${RACCOON_AUTH_PREFIX}/send_sms`,
  smsLogin: `${RACCOON_AUTH_PREFIX}/login_with_sms`,
  refresh: `${RACCOON_AUTH_PREFIX}/refresh`,
  userInfo: `${RACCOON_AUTH_PREFIX}/user_info`,
  models: `${RACCOON_LLM_PREFIX}/model_catalog`,
  balance: `${RACCOON_POINTS_PREFIX}/balance`,
})
