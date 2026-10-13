# 厂商事实与边界

本文记录每家厂商的协议事实、凭据来源、过期语义、额度窗口，以及**已知限制和未验证
边界**。这里的每一条都要能追溯到源码、厂商客户端或一次实测；写不出处的数字不写。

证据来源：

| 来源 | 版本/时间 | 用途 |
|---|---|---|
| magpie 源码 | `host.js` / `provider/plugins.go`（0.1.1137 同代） | 宿主契约语义 |
| JetHub | `dsh-codearts-auth` 0.4.2（commit `505d24f3`，MIT） | 两家厂商的协议移植来源；其中的端点/常量已由其真机使用验证 |
| 厂商客户端读取 | 2026-09-26 / 2026-09-29 两次 | 模型表、倍率、图片支持、token 寿命 |
| 本包实现 | `src/vendors/**` | 上述事实的落点 |

## 1. 凭据

Loomy 微信扫码及首次手机号绑定使用随包提供的客户端公开常量，用户无需配置。
可选短信登录仍需用户配置对应值；缺少完整配置时，该短信登录方式不出现。用户配置的
取值顺序：插件选项 → 环境变量。

| 厂商 | 用途 | 插件选项 | 环境变量 | 从哪里读 |
|---|---|---|---|---|
| Loomy | 微信扫码与首次手机号绑定的账号接口签名 | 无 | 无 | 随包提供的 JetHub Loomy 客户端公开常量 |
| Loomy | 可选的独立短信登录 | `accessKeyId` | `LOOMY_XFYUN_ACCESS_KEY_ID` | 用户为启用短信登录提供的 AccessKeyId |
| Loomy | 同上 | `accessKeySecret` | `LOOMY_XFYUN_ACCESS_KEY_SECRET` | 用户为启用短信登录提供的 AccessKeySecret |
| Raccoon | 短信登录时加密手机号 | `phoneCipherSecret` | `RACCOON_PHONE_CIPHER_SECRET` | 商汤小浣熊客户端渲染层包内的 16 字节 AES 密钥 |
| Raccoon | OpenCode 组织账号请求头（可选） | `officeIdentity` | — | OpenCode auth store 不保留 Magpie metadata 时手动配置 |

JetHub 的 Loomy QR 登录和首次手机号绑定会自动使用随包客户端常量；用户配置
`accessKeyId` / `accessKeySecret` 仅用于启用独立短信登录。Raccoon 的
`phoneCipherSecret` 仍按上表由用户配置。它们都不是用户账号密码或登录 token。
一个包里的两家 provider 共享同一份 `options`，键名互不冲突。

仅当需要启用短信登录时，才需要配置 Magpie 插件选项（`<name>` 是
`magpie plugin list` 里的插件名，也可以用 `cn-ai` 这样的短名）：

```sh
magpie plugin options <name> '{"accessKeyId": "…", "accessKeySecret": "…", "phoneCipherSecret": "…"}'
magpie plugin options <name>          # 读回当前设置
magpie plugin options <name> off      # 清空
```

OpenCode V2 一侧使用插件条目里的 `options` 对象，token 可放在 `accessToken`（也可
用 `LOOMY_SESSION` / `RACCOON_ACCESS_TOKEN` 环境变量），但不会保存 Magpie 的账号
metadata。适配器在插件加载时注册回退模型、V2 integration 登录方式并将 token 注入
请求；二维码/短信登录会在 OpenCode 的本地登录页完成，凭据由 OpenCode 保存。Raccoon
直接接入 OpenCode 时，应把组织码放在 `officeIdentity` option 中。

## 2. Loomy（讯飞）

`provider id = loomy`，显示名 `Loomy (讯飞)`。

### 端点与协议

| 项 | 值 | 出处 |
|---|---|---|
| 业务基址 | `https://loomyad.xunfei.cn/api/v1` | 插件 `product.ts`；JetHub 同值 |
| 账号基址 | `https://account.xfinfr.com`（账号请求需 xfyun AccessKey 签名） | 同上 |
| 信封 | `{ code, message, data }`，成功码 `"000000"` | 同上 |
| 登录态失效 | 业务码 `"100002"`（`缺少 token`） | 同上 |
| 账号接口签名 | HMAC-SHA1 + 内容 MD5（`sign.ts`） | 同上 |
| 超时 | 60s（业务请求） | 本包选择 |

### 登录方式

