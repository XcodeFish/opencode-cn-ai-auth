/**
 * 保护 core/util.ts：手机号掩码与 HTML 转义的固定形状、随机 id 的形状与随机性、
 * createSettlement 的一次性语义（首个 settle 生效、fail 后 settle 无效）、
 * sleep 的 abort 行为。
 */

import { describe, expect, test } from "bun:test"
import {
  createSettlement,
  escapeHtml,
  mainlandPhone,
  maskPhone,
  randomHex,
  randomId,
  sleep,
} from "../src/core/util.ts"
import { rejectionError } from "./helpers.ts"

describe("maskPhone / escapeHtml", () => {
  test("maskPhone 只遮中间，短号原样返回", () => {
    expect(maskPhone("13812345678")).toBe("138****5678")
    expect(maskPhone("1234567")).toBe("123****4567")
    expect(maskPhone("123456")).toBe("123456")
    expect(maskPhone("")).toBe("")
    expect(maskPhone("+8613812345678")).toBe("+86****5678")
  })

  test("escapeHtml 覆盖五个字符", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;")
    expect(escapeHtml("plain 文本 1")).toBe("plain 文本 1")
    expect(escapeHtml("a&b")).toBe("a&amp;b")
  })
})

describe("mainlandPhone", () => {
  test("接受裸号、带分隔符的号与 +86 前缀，统一成裸号", () => {
    expect(mainlandPhone("13812345678")).toBe("13812345678")
    expect(mainlandPhone("138 1234 5678")).toBe("13812345678")
    expect(mainlandPhone("138-1234-5678")).toBe("13812345678")
    expect(mainlandPhone("+8613812345678")).toBe("13812345678")
    expect(mainlandPhone("8613812345678")).toBe("13812345678")
  })

  test("非 11 位、非 1[3-9] 开头或空值一律拒绝", () => {
    expect(mainlandPhone("12812345678")).toBeUndefined()
    expect(mainlandPhone("1381234567")).toBeUndefined()
    expect(mainlandPhone("138123456789")).toBeUndefined()
    expect(mainlandPhone("")).toBeUndefined()
    expect(mainlandPhone(undefined)).toBeUndefined()
  })
})

describe("randomHex / randomId", () => {
  test("形状固定", () => {
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/)
    expect(randomHex(0)).toBe("")
    expect(randomId()).toMatch(/^[0-9a-f]{32}$/)
    expect(randomId()).not.toContain("-")
  })

  test("两次取值不同", () => {
    expect(randomHex(32)).not.toBe(randomHex(32))
    expect(randomId()).not.toBe(randomId())
  })
})

describe("createSettlement", () => {
  test("首个 settle 生效，后续 settle / fail 被忽略", async () => {
    const settlement = createSettlement<string>()
    expect(settlement.settled).toBe(false)
    settlement.settle("first")
    expect(settlement.settled).toBe(true)
    settlement.settle("second")
    settlement.fail(new Error("late"))
    await expect(settlement.promise).resolves.toBe("first")
  })

  test("首个 fail 生效，之后 settle 无效", async () => {
    const settlement = createSettlement<number>()
    settlement.fail(new Error("first"))
    settlement.settle(2)
    settlement.fail(new Error("second"))
    expect(settlement.settled).toBe(true)
    const reason = await settlement.promise.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(reason).toBeInstanceOf(Error)
    expect((reason as Error).message).toBe("first")
  })

  test("fail 非 Error 值会被包成 Error", async () => {
    const settlement = createSettlement<number>()
    settlement.fail("boom")
    const reason = await settlement.promise.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(reason).toBeInstanceOf(Error)
    expect((reason as Error).message).toBe("boom")
  })
})

describe("sleep", () => {
  test("到点后 resolve", async () => {
    await expect(sleep(0)).resolves.toBeUndefined()
  })

  test("已经 abort 的 signal 立即拒绝并带上原因", async () => {
    const controller = new AbortController()
    controller.abort(new Error("先取消"))
    await expect(sleep(1_000, controller.signal)).rejects.toThrow("先取消")
  })

  test("睡眠中 abort 会取消定时器，非 Error 原因变成 aborted", async () => {
    const controller = new AbortController()
    // 不走 expect(...).rejects：这个 Bun 版本里同步 abort 之后 matcher 会一直等原定时器。
    const pending = rejectionError(() => sleep(60_000, controller.signal))
    controller.abort("因为")
    expect((await pending).message).toBe("aborted")
  })
})
