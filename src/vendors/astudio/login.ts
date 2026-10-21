/**
 * AStudio 的登录：微信扫码（讯飞公共 SSO）。
 *
 * 这条链路**完全不依赖 AStudio 客户端、不需要任何厂商自有常量**：SSO 的三条
 * 路径（`scanlogin/qrcode` → `scanlogin/uids` → `scanlogin/bind`）是公开的
 * 讯飞账号服务，本包自备 8 位随机 `fd` 就能走完 —— 这是四家厂商里唯一零配置
 * 的登录方式。短信/密码登录（客户端的另外两条路）都要过极验（ GeeTest），
 * 本包第一版不接，见 `docs/vendors.md` 未验证边界。
 *
 * 流程（JetHub `astudio-oauth.ts` 实测链路）：
 *
 * 1. `generateFd()` 生成 `fd` → `GET scanlogin/qrcode?fd=` 拿微信 ticket URL；
 * 2. 登录页下载 ticket 图片内联展示，插件每 2s 轮询 `uids?fd=`：
 *    `-1` 未扫码；`0` + 账号列表 = 已确认（列表空 = 该微信号未开通 AStudio，
 *    文案指向「先在客户端里开通」而不是「重新扫码」—— 那是假出路）；
 * 3. `POST scanlogin/bind` 确认 → `completeLogin` 三步收尾
 *    （init-app 非阻塞 → userInfo 取昵称 → `bot/models/configs` 换 `api_key`）；
 * 4. 登录结果只有 `key`（无 refresh token）→ 宿主按 API key 形状存，
 *    Cookie 四件套进 metadata，到期交给推理端点的 401。
 */

import { errorMessage } from "../../core/errors.ts"
import { httpBytes } from "../../core/http.ts"
import { notFound, type PageRequest, type PageResponse, PageServer } from "../../core/local-page.ts"
import { jsonFail, jsonOk, renderLoginPage } from "../../core/login-page.ts"
import type { AuthMethod, PluginClient, SignInResult } from "../../core/types.ts"
import { createSettlement, sleep } from "../../core/util.ts"
import {
  bindWechatSession,
  claimDaily,
  completeLogin,
  createWechatQr,
  generateFd,
  pollWechatScan,
  type WechatAccount,
} from "./api.ts"
import { ASTUDIO_QR_POLL_INTERVAL_MS, ASTUDIO_SIGN_IN_TIMEOUT_MS } from "./product.ts"
import { maskIfPhone } from "./session.ts"

export interface AstudioLoginDeps {
  options: Record<string, unknown>
  client: PluginClient
  fetcher: typeof fetch
  /** 登录总时长上限；测试缩短它。 */
  signInTimeoutMs?: number
  /** 轮询间隔；测试缩短它。 */
  pollIntervalMs?: number
  /** 时钟；测试钉住它。 */
  now?: () => number
}

// ── 登录页 ──────────────────────────────────────────────────────────────

type FlowPhase = "waiting" | "scanned" | "unbound" | "done" | "failed"

interface FlowState {
  phase: FlowPhase
  message: string
  /** 二维码 `data:` URL（ticket 图片内联，页面不加载任何外链）。 */
  qr: string
  /** 单调递增：换二维码时递增（本流程 fd 不更换，预留与 Loomy 同款形状）。 */
  generation: number
}

const PHASE_TEXT: Record<FlowPhase, string> = {
  waiting: "等待扫码…",
  scanned: "已扫码，请在微信里确认",
  unbound: "该微信号尚未开通 AStudio 账号",
  done: "登录成功，可以关闭此页面",
  failed: "登录失败",
}

function renderQrPage(state: FlowState): string {
  const script = `
  var stop = cnPoll("state", function (next) {
    var image = document.getElementById("cn-qr-img");
    if (next.qr && image && image.getAttribute("src") !== next.qr) image.src = next.qr;
    if (next.phase === "done") { cnDone(stop, next.message); return; }
    if (next.phase === "failed") {
      stop();
      cnStatus("cn-status", next.message || "登录失败", "err");
      return;
    }
    cnStatus("cn-status", next.message || "");
  }, 1200);
`
  return renderLoginPage({
    title: "登录 AStudio",
    note: "用微信扫一扫（讯飞账号 SSO）",
    accent: "#1f6feb",
    body: `
      <div class="cn-qr"><img id="cn-qr-img" alt="微信扫码登录" src="${state.qr}"></div>
      <p class="cn-hint">扫码后在微信里确认即可；无需 AStudio 客户端</p>`,
    script,
  })
}