| 方式 | 流程 | 依赖 |
|---|---|---|
| 微信扫码登录 | `open.weixin.qq.com/connect/qrconnect`（appid `wx18d60be432287cf8`）→ uuid → 二维码 JPEG → 长轮询 `408/404/405/403/402` 状态机 → 换 `access` | 无需用户配置；使用随包客户端常量，首次绑定手机号时在本地页验证短信 |
| 短信验证码登录 | 账号基址签名发送验证码（`msgid`，有效期 300s）→ `checkCode` 换 `access` | AccessKeyId + AccessKeySecret |

扫码状态机、`appid`、回调地址来自 JetHub 的实现（redirect 用厂商白名单内的
`https://loomy.xunfei.cn/oauth/wechat/callback`，本包只负责轮询，不需要接收回调）。

**第三方登录的业务码。** 微信四步（`bind/auth` → `sendMsg` / `checkCode` /
`skip`）失败时，服务回的是裸 `desc`：`bind/auth` `270101 第三方鉴权失败`、
`bind/sendMsg` `270202`、`bind/checkCode` `270301`、`bind/skip` `270401`
（后三个都是「第三方鉴权过期」）。2026-10-13 用随包客户端常量对线上服务实测所得
（同一批实测：`sendMsgCode` 与带真实 session 的 `query/thirdInfo` 都回 `000000`，
假密钥回 HTTP 401 `HMAC signature cannot be verified`——签名层本身是通的）。
`270101` 只表示「这一枚微信 code 没能通过鉴权」，至于是被重复使用、已过期，
还是厂商侧对 `wx18d60be432287cf8` 的配置变了，服务不区分。该码不再原样透出，
`api.ts` 的 `THIRD_PARTY_MESSAGES` 把它翻成可照做的一句「重新扫码，不行就改用
短信验证码登录」，其余码也各有说法，原始 `code` 仍由 `VendorError.code` 保留。

**微信 code 一次性。** 一个微信 `code` 只能换一次 `rcode`。微信的长轮询可能对同一
次授权重复给出 `405 + wx_code`，因此 `login.ts` 的 `confirmedStep` 在换到 `rcode`
之后就把这次扫码标成「已兑换」（`WechatSession.exchanged`），后续确认帧不再重放——
重放会让服务回 `270101`（上游 JetHub `loomy-wechat-login.js` 用
`state.wechatCode` 锁存同一件事，本包移植时补上）。二维码换代时该标记随旧码一起清零。

### 会话与续期

- **没有续期端点**：本包不实现 `auth.refresh`。业务端点上会话失效由
  `usage` / `provider.models` 钩子读到 `100002` 后返回 `signIn: "expired"` /
  抛 `SignInExpiredError`，宿主据此把账号标记为需重新登录。
- 聊天端点（`/chat/completions`，标准 OpenAI 兼容、无信封）的失效形态见 §4 第 8 条：
  若厂商以 403 而非常见的 401 回答，宿主的聊天链路不会据此标记账号。
- `expires` 是本包按 **14 天**（`LOOMY_SESSION_TTL_SECONDS = 1_209_600`）推算的，
  **不是服务返回的字段**；推算依据来自 JetHub 对该客户端会话寿命的观察。
- 登录结果里的 `refresh: ""` 只用于让宿主按 OAuth 形状存储（保留 `expires`），
  不代表存在可用的续期令牌；因为没有 `auth.refresh`，这个值永远不会被使用。

### 模型目录

- 端点 `/models`，**按账号**返回（套餐不同列表不同）。
- 倍率只写在显示名里（三种括号风格），`models.ts` 把它解析回数值 `rate`，
  显示名**去掉**倍率：宿主本来就按 `rate` 画徽标，名字里再写一遍等于同一个价格
  说两次。
- 倍率只出现在**账号自己的列表**里：宿主只从 `provider.models` 的返回读 `rate`，
  `config` 声明的那份（未登录 / 账号列表读不到时由本包兜底）没有徽标，
  这是宿主的形状（`host.js` 的 `info()` 不搬运 `rate`），不是本包漏写。
- 思考档位取服务返回的 `reasoning_efforts`，回退值为
  `none / low / medium / high / xhigh`（都是宿主认识的档位 id）。
- 回退表 8 个模型，读自 2026-09-26，顺序与服务一致。

### 积分（额度窗口）

| 窗口 | 来源 | 宿主语义 |
|---|---|---|
| 今日积分 | `dailyQuota − dailyConsumed`（`/points/records` 读，签到应答给 `dailyQuota`） | 唯一参与路由的窗口：`used = consumed/quota`，重置时间取服务端 `dailyCycleDate`，缺失时用北京时间次日 00:05 |
| 永久积分 | 同上 | `aside: true`：只展示，不参与路由 |

