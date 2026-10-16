/**
 * 保护 opencode/trae.ts 与 adapter 的 bridge 接线：OpenCode 侧不注入请求头就完事，
 * 它要改写请求（URL/头/体）与响应（SOLO SSE → OpenAI）。
 *
 * 用假 ctx 驱动真实 setup，再拿安装上去的两个 hook 各跑一次，断言上游会收到
 * 什么、宿主会拿到什么。凭据走 options，网络走注入的假 fetcher（不碰全局 fetch：
 * 改全局会漏到同一进程里的其它测试文件）。
 */

import { describe, expect, test } from "bun:test"
import type { OpenCodeContext } from "../opencode/adapter.ts"
import traeEntry, { traeOpenCodeEntry } from "../opencode/trae.ts"
import { at, cannedFetch, jsonOk } from "./helpers.ts"

interface Hook {
  name: string
  callback: (event: unknown) => void | Promise<void>
}

/** 一个够用的假 ctx：记录注册结果与安装的 hook。 */
function fakeContext(options: Record<string, unknown>): {
  context: OpenCodeContext
  added: Array<{ info: Record<string, unknown>; models: readonly Record<string, unknown>[] }>
  hooks: Hook[]
  integrationUpdates: Array<{ integrationID: string; method: Record<string, unknown> }>
} {
  const added: Array<{ info: Record<string, unknown>; models: readonly Record<string, unknown>[] }> = []
  const hooks: Hook[] = []
  const integrationUpdates: Array<{ integrationID: string; method: Record<string, unknown> }> = []
  return {
    added,
    hooks,
    integrationUpdates,
    context: {
      options,
      provider: {
        transform: async (
          callback: (editor: {
            add(input: { info: Record<string, unknown>; models: readonly Record<string, unknown>[] }): void
          }) => void,
        ) => callback({ add: (input) => added.push(input) }),
      },
      session: {
        hook: async (
          name: "http.request" | "http.response",
          callback: (event: unknown) => void | Promise<void>,
        ) => {
          hooks.push({ name, callback })
        },
      },
      integration: {
        transform: async (
          callback: (editor: {
            method: { update(input: { integrationID: string; method: Record<string, unknown> }): void }
          }) => void,
        ) => callback({ method: { update: (input) => integrationUpdates.push(input) } }),
      },
    } as unknown as OpenCodeContext,
  }
}

