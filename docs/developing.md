# 开发与发布

## 1. 环境

| 需要 | 说明 |
|---|---|
| Bun ≥ 1.1 | 本包没有构建步骤，Bun 直接运行 TypeScript。若 PATH 里没有 bun，可用 magpie 自带的运行时：`~/.cache/magpie/bun/<版本>/magpie-bun` |
| magpie ≥ 0.1.11xx | 只用于**沙箱验收**（加载插件、跑登录流程），开发与测试不需要 |
| 网络 | 只有真实登录/沙箱验收时需要；测试全部离线 |

```bash
bun install          # 只装开发依赖（biome / typescript / @types/bun）
bun run verify       # typecheck → lint → test → 入口形状与依赖方向检查
```

单独执行：`bun run typecheck`、`bun run lint`、`bun run lint:fix`、`bun run test`、
`bun run check`。

## 2. 加一家新厂商

按顺序做，每一步都有对应的既有实现可对照（Loomy、Raccoon）：

1. **事实先行**：先读厂商客户端/现有实现，把域名、路径、信封、错误码、超时、
   时间常量、模型表抄成 `src/vendors/<id>/product.ts`。**没有证据的数字不要写**；
   不确定的写进 `docs/vendors.md` 的"未验证边界"。
2. `api.ts`：信封解析、请求头、每个端点的读写函数。入参一律带 `fetcher`，
   不要直接 `fetch`；`usage`/`models` 用的只读接口写"不抛异常"的版本
   （返回 `{ ok, code, message, signedOut }`），登录/续期这类用户要看到失败原因的
   写抛异常版本。
3. `models.ts`：远端目录 → `ModelSpec[]`（含 `rate`/`rateWas`、`images`、`efforts`），
   以及一份回退表。回退表的顺序与厂商返回顺序一致，并在注释里写明读取日期。
   `index.ts` 的 `listModels` 把读取与回退交给 `core/catalog.ts` 的 `catalogModels`
   （空目录=没话说、读失败=标记回退、登录态被拒=上抛），不要自己重写这三条。
4. `session.ts`：`access`/`key` 的读取、登录态缺失时的 `SignInExpiredError`、
   账号名（要能区分两个账号）、以及需要写回账号时的"整体复制 + 追加"。
5. `usage.ts`：把额度映射成 `UsageWindow[]`。**上限未知就用 `aside: true`**，
   不要把猜测的配额写进 `used`（宿主会用它排序账号）。
6. `login.ts`：`AuthMethod[]`。扫码类流程用 `core/local-page.ts` + `core/qr.ts`；
   需要厂商自有常量的方式在凭据缺失时**不注册**。
7. `index.ts`：`defineVendor` 装配 id、显示名、`baseURL`、方法、`configModels`、
   `loader`、`listModels`、`usage`，以及（如果厂商支持）`refresh` + `refreshLead`
   和 `checkin`；还有 `icon` —— 厂商自己页面声明的 logo 网址，别写裸图标名
   （§4.1）。
8. 根 `index.ts` 追加导出；`package.json` 的 `keywords` 追加厂商名（保持
   `opencode`/`auth` 等发现用关键词不动）。
9. 测试：`tests/<id>.*.test.ts`，全部离线。
10. 文档：`docs/vendors.md` 增补一节（端点、凭据、过期语义、额度窗口、已知限制），
    `README.md` 的能力表与安装说明同步。

完成定义：`bun run verify` 通过 + `docs/vendors.md` 有该厂商的完整事实与未验证
边界 + 至少覆盖登录状态机、模型解析、额度窗口的测试。

## 3. 沙箱验收（不改真实环境）

用一个临时 HOME 安装本包，检查宿主能否加载、插件形状是否正确：

```bash
sb=$(mktemp -d)
m() { env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" magpie "$@"; }

m plugin add "$PWD"
magpie plugin --json       # 应看到 loomy / raccoon / trae 三个 provider，且无加载错误
```

进一步的交互（**会连真实厂商**，需要真实账号，按需执行）：

```bash
m plugin login loomy        # 扫码无需配置；独立短信登录需配置 AccessKey
m provider test loomy
m quota                     # 额度卡片：Loomy 双窗口、Raccoon 积分池
m plugin login raccoon
```

验收的边界要写清楚：`plugin add` + `plugin --json` 只证明**加载与形状**正确，
不证明任何厂商协议正确；真实登录/请求属于运行时证据，需单独记录。

## 4. 发布流程

1. `package.json` 版本 + `CHANGELOG.md`（保留"未验证/已知限制"章节）。
2. `bun run verify` 全绿，`git status` 确认没有夹带无关改动。
3. 独立仓库发布：确认 `package.json` 没有 `private: true` 后执行 `npm publish`。
   发布包同时包含 Magpie 根入口与 `opencode/loomy`、`opencode/raccoon`、`opencode/trae`
   三个 OpenCode V2 子入口（各自导出 `{ id, setup }`）；V1 的函数/`server` loader 不在
   支持矩阵内。
