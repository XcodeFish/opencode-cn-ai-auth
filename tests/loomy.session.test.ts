/**
 * 保护 vendors/loomy/session.ts：access 与 key 都算 session、缺 session 抛
 * SignInExpiredError（signIn:"expired"）、账号名按 accountId → 掩码手机号 → userid、
 * rememberQuota 用 {...auth, dailyQuota} 整体重写 body 且值不变时不写。
 */

import { describe, expect, test } from "bun:test"
import { SignInExpiredError } from "../src/core/errors.ts"
import {
  accountLabel,
  rememberedQuota,
  rememberQuota,
  requireSession,
  sessionOf,
} from "../src/vendors/loomy/session.ts"
import { at, fakeClient, thrownInstance } from "./helpers.ts"

describe("sessionOf / requireSession", () => {
  test("access 优先，其次 key", () => {
    expect(sessionOf({ access: "a" })).toBe("a")
    expect(sessionOf({ key: "k" })).toBe("k")
    expect(sessionOf({ access: "a", key: "k" })).toBe("a")
    expect(sessionOf({ access: "", key: "k" })).toBe("k")
    expect(sessionOf({})).toBeUndefined()
    expect(sessionOf(undefined)).toBeUndefined()
  })

  test("缺 session 抛 SignInExpiredError", () => {
    const error = thrownInstance(SignInExpiredError, () => requireSession(undefined, "签到"))
    expect(error.signIn).toBe("expired")
    expect(error.vendor).toBe("loomy")
    expect(error.message).toBe("loomy: 账号里没有 session（签到），请重新登录")
    expect(requireSession({ key: "k" }, "签到")).toBe("k")
  })
})

describe("accountLabel", () => {
  test("accountId → 掩码手机号 → userid", () => {
    expect(accountLabel({ accountId: "acct-1", phone: "13812345678", userid: "u-1" })).toBe("acct-1")
    expect(accountLabel({ phone: "13812345678", userid: "u-1" })).toBe("138****5678")
    expect(accountLabel({ userid: "u-1" })).toBe("u-1")
    expect(accountLabel({ accountId: "" })).toBeUndefined()
    expect(accountLabel(undefined)).toBeUndefined()
  })
})

describe("rememberQuota", () => {
  test("quota 变化时整体重写 body，access / expires 仍在", async () => {
    const client = fakeClient()
    const auth = {
      access: "sess-1",
      refresh: "",
      expires: 1_700_000_000_000,
      dailyQuota: 5000,
      dailyCycleDate: "2026-10-09",
    }
    await rememberQuota(client, "loomy", auth, 6000, "2026-10-10")
    expect(client.writes).toStrictEqual([
      { path: { id: "loomy" }, body: { ...auth, dailyQuota: 6000, dailyCycleDate: "2026-10-10" } },
    ])
    expect(at(client.writes, 0).body.access).toBe("sess-1")
    expect(at(client.writes, 0).body.expires).toBe(1_700_000_000_000)
    expect(at(client.writes, 0).path.id).toBe("loomy")
  })

  test("值没变化不写", async () => {
    const client = fakeClient()
    await rememberQuota(
      client,
      "loomy",
      { access: "sess-1", dailyQuota: 5000, dailyCycleDate: "2026-10-09" },
      5000,
      "2026-10-09",
    )
    expect(client.writes).toHaveLength(0)
  })

  test("quota 缺失或 <= 0、账号缺失都不写", async () => {
    const client = fakeClient()
    await rememberQuota(client, "loomy", { access: "sess-1" }, undefined, "2026-10-09")
    await rememberQuota(client, "loomy", { access: "sess-1" }, 0, "2026-10-09")
    await rememberQuota(client, "loomy", { access: "sess-1" }, -1, "2026-10-09")
    await rememberQuota(client, "loomy", undefined, 5000, "2026-10-09")
    expect(client.writes).toHaveLength(0)
  })

  test("cycleDate 没给时保留账号里已有的", async () => {
    const client = fakeClient()
    await rememberQuota(
      client,
      "loomy",
      { access: "sess-1", dailyQuota: 5000, dailyCycleDate: "2026-10-09" },
      6000,
      undefined,
    )
    expect(at(client.writes, 0).body).toStrictEqual({
      access: "sess-1",
      dailyQuota: 6000,
      dailyCycleDate: "2026-10-09",
    })
  })

  test("写入失败不抛，仍是 best effort", async () => {
    const client = fakeClient({ failSet: true })
    await expect(
      rememberQuota(client, "loomy", { access: "sess-1" }, 5000, "2026-10-09"),
    ).resolves.toBeUndefined()
    expect(client.writes).toHaveLength(1)
  })
})

describe("rememberedQuota", () => {
  test("只认数字 quota 与非空 cycleDate", () => {
    expect(rememberedQuota({ dailyQuota: 5000, dailyCycleDate: "2026-10-09" })).toStrictEqual({
      dailyQuota: 5000,
      dailyCycleDate: "2026-10-09",
    })
    expect(rememberedQuota({ dailyQuota: "5000" })).toStrictEqual({})
    expect(rememberedQuota({ dailyCycleDate: "2026-10-09" })).toStrictEqual({
      dailyCycleDate: "2026-10-09",
    })
    expect(rememberedQuota(undefined)).toStrictEqual({})
  })
})
