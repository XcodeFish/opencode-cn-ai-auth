/**
 * AStudio（讯飞 AstronStudio 桌面端，AUMID `cn.xfyun.acode`）的产品事实，唯一真相源。
 *
 * 全部端点与常量转引自 JetHub 的 astudio provider（`src/astudio-product.ts` /
 * `src/astudio.ts` / `src/astudio-oauth.ts` / `src/astudio-credits.ts`，MIT），其
 * 协议事实由 2026-10-15 ~ 2026-10-20 的真机实测钉住（JetHub 仓库
 * `docs/agent-notes/providers-astudio.md`）。本文件只搬运事实，不发明数字。
 *
 * ## 与本包另三家都不同的结构性事实
 *
 * 1. **双域分离，两套鉴权**：推理网关只认
 *    `Authorization: Bearer <modelBearerToken>`；账号控制面只认
 *    `Cookie: ssoSessionId=…`（另有 `sso_sessionid`/`account_id`/`token` 三个
 *    同发键，见 `api.ts` 的 `cookieHeader`）。推理端点不消费 Cookie，控制面
 *    端点不消费 Bearer —— 两边各带各的，混带是无益的。
 * 2. **两个基址不共用前缀**：推理在 `/model-gateway/v1`，模型目录在
 *    `/api/v1/model-manager`（同域不同前缀）。`/model-gateway/v1/models`
 *    实测恒 404 —— 按「OpenAI 兼容网关必有 /v1/models」的直觉拼路径必空手。
 * 3. **`model` 只认裸 slug**：acode 内核的 `builtin/<base64url(slug)>` 是内部
 *    别名，发给上游推理端点回 502 `model_not_found`（JetHub 实测）。
 *    本包对外只暴露裸 slug（`models.ts` 的 `bareSlugOf` 只用于去重）。
 * 4. **两种失败信封都要判**：控制面是 `{code, message|desc, data}`
 *    （HTTP 恒 200，`code !== 0` 即失败；`data` 缺失/空等价于会话失效）；
 *    推理面是 OpenAI 裸体，失败为 `{"error":{code,message,type}}` 配非 2xx。
 * 5. **会话无 TTL、无 refresh token**：磁盘会话文件（客户端侧）没有任何到期
 *    字段，唯一可靠失效信号是推理端点的 HTTP 401；自愈方式是拿存活的
 *    Cookie 重问控制面 `bot/models/configs` 换一份新 `api_key`（`api.ts` 的
 *    `fetchApiKeyConfigs`）。因此本包按 API key 形状存账号（`refresh` 缺席），
 *    到期交给 401，不实现假的续期。
 * 6. **登录不依赖客户端**：微信扫码走讯飞公共 SSO
 *    （`sso.xfyun.cn/SSOService/wx/scanlogin/*`，本包自备 8 位 `fd`），
 *    无需极验、无需任何厂商自有常量 —— 这是四家厂商里唯一「零配置」的登录。
 */

import type { ModelSpec } from "../../core/models.ts"

export const ASTUDIO_ID = "astudio"
export const ASTUDIO_NAME = "AStudio (讯飞)"

/**
 * provider 的图标：`data:image/svg+xml` URI（宿主 `iconOf` 认可的两种形状之一）。
 *
 * AStudio 没有可取回的官方矢量 mark（客户端 asar 内资源未公开、站点 favicon
 * 是通用讯飞标），所以沿用 JetHub 同款**自绘最小 SVG**（蓝底圆角方块 + 白色 A，
 * 与官方客户端图标同构）。内联 data URI 避免外链失效，体积 ~350 字节，
 * 远在宿主 1 MB 字节上限内；写裸图标名会被宿主静默丢弃（`architecture.md` §4.7）。
 */
export const ASTUDIO_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iIzFGNkZFQiIvPjxwYXRoIGQ9Ik0xMiA2LjIgMTcuNiAxOC4yaC0yLjJsLTEuMi0yLjlIOS44bC0xLjIgMi45SDYuNHoiIGZpbGw9IiNGRkZGRkYiLz48cmVjdCB4PSI5LjIiIHk9IjEyLjYiIHdpZHRoPSI1LjYiIGhlaWdodD0iMS41IiBmaWxsPSIjRkZGRkZGIi8+PC9zdmc+"

/** 推理网关基址（OpenAI 兼容）：聊天端点接在它后面。 */
export const ASTUDIO_API_BASE = "https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1"

