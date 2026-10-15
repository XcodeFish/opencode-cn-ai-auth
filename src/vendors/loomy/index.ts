/**
 * Loomy as a provider plugin.
 *
 * The shapes the host reads are stated once here: the fallback catalog and
 * its config-model form, the two sign-in methods, the loader that puts the
 * session on chat requests, the model list as the account sees it, the two
 * credit pools and the daily check-in. Everything else lives in the modules
 * beside this one, and none of them talk to a host directly.
 */

import { catalogModels } from "../../core/catalog.ts"
import { SignInExpiredError } from "../../core/errors.ts"
import { gatedFetch } from "../../core/gate.ts"
import { vendorLogger } from "../../core/log.ts"
import { markFallback, toConfigModels, toModelRecord } from "../../core/models.ts"
import { defineVendor, modelContextOf, type VendorContext } from "../../core/plugin.ts"
import type { ModelRecord, UsageReport } from "../../core/types.ts"
import { chatHeaders, claimDailyQuota, claimOnboardingTasks, fetchCatalog, fetchPoints } from "./api.ts"
import { lockedRefusal, rememberDailyBalance } from "./balance.ts"
import { loginMethods } from "./login.ts"
import { fallbackModels, modelsFrom } from "./models.ts"
import { LOOMY_API_BASE, LOOMY_ICON, LOOMY_ID, LOOMY_NAME, LOOMY_SIGNED_OUT_CODE } from "./product.ts"
import { accountLabel, rememberedQuota, rememberQuota, requireSession, sessionOf } from "./session.ts"
import { checkinResult, quotaForNow, usageReport } from "./usage.ts"

/** Where this vendor's models are reached; see `core/plugin.ts`. */
const contextOf = (context: VendorContext) => modelContextOf(context, LOOMY_API_BASE)

export const LoomyAuthPlugin = defineVendor(({ client, options }) => {
  const log = vendorLogger(client, LOOMY_ID)
  const fallbackRecord = (context: VendorContext): ModelRecord =>
    toModelRecord(fallbackModels(), contextOf(context))
  return {
    id: LOOMY_ID,
    displayName: LOOMY_NAME,
    icon: LOOMY_ICON,
    baseURL: LOOMY_API_BASE,
    methods: loginMethods({ client, options, fetcher: fetch }),
    configModels: toConfigModels(fallbackModels()),

    /**
     * What a chat request goes out with. The session rides in `apiKey` (so the
     * AI SDK's own `Authorization: Bearer` is the session) and again in the
     * explicit headers, because this base wants the lowercase `token` header as
     * well and answers `100002 缺少 token` without it.
     *
     * `fetch` carries the locked-permanent refusal: the host caches this
     * loader's result until the sign-in changes, so the decision is taken per
     * request against the cached reading rather than once here (`balance.ts`).
     */
    async loader(context) {
      const auth = await context.getAuth()
      const access = requireSession(auth, "加载请求头")
      return {
        baseURL: LOOMY_API_BASE,
        apiKey: access,
        headers: chatHeaders(access),
        fetch: gatedFetch(fetch, () => lockedRefusal(auth, options)),
      }
    },

    /**
     * The account's own catalog. `/models` is per account (a plan may serve
     * fewer models), and when it cannot be read the host's list — this
     * package's fallback table — is handed back marked as a fallback, so the
     * editor says so rather than showing the copy as if it were the account's.
     */
    async listModels(context) {
      const access = sessionOf(context.auth)
      if (access === undefined) return undefined
      return await catalogModels({
        read: async () => toModelRecord(modelsFrom(await fetchCatalog(fetch, access)), contextOf(context)),
        fallback: () => markFallback(fallbackRecord(context)),
        log,
      })
    },

    /** The two pools. Reads only: `points/records` has no side effects. */
    async usage(context): Promise<UsageReport> {
      const auth = await context.getAuth()
      const access = sessionOf(auth)
      if (access === undefined) return { signIn: "expired", error: "账号里没有 session，请重新登录" }
      const points = await fetchPoints(fetch, access)
      if (!points.ok) {
        if (points.code === LOOMY_SIGNED_OUT_CODE) return { signIn: "expired", error: points.message }
        return { error: points.message }
      }
      // `points/records` does not state the day's ceiling: only the check-in
      // answer does. The quota the account kept at its last check-in is what
      // lets this reading draw the share-used window the host routes by, and
      // a quota from an earlier day is dropped rather than carried over
      // (`usage.ts`'s `quotaForNow`).
      const today = quotaForNow(points.data, rememberedQuota(auth), Date.now())
      // This is the reading the locked-permanent gate refuses on
      // (`balance.ts`): it means the day is spent even when the permanent
      // pool is not, and it is the same number the card shows.
      rememberDailyBalance(auth, today.daily)
      // `points/records` states the day's quota once a check-in has happened:
      // keep it, so the daily pool can be a window the host routes by.
      await rememberQuota(client, context.provider.id, auth, today.dailyQuota, today.dailyCycleDate)
      return usageReport(today, {
        ...(accountLabel(auth) === undefined ? {} : { user: accountLabel(auth) as string }),
      })
    },

    /**
     * The vendor's own "first login of the day", which is its check-in —
     * and, on the same press, the new-user tasks the account has not
     * finished.
     *
     * The tasks ride here because this hook is the only write the host
     * offers and the only one a user can press on demand (`Check in now`).
     * Claiming them spends no model tokens: the service sets the flag and
     * adds the credits without checking that anything happened (`api.ts`).
     * An account with all eight done sends nothing, so the usual case costs
     * a single extra read.
     */
    async checkin(context) {
      const auth = await context.getAuth()
      const access = requireSession(auth, "签到")
      const grant = await claimDailyQuota(fetch, access)
      if (!grant.ok) {
        if (grant.code === LOOMY_SIGNED_OUT_CODE) {
          throw new SignInExpiredError(LOOMY_ID, `签到被拒绝：${grant.message}`)
        }
        return { outcome: "failed", message: grant.message }
      }
      await rememberQuota(client, context.provider.id, auth, grant.data.dailyQuota, grant.data.dailyCycleDate)
      // A check-in is the other way the day's balance becomes known, and the
      // gate must see it at once rather than wait for the next usage read.
      rememberDailyBalance(auth, grant.data.daily)
      // The day's quota is what the host stores; the task claim is best
      // effort on top of it, and a refusal there must not undo the check-in.
      const tasks = await claimOnboardingTasks(fetch, access)
      if (!tasks.ok) {
        if (tasks.code === LOOMY_SIGNED_OUT_CODE) {
          throw new SignInExpiredError(LOOMY_ID, `新手任务被拒绝：${tasks.message}`)
        }
        await log.warn(`新手任务领取失败：${tasks.message}`)
      }
      return checkinResult(grant.data, tasks.ok ? tasks.data : undefined)
    },
  }
})
