/**
 * Loomy's two ways in.
 *
 * **WeChat, by QR code.** The code WeChat hands out is not delivered by a
 * redirect — the app's callback page 404s — so this plugin fetches the
 * authorization page, takes its uuid, downloads the QR as a `data:` URL, and
 * long-polls WeChat for the status (see `api.ts`). The QR and the status live
 * on a loopback page this module serves; a WeChat account that has never
 * bound a phone number is asked for one on that same page, which is the four
 * step dance the `bind*` functions implement.
 *
 * **SMS, on the local page.** xfyun's account service takes a phone number
 * and a code. The loopback page keeps this flow compatible with both hosts'
 * OAuth callback shape.
 *
 * WeChat uses the public AccessKey shipped in the vendor client. Users scan
 * to sign in; an account not yet bound to a phone completes that step on the
 * local page. Standalone SMS login remains optional and requires user config.
 */

import { MissingCredentialError, readCredential } from "../../core/credentials.ts"
import { errorMessage } from "../../core/errors.ts"
import type { Fetcher } from "../../core/http.ts"
import { notFound, type PageRequest, type PageResponse, PageServer } from "../../core/local-page.ts"
import { vendorLogger } from "../../core/log.ts"
import { jsonFail, jsonOk, renderLoginPage } from "../../core/login-page.ts"
import type { AuthMethod, PluginClient, SignInResult } from "../../core/types.ts"
import { createSettlement, mainlandPhone, maskPhone, randomId, sleep } from "../../core/util.ts"
import {
  bindCheckCode,
  bindSendMsg,
  bindSkip,
  bindWechat,
  claimDailyQuota,
  fetchWechatQr,
  type LoomyAccountKeys,
  loginWithSmsCode,
  pollWechat,
  sendSmsCode,
} from "./api.ts"
import { LOOMY_CLIENT_ACCESS_KEYS } from "./bundled-credentials.ts"
import {
  LOOMY_ACCESS_KEY_ID,
  LOOMY_ACCESS_KEY_SECRET,
  LOOMY_ID,
  LOOMY_SESSION_TTL_SECONDS,
  LOOMY_SIGN_IN_TIMEOUT_MS,
} from "./product.ts"

export interface LoomyLoginDeps {
  options: Record<string, unknown>
  client: PluginClient
  fetcher: Fetcher
  signInTimeoutMs?: number
}

/** The optional AccessKey pair for standalone SMS login. */
export function accountKeys(options: Record<string, unknown>): LoomyAccountKeys | undefined {
  const accessKeyId = readCredential(LOOMY_ACCESS_KEY_ID, options)
  const accessKeySecret = readCredential(LOOMY_ACCESS_KEY_SECRET, options)
  return accessKeyId === undefined || accessKeySecret === undefined
    ? undefined
    : { accessKeyId, accessKeySecret }
}

function requiredKeys(options: Record<string, unknown>): LoomyAccountKeys {
  const keys = accountKeys(options)
  if (keys !== undefined) return keys
  const missing =
    readCredential(LOOMY_ACCESS_KEY_ID, options) === undefined ? LOOMY_ACCESS_KEY_ID : LOOMY_ACCESS_KEY_SECRET
  throw new MissingCredentialError(missing)
}

/**
 * What a finished sign-in hands the host.
 *
 * `refresh: ""` is deliberate and is *not* a renewal: the host stores an
 * OAuth sign-in only when the result carries a `refresh` field, and Loomy has
 * no renewal endpoint at all. No `auth.refresh` hook is exported, so the
 * empty value is never used — it only marks the shape. `docs/vendors.md` says
 * the same about the session's expiry, which is this package's arithmetic
 * rather than a value the service states.
 */
export function signInResult(
  login: { access: string; userid: string; phone?: string },
  now = Date.now(),
): SignInResult {
  const label = login.phone === undefined ? login.userid : maskPhone(login.phone)
  return {
    type: "success",
    access: login.access,
    refresh: "",
    expires: now + LOOMY_SESSION_TTL_SECONDS * 1000,
    accountId: label,
    userid: login.userid,
    ...(login.phone === undefined ? {} : { phone: login.phone }),
  }
}

