/**
 * 保护 core/local-page.ts 的回环页面契约：只服务随机前缀内的路径、
 * handler 收到去掉前缀的 path 与 query、json() 对空 / 坏 / 非对象 body 都给 {}、
 * 响应头固定、close() 幂等且关闭后不再接受连接。
 */

import { describe, expect, test } from "bun:test"
import type { PageRequest } from "../src/core/local-page.ts"
import { HTML, notFound, PageServer } from "../src/core/local-page.ts"
import { at } from "./helpers.ts"

interface Seen {
  method: string
  path: string
  query: Record<string, string>
}

function record(request: PageRequest): Seen {
  return { method: request.method, path: request.path, query: Object.fromEntries(request.query) }
}

describe("PageServer（raw 模式）", () => {
  /**
   * Trae 的控制台用 `^http://127.0.0.1:(\d+)/authorize$` 校验回调地址，
   * 带随机前缀会被判成非法并直接显示「登录失败 / 网络错误」。所以 raw 模式
   * 必须把 handler 挂在源站根路径上，且 URL 里不带前缀。
   */
  test("raw 模式：URL 无前缀，/authorize 直接送到 handler", async () => {
    const seen: Seen[] = []
    const server = await PageServer.start(
      (request) => {
        seen.push(record(request))
        return { contentType: HTML, body: "<h1>raw</h1>" }
      },
      { raw: true },
    )
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      const response = await fetch(new URL("authorize", server.url))
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("raw")
      expect(at(seen, 0).path).toBe("/authorize")
      expect(server.url).not.toContain(at(seen, 0).path.slice(1, 5))
    } finally {
      server.close()
    }
  })

  test("raw 模式：不在 /authorize 的路径仍由 handler 决定", async () => {
    const server = await PageServer.start(
      (request) => (request.path === "/authorize" ? { body: "ok" } : notFound()),
      { raw: true },
    )
    try {
      expect((await fetch(new URL("authorize", server.url))).status).toBe(200)
      expect((await fetch(new URL("other", server.url))).status).toBe(404)
    } finally {
      server.close()
    }
  })
})

describe("PageServer", () => {
  test("GET 前缀内的根路径，前缀外 404", async () => {
    const seen: Seen[] = []
    const server = await PageServer.start((request) => {
      seen.push(record(request))
      return { contentType: HTML, body: "<h1>hi</h1>" }
    })
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/)
      const response = await fetch(`${server.url}?a=1&b=two`)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe(HTML)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(response.headers.get("content-security-policy")).toContain("frame-src 'self'")
      expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'")
      expect(await response.text()).toBe("<h1>hi</h1>")
      expect(seen).toStrictEqual([{ method: "GET", path: "/", query: { a: "1", b: "two" } }])

      const origin = new URL(server.url).origin
      const outside = await fetch(`${origin}/`)
      expect(outside.status).toBe(404)
      expect(await outside.text()).toBe("Not found")
      const wrongPrefix = await fetch(`${origin}/other-token/`)
      expect(wrongPrefix.status).toBe(404)
      expect(seen).toHaveLength(1)
    } finally {
      server.close()
    }
  })

  test("POST 的 json() 解析对象，坏 JSON / 非对象 / 空 body 都给 {}", async () => {
    const payloads: unknown[] = []
    const server = await PageServer.start(async (request) => {
      payloads.push(await request.json())
      return { contentType: "application/json; charset=utf-8", body: "{}" }
    })
    try {
      const post = (body?: string): Promise<Response> =>
        fetch(server.url, {
          method: "POST",
          ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
        })
      expect((await post(JSON.stringify({ phone: "138" }))).status).toBe(200)
      await post("not json")
      await post("[1,2]")
      await post()
      expect(payloads).toStrictEqual([{ phone: "138" }, {}, {}, {}])
    } finally {
      server.close()
    }
  })

  test("close() 二次调用安全，关闭后请求被拒", async () => {
    const server = await PageServer.start(() => ({ body: "{}" }))
    const url = server.url
    server.close()
    server.close()
    const failure = await fetch(url).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
  })
})
