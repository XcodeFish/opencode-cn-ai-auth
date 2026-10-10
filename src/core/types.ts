/**
 * The parts of the magpie / OpenCode plugin host contract this package uses.
 *
 * The authoritative implementation is magpie's `internal/plugin/host.js`; the
 * public description is <https://usemagpie.ai/docs/plugins>. Everything here
 * is optional-safe: a host this package has not met yet must still load, so
 * vendor code reads fields defensively instead of trusting these types.
 */

export interface PluginClient {
  auth: {
    /** Saves the account in scope; the body replaces what was stored. */
    set(input: { path: { id: string }; body: StoredAuth }): Promise<unknown>
    remove?(input: { path: { id: string } }): Promise<unknown>
  }
  app?: {
    log?(input: { service?: string; level?: string; message: string }): Promise<unknown> | unknown
  }
  tui?: {
    showToast?(input: { title?: string; message?: string; variant?: string }): Promise<unknown> | unknown
  }
  config?: {
    get?(): Promise<{ data?: unknown }>
  }
}

export interface PluginInput {
  client: PluginClient
  app?: unknown
  directory?: string
  worktree?: string
  [key: string]: unknown
}

/** What the host gives a plugin's hooks: the stored sign-in of the account. */
export interface StoredAuth {
  type?: string
  /** An API key sign-in's key. */
  key?: string
  /** An OAuth sign-in's current token. */
  access?: string
  /** An OAuth sign-in's renewal token, when the vendor has one. */
  refresh?: string
  /** When `access` stops being valid, in epoch milliseconds. */
  expires?: number
  accountId?: string
  /**
   * What the host keeps beside a sign-in of its own accord. An OAuth
   * sign-in keeps extra fields at the top level, but an API-key one is
   * rebuilt to `{ type, key, metadata }` when it is stored
   * (`internal/plugin/host.js`'s `save`), so anything learned about such
   * an account — its organisation, its phone number — is only reachable
   * here. Vendor readers look in both places.
   */
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface MethodPrompt {
  type: "text" | "select"
  key: string
  message: string
  placeholder?: string
  options?: { label: string; value: string; hint?: string }[]
  when?: { key: string; op: "eq" | "ne"; value: string }
  condition?: (inputs: Record<string, string>) => boolean
  validate?: (value: string) => string | undefined
}

/** What `authorize` gives the host once the browser flow has started. */
export interface AuthorizeResult {
  /** Opened in the user's browser; may be empty for a terminal-only flow. */
  url?: string
  instructions?: string
  /** `auto`: the plugin finishes on its own; `code`: the user pastes a code. */
  method?: "auto" | "code"
  callback: (code?: string) => Promise<SignInResult> | SignInResult
}

export type SignInResult =
  | {
      type: "success"
      /** Store the sign-in under another provider id of this package. */
      provider?: string
      /** An API key, when this is a key sign-in. */
      key?: string
      /** OAuth fields; `refresh` marks the stored account as OAuth. */
      refresh?: string
      access?: string
      expires?: number
      /** Names the account; the vendor's user id. */
      accountId?: string
      [key: string]: unknown
    }
  | { type: "failed"; error?: string }

export interface OAuthMethod {
  type: "oauth"
  label: string
  prompts?: MethodPrompt[]
  authorize: (inputs?: Record<string, string>) => Promise<AuthorizeResult> | AuthorizeResult
}

export interface ApiMethod {
  type: "api"
  label: string
  placeholder?: string
  prompts?: MethodPrompt[]
  authorize?: (inputs: Record<string, string>) => Promise<SignInResult> | SignInResult
}

export type AuthMethod = OAuthMethod | ApiMethod

export interface LoaderResult {
  baseURL?: string
  apiKey?: string
  headers?: Record<string, string>
  fetch?: typeof fetch
}

export interface RefreshPatch {
  access?: string
  refresh?: string
  expires?: number
  [key: string]: unknown
}

export interface UsageWindow {
  name: string
  /** Percent used; over 100 when overspent. */
  used: number
  resetsAt?: string | number
  resetSecs?: number
  span?: number
  display?: string
  amount?: number
  limit?: number
  unit?: string
  /** Only the models whose ids contain this word count. */
  model?: string
  models?: string[]
  notModels?: string[]
  /** Using it up does not stop the account. */
  aside?: boolean
}

export interface UsageReport {
  plan?: string
  user?: string
  until?: string | number
  renew?: "auto" | "off"
  balance?: string
  error?: string
  windows?: UsageWindow[]
  resets?: { count: number; until?: string; byWindow?: boolean; fiveHour?: number; weekly?: number }
  signIn?: "expired" | "kept" | "renewed"
}

export type CheckinOutcome = "claimed" | "done" | "ineligible" | "inactive" | "captcha" | "failed"

export interface CheckinResult {
  outcome: CheckinOutcome
  credit?: number
  streak?: number
  message?: string
}

/** One model as `provider.models` returns it (OpenCode's `Model`). */
export interface GatewayModel {
  id: string
  name?: string
  providerID?: string
  api?: { id?: string; url?: string; npm?: string }
  status?: string
  headers?: Record<string, string>
  options?: Record<string, unknown>
  cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } }
  limit?: { context?: number; input?: number; output?: number }
  capabilities?: {
    temperature?: boolean
    reasoning?: boolean
    attachment?: boolean
    toolcall?: boolean
    input?: { text?: boolean; image?: boolean; audio?: boolean; video?: boolean; pdf?: boolean }
    output?: { text?: boolean; image?: boolean; audio?: boolean; video?: boolean; pdf?: boolean }
    interleaved?: boolean
  }
  variants?: Record<string, unknown>
  release_date?: string
  free?: boolean
  /** The plan credits one request costs, as a multiple. */
  rate?: number | string
  /** The multiple before a discount now running. */
  rateWas?: number | string
}

export type ModelRecord = Record<string, GatewayModel>

/** The `provider` argument hooks receive: the models assembled so far. */
export interface ProviderInfo {
  id: string
  name?: string
  npm?: string
  api?: string
  models: ModelRecord
}

/** The config hook's view: `config.provider[id]`. */
export interface ConfigProvider {
  name?: string
  npm?: string
  api?: string
  models?: Record<string, unknown>
}

export interface Hooks {
  config?: (config: { provider?: Record<string, ConfigProvider> }) => Promise<void> | void
  auth: {
    provider: string
    methods: AuthMethod[]
    loader: (getAuth: GetAuth, provider: ProviderInfo) => Promise<LoaderResult>
    usage?: (getAuth: GetAuth, provider: ProviderInfo) => Promise<UsageReport>
    checkin?: (getAuth: GetAuth, provider: ProviderInfo) => Promise<CheckinResult>
    refresh?: (auth: StoredAuth, provider: ProviderInfo) => Promise<RefreshPatch | undefined>
    refreshLead?: number
    icon?: string
    maxConcurrency?: number
  }
  provider?: {
    id: string
    models: (provider: ProviderInfo, context?: { auth?: StoredAuth }) => Promise<ModelRecord | undefined>
  }
}

export type GetAuth = () => Promise<StoredAuth | undefined>

export type PluginFunction = (input: PluginInput, options?: unknown) => Promise<Hooks>
