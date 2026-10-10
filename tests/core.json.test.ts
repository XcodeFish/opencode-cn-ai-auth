/**
 * 保护 core/json.ts 的防御读取契约：只接受请求的形状，空串与非字符串一律拒绝，
 * 字符串数字只在 numericStr / posInt 里被解析（"abc" 不会变成数字），
 * stringList 去空白、丢空项并按出现顺序去重。
 */

import { describe, expect, test } from "bun:test"
import {
  asArray,
  asObject,
  bool,
  isObject,
  num,
  numericStr,
  posInt,
  str,
  stringList,
  trimmedStr,
} from "../src/core/json.ts"

describe("isObject / asObject / asArray", () => {
  test("isObject 只认普通对象", () => {
    expect(isObject({})).toBe(true)
    expect(isObject({ a: 1 })).toBe(true)
    expect(isObject([])).toBe(false)
    expect(isObject(null)).toBe(false)
    expect(isObject("x")).toBe(false)
    expect(isObject(0)).toBe(false)
    expect(isObject(undefined)).toBe(false)
  })

  test("asObject 返回同一个对象，否则 undefined", () => {
    const value: Record<string, unknown> = { a: 1 }
    expect(asObject(value)).toBe(value)
    expect(asObject([1])).toBeUndefined()
    expect(asObject("{}")).toBeUndefined()
    expect(asObject(null)).toBeUndefined()
  })

  test("asArray 只认真数组", () => {
    const list: unknown[] = [1, "a"]
    expect(asArray(list)).toBe(list)
    expect(asArray({ 0: 1, length: 1 })).toBeUndefined()
    expect(asArray("[]")).toBeUndefined()
    expect(asArray(undefined)).toBeUndefined()
  })
})

describe("str / trimmedStr", () => {
  test("str 拒绝空串，但不改内容", () => {
    expect(str("a")).toBe("a")
    expect(str(" a ")).toBe(" a ")
    expect(str("")).toBeUndefined()
    expect(str(0)).toBeUndefined()
    expect(str(["a"])).toBeUndefined()
    expect(str(null)).toBeUndefined()
  })

  test("trimmedStr 先去掉两端空白", () => {
    expect(trimmedStr(" a ")).toBe("a")
    expect(trimmedStr("\n b \t")).toBe("b")
    expect(trimmedStr("   ")).toBeUndefined()
    expect(trimmedStr("")).toBeUndefined()
    expect(trimmedStr(1)).toBeUndefined()
  })
})

describe("num / numericStr / posInt", () => {
  test("num 只认有限数字", () => {
    expect(num(1.5)).toBe(1.5)
    expect(num(0)).toBe(0)
    expect(num(-3)).toBe(-3)
    expect(num(Number.NaN)).toBeUndefined()
    expect(num(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(num("1")).toBeUndefined()
    expect(num(null)).toBeUndefined()
  })

  test("numericStr 认数字与数字字符串，不认其它字符串", () => {
    expect(numericStr(12)).toBe(12)
    expect(numericStr("12")).toBe(12)
    expect(numericStr(" 12.5 ")).toBe(12.5)
    expect(numericStr("1e3")).toBe(1000)
    expect(numericStr("abc")).toBeUndefined()
    expect(numericStr("")).toBeUndefined()
    expect(numericStr("   ")).toBeUndefined()
    expect(numericStr("Infinity")).toBeUndefined()
    expect(numericStr(true)).toBeUndefined()
    expect(numericStr(null)).toBeUndefined()
  })

  test("posInt 要求正的安全整数", () => {
    expect(posInt(12)).toBe(12)
    expect(posInt("12")).toBe(12)
    expect(posInt(0)).toBeUndefined()
    expect(posInt(-1)).toBeUndefined()
    expect(posInt(1.5)).toBeUndefined()
    expect(posInt("1.5")).toBeUndefined()
    expect(posInt(2 ** 53)).toBeUndefined()
    expect(posInt("abc")).toBeUndefined()
  })
})

describe("bool / stringList", () => {
  test("bool 只认布尔", () => {
    expect(bool(true)).toBe(true)
    expect(bool(false)).toBe(false)
    expect(bool("true")).toBeUndefined()
    expect(bool(1)).toBeUndefined()
    expect(bool(undefined)).toBeUndefined()
  })

  test("stringList 去空白、丢空项、保序去重", () => {
    expect(stringList([" a ", "b", "a", "", "  ", 1, null, "b"])).toStrictEqual(["a", "b"])
    expect(stringList([])).toStrictEqual([])
    expect(stringList("a")).toStrictEqual([])
    expect(stringList(undefined)).toStrictEqual([])
    expect(stringList([{}, "x"])).toStrictEqual(["x"])
  })
})
