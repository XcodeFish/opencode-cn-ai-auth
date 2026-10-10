/**
 * A small HTTP layer over the host's `fetch`: timeouts, guarded JSON reads
 * and a uniform transport error, so vendor modules can tell "the network
 * failed" from "the vendor answered".
 */

import { errorMessage } from "./errors.ts"

export type Fetcher = typeof fetch

export class HttpTransportError extends Error {
  readonly url: string

  constructor(url: string, cause: unknown) {
    super(`request to ${hostOf(url)} failed: ${errorMessage(cause)}`, { cause })
    this.name = "HttpTransportError"
    this.url = url
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 30_000

/** Sends one request; transport failures throw `HttpTransportError`. */
export async function httpRequest(
  fetcher: Fetcher,
  url: string,
  options: RequestOptions = {},
): Promise<Response> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  try {
    return await fetcher(url, {
      method: options.method ?? "GET",
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.body === undefined ? {} : { body: options.body }),
      signal,
    })
  } catch (error) {
    throw new HttpTransportError(url, error)
  }
}

export interface HttpResult<T> {
  status: number
  ok: boolean
  /** The parsed body, when it was JSON. */
  json: T | undefined
  /** The raw text, always read; `""` when the body could not be read. */
  text: string
}

export interface BytesResult {
  status: number
  ok: boolean
  contentType: string
  bytes: Uint8Array
}

/**
 * Sends one request and reads the body once, as JSON when it is JSON and as
 * text otherwise. HTTP status is not an error here: vendors disagree about
 * what a 200 means, so the caller decides.
 */
export async function httpJson<T = unknown>(
  fetcher: Fetcher,
  url: string,
  options: RequestOptions = {},
): Promise<HttpResult<T>> {
  const response = await httpRequest(fetcher, url, options)
  const text = await response.text().catch(() => "")
  let json: T | undefined
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as T
    } catch {
      json = undefined
    }
  }
  return { status: response.status, ok: response.ok, json, text }
}

/**
 * Sends one request and reads the body as bytes. Use this rather than
 * `httpJson` for anything that is not text: decoding a JPEG as UTF-8 replaces
 * undefined byte sequences and the picture is lost before it is re-encoded.
 */
export async function httpBytes(
  fetcher: Fetcher,
  url: string,
  options: RequestOptions = {},
): Promise<BytesResult> {
  const response = await httpRequest(fetcher, url, options)
  const bytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)))
  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type") ?? "",
    bytes,
  }
}
