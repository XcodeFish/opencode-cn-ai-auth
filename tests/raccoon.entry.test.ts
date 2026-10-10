/**
 * 保护根 index.ts：magpie 会把入口模块的每个函数导出都当成插件工厂调用
 * （`internal/plugin/host.js` 的 `servers()`），所以入口只允许两个插件工厂，
 * 且每个工厂都能在没有宿主时装配出各自 provider 的钩子。
 */

import { describe, expect, test } from "bun:test"
import * as entry from "../index.ts"
import loomyOpenCode from "../opencode/loomy.ts"
import raccoonOpenCode from "../opencode/raccoon.ts"
import { fakeClient, providerOf } from "./helpers.ts"

describe("插件入口", () => {
  test("只导出两个插件工厂", () => {
    expect(Object.keys(entry).sort()).toStrictEqual(["LoomyAuthPlugin", "RaccoonAuthPlugin"])
    expect(typeof entry.LoomyAuthPlugin).toBe("function")
    expect(typeof entry.RaccoonAuthPlugin).toBe("function")
  })

  test("两个工厂都能装配出各自 provider 的钩子", async () => {
    const input = { client: fakeClient() }
    const [loomy, raccoon] = await Promise.all([entry.LoomyAuthPlugin(input), entry.RaccoonAuthPlugin(input)])
    expect(loomy.auth.provider).toBe("loomy")
    expect(providerOf(loomy).id).toBe("loomy")
    expect(typeof loomy.auth.checkin).toBe("function")
    expect(raccoon.auth.provider).toBe("raccoon")
    expect(providerOf(raccoon).id).toBe("raccoon")
    expect(raccoon.auth.checkin).toBeUndefined()
    expect(typeof raccoon.auth.refresh).toBe("function")
    expect(loomy.auth.refresh).toBeUndefined()
  })

  test("OpenCode 子入口各自只暴露一个 server", () => {
    expect(loomyOpenCode.id).toBe("opencode-cn-ai-loomy")
    expect(typeof loomyOpenCode.server).toBe("function")
    expect(raccoonOpenCode.id).toBe("opencode-cn-ai-raccoon")
    expect(typeof raccoonOpenCode.server).toBe("function")
  })
})
