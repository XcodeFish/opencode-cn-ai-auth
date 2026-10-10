# 代码与工程规范

本规范适用于本仓库全部代码。可执行的规则交给工具（TypeScript、Biome、
`scripts/check.ts`），本文只写工具管不住、但评审会看的部分；两者冲突时以工具
配置为准，并回来改这份文档。

## 1. 工具链与硬性门禁

| 门禁 | 命令 | 说明 |
|---|---|---|
| 类型 | `bun run typecheck` | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| 格式与静态检查 | `bun run lint` | Biome：110 列、双引号、无分号、2 空格；禁止 `any` |
| 测试 | `bun run test` | `bun test`，全部离线 |
| 入口形状与依赖方向 | `bun run check` | `index.ts` 的导出必须都是插件工厂；`core` 不依赖厂商、厂商之间不依赖 |
| 全量 | `bun run verify` | 以上四步串行执行 |

改动完成前必须让 `bun run verify` 通过；没法跑的部分要在汇报里说明哪一步没跑、
为什么。**不允许**用 `// @ts-expect-error`、`as any`、关闭规则来"通过"门禁；
确有必要时必须在同一行注释里写明原因，并在评审里单独说明。

## 2. 类型

- 远端数据一律是 `unknown`，用 `core/json.ts` 的读取器取值；**不要**为响应体写
  `interface` 然后断言（`as SomeResponse`）。原因：厂商字段会变，断言会把运行时
  错误推迟到更难查的地方。
- 可选字段用条件展开表达，不用 `undefined` 赋值：

  ```ts
  // 对：exactOptionalPropertyTypes 下唯一安全的写法
  return { id, ...(office === undefined ? {} : { office }) }

  // 错：会写出一个值为 undefined 的字段，且类型上不允许
  return { id, office }
  ```

- 宿主传进来的函数可能在，也可能不在（`client.app?.log`），调用一律用可选链，
  并且**不要让可选能力影响主流程**（见 `core/log.ts`）。
- 不用 `any`；`unknown` + 收窄是标准做法。确需"任意对象"时用
  `Record<string, unknown>`。
- 公开返回结构用 `interface`/`type` 显式声明（例如 `RaccoonQrPoll`），不要靠推断
  把宿主契约的形状散进实现细节。

## 3. 命名

- 模块内的常量、函数用小驼峰；导出的厂商常量用 `VENDOR_` 前缀
  （`RACCOON_QR_POLL_INTERVAL_MS`），避免两家厂商在同一作用域里撞名。
- 布尔量用 `is`/`has`/`can` 起头（`isSignedOut`、`hasCredential`）；返回
  `T | undefined` 的读取器用名词（`accessOf`、`officeOf`）。
- 私有模块级函数不导出；只给测试用的导出**不存在**——测试直接 import 真正的
  实现模块，不为测试开洞。
- 文件名即职责：`product`（事实常量）、`api`（HTTP 方言）、`models`、`session`、
  `usage`、`login`、`index`（装配）。同一职责不要有两个文件。

## 4. 错误

- `VendorError`：请求级失败，信息面向用户，可带 `code`/`status`。
- `SignInExpiredError`：登录态失效，宿主据此把账号标记为需要重新登录。
- `usage` 钩子不抛异常表示"登录态失效"，而是返回 `{ signIn: "expired", error }`；
  其他失败返回 `{ error }`，卡片照常显示其余信息。
- 面向用户的消息用中文、说清下一步（"请重新登录"、"请检查插件选项 X"），
  **不带 token、不带手机号原文**（手机号一律 `maskPhone`）。
- 不为"可能失败"的清理动作抛错：日志、关闭页面、写回账号的失败都不影响主流程。

## 5. 注释与文档

- 文件头写**这个文件为什么存在**，以及它和宿主/厂商协议的哪条事实绑定；不要复述
  代码在做什么。
- 反直觉的决定必须留注释说明**为什么**，例如：`refresh: ""` 只用于标记存储形状、
  `expires: 0` 表示"没有可续期的到期时间"、扫码轮询把一切异常当作 `pending`。
- 注释引用事实时给出处（源码文件、端点、实测日期、上游版本），便于日后复核；
  未经证实的推断要写明"未验证"。
- 代码与注释用 ASCII；**面向用户的字符串用中文**，日志消息也用中文。

## 6. 网络与协议

