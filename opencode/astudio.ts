/**
 * OpenCode V2 entry point for AStudio (讯飞).
 *
 * 与根入口的 Magpie 工厂是两套独立宿主契约：OpenCode 加载的是
 * `{ id, setup }` 模块。AStudio 与 Loomy/Raccoon 同形 —— 推理端点就是
 * OpenAI 兼容的，适配器只需注入 `Authorization: Bearer`；账号控制面的
 * Cookie 字段（`ssoSessionId` 等）由 V2 凭据的 `metadata` 携带，但聊天请求
 * 用不到它们（实测 `X-Account-Id` 也不带也能 200），所以这里不装 bridge。
 */

import { loginMethods } from "../src/vendors/astudio/login.ts"
import { fallbackModels } from "../src/vendors/astudio/models.ts"
import { ASTUDIO_API_BASE, ASTUDIO_ID, ASTUDIO_NAME } from "../src/vendors/astudio/product.ts"
import { openCodePlugin } from "./adapter.ts"

export default openCodePlugin({
  id: ASTUDIO_ID,
  name: ASTUDIO_NAME,
  baseURL: ASTUDIO_API_BASE,
  env: "ASTUDIO_ACCESS_TOKEN",
  models: fallbackModels(),
  authMethods: (options, client) => loginMethods({ options, client, fetcher: fetch }),
  credentialEnv: {
    uid: "ASTUDIO_UID",
    accountId: "ASTUDIO_ACCOUNT_ID",
    nickname: "ASTUDIO_NICKNAME",
  },
})