- `dailyQuota` 只有 `POST /points/first-login` 会说；签到后按账号持久化
  （`rememberQuota`），下次 usage 读回它（`quotaForNow`，`tests/loomy.usage.test.ts`
  盯着这条接线）。拿不到配额时，今日窗口退化为 `aside: true` 的"剩余 N"。
  持久化下来的配额带 `dailyCycleDate`：属于**已经重置的那一天**的配额不再继承
  （额度可能随活动变化，JetHub 对同字段的告诫同样是"不要硬编码"），今日窗口
  就等当天签到再说。
- `POST /points/first-login` 幂等：`alreadyProcessed: true` → `done`，否则
  `claimed`；签到失败返回 `failed` + 厂商消息。
- **登录后初始化**：官方客户端在**两条**登录路径（短信与微信）成功后都会调
  `POST /points/first-login`，本包照做（失败只 warn，不影响登录）。它顺带让
  `dailyQuota` 与当日余额进入账号记录，今日窗口因此能立刻参与选号。

### 锁定永久积分（`options.lockPermanent`）

JetHub 的 `allowPermanent: false` 语义是"今日额度用完即完全不可用"。宿主的
usage 窗口表达不了硬排除（只有**已知上限**的窗口才会参与选号），所以本包把这条
规则做成 `loader.fetch` 里的门禁（`core/gate.ts` + `balance.ts`）：

| 条件 | 行为 |
|---|---|
| 未设 `lockPermanent`（默认） | 永不拒绝，按原样花永久积分 |
| 已锁定 + 缓存的今日余额 > 0 | 放行 |
| 已锁定 + 缓存的今日余额 ≤ 0 | 不下发请求，直接返回 429 拒绝（`LOOMY_LOCKED_REFUSAL`） |
| 已锁定 + 无缓存 / 缓存超过 60s | **放行**（fail-open：宁可偶发花掉永久积分，也不误伤可用请求） |

- 缓存由 `usage`（`points/records` 只读）与 `checkin` 填充，TTL 60s（JetHub 同值），
  只存在内存里、不落盘，可按账号重建。
- 拒绝形状经过核对：429 + 含"额度"的措辞，**不含**"余额/充值"（那会被宿主判成
  `failCredit`，歇 30 分钟）也不含限流措辞。判定规则来自 `internal/gateway/routing.go`
  的 `failure()`。核对方式：把本包实际产出的拒绝正文（中英文两版）喂进上游那份
  `failure()`，两次都得到 `quota`（2026-10-09，magpie clone `62b1c99`，与
  0.1.1137 同代；`tests/core.gate.test.ts` 用同一套规则做离线回归）。
- 落在 `failQuota` 才会让宿主把账号 bench 到窗口重置（`c.full(now)` → `By: "window"`），
  这正是门禁的目的：锁定的账号应该在今日额度重置时自己回来。

### 已知限制

- **新手任务 10000 分不做**：宿主没有对应钩子，插件不静默替用户领奖；需要去官方
  客户端领取。
- 签到只在宿主调度时发生（magpie 负责按北京日调度与失败重试），插件本身不带定时器。

### 图标

`LOOMY_ICON = https://loomy.xunfei.cn/icon.png` —— 取自 Loomy 自己页面声明的
`<link rel="icon" href="/icon.png?5f7e7b8be5d4c76b">`（2026-10-09 读，去掉查询串
后是同一份字节）：1024×1024 PNG、670 KB，在宿主 1 MB 上限内。这个网址是厂商
自己发布 logo 的地方，所以本包不复制品牌资源；失效时宿主回落到插件市场的图标，
不影响 provider 加载。规则与取舍见 `architecture.md` §4.7。

## 3. Raccoon（商汤小浣熊）

`provider id = raccoon`，显示名 `Raccoon (商汤)`。

### 端点与协议

| 项 | 值 |
|---|---|
| 基址 | `https://xiaohuanxiong.com` |
| 登录 | `/api/web/auth/v1/*` |
| 聊天与模型目录 | `/api/web/llm/v2/*`（聊天基址 = 基址 + 该前缀） |
| 积分 | `/api/web/points/v1/*` |
| 信封 | `{ code, message, details, data }`，`code === 0` 成功；无 `code` 时按 HTTP 状态判 |
| 登录态失效 | HTTP `401`，或业务码 `200003` |
| 请求头 | `Authorization: Bearer <access>`、`X-Org-Code: <office_identity ?? "">`、`X-Raccoon-Language: zh`；聊天另加 `X-Client-Platform: desktop-windows`、`X-Client-Version: v1.0.35` |

