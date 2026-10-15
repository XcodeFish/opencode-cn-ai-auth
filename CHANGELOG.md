# Changelog

本文件按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的风格记录。

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
