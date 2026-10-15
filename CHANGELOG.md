# Changelog

本文件按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的风格记录。

## [0.7.2] - 2026-10-16

### Fixed

- **Trae 登录的「登录失败 / 网络错误」定位到真正的根因：回调地址的形状**。控制台页面
  挂载时先用 `^http://127.0.0.1:(\d+)/authorize$` 校验 `auth_callback_url`，不匹配就
  直接切到失败屏（`ep(3)`），而且这一步发生在 `CheckLogin` 之前——所以本机连一个请求
  都收不到，看起来像网络问题。本包此前用 `PageServer` 的随机路径前缀
  （`http://127.0.0.1:<port>/<token>/authorize`），正好不匹配。现在 Trae 改用
  `PageServer` 新增的 `raw` 模式：回调就是源站根路径的 `/authorize`，并以 URL 里下发的
  `login_trace_id` 做校验（控制台原样回传，其它本机进程伪造的回调对不上）。
  无头 Chrome 对照实验：同一串参数只改回调形状，带前缀复现失败屏，根路径则出现正常
  登录界面（手机号 +86 / 获取验证码 / 抖音 / 苹果 / 企业账号）。
- 顺带补齐官方客户端同款的 `hide_saas_login=true`（solo 客户端才带）。

## [0.7.1] - 2026-10-16

### Fixed

- **Trae 的浏览器登录改用 PKCE，修掉「点登录就显示登录失败 / 网络错误」**。用户报障的
  那一屏是**控制台自己页面**的状态：无头 Chrome 复现确认，控制台只有在
  `GetRefreshToken` / `ExchangeToken` 成功之后才会跳转到本机回调页，出错时本机一个请求
  都收不到。对照本机安装的官方客户端（Trae CN 1.107.1 的 `product.json`）后确认差异：
  它用 `code_challenge` + `code_challenge_method=S256`，`plugin_version` 取
  `tronBuildVersion`（`2.3.91092`），`x_app_version` 取 `appVersion`（`3.4.2`），并在
  回调后用 `CodeVerifier` 到 `POST /trae/api/v3/oauth/ExchangeToken` 换令牌；本包此前
  用的是 JetHub 时代那套没有 PKCE 的老参数（`plugin_version` 还是 `2.3.62834`），于是
  控制台走了它已经不再签发令牌的老分支。现在按官方客户端构造 URL、回调里认
  `authCodeInfo.AuthCode` 并带校验串换取；老的 refreshToken 回调仍作为兜底保留。
- 回调里同时带着授权码与 token 时两条路都能走（优先用授权码），带授权码却没有校验串时
  明确报错而不是静默失败。

## [0.7.0] - 2026-10-16

### Added

- **新增第三家 provider：TRAE（字节跳动）**，`provider id = trae`，只做国内版客户端。
  与另两家不同，Trae 的 `POST /api/agent/v3/llm_utils_chat` **不是 OpenAI 兼容通道**：
  请求体要转成 SOLO 形状（强制 `stream`、注入 `function` 通道、`model` 与 `config_name`
  双写、字符串 `content` 变 `[{type:"text"}]`、assistant 的 `tool_calls[].function` 改名
  `function_call`、`tools[].function.parameters` 序列化成 JSON 字符串），响应要从 SOLO
  私有 SSE（`output` / `token_usage` / `done` / `error`）转回 OpenAI chunk。两件事都在
  `loader` 返回的 `fetch` 里做（`src/vendors/trae/wire.ts`），非流式请求由该层聚合。
- **模型目录按通道合并**：`batch_get_detail_param` 一次查多个通道，同一模型出现在多个
  通道时取信息更全的一条（能声明推理档位的胜出，否则按 `TRAE_CHANNELS` 优先），并把
  每个模型来自哪个通道记住 —— 模型只在列出它的通道里可调用，发错通道会在流内回
  `4001`。过滤与官方选择器一致：非 `chat_completion`、已停用、对用户隐藏的条目剔除。
- **一键签到**：`auth.checkin` 先查 `checkin_credits/status`（活动未开放报
  `ineligible`，当天已领报 `done`，都不发写请求），再 `claim`；因为 claim 响应不含
  积分数，成功后再查一次 status 取实际所得，避免卡片显示「成功 +0」。业务码 `9074`
  如实报失败并给重试提示（不自动换设备重试），字符串形式的 `"9074"` 也认。
