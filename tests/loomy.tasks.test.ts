/**
 * 保护 vendors/loomy/tasks.ts：新手任务那一行只在「还有没领的」时候出现、
 * 恒为 aside（不参与选号）、读数按账号缓存（usage 会被频繁调用）、
 * 以及读失败时只是一个 undefined 而不是抛错。全部离线。
 */

import { describe, expect, test } from "bun:test"
import {
  forgetTaskReadings,
  LOOMY_TASKS_TTL_MS,
  taskStateFor,
  tasksWindow,
} from "../src/vendors/loomy/tasks.ts"
import { at, cannedFetch, jsonOk } from "./helpers.ts"

const ACCESS = "sess-1"
const AUTH = { userid: "u-1", access: ACCESS }

function tasksBody(tasks: Record<string, boolean>, total = 10_000): ReturnType<typeof jsonOk> {
  return jsonOk({ code: "000000", desc: "成功", data: { tasks, earned: 0, total } })
}

describe("tasksWindow", () => {
  test("还有没领的：aside 窗口说清进度与剩余分数", () => {
    const window = tasksWindow({
      tasks: { first_message: true, pick_skill: true, generate_ppt: false },
      done: 2,
      earned: 1500,
      total: 10_000,
    })
    expect(window).toStrictEqual({
      name: "新手任务",
      used: 0,
      aside: true,
      unit: "分",
      display: "新手任务 2/3 · 已领 1500 / 还有 8500 分可领",
    })
    // 不参与选号：没有上限的窗口不能排序账号。
    expect(window?.aside).toBe(true)
    // 也不能带 limit/amount，否则卡片会画成「买来的池子被花掉多少」。
    expect("limit" in (window ?? {})).toBe(false)
    expect("amount" in (window ?? {})).toBe(false)
  })

  test("全领完就不加这一行（8/8 是常态，常驻是噪音）", () => {
    expect(
      tasksWindow({
        tasks: { a: true, b: true },
        done: 2,
        earned: 10_000,
        total: 10_000,
      }),
    ).toBeUndefined()
  })

  test("没有读数就没有这一行", () => {
    expect(tasksWindow(undefined)).toBeUndefined()
    expect(tasksWindow({ tasks: {}, done: 0, earned: 0, total: 0 })).toBeUndefined()
  })
})

describe("taskStateFor", () => {
  test("首次读服务，TTL 内复用缓存且不再发请求", async () => {
    forgetTaskReadings()
    const fetcher = cannedFetch([{ match: "/onboarding/tasks", respond: tasksBody({ first_message: true }) }])
    const first = await taskStateFor(fetcher, AUTH, ACCESS, 1_000)
    expect(first?.stale).toBe(false)
    expect(first?.data.done).toBe(1)
    expect(fetcher.callsMatching("/onboarding/tasks")).toHaveLength(1)

    const cached = await taskStateFor(fetcher, AUTH, ACCESS, 1_000 + LOOMY_TASKS_TTL_MS)
    expect(cached?.stale).toBe(true)
    expect(cached?.data.done).toBe(1)
    // usage 每次刷新都会走到这里，缓存命中必须真的省掉请求。
    expect(fetcher.callsMatching("/onboarding/tasks")).toHaveLength(1)
  })

  test("TTL 过期后重新读", async () => {
    forgetTaskReadings()
    const fetcher = cannedFetch([{ match: "/onboarding/tasks", respond: tasksBody({}) }])
    await taskStateFor(fetcher, AUTH, ACCESS, 1_000)
    await taskStateFor(fetcher, AUTH, ACCESS, 1_000 + LOOMY_TASKS_TTL_MS + 1)
    expect(fetcher.callsMatching("/onboarding/tasks")).toHaveLength(2)
  })

  test("两个账号各记各的", async () => {
    forgetTaskReadings()
    const fetcher = cannedFetch([
      { match: "/onboarding/tasks", respond: tasksBody({ first_message: true, pick_skill: true }) },
    ])
    await taskStateFor(fetcher, { userid: "u-1", access: "a" }, "a", 1_000)
    await taskStateFor(fetcher, { userid: "u-2", access: "b" }, "b", 1_000)
    expect(fetcher.callsMatching("/onboarding/tasks")).toHaveLength(2)
  })

  test("读失败返回 undefined，不抛错（不为任务打断整张额度卡片）", async () => {
    forgetTaskReadings()
    const fetcher = cannedFetch([
      { match: "/onboarding/tasks", respond: jsonOk({ code: "100002", desc: "缺少 token" }) },
    ])
    expect(await taskStateFor(fetcher, AUTH, ACCESS, 1_000)).toBeUndefined()
  })

  test("读到的签名与 token 都对", async () => {
    forgetTaskReadings()
    const fetcher = cannedFetch([{ match: "/onboarding/tasks", respond: tasksBody({}) }])
    await taskStateFor(fetcher, AUTH, ACCESS, 1_000)
    const call = at(fetcher.calls, 0)
    expect(call.url).toBe("https://loomyad.xunfei.cn/api/v1/onboarding/tasks")
    expect(call.init?.headers).toMatchObject({ token: ACCESS })
  })
})
