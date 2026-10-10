/**
 * 保护 vendors/loomy/sign.ts 的签名契约：签名串是 9 段并以两个空段结尾、
 * Content-MD5 空 body 为空串、Authorization 用 account 方案、
 * 路径与 query 按 RFC3986 转义。
 * 期望值事先用 node:crypto 算好写死在这里，不调用被测实现生成期望。
 */

import { describe, expect, test } from "bun:test"
import { contentMd5, signHeaders, signingString } from "../src/vendors/loomy/sign.ts"

const AK = "ak-test"
const SK = "sk-test"
const DATE = "Mon, 01 Jan 2024 00:00:00 GMT"
const NONCE = "01234567-89ab-cdef-0123-456789abcdef"
const PATH = "/login/phone/checkCode"
const BODY = '{"base":{"appid":"GM3LOOMY"},"param":{"mcode":"123456"}}'
const BODY_MD5 = "xycgXDvZRH7dlr60//2aFg=="
const BODY_SIG = "KtEkqz+8J8gK6M56j9vrK+/P/u0="
const EMPTY_SIG = "BmG2MiDCSMxj7wbPM6uTW+gWQJk="

function header(headers: Record<string, string>, name: string): string {
  const value = headers[name]
  if (value === undefined) throw new Error(`缺少请求头 ${name}`)
  return value
}

describe("signingString", () => {
  test("9 段以 \\n 连接，末两段为空，方法转大写", () => {
    const string = signingString({
      accessKeyId: AK,
      accessKeySecret: SK,
      method: "post",
      path: PATH,
      body: BODY,
      date: DATE,
      nonce: NONCE,
    })
    expect(string.split("\n")).toStrictEqual([
      "POST",
      PATH,
      "",
      BODY_MD5,
      "application/json",
      DATE,
      NONCE,
      "",
      "",
    ])
    expect(string.split("\n")).toHaveLength(9)
    expect(string.endsWith("\n\n")).toBe(true)
  })

  test("路径与 query 按 RFC3986 转义", () => {
    const string = signingString({
      accessKeyId: AK,
      accessKeySecret: SK,
      method: "GET",
      path: "a b/c+d/",
      query: { "a b": "c&d", "*": "'", "!": "()" },
      body: "",
      date: DATE,
      nonce: NONCE,
    })
    const fields = string.split("\n")
    expect(fields[1]).toBe("/a%20b/c%2Bd")
    expect(fields[2]).toBe("a%20b=c%26d&%2A=%27&%21=%28%29")
  })

  test("没有 query 时该段为空", () => {
    const base = {
      accessKeyId: AK,
      accessKeySecret: SK,
      method: "GET",
      path: "/x",
      body: "",
      date: DATE,
      nonce: NONCE,
    }
    expect(signingString(base).split("\n")[2]).toBe("")
    expect(signingString({ ...base, query: {} }).split("\n")[2]).toBe("")
  })
})

describe("contentMd5", () => {
  test("空 body 是空串，非空 body 是 base64", () => {
    expect(contentMd5("")).toBe("")
    expect(contentMd5(BODY)).toBe(BODY_MD5)
    expect(contentMd5("{}")).toBe("mZFLkyvTelC5g8XnyQrpOw==")
  })
})

describe("signHeaders", () => {
  test("固定 date / nonce / body 下逐字段命中", () => {
    const headers = signHeaders({
      accessKeyId: AK,
      accessKeySecret: SK,
      method: "POST",
      path: PATH,
      body: BODY,
      date: DATE,
      nonce: NONCE,
    })
    expect(headers).toStrictEqual({
      Authorization: `account ${AK}:${BODY_SIG}`,
      Date: DATE,
      Nonce: NONCE,
      "Content-Type": "application/json",
      "Content-MD5": BODY_MD5,
    })
    expect(header(headers, "Authorization")).toBe("account ak-test:KtEkqz+8J8gK6M56j9vrK+/P/u0=")
  })

  test("空 body 不带 Content-MD5", () => {
    const headers = signHeaders({
      accessKeyId: AK,
      accessKeySecret: SK,
      method: "GET",
      path: "/x",
      date: DATE,
      nonce: NONCE,
    })
    expect("Content-MD5" in headers).toBe(false)
    expect(header(headers, "Authorization")).toBe(`account ${AK}:${EMPTY_SIG}`)
  })

  test("自定义 contentType 参与签名并进请求头", () => {
    const headers = signHeaders({
      accessKeyId: AK,
      accessKeySecret: SK,
      method: "GET",
      path: "/x",
      contentType: "text/plain",
      date: DATE,
      nonce: NONCE,
    })
    expect(header(headers, "Content-Type")).toBe("text/plain")
  })

  test("不传 date / nonce 时给出可用的默认值", () => {
    const headers = signHeaders({ accessKeyId: AK, accessKeySecret: SK, method: "GET", path: "/x" })
    expect(header(headers, "Date")).toMatch(
      /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
    )
    expect(Number.isNaN(Date.parse(header(headers, "Date")))).toBe(false)
    expect(header(headers, "Nonce")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
