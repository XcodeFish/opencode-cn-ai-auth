/**
 * 保护 vendors/trae/wire.ts：Trae 的 SOLO 通道两侧都不是 OpenAI，这两个改写是把请求
 * 送出去、再把回答交回宿主的唯一地方。
 *
 * 每条断言对应一条被 JetHub 实测确认过的规则（出处见 docs/vendors.md §3），尤其是
 * 那几条写反了不会报错、只是悄悄坏掉的：tools 的 parameters 必须是字符串、assistant
 * 的 tool_calls 字段名必须改成 function_call、非流式请求必须由这里聚合。
 */

import { describe, expect, test } from "bun:test"
import { bridgeResponse, toSoloBody } from "../src/vendors/trae/wire.ts"
import { at } from "./helpers.ts"

const soloOf = (body: Record<string, unknown>, model = "glm-5.2", channel = "solo_work_lite") =>
  toSoloBody(body, { model, channel })

describe("toSoloBody", () => {
  test("注入通道与双写 model/config_name，并强制流式", () => {
    const solo = soloOf({ model: "glm-5.2", messages: [] }, "glm-5.2", "solo_agent")
    expect(solo.function).toBe("solo_agent")
    expect(solo.model).toBe("glm-5.2")
    expect(solo.config_name).toBe("glm-5.2")
    expect(solo.stream).toBe(true)
  })

  test("内部模型的 __dev 后缀被去掉", () => {
    const solo = soloOf({ model: "glm-5.2__dev" }, "glm-5.2__dev")
    expect(solo.model).toBe("glm-5.2")
    expect(solo.config_name).toBe("glm-5.2")
  })

  test("文本 content 变成 [{type:'text'}]，数组形态透传", () => {
    const solo = soloOf({
      model: "glm-5.2",
      messages: [
        { role: "user", content: "你好" },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }],
        },
      ],
    })
    const messages = solo.messages as Array<Record<string, unknown>>
    expect(messages[0]?.content).toStrictEqual([{ type: "text", text: "你好" }])
    expect(messages[1]?.content).toStrictEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
    ])
  })

  test("assistant 的 tool_calls 改成 function_call，且剔除无名称的条目", () => {
    const solo = soloOf({
      model: "glm-5.2",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
            { id: "call_2", type: "function", function: { name: "", arguments: "{}" } },
          ],
        },
      ],
    })
    const message = at(solo.messages as Array<Record<string, unknown>>, 0)
    const calls = message.tool_calls as unknown[]
    expect(calls).toHaveLength(1)
    const call = at(calls, 0) as Record<string, unknown>
    expect(call.function_call).toStrictEqual({ name: "read", arguments: "{}" })
    expect("function" in call).toBe(false)
  })

  test("tools.parameters 序列化为 JSON 字符串（上游要求 string）", () => {
    const solo = soloOf({
      model: "glm-5.2",
      messages: [],
      tools: [
        {
          type: "function",
          function: { name: "read", description: "读取", parameters: { type: "object", properties: {} } },
        },
      ],
    })
    const fn = (at(solo.tools as unknown[], 0) as { function: { parameters: unknown } }).function
    expect(typeof fn.parameters).toBe("string")
    expect(JSON.parse(fn.parameters as string)).toStrictEqual({ type: "object", properties: {} })
  })

  test("tool_choice:none 连 tools 一起删掉", () => {
    const solo = soloOf({
      model: "glm-5.2",
      messages: [],
      tools: [{ type: "function", function: { name: "read", parameters: {} } }],
      tool_choice: "none",
    })
    expect("tools" in solo).toBe(false)
    expect("tool_choice" in solo).toBe(false)
  })

  test("tool_choice 的三种形态归一化", () => {
    const choose = (choice: unknown): unknown =>
      soloOf({ model: "m", messages: [], tool_choice: choice }, "m", "c").tool_choice
    expect(choose({ type: "auto" })).toBe("auto")
    expect(choose({ type: "required" })).toBe("required")
    expect(choose({ type: "function", function: { name: "read" } })).toBe("read")
  })

  test("host 侧的 OpenAI 专有字段不进 SOLO 请求体", () => {
    const solo = soloOf({
      model: "glm-5.2",
      messages: [],
      stream_options: { include_usage: true },
      parallel_tool_calls: true,
      extra_body: { thinking: { type: "disabled" } },
    })
    expect("stream_options" in solo).toBe(false)
    expect("parallel_tool_calls" in solo).toBe(false)
    expect("extra_body" in solo).toBe(false)
  })

  test("输出上限收敛到安全线，非法值不编造", () => {
    const withTokens = (value: unknown): unknown =>
      soloOf({ model: "m", messages: [], max_tokens: value }, "m", "c").max_tokens
    expect(withTokens(131_072)).toBe(64_000)
    expect(withTokens(1000)).toBe(1000)
    expect(withTokens(undefined)).toBeUndefined()
  })

  test("推理档位原样透传，不做白名单", () => {
    const solo = soloOf({ model: "m", messages: [], reasoning_effort: "extra_high" }, "m", "c")
    expect(solo.reasoning_effort).toBe("extra_high")
  })
})

