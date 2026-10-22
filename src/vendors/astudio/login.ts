/**
 * AStudio 的登录：三合一载体页（微信扫码 / 短信验证码 / 账号密码）。
 *
 * 与 JetHub 的 `astudio-oauth.ts` 载体页同构 —— 一个本地页三个 Tab，页面只做
 * UI 与极验滑块，**所有厂商请求都由插件进程代理**（页面拿不到凭据，密码只在
 * POST 体里路过一次）。三条路最终都汇入 `completeLogin` 三步收尾
 * （init-app 非阻塞 → userInfo（仅微信）→ `bot/models/configs` 换 `api_key`）。
 *
 * | 方式 | 链路 | 极验 |
 * |---|---|---|
 * | 微信扫码 | 讯飞公共 SSO `scanlogin/qrcode→uids→bind`（本包自备 8 位 `fd`） | 无 |
 * | 短信验证码 | `chat/gee-captcha` 拉配置 → 页面滑块 → `login/mobile/send-verify-code` → `login/phone-quick-login` | 仅发送一步 |
 * | 账号密码 | 页面滑块 → `login/check-account` | 登录一步 |
 *
 * 极验（GeeTest）必须在**浏览器里**完成（滑块交互），所以配置由插件代理下发、
 * 滑块回执三件套（challenge/validate/seccode）由页面交回插件、再由插件转发厂商；
 * `gt.js` 是厂商自己的公开 SDK（`renderLoginPage` 的 vendor scripts 通道）。
 * 未注册手机号验证通过后，收尾的 `init-app` 会自动完成注册开户（JetHub 同款）。
 */

import { errorMessage } from "../../core/errors.ts"
import { httpBytes } from "../../core/http.ts"
import { notFound, type PageRequest, type PageResponse, PageServer } from "../../core/local-page.ts"
import { jsonFail, jsonOk, renderLoginPage } from "../../core/login-page.ts"
import type { AuthMethod, PluginClient, SignInResult } from "../../core/types.ts"
import { createSettlement, mainlandPhone, maskPhone, sleep } from "../../core/util.ts"
import {
  bindWechatSession,
  claimDaily,
  completeLogin,
  createWechatQr,
  fetchGeetestConfig,
  type GeeTestResult,
  generateFd,
  loginWithPassword,
  loginWithSms,
  pollWechatScan,
  type Session,
  sendSmsCode,
  type WechatAccount,
} from "./api.ts"
import {
  ASTUDIO_QR_POLL_INTERVAL_MS,
  ASTUDIO_SIGN_IN_TIMEOUT_MS,
  ASTUDIO_SSO_SESSION_TTL_MS,
} from "./product.ts"
import { maskIfPhone } from "./session.ts"

/** 极验官方 v3 SDK（载体页顶层加载；CSP 白名单放行 geetest/geevisit 两个域）。 */
const GEE_TEST_SDK_URL = "https://static.geetest.com/static/tools/gt.js"

