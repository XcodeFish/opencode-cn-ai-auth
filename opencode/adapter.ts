/**
 * Small, dependency-free OpenCode V2 adapter.
 *
 * OpenCode supplies its plugin runtime to a loaded package at runtime. The
 * Magpie implementation in `src/` deliberately does not depend on the
 * package, so this module keeps the V2 surface structural and only uses the
 * public `setup(ctx)`/provider-transform contract. This also lets `tsc` and
 * the offline test suite run without installing a particular OpenCode release.
 */

import type { ModelSpec } from "../src/core/models.ts"
import type { AuthMethod, PluginClient, SignInResult } from "../src/core/types.ts"

interface OpenCodeProviderEditor {
  add(input: { info: Record<string, unknown>; models: readonly Record<string, unknown>[] }): void
}

export interface OpenCodeContext {
  options?: unknown
  provider?: {
    transform(callback: (editor: OpenCodeProviderEditor) => void): Promise<unknown>
  }
  session?: {
    hook(
      name: "http.request" | "http.response",
      callback: (event: unknown) => void | Promise<void>,
      options?: Record<string, unknown>,
    ): Promise<unknown>
  }
  integration?: {
    transform(callback: (editor: OpenCodeIntegrationEditor) => void): Promise<unknown>
    connection?: {
      active(integrationID: string): Promise<unknown>
      resolve(connection: unknown): Promise<unknown>
    }
  }
}

interface OpenCodeIntegrationEditor {
  method: {
    update(input: {
      integrationID: string
      method: Record<string, unknown>
      authorize?: (inputs: Record<string, string>) => Promise<OpenCodeOAuthAuthorization>
      refresh?: (credential: OpenCodeCredentialOAuth) => Promise<OpenCodeCredentialOAuth>
    }): void
  }
}

type OpenCodeOAuthAuthorization = {
  url: string
  instructions: string
} & (
  | { mode: "auto"; callback: Promise<OpenCodeCredentialOAuth> }
  | { mode: "code"; callback: (code: string) => Promise<OpenCodeCredentialOAuth> }
)

interface OpenCodeCredentialOAuth {
  type: "oauth"
  methodID: string
  access: string
  refresh: string
  expires: number
  metadata?: Record<string, unknown>
}

/**
 * What a request/response rewrite is given.
 *
 * The credential is the live one — resolved per request rather than at setup
 * — because a sign-in can be renewed while the session is running. `metadata`
 * is where fields a vendor's protocol needs but the V2 credential schema has
 * no room for are kept (Trae's device fingerprints, for instance).
 */
export interface OpenCodeCredential {
  access: string
  metadata: Record<string, unknown>
}

export interface OpenCodeBridge {
  /**
   * Rewrite the provider's outgoing request.
   *
   * Returning `undefined` keeps the request exactly as the host built it. A
   * vendor whose chat endpoint is not OpenAI's (Trae) changes the URL, the
   * headers and the body here.
   */
  request?: (
    request: Request,
    credential: OpenCodeCredential,
  ) => Promise<Request | undefined> | Request | undefined
  /**
   * Rewrite the provider's answer, after `request` has run.
   *
   * Returning `undefined` hands the host the upstream response unchanged.
   */
  response?: (
    response: Response,
    request: Request,
    credential: OpenCodeCredential,
  ) => Promise<Response | undefined> | Response | undefined
}

export interface OpenCodeVendorDefinition {
  id: string
  name: string
  baseURL: string
  env: string
  models: readonly ModelSpec[]
  /** Static request headers derived from plugin options (for org accounts). */
  optionHeaders?: (options: Record<string, unknown>) => Record<string, string>
  /** Magpie's browser flows, exposed as V2 integration OAuth methods. */
  authMethods?: (options: Record<string, unknown>, client: PluginClient) => readonly AuthMethod[]
  /** Refresh a credential returned by an OAuth flow, when the vendor supports it. */
  refresh?: (
    credential: OpenCodeCredentialOAuth,
  ) => Promise<Pick<OpenCodeCredentialOAuth, "access" | "refresh" | "expires">>
  /** Translate a host variant id to the vendor request body. */
  variantBody?: (effort: string) => Record<string, unknown>
  /**
   * Environment variables that carry the extra credential fields of a bridge
   * vendor, for the env/key sign-in methods (see `credentialFromOptions`).
   */
  credentialEnv?: Record<string, string>
  /**
   * Rewrite the provider's requests and answers.
   *
   * Only a vendor whose endpoint is not OpenAI-compatible needs this (Trae);
   * the other two speak the protocol already. When present, the adapter
   * installs the host's request/response hooks, if the host offers them.
   */
  bridge?: OpenCodeBridge
}

function optionsOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringOption(options: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = options[key]
    if (typeof value === "string" && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function modelInfo(definition: OpenCodeVendorDefinition, spec: ModelSpec): Record<string, unknown> {
  const variants = (spec.efforts ?? []).map((effort) => ({
    id: effort,
    ...(definition.variantBody === undefined ? {} : { body: definition.variantBody(effort) }),
  }))
  return {
    id: spec.id,
    modelID: spec.id,
    providerID: definition.id,
    name: spec.name,
    package: "@opencode/ai/providers/openai-compatible",
    headers: {},
    body: {},
    capabilities: {
      tools: spec.toolCall ?? true,
      input: spec.images === true ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    variants,
    time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: spec.context ?? 0, output: spec.output ?? 0 },
  }
}

function addAuthHeaders(event: unknown, baseURL: string, access: string): void {
  const value = optionsOf(event)
  const request = optionsOf(value.request)
  const url = typeof request.url === "string" ? request.url : typeof value.url === "string" ? value.url : ""
  if (url.length > 0 && !url.startsWith(baseURL)) return
  const candidate = request.headers ?? value.headers
  if (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof (candidate as { set?: unknown }).set === "function"
  ) {
    const headers = candidate as { set(name: string, value: string): void }
    headers.set("Authorization", `Bearer ${access}`)
    // Loomy reads this lowercase header in addition to Authorization. Raccoon
    // ignores it, so keeping it here makes the shared adapter safe for both.
    headers.set("token", access)
    return
  }
  const headers = optionsOf(candidate)
  headers.Authorization = `Bearer ${access}`
  headers.token = access
  if (request.headers !== undefined) request.headers = headers
  else value.headers = headers
}

function openCodeClient(): PluginClient {
  return {
    auth: { set: async () => undefined },
    app: { log: () => undefined },
  }
}

function oauthCredential(result: SignInResult, methodID: string): OpenCodeCredentialOAuth {
  if (result.type !== "success") throw new Error(result.error ?? "登录失败")
  const access = typeof result.access === "string" ? result.access : result.key
  if (access === undefined || access.length === 0) throw new Error("登录响应缺少 access token")
  const refresh = typeof result.refresh === "string" ? result.refresh : ""
  // OpenCode V2's OAuth callback has one credential shape, while Magpie can
  // return a key sign-in with no renewal token. Keep that credential usable
  // until the vendor rejects it; the refresh callback below also short-circuits
  // an empty refresh token if a host invokes it defensively.
  const expires =
    typeof result.expires === "number" && Number.isFinite(result.expires) && result.expires > 0
      ? result.expires
      : refresh.length > 0
        ? 0
        : Number.MAX_SAFE_INTEGER
  // V2 credentials are keyed by the registered method, and the schema has no
  // room for anything else the sign-in learned — a vendor's device
  // fingerprints, its account id. Those are kept under `metadata`, which is
  // the one field the schema leaves open; dropping them here would leave an
  // account that cannot build a request.
  const metadata = credentialMetadata(result)
  return {
    type: "oauth",
    methodID,
    access,
    refresh,
    expires,
    ...(metadata === undefined ? {} : { metadata }),
  }
}

function credentialAccess(value: unknown): string | undefined {
  const credential = optionsOf(value)
  const access = credential.access
  if (typeof access === "string" && access.length > 0) return access
  const key = credential.key
  return typeof key === "string" && key.length > 0 ? key : undefined
}

/**
 * Everything the sign-in learned that the V2 credential schema has no field
 * for, kept under `metadata`.
 *
 * `SignInResult` allows arbitrary extra keys, and a vendor's protocol may
 * depend on them: Trae identifies a device by two hex fingerprints handed out
 * once at sign-in, so losing them here leaves the account unable to build a
 * request at all.
 */
function credentialMetadata(result: SignInResult): Record<string, unknown> | undefined {
  const reserved = new Set(["type", "access", "key", "refresh", "expires", "provider"])
  const metadata: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(result)) {
    if (reserved.has(name) || value === undefined) continue
    metadata[name] = value
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata
}

/** The metadata a credential carries; the empty object when it carries none. */
function metadataOf(value: unknown): Record<string, unknown> {
  const credential = optionsOf(value)
  return optionsOf(credential.metadata)
}

/** The live credential, in the shape a bridge gets. */
export interface OpenCodeCredential {
  access: string
  metadata: Record<string, unknown>
}

async function activeCredential(
  context: OpenCodeContext,
  integrationID: string,
): Promise<OpenCodeCredential | undefined> {
  const connection = context.integration?.connection
  if (connection === undefined) return undefined
  try {
    const active = await connection.active(integrationID)
    if (active === undefined) return undefined
    const resolved = await connection.resolve(active)
    const access = credentialAccess(resolved)
    if (access === undefined) return undefined
    return { access, metadata: metadataOf(resolved) }
  } catch {
    // A missing or expired integration is left to the host's own error path.
    return undefined
  }
}

/**
 * The fields a credential built from plugin options carries.
 *
 * The env/key sign-in methods hand the host only a token, so a vendor whose
 * protocol needs more than a token (Trae carries two device fingerprints and
 * an account id in its headers) names the extra variables in `credentialEnv`;
 * a value given in `options` wins over the variable.
 */
function credentialFromOptions(
  options: Record<string, unknown>,
  credentialEnv: Record<string, string> | undefined,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  for (const name of ["uid", "machineId", "deviceId", "nickname", "enterpriseId", "accountId"]) {
    const fromOptions = options[name]
    const value =
      typeof fromOptions === "string" && fromOptions.length > 0 ? fromOptions : readEnv(credentialEnv?.[name])
    if (value !== undefined) metadata[name] = value
  }
  return metadata
}

/** An environment variable's value, when the host process has one. */
function readEnv(name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  const value = process.env[name]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** The request an `http.request` event carries, whichever shape it uses. */
function requestOf(event: unknown): Request | undefined {
  const value = optionsOf(event)
  return value.request instanceof Request ? value.request : undefined
}

/** The response an `http.response` event carries. */
function responseOf(event: unknown): Response | undefined {
  const value = optionsOf(event)
  return value.response instanceof Response ? value.response : undefined
}

async function activeAccess(context: OpenCodeContext, integrationID: string): Promise<string | undefined> {
  const connection = context.integration?.connection
  if (connection === undefined) return undefined
  try {
    const active = await connection.active(integrationID)
    return active === undefined ? undefined : credentialAccess(await connection.resolve(active))
  } catch {
    // A missing/expired integration should leave the provider visible and let
    // OpenCode report its normal credential error on the attempted request.
    return undefined
  }
}

async function registerIntegration(
  context: OpenCodeContext,
  definition: OpenCodeVendorDefinition,
  options: Record<string, unknown>,
): Promise<void> {
  if (context.integration === undefined || definition.authMethods === undefined) return
  const methods = definition.authMethods(options, openCodeClient())
  await context.integration.transform((editor) => {
    methods.forEach((method, index) => {
      if (method.type !== "oauth") return
      const methodID = `${definition.id}-${index}`
      editor.method.update({
        integrationID: definition.id,
        method: { id: methodID, type: "oauth", label: method.label },
        authorize: async (inputs) => {
          const started = await method.authorize(inputs)
          const mode = started.method === "code" ? "code" : "auto"
          const base = {
            url: started.url ?? "",
            instructions: started.instructions ?? "",
            mode,
          }
          if (mode === "code") {
            return {
              ...base,
              mode,
              callback: async (code: string) => oauthCredential(await started.callback(code), methodID),
            }
          }
          return {
            ...base,
            mode,
            callback: Promise.resolve(started.callback()).then((result) => oauthCredential(result, methodID)),
          }
        },
        ...(definition.refresh === undefined
          ? {}
          : {
              refresh: async (credential: OpenCodeCredentialOAuth) => ({
                ...credential,
                ...(credential.refresh.length === 0 ? {} : await definition.refresh?.(credential)),
              }),
            }),
      })
    })
    editor.method.update({
      integrationID: definition.id,
      method: { type: "env", names: [definition.env] },
    })
    editor.method.update({
      integrationID: definition.id,
      method: {
        type: "key",
        label: "Access token",
        form: [{ type: "string", key: "key", title: "Access token" }],
      },
    })
  })
}

/** Build a real OpenCode V2 `{ id, setup }` module. */
export function openCodePlugin(definition: OpenCodeVendorDefinition): {
  id: string
  setup(context: OpenCodeContext): Promise<void>
} {
  return {
    id: definition.id,
    async setup(context: OpenCodeContext): Promise<void> {
      const options = optionsOf(context.options)
      const access = stringOption(options, "accessToken", "session", "token") ?? process.env[definition.env]
      const info: Record<string, unknown> = {
        id: definition.id,
        integrationID: definition.id,
        name: definition.name,
        activation: "enabled",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: definition.baseURL },
        headers: {
          ...(definition.optionHeaders?.(options) ?? {}),
          ...(access === undefined ? {} : { Authorization: `Bearer ${access}`, token: access }),
        },
      }
      const models = definition.models.map((spec) => modelInfo(definition, spec))
      if (context.provider === undefined) {
        throw new Error("OpenCode V2 provider API is unavailable")
      }
      await context.provider.transform((editor) => editor.add({ info, models }))
      await registerIntegration(context, definition, options)
      if (definition.bridge !== undefined) {
        // A bridge vendor writes its own auth headers, so the generic bearer
        // hook is not installed for it: the two would fight over
        // `Authorization`, and the order they run in is the host's to choose.
        await installBridge(context, definition, options, access)
      } else if (access !== undefined && context.session !== undefined) {
        await context.session.hook(
          "http.request",
          (event) => addAuthHeaders(event, definition.baseURL, access),
          {
            providerID: definition.id,
          },
        )
      } else if (context.session !== undefined && context.integration?.connection !== undefined) {
        await context.session.hook(
          "http.request",
          async (event) => {
            const current = await activeAccess(context, definition.id)
            if (current !== undefined) addAuthHeaders(event, definition.baseURL, current)
          },
          { providerID: definition.id },
        )
      }
    },
  }
}

/**
 * Install a bridge vendor's request and response rewrites.
 *
 * Both hooks are optional in the host contract, so each is installed only
 * when the host offers `session.hook` and the definition supplies that half.
 * A host that has no response hook leaves the vendor with a response it
 * cannot read — that is reported rather than hidden, because the alternative
 * is a model that answers with another protocol's bytes and no explanation.
 */
async function installBridge(
  context: OpenCodeContext,
  definition: OpenCodeVendorDefinition,
  options: Record<string, unknown>,
  staticAccess: string | undefined,
): Promise<void> {
  const bridge = definition.bridge
  const session = context.session
  if (bridge === undefined || session === undefined) return

  const credentialNow = async (): Promise<OpenCodeCredential | undefined> => {
    if (staticAccess !== undefined) {
      return { access: staticAccess, metadata: credentialFromOptions(options, definition.credentialEnv) }
    }
    return await activeCredential(context, definition.id)
  }

  if (bridge.request !== undefined) {
    await session.hook(
      "http.request",
      async (event) => {
        const credential = await credentialNow()
        const request = requestOf(event)
        if (credential === undefined || request === undefined) return
        const next = await bridge.request?.(request, credential)
        if (next !== undefined) optionsOf(event).request = next
      },
      { providerID: definition.id },
    )
  }

  if (bridge.response !== undefined) {
    await session.hook(
      "http.response",
      async (event) => {
        const credential = await credentialNow()
        const response = responseOf(event)
        const request = requestOf(event)
        if (credential === undefined || response === undefined || request === undefined) return
        const next = await bridge.response?.(response, request, credential)
        if (next !== undefined) optionsOf(event).response = next
      },
      { providerID: definition.id },
    )
  }
}