/**
 * Asks the service for the day's quota, as the vendor's own client does after
 * a sign-in — and it does so after **both** of them (the renderer bundle calls
 * `points/first-login` on the SMS path and on the WeChat path alike), so both
 * sign-in methods here call this. It is idempotent, and it is what makes the
 * day's `dailyQuota` known. The answer is not kept here: this runs before the
 * host has stored the sign-in, and remembering a quota means writing the whole
 * account back (see `session.ts`). The day's first `usage` read does it instead
 * — `points/records` carries the quota once a check-in has happened — and the
 * check-in hook keeps it from then on.
 *
 * Best effort: a sign-in that worked is not undone because this failed.
 */
async function initializeQuota(input: {
  client: PluginClient
  fetcher: Fetcher
  access: string
}): Promise<void> {
  const log = vendorLogger(input.client, LOOMY_ID)
  try {
    const grant = await claimDailyQuota(input.fetcher, input.access)
    if (grant.ok) return
    await log.warn(`登录后初始化每日额度失败：${grant.message}`)
  } catch (error) {
    await log.warn(`登录后初始化每日额度失败：${errorMessage(error)}`)
  }
}

// ---- the QR page -------------------------------------------------------------

type FlowPhase = "waiting" | "scanned" | "bind" | "done" | "cancelled" | "expired" | "failed"

interface FlowState {
  phase: FlowPhase
  message: string
  qr: string
}

/**
 * What the phone-binding steps have established so far. It is kept apart
 * from the page's own state because the page never reads it: the only thing
 * the browser learns is the answer to the request it just made.
 */
interface BindState {
  /** The code `bind/auth` handed out for this scan. */
  rcode: string
  /** The number the service accepted a send for. */
  phone: string
  /** True once a code went out for `phone`, and only for it. */
  smsSent: boolean
  /** The `msgid` of that send, which the check needs. */
  msgid?: string
}

const PHASE_TEXT: Record<FlowPhase, string> = {
  waiting: "等待扫码…",
  scanned: "已扫码，请在微信里确认",
  bind: "该微信还没有绑定手机号，请在下方填写",
  done: "登录成功，可以关闭此页面",
  cancelled: "已取消扫码",
  expired: "二维码已刷新，请重新扫码",
  failed: "登录失败",
}

function renderQrPage(state: FlowState): string {
  const script = `
  var stop = cnPoll("state", function (next) {
    var image = document.getElementById("cn-qr-img");
    if (next.qr && image && image.getAttribute("src") !== next.qr) image.src = next.qr;
    var bind = document.getElementById("cn-bind");
    if (bind) bind.className = next.phase === "bind" ? "" : "cn-hidden";
    if (next.phase === "done") { cnDone(stop, next.message); return; }
    if (next.phase === "failed" || next.phase === "cancelled") {
      stop();
      cnStatus("cn-status", next.message || "登录失败", "err");
      return;
    }
    cnStatus("cn-status", next.message || "");
  }, 1200);
  var send = document.getElementById("cn-send");
  if (send) send.addEventListener("click", function () {
    cnStatus("cn-status", "正在发送验证码…");
    cnPost("phone", { phone: document.getElementById("cn-phone").value.trim() })
      .then(function (data) { cnStatus("cn-status", data.message || "验证码已发送", "ok"); })
      .catch(function (e) { cnStatus("cn-status", e.message || "发送失败", "err"); });
  });
  var verify = document.getElementById("cn-verify");
  if (verify) verify.addEventListener("click", function () {
    cnStatus("cn-status", "正在验证…");
    cnPost("verify", { code: document.getElementById("cn-code").value.trim() })
      .then(function () { cnDone(stop, "登录成功，可以关闭此页面"); })
      .catch(function (e) { cnStatus("cn-status", e.message || "验证失败", "err"); });
  });
`
  return renderLoginPage({
    title: "登录 Loomy",
    note: "用微信扫一扫；首次登录需要绑定手机号",
    accent: "#1f6feb",
    body: `
      <div class="cn-qr"><img id="cn-qr-img" alt="微信扫码登录" src="${state.qr}"></div>
      <p class="cn-hint">二维码失效后会自动刷新</p>
      <div id="cn-bind" class="cn-hidden">
        <label for="cn-phone">手机号（微信未绑定，填一次即可）</label>
        <div class="cn-row">
          <input id="cn-phone" type="tel" inputmode="numeric" maxlength="11" placeholder="11 位手机号">
          <button class="cn-quiet" id="cn-send" type="button">获取验证码</button>
        </div>
        <label for="cn-code">短信验证码</label>
        <input id="cn-code" type="text" inputmode="numeric" maxlength="6" placeholder="6 位验证码">
        <button id="cn-verify" type="button">绑定并登录</button>
      </div>`,
    script,
  })
}