4. 进社区仓库（`magpie-community/plugins`）：
   - 目录 `packages/cn-ai/`，`package.json` 的 `name` 改为
     `@magpie-community/opencode-cn-ai-auth`；
   - `registry.json` 增加下面这条（`icon` 见 §4.1，先读那一节再定）：

     ```json
     { "package": "@magpie-community/opencode-cn-ai-auth", "name": "Loomy · Raccoon", "icon": "spark-color", "providers": ["loomy", "raccoon"], "community": true,
       "summary": { "en": "Loomy (iFlytek) and Raccoon (SenseTime) coding subscriptions, each with its own sign-in, model catalog and credits.", "zh": "讯飞 Loomy 与商汤小浣熊的编程订阅：各自的登录、模型目录与积分额度。" } }
     ```

   - 图标**不新增自绘资源**；`icon` 的取舍与两级图标的区别见 §4.1。
5. 发布后回归：按 §3 的沙箱流程确认新版本仍能加载；已登录账号的 provider id
   **不可**改变（改了等于让所有账号失联）。

### 4.1 图标：两级身份，各有各的规则

图标有**两种**，宿主对它们的取值规则不同，混用会静默失效（界面上只是没有图标，
没有任何报错）：

| 用途 | 字段 | 宿主接受什么 | 本包的值 |
|---|---|---|---|
| provider 行、账号、额度卡片 | `auth.icon`（`defineVendor` 的 `icon`） | **只有** `https://` 的图片网址或 `data:image/` URI；**裸图标名会被丢弃** | 各厂商**自己**页面声明的 logo（`product.ts` 的 `LOOMY_ICON` / `RACCOON_ICON` / `TRAE_ICON`），每个 provider 各不相同 |
| 插件市场卡片、插件行 | `registry.json` 的 `icon` | 社区内置图标名（`internal/gui/assets/icons/<name>.svg`） | 见下面那条选择 |

出处：宿主 `internal/plugin/host.js` 的 `iconOf`（只保留 `https://` 与 `data:image/`）、
`internal/gui/assets/app.js` 的 `icon()`（按名字取内置 svg）、
`internal/provider/plugin_icon.go` 的 `PluginIcon`（插件给的图片优先，市场图标兜底）。
本包的 `bun run check` 会机械校验 `auth.icon` 的形状，写裸名字直接红。

已实测（magpie `0.1.1137`，2026-10-09）：把 `LOOMY_ICON` 临时改成 `spark-color`，
`plugin --json` 里 loomy 的 `icon` 字段直接消失（raccoon 不受影响）；改回 https
网址后该字段是完整 URL。所以「写裸名字会静默失效」这条不是从源码推的，是观测到的。

体积有两个不同的上限，别混：插件给出的字符串超过 `3 << 19`（约 1.5M 字符）会被
宿主丢弃（`host.js` 的 `iconOf`）；图片**字节数**另有 1 MB 上限
（`provider/icon.go` 的 `MaxIcon = 1 << 20`，取回与存储时拦）。所以裸 `https://`
网址几乎不可能超，只有内联的 data URI 需要注意。

**为什么 provider 用厂商自己托管的图片**：不往仓库里放品牌资源（不引入授权与体积
问题），图片换了也跟着换；失效时宿主回落到市场图标，代价只是一个图标。

**市场卡片那条 `icon` 是唯一要人做取舍的地方**：一个包只有一个 `icon`，而本包有
多家厂商，所以它只能代表一家。当前取 `spark-color`（讯飞星火，本包第一个
provider 的母公司）；换成 `sensenova-color` 或干脆不写（宿主画通用标记）
都不影响功能，改的是观感。

## 5. 排错

| 现象 | 常见原因 | 处理 |
|---|---|---|
| 加载报 `exports no OpenCode plugin function` | 入口模块没有函数导出，或导出的是对象/常量 | 检查 `index.ts` 只导出工厂；跑 `bun run check` |
| 两个厂商里只有一个出现 | 某个工厂抛错（例如初始化时读了不存在的凭据） | 工厂必须无副作用；读凭据放在方法注册/hook 里 |
| 短信登录方式不出现 | 凭据未配置（options 键写错或环境变量未设置） | 看 `docs/vendors.md` 的凭据表；错误信息里带选项名 |
| 选项改了不生效 | 一个包的多个 provider 共享同一份 `options` | 键必须厂商特有，不要复用同名键 |
| 账号显示成 `RaccoonAva` 之类默认名 | 账号名读取失败/字段变了 | 看日志里"读取账号信息失败"；`learn()` 是尽力而为 |
| 账号每次请求都在续期 | 续期返回值漏了 `expires`，旧到期时间被保留 | 返回 `expires: renewed.expires ?? 0` |
| 积分卡片数字不对 | 字段名变了 | `api.ts` 的读取器是唯一解析点；对不上就查原始响应 |
| 聊天的思考开关无效 | 厂商只认私有 wire 字段 | 在厂商 `thinking.ts` 里改写，并登记为待端到端验证 |

日志统一走 `core/log.ts`（service `cn-ai`，消息前缀 `<vendor>: `）。
