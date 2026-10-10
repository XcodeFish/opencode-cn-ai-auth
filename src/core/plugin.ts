/**
 * The base every vendor plugs into.
 *
 * A vendor states its provider id, catalog, sign-in methods and hooks once;
 * `defineVendor` turns that into the `{ config, auth, provider }` hooks the
 * host (magpie or OpenCode) calls. Keeping the assembly here means vendors
 * cannot drift on the host contract, and every hook can be unit-tested
 * without a host.
 */

import { isObject } from "./json.ts"
import type { ModelContext } from "./models.ts"
import type {
  AuthMethod,
  CheckinResult,
  GetAuth,
  Hooks,
  LoaderResult,
  ModelRecord,
  PluginClient,
  PluginInput,
  ProviderInfo,
  RefreshPatch,
  StoredAuth,
  UsageReport,
} from "./types.ts"

export interface VendorContext {
  getAuth: GetAuth
  provider: ProviderInfo
  client: PluginClient
  /** The `options` object of this vendor's plugins.json entry. */
  options: Record<string, unknown>
}

/**
 * Where a vendor's models are reached, as the model builders want it.
 *
 * A vendor states its own base URL as the fallback; the host's answer wins
 * when it has one, since a user may have pointed the provider elsewhere.
 * One helper rather than one per vendor: the same two lines had been written
 * three times, each with a different default to keep in step.
 */
export function modelContextOf(context: VendorContext, baseURL: string): ModelContext {
  return {
    providerID: context.provider.id,
    npm: context.provider.npm ?? DEFAULT_NPM,
    api: context.provider.api ?? baseURL,
  }
}

export interface VendorDefinition {
  id: string
  displayName: string
  /**
   * The picture magpie shows beside this provider: a `data:image/` URI or an
   * `https` URL of a picture on a public host, at most 1 MB. Anything else is
   * dropped **without a word** (the host's `iconOf` only keeps those two
   * shapes, and a bare market icon name such as `spark-color` is not one of
   * them) — measured against magpie 0.1.1137, so `scripts/check.ts` fails on
   * it instead of leaving an icon missing with no error anywhere.
   *
   * One vendor per value: a package's `package.json` icon is the fallback for
   * every provider that names none, which would draw the wrong vendor's mark.
   */
  icon?: string
  npm?: string
  /** Where the vendor's OpenAI-compatible API lives (its base URL). */
  baseURL: string
  methods: AuthMethod[]
  configModels: Record<string, unknown>
  loader: (context: VendorContext) => Promise<LoaderResult | undefined>
  /**
   * Answers with this account's models. Returning undefined keeps the list
   * the host gave; throwing with `signIn: "expired"` marks the account.
   */
  listModels?: (
    context: VendorContext & { auth: StoredAuth | undefined; given: ModelRecord },
  ) => Promise<ModelRecord | undefined>
  usage?: (context: VendorContext) => Promise<UsageReport>
  checkin?: (context: VendorContext) => Promise<CheckinResult>
  refresh?: (auth: StoredAuth, provider: ProviderInfo) => Promise<RefreshPatch | undefined>
  refreshLead?: number
  maxConcurrency?: number
}

export type VendorPlugin = (input: PluginInput, options?: unknown) => Promise<Hooks>

/** What a vendor's setup gets: the host's client and the entry's options. */
export interface VendorRuntime {
  client: PluginClient
  options: Record<string, unknown>
}

/**
 * A vendor's definition, or a function building one. The function form is
 * for a vendor whose **methods** depend on what the user configured — an SMS
 * sign-in that needs a credential the vendor's client ships, and is offered
 * only once that credential resolves, is the reason it exists.
 */
export type VendorSetup = (runtime: VendorRuntime) => VendorDefinition

const DEFAULT_NPM = "@ai-sdk/openai-compatible"

/**
 * The factory is named `vendorAuthPlugin`, not after its vendor: a vendor
 * built from setup code states its id only when it runs, and a name that
 * disagreed with the export would send someone grepping for the wrong
 * symbol (`scripts/check.ts` prints both when they differ). What names a
 * plugin is the export it is bound to — `<Vendor>AuthPlugin`, one per
 * provider, checked by that same gate.
 */
export function defineVendor(source: VendorDefinition | VendorSetup): VendorPlugin {
  const plugin = async function vendorAuthPlugin(input: PluginInput, options?: unknown): Promise<Hooks> {
    const vendorOptions = isObject(options) ? options : {}
    const vendor =
      typeof source === "function" ? source({ client: input.client, options: vendorOptions }) : source
    const { refresh, usage, checkin } = vendor
    const context = (getAuth: GetAuth, provider: ProviderInfo): VendorContext => ({
      getAuth,
      provider,
      client: input.client,
      options: vendorOptions,
    })

    const hooks: Hooks = {
      config: (config) => {
        config.provider ??= {}
        config.provider[vendor.id] ??= {
          name: vendor.displayName,
          npm: vendor.npm ?? DEFAULT_NPM,
          api: vendor.baseURL,
          models: vendor.configModels,
        }
      },
      auth: {
        provider: vendor.id,
        methods: vendor.methods,
        loader: async (getAuth, provider) => (await vendor.loader(context(getAuth, provider))) ?? {},
        ...(vendor.icon === undefined ? {} : { icon: vendor.icon }),
        ...(vendor.maxConcurrency === undefined ? {} : { maxConcurrency: vendor.maxConcurrency }),
        ...(refresh === undefined
          ? {}
          : { refresh: (auth: StoredAuth, provider: ProviderInfo) => refresh(auth, provider) }),
        ...(vendor.refreshLead === undefined ? {} : { refreshLead: vendor.refreshLead }),
        ...(usage === undefined
          ? {}
          : { usage: (getAuth: GetAuth, provider: ProviderInfo) => usage(context(getAuth, provider)) }),
        ...(checkin === undefined
          ? {}
          : {
              checkin: (getAuth: GetAuth, provider: ProviderInfo) => checkin(context(getAuth, provider)),
            }),
      },
      provider: {
        id: vendor.id,
        models: async (provider, hookContext) => {
          if (vendor.listModels === undefined) return provider.models
          const auth = hookContext?.auth
          const result = await vendor.listModels({
            ...context(async () => auth, provider),
            auth,
            given: provider.models,
          })
          return result ?? provider.models
        },
      },
    }
    return hooks
  }
  return plugin
}