/** 模型目录基址：与推理网关**同域不同前缀**（见模块头第 2 条）。 */
export const ASTUDIO_CATALOG_BASE = "https://astronstudio-api-volces-prod.xf-yun.com"

/** 账号控制面基址：额度、弹窗奖励、凭据轮换、登录收尾都在这里。 */
export const ASTUDIO_AUTH_BASE = "https://agent.xfyun.cn/xingchen-studio"

/** 讯飞公共 SSO 基址：微信扫码三条路径（qrcode / uids / bind）。 */
export const ASTUDIO_SSO_BASE = "https://sso.xfyun.cn"

/** 端点路径表 —— 每条路径只在这里写一次。 */
export const ASTUDIO_PATHS = Object.freeze({
  /** 推理（OpenAI 兼容），接在 `ASTUDIO_API_BASE` 之后。 */
  chat: "/chat/completions",
  /** 模型目录，接在 `ASTUDIO_CATALOG_BASE` 之后（Bearer 鉴权）。 */
  catalog: "/api/v1/model-manager/models",
  /** 活体凭据权威源（Cookie 鉴权，`data` 是**数组**）。 */
  apiKeyConfigs: "/bot/models/configs",
  /** 登录收尾第一步：租户开户初始化（非阻塞，失败可忽略）。 */
  initApp: "/tenant-app/v2/init-app",
  /** 登录收尾第二步：用户信息（昵称；仅微信登录调用）。 */
  userInfo: "/userInfo",
  /** 积分余额（Cookie 鉴权；`data.totalBalance` 是权威合计）。 */
  pointsBalance: "/points/balance",
  /** 待领取弹窗（每日签到与新手礼包的载体）。 */
  popupsPending: "/client-popups/pending",
  /** 提交领取弹窗。 */
  popupsComplete: "/client-popups/complete",
  /** SSO：申请微信扫码二维码（`?fd=`）。 */
  ssoQrcode: "/SSOService/wx/scanlogin/qrcode",
  /** SSO：轮询扫码状态（`?fd=`）。 */
  ssoUids: "/SSOService/wx/scanlogin/uids",
  /** SSO：确认绑定会话（表单 POST）。 */
  ssoBind: "/SSOService/wx/scanlogin/bind",
  /** 极验（GeeTest）人机验证配置（无 Cookie；登录页拉起滑块用）。 */
  geeCaptcha: "/chat/gee-captcha",
  /** 短信验证码发送（multipart 表单 + 极验三参数）。 */
  sendVerifyCode: "/login/mobile/send-verify-code",
  /** 手机短信快速登录（multipart 表单；JetHub：未注册号码验证通过后自动注册开户）。 */
  phoneQuickLogin: "/login/phone-quick-login",
  /** 账号密码登录（multipart 表单 + 极验三参数）。 */
  checkAccount: "/login/check-account",
})

/** 客户端自报类型：`21` = win32（实测取自客户端请求头；AStudio 是 Windows 独占应用）。 */
export const ASTUDIO_CLIENT_TYPE = "21"

/** 客户端自报产品版本（可选头；与真实客户端一致，服务端加强校验时不受影响）。 */
export const ASTUDIO_STUDIO_VERSION = "3.5.2"

/** 控制面（目录 / 凭据 / 额度 / 弹窗）请求超时。 */
export const ASTUDIO_REQUEST_TIMEOUT_MS = 30_000

/** 登录链路（SSO + 收尾）单请求超时。 */
export const ASTUDIO_LOGIN_TIMEOUT_MS = 15_000

/**
 * 会话失效的业务码（语义：需要人工重新登录，静默重试无意义）。
 *
 * 只登记 JetHub 实测见过的三个：`1002` / `1005` / `80000`。其中 `80000` 是
 * 账号后端会话失效的真实形态（HTTP 恒 200 + `{code:80000, desc:"登录异常，请重新登录"}`），
 * 客户端自己的失效码集合（`{401,403,1002,1005}`）反而不含它 —— 判码不能跟着客户端漏。
 * 其余非 0 码一律按「可重试」处理：加错码会把一次瞬时故障固化成「账号已死」。
 */
export const ASTUDIO_SESSION_DEAD_CODES: ReadonlySet<number> = Object.freeze(new Set([1002, 1005, 80000]))

/** 推理端点唯一可信的会话失效信号：HTTP 401（磁盘会话无 TTL，见模块头第 5 条）。 */
export const ASTUDIO_UNAUTHORIZED_STATUS = 401

