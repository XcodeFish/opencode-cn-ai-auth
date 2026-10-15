/**
 * 保护 vendors/loomy/tasks.ts：新手任务那一行只在「还有没领的」时候出现、
 * 恒为 aside（不参与选号）、读数按账号缓存（usage 会被频繁调用）、
 * 读到未完成就自动领掉（claim=false 时只读）、领取被拒时如实记录并停止、
 * 以及读失败时只是一个 undefined 而不是抛错。全部离线。
 */

import { describe, expect, test } from "bun:test"
import {
  forgetTaskReading,
  forgetTaskReadings,
  LOOMY_TASKS_TTL_MS,
  taskStateFor,
  tasksWindow,
} from "../src/vendors/loomy/tasks.ts"
import { at, cannedFetch, jsonOk } from "./helpers.ts"

const ACCESS = "sess-1"
const AUTH = { userid: "u-1", access: ACCESS }

/** 八项全领完的样子，测试用来表示领取之后的读数。 */
const ALL_DONE = Object.fromEntries(
  [
    "first_message",
    "pick_skill",
    "generate_ppt",
    "set_schedule",
    "install_skill",
    "configure_remote",
    "create_soul",
    "share_soul",
  ].map((key) => [key, true]),
)

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
  // 只读那几条都显式传 claim=false：它们验的是「卡片怎么读」，不是「要不要领」。
  test("只读模式：读服务，TTL 内复用缓存且不再发请求", async () => {
    forgetTaskReadings()
    const fetcher = cannedFetch([{ match: "/onboarding/tasks", respond: tasksBody({ first_message: true }) }])
    const first = await taskStateFor(fetcher, AUTH, ACCESS, 1_000, false)
    expect(first?.stale).toBe(false)
    expect(first?.data.done).toBe(1)
    expect(fetcher.callsMatching("/onboarding/tasks")).toHaveLength(1)
    expect(fetcher.callsMatching("/onboarding/tasks/complete")).toHaveLength(0)

    const cached = await taskStateFor(fetcher, AUTH, ACCESS, 1_000 + LOOMY_TASKS_TTL_MS, false)
    expect(cached?.stale).toBe(true)
    expect(cached?.data.done).toBe(1)
    // usage 每次刷新都会走到这里，缓存命中必须真的省掉请求。
    expect(fetcher.callsMatching("/onboarding/tasks")).toHaveLength(1)
  })

  test("TTL 过期后重新读", async () => {
    forgetTaskReadings()
    const fetcher = cannedFetch([{ match: "/onboarding/tasks", respond: tasksBody({}) }])
    await taskStateFor(fetcher, AUTH, ACCESS, 1_000, false)
    await taskStateFor(fetcher, AUTH, ACCESS, 1_000 + LOOMY_TASKS_TTL_MS + 1, false)
    expect(fetcher.callsMatching("/onboarding/tasks")).toHaveLength(2)
  })

  test("两个账号各记各的", async () => {
    forgetTaskReadings()
    const fetcher = cannedFetch([
      { match: "/onboarding/tasks", respond: tasksBody({ first_message: true, pick_skill: true }) },
    ])
    await taskStateFor(fetcher, { userid: "u-1", access: "a" }, "a", 1_000, false)
    await taskStateFor(fetcher, { userid: "u-2", access: "b" }, "b", 1_000, false)
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
    await taskStateFor(fetcher, AUTH, ACCESS, 1_000, false)
    const call = at(fetcher.calls, 0)
    expect(call.url).toBe("https://loomyad.xunfei.cn/api/v1/onboarding/tasks")
    expect(call.init?.headers).toMatchObject({ token: ACCESS })
  })

  test("默认会领：读到未完成就自动领完，读数直接变 8/8", async () => {
    forgetTaskReadings()
    let claimed = false
    const fetcher = cannedFetch([
      {
        match: "/onboarding/tasks/complete",
        respond: () => {
          claimed = true
          return jsonOk({ code: "000000", data: { alreadyCompleted: false, balance: 500 } })
        },
      },
      { match: "/onboarding/tasks", respond: () => tasksBody(claimed ? ALL_DONE : {}) },
    ])
    const state = await taskStateFor(fetcher, AUTH, ACCESS, 1_000)
    expect(state?.data.done).toBe(8)
    expect(state?.data.earned).toBe(10_000)
    expect(state?.stale).toBe(false)
    // 八项各 POST 一次；任务表只读一次（领的时候用刚读到的那份，不重读）。
    expect(fetcher.callsMatching("/onboarding/tasks/complete")).toHaveLength(8)
    // callsMatching 是 includes 匹配，/complete 也算「含 /onboarding/tasks」，
    // 所以按结尾精确数一次任务表读取。
    const listReads = fetcher.urls().filter((url) => url.endsWith("/onboarding/tasks"))
    expect(listReads).toHaveLength(1)

    // 领完之后的刷新走缓存，不再有任何请求。
    await taskStateFor(fetcher, AUTH, ACCESS, 1_100)
    expect(fetcher.calls).toHaveLength(9)
    expect(fetcher.urls().filter((url) => url.endsWith("/onboarding/tasks"))).toHaveLength(1)
  })

  test("claim=false：只读，一个 complete 都不发", async () => {
    forgetTaskReadings()
    const fetcher = cannedFetch([{ match: "/onboarding/tasks", respond: tasksBody({}) }])
    const state = await taskStateFor(fetcher, AUTH, ACCESS, 1_000, false)
    expect(state?.data.done).toBe(0)
    expect(fetcher.callsMatching("/onboarding/tasks/complete")).toHaveLength(0)
  })

  test("领取被拒时停下，记下已领的部分，并在 TTL 后重试", async () => {
    forgetTaskReadings()
    const fetcher = cannedFetch([
      {
        match: "/onboarding/tasks/complete",
        respond: (_url, init) => {
          const key = JSON.parse(String(init?.body)).key as string
          return key === "generate_ppt"
            ? jsonOk({ code: "100002", desc: "缺少 token" })
            : jsonOk({ code: "000000", data: { alreadyCompleted: false, balance: 0 } })
        },
      },
      { match: "/onboarding/tasks", respond: tasksBody({}) },
    ])
    // 表里的顺序：first_message 500、pick_skill 1000、generate_ppt（被拒）。
    const first = await taskStateFor(fetcher, AUTH, ACCESS, 1_000)
    expect(first?.data.done).toBe(2)
    expect(first?.data.earned).toBe(1500)
    const afterFirst = fetcher.callsMatching("/onboarding/tasks/complete").length
    expect(afterFirst).toBe(3)

    // TTL 内不重试（卡片刷新很频繁，不能每次都打）。
    await taskStateFor(fetcher, AUTH, ACCESS, 1_100)
    expect(fetcher.callsMatching("/onboarding/tasks/complete")).toHaveLength(afterFirst)

    // TTL 过后再试一次。
    await taskStateFor(fetcher, AUTH, ACCESS, 1_000 + LOOMY_TASKS_TTL_MS + 1)
    expect(fetcher.callsMatching("/onboarding/tasks/complete").length).toBeGreaterThan(afterFirst)
  })

  test("领取后清缓存：卡片不会在 TTL 内继续显示领取前的 N/8", async () => {
    // 真实回归（用户报「已签到但新手任务还是 0/8」）：签到与卡片刷新只差几秒，
    // 卡片的读数在签到之前就已经进了缓存，不清掉就会在整个 TTL 里显示旧值。
    forgetTaskReadings()
    let claimed = false
    const fetcher = cannedFetch([
      {
        match: "/onboarding/tasks",
        respond: () => tasksBody(claimed ? { first_message: true, share_soul: true } : {}),
      },
    ])
    const before = await taskStateFor(fetcher, AUTH, ACCESS, 1_000, false)
    expect(before?.data.done).toBe(0)
    expect(before?.stale).toBe(false)

    // 插件在 claimOnboardingTasks 之后做的事。
    claimed = true
    forgetTaskReading(AUTH)

    const after = await taskStateFor(fetcher, AUTH, ACCESS, 1_100, false)
    expect(after?.data.done).toBe(2)
    expect(after?.stale).toBe(false)
    expect(fetcher.callsMatching("/onboarding/tasks")).toHaveLength(2)
  })

  test("清缓存只影响那个账号", async () => {
    forgetTaskReadings()
    const fetcher = cannedFetch([{ match: "/onboarding/tasks", respond: tasksBody({ first_message: true }) }])
    await taskStateFor(fetcher, { userid: "u-1", access: "a" }, "a", 1_000, false)
    await taskStateFor(fetcher, { userid: "u-2", access: "b" }, "b", 1_000, false)
    expect(fetcher.callsMatching("/onboarding/tasks")).toHaveLength(2)

    forgetTaskReading({ userid: "u-1", access: "a" })
    await taskStateFor(fetcher, { userid: "u-1", access: "a" }, "a", 1_100, false)
    await taskStateFor(fetcher, { userid: "u-2", access: "b" }, "b", 1_100, false)
    // u-1 重读，u-2 仍命中缓存。
    expect(fetcher.callsMatching("/onboarding/tasks")).toHaveLength(3)
  })
})