/**
 * 载体页**自己的** CSP（覆盖基座默认值，`PageResponse.contentSecurityPolicy` 通道）。
 *
 * ## 为什么必须覆盖（2026-10-22 用户实测的第四个坑，也是真根因）
 *
 * 基座 `local-page.ts` 给每个登录页默认加 `script-src 'unsafe-inline'` —— 只放行
 * 内联脚本，**外部 gt.js 被浏览器静默拦截**，静态与动态两次加载必然全失败，而同机
 * curl 一切正常（HTTP 200 / 0.1s）⇒ 排查半天网络全无收获。基座原本为此设计了
 * 「厂商 SDK 跑在自带宽松 CSP 的沙箱 iframe」这条路（Raccoon 阿里云滑块即此模式），
 * 但 GeeTest v3 在**不透明 origin** 的沙箱里不可靠（弹层被 iframe 视口裁剪、就绪
 * 时序与 postMessage 往返都增加失败面），实测「点击完成安全验证完全没反应」。
 * ⇒ 改为与 JetHub 载体页同款：滑块跑在**顶层页面**，页面自带白名单 CSP。
 *
 * ## 安全边界（与基座默认值的差异必须写清楚）
 *
 * - 仍然 `default-src 'none'` + `form-action 'none'` + `frame-ancestors 'none'`：
 *   页面不能向任何地方提交表单、不能被嵌套；
 * - `script-src` 只多放行**极验的两个公开域名**（`*.geetest.com` / `*.geevisit.com`，
 *   后者是官方备用域），不写 `https:` 通配；
 * - `connect-src` 除极验域名外只留 `'self'`（本机载体 API）；
 * - 这个页面**按设计不持有任何凭据**（页面只发手机号/账号/滑块回执，凭据由插件
 *   进程换取并直接交付宿主），所以放行滑块 SDK 的收益/风险是划算的；
 * - 不用沙箱 iframe 的另一个原因：`sandbox` 无 `allow-same-origin` ⇒ 不透明 origin，
 *   而 GeeTest 需要在自家域内读写状态。
 */
const CARRIER_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "script-src 'unsafe-inline' https://*.geetest.com https://*.geevisit.com",
  "connect-src 'self' https://*.geetest.com https://*.geevisit.com",
  "img-src 'self' data: https://*.geetest.com https://*.geevisit.com",
  "style-src 'unsafe-inline' https://*.geetest.com https://*.geevisit.com",
  "frame-src https://*.geetest.com https://*.geevisit.com",
  "child-src https://*.geetest.com https://*.geevisit.com",
].join("; ")

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

// ── 微信扫码流（服务端泵）────────────────────────────────────────────────

type FlowPhase = "waiting" | "scanned" | "unbound" | "done" | "failed"

interface FlowState {
  phase: FlowPhase
  message: string
  /** 二维码 `data:` URL（ticket 图片内联，页面不加载任何外链）。 */
  qr: string
  /** 单调递增：换二维码时递增。 */
  generation: number
}

