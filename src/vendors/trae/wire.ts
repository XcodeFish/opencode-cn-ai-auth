/**
 * The two rewrites that make Trae speak OpenAI.
 *
 * The host gives a loader a plain `fetch`, builds an OpenAI chat-completions
 * request, and parses whatever the fetch answers as OpenAI. Trae's SOLO
 * endpoint is not OpenAI on either side, so this module sits at that seam and
 * does both halves:
 *
 * - **out**: an OpenAI body becomes a SOLO body (`toSoloBody`). Only a
 *   whitelist of fields is carried over — the host adds OpenAI-only fields
 *   (`stream_options`, `parallel_tool_calls`…) that the upstream rejects, and
 *   the surest way not to send them is to build the body rather than patch it.
 * - **back**: the SOLO event stream becomes OpenAI chunks (`bridgeResponse`).
 *
 * Both are written against plain values (`Request`/`Response` in, `Response`
 * out) with no host types, so the same bytes will serve the OpenCode entry
 * when it is built.
 *
 * `docs/vendors.md` §3 records the transformation rules and where they came
 * from; the counter-intuitive ones carry a comment at the point they matter.
 */

import { asArray, isObject, num, str } from "../../core/json.ts"
import {
  OPENAI_DONE,
  openAiChunk,
  soloHeaders,
  type TraeCredential,
  type TraeEvent,
  takeEvents,
} from "./api.ts"
import {
  TRAE_AGENT_BASE,
  TRAE_CLIENT,
  TRAE_FALLBACK_CHANNEL,
  TRAE_FALLBACK_MODEL,
  TRAE_MAX_COMPLETION_TOKENS,
  TRAE_MAX_HISTORY_CHARS,
  TRAE_PATHS,
} from "./product.ts"

/** What a solved request needs to know about the model it is going to. */
export interface WireTarget {
  /** The model id the host named. */
  model: string
  /** The channel that lists this model; see `models.ts`'s `channelFor`. */
  channel: string
}

/**
 * The reader shape this module needs.
 *
 * Stated structurally rather than as `ReadableStreamDefaultReader<Uint8Array>`
 * because Bun's and undici's `Response.body` are declared differently, and
 * the only thing used here is `read()`.
 */
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
}

/**
 * An OpenAI chat-completions body as a SOLO one.
 *
 * The rules, in the order the upstream cares about them:
 *
 * - `stream` is always true — the endpoint only answers with the event
 *   stream; a caller that asked for a single JSON answer is served by
 *   aggregating the stream in `bridgeResponse`.
 * - `function` is the channel. Sending a model through a channel that does
 *   not list it is answered in-stream with `4001`, so this is not a default
 *   that can be chosen freely.
 * - `model` and `config_name` are both written; the upstream reads both.
 * - message `content` strings become `[{type:"text",text}]`. An array is left
 *   alone: the host already writes the multimodal shape the vendor wants.
 * - an assistant's `tool_calls[].function` becomes `function_call` (the SOLO
 *   spelling). A call without a usable name is dropped, because the upstream
 *   requires the name.
 * - `tools[].function.parameters` is **serialized to a string**. The vendor
 *   wants a string where OpenAI wants an object; leaving it an object is
 *   refused by the upstream with an error that does not point here.
 * - history over `TRAE_MAX_HISTORY_CHARS` is trimmed from the oldest round,
 *   never dropping a system message and never splitting a tool call from its
 *   result.
 */