- **登录**：浏览器授权 + 本机回环回调。回调参数是 `auth_callback_url`，回调直接回传
  token（不是 OAuth 的 `?code=`）；授权页的 PKCE 分支如实报「流程暂不支持」而不是
  「缺凭据」。登录态里带两个 32 位 hex 设备指纹（`machineId` / `deviceId`），续期时
  原样保留 —— 换值会看起来像新机器，也会让按设备计次的签到额度翻倍。
- **OpenCode 子入口** `opencode/trae.ts`：Trae 在 OpenCode 侧同样需要改写请求与响应，
  因此适配器（`opencode/adapter.ts`）新增 `bridge` 能力（安装 `http.request` /
  `http.response` 两个 hook）与 `credentialEnv`（粘贴 token 时从环境变量读设备指纹）。
  改写复用 Magpie 侧同一份 `wire.ts`。**OpenCode 不消费 `auth.checkin`，一键签到只在
  Magpie 侧**。
- 图标取自厂商自己页面声明的 `<link rel="icon">`（48x48 PNG）；`docs/vendors.md` §4
  记录了 Trae 的协议事实与出处，§5 第 11–16 条记录尚未验证的边界（含「Magpie 是否
  消费合成的流式 Response」与「OpenCode 的 hook 能否替换对象」两个待探针的前提）。

### Fixed

- **流式改写把控制器关两次**：`bridgeResponse` 在读流出错时先 `error()` 再在 `finally`
  里 `close()`，后者会抛 `Invalid state` 并掩盖真实原因；现在错误路径只 `error()`。
- **`fetch(request)` 形态被改成 GET**：宿主直接交一个 `Request` 时，改写后的请求会落到
  fetch 的默认方法 GET 上，而带 body 的 GET 会被拒；现在方法与 abort signal 都从该
  Request 上读取。
- **未知模型每个请求都重读目录**：懒读目录原先以「这个模型不在表里」为条件，于是已下架
  或回退表里的模型会让每一次对话都多一次目录请求；改为「本次实例还没成功读过」。
- **昵称不再被 latin-1 回转改坏**：实测该回转修不回文档里的乱码形态，却会把正常名字
  改坏（`🙂boy` → `=Bboy`、`Москва` → 控制字符、`José` → 替换字符，而这三者都恰好
  通过了「可打印且无替换字符」的判据）。现在可打印的名字原样保留，只有空名字或带控制
  字符时才用 `用户+uid末4位` 占位。

## [0.6.0] - 2026-10-16

### Fixed

- 用量卡片的「新手任务」一行在签到领完之后仍显示领取前的 N/8：任务读数的 10 分钟缓存
  没有在领取后失效，而签到与卡片刷新只差几秒，于是「今日已签到」和「已领 0 / 还有
  10000 分可领」会同时出现（用户报的「好像没有一键完成新手任务」）。现在签到领完会
  丢掉该账号的读数，下一次读即拿到新状态。

### Added

- Loomy 的新手任务在用量卡片**读到未完成时自动领取**。宿主自己画卡片、不给插件任何
  可按的东西（窗口是纯展示对象，签到行的两个按钮在账号「今日已签到」后消失），所以
  「已签到 + 任务没领」在界面上没有入口；`auth.usage` 是唯一必然会跑到的钩子。读到
  还有未完成就顺手领掉，同一次刷新的读数直接变成 8/8、那一行随之消失，用户不需要点
  任何东西。只在有未完成时尝试（读数 10 分钟缓存一次）、幂等（已领完 0 个请求）、
  被拒时停下并记录已领部分；`options.claimTasks: false` 可关掉，让额度读取回到只读。

## [0.5.0] - 2026-10-15

### Fixed

- **手机号（或扫码）新登录的账号，今日额度不显示百分比、不参与选号**。根因是登录时
  `POST /points/first-login` 拿到的 `dailyQuota` 被丢掉了，而 `usage` 依赖的
  `points/records` **并不返回它**（2026-10-15 实测：只回两个余额，遍历 `recordType`
  与 `pageSize` 都一样）——代码注释里「签到后 `/points/records` 会带上配额」的假设
  是错的。现在配额随登录结果一起交给宿主存下（宿主 `save()` 保留 `refresh`/`access`/
  `expires` 之外的字段），新账号第一眼就有百分比。这次调用套了 8s 上限
  （`LOOMY_SIGN_IN_QUOTA_DEADLINE_MS`）：拿不到就照常登录、只是不带配额。

