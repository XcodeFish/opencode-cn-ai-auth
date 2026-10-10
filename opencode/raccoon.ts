/**
 * Direct OpenCode entry point for the Raccoon provider.
 *
 * Raccoon organization accounts need `officeIdentity`. OpenCode's public
 * API-key auth shape has no metadata field, so configure that value in the
 * plugin options when using an organization account directly with OpenCode.
 * Magpie keeps the learned value in its account metadata automatically.
 */

import { RaccoonAuthPlugin } from "../src/vendors/raccoon/index.ts"

export default {
  id: "opencode-cn-ai-raccoon",
  server: RaccoonAuthPlugin,
}
