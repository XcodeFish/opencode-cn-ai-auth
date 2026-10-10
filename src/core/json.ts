/**
 * Defensive readers for vendor payloads. A vendor's answer is unknown input:
 * these only accept the shape asked for, never coerce a number out of a
 * string that merely looks numeric unless the caller says so.
 */

export type JsonObject = Record<string, unknown>

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function asObject(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function trimmedStr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const out = value.trim()
  return out.length > 0 ? out : undefined
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** A number a vendor wrote as a string, e.g. `"1209600"`. */
export function numericStr(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || value.trim().length === 0) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function posInt(value: unknown): number | undefined {
  const parsed = numericStr(value)
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

/** A list of strings with empty entries dropped, in order, deduplicated. */
export function stringList(value: unknown): string[] {
  const list = asArray(value)
  if (!list) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    const s = trimmedStr(item)
    if (s === undefined || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}
