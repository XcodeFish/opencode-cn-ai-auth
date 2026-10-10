/**
 * Refusing a request host-side, in the shape the host reads as "out of quota".
 *
 * A vendor whose credits are split into pools sometimes has to decline a
 * request **before** sending it: Loomy's permanent pool may be locked, and a
 * request that would spend it must not leave the process. magpie decides what
 * a plugin's failure means from the answer, not from the plugin's word
 * (`internal/gateway/routing.go`'s `failure()` matches the status and body),
 * so a refusal has to be shaped like the vendor's own out-of-quota answer.
 *
 * The shape, from that function's rules:
 *
 * - **429**, since a non-429 goes down other branches;
 * - the body naming the plan's allowance (`额度`, `quota`, `用量`… — its
 *   `usedUpWords`), which is what makes it `failQuota` rather than `failRate`;
 * - **no** balance or payment wording (`余额`, `请充值`, `credit`… —
 *   `creditWords`/`brokeWords`), which would take it to `failCredit` and
 *   rest the account for a flat half hour instead of until its window
 *   renews;
 * - no "too many requests"/"per minute" wording (`rateWords`), which would
 *   make it a rate limit.
 *
 * `failQuota` is what lets the host rest the account until the usage window
 * the plugin reported renews (`restAfter` → `c.full(now)` → `By: "window"`),
 * which is the point of refusing at all: a locked account should come back by
 * itself when the day's quota does. The rules were confirmed against the
 * 0.1.1137-class `failure()` with the wording used here (`docs/vendors.md`).
 */

import type { Fetcher } from "./http.ts"

/** HTTP status a refusal carries; see the module comment for why. */
export const QUOTA_REFUSAL_STATUS = 429

/**
 * A refusal, as the host reads one. `message` is shown to the user, so it is
 * Chinese, says what to do next, and carries no credential.
 */
export function quotaRefusal(message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "quota_exhausted" } }), {
    status: QUOTA_REFUSAL_STATUS,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

/**
 * A `fetch` that asks `refusal` before every request and declines when it
 * answers with a message. Asked per request, never once: the host caches a
 * loader's result until the sign-in changes, so a decision made in the loader
 * would outlive the reading behind it.
 */
export function gatedFetch(fetcher: Fetcher, refusal: () => string | undefined): Fetcher {
  const wrapped = async (input: Parameters<Fetcher>[0], init?: Parameters<Fetcher>[1]): Promise<Response> => {
    const message = refusal()
    return message === undefined ? fetcher(input, init) : quotaRefusal(message)
  }
  return wrapped as Fetcher
}
