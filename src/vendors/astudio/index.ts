/**
 * AStudio as a provider plugin.
 *
 * 形状只在这里与宿主见面（`defineVendor` 装配 config / auth / provider 三条
 * hook），其余模块只接 `Fetcher` 与普通数据。与 Loomy 同构，差异都在协议上：
 *
 * - **loader**：`apiKey` 就是活体模型凭据（推理网关只认
 *   `Authorization: Bearer`），显式头补客户端形状（`clientType` /
 *   `studioVersion` / 已知时的 `X-Account-Id`，实测都不带也能 200，带上是为了
 *   与真实客户端逐字一致）；`fetch` 带一条 401 自愈链 —— 磁盘会话无 TTL，
 *   唯一的失效信号是上游 401，而凭据可以拿存活的 Cookie 向控制面重问一份新的
 *   （`bot/models/configs`，幂等纯读），换到新值写回账号并重试一次。
 * - **usage / listModels 走两个域**：模型目录在推理域（Bearer），积分在账号域
 *   （Cookie）。两边都把「会话失效」上抛（`SignInExpiredError` /
 *   `signIn: "expired"`），其余失败如实报错。
 * - **checkin**：每日签到与新手礼包都挂在弹窗奖励体系上（`client-popups`），
 *   挂在宿主唯一的写钩子上（`Check in now` / 自动签到）。
 * - **没有 refresh**：没有 refresh token、没有 TTL，不实现假的续期
 *   （`architecture.md` §5）；401 自愈在 loader 的 fetch 里完成。
 */

import { catalogModels } from "../../core/catalog.ts"
import { SignInExpiredError } from "../../core/errors.ts"
import type { Fetcher } from "../../core/http.ts"
import { vendorLogger } from "../../core/log.ts"
import { markFallback, toConfigModels, toModelRecord } from "../../core/models.ts"
import { defineVendor, modelContextOf, type VendorContext } from "../../core/plugin.ts"
import type { LoaderResult, ModelRecord, StoredAuth, UsageReport } from "../../core/types.ts"
import { claimDaily, fetchApiKeyConfigs, fetchBalance, fetchCatalog, type Session } from "./api.ts"
import { loginMethods } from "./login.ts"
import { fallbackModels, specsFrom } from "./models.ts"
import {
  ASTUDIO_API_BASE,
  ASTUDIO_CLIENT_TYPE,
  ASTUDIO_ICON,
  ASTUDIO_ID,
  ASTUDIO_NAME,
  ASTUDIO_STUDIO_VERSION,
  ASTUDIO_UNAUTHORIZED_STATUS,
} from "./product.ts"
import { accountLabel, controlOf, rememberAccessToken, requireSession, sessionDataOf } from "./session.ts"
import { checkinResult, usageReport } from "./usage.ts"

/** Where this vendor's models are reached; see `core/plugin.ts`. */
const contextOf = (context: VendorContext) => modelContextOf(context, ASTUDIO_API_BASE)

/**
 * 401 自愈链的决策（JetHub `astudioAuthRetryPlan` 同款三格，纯判定便于单测）：
 * 非 401 不重试；401 且换到了**不同**的凭据 → 换凭据重试一次；
 * 401 但凭据没变（或重取失败）→ 终态，原样交还 401 让宿主标记账号。
 */
export function shouldRetryUnauthorized(
  status: number,
  attempted: boolean,
  nextAccessToken: string | undefined,
  previousAccessToken: string,
): boolean {
  if (status !== ASTUDIO_UNAUTHORIZED_STATUS) return false
  if (attempted) return false
  return (
    nextAccessToken !== undefined && nextAccessToken.length > 0 && nextAccessToken !== previousAccessToken
  )
}

interface HealDeps {
  fetcher: Fetcher
  getAuth: () => Promise<StoredAuth | undefined>
  remember: (accessToken: string) => Promise<void>
}

/**
 * 把一次请求的鉴权头换成新凭据后的重试请求。只处理 `(url, init)` 形态
 * （AI SDK 的调用形状，`init.body` 是字符串）；`Request` 入参的 body 已被
 * 第一次 fetch 消费、无法安全重建 —— 这种形态直接放弃重试，401 原样上抛
 * （宿主会标记账号，用户重新登录即可，绝不吞掉失效信号）。
 */
