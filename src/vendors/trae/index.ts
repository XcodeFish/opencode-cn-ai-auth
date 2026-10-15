/**
 * Trae as a provider plugin.
 *
 * This is the only module in the vendor that touches the host contract; the
 * modules beside it take a `Fetcher` and plain values so they can be tested
 * without a host (`docs/architecture.md` §2).
 *
 * Two of the hooks do something the other vendors' do not, and both follow
 * from Trae not being an OpenAI-compatible provider:
 *
 * - `loader` returns a `fetch` that **rewrites the request and the response**
 *   (`wire.ts`), because neither side of this protocol is the one the host
 *   writes.
 * - `provider.models` has to remember which **channel** each model came from.
 *   The host's model shape has no field for it and a request through a
 *   channel that does not list the model is refused in-stream with `4001`.
 */

import { catalogModels } from "../../core/catalog.ts"
import { vendorLogger } from "../../core/log.ts"
import { markFallback, toConfigModels, toModelRecord } from "../../core/models.ts"
import { defineVendor, modelContextOf, type VendorContext } from "../../core/plugin.ts"
import type { GetAuth, RefreshPatch, UsageReport } from "../../core/types.ts"
import { identityFields, requestIds, soloHeaders, type TraeCredential } from "./api.ts"
import { claimCheckin, creditsMissing, fetchCheckinStatus, fetchCredits, usageReport } from "./credits.ts"
import { loginMethods, refreshCredential } from "./login.ts"
import { channelFor, fallbackCatalog, readCatalog, type TraeCatalog } from "./models.ts"
import {
  TRAE_AGENT_BASE,
  TRAE_CLIENT,
  TRAE_ICON,
  TRAE_ID,
  TRAE_NAME,
  TRAE_REFRESH_LEAD_MS,
} from "./product.ts"
import { accountLabel, credentialFor, credentialOrUndefined } from "./session.ts"
import { chatFetch } from "./wire.ts"

/** Where this vendor's models are reached; see `core/plugin.ts`. */
const contextOf = (context: VendorContext) => modelContextOf(context, TRAE_AGENT_BASE)

