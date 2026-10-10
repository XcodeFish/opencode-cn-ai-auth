/**
 * 保护 core/catalog.ts 的三条宿主规则：空目录等于"没话说"（交回宿主原有的
 * 列表，而不是把它清空）、读失败交回打上 fellBack 标记的内置表、登录态被拒
 * 必须原样抛出（`SignInExpiredError` 是宿主标记账号的信号，不能被吞成一次
 * 普通的读失败）。三家厂商以前各写一份这段逻辑，重复正是这段代码消失的原因。
 */

import { describe, expect, test } from "bun:test"
import { catalogModels } from "../src/core/catalog.ts"
import { SignInExpiredError } from "../src/core/errors.ts"
import type { VendorLogger } from "../src/core/log.ts"
import { markFallback } from "../src/core/models.ts"
import type { ModelRecord } from "../src/core/types.ts"

function collector(): { log: VendorLogger; warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    log: {
      async warn(message: string): Promise<void> {
        warnings.push(message)
      },
      async info(): Promise<void> {},
    },
  }
}

const FALLBACK: ModelRecord = markFallback({ "m-1": { id: "m-1", name: "内置" } })

describe("catalogModels", () => {
  test("读到目录就交回它，不打标记、不写日志", async () => {
    const { log, warnings } = collector()
    const account: ModelRecord = { "m-9": { id: "m-9", name: "账号自己的" } }
    const out = await catalogModels({ read: async () => account, fallback: () => FALLBACK, log })
    expect(out).toBe(account)
    expect(Reflect.get(out ?? {}, Symbol.for("magpie.fellBack"))).toBeUndefined()
    expect(warnings).toStrictEqual([])
  })

  test("空目录当作没话说：返回 undefined，宿主因此保留原有列表", async () => {
    const { log } = collector()
    expect(await catalogModels({ read: async () => ({}), fallback: () => FALLBACK, log })).toBeUndefined()
    expect(
      await catalogModels({ read: async () => undefined, fallback: () => FALLBACK, log }),
    ).toBeUndefined()
  })

  test("读失败交回内置表，记一条 warn", async () => {
    const { log, warnings } = collector()
    const out = await catalogModels({
      read: async () => {
        throw new Error("boom")
      },
      fallback: () => FALLBACK,
      log,
    })
    expect(out).toBe(FALLBACK)
    expect(Reflect.get(out ?? {}, Symbol.for("magpie.fellBack"))).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("模型列表读取失败")
    expect(warnings[0]).toContain("boom")
  })

  test("登录态被拒时原样抛出，不当作读失败回退", async () => {
    const { log, warnings } = collector()
    const refused = new SignInExpiredError("loomy", "登录态失效")
    const error = await catalogModels({
      read: async () => {
        throw refused
      },
      fallback: () => FALLBACK,
      log,
    }).catch((thrown: unknown) => thrown)
    expect(error).toBe(refused)
    expect(warnings).toStrictEqual([])
  })
})
