/**
 * The one page both vendors' sign-ins are served on.
 *
 * A sign-in that needs a browser (a QR code to scan, a captcha to solve)
 * gets a page on loopback from `PageServer`; this module is the page itself:
 * the shell, the styles, and the small runtime every page uses. Sharing them
 * keeps the two vendors' pages the same shape for the user, and keeps the
 * security rules in one place:
 *
 * - the page loads nothing from the network (no CDN fonts, no analytics);
 *   when a vendor's own sign-in requires a script, it is placed in an
 *   opaque-origin sandbox iframe with a separate CSP;
 * - every value a vendor puts in the page goes through `escape` or is a
 *   constant of this package: no token, secret or phone number is ever
 *   written into the HTML (the tests assert this for each page);
 * - the script talks only to the page's own origin, whose path prefix is
 *   random per sign-in (`PageServer`).
 */

import type { PageResponse } from "./local-page.ts"
import { HTML, JSON_TYPE } from "./local-page.ts"
import { escapeHtml } from "./util.ts"

export interface LoginPageSpec {
  /** The document title and the card's heading. */
  title: string
  /** A line under the heading; omit for none. */
  note?: string
  /** `#rrggbb` for the primary button; defaults to a neutral slate. */
  accent?: string
  /** The card's markup. */
  body: string
  /**
   * Runs after the runtime is in place. It may use the globals the runtime
   * defines: `cnStatus`, `cnPoll`, `cnPost`, `cnDone`, `cnEscape`.
   */
  script: string
  /** Extra `<script src>` tags, in order; only for a vendor's own script. */
  scripts?: string[]
}

export interface SandboxedScriptFrameSpec {
  /** The element id used to validate postMessage sources in the parent page. */
  id: string
  title: string
  /** Relative path to the isolated document under the random login prefix. */
  path: string
}

export interface SandboxedScriptPageSpec {
  /** A public HTTPS script loaded only inside the opaque-origin frame. */
  source: string
  /** Trusted package-owned markup and bootstrap code for the frame. */
  body: string
  bootstrap: string
}

// 这段脚本里没有任何反斜杠转义，所以是普通模板串；若日后需要写 `\d` 一类的
// 正则，改回 `String.raw` 并同步 biome.json 的例外。
const RUNTIME = `
function cnEscape(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function cnStatus(id, text, tone) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  if (tone) { el.setAttribute("data-tone", tone); } else { el.removeAttribute("data-tone"); }
}
function cnPost(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  }).then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data || {} }; }); })
    .then(function (r) {
      if (!r.ok || r.data.ok === false) { throw new Error(r.data.message || "请求失败"); }
      return r.data;
    });
}
function cnPoll(url, onState, intervalMs) {
  var stopped = false;
  function once() {
    if (stopped) return;
    fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (state) { if (!stopped) onState(state || {}); })
      .catch(function () { /* a poll that failed is asked again */ });
  }
  var timer = setInterval(once, intervalMs || 1200);
  once();
  return function () { stopped = true; clearInterval(timer); };
}
function cnDone(stopPolling, message) {
  if (typeof stopPolling === "function") stopPolling();
  cnStatus("cn-status", message || "已完成，可以关闭此页面", "ok");
  setTimeout(function () { window.close(); }, 1200);
}
`

const STYLES = `
:root { color-scheme: light; --accent: #3b5bdb; --ink: #1f2329; --soft: #8a9099; --line: #e3e6ea; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  padding: 24px; background: #f4f5f7; color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.cn-card { width: 344px; background: #fff; border: 1px solid var(--line); border-radius: 14px;
  padding: 22px 24px 24px; box-shadow: 0 6px 28px rgba(15, 23, 42, .08); text-align: center; }
.cn-brand { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--soft); }
h1 { font-size: 17px; margin: 6px 0 4px; font-weight: 600; }
.cn-note { font-size: 12px; color: var(--soft); margin: 0 0 16px; line-height: 1.5; }
.cn-qr { display: block; width: 208px; height: 208px; margin: 0 auto; padding: 6px;
  border: 1px solid var(--line); border-radius: 10px; background: #fff; }
.cn-qr img, .cn-qr svg { display: block; width: 100%; height: 100%; }
.cn-status { margin-top: 12px; min-height: 20px; font-size: 13px; line-height: 1.5; color: #4e5969; }
.cn-status[data-tone="ok"] { color: #0f9d58; font-weight: 600; }
.cn-status[data-tone="err"] { color: #d93026; }
.cn-hint { font-size: 12px; color: var(--soft); margin: 10px 0 0; }
label { display: block; text-align: left; font-size: 12px; color: var(--soft); margin: 12px 0 4px; }
input { width: 100%; padding: 9px 11px; font-size: 14px; border: 1px solid #d9dde3; border-radius: 8px; }
input:focus { outline: 2px solid rgba(59, 91, 219, .25); border-color: var(--accent); }
button { width: 100%; margin-top: 12px; padding: 10px; font-size: 14px; color: #fff;
  background: var(--accent); border: 0; border-radius: 8px; cursor: pointer; }
button:disabled { background: #c9cdd4; cursor: not-allowed; }
button.cn-quiet { background: #eef0f3; color: #4e5969; }
.cn-row { display: flex; gap: 8px; align-items: flex-end; }
.cn-row button { width: auto; white-space: nowrap; padding: 10px 12px; }
.cn-hidden { display: none; }
footer { margin-top: 16px; font-size: 11px; color: var(--soft); }
`