export function toSoloBody(body: Record<string, unknown>, target: WireTarget): Record<string, unknown> {
  const out: Record<string, unknown> = {
    function: target.channel.length > 0 ? target.channel : TRAE_FALLBACK_CHANNEL,
    model: normalizeModel(target.model),
    config_name: normalizeModel(target.model),
    stream: true,
  }

  const messages = trimHistory(soloMessages(body.messages))
  if (messages.length > 0) out.messages = messages

  const tools = soloTools(body.tools)
  const choice = soloToolChoice(body.tool_choice)
  if (choice.dropped) {
    // `tool_choice: "none"` means both the choice and the tools go away.
  } else {
    if (tools !== undefined) out.tools = tools
    if (choice.value !== undefined) out.tool_choice = choice.value
  }

  const temperature = num(body.temperature)
  if (temperature !== undefined) out.temperature = temperature
  const topP = num(body.top_p)
  if (topP !== undefined) out.top_p = topP
  const stop = body.stop
  if (Array.isArray(stop) && stop.length > 0) out.stop = stop
  else if (typeof stop === "string" && stop.length > 0) out.stop = stop

  const maxTokens = clampMaxTokens(num(body.max_tokens) ?? num(body.max_completion_tokens))
  if (maxTokens !== undefined) out.max_tokens = maxTokens

  // The host passes the tier it chose; the value is the vendor's own word for
  // it, taken from the catalog, so it is forwarded unwrapped rather than
  // translated through a table that would go stale.
  const effort = str(body.reasoning_effort)
  if (effort !== undefined) out.reasoning_effort = effort

  return out
}

/** `__dev` suffix removal; the upstream keys its catalog by the bare name. */
function normalizeModel(model: string): string {
  const bare = model.includes("__") ? (model.split("__")[0] ?? model) : model
  return bare.length > 0 ? bare : TRAE_FALLBACK_MODEL
}

/** The cap described on `TRAE_MAX_COMPLETION_TOKENS`; non-positive values pass through. */
function clampMaxTokens(value: number | undefined): number | undefined {
  if (value === undefined || value <= 0) return value
  return Math.min(value, TRAE_MAX_COMPLETION_TOKENS)
}

/**
 * Messages in the SOLO shape.
 *
 * `content` arrives as a string in the common case and as an array when the
 * host attached an image; only the string case is rewritten.
 */
function soloMessages(messages: unknown): Array<Record<string, unknown>> {
  const list = asArray(messages)
  if (list === undefined) return []
  const out: Array<Record<string, unknown>> = []
  for (const item of list) {
    if (!isObject(item)) continue
    const message: Record<string, unknown> = { ...item }
    if (typeof message.content === "string") {
      message.content = [{ type: "text", text: message.content }]
    }
    if (message.role === "assistant") {
      const calls = soloToolCalls(message.tool_calls)
      if (calls === undefined) delete message.tool_calls
      else message.tool_calls = calls
    }
    out.push(message)
  }
  return out
}

/** `function` → `function_call`, dropping calls the upstream would reject. */
function soloToolCalls(calls: unknown): unknown[] | undefined {
  const list = asArray(calls)
  if (list === undefined) return undefined
  const kept: unknown[] = []
  for (const call of list) {
    if (!isObject(call)) continue
    const next: Record<string, unknown> = { ...call }
    if (isObject(next.function)) {
      next.function_call = next.function
      delete next.function
    }
    const fn = next.function_call
    if (!isObject(fn)) continue
    const name = str(fn.name)
    if (name === undefined || name.trim().length === 0) continue
    kept.push(next)
  }
  return kept.length > 0 ? kept : undefined
}

/** Tool definitions with `parameters` serialized to the string the upstream wants. */
function soloTools(tools: unknown): unknown[] | undefined {
  const list = asArray(tools)
  if (list === undefined) return undefined
  const out: unknown[] = []
  for (const item of list) {
    if (!isObject(item)) continue
    const tool: Record<string, unknown> = { ...item }
    if (isObject(tool.function)) {
      const fn: Record<string, unknown> = { ...tool.function }
      if (isObject(fn.parameters)) fn.parameters = JSON.stringify(fn.parameters)
      tool.function = fn
    }
    out.push(tool)
  }
  return out.length > 0 ? out : undefined
}

/**
 * `tool_choice` in the shape the upstream takes.
 *
 * `"none"` is not a value it understands; it is expressed by sending neither
 * `tool_choice` nor `tools`, which is why the caller needs `dropped`.
 */