### Added

- Loomy 的新手任务（8 项 / 10000 分）随每日签到一起补领：`auth.checkin` 里先领当日
  额度，再把没完成的任务逐个领掉。服务端不校验前置行为（JetHub 2026-09-26 实测，
  没发对话、没生成 PPT 也全过），所以是纯 API 直领，不花模型 token；**已领完的账号
  一个 `complete` 请求都不发**，只多一次只读任务表。
- 领取是幂等的（`alreadyCompleted` 算成功）、按表顺序串行、**中途被拒就停手**不再发
  剩余请求，中断原因写进签到消息；`100002` 仍抛 `SignInExpiredError` 让宿主标记账号。
- 任务分**不计入 `credit`**（那是「今日额度」，把 10000 永久积分报在那儿等于谎报每日
  额度），只写进签到消息，带任务标题与累计进度。
- 用量卡片新增一行**新手任务**进度（`新手任务 2/8 · 已领 1500 / 还有 8500 分可领`，
  `aside: true`，8/8 领完时不显示）。签到返回的消息宿主只在失败时显示，所以「一键
  领取」的结果此前对用户不可见；这一行按账号缓存 10 分钟读 `GET /onboarding/tasks`。

### Known

- 触发方式：`magpie accounts checkin`（实测对 loomy 生效，不受开关影响），或在
  Settings › Daily check-in › Plugins 打开 Loomy 的开关后用卡片上的 `Check in now`
  与每日自动签到。宿主对 loomy 的插件签到**默认关闭**（`PluginCheckinOn` 只对
  WorkBuddy / Trae CN / MiniMax / Qoder 有继承默认值），需要用户开一次。

## [0.3.0] - 2026-10-15

### Added

- Loomy 的短信登录默认可用，不再要求用户自备 AccessKey：随包客户端常量对
  `account.xfinfr.com` 的短信端点同样有效（2026-10-15 实测 `sendMsgCode` 回
  `000000`），用户配置的 `accessKeyId`/`accessKeySecret` 改为可选覆盖。
- `options.smsLogin: false` 可关闭 Loomy 的短信登录方式。
- 短信登录页改成「验证码输入框 + 获取验证码按钮」同一行，手机号单独一行；按钮点击后
  进入 60 秒倒计时（读服务端返回的 `retryAfterMs`），倒计时中禁用并显示剩余秒数。
- 短信登录页自带两道闸：同号码 60 秒冷却、一次登录最多发 3 条（服务端实测无频控）。
  冷却按号码记账，填错号码可以立刻改正后重发，切回未过期的号码仍会继续倒计时。

## [0.2.1] - 2026-10-13

### Fixed

- 修复 Loomy 微信扫码在长轮询重复给出 `405 + wx_code` 时，把同一枚一次性 code 二次
  提交给 `bind/auth`、被服务回 `270101 第三方鉴权失败` 的问题：换到 `rcode` 后标记
  该次扫码已兑换，后续确认帧不再重放。补回归测试（同一 code 的两帧确认只提交一次）。
- 微信第三方登录失败的裸 `desc` 不再原样透出：`270101` / `270202` / `270301` /
  `270401` 翻成可照做的中文（`270101` 引导「重新扫码，不行就改用短信验证码登录」），
  原始 `code` 仍保留在 `VendorError.code`。

## [0.2.0] - 2026-10-11

### Added

- 增加 OpenCode V2 适配层：`opencode/loomy` 与 `opencode/raccoon` 导出标准的
  `{ id, setup }` 插件对象，注册模型、登录方式、请求鉴权和凭据续期。
- 增加 OpenCode 适配器、登录、页面隔离和 QR/SMS 状态机的回归测试。

### Fixed

- 修复 Loomy 非 2xx 响应被当作空模型目录的问题，区分登录失效与供应商错误。
- 修复 Raccoon 短信并发请求覆盖状态的问题，增加 generation、过期请求和幂等验证保护。
- 修复 Loomy QR 绑定在二维码换代、旧页面和结算后仍可提交的问题。
- 将 Raccoon 验证码脚本移入 opaque-origin sandbox iframe，并增加 CSP 与严格消息校验。
- 更新文档和发布元数据，明确 Magpie 根入口与 OpenCode V2 子入口的兼容范围。

