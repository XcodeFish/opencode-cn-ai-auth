/**
 * Raccoon as a provider plugin.
 *
 * The shapes the host reads are stated once here: the fallback catalog and
 * its config-model form, the two sign-in methods, the loader that puts the
 * session and the thinking flag on chat requests, the model list as the
 * account sees it, the points the card shows and the renewal the host
 * schedules. Everything else lives in the modules beside this one, and none
 * of them talk to a host directly.
 *
 * Two host details decide the shape of the loader:
 *
 * - `apiKey` carries the session, so the AI SDK's own `Authorization:
 *   Bearer` is the sign-in; the explicit headers repeat it because the same
 *   requests must also carry the organisation code, and chat adds the
 *   desktop client's platform and version.
 * - `fetch` is wrapped, not replaced: magpie builds a chat request from the
 *   agent's words and this is the last place the vendor's own dialect can be
 *   written into it (`extra_body.thinking`, see `thinking.ts`). The wrapper
 *   leaves every other request byte for byte as it came.
 */

import { catalogModels } from "../../core/catalog.ts"
import { SignInExpiredError } from "../../core/errors.ts"
import { vendorLogger } from "../../core/log.ts"
import { markFallback, toConfigModels, toModelRecord } from "../../core/models.ts"
import { defineVendor, modelContextOf, type VendorContext } from "../../core/plugin.ts"
import { patchingJsonBody } from "../../core/request.ts"
import type { ModelRecord, StoredAuth, UsageReport } from "../../core/types.ts"
import { chatHeaders, fetchBalance, fetchCatalog, refreshAccess } from "./api.ts"
import { loginMethods } from "./login.ts"
import { fallbackModels, modelsFrom } from "./models.ts"
import {
  RACCOON_CHAT_BASE,
  RACCOON_ICON,
  RACCOON_ID,
  RACCOON_NAME,
  RACCOON_OFFICE_IDENTITY_OPTION,
  RACCOON_REFRESH_LEAD_MS,
} from "./product.ts"
import { accessOf, accountLabel, officeOf, refreshOf, requireAccess } from "./session.ts"
import { raccoonThinkingPatch } from "./thinking.ts"
import { usageReport } from "./usage.ts"

/** Where this vendor's models are reached; see `core/plugin.ts`. */
const contextOf = (context: VendorContext) => modelContextOf(context, RACCOON_CHAT_BASE)

function officeOfContext(auth: StoredAuth | undefined, options: Record<string, unknown>): string | undefined {
  const configured = options[RACCOON_OFFICE_IDENTITY_OPTION]
  return (
    officeOf(auth) ??
    (typeof configured === "string" && configured.trim().length > 0 ? configured.trim() : undefined)
  )
}

export const RaccoonAuthPlugin = defineVendor(({ client, options }) => {
  const log = vendorLogger(client, RACCOON_ID)
  const fallbackRecord = (context: VendorContext): ModelRecord =>
    markFallback(toModelRecord(fallbackModels(), contextOf(context)))
  return {
    id: RACCOON_ID,
    displayName: RACCOON_NAME,
    icon: RACCOON_ICON,
    baseURL: RACCOON_CHAT_BASE,
    methods: loginMethods({ client, options, fetcher: fetch }),
    configModels: toConfigModels(fallbackModels()),
    refreshLead: RACCOON_REFRESH_LEAD_MS,

    /** What a chat request goes out with. */
    async loader(context) {
      const auth = await context.getAuth()
      const access = requireAccess(auth, "加载请求头")
      return {
        baseURL: RACCOON_CHAT_BASE,
        apiKey: access,
        headers: chatHeaders(access, officeOfContext(auth, options)),
        fetch: patchingJsonBody(fetch, raccoonThinkingPatch),
      }
    },

    /**
     * The account's own catalog. `/model_catalog` is per account (a plan may
     * serve fewer models), and when it cannot be read the packaged table is
     * handed back marked as a fallback, so the editor says so rather than
     * showing the copy as if it were the account's.
     */
    async listModels(context) {
      const access = accessOf(context.auth)
      if (access === undefined) return undefined
      return await catalogModels({
        read: async () =>
          toModelRecord(
            modelsFrom(await fetchCatalog(fetch, access, officeOfContext(context.auth, options))),
            contextOf(context),
          ),
        fallback: () => fallbackRecord(context),
        log,
      })
    },

    /** The points card. Reads only: `/points/v1/balance` has no side effects. */
    async usage(context): Promise<UsageReport> {
      const auth = await context.getAuth()
      const access = accessOf(auth)
      if (access === undefined) return { signIn: "expired", error: "账号里没有 access_token，请重新登录" }
      const balance = await fetchBalance(fetch, access, officeOfContext(auth, options))
      if (!balance.ok) {
        if (balance.signedOut) return { signIn: "expired", error: balance.message }
        return { error: balance.message }
      }
      const user = accountLabel(auth)
      return usageReport(balance.data ?? {}, user === undefined ? {} : { user })
    },

    /**
     * Renewal, which this vendor does rotate: the service may answer with a
     * new refresh token, and when it does not, the old one is still in force
     * — the host merges this patch over the stored sign-in, so keeping the
     * token here is what keeps the account renewable after one renewal.
     *
     * `expires: 0` is the one shape worth explaining: an access token whose
     * `exp` cannot be read gives the host nothing to schedule a renewal
     * against, and `0` is how it is told never to renew (its own rule is
     * `expires > 0`). Leaving the old expiry in place would have it renew on
     * every request from then on.
     */
    async refresh(auth: StoredAuth) {
      const token = refreshOf(auth)
      if (token === undefined) {
        throw new SignInExpiredError(RACCOON_ID, "账号里没有 refresh_token，请重新登录")
      }
      const renewed = await refreshAccess(fetch, token)
      return {
        access: renewed.access,
        refresh: renewed.refresh ?? token,
        expires: renewed.expires ?? 0,
      }
    },
  }
})
