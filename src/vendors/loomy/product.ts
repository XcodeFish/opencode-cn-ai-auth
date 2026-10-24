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
 * The `options` key that turns the new-user task claim off. It is on by
 * default: the host gives a plugin no button to press, so claiming as soon as
 * the usage card notices unfinished tasks is the only way they get done.
 * Turning it off leaves `usage` strictly read-only.
 */
export const LOOMY_CLAIM_TASKS_OPTION = "claimTasks"

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

/**
 * How long a sign-in waits for the day's quota before landing without it.
 *
 * The quota rides inside the sign-in result (see `signInResult`), so the wait
 * is on the critical path of signing in: the request itself took ~450ms when
 * probed on 2026-10-15, and 8s is roomy for a slow connection while still
 * short enough that a sick endpoint cannot make the sign-in look hung. Timing
 * out costs the percentage on the daily window until the first check-in, not
 * the sign-in.
 */
export const LOOMY_SIGN_IN_QUOTA_DEADLINE_MS = 8_000

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
 * 上下文窗口的**逐模型硬覆盖**（`模型 id → 真实窗口`）。
 *
 * ## 为什么需要（真实缺陷，JetHub Gitee issue IKJW31，2026-10-08 落地）
 *
 * 远端 `GET /models` 对 **`spark-x` 声明 `context_length: 1048576`，而真实墙在
 * 262144**：宿主按 1M 放心打包，输入一旦越过 256K，上游**收下请求但 0 输出**
 * 并回 `finish_reason=length`，整轮静默失败。硬证据：
 *
 * 1. 报障会话 4 次失败的 prompt 总量逐 token 相同，全部 = **262,138 = 262,144−6**；
 *    同晚直连其它模型 473K/518K/644K 全部正常 ⇒ 墙只属于这一个模型。
 * 2. 官方客户端本地表对 `spark-x` 写 `limit.context = 262144`，同一文件其余 7 条
 *    与远端逐条一致 ⇒ 官方只对这一个刻意降档。
 *
 * ⚠️ **只改兜底表是无效的**：远端可用时走的是远端值（远端自己就声明 1M），
 * 所以远端解析与兜底表**两条路径都必须过** `contextWindowOf`。
 * ⚠️ 键必须**小写**：查表经 `catalogKey` 归一，混入大写键会恒不命中
 * （上游改大小写即静默失效 —— JetHub 2026-10-14 审计教训）。
 */
export const LOOMY_CONTEXT_WINDOW_OVERRIDES: Readonly<Record<string, number>> = Object.freeze({
  "spark-x": 262_144,
})

/**
 * 远端声明为**纯文本**、但实测**能读图**的模型（`input_modalities` 漏报）。
 *
 * ## 为什么需要（真实缺陷，JetHub 2026-10-14 用户报障）
 *
 * 远端对 `qwen-3.8-max` 下发 `capabilities.input_modalities = ['text']`，
 * 原样直译 ⇒ 图片根本发不出去（宿主按声明做附件准入）。实测判据是随机纯色
 * PNG 的颜色问答（纯文本模型答不出颜色）：`qwen-3.8-max` 4/5 次答对，同批
 * `DeepSeek-V4.1-Flash` / `Kimi-k2.6` / `qwen3.8-flash` / `mimo-v2.5` 均读得
 * 到（远端本来就声明了 image，不需要覆盖）。
 *
 * ⚠️ `MiniMax-M3` 远端声明 image 但实测 4/4 未命中（疑似编造答案）——
 * **刻意不降级**：单账号证据不足以判死一个已声明的能力，降级会改变既有可用路径。
 * ⚠️ **不要改成「该家恒支持图片」**：白名单只覆盖实测确认的个案，否则将来上架
 * 真正的纯文本模型时会把图放行，让上游回一个更难懂的 400。
 * ⚠️ 表内条目必须**小写**（查表经 `catalogKey` 归一）。
 */
export const LOOMY_IMAGE_CAPABILITY_OVERRIDES: ReadonlySet<string> = Object.freeze(new Set(["qwen-3.8-max"]))

/**
 * 模型 id 的**归一化查表键**：上面两张覆盖表唯一的查表口径
 * （小写、去首尾空白）。⚠️ 只用于查表，绝不改对外 id。
 */
export function catalogKey(modelId: string): string {
  return modelId.trim().toLowerCase()
}

/**
 * 取一个模型的**真实**上下文窗口：覆盖表优先于声明值。
 * ⚠️ 远端与兜底表**两条路径都必须过这里** —— 只改兜底表无效。
 */
export function contextWindowOf(modelId: string, declared: number): number {
  return LOOMY_CONTEXT_WINDOW_OVERRIDES[catalogKey(modelId)] ?? declared
}

/**
 * 取一个模型的**真实**图片能力：覆盖表命中即为 true，否则原样返回声明值。
 * ⚠️ 远端与兜底表**两条路径都必须过这里**。
 */
export function supportsImageOf(modelId: string, declared: boolean): boolean {
  return LOOMY_IMAGE_CAPABILITY_OVERRIDES.has(catalogKey(modelId)) || declared
}

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
 * ⚠️ `spark-x` 的 context 是覆盖后的真实值（远端虚报 1M，见覆盖表说明）。
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
    context: 262_144,
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
  petWork: "/pet-work",
  petWorkRewards: "/pet-work/rewards",
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

/**
 * 宠物每日打工（pet-work）：Loomy 唯一「按天算、要手动领」的积分，每天 0～1000 分。
 *
 * 档位由服务端按**该账号当日在官方客户端的有效对话轮次**计算
 * （`sessionWeight × sessionIndex + depthWeight × depthIndex`，见快照 `config`），
 * 本包只提交「业务日 + 配置版本 + 已达档位」，是否达标由服务端判。
 *
 * ⚠️ 两处拼写不同，别顺手统一：快照里配置版本是 `config.version`，而领奖请求体
 * 的字段**是** `configVersion`（2026-10-23 实测，见 `docs/vendors.md`）。
 */
export const LOOMY_PETWORK_CONFIG_VERSION = "pet-work-v1"

/** 拿不到快照档位表时的兜底档位；服务端只认它自己的档位 id。 */
export const LOOMY_PETWORK_FIRST_TIER = "tier_1"

/**
 * 卡片读数的缓存时长。
 *
 * 进度只在官方客户端产生新轮次、或本包领奖之后变化，而 `usage` 每轮额度刷新都会
 * 跑，10 分钟一次足够（与新手任务同一口径）。
 */
export const LOOMY_PETWORK_TTL_MS = 10 * 60 * 1000