## [0.1.0] - 2026-10-09

### Added

- 首个版本：Loomy（讯飞）与 Raccoon（商汤小浣熊）两个 provider，共享基座 `src/core`。
- 一个包、两个 provider id：`loomy` 与 `raccoon`，由同一个入口 `index.ts` 导出两个插件工厂。
- 无运行时依赖、零构建，宿主 Bun 直接加载 TypeScript 源。
- Loomy：`options.lockPermanent` 锁定永久积分，今日额度用完即在 `loader.fetch`
  放行前拒绝（429 + 额度措辞），宿主据此把账号 bench 到窗口重置（`core/gate.ts`）。
- Loomy：两条登录路径（短信 / 微信）与签到都会初始化当日额度，与官方客户端一致。
- 基座：`core/gate.ts`（拒绝形状）、`core/request.ts`（wire 改写）、
  `core/login-page.ts` + `core/local-page.ts`（一次性回环登录页）。
- 基座：`core/stored.ts` 统一登录态的两种存储形状（OAuth 顶层字段 / API key 的
  `metadata`），厂商 `session.ts` 一律经它读账号字段。
- 基座：`core/catalog.ts` 统一 `provider.models` 的三条宿主规则（空目录=交回宿主
  原有列表、读失败=交回打上 `fellBack` 标记的内置表、登录态被拒=原样上抛），
  两家厂商不再各写一份。
- 门禁：`bun run check` 除入口形状外，还机械校验依赖方向（`core` 不 import 厂商、
  厂商之间不 import），把架构文档 §2 的规则从评审约定变成可执行检查。
- 门禁：`bun run check` 同时校验 `auth.icon` 的形状。宿主只保留 `https://` 网址与
  `data:image/` URI，**裸图标名会被静默丢弃**（无报错、界面上只是没有图标），
  已实测确认（magpie `0.1.1137`），因此做成检查而不是只写在文档里。
- 图标：两个 provider 各自带厂商自己页面声明的 logo（`LOOMY_ICON` /
  `RACCOON_ICON`），仓库不携带品牌资源；各厂商图标互不相同，一处配错只影响一家。
- CI：`.github/workflows/ci.yml` 在 push 与 PR 上跑同一条 `bun run verify`
  （`bun install --frozen-lockfile` + 临时 HOME），本地与 CI 不会跑成两套规则。
- 文档：README 补齐架构设计（含 Mermaid 分层图与聊天请求时序图）、开发规范、
  目录职责、分层与 Issue 模板;`.github/ISSUE_TEMPLATE/` 提供 bug / 功能与新厂商 /
  文档三张表单。

### Fixed

- 模型 `id` 全为空白时不再注册（Loomy `/models`、Raccoon `model_catalog`）：
  空白 id 会在宿主里变成不可路由的空模型。
- Loomy 的今日额度窗口以前永远停在"上限未知"、不参与选号：签到写下的
  `dailyQuota` 只存不读。现在 usage 会把它读回来（`usage.ts` 的 `quotaForNow`），
  缺少 `dailyConsumed` 时按服务端自己的算式 `quota − dailyBalance` 补出用量；
  属于已经重置那一天的上限会被丢掉，不带进新的一天。
- Raccoon 的组织码 / 手机号 / user id 现在也从 `metadata` 读：宿主把 API key 形状
  的登录态重建成 `{ type, key, metadata }`，只读顶层的写法会让这类账号静默丢掉
  组织码（`X-Org-Code` 为空，请求打到个人账号）并退回默认账号名。
- 文档更正：原先写「`X-Magpie-Sign-In: expired`（服务端 `100002`）标记 Loomy
  失效」与实现不符（插件从未设置该响应头）。实际由 `usage` / `provider.models` /
  `auth.checkin` 返回 `signIn: "expired"` 上报；聊天链路只认 401，403 刻意不翻译
  （理由与实测出处见 `docs/vendors.md` §4 第 8 条）。
- 文档更正：原先在 `docs/developing.md` §4 写「图标沿用社区内置图标名
  （`spark-color` 等）」作为 provider 图标，与宿主实现不符——`auth.icon` 只认
  `https://` 与 `data:image/`，内置图标名只对 `registry.json` 的市场条目有效。
  现在分开写：provider 用厂商自己托管的图片，市场卡片才用内置图标名（§4.1）。
