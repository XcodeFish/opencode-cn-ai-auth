/**
 * 保护 core/qr.ts：矩阵是方阵且边长 = 模块数、三个定位图案角上深浅正确、
 * renderQrSvg 输出内联 SVG（以 <svg 开头且带 viewBox）、
 * 超过 213 字节（纠错 M、版本 10 上限）直接抛错而不是产出扫不出来的码。
 */

import { describe, expect, test } from "bun:test"
import { buildQrMatrix, renderQrSvg } from "../src/core/qr.ts"
import { at } from "./helpers.ts"

const TEXT = "https://loomy.xunfei.cn/oauth/wechat/callback?state=abc123"

describe("buildQrMatrix", () => {
  test("短串得到方阵，边长与模块数一致", () => {
    const { size, modules } = buildQrMatrix(TEXT)
    expect(size).toBeGreaterThanOrEqual(21)
    expect((size - 17) % 4).toBe(0)
    expect(modules).toHaveLength(size)
    expect(modules.map((row) => row.length)).toStrictEqual(new Array<number>(size).fill(size))
  })

  test("三个定位图案的角上是深色、内圈第 2 圈是浅色", () => {
    const { size, modules } = buildQrMatrix("hello")
    const dark = (x: number, y: number): boolean => at(at(modules, y), x)
    expect([dark(0, 0), dark(size - 1, 0), dark(0, size - 1)]).toStrictEqual([true, true, true])
    expect([dark(1, 1), dark(size - 2, 1), dark(1, size - 2)]).toStrictEqual([false, false, false])
    expect([dark(2, 2), dark(size - 3, 2), dark(2, size - 3)]).toStrictEqual([true, true, true])
    // modules[row][col]：第 6 行是 timing pattern，从第 8 列起隔列取反
    expect([dark(8, 6), dark(9, 6)]).toStrictEqual([true, false])
  })

  test("只实现纠错 M，其它等级抛错", () => {
    expect(() => buildQrMatrix("hi", { errorCorrection: "L" })).toThrow(
      "only error correction M is implemented",
    )
  })

  test("超过 213 字节抛错，213 字节仍是版本 10", () => {
    expect(buildQrMatrix("a".repeat(213)).size).toBe(57)
    expect(() => buildQrMatrix("a".repeat(214))).toThrow(/too long \(214 bytes, 213 at most\)/)
    expect(() => buildQrMatrix("语".repeat(72))).toThrow(/too long \(216 bytes, 213 at most\)/)
  })
})

describe("renderQrSvg", () => {
  test("输出以 <svg 开头的内联 SVG，viewBox 与矩阵尺寸对齐", () => {
    const svg = renderQrSvg(TEXT)
    const { size } = buildQrMatrix(TEXT)
    expect(svg.startsWith("<svg")).toBe(true)
    expect(svg.endsWith("</svg>")).toBe(true)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain(`viewBox="0 0 ${size + 8} ${size + 8}"`)
    expect(svg).toContain('width="158"')
    expect(svg).toContain('<path d="M')
  })

  test("size / margin 选项生效", () => {
    const svg = renderQrSvg("hi", { size: 320, margin: 0 })
    const { size } = buildQrMatrix("hi")
    expect(svg).toContain('width="320"')
    expect(svg).toContain(`viewBox="0 0 ${size} ${size}"`)
  })
})
