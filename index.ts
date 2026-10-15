/**
 * What magpie loads: this package's provider plugins.
 *
 * The host reads a plugin entry's module and calls **every function export**
 * as a plugin factory (`internal/plugin/host.js`'s `servers()`), so this file
 * exports the factories and nothing else. Vendor code lives in `src/`, where
 * a function is a function; nothing there is visible to the host.
 *
 * A vendor is added by writing `src/vendors/<id>/` and exporting its
 * factory here — one package can hold several, and one magpie entry's
 * options object is shared by all of them (see `docs/architecture.md`).
 */

export { LoomyAuthPlugin } from "./src/vendors/loomy/index.ts"
export { RaccoonAuthPlugin } from "./src/vendors/raccoon/index.ts"
export { TraeAuthPlugin } from "./src/vendors/trae/index.ts"
