/**
 * 保护载体页**真的能跑起来**：把渲染出的内联脚本放进最小 DOM 桩里执行一遍。
 *
 * ## 为什么需要这个文件（真实事故，2026-10-22）
 *
 * 0.9.7 把沙箱方案改回顶层触发时，旧代码里的 `setupCaptcha(...)` 调用被留在了
 * 页面脚本里，而那个函数已经随沙箱方案删除 ⇒ 浏览器执行到那一行抛
 * `ReferenceError: setupCaptcha is not defined` ⇒ **它之后的所有绑定（发送/登录
 * 按钮、两个滑块按钮）全部没挂上** ⇒ 用户看到「点击完成安全验证完全没反应」，
 * 页面底部还停在初始文案。
 *
 * 这个缺陷**逃过了当时所有门禁**：
 * - `tsc`/`biome` 只看 TS 源码，页面脚本是字符串；
 * - 纯函数测试不执行浏览器侧脚本；
 * - 我从渲染结果里抽取脚本做的「语法检查」（`new Function(code)`）也抓不到 ——
 *   `setupCaptcha(...)` 是**运行时** ReferenceError，语法完全合法。
 *
 * 所以这里做的是**执行**而不是解析：给一个只实现页面真正用到的 API 的桩
 * （`document`/`window`/`fetch`/定时器），把脚本跑一遍，然后断言每个按钮都挂上了
 * 监听器。任何未定义函数、未挂上的绑定、访问不存在的元素都会当场变红。
 * 未知 id 一律返回 undefined（元素表由渲染出的 HTML 的 id 属性生成），所以
 * 「页面脚本引用了 HTML 里不存在的 id」这类错也会被抓到。
 */

import { describe, expect, test } from "bun:test"
import { loginMethods } from "../src/vendors/astudio/login.ts"
import { at, bytesResponse, cannedFetch, fakeClient, jpegBytes, jsonOk } from "./helpers.ts"

interface StubElement {
  id: string
  textContent: string
  className: string
  value: string
  disabled: boolean
  src: string
  readonly listeners: Record<string, (() => void)[]>
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  addEventListener(name: string, handler: () => void): void
  appendChild(): void
  readonly attrs: Record<string, string>
}

interface PageRun {
  /** 脚本执行时抛出的错误；undefined = 顺利跑完。 */
  error: Error | undefined
  /** 按 id 索引的元素桩（只含渲染出的 HTML 里出现过的 id）。 */
  elements: Map<string, StubElement>
  status: () => string
}

function elementStub(id: string): StubElement {
  const listeners: Record<string, (() => void)[]> = {}
  const attrs: Record<string, string> = {}
  return {
    id,
    textContent: "",
    className: "",
    value: "",
    disabled: false,
    src: "",
    listeners,
    attrs,
    setAttribute(name, value) {
      attrs[name] = value
    },
    removeAttribute(name) {
      delete attrs[name]
    },
    getAttribute(name) {
      return attrs[name] ?? null
    },
    addEventListener(name, handler) {
      listeners[name] = [...(listeners[name] ?? []), handler]
    },
    appendChild() {},
  }
}

/** 把渲染出的页面里最后一个内联 `<script>` 跑在 DOM 桩里。 */
function runPageScript(html: string): PageRun {
  // 元素表：只认渲染出的 HTML 里真实存在的 id（脚本引用不存在的 id 会在桩里炸）。
  const elements = new Map<string, StubElement>()
  for (const match of html.matchAll(/id="([A-Za-z0-9_-]+)"/g)) {
    const id = match[1]
    if (id !== undefined && !elements.has(id)) elements.set(id, elementStub(id))
  }
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()
  const code = inline?.[1] ?? ""
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => elementStub("created"),
    addEventListener: () => undefined,
    head: { appendChild: () => undefined },
    body: { appendChild: () => undefined },
  }
  const window = {
    close: () => undefined,
    addEventListener: () => undefined,
    initGeetest: undefined as unknown,
  }
  // poll 与滑块配置一律「永不返回」：避免桩里跑出真实分支，只验证挂载。
  const fetch = () => new Promise<never>(() => undefined)
  let error: Error | undefined
  try {
    const run = new Function(
      "window",
      "document",
      "fetch",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "console",
      code,
    )
    run(
      window,
      document,
      fetch,
      () => 1,
      () => undefined,
      () => 1,
      () => undefined,
      console,
    )
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  }
  return {
    error,
    elements,
    status: () => elements.get("cn-status")?.textContent ?? "",
  }
}

const ROUTES = [
  { match: "scanlogin/qrcode", respond: jsonOk({ code: 0, data: "https://mp.weixin.qq.com/x?showqrcode" }) },
  { match: "mp.weixin.qq.com", respond: bytesResponse(jpegBytes(), "image/jpeg") },
  { match: "scanlogin/uids", respond: jsonOk({ code: -1 }) },
]

async function carrierPage(): Promise<string> {
  const methods = loginMethods({
    client: fakeClient(),
    options: {},
    pollIntervalMs: 1_000,
    fetcher: cannedFetch(ROUTES),
  })
  const method = at(methods, 0)
  if (method.type !== "oauth") throw new Error("载体页登录方式必须是 oauth")
  const started = await method.authorize()
  const url = started.url ?? ""
  return await (await fetch(url)).text()
}

describe("载体页脚本在 DOM 桩里能跑完", () => {
  test("执行无异常（未定义的函数引用会在这里炸）", async () => {
    const run = runPageScript(await carrierPage())
    expect(run.error?.message ?? "").toBe("")
  })

  test("四个按钮都挂上了 click 监听器（脚本中途抛错会让后面的绑定消失）", async () => {
    const run = runPageScript(await carrierPage())
    for (const id of [
      "cn-sms-captcha-btn",
      "cn-pwd-captcha-btn",
      "cn-sms-send",
      "cn-sms-login",
      "cn-pwd-login",
    ]) {
      const element = run.elements.get(id)
      expect(element, `缺少元素 ${id}`).toBeDefined()
      expect(element?.listeners.click?.length ?? 0, `${id} 没有 click 监听器`).toBe(1)
    }
  })

  test("三个 Tab 都能切换（各自的监听器在场）", async () => {
    const run = runPageScript(await carrierPage())
    for (const id of ["cn-tab-sms", "cn-tab-pwd", "cn-tab-qr"]) {
      expect(run.elements.get(id)?.listeners.click?.length ?? 0).toBe(1)
    }
  })

  test("初始状态是明确指引，而不是静态的「正在准备…」", async () => {
    const run = runPageScript(await carrierPage())
    expect(run.status()).toContain("请选择登录方式")
    expect(run.status()).not.toContain("正在准备…")
  })

  test("页面脚本不再引用已删除的 setupCaptcha（0.9.7 事故的回归钉）", async () => {
    const html = await carrierPage()
    // 允许注释里提到它（说明历史），但**不允许**出现调用。
    expect(html).not.toContain("setupCaptcha(")
  })
})
