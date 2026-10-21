/**
 * AStudio 账号在宿主存储里的读法与写回。
 *
 * AStudio 没有 refresh token，登录结果只有 `key`（活体模型凭据），宿主按
 * **API key 形状**存：`{ type: "api", key, metadata: { … } }`（`host.js` 的
 * `save` 会重建形状）。因此 Cookie 四件套（`ssoSessionId` / `accountId` /
 * `token`）与昵称全部住在 `metadata` 里 —— `core/stored.ts` 的两个读法同时看
 * 顶层与 `metadata`，本模块一律经它取值，绝不直读 `auth[key]`。
 *
 * 写回只有一处（401 自愈换到新凭据）：必须从宿主给的登录态**整体复制**再改
 * `key`，因为 `client.auth.set` 是整体替换 —— 从零拼一个对象会把 `type`/`metadata`
 * 写丢，账号就静默降级成「没有 Cookie 的空账号」。
 */

import { SignInExpiredError } from "../../core/errors.ts"
import { asObject, str, trimmedStr } from "../../core/json.ts"
import { storedField, storedSession } from "../../core/stored.ts"
import type { PluginClient, StoredAuth } from "../../core/types.ts"
import { maskPhone } from "../../core/util.ts"
import type { Session } from "./api.ts"
import { ASTUDIO_ID } from "./product.ts"

/** 登录态里的活体凭据：OAuth 形状看 `access`，API key 形状看 `key`。 */
export const sessionOf = storedSession

/**
 * 从存储的登录态读出一次请求所需的会话。
 *
 * ⚠️ 兼容两种来源的字段名：本包登录写入 `ssoSessionId` 等驼峰键，同时认
 * 蛇形 `sso_session_id`（用户手工从磁盘会话文件抄进 metadata 时的自然拼写，
 * 与上游磁盘文件字段名一致）。
 */
export function sessionDataOf(auth: StoredAuth | undefined): Session | undefined {
  const accessToken = sessionOf(auth)
  if (accessToken === undefined) return undefined
  const ssoSessionId = storedField(auth, "ssoSessionId") ?? storedField(auth, "sso_session_id")
  const accountId = storedField(auth, "accountId") ?? storedField(auth, "account_id")
  const token = storedField(auth, "token")
  const uid = storedField(auth, "uid")
  const nickname = storedField(auth, "nickname")
  return {
    accessToken,
    ...(accountId === undefined ? {} : { accountId }),
    ...(uid === undefined ? {} : { uid }),
    ...(ssoSessionId === undefined ? {} : { ssoSessionId }),
    ...(token === undefined ? {} : { token }),
    ...(nickname === undefined ? {} : { nickname }),
  }
}

/** 会话，或标出「需要重新登录」的错误。 */
export function requireSession(auth: StoredAuth | undefined, what: string): Session {
  const session = sessionDataOf(auth)
  if (session === undefined) {
    throw new SignInExpiredError(ASTUDIO_ID, `账号里没有登录态（${what}），请重新登录`)
  }
  return session
}

/** 控制面（Cookie）侧的会话字段；没有 Cookie 时返回 undefined，由调用方决定语义。 */
export function controlOf(
  session: Session,
): Pick<Session, "ssoSessionId" | "accountId" | "token"> | undefined {
  const ssoSessionId = trimmedStr(session.ssoSessionId)
  if (ssoSessionId === undefined) return undefined
  return {
    ssoSessionId,
    ...(session.accountId === undefined ? {} : { accountId: session.accountId }),
    ...(session.token === undefined ? {} : { token: session.token }),
  }
}

/** 宿主展示的账号名：优先昵称（手机号掩码），退回账号 id。 */
export function accountLabel(auth: StoredAuth | undefined): string | undefined {
  const nickname = storedField(auth, "nickname")
  if (nickname !== undefined) return maskIfPhone(nickname)
  const accountId = storedField(auth, "accountId") ?? storedField(auth, "account_id")
  if (accountId !== undefined) return accountId
  return storedField(auth, "uid")
}

/** 手机号原值只露末 2 位是用户定过的口径（JetHub lobsterai 整改同款）；非手机号原样。 */
export function maskIfPhone(value: string): string {
  return /^1[3-9]\d{9}$/.test(value) ? maskPhone(value) : value
}

/** 登录成功时宿主存下的形状（API key；扩展字段进 metadata 由宿主负责）。 */
export function signInStored(session: Session, now = Date.now()): StoredAuth & Record<string, unknown> {
  return {
    type: "api",
    key: session.accessToken,
    accountId: session.accountId ?? session.uid ?? "",
    uid: session.uid ?? "",
    ...(session.ssoSessionId === undefined ? {} : { ssoSessionId: session.ssoSessionId }),
    ...(session.token === undefined ? {} : { token: session.token }),
    ...(session.nickname === undefined ? {} : { nickname: session.nickname }),
    loggedAt: now,
    loginMethod: "wechat",
  }
}

/**
 * 401 自愈换到新凭据后的写回：**整体复制**宿主给的登录态，只改 `key`
 * （与 metadata 里可能存在的旧值同源字段 `accessToken` 不存在 —— API key 形状
 * 的凭据就是 `key` 本身）。写失败静默吞掉：写回失败只影响下次请求的起点，
 * 不影响本次已经拿到的响应。
 */
export async function rememberAccessToken(
  client: PluginClient,
  provider: string,
  auth: StoredAuth | undefined,
  accessToken: string,
): Promise<void> {
  if (auth === undefined) return
  const current = sessionOf(auth)
  if (current === accessToken) return
  await client.auth
    .set({
      path: { id: provider },
      body: { ...auth, key: accessToken, ...(auth.access === undefined ? {} : { access: accessToken }) },
    })
    .catch(() => undefined)
}

/** metadata 里可读的字符串字段（排障与登录页共用）。 */
export function metadataString(auth: StoredAuth | undefined, key: string): string | undefined {
  return str(asObject(auth?.metadata)?.[key]) ?? str(auth?.[key])
}