/**
 * Sends the binding code. `bind/auth` must have handed out an `rcode` first
 * (the scan that just succeeded did), and only a number the service accepted
 * is remembered: checking a code for a number that never got one can only
 * fail.
 */
async function bindPhoneRequest(
  deps: LoomyLoginDeps,
  bind: BindState,
  request: PageRequest,
): Promise<PageResponse> {
  const body = await request.json()
  const phone = mainlandPhone(typeof body.phone === "string" ? body.phone : undefined)
  if (phone === undefined) return jsonFail("请输入有效的 11 位手机号")
  if (bind.rcode.length === 0) return jsonFail("还没有扫码完成，请先扫码")
  try {
    bind.msgid = await bindSendMsg(deps.fetcher, LOOMY_CLIENT_ACCESS_KEYS, { rcode: bind.rcode, phone })
    bind.phone = phone
    bind.smsSent = true
    return jsonOk({ message: `验证码已发送到 ${maskPhone(phone)}` })
  } catch (error) {
    return jsonFail(errorMessage(error))
  }
}

/** Checks the code, and a success is the sign-in. */
async function bindVerifyRequest(
  deps: LoomyLoginDeps,
  bind: BindState,
  request: PageRequest,
  complete: (login: { access: string; userid: string; phone?: string }) => void,
): Promise<PageResponse> {
  const body = await request.json()
  const code = typeof body.code === "string" ? body.code.trim() : ""
  if (code.length === 0) return jsonFail("请输入短信验证码")
  if (!bind.smsSent || bind.msgid === undefined) return jsonFail("请先获取验证码")
  try {
    const login = await bindCheckCode(deps.fetcher, LOOMY_CLIENT_ACCESS_KEYS, {
      rcode: bind.rcode,
      code,
      msgid: bind.msgid,
    })
    complete(login)
    return jsonOk()
  } catch (error) {
    return jsonFail(errorMessage(error))
  }
}

interface StartedFlow {
  url: string
  instructions: string
  done: Promise<SignInResult>
}

/**
 * The mutable state the long poll works on, shared with the page. `uuid` and
 * `last` are the poll's own cursor — the page only ever sees `state`.
 */
interface WechatSession {
  deps: LoomyLoginDeps
  state: FlowState
  bind: BindState
  /** The uuid of the QR on screen; an expired one is replaced. */
  uuid: string
  /** The last status told to WeChat, which it long-polls incrementally by. */
  last: string
  settled(): boolean
  settle(login: { access: string; userid: string; phone?: string }): void
  fail(message: string): void
}

/**
 * A confirmed scan: an account that is already bound is finished here, one
 * that is not moves the page to its binding step and keeps polling (the
 * binding itself happens through the page's two POSTs).
 */
async function confirmedStep(session: WechatSession, code: string): Promise<"done" | "bind"> {
  const keys = LOOMY_CLIENT_ACCESS_KEYS
  const bound = await bindWechat(session.deps.fetcher, keys, code)
  session.bind.rcode = bound.rcode
  if (bound.bound) {
    session.settle(await bindSkip(session.deps.fetcher, keys, bound.rcode))
    return "done"
  }
  session.state.phase = "bind"
  session.state.message = PHASE_TEXT.bind
  return "bind"
}

/** An expired QR: draw the next one, say so, then wait again. */
async function reissueQr(session: WechatSession): Promise<void> {
  const next = await fetchWechatQr(session.deps.fetcher, randomId())
  session.uuid = next.uuid
  session.state.qr = next.image
  session.state.phase = "expired"
  session.state.message = PHASE_TEXT.expired
  await sleep(2_000)
  session.state.phase = "waiting"
  session.state.message = PHASE_TEXT.waiting
}

/**
 * The long poll behind the page, until the sign-in ends or its deadline
 * passes. Each step is one of WeChat's own statuses; the ones this package
 * does not act on are simply waited out.
 */
