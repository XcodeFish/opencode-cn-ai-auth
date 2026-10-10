/**
 * 离线测试的共享工具：按路由作答的假 fetch、固定 JSON / 字节响应、
 * 异常捕获、假 client 与下标窄化。
 * 所有测试只经过注入的 fetcher 或本地回环服务器，不发真实外网请求。
 */

import type { Hooks, PluginClient, StoredAuth } from "../src/core/types.ts"

/** `fetch` 的入参与 init，和被测代码里的 `Fetcher` 完全一致。 */
export type FetchInput = Parameters<typeof fetch>[0]
export type FetchInit = Parameters<typeof fetch>[1]
/**
 * `fetch` 的返回类型。`lib` 里没有 DOM 时 Bun 与 undici 的 `Response`
 * 声明不同源，构造出来的 Response 和 `fetch` 的声明对不上，统一用这个别名。
 */
export type FetchResponse = Awaited<ReturnType<typeof fetch>>

/** 一次假请求的记录。 */
export interface FetchCall {
  url: string
  init: FetchInit | undefined
}

export type RouteMatch = string | RegExp | ((url: string, init: FetchInit | undefined) => boolean)

export interface CannedRoute {
  /** URL 子串、正则或谓词；按数组顺序取第一条命中的路由。 */
  match: RouteMatch
  /** 固定响应（每次 clone 一份）或现算的响应。 */
  respond:
    | FetchResponse
    | ((url: string, init: FetchInit | undefined) => FetchResponse | Promise<FetchResponse>)
}

export interface CannedFetch {
  (input: FetchInput, init?: FetchInit): Promise<FetchResponse>
  preconnect(url: string | URL): void
  /** 每次请求，按发生顺序。未命中路由时抛错，免得测试偷偷联网。 */
  readonly calls: FetchCall[]
  urls(): string[]
  callsMatching(part: string): FetchCall[]
}

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

function matches(match: RouteMatch, url: string, init: FetchInit | undefined): boolean {
  if (typeof match === "string") return url.includes(match)
  if (match instanceof RegExp) return match.test(url)
  return match(url, init)
}

/** 按路由表作答的假 fetch；未命中即抛错。 */
export function cannedFetch(routes: readonly CannedRoute[]): CannedFetch {
  const calls: FetchCall[] = []
  const fake = async (input: FetchInput, init?: FetchInit): Promise<FetchResponse> => {
    const url = urlOf(input)
    calls.push({ url, init })
    const route = routes.find((candidate) => matches(candidate.match, url, init))
    if (route === undefined) throw new Error(`cannedFetch 没有匹配的路由：${url}`)
    if (typeof route.respond === "function") return await route.respond(url, init)
    return route.respond.clone() as FetchResponse
  }
  return Object.assign(fake, {
    preconnect(_url: string | URL): void {},
    calls,
    urls: (): string[] => calls.map((call) => call.url),
    callsMatching: (part: string): FetchCall[] => calls.filter((call) => call.url.includes(part)),
  })
}

function jsonResponse(body: unknown, status: number): FetchResponse {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  }) as FetchResponse
}

/** 成功的 JSON 响应（HTTP 状态也由调用方给）。 */
export function jsonOk(body: unknown, status = 200): FetchResponse {
  return jsonResponse(body, status)
}

/** 失败的 JSON 响应。 */
export function jsonFail(body: unknown, status = 400): FetchResponse {
  return jsonResponse(body, status)
}

/** 纯文本响应；微信的长轮询就是脚本片段。 */
export function textBody(text: string, status = 200): FetchResponse {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  }) as FetchResponse
}

/** 任意字节 + content-type 的响应。 */
export function bytesResponse(bytes: Uint8Array, contentType: string, status = 200): FetchResponse {
  return new Response(bytes, { status, headers: { "content-type": contentType } }) as FetchResponse
}

/** 魔数为 PNG 的假图片，默认够长以便过 `>= 200` 的检查。 */
export function pngBytes(length = 256): Uint8Array {
  const bytes = new Uint8Array(length)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes
}

/** 魔数为 JPEG 的假图片。 */
export function jpegBytes(length = 256): Uint8Array {
  const bytes = new Uint8Array(length)
  bytes.set([0xff, 0xd8, 0xff, 0xe0])
  return bytes
}

/** 等一个宏任务，给 fire-and-forget 的调用留一点时间。 */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 列表下标，`noUncheckedIndexedAccess` 下的窄化。 */
export function at<T>(list: readonly T[], index: number): T {
  const value = list[index]
  if (value === undefined) throw new Error(`列表缺少下标 ${index}`)
  return value
}

/** `hooks.provider` 是可选字段，测试里统一在这里窄化。 */
export function providerOf(hooks: Hooks): NonNullable<Hooks["provider"]> {
  const provider = hooks.provider
  if (provider === undefined) throw new Error("插件必须声明 provider 钩子")
  return provider
}

/**
 * 请求头，取成普通对象并**保留 src 写的键名大小写**（`new Headers`
 * 会把键名统一成小写，断言就看不出 `X-Org-Code` 这类原始拼写）。
 */
export function headersOf(call: FetchCall): Record<string, string> {
  const out: Record<string, string> = {}
  const headers = call.init?.headers
  if (headers === undefined) return out
  if (headers instanceof Headers) {
    headers.forEach((value, name) => {
      out[name] = value
    })
    return out
  }
  if (Array.isArray(headers)) {
    const pairs = headers as unknown as ReadonlyArray<readonly [unknown, unknown]>
    for (const pair of pairs) out[String(pair[0])] = String(pair[1])
    return out
  }
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    out[name] = String(value)
  }
  return out
}

/** 同步运行的异常；没有抛出时返回 undefined。 */
export function thrownBy(run: () => unknown): unknown {
  try {
    run()
    return undefined
  } catch (error) {
    return error
  }
}

/** 断言同步抛出 `ctor` 的实例并返回它。 */
export function thrownInstance<T>(ctor: new (...args: never[]) => T, run: () => unknown): T {
  const error = thrownBy(run)
  if (!(error instanceof ctor)) throw new Error(`期望抛出 ${ctor.name}，实际是 ${String(error)}`)
  return error
}

/** 运行异步调用并返回捕获到的错误（必须是 Error）。 */
export async function rejectionError<T>(run: () => Promise<T>): Promise<Error> {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof Error)) throw new Error(`期望 Promise 抛 Error，实际是 ${String(error)}`)
    return error
  }
  throw new Error("期望 Promise 抛错，但它成功了")
}

/** 一次 `client.auth.set` 的记录。 */
export interface AuthWrite {
  path: { id: string }
  body: StoredAuth
}

export interface FakeClient extends PluginClient {
  readonly writes: AuthWrite[]
  readonly logs: string[]
  reset(): void
}

/** 记录 `auth.set` 与 `app.log` 的假 client。 */
export function fakeClient(options: { failSet?: boolean } = {}): FakeClient {
  const writes: AuthWrite[] = []
  const logs: string[] = []
  return {
    writes,
    logs,
    reset(): void {
      writes.length = 0
      logs.length = 0
    },
    auth: {
      async set(input: { path: { id: string }; body: StoredAuth }): Promise<unknown> {
        writes.push({ path: input.path, body: input.body })
        if (options.failSet === true) throw new Error("auth store unavailable")
        return undefined
      },
    },
    app: {
      log(input: { service?: string; level?: string; message: string }): unknown {
        logs.push(input.message)
        return undefined
      },
    },
  }
}
