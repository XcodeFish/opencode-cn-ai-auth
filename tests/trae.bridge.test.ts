/**
 * 保护 vendors/trae/wire.ts 的 chatFetch：宿主发一次 OpenAI 请求，上游必须
 * 收到 SOLO 请求；上游回 SOLO SSE，宿主必须收到 OpenAI 流。
 *
 * 这里按真实链路驱动：deps 全部注入（含上游 fetcher），不碰全局 fetch——
 * 改全局 fetch 会漏到同一进程里的其它测试文件。
 */

import { describe, expect, test } from "bun:test"
import { parseCatalogAnswer } from "../src/vendors/trae/api.ts"
import { channelFor, fallbackCatalog, modelsFrom } from "../src/vendors/trae/models.ts"
import { bridgeResponse, chatFetch } from "../src/vendors/trae/wire.ts"
import { at, cannedFetch, jsonOk } from "./helpers.ts"

const CREDENTIAL = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  uid: "uid-1",
  machineId: "a".repeat(32),
  deviceId: "b".repeat(32),
}

const CATALOG = {
  function_configs: [
    {
      function: "solo_agent_remote",
      config_info_list: [
        {
          config_name: "glm-5.2",
          usage: "chat_completion",
          display_config: { display_name: "GLM-5.2" },
        },
      ],
    },
  ],
}

interface Upstream {
  url: string
  body: Record<string, unknown>
  headers: Record<string, string>
}

/** 驱动一次完整链路，返回上游实际收到的请求与宿主拿到的响应。 */
async function drive(options: {
  routes: Parameters<typeof cannedFetch>[0]
  model?: string
  stream?: boolean
  withCatalog?: boolean
  /** 模拟「目录还没读过」：chatFetch 需要自己补读一次。 */
  preseeded?: boolean
  headers?: Record<string, string>
}): Promise<{ upstream: Upstream; answer: Response; calls: string[] }> {
  const fetcher = cannedFetch(options.routes)
  const calls: string[] = []
  const tracked = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    return await fetcher(input, init)
  }) as typeof fetch

  // 目录状态按真实语义演进：只有读成功才记住通道，读失败就退回默认通道。
  let catalog =
    options.preseeded === false ? fallbackCatalog() : modelsFrom(parseCatalogAnswer(CATALOG) ?? [])
  const bridged = chatFetch({
    fetcher: tracked,
    credentialNow: async () => CREDENTIAL,
    channelFor: (model) => channelFor(catalog, model),
    catalogHas: (model) => catalog.channels.has(model),
    catalogLoaded: () => options.preseeded !== false,
    ensureCatalog: async () => {
      const response = await tracked("https://trae-api-cn.mchost.guru/api/ide/v1/batch_get_detail_param", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      if (!response.ok) return
      const parsed = parseCatalogAnswer(await response.json().catch(() => undefined))
      if (parsed !== undefined) catalog = modelsFrom(parsed)
    },
    logWarn: async () => undefined,
  })

  const answer = await bridged("https://trae-api-cn.mchost.guru/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer host-token" },
    body: JSON.stringify({
      model: options.model ?? "glm-5.2",
      stream: options.stream ?? true,
      messages: [{ role: "user", content: "hi" }],
      ...(options.headers === undefined ? {} : {}),
    }),
  })
  const chat = fetcher.callsMatching("/llm_utils_chat").at(-1)
  if (chat === undefined) throw new Error("上游没有收到聊天请求")
  return {
    upstream: {
      url: chat.url,
      body: JSON.parse(String(chat.init?.body)) as Record<string, unknown>,
      headers: Object.fromEntries(new Headers(chat.init?.headers).entries()),
    },
    answer,
    calls,
  }
}

const chatRoute = (sse: string) => ({
  match: "/llm_utils_chat",
  respond: () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
})