const PHASE_TEXT: Record<FlowPhase, string> = {
  waiting: "等待扫码…",
  scanned: "已扫码，请在微信里确认",
  unbound: "该微信号尚未开通 AStudio 账号",
  done: "登录成功，可以关闭此页面",
  failed: "登录失败",
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
 * 登录成功时宿主存下的形状 —— 必须是 **OAuth 形状**（`access` + `refresh` + `expires`）。
 *
 * ## ⚠️ 为什么不能只给 `key`（2026-10-22 用户实测的真实缺陷）
 *
 * 本包登录成功后，宿主 magpie 实存的是 `{type:"api", key}` —— **扩展字段全被
 * 丢掉了**（`ssoSessionId`/`token`/`accountId`/`nickname` 一个不剩），于是
 * `usage`/`checkin` 读不到控制面 Cookie，账号卡片显示「账号里没有登录会话
 * Cookie，请重新登录」。对照同一台机器上 Loomy/Raccoon/TRAE 的实存形状：全都是
 * `type:"oauth"` 且扩展字段**在顶层**（`accountId`/`phone`/`dailyQuota`/`machineId`…）。
 * 差别就在登录结果里有没有 `refresh`：**API key 形状只保留 `key`，OAuth 形状
 * 保留顶层扩展字段**（`docs/architecture.md` §4.6）。而 AStudio 的自愈与额度
 * 全部依赖 Cookie 四件套，丢了它们账号就是死的。
 *
 * ⇒ 按 Loomy 同款：给 `access`（活体模型凭据）+ `refresh: ""`（**仅为标记存储
 * 形状**，AStudio 没有续期端点，本包也没有 `auth.refresh` 钩子）+ 一个正数
 * `expires`（SSO 会话的实测 Max-Age，见 `ASTUDIO_SSO_SESSION_TTL_MS`）。
 * ⚠️ 不要改回 `key`。
 */
function signInResultOf(session: Session, loginMethod: string): SignInResult {
  const labelSource = session.nickname ?? session.mobile ?? session.accountId ?? session.uid
  const label = labelSource === undefined ? "AStudio 账号" : maskIfPhone(labelSource)
  return {
    type: "success",
    access: session.accessToken,
    refresh: "",
    expires: Date.now() + ASTUDIO_SSO_SESSION_TTL_MS,
    accountId: label,
    uid: session.uid ?? "",
    ...(session.ssoSessionId === undefined ? {} : { ssoSessionId: session.ssoSessionId }),
    ...(session.token === undefined ? {} : { token: session.token }),
    ...(session.nickname === undefined ? {} : { nickname: session.nickname }),
    loginMethod,
  }
}

/** 已扫码确认：绑定会话并完成凭据交换。返回是否已终局。 */
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
  flow.state.phase = "done"
  flow.state.message = PHASE_TEXT.done
  flow.settle(signInResultOf(completed.session, "wechat"))
  void initializeRewards(flow.deps, {
    ...(completed.session.ssoSessionId === undefined ? {} : { ssoSessionId: completed.session.ssoSessionId }),
    ...(completed.session.accountId === undefined ? {} : { accountId: completed.session.accountId }),
    ...(completed.session.token === undefined ? {} : { token: completed.session.token }),
  }).catch(() => undefined)
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

// ── 短信 / 密码（页面滑块 + 插件代理）─────────────────────────────────────

/** 页面滑块回执的完整性校验（服务端代理前的最后一道闸）。 */
function captchaOf(body: Record<string, unknown>): GeeTestResult | undefined {
  const geetestChallenge = typeof body.geetestChallenge === "string" ? body.geetestChallenge : ""
  const geetestValidate = typeof body.geetestValidate === "string" ? body.geetestValidate : ""
  const geetestSeccode = typeof body.geetestSeccode === "string" ? body.geetestSeccode : ""
  if (geetestChallenge.length === 0 || geetestValidate.length === 0 || geetestSeccode.length === 0) {
    return undefined
  }
  return { geetestChallenge, geetestValidate, geetestSeccode }
}

/** 登录成功后的签到初始化（幂等读+领；失败只记日志不阻断登录）。 */
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

// ── 三合一载体页 ────────────────────────────────────────────────────────

/**
 * 页面标记与脚本。三条路的分工与 JetHub 载体页同构：
 * 页面只切 Tab、跑极验滑块、把表单 POST 给本机代理；极验 `gt.js` 是厂商
 * 自己的公开 SDK（vendor scripts 通道），`product:"bind"` 弹滑块、
 * `offline: !success` 走离线形态（JetHub 同款 init 参数）。
 */
function renderCarrierPage(state: FlowState): string {
  const body = `
  <style>
    .cn-tabs { display: flex; gap: 4px; margin: 4px 0 14px; background: #eef0f4; border-radius: 8px; padding: 4px; }
    .cn-tabs button { flex: 1; border: 0; background: transparent; border-radius: 6px; padding: 7px 0;
      font-size: 13px; cursor: pointer; color: #4e5969; }
    .cn-tabs button.cn-tab-on { background: #fff; color: #1f6feb; font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .cn-pane { display: none; text-align: left; }
    .cn-pane.cn-pane-on { display: block; }
    .cn-pane label { display: block; font-size: 12px; color: #4e5969; margin: 10px 0 4px; }
    .cn-pane input { width: 100%; box-sizing: border-box; border: 1px solid #d9dce3; border-radius: 8px;
      padding: 9px 10px; font-size: 14px; }
    .cn-row { display: flex; gap: 8px; }
    .cn-row input { flex: 1; }
    .cn-btn { width: 100%; margin-top: 14px; border: 0; border-radius: 8px; padding: 10px 0; font-size: 14px;
      cursor: pointer; background: #eef0f4; color: #4e5969; }
    .cn-btn.cn-go { background: #1f6feb; color: #fff; font-weight: 600; }
    .cn-btn:disabled { opacity: .55; cursor: default; }
    .cn-captcha-box { margin-top: 8px; font-size: 12px; color: #1f6feb; min-height: 18px; }
    .cn-pane .cn-qr { text-align: center; }
    .cn-pane .cn-qr img { width: 210px; height: 210px; }
  </style>
  <div class="cn-tabs">
    <button type="button" id="cn-tab-sms" class="cn-tab-on">手机验证码</button>
    <button type="button" id="cn-tab-pwd">账号密码</button>
    <button type="button" id="cn-tab-qr">微信扫码</button>
  </div>

  <div class="cn-pane cn-pane-on" id="cn-pane-sms">
    <label for="cn-sms-phone">手机号</label>
    <input id="cn-sms-phone" type="tel" inputmode="numeric" maxlength="11" placeholder="请输入中国大陆手机号">
    <label>人机验证</label>
    <button class="cn-btn" id="cn-sms-captcha-btn" type="button">完成安全验证</button>
    <div class="cn-captcha-box" id="cn-sms-captcha-box"></div>
    <label for="cn-sms-code">验证码</label>
    <div class="cn-row">
      <input id="cn-sms-code" type="text" inputmode="numeric" maxlength="6" placeholder="6 位验证码">
      <button class="cn-btn" style="width:auto;margin:0;padding:9px 14px;" id="cn-sms-send" type="button">获取验证码</button>
    </div>
    <button class="cn-btn cn-go" id="cn-sms-login" type="button">登 录</button>
    <p class="cn-note">未注册手机号验证通过后将自动完成注册开户</p>
  </div>

  <div class="cn-pane" id="cn-pane-pwd">
    <label for="cn-pwd-account">账号或手机号</label>
    <input id="cn-pwd-account" type="text" placeholder="账号 / 手机号">
    <label for="cn-pwd-password">密码</label>
    <input id="cn-pwd-password" type="password" placeholder="密码">
    <label>人机验证</label>
    <button class="cn-btn" id="cn-pwd-captcha-btn" type="button">完成安全验证</button>
    <div class="cn-captcha-box" id="cn-pwd-captcha-box"></div>
    <button class="cn-btn cn-go" id="cn-pwd-login" type="button">登 录</button>
  </div>

  <div class="cn-pane" id="cn-pane-qr">
    <div class="cn-qr"><img id="cn-qr-img" alt="微信扫码登录" src="${state.qr}"></div>
    <p class="cn-note">扫码后在微信里确认即可；无需 AStudio 客户端</p>
  </div>`

  const script = `
  // ── 自诊断：任何 CSP 拦截 / 脚本错误都写到状态条上，不再「点击没反应」──
  document.addEventListener("securitypolicyviolation", function (e) {
    cnStatus("cn-status", "被安全策略拦截：" + (e.blockedURI || e.violatedDirective || "未知资源"), "err");
  });
  window.addEventListener("error", function (e) {
    cnStatus("cn-status", "页面脚本错误：" + (e.message || "未知错误"), "err");
  });
  cnStatus("cn-status", "请选择登录方式；短信 / 密码需先完成人机验证", "");

  var activeTab = "sms";
  function showTab(name) {
    activeTab = name;
    ["sms", "pwd", "qr"].forEach(function (key) {
      document.getElementById("cn-tab-" + key).className = key === name ? "cn-tab-on" : "";
      document.getElementById("cn-pane-" + key).className = "cn-pane" + (key === name ? " cn-pane-on" : "");
    });
  }
  document.getElementById("cn-tab-sms").addEventListener("click", function () { showTab("sms"); });
  document.getElementById("cn-tab-pwd").addEventListener("click", function () { showTab("pwd"); });
  document.getElementById("cn-tab-qr").addEventListener("click", function () { showTab("qr"); });

  // 微信 Tab：状态轮询（服务端泵在插件进程里跑）。
  var stop = cnPoll("state", function (next) {
    var image = document.getElementById("cn-qr-img");
    if (next.qr && image && image.getAttribute("src") !== next.qr) image.src = next.qr;
    if (next.phase === "done") { cnDone(stop, next.message); return; }
    if (next.phase === "failed") {
      stop();
      cnStatus("cn-status", next.message || "登录失败", "err");
      return;
    }
    if (activeTab === "qr") cnStatus("cn-status", next.message || "");
  }, 1200);

  // 极验滑块：配置由本机代理下发（不含任何凭据），回执三件套交回插件转发。
  // 极验滑块（顶层页面；页面 CSP 白名单放行 gt.js —— 见 CARRIER_CSP 的说明）。
  // SDK 双重加载：静态标签 + 动态兜底（弱网/代理下静态可能失败）。
  var gtScriptPromise = null;
  function ensureGeetestSdk() {
    if (typeof window.initGeetest === "function") return Promise.resolve();
    if (gtScriptPromise) return gtScriptPromise;
    gtScriptPromise = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = "${GEE_TEST_SDK_URL}";
      script.async = true;
      script.addEventListener("load", function () { resolve(); }, { once: true });
      script.addEventListener("error", function () {
        script.remove();
        gtScriptPromise = null;
        reject(new Error("安全验证组件加载失败，请检查网络或广告拦截插件后重试。"));
      }, { once: true });
      document.head.appendChild(script);
    });
    return gtScriptPromise;
  }
  // 一次一枚验证：pending 期间忽略重复点击；任何失败都在**按钮旁**写原因
  //（底部状态条可能不在视野内，2026-10-22 用户实测「点击没反应」）。
  var pending = false;
  function triggerGeetest(slot, boxId) {
    var btn = document.getElementById("cn-" + slot + "-captcha-btn");
    var box = document.getElementById(boxId);
    if (pending) return Promise.reject(new Error("安全验证进行中，请稍候"));
    pending = true;
    btn.disabled = true;
    btn.textContent = "正在拉起验证…";
    box.textContent = "正在拉取安全验证…";
    cnStatus("cn-status", "正在准备安全验证…", "");
    function reset() {
      pending = false;
      btn.disabled = false;
      btn.textContent = "完成安全验证";
    }
    return ensureGeetestSdk().then(function () {
      if (typeof window.initGeetest !== "function") throw new Error("安全验证组件不可用，请刷新页面重试。");
      return fetch("gee-captcha");
    }).then(function (r) { return r.json(); }).then(function (json) {
      if (!json.ok || !json.config) throw new Error(json.message || "获取安全验证配置失败");
      var c = json.config;
      return new Promise(function (resolve, reject) {
        var finished = false;
        var instance = null;
        var timer = setTimeout(function () { finish({ error: new Error("安全验证超时，请重试") }); }, 45000);
        function finish(result) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          try { if (instance && instance.destroy) instance.destroy(); } catch (_) {}
          if ("payload" in result) resolve(result.payload); else reject(result.error);
        }
        try {
          window.initGeetest({
            gt: c.gt, challenge: c.challenge, success: c.success, new_captcha: c.newCaptcha,
            https: true, offline: !c.success, product: "bind", width: "100%"
          }, function (captchaObj) {
            instance = captchaObj;
            captchaObj.onReady(function () {
              try { captchaObj.verify(); } catch (e) { finish({ error: new Error("安全验证启动失败，请重试") }); }
            });
            captchaObj.onError(function () { finish({ error: new Error("安全验证网络异常，请稍后重试") }); });
            if (captchaObj.onClose) captchaObj.onClose(function () { finish({ error: new Error("安全验证已取消") }); });
            captchaObj.onSuccess(function () {
              var val = captchaObj.getValidate();
              if (!val || !val.geetest_challenge || !val.geetest_validate || !val.geetest_seccode) {
                finish({ error: new Error("安全验证结果无效，请重试") });
                return;
              }
              finish({ payload: {
                geetestChallenge: val.geetest_challenge,
                geetestValidate: val.geetest_validate,
                geetestSeccode: val.geetest_seccode
              } });
            });
          });
        } catch (e) {
          finish({ error: new Error("安全验证初始化失败，请重试") });
        }
      });
    }).then(function (captcha) {
      reset();
      box.textContent = "✓ 已完成安全验证";
      cnStatus("cn-status", "", "");
      return captcha;
    }).catch(function (e) {
      reset();
      box.textContent = e && e.message ? e.message : "安全验证失败";
      cnStatus("cn-status", e && e.message ? e.message : "安全验证失败", "err");
      throw e;
    });
  }
  var smsCaptcha = null, pwdCaptcha = null;
  // 两个槽位的点击绑定（顶层 triggerGeetest；旧的 setupCaptcha 已随沙箱方案删除）
  document.getElementById("cn-sms-captcha-btn").addEventListener("click", function () {
    triggerGeetest("sms", "cn-sms-captcha-box").then(function (captcha) { smsCaptcha = captcha; })
      .catch(function () { /* 失败原因已写在按钮旁与状态条 */ });
  });
  document.getElementById("cn-pwd-captcha-btn").addEventListener("click", function () {
    triggerGeetest("pwd", "cn-pwd-captcha-box").then(function (captcha) { pwdCaptcha = captcha; })
      .catch(function () { /* 失败原因已写在按钮旁与状态条 */ });
  });

  // 短信：发送（需滑块回执）+ 登录。
  document.getElementById("cn-sms-send").addEventListener("click", function () {
    var btn = document.getElementById("cn-sms-send");
    var phone = document.getElementById("cn-sms-phone").value.trim();
    if (!phone) return cnStatus("cn-status", "请输入手机号", "err");
    if (!smsCaptcha) return cnStatus("cn-status", "请先完成人机安全验证", "err");
    btn.disabled = true;
    cnStatus("cn-status", "正在发送验证码…", "");
    cnPost("sms/send", { mobile: phone, geetestChallenge: smsCaptcha.geetestChallenge,
      geetestValidate: smsCaptcha.geetestValidate, geetestSeccode: smsCaptcha.geetestSeccode })
      .then(function (data) {
        cnStatus("cn-status", data.message || "验证码已发送", "ok");
        var sec = 60;
        var t = setInterval(function () {
          sec -= 1;
          if (sec <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = "获取验证码"; }
          else btn.textContent = sec + "s";
        }, 1000);
      })
      .catch(function (e) { btn.disabled = false; cnStatus("cn-status", e.message || "发送失败", "err"); });
  });
  document.getElementById("cn-sms-login").addEventListener("click", function () {
    var phone = document.getElementById("cn-sms-phone").value.trim();
    var code = document.getElementById("cn-sms-code").value.trim();
    if (!phone) return cnStatus("cn-status", "请输入手机号", "err");
    if (!code) return cnStatus("cn-status", "请输入短信验证码", "err");
    cnStatus("cn-status", "正在登录…", "");
    cnPost("sms/login", { mobile: phone, verifyCode: code })
      .then(function () { cnDone(stop, "登录成功，可以关闭此页面"); })
      .catch(function (e) { cnStatus("cn-status", e.message || "登录失败", "err"); });
  });

  // 密码：滑块回执 + 登录。
  document.getElementById("cn-pwd-login").addEventListener("click", function () {
    var account = document.getElementById("cn-pwd-account").value.trim();
    var pwd = document.getElementById("cn-pwd-password").value;
    if (!account) return cnStatus("cn-status", "请输入账号或手机号", "err");
    if (!pwd) return cnStatus("cn-status", "请输入密码", "err");
    if (!pwdCaptcha) return cnStatus("cn-status", "请先完成人机安全验证", "err");
    cnStatus("cn-status", "正在登录…", "");
    cnPost("password/login", { accountName: account, accountPwd: pwd,
      geetestChallenge: pwdCaptcha.geetestChallenge,
      geetestValidate: pwdCaptcha.geetestValidate, geetestSeccode: pwdCaptcha.geetestSeccode })
      .then(function () { cnDone(stop, "登录成功，可以关闭此页面"); })
      .catch(function (e) { cnStatus("cn-status", e.message || "登录失败", "err"); });
  });
`
  return renderLoginPage({
    title: "登录 AStudio",
    note: "讯飞账号 SSO：扫码 / 短信 / 密码任选其一",
    accent: "#1f6feb",
    body,
    script,
    // 静态标签 + 动态兜底（ensureGeetestSdk）双重加载，JetHub 同款。
    scripts: [GEE_TEST_SDK_URL],
  })
}

// ── 载体服务 ────────────────────────────────────────────────────────────

interface StartedFlow {
  url: string
  instructions: string
  done: Promise<SignInResult>
}

interface CarrierFlow {
  deps: AstudioLoginDeps
  state: FlowState
  fd: string
  settled(): boolean
  settle(result: SignInResult): void
  fail(message: string): void
  close(): void
}

/** 短信/密码登录成功后的收尾：completeLogin → 结果交付 → 顺手领弹窗奖励。 */
async function settleIdentity(
  flow: CarrierFlow,
  identity: {
    uid: string
    ssoSessionId: string
    nickname?: string
    token?: string
    accountId?: string
    mobile?: string
    loginMethod: string
  },
): Promise<PageResponse> {
  const completed = await completeLogin(flow.deps.fetcher, {
    uid: identity.uid,
    ssoSessionId: identity.ssoSessionId,
    ...(identity.nickname === undefined ? {} : { nickname: identity.nickname }),
    ...(identity.token === undefined ? {} : { token: identity.token }),
    ...(identity.accountId === undefined ? {} : { accountId: identity.accountId }),
    ...(identity.mobile === undefined ? {} : { mobile: identity.mobile }),
    loginMethod: identity.loginMethod,
  })
  if (!completed.ok) return jsonFail(completed.message)
  flow.state.phase = "done"
  flow.state.message = PHASE_TEXT.done
  flow.settle(signInResultOf(completed.session, identity.loginMethod))
  void initializeRewards(flow.deps, {
    ...(completed.session.ssoSessionId === undefined ? {} : { ssoSessionId: completed.session.ssoSessionId }),
    ...(completed.session.accountId === undefined ? {} : { accountId: completed.session.accountId }),
    ...(completed.session.token === undefined ? {} : { token: completed.session.token }),
  }).catch(() => undefined)
  return jsonOk()
}

/** 载体页的 GET 路由：页面本体、扫码状态、极验配置代理。 */
async function carrierGet(flow: CarrierFlow, request: PageRequest): Promise<PageResponse | undefined> {
  if (request.path === "/") {
    return {
      contentType: "text/html; charset=utf-8",
      // 页面自带 CSP：白名单放行极验两个域（基座默认 CSP 会拦掉外部 gt.js）。
      contentSecurityPolicy: CARRIER_CSP,
      body: renderCarrierPage(flow.state),
    }
  }
  if (request.path === "/state") {
    return jsonOk({
      phase: flow.state.phase,
      message: flow.state.message,
      qr: flow.state.qr,
      generation: flow.state.generation,
    })
  }
  if (request.path === "/gee-captcha") {
    const config = await fetchGeetestConfig(flow.deps.fetcher)
    return config.ok ? jsonOk({ config: config.config }) : jsonFail(config.message)
  }
  return undefined
}

/** 载体页的 POST 路由分发：发短信、短信登录、密码登录（全部由插件代理厂商请求）。 */
async function carrierPost(flow: CarrierFlow, request: PageRequest): Promise<PageResponse> {
  const body = await request.json()
  if (request.path === "/sms/send") return await smsSend(flow.deps, body)
  if (request.path === "/sms/login") return await smsLogin(flow, body)
  if (request.path === "/password/login") return await passwordLogin(flow, body)
  return notFound()
}

/** 发送短信验证码：手机号与极验回执校验后由插件转发厂商。 */
async function smsSend(deps: AstudioLoginDeps, body: Record<string, unknown>): Promise<PageResponse> {
  const phone = mainlandPhone(typeof body.mobile === "string" ? body.mobile : undefined)
  if (phone === undefined) return jsonFail("请输入有效的 11 位手机号")
  const captcha = captchaOf(body)
  if (captcha === undefined) return jsonFail("请先完成人机安全验证")
  const sent = await sendSmsCode(deps.fetcher, { mobile: phone, countryCode: "86", captcha })
  return sent.ok ? jsonOk({ message: `验证码已发送到 ${maskPhone(phone)}` }) : jsonFail(sent.message)
}

/** 短信验证码登录：快速登录换身份 → 收尾三步换凭据。 */
async function smsLogin(flow: CarrierFlow, body: Record<string, unknown>): Promise<PageResponse> {
  const phone = mainlandPhone(typeof body.mobile === "string" ? body.mobile : undefined)
  const code = typeof body.verifyCode === "string" ? body.verifyCode.trim() : ""
  if (phone === undefined) return jsonFail("请输入有效的 11 位手机号")
  if (code.length === 0) return jsonFail("请输入短信验证码")
  const login = await loginWithSms(flow.deps.fetcher, { mobile: phone, verifyCode: code })
  if (!login.ok) return jsonFail(login.message)
  return await settleIdentity(flow, login.identity)
}

/** 账号密码登录：极验回执校验后 check-account → 收尾三步换凭据。 */
async function passwordLogin(flow: CarrierFlow, body: Record<string, unknown>): Promise<PageResponse> {
  const accountName = typeof body.accountName === "string" ? body.accountName.trim() : ""
  const accountPwd = typeof body.accountPwd === "string" ? body.accountPwd : ""
  const captcha = captchaOf(body)
  if (accountName.length === 0) return jsonFail("请输入账号或手机号")
  if (accountPwd.length === 0) return jsonFail("请输入密码")
  if (captcha === undefined) return jsonFail("请先完成人机安全验证")
  const login = await loginWithPassword(flow.deps.fetcher, { accountName, accountPwd, captcha })
  if (!login.ok) return jsonFail(login.message)
  return await settleIdentity(flow, login.identity)
}

/** 跑一次三合一登录：本地页 + 微信泵 + 短信/密码代理。 */
async function startCarrier(deps: AstudioLoginDeps): Promise<StartedFlow> {
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

  const flow: CarrierFlow = {
    deps,
    state,
    fd,
    settled: () => settlement.settled,
    settle,
    fail,
    close,
  }

  const server = await PageServer.start(async (request: PageRequest): Promise<PageResponse> => {
    if (settlement.settled && request.method === "POST") {
      return jsonFail("登录流程已结束，请重新发起登录", 409)
    }
    if (request.method === "POST") return await carrierPost(flow, request)
    if (request.method === "GET") return (await carrierGet(flow, request)) ?? notFound()
    return notFound()
  })

  void pumpWechat(flow).catch((error: unknown) => fail(errorMessage(error)))

  return {
    url: server.url,
    instructions: "在浏览器里打开这个地址：微信扫码 / 短信验证码 / 账号密码任选其一登录 AStudio（讯飞）",
    done: settlement.promise,
  }
}

/**
 * 登录方式：一个入口三种方式（JetHub 载体页同款三 Tab），全部零配置可用 ——
 * 扫码走讯飞公共 SSO，短信/密码走极验滑块，都不需要任何厂商自有常量。
 */
export function loginMethods(deps: AstudioLoginDeps): AuthMethod[] {
  return [
    {
      type: "oauth",
      label: "扫码 / 短信 / 密码登录",
      async authorize() {
        const flow = await startCarrier(deps)
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
