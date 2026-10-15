/**
 * Loomy (讯飞) product facts, in one place.
 *
 * Everything here was read out of the Loomy desktop client and confirmed
 * against the live service from JetHub's port of the same protocol
 * (`src/loomy*.ts` at JetHub 0.4.2). `docs/vendors.md` records which value
 * came from where, and which of them are assumptions.
 *
 * Two bases, two contracts:
 *
 * - `loomyad.xunfei.cn/api/v1` — the product: chat, model list, points. It
 *   answers `{code, desc, data}` with `code: "000000"` for success, and it
 *   *always* answers HTTP 200, so only `code` says what happened.
 * - `account.xfinfr.com` — xfyun's account service (login, SMS, WeChat
 *   binding). It signs with `Authorization: account {ak}:{sig}`, and every
 *   flow on it — WeChat, WeChat's first-time phone binding and SMS sign-in —
 *   is signed with the public client constants. User keys only override.
 */

import type { CredentialSpec } from "../../core/credentials.ts"
import type { ModelSpec } from "../../core/models.ts"

export const LOOMY_ID = "loomy"
export const LOOMY_NAME = "Loomy (讯飞)"

/**
 * The provider's picture, as magpie takes it: an `https` URL of a picture on
 * a public host, which the host fetches once and keeps. Anything else — a
 * bare name such as `spark-color` — is silently dropped (`host.js`'s
 * `iconOf` only keeps `https://` and `data:image/`). This is the icon the
 * product's own page declares (`<link rel="icon" href="/icon.png?…">`),
 * read on 2026-10-09: 1024x1024 PNG, 670 KB, inside the host's 1 MB limit.
 *
 * The vendor's published picture is used rather than a copy committed here:
 * it stays current on its own, and this package carries no brand asset. A
 * URL that stops resolving costs nothing but the icon — the host falls back
 * to the plugin market's mark.
 */
export const LOOMY_ICON = "https://loomy.xunfei.cn/icon.png"

/** The product base: chat, `/models`, `/points/*` (token header only). */
export const LOOMY_API_BASE = "https://loomyad.xunfei.cn/api/v1"

/** xfyun's account base: SMS sign-in and WeChat binding (signed requests). */
export const LOOMY_ACCOUNT_BASE = "https://account.xfinfr.com"

/** The product's success code. */
export const LOOMY_OK_CODE = "000000"

/** The sign-in lapsed: the account needs a new sign-in, and no retry helps. */
export const LOOMY_SIGNED_OUT_CODE = "100002"

export const LOOMY_REQUEST_TIMEOUT_MS = 60_000

/** How long an SMS code stays good, as the sign-in request declares it. */
export const LOOMY_SMS_TTL_SECONDS = 300

/**
 * How long the page waits between two codes for the same number.
 *
 * The service does not rate-limit `sendMsgCode` at all: three back-to-back
 * calls for one number all answered `000000` on 2026-10-15, so this cooldown
 * is the package's own guard against a user (or a stuck retry) spending the
 * vendor's SMS quota. 60s is the interval Chinese account services
 * conventionally allow.
 *
 * The cooldown is per number, so a mistyped one can be corrected and sent at
 * once; volume is bounded by `LOOMY_SMS_SENDS_PER_FLOW` regardless of number.
 */
export const LOOMY_SMS_SEND_COOLDOWN_MS = 60_000

/** How many codes one page of the SMS flow may ask for. */
export const LOOMY_SMS_SENDS_PER_FLOW = 3

/**
 * The `options` key that turns the SMS sign-in method on and off. It is on
 * by default: the shipped client AccessKey signs the SMS endpoints just as
 * well as the QR ones, so an account with no WeChat can still get in.
 */
export const LOOMY_SMS_LOGIN_OPTION = "smsLogin"

/**
 * The lifetime the sign-in request asks for: 14 days. The service answers no
 * expiry of its own, so the stored `expires` is this span from sign-in time
 * — a local record, not the vendor's word (`docs/vendors.md`).
 */
export const LOOMY_SESSION_TTL_SECONDS = 1_209_600

/** The `base.appid` the account service expects. */
export const LOOMY_APP_ID = "GM3LOOMY"

/**
 * The user agent the account service sees. The shipped client sends this on
 * every platform, so this package does too.
 */
export const LOOMY_ACCOUNT_UA = "Loomy|Desktop|Electron|macOS"

/** WeChat's open-platform app for Loomy's web sign-in. */
export const LOOMY_WECHAT_APP_ID = "wx18d60be432287cf8"

/**
 * The redirect the WeChat authorization page is opened with. WeChat checks
 * it against the app's own whitelist, and the page 404s — this package never
 * loads it: the code arrives from the long poll instead. Changing it to a
 * loopback address makes WeChat answer "redirect_uri 参数错误".
 */
export const LOOMY_WECHAT_REDIRECT_URI = "https://loomy.xunfei.cn/oauth/wechat/callback"

/** One WeChat long poll: the service holds the request about 25 seconds. */
export const LOOMY_WECHAT_POLL_TIMEOUT_MS = 40_000

/** How long a sign-in may take before the plugin gives up on it. */
export const LOOMY_SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000

/** A browser user agent: WeChat's pages are unfriendly to anything else. */
export const LOOMY_WECHAT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

/**
 * User overrides for the AccessKey every account request is signed with.
 * Optional: unconfigured means the shipped client constants are used, the
 * same pair the QR flow has always signed with.
 */