function soloToolChoice(choice: unknown): { value?: unknown; dropped: boolean } {
  if (choice === undefined || choice === null) return { dropped: false }
  if (typeof choice === "string") {
    return choice.trim().toLowerCase() === "none" ? { dropped: true } : { dropped: false }
  }
  if (!isObject(choice)) return { dropped: true }
  const type = (str(choice.type) ?? "").toLowerCase().trim()
  if (type === "none") return { dropped: true }
  if (type === "auto" || type === "required") return { value: type, dropped: false }
  if (type === "function") {
    const fn = isObject(choice.function) ? choice.function : undefined
    const name = (fn === undefined ? undefined : str(fn.name)) ?? str(choice.name)
    return { value: name === undefined ? "auto" : name.trim(), dropped: false }
  }
  return { value: "auto", dropped: false }
}

/**
 * Drop the oldest conversation rounds until the request fits.
 *
 * The upstream stops answering, without an error, somewhere around 480K
 * characters of history, so the trim is on characters rather than tokens —
 * a token estimate would be a guess, and the failure mode of guessing low is
 * the silent one. Rounds are dropped whole (an assistant's tool calls travel
 * with the results that answer them) and system messages are never dropped.
 */
function trimHistory(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const size = (message: Record<string, unknown>): number => JSON.stringify(message).length
  let total = messages.reduce((sum, message) => sum + size(message), 0)
  if (total <= TRAE_MAX_HISTORY_CHARS) return messages

  const drop = new Set<number>()
  let index = 0
  while (index < messages.length && total > TRAE_MAX_HISTORY_CHARS) {
    const current = messages[index]
    if (current === undefined) break
    if (current.role === "system") {
      index += 1
      continue
    }
    const start = index
    let end = index + 1
    if ((asArray(current.tool_calls)?.length ?? 0) > 0) {
      while (end < messages.length && messages[end]?.role === "tool") end += 1
    }
    for (let cursor = start; cursor < end; cursor += 1) {
      const message = messages[cursor]
      if (message === undefined) continue
      drop.add(cursor)
      total -= size(message)
    }
    index = end
  }
  // Still over budget with every non-system round gone (one huge system
  // prompt): stop rather than keep deleting, which would only produce an
  // empty request that fails less legibly.
  return messages.filter((_, position) => !drop.has(position))
}

// ── SOLO SSE → OpenAI ────────────────────────────────────────────────────────

/**
 * The response the host reads: OpenAI chunks for a streaming request, one
 * aggregated completion for a non-streaming one.
 *
 * The upstream is always streamed, so a request that asked for a single
 * answer is buffered here and answered with `application/json`. Everything
 * that is not a successful SSE (a 401, a 5xx, a JSON error) is handed back
 * untouched: the host reads HTTP status on the chat path, and a 401 is how it
 * learns the account needs a new sign-in.
 */