async function pumpWechat(session: WechatSession): Promise<void> {
  const deadline = Date.now() + (session.deps.signInTimeoutMs ?? LOOMY_SIGN_IN_TIMEOUT_MS)
  while (!session.settled() && Date.now() < deadline) {
    const poll = await pollWechat(session.deps.fetcher, {
      uuid: session.uuid,
      ...(session.last.length === 0 ? {} : { last: session.last }),
    })
    // WeChat's cursor is its numeric errcode, not this plugin's phase name.
    session.last = poll.errcode
    if (poll.status === "confirmed") {
      if ((await confirmedStep(session, poll.code)) === "done") return
      continue
    }
    if (poll.status === "cancelled") {
      session.fail("扫码已被取消，请重新发起登录")
      return
    }
    if (poll.status === "expired") {
      await reissueQr(session)
      continue
    }
    if (poll.status === "scanned") {
      session.state.phase = "scanned"
      session.state.message = PHASE_TEXT.scanned
      continue
    }
    if (poll.status === "error") await sleep(1_000)
  }
  if (!session.settled()) session.fail("登录超时，请重新发起登录")
}

/**
 * Runs one QR sign-in: the page, the long poll and the binding steps.
 *
 * The poll and the page share one `state` object — the page reads it from
 * `GET state`, the poll writes it. Nothing waits for the page: a user who
 * scans and confirms an account that is already bound finishes without ever
 * loading it.
 */
async function startWechat(deps: LoomyLoginDeps): Promise<StartedFlow> {
  const { fetcher } = deps
  const settlement = createSettlement<SignInResult>()
  const first = await fetchWechatQr(fetcher, randomId())
  const state: FlowState = {
    phase: "waiting",
    message: PHASE_TEXT.waiting,
    qr: first.image,
  }
  const bind: BindState = { rcode: "", phone: "", smsSent: false }
  let closed = false

  const close = (): void => {
    if (closed) return
    closed = true
    // Later than the page's own last poll, so "登录成功" stays readable.
    const timer = setTimeout(() => server.close(), 5_000)
    timer.unref?.()
  }

  const settle = (login: { access: string; userid: string; phone?: string }): void => {
    if (settlement.settled) return
    state.phase = "done"
    state.message = PHASE_TEXT.done
    void initializeQuota({ client: deps.client, fetcher, access: login.access })
    settlement.settle(signInResult(login))
    close()
  }

  const fail = (message: string): void => {
    if (settlement.settled) return
    state.phase = "failed"
    state.message = message
    settlement.settle({ type: "failed", error: message })
    close()
  }

  const session: WechatSession = {
    deps,
    state,
    bind,
    uuid: first.uuid,
    last: "",
    settled: () => settlement.settled,
    settle,
    fail,
  }

  const server = await PageServer.start(async (request: PageRequest) => {
    if (request.method === "GET" && request.path === "/") {
      return { contentType: "text/html; charset=utf-8", body: renderQrPage(state) }
    }
    if (request.method === "GET" && request.path === "/state") {
      return jsonOk({ phase: state.phase, message: state.message, qr: state.qr })
    }
    if (request.method === "POST" && request.path === "/phone") {
      return bindPhoneRequest(deps, bind, request)
    }
    if (request.method === "POST" && request.path === "/verify") {
      return bindVerifyRequest(deps, bind, request, settle)
    }
    return notFound()
  })

  void pumpWechat(session).catch((error: unknown) => fail(errorMessage(error)))

  return {
    url: server.url,
    instructions: "在浏览器里打开这个地址，用微信扫码登录",
    done: settlement.promise,
  }
}

interface SmsState {
  phone: string
  msgid?: string
  sent: boolean
}

function renderSmsPage(): string {
  return renderLoginPage({
    title: "登录 Loomy",
    note: "使用手机号接收验证码",
    accent: "#1f6feb",
    body: `
      <label for="cn-phone">手机号</label>
      <input id="cn-phone" type="tel" inputmode="numeric" maxlength="11" placeholder="11 位手机号">
      <button id="cn-send" type="button">获取验证码</button>
      <label for="cn-code">短信验证码</label>
      <input id="cn-code" type="text" inputmode="numeric" maxlength="6" placeholder="6 位验证码">
      <button id="cn-verify" type="button">登录</button>`,
    script: `
  var send = document.getElementById("cn-send");
  var verify = document.getElementById("cn-verify");
  send.addEventListener("click", function () {
    cnStatus("cn-status", "正在发送验证码…");
    cnPost("sms", { phone: document.getElementById("cn-phone").value.trim() })
      .then(function (data) { cnStatus("cn-status", data.message || "验证码已发送", "ok"); })
      .catch(function (e) { cnStatus("cn-status", e.message || "发送失败", "err"); });
  });
  verify.addEventListener("click", function () {
    cnStatus("cn-status", "正在登录…");
    cnPost("verify", { code: document.getElementById("cn-code").value.trim() })
      .then(function () { cnDone(null, "登录成功，可以关闭此页面"); })
      .catch(function (e) { cnStatus("cn-status", e.message || "登录失败", "err"); });
  });
`,
  })
}