async function retryWithAccessToken(
  fetcher: Fetcher,
  input: Parameters<Fetcher>[0],
  init: Parameters<Fetcher>[1] | undefined,
  accessToken: string,
): Promise<Response | undefined> {
  if (input instanceof Request) return undefined
  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${accessToken}`)
  return await fetcher(input, { ...init, headers })
}

/**
 * loader.fetch 的包装：每次响应都看一眼状态码，401 时走一遍自愈链。
 *
 * 为什么放在 fetch 而不是 loader 里：宿主会缓存 loader 的结果直到登录态变化，
 * 而「凭据被上游作废」恰恰不改变登录态 —— 只有每次请求都跑的这一层才接得住。
 * 自愈是**一次**重取 + **一次**重试：重取是幂等纯读，但换到同一份死凭据时
 * 重试只会永远 401（`shouldRetryUnauthorized` 把三格判据钉死）。
 */
function healingFetch(deps: HealDeps): Fetcher {
  const wrapped = async (input: Parameters<Fetcher>[0], init?: Parameters<Fetcher>[1]): Promise<Response> => {
    const response = await deps.fetcher(input, init)
    if (response.status !== ASTUDIO_UNAUTHORIZED_STATUS) return response
    const auth = await deps.getAuth()
    const session = sessionDataOf(auth)
    const control = session === undefined ? undefined : controlOf(session)
    if (session === undefined || control === undefined) return response
    const configs = await fetchApiKeyConfigs(deps.fetcher, control)
    if (!configs.ok) return response
    await deps.remember(configs.apiKey)
    if (!shouldRetryUnauthorized(response.status, false, configs.apiKey, session.accessToken)) {
      return response
    }
    const retry = await retryWithAccessToken(deps.fetcher, input, init, configs.apiKey)
    // 重试请求本身造不出来（Request 形态）时，交还原始 401，不吞失效信号。
    return retry ?? response
  }
  return wrapped as Fetcher
}

/** loader 显式头的形状：宿主负责 `Authorization`，这里只补客户端形状。 */
function chatHeaderExtras(session: Session): Record<string, string> {
  return {
    Accept: "text/event-stream, application/json",
    clientType: ASTUDIO_CLIENT_TYPE,
    studioVersion: ASTUDIO_STUDIO_VERSION,
    ...(session.accountId === undefined || session.accountId.length === 0
      ? {}
      : { "X-Account-Id": session.accountId }),
  }
}

export const AstudioAuthPlugin = defineVendor(({ client, options }) => {
  const log = vendorLogger(client, ASTUDIO_ID)
  const fallbackRecord = (context: VendorContext): ModelRecord =>
    toModelRecord(fallbackModels(), contextOf(context))
  return {
    id: ASTUDIO_ID,
    displayName: ASTUDIO_NAME,
    icon: ASTUDIO_ICON,
    baseURL: ASTUDIO_API_BASE,
    methods: loginMethods({ options, client, fetcher: fetch }),
    configModels: toConfigModels(fallbackModels()),

    /** 聊天请求携带的形状（`fetch` 是 401 自愈链，见 `healingFetch`）。 */
    async loader(context): Promise<LoaderResult | undefined> {
      const auth = await context.getAuth()
      const session = requireSession(auth, "加载请求头")
      return {
        baseURL: ASTUDIO_API_BASE,
        apiKey: session.accessToken,
        headers: chatHeaderExtras(session),
        fetch: healingFetch({
          fetcher: fetch,
          getAuth: context.getAuth,
          remember: (accessToken) => rememberAccessToken(client, context.provider.id, auth, accessToken),
        }),
      }
    },

    /**
     * 账号自己的模型目录（推理域，Bearer）。读失败 → 回退表并标记；
     * 会话被拒 → 上抛让宿主标记账号（`core/catalog.ts` 的三条规则）。
     */
    async listModels(context) {
      if (sessionDataOf(context.auth) === undefined) return undefined
      const session = requireSession(context.auth, "读取模型目录")
      return await catalogModels({
        read: async () => {
          const catalog = await fetchCatalog(fetch, session)
          if (!catalog.ok) {
            if (catalog.sessionDead) {
              throw new SignInExpiredError(ASTUDIO_ID, catalog.message)
            }
            throw new Error(catalog.message)
          }
          return toModelRecord(specsFrom(catalog.models), contextOf(context))
        },
        fallback: () => markFallback(fallbackRecord(context)),
        log,
      })
    },

    /** 积分窗口（账号域，Cookie 只读）。全部 aside，不参与路由（见 `usage.ts`）。 */
    async usage(context): Promise<UsageReport> {
      const auth = await context.getAuth()
      const session = sessionDataOf(auth)
      if (session === undefined) return { signIn: "expired", error: "账号里没有登录态，请重新登录" }
      const control = controlOf(session)
      if (control === undefined) return { signIn: "expired", error: "账号里没有登录会话 Cookie，请重新登录" }
      const balance = await fetchBalance(fetch, control)
      if (!balance.ok) {
        if (balance.sessionDead) return { signIn: "expired", error: balance.message }
        return { error: balance.message }
      }
      return usageReport(balance.balance, {
        ...(accountLabel(auth) === undefined ? {} : { user: accountLabel(auth) as string }),
      })
    },

    /**
     * 每日签到 = 弹窗奖励领取（每日签到 + 新手礼包）。没有账号域 Cookie 时
     * 如实报失败 —— 推理侧的 Bearer 帮不上控制面的忙。
     */
    async checkin(context) {
      const session = requireSession(await context.getAuth(), "签到")
      const control = controlOf(session)
      if (control === undefined) {
        return { outcome: "failed", message: "账号里没有登录会话 Cookie，请重新登录" }
      }
      const claim = await claimDaily(fetch, control)
      return checkinResult(claim)
    },
  }
})