/**
 * 账号后端在会话失效之外，把 `code:0` 但 `data` 为空/缺 `api_key` 也判成终态：
 * 那是「账号下没有任何可用模型凭据」的真实形态（JetHub 实测信封
 * `{flag:false,code:99909001,desc:"系统异常",data:null}` 与
 * `{flag:true,code:0,desc:"成功",data:[]}` 两种都见过）。
 */
export const ASTUDIO_NO_CREDENTIAL_MESSAGE =
  "账号后端没有可用的推理凭据（api_key），请先在 AStudio 客户端登录一次"

/**
 * 登录二维码的兜底寿命。SSO 不声明有效期；微信带参二维码本身的通用寿命是
 * 5 分钟，超时后由登录页的总体超时收口（`ASTUDIO_SIGN_IN_TIMEOUT_MS`）。
 */
export const ASTUDIO_QR_EXPIRES_MS = 300_000

/** 扫码状态轮询间隔（SSO `uids` 是立即返回的短轮询，不是长轮询）。 */
export const ASTUDIO_QR_POLL_INTERVAL_MS = 2_000

/**
 * SSO 会话的寿命：一年（服务端 `Set-Cookie: ssoSessionId=…; Max-Age=31536000`，
 * 且**不滑动** —— JetHub 2026-10-10 实测抄录）。
 *
 * ⚠️ 这不是模型 token 的 TTL：磁盘会话与 `modelBearerToken` 都没有到期字段，
 * 唯一失效信号仍是推理端点的 HTTP 401（`index.ts` 的 401 自愈链）。这里登记它
 * 只为一件事：登录结果需要一个 `expires > 0` 才能被宿主按 **OAuth 形状**存储
 *（`refresh: ""` + `expires`）—— 那是扩展字段（Cookie 四件套）**唯一**能存活
 * 的存储形状，见 `login.ts` 的 `signInResultOf`。
 */
export const ASTUDIO_SSO_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000

/** 一次登录流程的总时长上限，到点判失败并关闭本地页。 */
export const ASTUDIO_SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000

/** `fd` 的字符表：官方客户端生成 8 位随机串所用（JetHub 抄录）。 */
export const ASTUDIO_FD_ALPHABET = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"

/** 弹窗类型：每日签到奖励。 */
export const ASTUDIO_POPUP_DAILY_REWARD = "DAILY_REWARD_DIALOG"

/** 弹窗类型：新用户礼包。 */
export const ASTUDIO_POPUP_NEW_USER = "NEW_USER_DIALOG"

/**
 * 兜底模型表 —— JetHub 2026-10-15 实测上游目录里的全部 6 个模型，逐字段抄录。
 *
 * ⚠️ `efforts` 是远端 `supported_reasoning_levels[].effort` 的原样集合：
 * 上游对**非法档位不报错**、按最大档静默执行（实测 `reasoning_effort:"bogus"`
 * 以最大档计费跑完），所以这里只声明远端下发过的档位，运行期收到的目录
 * 未声明的档位一律不下发（`index.ts` 的 loader 不改写档位，声明即全集）。
 * ⚠️ 表里没有 `glm5.3flash` —— 它在上游目录中不存在（JetHub 对全量 JSON 零命中）；
 * 编造一个上游不认的 slug，症状是用户选中后 502 `model_not_found`。
 */
export const ASTUDIO_FALLBACK_MODELS: readonly ModelSpec[] = [
  {
    id: "xopglm52",
    name: "GLM-5.2",
    context: 1_000_000,
    output: 128_000,
    reasoning: true,
    efforts: ["none", "high", "max"],
  },
  {
    id: "astronclaw-auto",
    name: "Auto",
    context: 1_000_000,
    output: 384_000,
    reasoning: true,
    efforts: ["none", "high"],
  },
  {
    id: "xopdsv4flash0731in",
    name: "DeepSeek-V4-Flash",
    context: 1_000_000,
    output: 384_000,
    reasoning: true,
    efforts: ["none", "high", "max"],
  },
  {
    id: "xopdeepseekv4pro0813",
    name: "DeepSeek-V4-Pro",
    context: 1_000_000,
    output: 384_000,
    reasoning: true,
    efforts: ["none", "high", "max"],
  },
  {
    id: "spark-x2.5",
    name: "Spark-X2.5",
    context: 262_144,
    output: 256_000,
    reasoning: true,
    efforts: ["none", "high"],
  },
  {
    id: "spark-x2.6-preview",
    name: "Spark-X2.6-Preview",
    context: 262_144,
    output: 256_000,
    reasoning: true,
    efforts: ["none", "high"],
  },
]