export async function bridgeResponse(
  upstream: Response,
  options: { model: string; streamed: boolean; onError?: (message: string) => void },
): Promise<Response> {
  if (!upstream.ok || upstream.body === null) return upstream
  const contentType = upstream.headers.get("content-type") ?? ""
  // A non-SSE 200 is a JSON error envelope from a proxy; it is already an
  // OpenAI-shaped error more often than not, so it is passed through.
  if (!contentType.includes("text/event-stream")) return upstream

  const id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`
  const reader = upstream.body.getReader()

  if (!options.streamed) {
    const aggregated = await aggregate(reader, options.model)
    return jsonResponse(aggregated)
  }

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = ""
      let finished = false
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const { events, rest } = takeEvents(buffer)
          buffer = rest
          for (const event of events) {
            const chunk = chunkFor(id, options.model, event, options.onError)
            if (chunk !== undefined) controller.enqueue(encoder.encode(chunk))
            if (event.event === "done" || event.event === "error") finished = true
          }
        }
        // The upstream may end the stream without a `done` event; the host
        // still needs a terminator or it waits forever.
        if (!finished) {
          controller.enqueue(encoder.encode(openAiChunk(id, options.model, {}, "stop")))
        }
        controller.enqueue(encoder.encode(OPENAI_DONE))
        controller.close()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        options.onError?.(message)
        // An errored controller must not also be closed: `close()` after
        // `error()` throws, which would replace the real cause with a
        // "Invalid state" Typeerror and reject this stream's start promise
        // for no reason. The stream is already failed at this point.
        controller.error(error)
      }
    },
    cancel(reason) {
      void reader.cancel(reason)
    },
  })

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  })
}

/** The OpenAI chunk one SOLO event turns into, or undefined when it says nothing. */
function chunkFor(
  id: string,
  model: string,
  event: TraeEvent,
  onError: ((message: string) => void) | undefined,
): string | undefined {
  switch (event.event) {
    case "output": {
      const delta: Record<string, unknown> = {}
      if (event.content !== undefined && event.content.length > 0) delta.content = event.content
      // Reasoning is reported the way OpenAI-compatible clients read it; the
      // vendor calls the same thing `reasoning_content`.
      if (event.reasoning !== undefined && event.reasoning.length > 0) {
        delta.reasoning_content = event.reasoning
      }
      if (event.toolCalls !== undefined && event.toolCalls.length > 0) {
        delta.tool_calls = event.toolCalls.map(toolCallDelta)
      }
      return Object.keys(delta).length === 0 ? undefined : openAiChunk(id, model, delta)
    }
    case "token_usage":
      return event.usage === undefined
        ? undefined
        : openAiChunk(id, model, {}, undefined, usageOf(event.usage))
    case "done":
      return openAiChunk(id, model, {}, event.finishReason ?? "stop")
    case "error": {
      const code = event.errorCode ?? -1
      const message = event.errorMessage ?? "unknown error"
      onError?.(`TRAE 上游错误 code=${code}：${message}`)
      // A stream that has already sent its 200 cannot become an HTTP error,
      // so the failure travels as an error object on the stream; the host
      // surfaces the message rather than a truncated answer.
      return `data: ${JSON.stringify({ error: { message: `TRAE: ${message}`, code, type: "upstream_error" } })}\n\n`
    }
    default:
      // `metadata` / `timing_cost` / `extra_info` carry no text the host needs.
      return undefined
  }
}

/** Normalize one tool-call delta into the OpenAI shape. */
function toolCallDelta(call: unknown, position: number): Record<string, unknown> {
  if (!isObject(call)) return { index: position }
  const fn = isObject(call.function) ? call.function : undefined
  const index = num(call.index)
  return {
    index: index === undefined ? position : index,
    ...(str(call.id) === undefined ? {} : { id: str(call.id) }),
    type: "function",
    ...(fn === undefined
      ? {}
      : {
          function: {
            ...(str(fn.name) === undefined ? {} : { name: str(fn.name) }),
            ...(str(fn.arguments) === undefined ? {} : { arguments: str(fn.arguments) }),
          },
        }),
  }
}

/** OpenAI's usage field names, from the vendor's. */
function usageOf(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(num(usage.prompt_tokens) === undefined ? {} : { prompt_tokens: num(usage.prompt_tokens) }),
    ...(num(usage.completion_tokens) === undefined
      ? {}
      : { completion_tokens: num(usage.completion_tokens) }),
    ...(num(usage.total_tokens) === undefined ? {} : { total_tokens: num(usage.total_tokens) }),
  }
}

/**
 * Read the whole stream into one OpenAI completion.
 *
 * This is what a host that asked for `stream: false` gets. The upstream has
 * no non-streaming mode, so the value is assembled here; the parts the host
 * would have assembled itself from chunks (the text, the tool calls, the
 * finish reason) are the ones carried over.
 */
async function aggregate(reader: ByteReader, model: string): Promise<Record<string, unknown>> {
  const acc = new Accumulator()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const { events, rest } = takeEvents(buffer)
    buffer = rest
    for (const event of events) acc.accept(event)
  }
  return acc.completion(model)
}

/**
 * The parts of a streamed answer, as they are collected.
 *
 * Tool calls arrive in fragments that have to be joined by their index, and
 * the text and the reasoning are concatenated in arrival order. An `error`
 * event ends the answer: the stream has already sent its 200, so the failure
 * can only surface as a thrown error here or as an error object on the
 * streaming path.
 */
class Accumulator {
  private content = ""
  private reasoning = ""
  private finishReason = "stop"
  private usage: Record<string, unknown> | undefined
  private failure: { code: number; message: string } | undefined
  private readonly toolCalls = new Map<number, { id?: string; name: string; arguments: string }>()

  accept(event: TraeEvent): void {
    switch (event.event) {
      case "output":
        this.acceptOutput(event)
        return
      case "token_usage":
        this.usage = event.usage
        return
      case "done":
        this.finishReason = event.finishReason ?? this.finishReason
        return
      case "error":
        this.failure = { code: event.errorCode ?? -1, message: event.errorMessage ?? "unknown error" }
        return
      default:
        return
    }
  }

  completion(model: string): Record<string, unknown> {
    if (this.failure !== undefined) {
      throw new Error(`TRAE 上游错误 code=${this.failure.code}：${this.failure.message}`)
    }
    const message: Record<string, unknown> = { role: "assistant", content: this.content }
    if (this.reasoning.length > 0) message.reasoning_content = this.reasoning
    if (this.toolCalls.size > 0) message.tool_calls = this.toolCallList()
    const completion: Record<string, unknown> = {
      id: `chatcmpl-${Math.random().toString(36).slice(2, 12)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: this.finishReason }],
    }
    if (this.usage !== undefined) completion.usage = usageOf(this.usage)
    return completion
  }

  private acceptOutput(event: TraeEvent): void {
    if (event.content !== undefined) this.content += event.content
    if (event.reasoning !== undefined) this.reasoning += event.reasoning
    for (const [position, call] of (event.toolCalls ?? []).entries()) {
      if (!isObject(call)) continue
      const fn = isObject(call.function) ? call.function : undefined
      const index = num(call.index) ?? position
      const slot = this.toolCalls.get(index) ?? { name: "", arguments: "" }
      const id = str(call.id)
      if (id !== undefined) slot.id = id
      const name = fn === undefined ? undefined : str(fn.name)
      if (name !== undefined) slot.name += name
      const fragment = fn === undefined ? undefined : str(fn.arguments)
      if (fragment !== undefined) slot.arguments += fragment
      this.toolCalls.set(index, slot)
    }
  }

  private toolCallList(): unknown[] {
    return [...this.toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, slot]) => ({
        index,
        ...(slot.id === undefined ? {} : { id: slot.id }),
        type: "function",
        function: { name: slot.name, arguments: slot.arguments },
      }))
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