async function startSmsSignIn(deps: LoomyLoginDeps): Promise<StartedFlow> {
  const settlement = createSettlement<SignInResult>()
  const state: SmsState = { phone: "", sent: false }
  let closed = false
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined

  const close = (immediate = false): void => {
    if (closed) return
    closed = true
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    if (immediate) {
      server.close()
      return
    }
    const timer = setTimeout(() => server.close(), 5_000)
    timer.unref?.()
  }

  const server = await PageServer.start((request: PageRequest) =>
    handleSmsPageRequest(deps, state, settlement, close, request),
  )

  timeoutTimer = setTimeout(() => {
    if (settlement.settled) return
    settlement.settle({ type: "failed", error: "登录超时，请重新发起登录" })
    close(true)
  }, deps.signInTimeoutMs ?? LOOMY_SIGN_IN_TIMEOUT_MS)
  timeoutTimer.unref?.()

  return {
    url: server.url,
    instructions: "在浏览器里打开这个地址，用手机号登录",
    done: settlement.promise,
  }
}

async function handleSmsPageRequest(
  deps: LoomyLoginDeps,
  state: SmsState,
  settlement: ReturnType<typeof createSettlement<SignInResult>>,
  close: () => void,
  request: PageRequest,
): Promise<PageResponse> {
  if (settlement.settled) return jsonFail("登录流程已结束，请重新发起登录")
  if (request.method === "GET" && request.path === "/") {
    return { contentType: "text/html; charset=utf-8", body: renderSmsPage() }
  }
  if (request.method === "POST" && request.path === "/sms") return handleSmsSend(deps, state, request)
  if (request.method === "POST" && request.path === "/verify") {
    return handleSmsVerify(deps, state, settlement, close, request)
  }
  return notFound()
}

async function handleSmsSend(
  deps: LoomyLoginDeps,
  state: SmsState,
  request: PageRequest,
): Promise<PageResponse> {
  const body = await request.json()
  const phone = mainlandPhone(typeof body.phone === "string" ? body.phone : undefined)
  if (phone === undefined) return jsonFail("请输入有效的 11 位手机号")
  try {
    state.msgid = await sendSmsCode(deps.fetcher, requiredKeys(deps.options), phone)
    state.phone = phone
    state.sent = true
    return jsonOk({ message: `验证码已发送到 ${maskPhone(phone)}` })
  } catch (error) {
    state.sent = false
    return jsonFail(errorMessage(error))
  }
}

async function handleSmsVerify(
  deps: LoomyLoginDeps,
  state: SmsState,
  settlement: ReturnType<typeof createSettlement<SignInResult>>,
  close: () => void,
  request: PageRequest,
): Promise<PageResponse> {
  const body = await request.json()
  const code = typeof body.code === "string" ? body.code.trim() : ""
  if (code.length === 0) return jsonFail("请输入短信验证码")
  if (!state.sent || state.msgid === undefined) return jsonFail("请先获取验证码")
  try {
    const login = await loginWithSmsCode(deps.fetcher, requiredKeys(deps.options), {
      phone: state.phone,
      code,
      msgid: state.msgid,
    })
    settlement.settle(signInResult(login))
    void initializeQuota({ client: deps.client, fetcher: deps.fetcher, access: login.access })
    close()
    return jsonOk()
  } catch (error) {
    return jsonFail(errorMessage(error))
  }
}

/** The two methods, as the host wants them. */
export function loginMethods(deps: LoomyLoginDeps): AuthMethod[] {
  const methods: AuthMethod[] = [
    {
      type: "oauth",
      label: "微信扫码登录",
      async authorize() {
        const flow = await startWechat(deps)
        return {
          url: flow.url,
          instructions: flow.instructions,
          method: "auto",
          callback: () => flow.done,
        }
      },
    },
  ]
  if (accountKeys(deps.options) === undefined) return methods
  methods.push({
    type: "oauth",
    label: "短信验证码登录",
    async authorize() {
      const flow = await startSmsSignIn(deps)
      return {
        url: flow.url,
        instructions: flow.instructions,
        method: "auto",
        callback: () => flow.done,
      }
    },
  })
  return methods
}