平台/版本头是桌面客户端自己的值，服务端的 desktop 端点要求它们。

### 登录方式

| 方式 | 流程 | 依赖 |
|---|---|---|
| 微信扫码登录 | 本地生成 32 位 hex `qrcode_code` → 二维码指向厂商落地页 `…/login/mp?code=…&appname=商汤小浣熊官网` → 每 2s 轮询 `POST /login_with_qrcode_code` → `pending/logging/canceled/success` | 无 |
| 短信验证码登录 | 阿里云滑块 → `POST /send_sms`（手机号 AES-128-CFB，`base64(iv‖ct)`）→ `POST /login_with_sms` | `phoneCipherSecret` |

- 客户端自己的扫码流程最终回调到 `office-raccoon://`，插件进程收不到，因此采用
  "本地生成 code + 厂商落地页 + 轮询"的等价流程。
- 服务对未知状态、坏响应、请求失败一律按 `pending` 处理（宁可多等 2s，不可误判
  `success`）；`success` 必须真的带 `access_token` 才算成功。
- 短信接口的错误码：`100006 captcha_verify_error`（滑块未过/失效）、
  `100003 params_encryted_error`（手机号加密不对）。
- 阿里云验证码常量（sceneId `1pkmy0x3`、prefix `hk1r5l`、脚本 CDN）来自该客户端
  的页面配置。

### 会话与续期

- `POST /refresh {refresh_token}`：`access_token` 必须返回；`refresh_token` 可选，
  **服务不返回时旧 refresh 仍然有效**，因此续期结果里保留旧值。
- `refreshLead = 300s`（客户端自己的续期窗口；实测 `exp − nbf = 10805s`，约 3 小时）。
- access 的 `exp` 读不出来时，续期结果返回 `expires: 0`：宿主按 `expires > 0`
  判断是否需要续期，`0` 表示"没有可续期的到期时间"，让厂商的 401 去标记账号；
  省略 `expires` 会保留旧值，导致每次请求都续期一次。
- 扫码/短信登录若拿到 `refresh_token` 就按 OAuth 形状存储（可续期）；没有则按
  API key 形状存储，宿主不做续期。
- **形状影响字段位置**：宿主把 API key 形状的登录态重建成
  `{ type, key, metadata }`（`internal/plugin/host.js` 的 `save`），所以那种账号里
  组织码、手机号、user id 只在 `metadata` 下。`core/stored.ts` 的两个读法同时看
  顶层与 `metadata`，`session.ts` 一律经它取值——否则这类账号会静默丢掉组织码
  （`X-Org-Code` 变空，请求打到个人账号），账号名也退回服务端默认值。

### 模型目录

- 端点 `/api/web/llm/v2/model_catalog`：`data.categories[]` 中 `type === "chat"`
  的 `models[]`。
- **模型 id 是 `name` 字段**（聊天请求的 `model`），显示名是 `description`；
  `visible: false` 的模型（三个内部 `raccoon-*`）不提供。
- 倍率：`billing_effective_multiplier` → `rate`，`billing_multiplier` 更大时 →
  `rateWas`，`rate === 0` → `free`。
- 上下文/输出上限取 `params.context_window` / `params.max_tokens`。
- `tags` 少报图片能力：`sn-glm-5-3-flash`、`sn-deepseek-v4-1-flash` 两个模型
  由白名单显式标记为支持图片（2026-09-29 实测 `image_tokens = 64`）。
- 回退表 6 个可见模型，读自 2026-09-26，顺序与服务一致。

### 思考开关

- 只有 `extra_body.thinking.type`（`enabled` / `disabled`）真正起作用；
  `reasoning_effort` 服务接受但不决定行为（8 轮配对实验无差异）。
- 因此插件对外只暴露 `none` / `high` 两档（宿主认识的 id）：`none` → 关闭，
  其他 → 开启；`loader.fetch` 改写请求体并**删掉** `reasoning_effort`，
  避免两个通道各说各话。
- 未收到 `reasoning_effort` 时原样透传（服务默认就是思考开启）。

### 积分（额度窗口）

| 窗口 | 来源 | 宿主语义 |
|---|---|---|
| 每日积分 / 月度积分 / 奖励积分 / 充值积分 | `GET /points/v1/balance` 的 `daily_points` / `monthly_points` / `reward_points` / `topup_points` | 全部 `aside: true`：只展示，不参与路由 |
| 可用积分 | `available_points` | 卡片 `balance` 一行 |