export const TraeAuthPlugin = defineVendor(({ client, options }) => {
  void options
  const log = vendorLogger(client, TRAE_ID)

  /**
   * Which catalog entry a model id refers to, per plugin instance.
   *
   * Rebuilt by every catalog read rather than cached across accounts: it is
   * small, the reads are rare, and a longer-lived copy would need invalidating
   * whenever the account changes.
   */
  let catalog: TraeCatalog = fallbackCatalog()

  /**
   * Whether a catalog read has succeeded.
   *
   * It gates the lazy read in `chatFetch`: without it, a model the catalog
   * does not list would trigger a fresh read on every request.
   */
  let catalogLoaded = false

  /**
   * The account handle for the in-flight request.
   *
   * `loader` is given the host's `getAuth` and the `fetch` it returns runs per
   * request; the two are joined here so a request reads the credential the
   * account holds **at that moment**, not the one the loader saw (the host
   * caches a loader result across a renewal).
   */
  let authSource: GetAuth | undefined

  const credentialNow = async (): Promise<TraeCredential | undefined> => {
    const getAuth = authSource
    if (getAuth === undefined) return undefined
    return credentialOrUndefined(await getAuth())
  }

  return {
    id: TRAE_ID,
    displayName: TRAE_NAME,
    icon: TRAE_ICON,
    baseURL: TRAE_AGENT_BASE,
    methods: loginMethods({ client, fetcher: fetch }),
    configModels: toConfigModels(fallbackCatalog().models),
    refreshLead: TRAE_REFRESH_LEAD_MS,

    async loader(context) {
      authSource = context.getAuth
      const credential = credentialFor(await context.getAuth(), "加载请求头")
      return {
        baseURL: TRAE_AGENT_BASE,
        apiKey: credential.accessToken,
        headers: soloHeaders(credential, TRAE_CLIENT, true),
        fetch: chatFetch({
          fetcher: fetch,
          credentialNow,
          channelFor: (model) => channelFor(catalog, model),
          catalogHas: (model) => catalog.channels.has(model),
          catalogLoaded: () => catalogLoaded,
          ensureCatalog: async (current: TraeCredential) => {
            // A chat can arrive before the host has ever asked for the model
            // list — then the channel table is empty and every request would
            // fall through to the default channel, which the upstream answers
            // with `4001` for the models the default does not serve. So the
            // catalog is read on the first chat that has no entry for its model.
            const read = await readCatalog(fetch, current)
            if (read !== undefined) {
              catalog = read
              catalogLoaded = true
            }
          },
          logWarn: (message) => log.warn(message),
        }),
      }
    },

    async listModels(context) {
      const credential = credentialOrUndefined(context.auth)
      if (credential === undefined) return undefined
      return await catalogModels({
        read: async () => {
          const read = await readCatalog(fetch, credential)
          if (read === undefined) return undefined
          catalog = read
          catalogLoaded = true
          return toModelRecord(catalog.models, contextOf(context))
        },
        fallback: () => {
          catalog = fallbackCatalog()
          return markFallback(toModelRecord(catalog.models, contextOf(context)))
        },
        log,
      })
    },

    /**
     * The credit packs, plus whether today's check-in is still available.
     *
     * Read-only. The status read rides along because its answer is what lets
     * the card say how much today's check-in is worth; without it the card
     * would only show a balance.
     */
    async usage(context): Promise<UsageReport> {
      const auth = await context.getAuth()
      const credential = credentialOrUndefined(auth)
      if (credential === undefined) {
        return { signIn: "expired", error: "账号里没有 Trae 登录态，请重新登录" }
      }
      const ids = requestIds()
      const credits = await fetchCredits(fetch, credential, ids)
      if (credits === undefined || creditsMissing(credits)) {
        return { error: "无法读取 Trae 积分，请稍后重试" }
      }
      const status = await fetchCheckinStatus(fetch, credential, ids).catch(() => undefined)
      const label = accountLabel(auth)
      return usageReport(credits, {
        ...(label === undefined ? {} : { user: label }),
        ...(status === undefined ? {} : { extraWindows: [checkinWindow(status)] }),
      })
    },

    /**
     * Today's check-in, on demand.
     *
     * The package's only call that changes the vendor's state. It is reachable
     * only from the host's check-in hook — the button on the usage card,
     * `magpie accounts checkin`, or the host's daily scheduler — and never as
     * a side effect of a read.
     */
    async checkin(context) {
      const credential = credentialFor(await context.getAuth(), "签到")
      return await claimCheckin(fetch, credential, requestIds())
    },

    /**
     * Renewal.
     *
     * The exchange rotates the refresh token, so the new value is written back
     * together with the device identity, which must not change.
     */
    async refresh(auth): Promise<RefreshPatch | undefined> {
      const credential = credentialFor(auth, "续期")
      const next = await refreshCredential(credential, { client, fetcher: fetch })
      return {
        access: next.accessToken,
        refresh: next.refreshToken,
        ...(next.expiresAt === undefined ? {} : { expires: next.expiresAt }),
        // The device identity and the account id survive a renewal untouched;
        // the host merges this over what it stored, so anything not listed
        // here keeps its old value.
        ...identityFields(next),
      }
    },
  }
})

/** The check-in line the usage card carries beside the credit packs. */
function checkinWindow(status: { enabled: boolean; checkedIn: boolean; dailyCredit?: number }): {
  name: string
  used: number
  aside: boolean
  unit: string
  display: string
} {
  if (!status.enabled) {
    return { name: "每日签到", used: 0, aside: true, unit: "积分", display: "每日签到 未开放" }
  }
  if (status.checkedIn) {
    return { name: "每日签到", used: 0, aside: true, unit: "积分", display: "每日签到 已领取" }
  }
  const reward = status.dailyCredit === undefined ? "" : ` ${status.dailyCredit} 积分`
  return { name: "每日签到", used: 0, aside: true, unit: "积分", display: `每日签到 今日可领${reward}` }
}
