/**
 * Answering the host's `provider.models` hook, once for every vendor.
 *
 * The hook has three rules the host reads, and every vendor has to obey all
 * three (`internal/plugin/host.js`'s `info()`), so they are stated here
 * rather than re-typed per vendor:
 *
 * - **An empty list is not an answer.** Returning undefined (or an empty
 *   record) hands the host back the list it already had, which is the right
 *   result for a plan that serves nothing this package knows: an empty
 *   record would leave the account with no models at all. So an empty read
 *   is reported as "nothing to say" instead of as an empty catalog.
 * - **A failed read keeps the package's table**, marked with
 *   `Symbol.for("magpie.fellBack")` (`models.ts`'s `markFallback`), and the
 *   host then says on screen that the list is not the account's. Returning
 *   the packaged copy unmarked would show it as if the vendor had said it.
 * - **A refused sign-in is not a failed read.** `SignInExpiredError` is the
 *   host's signal to mark the account as needing a new sign-in, so it must
 *   travel up untouched; swallowing it here would leave a lapsed account
 *   looking like one whose model list merely could not be read.
 *
 * A vendor supplies the read, the fallback and its logger; the rules stay
 * here. `tests/core.catalog.test.ts` pins all three.
 */

import { errorMessage, SignInExpiredError } from "./errors.ts"
import type { VendorLogger } from "./log.ts"
import type { ModelRecord } from "./types.ts"

export interface CatalogRead {
  /** The account's own catalog, or undefined when the read said nothing. */
  read(): Promise<ModelRecord | undefined>
  /** The table this package carries, already marked as its own. */
  fallback(): ModelRecord
  log: VendorLogger
}

export async function catalogModels(source: CatalogRead): Promise<ModelRecord | undefined> {
  try {
    const record = await source.read()
    // An empty record is as unhelpful as no record: the host would replace
    // the account's models with none.
    if (record === undefined || Object.keys(record).length === 0) return undefined
    return record
  } catch (error) {
    if (error instanceof SignInExpiredError) throw error
    await source.log.warn(`模型列表读取失败，回退到内置表：${errorMessage(error)}`)
    return source.fallback()
  }
}
