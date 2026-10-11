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

interface OpenCodeContext {
  options?: unknown
  provider?: {
    transform(callback: (editor: OpenCodeProviderEditor) => void): Promise<unknown>
  }
  session?: {
    hook(
      name: "http.request",
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
  // V2 credentials are keyed by the registered method. Magpie's accountId is
  // retained as metadata because the V2 schema does not have a top-level
  // accountId field.
  const metadata = typeof result.accountId === "string" ? { accountId: result.accountId } : undefined
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
      if (access !== undefined && context.session !== undefined) {
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
