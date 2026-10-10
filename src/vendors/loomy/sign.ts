/**
 * xfyun's account request signature (HMAC-SHA1), a byte-for-byte port of the
 * Loomy client's `sign.js` as JetHub ported it (`src/loomy-sign.ts`).
 *
 * The string to sign is nine fields joined with newlines:
 *
 * ```
 * {METHOD}\n{ESCAPED_PATH}\n{ESCAPED_QUERY}\n{Content-MD5}\n
 * {Content-Type}\n{Date}\n{Nonce}\n{SignedHeaders}\n{CanonicalHeaders}
 * ```
 *
 * This package sends no `x-*` headers, so the last two are always empty and
 * the string ends with two newlines. The authenticator's scheme is
 * `account`, not `Bearer`: `Authorization: account {ak}:{sig}`.
 *
 * Every function here is pure — `date` and `nonce` are arguments — so the
 * tests can pin the exact string the service expects.
 */

import { createHash, createHmac, randomUUID } from "node:crypto"

export interface LoomySignInput {
  accessKeyId: string
  accessKeySecret: string
  method: string
  path: string
  query?: Record<string, string>
  /** The body **as serialized**: the same string that goes on the wire. */
  body?: string
  contentType?: string
}

/** `Content-MD5`, base64; the empty body's is the empty string, as the client has it. */
export function contentMd5(body: string): string {
  if (body.length === 0) return ""
  return createHash("md5").update(body, "utf8").digest("base64")
}

function escapeRfc3986(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A")
}

function escapedPath(raw: string): string {
  let path = raw.startsWith("/") ? raw : `/${raw}`
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1)
  return path
    .split("/")
    .map((segment) => (segment.length === 0 ? "" : escapeRfc3986(segment)))
    .join("/")
}

function escapedQuery(query: Record<string, string> | undefined): string {
  if (query === undefined) return ""
  const entries = Object.entries(query)
  if (entries.length === 0) return ""
  return entries.map(([key, value]) => `${escapeRfc3986(key)}=${escapeRfc3986(value)}`).join("&")
}

/** The nine fields, joined. Exported so a test can pin them. */
export function signingString(input: LoomySignInput & { date: string; nonce: string }): string {
  return [
    input.method.toUpperCase(),
    escapedPath(input.path),
    escapedQuery(input.query),
    contentMd5(input.body ?? ""),
    input.contentType ?? "application/json",
    input.date,
    input.nonce,
    "",
    "",
  ].join("\n")
}

/**
 * The headers for one account request.
 *
 * The returned `body` is not sent from here — the caller serializes the body
 * once and passes the same string to both this function and `fetch`, because
 * a second serialization (key order, spacing) changes the bytes and the
 * signature with them.
 */
export function signHeaders(
  input: LoomySignInput & { date?: string; nonce?: string },
): Record<string, string> {
  const date = input.date ?? new Date().toUTCString()
  const nonce = input.nonce ?? randomUUID()
  const contentType = input.contentType ?? "application/json"
  const body = input.body ?? ""
  const signature = createHmac("sha1", input.accessKeySecret)
    .update(signingString({ ...input, contentType, body, date, nonce }), "utf8")
    .digest("base64")
  const headers: Record<string, string> = {
    Authorization: `account ${input.accessKeyId}:${signature}`,
    Date: date,
    Nonce: nonce,
    "Content-Type": contentType,
  }
  const md5 = contentMd5(body)
  if (md5.length > 0) headers["Content-MD5"] = md5
  return headers
}