- 所有窗口都不计算百分比：服务只说"还剩多少"，**不说上限**。把猜来的上限写进
  `used` 会让宿主按错误的用量排序账号，因此宁可不参与路由。
- **每日 300 分是服务端自动发放、没有端点**，所以不实现 `auth.checkin`
  （不伪造签到能力）。
- 一次性登录奖励 3000 分同样没有对应钩子，不做。

### 图标

`RACCOON_ICON = https://sta-volc.xiaohuanxiong.com/raccoon-family/prod/favicon.svg`
—— 取自小浣熊自己页面声明的 `<link rel="icon" type="image/svg+xml" …>`（2026-10-09
读）：1.7 KB SVG，深色画在透明底上，深浅主题都看得见；站点的 `/favicon.svg`
返回同一份字节。网址是厂商自己发布 mark 的地方，本包不复制品牌资源；失效时宿主
回落到插件市场的图标。规则与取舍见 `architecture.md` §4.7。

## 4. 未验证边界（发布前需知）

以下内容在源码/客户端层面有据，但**没有在 magpie 内实测过**，不要当成已验证事实：

1. 两家厂商的插件都未在 magpie 宿主内跑过真实登录与真实聊天；当前证据是
   `plugin add` 级别的加载与形状检查（见 `developing.md` §3）。
2. Raccoon 的思考开关端到端未抓包确认：`variants{none,high}` + `extra_body`
   改写逻辑自洽，但 agent 实际发出的 `reasoning_effort` 终值未观测。
3. Raccoon 短信登录依赖阿里云验证码 CDN 在宿主页面环境中的可用性；扫码路径不依赖。
4. Raccoon 积分池的语义（各池的刷新时间、是否有隐藏上限）未逐项验证；
   若日后证实每日池上限稳定为 300，可把每日窗口从 `aside` 提升为路由窗口。
5. Loomy 的 `lockPermanent` 门禁只验证了**拒绝形状被宿主判成 `quota`**（见上文
   与 §2 那条）；端到端路由行为（两个账号、一个锁定额度为 0 时请求是否都落到另一个、
   以及账号是否真的被 bench 到次日）未在真实网关流量下观测。
6. Loomy 的 14 天会话寿命是本包的推算值；服务未返回明确到期时间。
7. Loomy 的微信 `redirect_uri` 使用厂商白名单内的地址，本包不接收回调；
  若厂商调整白名单，扫码流程会失效（现象：轮询一直不返回已确认状态）。
8. **聊天链路的认证状态只认 401，403 刻意不翻译**。已工作的部分：会话失效时两家
   的聊天端点都回 401（Raccoon 见 JetHub `src/raccoon.ts:156`「服务端会回 401，
   我们能识别并续期」；Loomy 适配器把 401/403 同等处理，`loomy-adapter.ts:506-515`），
   而 401 正是 magpie 会标记失效的状态（`provider/plugins.go` 的 `notePluginSaid`
   默认分支 → `plugin_accounts.go:343-347`）。**未做**：把 403 补成
   `X-Magpie-Sign-In: expired`。理由是 JetHub 自己的两次实测都记着 403 同时覆盖
   「真认证失败 / 额度 / 权限 / 安全策略 / 地域限制」（`cline-adapter.ts:887-915`、
   `buddy-adapter.ts:409-412`：同一份请求体在 7 个账号上得到 2×200、4×403、1×429），
   按状态码一刀切会把内容或地域拦截误判成会话过期，逼用户白白重新登录。因此本包
   不在 loader 的 fetch 上补这个头；若日后真实流量证实某家用 403 表达会话失效，应
   按响应体特征词做有据的翻译，并补回归测试。社区里 `cline` / `minimax` 用的是
   「补 `kept` 或按文案分类」这类更保守的写法，可作参考。
9. Loomy 的微信 `270101` 有一个**未证伪**的厂商侧可能：若讯飞对
   `wx18d60be432287cf8` 这个网站应用改了主体、密钥或授权槽位，那么即使是刚拿到、
   从未用过的合法 code 也会被判「第三方鉴权失败」。本包已消除**我们这侧**能把
   同一枚 code 用第二次的那条路（见 §2「微信 code 一次性」），但「合法 code 是否
   仍被接受」只有在真机上扫一次、把那一帧的 `wx_code` 重放给 `bind/auth` 才能定论。

发现与上述不符的现象时：先改 `src/vendors/<id>/product.ts` 的常量与本文档，
再补一条回归测试；不要只改实现不留证据。
