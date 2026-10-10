/**
 * 入口契约自检：按 magpie 的方式加载根 index.ts，把每个导出都当作插件工厂调用一次，
 * 校验 auth / config / provider 三条 hook 的形状。只加载、只调用，绝不发真实网络请求，
 * 任何失败都以 ✗ 打印并让进程以 1 退出。
 * 「没有账号时 loader 应报错」刻意只提示不失败：某家厂商将来若合法地不需要账号，
 * 自检不该变成假阳性（设 CHECK_ALLOW_ANONYMOUS_LOADER=1 静音），假阳性比漏报更伤可信度。
 *
 * 同时校验 `docs/architecture.md` §2 的依赖方向（core 不依赖厂商、厂商之间不依赖）：
 * 那条规则本来只靠评审，做成门禁后新厂商抄错 import 会在提交前就红。
 */

import { readdir, readFile } from "node:fs/promises"
import { dirname, join, posix, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ENTRY = new URL("../index.ts", import.meta.url)

/** 仓库根，用来把依赖检查的路径写成相对形式。 */
const ROOT = dirname(fileURLToPath(ENTRY))

/** 无账号时 loader 最长等多久；超时与返回结果一样，只提示不失败。 */
const LOADER_TIMEOUT_MS = 5_000

/** 宽松开关：置 1 表示「本包的厂商可以没有账号也返回 loader」，不再打印提示。 */
const ALLOW_ANONYMOUS_LOADER = process.env.CHECK_ALLOW_ANONYMOUS_LOADER === "1"

type AnyFunction = (...args: unknown[]) => unknown

interface Inspection {
  /** undefined 表示 auth.provider 不合法，报告里就不写括号。 */
  provider: string | undefined
  problems: string[]
  warnings: string[]
}

interface FactoryEntry {
  /** 函数自身的 name —— host 的日志里就是它。 */
  name: string
  /** 在入口模块里的导出名；与 name 不同时报告里两个都写，才认得出是哪一个。 */
  exportedAs: string
  factory: AnyFunction
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asFunction(value: unknown): AnyFunction | undefined {
  return typeof value === "function" ? (value as AnyFunction) : undefined
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isHttpUrl(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false
  try {
    return ["http:", "https:"].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function describe(value: unknown): string {
  if (typeof value === "string") return value.length === 0 ? "空字符串" : `"${value.slice(0, 60)}"`
  if (value === null) return "null"
  if (Array.isArray(value)) return `数组（${value.length} 项）`
  if (typeof value === "object") return "对象"
  if (typeof value === "function") return "函数"
  return String(value)
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return JSON.stringify(error) ?? String(error)
}

function entryPath(): string {
  try {
    return decodeURIComponent(ENTRY.pathname)
  } catch {
    return ENTRY.href
  }
}

/**
 * magpie 的 host 给工厂的 input：client 加工作目录。这里刻意不给 `$` 与
 * `experimental_workspace` —— provider 工厂不该用它们，真要用时先改这个 fake。
 */
function fakeInput(): Record<string, unknown> {
  const directory = process.cwd()
  return {
    client: {
      auth: { set: async () => ({}), remove: async () => ({}) },
      app: { log: async () => ({}) },
      tui: { showToast: async () => ({}) },
      config: { get: async () => ({ data: {} }) },
    },
    project: { id: "magpie", worktree: directory },
    directory,
    worktree: directory,
    serverUrl: new URL("http://127.0.0.1:4096"),
  }
}

function checkMethods(methods: unknown, problems: string[]): void {
  if (!Array.isArray(methods) || methods.length === 0) {
    problems.push("auth.methods 必须是非空数组")
    return
  }
  methods.forEach((method, index) => {
    const where = `auth.methods[${index}]`
    if (!isObject(method)) {
      problems.push(`${where} 必须是对象（收到 ${describe(method)}）`)
      return
    }
    if (method.type === "oauth") {
      if (typeof method.authorize !== "function") problems.push(`${where}（oauth）必须有 authorize 函数`)
      return
    }
    if (method.type === "api") {
      const hasAuthorize = typeof method.authorize === "function"
      const hasPrompts = Array.isArray(method.prompts) && method.prompts.length > 0
      if (!hasAuthorize && !hasPrompts) problems.push(`${where}（api）必须有 authorize 函数或非空 prompts`)
      return
    }
    problems.push(`${where}.type 必须是 "oauth" 或 "api"（收到 ${describe(method.type)}）`)
  })
}

/**
 * `auth.icon` 的宿主规则，做成门禁：host 的 `iconOf` 只保留 `https://` 开头的
 * 网址或 `data:image/` 开头的 data URI，**其余一律静默丢弃**（`host.js` 的
 * `iconOf` 返回 ""，再退回插件市场的图标）。裸图标名（`spark-color`）正是最
 * 容易写错的一种：它看起来像内置图标名，宿主却根本不认，而失败是无声的——
 * 界面上只是没有图标，没有任何报错，所以这条规则不能只写在文档里。
 *
 * 长度上限是 host.js 自己的 `3 << 19`（1.5M 字符，超限同样丢弃）。图片**本身**
 * 另有 1 MB 字节上限（`internal/provider/icon.go` 的 `MaxIcon = 1 << 20`，取回与
 * 存储都在那里拦），那是字节数，这里只看字符串长度，不重复判它。
 *
 * 已实测（magpie 0.1.1137，2026-10-09）：`auth.icon` 写 `spark-color` 时
 * `plugin --json` 的该 provider 没有 `icon` 字段；同一位置写 https 网址则有。
 */
function checkIcon(icon: unknown, problems: string[]): void {
  if (icon === undefined) return
  if (!isNonEmptyString(icon)) {
    problems.push(`auth.icon 存在时必须是 data:image/ 或 https:// 开头的字符串（收到 ${describe(icon)}）`)
    return
  }
  const value = icon.trim()
  if (!/^(https:\/\/|data:image\/)/i.test(value)) {
    problems.push(
      `auth.icon 必须是 https:// 或 data:image/ 开头（收到 ${describe(value)}）：` +
        "宿主会静默丢弃其他写法，裸图标名要用插件市场的 registry 条目",
    )
    return
  }
  if (value.length > 3 << 19) {
    problems.push(`auth.icon 超过宿主 1.5M 字符上限（${value.length} 字符），会被静默丢弃`)
  }
}

function checkAuth(auth: unknown, problems: string[]): { provider: string | undefined; loader: unknown } {
  if (!isObject(auth)) {
    problems.push("缺少 auth hook（host 要读 auth.provider / auth.loader / auth.methods）")
    return { provider: undefined, loader: undefined }
  }
  if (!isNonEmptyString(auth.provider)) problems.push("auth.provider 必须是非空字符串")
  if (typeof auth.loader !== "function") problems.push("auth.loader 必须是函数")
  checkMethods(auth.methods, problems)
  checkIcon(auth.icon, problems)

  for (const key of ["usage", "checkin", "refresh"]) {
    const hook = auth[key]
    if (hook !== undefined && typeof hook !== "function") {
      problems.push(`auth.${key} 存在时必须是函数（收到 ${describe(hook)}）`)
    }
  }
  const lead = auth.refreshLead
  if (lead !== undefined && !(typeof lead === "number" && Number.isFinite(lead) && lead > 0)) {
    problems.push(`auth.refreshLead 必须是大于 0 的数字（收到 ${describe(lead)}）`)
  }
  return { provider: isNonEmptyString(auth.provider) ? auth.provider : undefined, loader: auth.loader }
}

async function checkConfig(hook: unknown, provider: string, problems: string[]): Promise<void> {
  const call = asFunction(hook)
  if (call === undefined) {
    problems.push(`config 存在时必须是函数（收到 ${describe(hook)}）`)
    return
  }
  const config: Record<string, unknown> = { provider: {} }
  await call(config)
  const entry = isObject(config.provider) ? config.provider[provider] : undefined
  if (!isObject(entry)) {
    problems.push(`config() 之后 config.provider["${provider}"] 必须是对象`)
    return
  }
  if (!isNonEmptyString(entry.npm)) problems.push(`config.provider["${provider}"].npm 必须是非空字符串`)
  if (!isObject(entry.models) || Object.keys(entry.models).length === 0) {
    problems.push(`config.provider["${provider}"].models 必须是非空对象`)
  }
  if (!isHttpUrl(entry.api)) {
    problems.push(`config.provider["${provider}"].api 必须是 http(s) URL（收到 ${describe(entry.api)}）`)
  }
}

function checkProviderHook(hook: unknown, provider: string | undefined, problems: string[]): void {
  if (!isObject(hook)) {
    problems.push(`provider 存在时必须是对象（收到 ${describe(hook)}）`)
    return
  }
  if (provider !== undefined && hook.id !== provider) {
    problems.push(`provider.id（${describe(hook.id)}）必须等于 auth.provider（"${provider}"）`)
  }
  if (typeof hook.models !== "function") problems.push("provider.models 必须是函数")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 没有账号（getAuth 恒为 undefined）时调一次 loader：抛错是期望，报「需要重新登录」；
 * 返回了结果只当提示，见文件顶部。超时同样只提示 —— 卡住的 loader 也不该让自检变红。
 */
async function checkAnonymousLoader(loader: unknown, provider: string, warnings: string[]): Promise<void> {
  const call = asFunction(loader)
  if (call === undefined) return

  const started = Promise.resolve().then(() => call(async () => undefined, { id: provider, models: {} }))
  void started.catch(() => undefined)

  const outcome = await Promise.race([
    started.then(
      (value: unknown) => ({ kind: "returned" as const, value }),
      () => ({ kind: "threw" as const }),
    ),
    sleep(LOADER_TIMEOUT_MS).then(() => ({ kind: "timeout" as const })),
  ])
  if (outcome.kind === "threw" || ALLOW_ANONYMOUS_LOADER) return
  warnings.push(
    outcome.kind === "timeout"
      ? `无账号时 loader 在 ${LOADER_TIMEOUT_MS}ms 内没有抛错（预期报「需要重新登录」）`
      : `无账号时 loader 没有抛错，而是返回了 ${describe(outcome.value)}（预期报「需要重新登录」）`,
  )
}

async function inspect(factory: AnyFunction, input: Record<string, unknown>): Promise<Inspection> {
  const problems: string[] = []
  const warnings: string[] = []
  let provider: string | undefined
  try {
    const hooks = await factory(input)
    if (!isObject(hooks)) {
      problems.push(`工厂必须返回 hooks 对象（收到 ${describe(hooks)}）`)
      return { provider, problems, warnings }
    }
    const auth = checkAuth(hooks.auth, problems)
    provider = auth.provider
    if (provider !== undefined && hooks.config !== undefined)
      await checkConfig(hooks.config, provider, problems)
    if (hooks.provider !== undefined) checkProviderHook(hooks.provider, provider, problems)
    if (provider !== undefined) await checkAnonymousLoader(auth.loader, provider, warnings)
  } catch (error) {
    problems.push(`调用工厂时抛错：${messageOf(error)}`)
  }
  return { provider, problems, warnings }
}

function pluginLabel(entry: FactoryEntry): string {
  return entry.name === entry.exportedAs ? entry.name : `${entry.name}（导出 ${entry.exportedAs}）`
}

function report(entry: FactoryEntry, result: Inspection): void {
  const label = pluginLabel(entry)
  const suffix = result.provider === undefined ? "" : ` (${result.provider})`
  if (result.problems.length === 0) {
    console.log(`✓ ${label}${suffix}`)
  } else {
    console.log(`✗ ${label}${suffix}`)
    for (const problem of result.problems) console.log(`  - ${problem}`)
  }
  for (const warning of result.warnings) console.log(`! ${label}: ${warning}`)
}

/** 导出名后缀：`LoomyAuthPlugin`、`RaccoonAuthPlugin`，一个 provider 一个。 */
const FACTORY_SUFFIX = "AuthPlugin"

function collectFactories(mod: Record<string, unknown>): {
  factories: FactoryEntry[]
  leaked: string[]
  misnamed: string[]
} {
  const factories: FactoryEntry[] = []
  const leaked: string[] = []
  const misnamed: string[] = []
  const seen = new Set<unknown>()
  for (const [exportName, value] of Object.entries(mod)) {
    const factory = asFunction(value)
    if (factory === undefined) {
      leaked.push(exportName)
      continue
    }
    // magpie 的 servers() 按函数身份去重，同一个函数导出两次只调用一次。
    if (seen.has(value)) continue
    seen.add(value)
    const declared = (value as { name?: string }).name
    if (!exportName.endsWith(FACTORY_SUFFIX)) misnamed.push(exportName)
    factories.push({
      name: isNonEmptyString(declared) ? declared : exportName,
      exportedAs: exportName,
      factory,
    })
  }
  return { factories, leaked, misnamed }
}

/** 递归收集一个目录下的 .ts 文件，返回相对仓库根的路径。 */
async function tsFilesUnder(relativeDir: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.name.endsWith(".ts")) {
        found.push(relative(ROOT, full).split(sep).join("/"))
      }
    }
  }
  await walk(join(ROOT, relativeDir))
  return found
}

/**
 * `docs/architecture.md` §2 的依赖方向，作为门禁：
 *
 * - `src/core/**` 不得 import `src/vendors/**`（基座不知道厂商存在）；
 * - 一个厂商不得 import 另一个厂商（共用能力下沉到 core，不横向复用）。
 *
 * 规则理由在架构文档里；这里只做机械校验，避免它退化成一句评审口号。
 */
async function checkLayout(): Promise<string[]> {
  const problems: string[] = []
  const importers = ["index.ts", ...(await tsFilesUnder("src")), ...(await tsFilesUnder("opencode"))]
  for (const file of importers) {
    const source = await readFile(join(ROOT, file), "utf8")
    for (const match of source.matchAll(/^\s*(?:import|export)\b[^\n]*?from\s+["']([^"']+)["']/gm)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      // 相对导入按发起文件所在目录解析成仓库内路径，再判它落在谁的目录下；
      // 这样 `../../core/x.ts` 与 `src/core/x.ts` 是同一条判断。
      const resolved = specifier.startsWith(".")
        ? posix.normalize(posix.join(posix.dirname(file), specifier))
        : specifier
      if (file.startsWith("src/core/") && resolved.startsWith("src/vendors/")) {
        problems.push(`${file} 不得 import 厂商模块（${specifier}）：core 是基座，不知道厂商存在`)
        continue
      }
      const owner = /^src\/vendors\/([^/]+)\//.exec(file)?.[1]
      const target = /^src\/vendors\/([^/]+)\//.exec(resolved)?.[1]
      if (owner !== undefined && target !== undefined && target !== owner) {
        problems.push(`${file} 不得 import 另一家厂商（${specifier}）：共用能力下沉到 src/core`)
      }
    }
  }
  return problems
}

async function main(): Promise<number> {
  const layoutProblems = await checkLayout()
  for (const problem of layoutProblems) console.log(`✗ 依赖方向：${problem}`)

  let mod: Record<string, unknown>
  try {
    mod = (await import(ENTRY.href)) as Record<string, unknown>
  } catch (error) {
    console.log(`✗ 入口模块 ${entryPath()} 导入失败：${messageOf(error)}`)
    console.log("✗ 汇总：入口模块不可加载，插件 0 个，失败 1 个")
    return 1
  }

  const moduleProblems: string[] = []
  const { factories, leaked, misnamed } = collectFactories(mod)
  if (factories.length === 0) moduleProblems.push("没有导出插件工厂函数")
  if (leaked.length > 0) {
    // host 也接受 { server } 对象与带 server 的 default 导出，本包约定不写这两种。
    moduleProblems.push(`导出了非函数值：${leaked.join("、")}（对象与常量不该被 host 当工厂调用）`)
  }
  if (misnamed.length > 0) {
    // 名字是给人看的：日志、报错与文档都按导出名索引。
    moduleProblems.push(`导出名必须以 AuthPlugin 结尾：${misnamed.join("、")}（<Vendor>AuthPlugin）`)
  }
  for (const problem of moduleProblems) console.log(`✗ 入口模块：${problem}`)

  const input = fakeInput()
  let failed = 0
  let warnings = 0
  for (const entry of factories) {
    const result = await inspect(entry.factory, input)
    report(entry, result)
    if (result.problems.length > 0) failed += 1
    warnings += result.warnings.length
  }

  const ok = failed === 0 && moduleProblems.length === 0 && layoutProblems.length === 0
  const entryNote = moduleProblems.length === 0 ? "" : `，入口问题 ${moduleProblems.length} 项`
  const layoutNote = layoutProblems.length === 0 ? "" : `，依赖方向问题 ${layoutProblems.length} 项`
  console.log(
    `${ok ? "✓" : "✗"} 汇总：插件 ${factories.length} 个，失败 ${failed} 个${entryNote}${layoutNote}，提示 ${warnings} 条`,
  )
  return ok ? 0 : 1
}

void main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.log(`✗ 自检未能完成：${messageOf(error)}`)
    process.exit(1)
  })