// ── the chat bridge ──────────────────────────────────────────────────────────

/**
 * What `chatFetch` needs from the vendor around it.
 *
 * Every dependency is passed in — including the upstream `fetcher` — so the
 * bridge can be driven end to end by a test without touching the global
 * `fetch`, and so the OpenCode entry can hand it a different one.
 */
export interface ChatFetchDeps {
  /** The network implementation the rewritten request goes out through. */
  fetcher: typeof fetch
  /** The credential at the time of the request, not when the loader ran. */
  credentialNow: () => Promise<TraeCredential | undefined>
  /** The channel for a model, falling back when no catalog has been read yet. */
  channelFor: (model: string) => string
  /** Whether the current catalog names this model (and so knows its channel). */
  catalogHas: (model: string) => boolean
  /** Whether a catalog read has already succeeded for this vendor instance. */
  catalogLoaded: () => boolean
  /** Reads the catalog once, for a chat that arrives before any model list did. */
  ensureCatalog: (credential: TraeCredential) => Promise<void>
  logWarn: (message: string) => Promise<void>
}

/**
 * The `fetch` a chat request runs through.
 *
 * It is where the two rewrites meet: the host's URL is redirected to the SOLO
 * endpoint, its body and headers are rebuilt (`toSoloBody`), and the answer is
 * turned back into OpenAI chunks (`bridgeResponse`).
 *
 * Nothing is captured by value except the dependencies: the credential is
 * read per request, because the host caches a loader result across a renewal
 * and a request that ran on the previous token would be refused.
 */
