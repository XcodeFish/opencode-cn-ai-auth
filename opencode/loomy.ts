/**
 * OpenCode V2 entry point for Loomy.
 *
 * This is intentionally separate from the Magpie factory at the package root:
 * OpenCode loads a module with `{ id, setup }`, while Magpie loads the two
 * named factories exported by `index.ts`.
 */

import { loginMethods } from "../src/vendors/loomy/login.ts"
import { fallbackModels } from "../src/vendors/loomy/models.ts"
import { LOOMY_API_BASE, LOOMY_ID, LOOMY_NAME } from "../src/vendors/loomy/product.ts"
import { openCodePlugin } from "./adapter.ts"

export default openCodePlugin({
  id: LOOMY_ID,
  name: LOOMY_NAME,
  baseURL: LOOMY_API_BASE,
  env: "LOOMY_SESSION",
  models: fallbackModels(),
  authMethods: (options, client) => loginMethods({ options, client, fetcher: fetch }),
})