export const LOOMY_ACCESS_KEY_ID: CredentialSpec = {
  option: "accessKeyId",
  env: "LOOMY_XFYUN_ACCESS_KEY_ID",
  what: "讯飞账号 AccessKeyId",
}

export const LOOMY_ACCESS_KEY_SECRET: CredentialSpec = {
  option: "accessKeySecret",
  env: "LOOMY_XFYUN_ACCESS_KEY_SECRET",
  what: "讯飞账号 AccessKeySecret",
}

/**
 * The reasoning levels every chat model offers, in the order the service
 * lists them. The live `/models` answer carries its own `reasoning_efforts`
 * and wins when it arrives; this is the copy that stands in when it does
 * not.
 */
export const LOOMY_EFFORTS: readonly string[] = ["none", "low", "medium", "high", "xhigh"]

/**
 * The catalog for a moment when `/models` cannot be read.
 *
 * Read from the live service on 2026-09-26 by JetHub (`loomy-product.ts`),
 * same order as the service returned: the order matters when a user compares
 * this list with the vendor's own.
 *
 * The rates in the names come from the same reading: the service states a
 * model's credit rate only inside its display name, in three different
 * bracket styles, and `models.ts` parses it back into `rate`.
 */
export const LOOMY_FALLBACK_MODELS: readonly ModelSpec[] = [
  {
    id: "deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash 0731",
    rate: 3,
    context: 1_048_576,
    reasoning: true,
    efforts: [...LOOMY_EFFORTS],
  },
  {
    id: "MiniMax-M3",
    name: "MiniMax M3",
    rate: 4,
    context: 1_048_576,
    reasoning: true,
    efforts: [...LOOMY_EFFORTS],
  },
  {
    id: "Kimi-k2.6",
    name: "Kimi k2.6",
    rate: 6.5,
    context: 262_144,
    reasoning: true,
    efforts: [...LOOMY_EFFORTS],
  },
  {
    id: "qwen-3.8-max",
    name: "Qwen 3.8 Max",
    rate: 12,
    context: 1_000_000,
    reasoning: true,
    efforts: [...LOOMY_EFFORTS],
  },
  {
    id: "GLM-5.3-Flash",
    name: "GLM 5.3 Flash",
    rate: 0.8,
    context: 1_048_576,
    reasoning: true,
    efforts: [...LOOMY_EFFORTS],
  },
  {
    id: "qwen3.8-flash",
    name: "qwen 3.8 flash",
    rate: 0.8,
    context: 1_000_000,
    reasoning: true,
    efforts: [...LOOMY_EFFORTS],
  },
  {
    id: "spark-x",
    name: "Spark X2.5",
    rate: 0.1,
    context: 1_048_576,
    reasoning: true,
    efforts: [...LOOMY_EFFORTS],
  },
  {
    id: "mimo-v2.5",
    name: "MiMo V2.5",
    rate: 3.3,
    context: 1_048_576,
    reasoning: true,
    efforts: [...LOOMY_EFFORTS],
  },
]

/** Endpoints, so no path is written twice. */
export const LOOMY_PATHS = Object.freeze({
  sendSms: "/login/phone/sendMsgCode",
  checkSms: "/login/phone/checkCode",
  bindAuth: "/login/thirdAccount/bind/auth",
  bindSend: "/login/thirdAccount/bind/sendMsg",
  bindCheck: "/login/thirdAccount/bind/checkCode",
  bindSkip: "/login/thirdAccount/bind/skip",
  models: "/models",
  points: "/points/records?pageNo=1&pageSize=1&recordType=all",
  firstLogin: "/points/first-login",
  onboardingTasks: "/onboarding/tasks",
  onboardingComplete: "/onboarding/tasks/complete",
})

/**
 * The new-user tasks ("新手任务"), keyed as the service keys them, with the
 * credits each is worth.
 *
 * Read out of the Loomy client's `electron/onboarding-service.js:18-27`
 * (`TASK_POINTS`, whose own test asserts the eight sum to 10 000), the same
 * table JetHub ported. The order is the client's registry order and is what
 * this package claims in.
 *
 * Why this package may claim them at all: the service does not check that
 * anything happened. JetHub posted all eight to `onboarding/tasks/complete`
 * on 2026-09-26 — no chat sent, no PPT generated, no skill installed — and
 * every one answered `000000`, taking the balance from 0 to 10 000. The
 * client decides completion locally; the service only sets the flag and adds
 * the credits, which makes this a plain API claim that spends no model
 * tokens.
 */
export const LOOMY_TASK_POINTS: Readonly<Record<string, number>> = Object.freeze({
  first_message: 500,
  pick_skill: 1000,
  generate_ppt: 1500,
  set_schedule: 1000,
  install_skill: 1500,
  configure_remote: 1000,
  create_soul: 1500,
  share_soul: 2000,
})

/** What all eight tasks are worth together. */
export const LOOMY_ONBOARDING_TOTAL = 10_000

/**
 * The tasks, in claim order, as Chinese titles — the client's own wording
 * (`GE` registry), so a message this package writes reads like the app's.
 */
export const LOOMY_TASK_TITLES: Readonly<Record<string, string>> = Object.freeze({
  first_message: "发送你的第一条消息",
  pick_skill: "试试选择一个技能",
  generate_ppt: "生成第一份 PPT",
  set_schedule: "设置定时任务",
  install_skill: "在技能广场安装一个技能",
  configure_remote: "配置远程控制",
  create_soul: "创建你的第一个搭子",
  share_soul: "把搭子分享给朋友",
})