export function chatFetch(deps: ChatFetchDeps): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    // A `Request` carries its own body and headers; both are honoured so this
    // works whichever shape the host hands over.
    const request = input instanceof Request ? input : undefined
    const body = await readJsonBody(init, request)
    if (body === undefined) return deps.fetcher(input, init)
    const credential = await deps.credentialNow()
    if (credential === undefined) {
      return new Response(
        JSON.stringify({ error: { message: "TRAE：账号里没有登录态，请重新登录", type: "auth_error" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      )
    }
    const model = typeof body.model === "string" ? body.model : ""
    // A chat can arrive before the host has ever asked for the model list —
    // then the channel table is empty and every request would fall through to
    // the default channel, which the upstream answers with `4001` for the
    // models the default does not serve.
    //
    // The read is guarded by `catalogLoaded`, not by this model's absence: a
    // model the account's catalog simply does not list (retired, hidden, an
    // unpublished fallback row) would otherwise re-read the catalog on every
    // single request, adding a round trip to every message.
    if (model.length > 0 && !deps.catalogHas(model) && !deps.catalogLoaded()) {
      await deps.ensureCatalog(credential).catch(() => undefined)
    }
    const headers = new Headers(request?.headers ?? init?.headers)
    // The host writes its own bearer auth; this vendor's is a different scheme
    // on the same header, so the host's value is replaced, not kept.
    headers.delete("authorization")
    // The body is replaced below, so the length the host computed no longer
    // describes what goes out.
    headers.delete("content-length")
    for (const [name, value] of Object.entries(soloHeaders(credential, TRAE_CLIENT, true))) {
      headers.set(name, value)
    }
    // The method and the abort signal live on whichever shape carried them:
    // an init for `fetch(url, init)`, the request itself for `fetch(request)`.
    // Defaulting to GET here would make the rewritten call illegal — a GET
    // with a body is refused — so both shapes are read.
    const upstream = await deps.fetcher(chatEndpointOf(input), {
      ...init,
      method: init?.method ?? request?.method ?? "POST",
      headers,
      body: JSON.stringify(toSoloBody(body, { model, channel: deps.channelFor(model) })),
      ...(init?.signal === undefined && request?.signal !== undefined ? { signal: request.signal } : {}),
    })
    try {
      return await bridgeResponse(upstream, {
        model,
        streamed: body.stream !== false,
        onError: (message) => {
          void deps.logWarn(message)
        },
      })
    } catch (error) {
      // The non-streaming path reads the whole stream before answering, so an
      // upstream error event arrives here as an exception. A failed request is
      // reported as a response rather than thrown out of `fetch`.
      const message = error instanceof Error ? error.message : String(error)
      return new Response(
        JSON.stringify({ error: { message: `TRAE: ${message}`, type: "upstream_error" } }),
        {
          status: 502,
          headers: { "content-type": "application/json" },
        },
      )
    }
  }
  return wrapped as typeof fetch
}

/**
 * The SOLO endpoint for the URL the host built.
 *
 * The host appends `/chat/completions` to the provider's base URL; this vendor
 * serves chat at a different path on the same origin, so the path is replaced
 * rather than extended.
 */
function chatEndpointOf(input: Parameters<typeof fetch>[0]): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  try {
    return `${new URL(url).origin}${TRAE_PATHS.chat}`
  } catch {
    return `${TRAE_AGENT_BASE}${TRAE_PATHS.chat}`
  }
}

/**
 * The JSON body of a request, when it has one.
 *
 * The body lives on the init for a `fetch(url, init)` call and on the request
 * itself for a `Request`; either shape may carry it, so both are read. A body
 * that is not readable text (a stream) is left alone — the caller then passes
 * the request through untouched.
 */
async function readJsonBody(
  init: RequestInit | undefined,
  request: Request | undefined,
): Promise<Record<string, unknown> | undefined> {
  const raw = init?.body ?? (request === undefined ? undefined : await request.clone().text())
  if (raw === undefined || raw === null) return undefined
  const text =
    typeof raw === "string"
      ? raw
      : raw instanceof Uint8Array
        ? new TextDecoder().decode(raw)
        : raw instanceof ArrayBuffer
          ? new TextDecoder().decode(new Uint8Array(raw))
          : undefined
  if (text === undefined || text.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}
