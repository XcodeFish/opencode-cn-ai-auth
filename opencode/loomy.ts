/**
 * Direct OpenCode entry point for the Loomy provider.
 *
 * Magpie loads the package root and discovers both named factories. OpenCode
 * loads one `server` module, so each vendor has an explicit subpath instead
 * of pretending that two auth hooks can be merged into one OpenCode hook.
 */

import { LoomyAuthPlugin } from "../src/vendors/loomy/index.ts"

export default {
  id: "opencode-cn-ai-loomy",
  server: LoomyAuthPlugin,
}
