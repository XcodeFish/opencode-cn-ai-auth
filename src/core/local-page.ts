/**
 * A one-shot local login page on loopback.
 *
 * Both vendors' sign-ins need a page in the user's browser and requests from
 * that page back to the plugin. The server binds `127.0.0.1:0` only, serves
 * a single random path prefix so other local processes cannot address it,
 * and is meant to be closed by the flow that started it.
 */

import { createServer, type Server } from "node:http"
import { randomHex } from "./util.ts"

export interface PageRequest {
  method: string
  /** The path after the server's own prefix, always starting with `/`. */
  path: string
  query: URLSearchParams
  /** The request body parsed as a JSON object; `{}` when there is none. */
  json(): Promise<Record<string, unknown>>
}

export interface PageResponse {
  status?: number
  contentType?: string
  /** Package-owned policy override for an isolated vendor SDK document. */
  contentSecurityPolicy?: string
  body: string
}

export type PageHandler = (request: PageRequest) => Promise<PageResponse> | PageResponse

export const HTML = "text/html; charset=utf-8"
export const JSON_TYPE = "application/json; charset=utf-8"

/** The answer for a path the page does not serve. */
export function notFound(): PageResponse {
  return { status: 404, contentType: "text/plain; charset=utf-8", body: "Not found" }
}

const MAX_BODY_BYTES = 64 * 1024

export interface PageServerOptions {
  /**
   * Serve the handler at the origin root, with no random prefix.
   *
   * The default prefix is a security measure: it keeps other local processes
   * from addressing the page, and every vendor whose flow lets us choose the
   * whole callback URL can use it. A vendor that **validates the shape** of
   * the callback URL instead cannot: Trae's console accepts only
   * `http://127.0.0.1:<port>/authorize`, so a prefix makes it refuse the
   * sign-in before it even looks at the query (measured — see
   * `docs/vendors.md` §4). With `raw`, the caller is responsible for the
   * equivalent protection; `vendors/trae/login.ts` checks the trace id it
   * issued.
   */
  raw?: boolean
}

export class PageServer {
  private closed = false

  private constructor(
    private readonly server: Server,
    /** The page's URL; open this in a browser. Includes the random prefix unless `raw`. */
    readonly url: string,
  ) {}

  static async start(handler: PageHandler, options: PageServerOptions = {}): Promise<PageServer> {
    // `raw` keeps an empty prefix, so `handle` matches the origin root.
    const token = options.raw === true ? "" : randomHex(16)
    const server = createServer((request, response) => {
      void handle(handler, token, request, response)
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === "string") {
      server.close()
      throw new Error("the login page server did not get a loopback port")
    }
    const origin = `http://127.0.0.1:${address.port}`
    return new PageServer(server, token === "" ? `${origin}/` : `${origin}/${token}/`)
  }

  /** Stops listening and drops live connections; safe to call twice. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.server.closeAllConnections?.()
    this.server.close()
  }
}

async function handle(
  handler: PageHandler,
  token: string,
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    // An empty token is `raw` mode: the path is served as it arrives.
    const prefix = token === "" ? "" : `/${token}`
    if (prefix !== "" && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      write(response, 404, "text/plain; charset=utf-8", "Not found")
      return
    }
    const path = prefix === "" ? url.pathname || "/" : url.pathname.slice(prefix.length) || "/"
    const body = await readBody(request)
    let parsed: Record<string, unknown> | undefined
    const result = await handler({
      method: request.method ?? "GET",
      path,
      query: url.searchParams,
      json: async () => {
        if (parsed !== undefined) return parsed
        if (body.length === 0) {
          parsed = {}
          return parsed
        }
        try {
          const value: unknown = JSON.parse(body)
          parsed =
            typeof value === "object" && value !== null && !Array.isArray(value)
              ? (value as Record<string, unknown>)
              : {}
        } catch {
          parsed = {}
        }
        return parsed
      },
    })
    write(
      response,
      result.status ?? 200,
      result.contentType ?? JSON_TYPE,
      result.body,
      result.contentSecurityPolicy,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    write(response, 500, "text/plain; charset=utf-8", `internal error: ${message}`)
  }
}

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })
}

function write(
  response: import("node:http").ServerResponse,
  status: number,
  contentType: string,
  body: string,
  contentSecurityPolicy?: string,
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // The page owns only its loopback API. Third-party browser code, when a
    // vendor needs it, runs in a separate opaque-origin sandboxed iframe.
    "content-security-policy":
      contentSecurityPolicy ??
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; child-src 'self'",
  })
  response.end(body)
}