describe("chatFetch", () => {
  test("URL 改到 SOLO 端点，请求体带通道，宿主自带的 bearer 被换掉", async () => {
    const { upstream, answer } = await drive({
      routes: [
        chatRoute('event:output\ndata:{"response":"ok"}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n'),
      ],
    })
    expect(upstream.url).toBe("https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat")
    expect(upstream.body.function).toBe("solo_agent_remote")
    expect(upstream.body.model).toBe("glm-5.2")
    expect(upstream.body.config_name).toBe("glm-5.2")
    expect(upstream.body.stream).toBe(true)
    expect(upstream.body.messages).toStrictEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])
    // 宿主写的 Bearer 必须被换掉，而不是与 Cloud-IDE-JWT 并存。
    expect(upstream.headers.authorization).toBe("Cloud-IDE-JWT access-token")
    expect(upstream.headers["x-machine-id"]).toBe(CREDENTIAL.machineId)
    expect(upstream.headers["x-ide-token"]).toBe("access-token")
    expect(answer.headers.get("content-type")).toContain("text/event-stream")
    expect(await answer.text()).toContain("data: [DONE]")
  })

  test("目录还没读过时，先补读一次目录再取通道", async () => {
    const { upstream, calls } = await drive({
      preseeded: false,
      routes: [
        { match: "/batch_get_detail_param", respond: () => jsonOk(CATALOG) },
        chatRoute("event:done\ndata:{}\n\n"),
      ],
    })
    // 关键：先补读目录，再按真实通道发请求；顺序也能看出来。
    const catalogAt = calls.findIndex((url) => url.includes("/batch_get_detail_param"))
    const chatAt = calls.findIndex((url) => url.includes("/llm_utils_chat"))
    expect(catalogAt).toBeGreaterThanOrEqual(0)
    expect(catalogAt).toBeLessThan(chatAt)
    expect(upstream.body.function).toBe("solo_agent_remote")
  })

  test("非流式请求收到聚合后的 OpenAI completion", async () => {
    const { answer } = await drive({
      stream: false,
      routes: [
        chatRoute('event:output\ndata:{"response":"你好"}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n'),
      ],
    })
    expect(answer.headers.get("content-type")).toContain("application/json")
    const payload = (await answer.json()) as {
      object: string
      choices: Array<{ message: { content: string } }>
    }
    expect(payload.object).toBe("chat.completion")
    expect(at(payload.choices, 0).message.content).toBe("你好")
  })

  test("上游 401 原样交给宿主（聊天链路靠状态码判定失效）", async () => {
    const { answer } = await drive({
      routes: [{ match: "/llm_utils_chat", respond: () => new Response("unauthorized", { status: 401 }) }],
    })
    expect(answer.status).toBe(401)
  })

  test("没有登录态时给 401，而不是把请求发出去", async () => {
    const fetcher = cannedFetch([])
    const bridged = chatFetch({
      fetcher: fetcher as unknown as typeof fetch,
      credentialNow: async () => undefined,
      channelFor: () => "solo_work_lite",
      catalogHas: () => true,
      catalogLoaded: () => true,
      ensureCatalog: async () => undefined,
      logWarn: async () => undefined,
    })
    const answer = await bridged("https://trae-api-cn.mchost.guru/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.2", messages: [] }),
    })
    expect(answer.status).toBe(401)
    expect(fetcher.calls).toHaveLength(0)
  })

  test("宿主交过来的是一个 Request 时，方法跟着它走（默认 GET 会让改写后的请求非法）", async () => {
    const fetcher = cannedFetch([chatRoute("event:done\ndata:{}\n\n")])
    const bridged = chatFetch({
      fetcher: fetcher as unknown as typeof fetch,
      credentialNow: async () => CREDENTIAL,
      channelFor: () => "solo_work_lite",
      catalogHas: () => true,
      catalogLoaded: () => true,
      ensureCatalog: async () => undefined,
      logWarn: async () => undefined,
    })
    // fetch(request) 形态：init 为空，方法与头只能从 Request 上读。
    const answer = await bridged(
      new Request("https://trae-api-cn.mchost.guru/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer host-token" },
        body: JSON.stringify({ model: "glm-5.2", messages: [] }),
      }),
    )
    expect(answer.status).toBe(200)
    const chat = fetcher.callsMatching("/llm_utils_chat").at(-1)
    expect(chat?.init?.method).toBe("POST")
    expect(String(chat?.init?.body)).toContain('"config_name"')
  })

  test("流读取出错时以错误结束，不会把控制器再关一次而覆盖真实原因", async () => {
    const failure = new Error("socket closed mid-stream")
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event:output\ndata:{"response":"半"}\n\n'))
          controller.error(failure)
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
    const seen: string[] = []
    const bridged = await bridgeResponse(upstream, {
      model: "m",
      streamed: true,
      onError: (message) => seen.push(message),
    })
    // 读流以那个真实原因失败（而不是先 close 再 error 造成的 “Invalid state”），
    // 也不会把 start() 的 promise 变成未处理的拒绝。
    const readError = await bridged.text().then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(at(seen, 0)).toContain("socket closed mid-stream")
    expect(seen.join(" ")).not.toContain("Invalid state")
    if (readError !== undefined) expect(readError).not.toContain("Invalid state")
  })

  test("目录里没有这个模型时，不会每个请求都重读一次目录", async () => {
    const fetcher = cannedFetch([
      { match: "/batch_get_detail_param", respond: () => jsonOk(CATALOG) },
      chatRoute("event:done\ndata:{}\n\n"),
    ])
    let loaded = false
    const bridged = chatFetch({
      fetcher: fetcher as unknown as typeof fetch,
      credentialNow: async () => CREDENTIAL,
      channelFor: () => "solo_work_lite",
      // 这个模型永远不在目录里（例如已下架或回退表里的一行）。
      catalogHas: () => false,
      catalogLoaded: () => loaded,
      ensureCatalog: async () => {
        await fetcher("https://trae-api-cn.mchost.guru/api/ide/v1/batch_get_detail_param", { method: "POST" })
        loaded = true
      },
      logWarn: async () => undefined,
    })
    const ask = () =>
      bridged("https://trae-api-cn.mchost.guru/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "已下架的模型", messages: [] }),
      })
    await (await ask()).text()
    await (await ask()).text()
    // 两次请求，目录只读一次。
    expect(fetcher.callsMatching("/batch_get_detail_param")).toHaveLength(1)
    expect(fetcher.callsMatching("/llm_utils_chat")).toHaveLength(2)
  })

  test("目录读失败也不抛错，退回默认通道继续请求", async () => {
    const { upstream } = await drive({
      preseeded: false,
      routes: [
        { match: "/batch_get_detail_param", respond: () => jsonOk({}, 500) },
        chatRoute("event:done\ndata:{}\n\n"),
      ],
    })
    expect(upstream.body.function).toBe("solo_work_lite")
  })
})