function scriptTag(source: string): string {
  const url = new URL(source)
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("login page scripts must be public https URLs without credentials")
  }
  return `<script src="${escapeHtml(url.href)}"></script>`
}

/**
 * Put a vendor browser SDK in an opaque-origin sandbox. It uses a separate
 * document because an inline srcdoc would inherit the parent CSP; the parent
 * validates messages against this exact frame window.
 */
export function renderSandboxedScriptFrame(spec: SandboxedScriptFrameSpec): string {
  if (!/^[a-z][a-z0-9-]*$/.test(spec.path)) throw new Error("sandboxed frame path must be a relative name")
  return `<iframe id="${escapeHtml(spec.id)}" title="${escapeHtml(spec.title)}" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" style="display:block;width:100%;height:380px;border:0" src="${spec.path}"></iframe>`
}

/** The child has its own CSP, including sandboxing even if opened directly. */
export function renderSandboxedScriptPage(spec: SandboxedScriptPageSpec): PageResponse {
  const url = new URL(spec.source)
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("sandboxed login scripts must be public https URLs without credentials")
  }
  const body = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<style>body{margin:0;font:13px sans-serif;color:#4e5969}button{width:100%;padding:9px;border:0;border-radius:8px;background:#eef0f3;color:#4e5969;cursor:pointer}</style>
</head>
<body>
${spec.body}
<script src="${escapeHtml(url.href)}"></script>
<script>
"use strict";
${spec.bootstrap}
</script>
</body>
</html>`
  return {
    contentType: HTML,
    contentSecurityPolicy:
      "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; script-src 'unsafe-inline' https:; connect-src https: wss:; img-src data: https:; style-src 'unsafe-inline' https:",
    body,
  }
}

function accentStyle(accent: string | undefined): string {
  if (accent === undefined) return ""
  // The accent is CSS, not HTML text. Keep the accepted surface deliberately
  // small so a future vendor cannot turn this field into a style injection.
  if (!/^#[0-9a-f]{3,8}$/i.test(accent)) throw new Error("login page accent must be a hex color")
  return `:root{--accent:${accent};}`
}

/**
 * The page as HTML. `body` and `script` are trusted package-owned fragments;
 * ordinary text and external script URLs are escaped and validated here.
 */
export function renderLoginPage(spec: LoginPageSpec): string {
  const accent = accentStyle(spec.accent)
  const note = spec.note === undefined ? "" : `<p class="cn-note">${escapeHtml(spec.note)}</p>`
  const scripts = (spec.scripts ?? []).map(scriptTag).join("\n")
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(spec.title)}</title>
<style>${STYLES}${accent}</style>
</head>
<body>
  <main class="cn-card">
    <div class="cn-brand">cn-ai</div>
    <h1>${escapeHtml(spec.title)}</h1>
    ${note}
    ${spec.body}
    <div class="cn-status" id="cn-status">正在准备…</div>
    <footer>此页面来自本机 127.0.0.1，登录完成后会自动关闭</footer>
  </main>
${scripts}
<script>
(function () {
  "use strict";
${RUNTIME}
  window.cnEscape = cnEscape;
  window.cnStatus = cnStatus;
  window.cnPost = cnPost;
  window.cnPoll = cnPoll;
  window.cnDone = cnDone;
${spec.script}
})();
</script>
</body>
</html>`
}

/** What a page's `fetch` reads: `{ ok: true, … }`. */
export function jsonOk(value: Record<string, unknown> = {}): PageResponse {
  return { contentType: JSON_TYPE, body: JSON.stringify({ ok: true, ...value }) }
}

/**
 * What a page's `fetch` throws on: `{ ok: false, message }`, with the HTTP
 * status the page reads as a failure too. The message is shown to the user,
 * so it must say what they can do, in Chinese, and carry no token.
 */
export function jsonFail(message: string, status = 400): PageResponse {
  return { status, contentType: JSON_TYPE, body: JSON.stringify({ ok: false, message }) }
}
