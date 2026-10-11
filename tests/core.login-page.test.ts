/**
 * 保护 core/login-page.ts：页面含标题 / 正文 / 运行时脚本，
 * 除传入的 spec.scripts 外没有任何外链资源（src="http 只应来自它），
 * jsonOk 是 {ok:true,...}、jsonFail 带 status 与 {ok:false,message}。
 */

import { describe, expect, test } from "bun:test"
import { JSON_TYPE } from "../src/core/local-page.ts"
import {
  jsonFail,
  jsonOk,
  renderLoginPage,
  renderSandboxedScriptFrame,
  renderSandboxedScriptPage,
} from "../src/core/login-page.ts"

function externalCount(html: string): number {
  return html.split('src="http').length - 1
}

describe("renderLoginPage", () => {
  test("标题、提示、正文与运行时脚本都在页面上", () => {
    const html = renderLoginPage({
      title: "登录 Loomy",
      note: "用微信扫一扫；首次登录需要绑定手机号",
      accent: "#1f6feb",
      body: '<div class="cn-qr"><img id="cn-qr-img" alt="微信扫码登录"></div>',
      script: "cnStatus('cn-status', '已就绪');",
    })
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true)
    expect(html).toContain("<title>登录 Loomy</title>")
    expect(html).toContain("<h1>登录 Loomy</h1>")
    expect(html).toContain('<p class="cn-note">用微信扫一扫；首次登录需要绑定手机号</p>')
    expect(html).toContain('<div class="cn-qr"><img id="cn-qr-img" alt="微信扫码登录"></div>')
    expect(html).toContain(":root{--accent:#1f6feb;}")
    expect(html).toContain("function cnEscape(")
    expect(html).toContain("function cnPoll(")
    expect(html).toContain("window.cnPost = cnPost;")
    expect(html).toContain("cnStatus('cn-status', '已就绪');")
  })

  test("不传 scripts 时页面没有任何外链资源", () => {
    const bare = renderLoginPage({ title: "T", body: "", script: "" })
    expect(externalCount(bare)).toBe(0)
    expect(bare).not.toContain("<script src=")
    expect(bare).not.toContain('class="cn-note"')
  })

  test('src="http 只来自传入的 scripts', () => {
    const html = renderLoginPage({
      title: "T",
      body: "",
      script: "",
      scripts: ["https://cdn.example.com/captcha.js"],
    })
    expect(html).toContain('<script src="https://cdn.example.com/captcha.js"></script>')
    expect(externalCount(html)).toBe(1)
  })

  test("普通文本会转义，外链脚本只接受无凭据的 https", () => {
    const html = renderLoginPage({
      title: '<script>alert("x")</script>',
      note: "<b>note</b>",
      body: "",
      script: "",
      scripts: ["https://cdn.example.com/captcha.js?scene=1"],
    })
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;")
    expect(html).toContain("&lt;b&gt;note&lt;/b&gt;")
    expect(() =>
      renderLoginPage({ title: "T", body: "", script: "", scripts: ["http://evil.test/x.js"] }),
    ).toThrow("https")
    expect(() => renderLoginPage({ title: "T", body: "", script: "", accent: "red" })).toThrow("hex color")
  })

  test("第三方验证码脚本只出现在 opaque-origin sandbox iframe", () => {
    const html = renderSandboxedScriptFrame({
      id: "captcha-frame",
      title: "验证码",
      path: "captcha",
    })
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"')
    expect(html).toContain('src="captcha"')
    expect(externalCount(html)).toBe(0)
    const child = renderSandboxedScriptPage({
      source: "https://cdn.example.com/captcha.js",
      body: '<div id="captcha"></div>',
      bootstrap: 'window.parent.postMessage({ type: "ready" }, "*");',
    })
    expect(child.contentSecurityPolicy).toContain("sandbox allow-scripts")
    expect(child.body).toContain('<script src="https://cdn.example.com/captcha.js"></script>')
    expect(() =>
      renderSandboxedScriptPage({
        source: "https://user:pass@cdn.example.com/captcha.js",
        body: "",
        bootstrap: "",
      }),
    ).toThrow("public https")
  })
})

describe("jsonOk / jsonFail", () => {
  test("jsonOk 是 {ok:true,...}，不带 status", () => {
    const empty = jsonOk()
    expect(empty.status).toBeUndefined()
    expect(empty.contentType).toBe(JSON_TYPE)
    expect(JSON.parse(empty.body)).toStrictEqual({ ok: true })

    const withValue = jsonOk({ phase: "waiting", qr: "data:image/png;base64,AA" })
    expect(JSON.parse(withValue.body)).toStrictEqual({
      ok: true,
      phase: "waiting",
      qr: "data:image/png;base64,AA",
    })
  })

  test("jsonFail 带 status 与 {ok:false,message}", () => {
    const fail = jsonFail("请输入有效的 11 位手机号")
    expect(fail.status).toBe(400)
    expect(fail.contentType).toBe(JSON_TYPE)
    expect(JSON.parse(fail.body)).toStrictEqual({ ok: false, message: "请输入有效的 11 位手机号" })
    expect(jsonFail("服务不可用", 503).status).toBe(503)
  })
})