/** 把微信 ticket 图片下载并内联成 `data:` URL（按魔数判型，与 Loomy 同款）。 */
async function inlineQrImage(fetcher: typeof fetch, qrUrl: string): Promise<string> {
  const image = await httpBytes(fetcher, qrUrl, { timeoutMs: 30_000 })
  if (!image.ok) throw new Error(`微信二维码返回 HTTP ${image.status}`)
  const mime = imageMime(image.bytes)
  if (mime === "" || image.bytes.length < 200) {
    throw new Error("微信二维码不是图片（多半是错误页）")
  }
  return `data:${mime};base64,${Buffer.from(image.bytes).toString("base64")}`
}

function imageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif"
  return ""
}

// ── 扫码轮询泵 ──────────────────────────────────────────────────────────

interface WechatFlow {
  deps: AstudioLoginDeps
  state: FlowState
  fd: string
  settled(): boolean
  /** 完成登录：宿主存下的结果由这里交出（页面的 done 在此之后才显示）。 */
  settle(result: SignInResult): void
  fail(message: string): void
}

/**
 * 已扫码确认：绑定会话并完成凭据交换。返回是否已终局
 * （绑定失败/收尾失败 → `fail` 已调用，轮询停止）。
 */
async function confirmedStep(flow: WechatFlow, account: WechatAccount): Promise<boolean> {
  const bind = await bindWechatSession(flow.deps.fetcher, { fd: flow.fd, account })
  if (!bind.ok) {
    flow.fail(`绑定微信登录会话失败：${bind.message}`)
    return true
  }
  const completed = await completeLogin(flow.deps.fetcher, {
    uid: account.uid,
    ssoSessionId: account.ssoSessionId,
    ...(account.username === undefined ? {} : { nickname: account.username }),
    loginMethod: "wechat",
  })
  if (!completed.ok) {
    flow.fail(completed.message)
    return true
  }
  const session = completed.session
  const labelSource = session.nickname ?? session.accountId ?? session.uid
  const label = labelSource === undefined ? "AStudio 账号" : maskIfPhone(labelSource)
  flow.state.phase = "done"
  flow.state.message = PHASE_TEXT.done
  flow.settle({
    type: "success",
    key: session.accessToken,
    accountId: label,
    uid: session.uid ?? "",
    ...(session.ssoSessionId === undefined ? {} : { ssoSessionId: session.ssoSessionId }),
    ...(session.token === undefined ? {} : { token: session.token }),
    ...(session.nickname === undefined ? {} : { nickname: session.nickname }),
    loginMethod: "wechat",
  })
  return true
}

/** 扫码轮询，直到终局或超时。SSO 是短轮询，异常一律当作「还没结果」。 */
async function pumpWechat(flow: WechatFlow): Promise<void> {
  const deadline =
    (flow.deps.now?.() ?? Date.now()) + (flow.deps.signInTimeoutMs ?? ASTUDIO_SIGN_IN_TIMEOUT_MS)
  const interval = flow.deps.pollIntervalMs ?? ASTUDIO_QR_POLL_INTERVAL_MS
  while (!flow.settled() && (flow.deps.now?.() ?? Date.now()) < deadline) {
    const poll = await pollWechatScan(flow.deps.fetcher, flow.fd)
    if (poll.status === "scanned") {
      flow.state.phase = "scanned"
      flow.state.message = PHASE_TEXT.scanned
      const finished = await confirmedStep(flow, poll.account)
      if (finished) return
      continue
    }
    if (poll.status === "unbound") {
      flow.state.phase = "unbound"
      flow.state.message = poll.message
      flow.fail(poll.message)
      return
    }
    if (poll.status === "error") await sleep(Math.max(1_000, interval))
    else await sleep(interval)
  }
  if (!flow.settled()) flow.fail("登录超时，请重新发起登录")
}