/** 目录读取用的假响应；通道名与 api.test.ts 里那条 fixture 一致。 */
const CATALOG_ANSWER = {
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

const CREDENTIAL_OPTIONS = {
  accessToken: "access-token",
  uid: "uid-1",
  machineId: "a".repeat(32),
  deviceId: "b".repeat(32),
}

describe("OpenCode Trae 入口", () => {
  test("遵守 V2 的 id/setup 契约，且不导出 server", () => {
    expect(traeEntry.id).toBe("trae-cn")
    expect(typeof traeEntry.setup).toBe("function")
    expect("server" in traeEntry).toBe(false)
  })

  test("注册 provider 与模型，并安装请求/响应两个 hook", async () => {
    const fake = fakeContext(CREDENTIAL_OPTIONS)
    await traeEntry.setup(fake.context)
    expect(fake.added).toHaveLength(1)
    expect(at(fake.added, 0).info.id).toBe("trae-cn")
    expect(at(fake.added, 0).models.length).toBeGreaterThan(0)
    const names = fake.hooks.map((hook) => hook.name).sort()
    expect(names).toStrictEqual(["http.request", "http.response"])
  })

  test("只给 token 时，设备指纹从环境变量读（否则请求头会缺字段）", async () => {
    const previous = {
      token: process.env.TRAE_ACCESS_TOKEN,
      uid: process.env.TRAE_UID,
      machine: process.env.TRAE_MACHINE_ID,
      device: process.env.TRAE_DEVICE_ID,
    }
    process.env.TRAE_ACCESS_TOKEN = "env-token"
    process.env.TRAE_UID = "env-uid"
    process.env.TRAE_MACHINE_ID = "c".repeat(32)
    process.env.TRAE_DEVICE_ID = "d".repeat(32)
    try {
      const fake = fakeContext({})
      const entry = traeOpenCodeEntry({
        fetcher: cannedFetch([{ match: "/batch", respond: () => jsonOk({}) }]),
      })
      await entry.setup(fake.context)
      const hook = fake.hooks.find((candidate) => candidate.name === "http.request")
      if (hook === undefined) throw new Error("没有安装 http.request")
      const event = {
        request: new Request("https://trae-api-cn.mchost.guru/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "glm-5.2", messages: [] }),
        }),
      }
      await hook.callback(event)
      expect(event.request.headers.get("authorization")).toBe("Cloud-IDE-JWT env-token")
      expect(event.request.headers.get("x-uid")).toBe("env-uid")
      expect(event.request.headers.get("x-machine-id")).toBe("c".repeat(32))
      expect(event.request.headers.get("x-device-id")).toBe("d".repeat(32))
    } finally {
      const restore = (name: keyof typeof previous, value: string | undefined): void => {
        const envName = {
          token: "TRAE_ACCESS_TOKEN",
          uid: "TRAE_UID",
          machine: "TRAE_MACHINE_ID",
          device: "TRAE_DEVICE_ID",
        }[name]
        if (value === undefined) delete process.env[envName]
        else process.env[envName] = value
      }
      for (const [name, value] of Object.entries(previous)) {
        restore(name as keyof typeof previous, value)
      }
    }
  })

  test("请求 hook 把 OpenAI 请求改成 SOLO 请求（URL/头/体）", async () => {
    const fake = fakeContext(CREDENTIAL_OPTIONS)
    const fetcher = cannedFetch([{ match: "/batch_get_detail_param", respond: () => jsonOk(CATALOG_ANSWER) }])
    const entry = traeOpenCodeEntry({ fetcher })
    await entry.setup(fake.context)
    const hook = fake.hooks.find((candidate) => candidate.name === "http.request")
    if (hook === undefined) throw new Error("没有安装 http.request")
    const event = {
      request: new Request("https://trae-api-cn.mchost.guru/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer host-token" },
        body: JSON.stringify({ model: "glm-5.2", messages: [{ role: "user", content: "hi" }] }),
      }),
    }
    await hook.callback(event)
    const rewritten = event.request
    expect(rewritten.url).toBe("https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat")
    expect(rewritten.headers.get("authorization")).toBe("Cloud-IDE-JWT access-token")
    expect(rewritten.headers.get("x-machine-id")).toBe(CREDENTIAL_OPTIONS.machineId)
    expect(rewritten.headers.get("x-device-id")).toBe(CREDENTIAL_OPTIONS.deviceId)
    expect(rewritten.headers.get("x-uid")).toBe("uid-1")
    const body = JSON.parse(await rewritten.text()) as Record<string, unknown>
    // 关键：通道来自目录，不是默认值。
    expect(body.function).toBe("solo_agent_remote")
    expect(body.config_name).toBe("glm-5.2")
    expect(body.messages).toStrictEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])
    // 目录确实被读过一次。
    expect(fetcher.callsMatching("/batch_get_detail_param")).toHaveLength(1)
  })

  test("响应 hook 拿到的是改写后的 request 时，仍然知道模型与是否流式", async () => {
    const fake = fakeContext(CREDENTIAL_OPTIONS)
    const entry = traeOpenCodeEntry({
      fetcher: cannedFetch([{ match: "/batch", respond: () => jsonOk({}) }]),
    })
    await entry.setup(fake.context)
    const requestHook = fake.hooks.find((candidate) => candidate.name === "http.request")
    const responseHook = fake.hooks.find((candidate) => candidate.name === "http.response")
    if (requestHook === undefined || responseHook === undefined) throw new Error("hook 没装齐")
    const event = {
      request: new Request("https://trae-api-cn.mchost.guru/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "glm-5.2", stream: false, messages: [] }),
      }),
    }
    await requestHook.callback(event)
    // 宿主把改写后的请求交给响应 hook（这是更常见的一种），此时两条信息
    // 只能从那次改写里带过来：模型名与「宿主只要一条答案」。
    const rewritten = event.request
    const answer = {
      request: rewritten,
      response: new Response('event:output\ndata:{"response":"你好"}\n\nevent:done\ndata:{}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    }
    await responseHook.callback(answer)
    expect(answer.response.headers.get("content-type")).toContain("application/json")
    const payload = (await answer.response.json()) as {
      model: string
      object: string
      choices: Array<{ message: { content: string } }>
    }
    expect(payload.object).toBe("chat.completion")
    expect(payload.model).toBe("glm-5.2")
    expect(at(payload.choices, 0).message.content).toBe("你好")
  })

  test("响应 hook 把 SOLO 事件流换成 OpenAI chunk", async () => {
    const fake = fakeContext(CREDENTIAL_OPTIONS)
    const entry = traeOpenCodeEntry({
      fetcher: cannedFetch([{ match: "/batch", respond: () => jsonOk({}) }]),
    })
    await entry.setup(fake.context)
    const request = new Request("https://trae-api-cn.mchost.guru/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "glm-5.2", messages: [] }),
    })
    const requestHook = fake.hooks.find((candidate) => candidate.name === "http.request")
    const responseHook = fake.hooks.find((candidate) => candidate.name === "http.response")
    if (requestHook === undefined || responseHook === undefined) throw new Error("hook 没装齐")
    // 先过请求 hook，响应 hook 才能知道这次请求的模型与是否流式。
    await requestHook.callback({ request })
    const event = {
      request,
      response: new Response(
        'event:output\ndata:{"response":"你好"}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    }
    await responseHook.callback(event)
    expect(event.response.headers.get("content-type")).toContain("text/event-stream")
    const text = await event.response.text()
    expect(text).toContain('"content":"你好"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain("data: [DONE]")
  })
})
