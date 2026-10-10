/**
 * 保护 core/stored.ts 的两种登录态形状：OAuth（`access` + 顶层附加字段）与
 * API key（host 重建的 `{ type, key, metadata }`）。字段读取必须在两种形状下
 * 都拿到同一个值——曾经 Raccoon 只读顶层，key 形状的账号会丢掉组织码，
 * 请求因而打到个人账号（`X-Org-Code` 为空）。
 */

import { describe, expect, test } from "bun:test"
import { storedField, storedSession } from "../src/core/stored.ts"
import type { StoredAuth } from "../src/core/types.ts"

describe("storedSession", () => {
  test("access 优先，其次 key；都没有则 undefined", () => {
    expect(storedSession({ access: "a" })).toBe("a")
    expect(storedSession({ key: "k" })).toBe("k")
    expect(storedSession({ access: "a", key: "k" })).toBe("a")
    expect(storedSession({ access: "", key: "k" })).toBe("k")
    expect(storedSession({})).toBeUndefined()
    expect(storedSession(undefined)).toBeUndefined()
  })
})

describe("storedField", () => {
  test("OAuth 形状从顶层读", () => {
    expect(storedField({ type: "oauth", access: "a", officeIdentity: "org-9" }, "officeIdentity")).toBe(
      "org-9",
    )
  })

  test("API key 形状从 metadata 读", () => {
    const auth = { type: "api", key: "k", metadata: { officeIdentity: "org-9", phone: "13812345678" } }
    expect(storedField(auth, "officeIdentity")).toBe("org-9")
    expect(storedField(auth, "phone")).toBe("13812345678")
  })

  test("两种地方都有时顶层优先（它才是 host 刚写下的那份）", () => {
    const auth = { officeIdentity: "top", metadata: { officeIdentity: "meta" } }
    expect(storedField(auth, "officeIdentity")).toBe("top")
  })

  test("字段缺失、空串、metadata 不是对象时都给 undefined", () => {
    expect(storedField({}, "phone")).toBeUndefined()
    expect(storedField({ phone: "" }, "phone")).toBeUndefined()
    expect(storedField({ metadata: { phone: 138 } }, "phone")).toBeUndefined()
    // 宿主理论上只写对象，但读法不能因此崩掉：这里刻意喂一个坏形状，
    // 所以需要断言——`StoredAuth` 的类型正是"按字段可能缺失读"的契约。
    const malformed = { metadata: "not-an-object" } as unknown as StoredAuth
    expect(storedField(malformed, "phone")).toBeUndefined()
    expect(storedField(undefined, "phone")).toBeUndefined()
  })
})