- 所有请求都经 `core/http.ts`（超时 + `HttpTransportError`），不要直接 `fetch` 出网。
- 每个端点只在 `product.ts` 的常量表里写一次路径（`*_PATHS`），实现里拼常量。
- 解析响应先判信封（`parseEnvelope`），再判"登录态失效"（`isSignedOut`），最后
  才是业务字段；业务字段一律防御式读取。
- 轮询类接口把**无法解释的异常当作"还没结果"**，并写明理由；但"成功"必须有实锤
  （例如 QR 登录必须真的拿到 `access_token`）。
- **不按状态码一刀切地标记登录态失效**：403 同时覆盖认证失败、额度、权限、安全
  策略与地域限制（JetHub 两次实测，出处见 `docs/vendors.md` §4 第 8 条），只有
  401 才是宿主认可的「会话失效」。要在聊天链路上补 `X-Magpie-Sign-In`，必须先有
  该厂商 403 文案的实测证据，并按特征词分类，不能只看状态码。
- 超时、轮询间隔、续期提前量等时间常量放在 `product.ts`，并在注释里说明来源
  （厂商客户端、实测值或本包选择）。
- **图标只写宿主认得的形状**：`auth.icon` 必须是 `https://` 图片网址或
  `data:image/` URI（图片本身 ≤ 1 MB），裸图标名（`spark-color`）会被宿主**静默丢弃**；
  内置图标名只对 `registry.json` 的市场条目有效。理由、实测与取舍见
  `docs/architecture.md` §4.7；`bun run check` 会机械校验形状。

## 7. 安全与密钥

- 厂商自有的常量（AccessKey、手机号加密密钥）**默认绝不写进仓库**：走
  `core/credentials.ts` 的 options → env 顺序，缺失就让对应登录方式不出现。
  **唯一例外**是 `src/vendors/loomy/bundled-credentials.ts` 里 Loomy 二维码登录用的
  那组客户端 AccessKey：它是官方桌面客户端 bundle 里的常量、任何人都能读出，不内嵌就
  没有开箱即用的扫码登录，因此有意保留。例外要付代价——厂商旋转或吊销它，扫码登录全线
  失效且必须发一次新版——所以除了这一处**不再破例**，新出现的厂商常量一律走
  options → env。谁内嵌了新的常量，`THIRD_PARTY_NOTICES.md` 的厂商密钥一节必须同步。
- 用户凭据只存在于宿主的账号存储里；插件不写自己的凭据文件。
- 本地登录页只绑 `127.0.0.1`、只监听 0 端口、URL 带随机前缀；页面里不出现密钥、
  不出现 token、不出现未打码的手机号。
- 日志不打印凭据、token、手机号原文；错误信息只带厂商消息与错误码。

## 8. 依赖

- **零运行时依赖**：只用 Bun/Node 内置模块。需要的能力（如 QR 编码）自己实现，
  第三方代码必须在 `THIRD_PARTY_NOTICES.md` 里署名并保留许可证。
- 新增开发期依赖要说明用途、体积和是否可替代；`package.json` 的
  `devDependencies` 是唯一允许出现依赖的地方。

## 9. 测试

- 测试文件与被测模块同名：基座是 `tests/core.<module>.test.ts`，厂商是
  `tests/<vendor>.<module>.test.ts`（跨模块的装配测试用厂商名，
  如 `tests/raccoon.plugin.test.ts`）。
- **不联网**：被测函数都接收 `Fetcher`，测试传一个返回预置响应的假实现
  （见 `tests/helpers.ts`）。
- 测行为而不是实现：信封解析、状态机分支（`pending`/`canceled`/`success`）、
  边界（上限未知、字段缺失、异常响应）、以及**回归点**（曾经写错的那一行）。
- 时间与随机数是参数或依赖注入的边界（`now = Date.now()`、`iv?: Uint8Array`），
  测试用固定值断言，不 sleep。
- 每个新增的对外行为至少有一个测试；无法离线测的（真实登录、真实额度）在
  `docs/vendors.md` 的"未验证边界"里登记。

## 10. 提交与评审清单

提交前逐条确认：

1. `bun run verify` 通过（或说明未跑的步骤与原因）。
2. 涉及宿主契约的改动同时在 `docs/architecture.md` 有落点。
3. 涉及厂商协议事实的改动同时在 `docs/vendors.md` 有落点。
4. 面向用户的新文案是中文且无敏感信息。
5. 新导出都在入口/模块的职责范围内（入口只导出工厂）。
6. 没有为测试或调试开的后门导出、没有遗留 TODO 而不写明后续人。
