/**
 * OpenCode V2 entry point for Raccoon.
 *
 * Organization accounts may still pass `officeIdentity` in plugin options;
 * the V2 provider adapter leaves that value available to OpenCode's request
 * configuration while the access token comes from options or the environment.
 */

import { refreshAccess } from "../src/vendors/raccoon/api.ts"
import { loginMethods } from "../src/vendors/raccoon/login.ts"
import { fallbackModels } from "../src/vendors/raccoon/models.ts"
import {
  RACCOON_CHAT_BASE,
  RACCOON_ID,
  RACCOON_NAME,
  RACCOON_OFFICE_IDENTITY_OPTION,
} from "../src/vendors/raccoon/product.ts"
import { openCodePlugin } from "./adapter.ts"

export default openCodePlugin({
  id: RACCOON_ID,
  name: RACCOON_NAME,
  baseURL: RACCOON_CHAT_BASE,
  env: "RACCOON_ACCESS_TOKEN",
  models: fallbackModels(),
  authMethods: (options, client) => loginMethods({ options, client, fetcher: fetch }),
  refresh: async (credential) => {
    const renewed = await refreshAccess(fetch, credential.refresh)
    return {
      access: renewed.access,
      refresh: renewed.refresh ?? credential.refresh,
      expires: renewed.expires ?? 0,
    }
  },
  optionHeaders: (options) => {
    const office = options[RACCOON_OFFICE_IDENTITY_OPTION]
    return typeof office === "string" && office.trim().length > 0 ? { "X-Org-Code": office.trim() } : {}
  },
  variantBody: (effort) => ({
    extra_body: { thinking: { type: effort === "none" ? "disabled" : "enabled" } },
  }),
})