// ── 发起登录 ────────────────────────────────────────────────────────────

interface StartedFlow {
  url: string
  instructions: string
  done: Promise<SignInResult>
}

/** 跑一次扫码登录：本地页 + SSO 轮询 + 凭据交换。 */
async function startWechat(deps: AstudioLoginDeps): Promise<StartedFlow> {
  const settlement = createSettlement<SignInResult>()
  const fd = generateFd()
  const qr = await createWechatQr(deps.fetcher, fd)
  if (!qr.ok) throw new Error(qr.message)
  const image = await inlineQrImage(deps.fetcher, qr.qr.qrUrl)
  const state: FlowState = { phase: "waiting", message: PHASE_TEXT.waiting, qr: image, generation: 1 }
  let closed = false

  const close = (): void => {
    if (closed) return
    closed = true
    // 晚于页面自己的最后一次轮询，「登录成功」读得完。
    const timer = setTimeout(() => server.close(), 5_000)
    timer.unref?.()
  }

  const settle = (result: SignInResult): void => {
    if (settlement.settled) return
    settlement.settle(result)
    close()
  }

  const fail = (message: string): void => {
    if (settlement.settled) return
    state.phase = "failed"
    state.message = message
    settlement.settle({ type: "failed", error: message })
    close()
  }

  const flow: WechatFlow = {
    deps,
    state,
    fd,
    settled: () => settlement.settled,
    settle,
    fail,
  }

  const server = await PageServer.start(async (request: PageRequest): Promise<PageResponse> => {
    if (settlement.settled && request.method === "POST") {
      return jsonFail("登录流程已结束，请重新发起登录", 409)
    }
    if (request.method === "GET" && request.path === "/") {
      return { contentType: "text/html; charset=utf-8", body: renderQrPage(state) }
    }
    if (request.method === "GET" && request.path === "/state") {
      return jsonOk({
        phase: state.phase,
        message: state.message,
        qr: state.qr,
        generation: state.generation,
      })
    }
    return notFound()
  })

  void pumpWechat(flow).catch((error: unknown) => fail(errorMessage(error)))

  return {
    url: server.url,
    instructions: "在浏览器里打开这个地址，用微信扫码登录 AStudio（讯飞）",
    done: settlement.promise,
  }
}

/** 登录成功后的签到初始化（JetHub：客户端登录后也会拉一次弹窗奖励）。 */
async function initializeRewards(
  deps: AstudioLoginDeps,
  session: { ssoSessionId?: string; accountId?: string; token?: string },
): Promise<void> {
  if (session.ssoSessionId === undefined) return
  try {
    await claimDaily(deps.fetcher, {
      ssoSessionId: session.ssoSessionId,
      ...(session.accountId === undefined ? {} : { accountId: session.accountId }),
      ...(session.token === undefined ? {} : { token: session.token }),
    })
  } catch {
    // 初始化领取失败不影响登录（幂等，下次签到会再试）。
  }
}

/**
 * 登录方式：微信扫码一条，零配置可用。
 *
 * 登录成功后顺手领一次待领的弹窗奖励（每日签到 + 新手礼包）：客户端自己的
 * 登录收尾也这么做，它是幂等读+领，失败只记日志不阻断登录。
 */
export function loginMethods(deps: AstudioLoginDeps): AuthMethod[] {
  return [
    {
      type: "oauth",
      label: "微信扫码登录",
      async authorize() {
        const flow = await startWechat(deps)
        void flow.done
          .then(async (result) => {
            if (result.type !== "success") return
            const ssoSessionId = typeof result.ssoSessionId === "string" ? result.ssoSessionId : undefined
            const accountId = typeof result.uid === "string" ? result.uid : undefined
            const token = typeof result.token === "string" ? result.token : undefined
            await initializeRewards(deps, {
              ...(ssoSessionId === undefined ? {} : { ssoSessionId }),
              ...(accountId === undefined ? {} : { accountId }),
              ...(token === undefined ? {} : { token }),
            })
          })
          .catch(() => undefined)
        return {
          url: flow.url,
          instructions: flow.instructions,
          method: "auto",
          callback: () => flow.done,
        }
      },
    },
  ]
}
