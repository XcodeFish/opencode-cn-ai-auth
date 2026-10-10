/**
 * 保护 core/gate.ts：拒绝形状必须落在宿主的 failQuota 判定上 —— 429、
 * 错误正文含"额度"这类计划用量措辞、且**不含**余额/充值（会落到 failCredit）、
 * 也不含限流措辞（会落到 failRate）。
 *
 * 判定规则抄自 magpie `internal/gateway/routing.go` 的 `failure()`（本地 clone
 * 62b1c99 / 二进制 0.1.1137 同代）。本文件里的 regexp 是上游那份的副本，只用来
 * 在离线测试里钉住文案；**真正的证据**是把本模块产出的正文喂进上游 `failure()`
 * 得到 `quota`（2026-10-09，用 `go test ./internal/gateway/` 的一次性探针跑过，
 * 中英文两种文案都是 `quota`）。改文案时先跑本文件，再用同一探针复核。
 */

import { describe, expect, test } from "bun:test"
import { gatedFetch, QUOTA_REFUSAL_STATUS, quotaRefusal } from "../src/core/gate.ts"
import { cannedFetch } from "./helpers.ts"

const rateWords = /rate.?limit|too many requests|per.?(second|sec|minute|min)\b|\b[rt]pm\b|频率|太频繁/i
const creditWords =
  /insufficient.?(balance|credit|fund)|balance|credit|billing|payment|arrear|overdue|suspended|余额|欠费|充值|账户.*(不足|停)/i
const brokeWords = /insufficient.?(balance|credit|fund)|余额不足|欠费|请充值/i
const usedUpWords =
  /quota|usage.?limit|out of budget|budget (exceeded|exhausted)|limit.?reached|hit your .*limit|limit.{0,24}resets|exceeded.*(plan|limit)|额度|用量|套餐|上限/i

/** 与上游 `failure()` 同序：先 credit，再 rate，最后 quota。 */
function classify(status: number, body: string): "credit" | "rate" | "quota" | "other" {
  if (status === 402) return "credit"
  if (creditWords.test(body) && (status !== 429 || brokeWords.test(body))) return "credit"
  if (body.includes("insufficient_quota")) return "credit"
  if (status === 429 && rateWords.test(body) && !usedUpWords.test(body)) return "rate"
  if (usedUpWords.test(body) || status === 429) return "quota"
  return "other"
}

describe("quotaRefusal 的形状", () => {
  test("是 429 + JSON 错误正文", async () => {
    const response = quotaRefusal("今日赠送额度已用完")
    expect(response.status).toBe(QUOTA_REFUSAL_STATUS)
    expect(response.status).toBe(429)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(JSON.parse(await response.text())).toStrictEqual({
      error: { message: "今日赠送额度已用完", type: "quota_exhausted" },
    })
  })

  test("被宿主的规则判成 quota（而不是 credit / rate）", () => {
    const message = "今日赠送额度已用完，且永久积分已被锁定（插件选项 lockPermanent）。请解锁或等重置"
    const body = JSON.stringify({ error: { message, type: "quota_exhausted" } })
    expect(classify(429, body)).toBe("quota")
    expect(usedUpWords.test(body)).toBe(true)
    expect(rateWords.test(body)).toBe(false)
    expect(brokeWords.test(body)).toBe(false)
  })

  test("额度文案里出现「余额/充值」会被误判成 credit —— 文案守则钉在这里", () => {
    const bad = JSON.stringify({ error: { message: "今日赠送额度用完，账户余额不足请充值" } })
    expect(classify(429, bad)).toBe("credit")
  })
})

describe("gatedFetch", () => {
  test("没有拒绝理由时原样透传，且不改 init", async () => {
    const inner = cannedFetch([{ match: "/v1/chat", respond: () => new Response("ok") }])
    const gated = gatedFetch(inner, () => undefined)
    const init = { method: "POST", body: '{"a":1}' }
    const response = await gated("https://loomyad.xunfei.cn/api/v1/chat/completions", init)
    expect(await response.text()).toBe("ok")
    expect(inner.calls).toHaveLength(1)
    expect(inner.calls[0]?.init).toBe(init)
  })

  test("有拒绝理由时不下发请求，直接给 429", async () => {
    const inner = cannedFetch([])
    const gated = gatedFetch(inner, () => "今天没有了")
    const response = await gated("https://loomyad.xunfei.cn/api/v1/chat/completions")
    expect(response.status).toBe(429)
    expect(inner.calls).toHaveLength(0)
  })

  test("每次请求都重新问一次（loader 结果会被宿主缓存）", async () => {
    const inner = cannedFetch([{ match: "/v1/chat", respond: () => new Response("ok") }])
    let answer: string | undefined = "先拒绝一次"
    const gated = gatedFetch(inner, () => answer)
    expect((await gated("https://x/v1/chat")).status).toBe(429)
    answer = undefined
    expect((await gated("https://x/v1/chat")).status).toBe(200)
    expect(inner.calls).toHaveLength(1)
  })
})