describe("bridgeResponse", () => {
  const sse = (parts: string[]): Response =>
    new Response(parts.join(""), { status: 200, headers: { "content-type": "text/event-stream" } })

  test("SOLO 事件转成 OpenAI chunk，并以 [DONE] 结束", async () => {
    const upstream = sse([
      'event:output\ndata:{"response":"你好"}\n\n',
      'event:output\ndata:{"reasoning_content":"想想"}\n\n',
      'event:done\ndata:{"finish_reason":"stop"}\n\n',
    ])
    const text = await (await bridgeResponse(upstream, { model: "glm-5.2", streamed: true })).text()
    const lines = text.split("\n\n").filter((line) => line.startsWith("data:"))
    const first = JSON.parse(at(lines, 0).slice("data:".length)) as {
      choices: Array<{ delta: Record<string, unknown> }>
    }
    expect(at(first.choices, 0).delta.content).toBe("你好")
    const second = JSON.parse(at(lines, 1).slice("data:".length)) as {
      choices: Array<{ delta: Record<string, unknown> }>
    }
    expect(at(second.choices, 0).delta.reasoning_content).toBe("想想")
    expect(text).toContain("data: [DONE]")
    expect(text).toContain('"finish_reason":"stop"')
  })

  test("上游没有 done 事件时补一个终止 chunk", async () => {
    const bridged = await bridgeResponse(sse(['event:output\ndata:{"response":"hi"}\n\n']), {
      model: "m",
      streamed: true,
    })
    const text = await bridged.text()
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain("data: [DONE]")
  })

  test("工具调用清掉 SOLO 专有字段（namespace / partial_arguments）", async () => {
    const upstream = sse([
      'event:output\ndata:{"tool_calls":[{"index":0,"id":"call_1","function_call":{"name":"read","arguments":"{}","namespace":"x","partial_arguments":true}}]}\n\n',
      'event:done\ndata:{"finish_reason":"tool_calls"}\n\n',
    ])
    const text = await (await bridgeResponse(upstream, { model: "m", streamed: true })).text()
    expect(text).toContain('"name":"read"')
    expect(text).not.toContain("namespace")
    expect(text).not.toContain("partial_arguments")
  })

  test("非流式请求聚合成一条 chat.completion", async () => {
    const upstream = sse([
      'event:output\ndata:{"response":"你"}\n\n',
      'event:output\ndata:{"response":"好"}\n\n',
      'event:token_usage\ndata:{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}\n\n',
      'event:done\ndata:{"finish_reason":"stop"}\n\n',
    ])
    const bridged = await bridgeResponse(upstream, { model: "glm-5.2", streamed: false })
    expect(bridged.headers.get("content-type")).toContain("application/json")
    const payload = (await bridged.json()) as {
      object: string
      choices: Array<{ message: Record<string, unknown> }>
      usage?: Record<string, unknown>
    }
    expect(payload.object).toBe("chat.completion")
    expect(at(payload.choices, 0).message.content).toBe("你好")
    expect(payload.usage).toStrictEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })
  })

  test("401 与 JSON 响应原样交给宿主（聊天链路的失效判定靠它）", async () => {
    const unauthorized = new Response("nope", { status: 401 })
    expect(await bridgeResponse(unauthorized, { model: "m", streamed: true })).toBe(unauthorized)
    const json = new Response(JSON.stringify({ error: { message: "boom" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
    expect(await bridgeResponse(json, { model: "m", streamed: true })).toBe(json)
  })

  test("流内 error 事件变成流上的 error 对象，并通知上层记日志", async () => {
    const seen: string[] = []
    const upstream = sse(['event:error\ndata:{"code":4008,"message":"额度不足"}\n\n'])
    const text = await (
      await bridgeResponse(upstream, {
        model: "m",
        streamed: true,
        onError: (message) => {
          seen.push(message)
        },
      })
    ).text()
    expect(text).toContain("额度不足")
    expect(at(seen, 0)).toContain("4008")
  })
})
