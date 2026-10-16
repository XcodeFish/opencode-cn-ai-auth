# 厂商事实与边界

本文记录每家厂商的协议事实、凭据来源、过期语义、额度窗口，以及**已知限制和未验证
边界**。这里的每一条都要能追溯到源码、厂商客户端或一次实测；写不出处的数字不写。

证据来源：

| 来源 | 版本/时间 | 用途 |
|---|---|---|
| magpie 源码 | `host.js` / `provider/plugins.go`（0.1.1137 同代） | 宿主契约语义 |
| JetHub | `dsh-codearts-auth` 0.4.2（commit `505d24f3`，MIT） | Loomy / Raccoon 两家的协议移植来源；其中的端点/常量已由其真机使用验证 |
| JetHub（Trae） | `src/trae*.ts`（同仓库，MIT） | Trae 的协议移植来源；其上游是 `trae2api`（Go）与 `trae-mate`，JetHub 在真机上验证过这些通道 |
| 厂商客户端读取 | 2026-09-26 / 2026-09-29 两次 | 模型表、倍率、图片支持、token 寿命 |
| 本包实现 | `src/vendors/**` | 上述事实的落点 |

## 1. 凭据

Loomy 的三条账号请求路径——微信扫码、首次手机号绑定、独立短信登录——都使用随包
提供的客户端公开常量，用户无需配置任何东西。用户配置的取值顺序：插件选项 →
环境变量，配了就用用户的（用于内嵌常量被厂商旋转时自救），没配就用内嵌的那对。
`options.smsLogin: false` 可以关掉独立短信登录（默认开）。

| 厂商 | 用途 | 插件选项 | 环境变量 | 从哪里读 |
|---|---|---|---|---|
| Loomy | 账号接口签名（扫码 / 扫码绑手机号 / 短信登录） | 无 | 无 | 随包提供的 JetHub Loomy 客户端公开常量 |
| Loomy | 覆盖上面的签名凭据（可选） | `accessKeyId` | `LOOMY_XFYUN_ACCESS_KEY_ID` | 用户自己的 AccessKeyId |
| Loomy | 同上 | `accessKeySecret` | `LOOMY_XFYUN_ACCESS_KEY_SECRET` | 用户自己的 AccessKeySecret |
| Loomy | 关掉独立短信登录（可选） | `smsLogin: false` | — | 本包的开关，默认开启 |
| Raccoon | 短信登录时加密手机号 | `phoneCipherSecret` | `RACCOON_PHONE_CIPHER_SECRET` | 商汤小浣熊客户端渲染层包内的 16 字节 AES 密钥 |
| Raccoon | OpenCode 组织账号请求头（可选） | `officeIdentity` | — | OpenCode auth store 不保留 Magpie metadata 时手动配置 |

JetHub 的 Loomy QR 登录和首次手机号绑定会自动使用随包客户端常量；短信登录用的是
同一对常量（2026-10-15 实测该常量对 `sendMsgCode`/`checkCode` 回 `000000`）。
Raccoon 的 `phoneCipherSecret` 仍按上表由用户配置。它们都不是用户账号密码或登录
token。
一个包里的两家 provider 共享同一份 `options`，键名互不冲突。

只有在需要覆盖内嵌签名凭据、或要开关某家登录方式时，才需要配置 Magpie 插件选项
（`<name>` 是 `magpie plugin list` 里的插件名，也可以用 `cn-ai` 这样的短名）：

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
| 短信验证码登录 | 账号基址签名发送验证码（`msgid`，有效期 300s）→ `checkCode` 换 `access` | 无（用随包客户端常量；`options.smsLogin: false` 可关闭） |

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

**短信登录的错误码与频率。** 2026-10-15 用随包客户端常量对线上实测：错验证码回
`210105 验证码错误`，`msgid` 过期回 `210106 验证码已失效`，手机号格式非法回
`010003 请求参数错误`。服务对 `sendMsgCode` **完全没有频控**：同一号码连续三次
都回 `000000`。因此本页自带两道闸——两次发送之间隔 60 秒
（`LOOMY_SMS_SEND_COOLDOWN_MS`）、一次登录页最多发 3 条
（`LOOMY_SMS_SENDS_PER_FLOW`），超过回 429。冷却按**号码**算：填错号码可以立刻改成
正确的再发（只向新号码发），同一个号码的重复点击则被挡住；次数上限按**这一次登录页**
算，换号码也共用，因为目标是限制本页发出的短信总量。它们是本包的防误触措施，不是
厂商行为；服务端若哪天也加上限流，超限消息由厂商 `desc` 直接透出。

页面形状：手机号一行、「验证码输入框 + 获取验证码按钮」一行。按钮点击后禁用并显示
「N 秒后可重发」（读响应里的 `retryAfterMs`），前端按号码记账，所以切回一个仍在冷却
的号码会重新显示那个号码剩下的秒数，而不是误以为可以立刻重发。

### 会话与续期

- **没有续期端点**：本包不实现 `auth.refresh`。业务端点上会话失效由
  `usage` / `provider.models` 钩子读到 `100002` 后返回 `signIn: "expired"` /
  抛 `SignInExpiredError`，宿主据此把账号标记为需重新登录。
- 聊天端点（`/chat/completions`，标准 OpenAI 兼容、无信封）的失效形态见 §5 第 8 条：
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
| 今日积分 | `dailyQuota − dailyConsumed`（`/points/records` 只给两个余额，`dailyQuota` 只有 `POST /points/first-login` 给） | 唯一参与路由的窗口：`used = consumed/quota`，重置时间取服务端 `dailyCycleDate`，缺失时用北京时间次日 00:05 |
| 永久积分 | 同上 | `aside: true`：只展示，不参与路由 |
| 新手任务 | `GET /onboarding/tasks` 的 8 个标记 | `aside: true`：只展示，不参与路由；8/8 领完时不显示这一行 |

**`dailyQuota` 只有 `POST /points/first-login` 会说**（2026-10-15 实测：
`/points/records` 只回 `balance` / `dailyBalance` / `availableBalance`，**没有**
`dailyQuota` / `dailyConsumed` / `dailyCycleDate`——遍历 `recordType` 与 `pageSize`
都一样）。它进账号记录有两条路：

1. **登录时随登录结果一起存**（主力路径）：`POST /points/first-login` 的答案塞进
   `SignInResult`（`login.ts` 的 `signInResult`），宿主 `save()` 把 `refresh`/`access`/
   `expires` 之外的字段原样留在顶层。新登录的账号因此**第一眼就有百分比**。
   这次调用被 `raceQuota` 套了 8s 上限（`LOOMY_SIGN_IN_QUOTA_DEADLINE_MS`），
   拿不到就照常登录、只是不带 quota（今日窗口退回 `aside`），不阻断登录。
2. **签到后补写**（老账号与失败重试）：`rememberQuota` 写回账号，`quotaForNow`
   在下次 usage 读回它（`tests/loomy.usage.test.ts` 盯着这条接线）。

持久化下来的配额带 `dailyCycleDate`：属于**已经重置的那一天**的配额不再继承
（额度可能随活动变化，JetHub 对同字段的告诫同样是"不要硬编码"），今日窗口
就等当天签到再说。
- `POST /points/first-login` 幂等：`alreadyProcessed: true` → `done`，否则
  `claimed`；签到失败返回 `failed` + 厂商消息。
- **登录后初始化**：官方客户端在**两条**登录路径（短信与微信）成功后都会调
  `POST /points/first-login`，本包照做（失败只 warn，不影响登录），并把答案里的
  `dailyQuota` / `dailyCycleDate` 交给宿主随登录态存下——这就是上面第 1 条。

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

### 新手任务（10000 分）

`GET /onboarding/tasks` 读 8 个任务的完成标记，`POST /onboarding/tasks/complete
{key}` 领一项。表与分值抄自客户端 `electron/onboarding-service.js` 的 `TASK_POINTS`
（其单测断言 8 项之和 === 10000），`product.ts` 的 `LOOMY_TASK_POINTS` 是唯一落点。

**服务端不校验前置行为。** 2026-09-26 JetHub 对 8 个任务逐个发 `POST /complete`，
没有真的发对话、生成 PPT、装技能，全部回 `000000`，余额 0 → 10000：完成条件全在
客户端本地判定，服务端只做「幂等置位 + 加分」。所以本包也是**纯 API 直领**，
一个模型 token 都不花。上报 body 只有 `key`（无设备指纹、无版本号）。

**为什么挂在 `auth.checkin` 上。** 宿主的钩子只有 `config` / `provider.models` /
`auth.{provider,methods,loader,usage,checkin,refresh,refreshLead,icon,maxConcurrency}`
（读自本机 magpie 0.1.1254 的 `plugin-host`），**没有一次性奖励钩子**；`checkin` 是
唯一的写钩子，也是唯一有手动入口的（额度卡片的 `Check in now`、`magpie accounts
checkin`、Settings › Daily check-in › Plugins 的自动开关，三者都实测对 loomy 生效）。
于是签约当天顺手补领没领的任务：**已领完的账号一次请求都不发**（8 项全 `true` 时
只读一次任务表），每天最多多一次只读。

- **幂等判据是响应体的 `alreadyCompleted`**，不是 HTTP 码、不是 `code`；重放算成功。
- **不采信服务端 `earned`**（JetHub 见它与本地表不一致），按本地表现算。
- **中途被拒就停**：`100002` 立即停手，不再对剩余 key 发请求（否则是 7 个必失败
  请求），并把中断原因写进 message。
- **任务分不进 `credit`**：`credit` 会被读成「今日发放」，把 10000 永久积分报在那儿
  等于谎报每日额度。任务情况只写 `message`，`credit` 仍只算当日额度。
- **`100002` 仍抛 `SignInExpiredError`**，让宿主标记账号需重新登录（和签到同一条规则）。

**在卡片上看得见，并顺手领掉（`tasks.ts`）。** 签到返回的 `message` 宿主只在
**失败**时显示：`usageOf` / CLI 的签到输出对 `claimed` / `done` 只拼 `credit` 与
`streak`，不拼 `msg`（读自 magpie 0.1.1254 的 `plugin-host` 与界面字符串）。于是
`usage` 里另起一行读 `GET /onboarding/tasks`，按账号缓存 10 分钟
（`LOOMY_TASKS_TTL_MS`，usage 每次刷新都会走到这里），还有没领的就多一个
`aside: true` 的窗口：

```
新手任务 2/8 · 已领 1500 / 还有 8500 分可领
```

不带 `limit` / `amount`（否则卡片会画成"池子被花掉多少"的进度条），8/8 领完时
这一行不出现。读失败只是一个 `undefined`，不影响额度卡片本身。

**默认识别到未完成就自动领取。** 宿主自己画用量卡片，**不给插件任何可按的东西**：
窗口是纯展示对象（`{name, used, display, …}`，没有 action/button 字段），而签到行
的两个按钮（`自动签到` / `立即签到`）在账号「今日已签到」后就消失——也就是说
「已签到 + 任务没领」这个组合在界面上没有入口。所以本包把领取放在**必然会跑到的**
`usage` 上：读到还有未完成就顺手领掉，同一次刷新的卡片读数直接变成 8/8、那一行随之
消失。用户不需要点任何东西，这也是「按钮」在这里唯一可能的等价物。

- 只在**读到有未完成**时才尝试；读数 10 分钟缓存一次，所以最多 10 分钟一次尝试。
- 领取是幂等的（已领完的账号 0 个请求）；被拒时停下、记下已领的部分，等读数过期再试。
- `options.claimTasks: false` 关掉它，让 `usage` 回到严格只读。默认开启。

### 已知限制

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

## 4. TRAE（字节跳动）

`provider id = trae-cn`，显示名 `TRAE (字节)`。**第一版只做国内版客户端**：JetHub 另有一个
国际版（`trae-intl`，域名与 client_id 都不同），本包暂不接入，理由见 §5 未验证边界。

### provider id 与既有 TRAE 插件的登录迁移

magpie 的登录态**按 provider id 存**：`~/.config/magpie/plugin-auth.json` 里第一个账号占
`trae-cn`，第二个起是 `trae-cn#<slot>`（`internal/plugin/host.js` 的 `accountsOf`）；请求、
`getAuth()`、`loader` 都在「这个 provider 的这个账号」作用域里跑，宿主**没有**读别的
provider 账号的接口（`getAuth` 就是 `readAuth()[key]`，key 是本 provider 的账号键）。
而一个 provider 由**哪个插件服务**是可选的：`magpie plugin use <插件> <provider>` 把它记进
`plugins.json` 的 `prefer`，两个插件声明同一个 id 时，一个负责登录、一个负责服务。

于是「magpie 里已有的 TRAE CN 登录能不能一键迁移」的答案就是 id 是否相同。既有的
`@magpie-community/opencode-trae-auth`（0.2.14）登录的正是 `trae-cn`（国际版为
`trae-global`），它存下来的字段是
`access` / `refresh` / `expires` / `accountId` / `uid` / `deviceId` / `machineId`（另有
`clientId` / `api` / `host` / `authHost` / `region` / `account` 等本包不读的字段），与本包
`session.ts` 读的那一组一致——所以本包声明 `trae-cn` 之后，那家插件登录过的账号直接可用，
连设备指纹都是同一个（签到是按设备限次的，这一点重要）。magpie 自己的
`plugin move`（内置 `zcode` / `workbuddy` 订阅转社区插件、账号仍留在同名 id 下）就是同一
套机制。

代价与边界写在这里：0.7.x 的 `trae` 账号（本包自己对国内版的旧 id）不会被读取，需要重新
登录一次；反过来，装了那家插件时想由本包服务 `trae-cn`，要么跑一次
`magpie plugin use opencode-cn-ai-auth trae-cn`，要么在插件页里改「服务方」。

这一家与另两家的根本区别：**Trae 不是 OpenAI 兼容通道**。Loomy / Raccoon 只需注入请求头
（Raccoon 再加一个 `extra_body` 字段），协议转换由宿主完成；Trae 的请求体与流式响应都要
本包改写。因此它有另两家没有的模块（`api.ts` 的 wire 解析、`wire.ts` 的双向改写），也有
另两家没有的两类约束：**请求体必须转换**、**响应流必须转换**。

### 端点与协议

| 用途 | 方法 | 路径 | Host | 认证 |
|---|---|---|---|---|
| 对话 | POST | `/api/agent/v3/llm_utils_chat` | `trae-api-cn.mchost.guru` | `Cloud-IDE-JWT` |
| 模型目录（单通道） | POST | `/api/ide/v1/get_detail_param` | 同上 | 同上 |
| 模型目录（**多通道**） | POST | `/api/ide/v1/batch_get_detail_param` | 同上 | 同上 |
| 换 token | POST | `/cloudide/api/v3/trae/oauth/ExchangeToken` | `api.trae.com.cn` | 用 refreshToken |
| 用户信息 | POST | `/cloudide/api/v3/trae/GetUserInfo` | 同上 | `Cloud-IDE-JWT` |
| 签到状态 | POST | `/trae/api/v2/ug/checkin_credits/status` | `api.trae.cn` | `Cloud-IDE-JWT` |
| 签到领取 | POST | `/trae/api/v2/ug/checkin_credits/claim` | 同上 | 同上 |
| 积分余额 | POST | `/trae/api/v2/pay/ide_user_ent_usage` | 同上 | 同上 |

出处：JetHub `src/trae.ts` / `src/trae-product.ts`（0.4.2，MIT），其协议转引自 `trae2api`（Go）
与 `trae-mate`；`docs/conventions.md` §6 的「每个端点只在 `product.ts` 写一次」在本包由
`TRAE_PATHS` 承载。

### 三条实测结论（写反了不会报错）

1. **`function` 是通道，不是装饰**。同一个模型只在列出它的通道里可调用，发错通道会在
   **流内**回 `4001 param is invalid`（JetHub 2026-09-19 逐模型 × 逐通道实测）。因此
   `provider.models` 把每个模型来自哪个通道记在 `catalog` 里，聊天请求再按模型回放
   （`wire.ts` 的 `function` 字段）。缺省通道 `solo_work_lite` 只是兜底。
2. **请求体必须转换，不能透传**。`stream` 强制 true；`model` 与 `config_name` 双写；
   字符串 `content` 变 `[{type:"text"}]`；assistant 的 `tool_calls[].function` 改名
   `function_call`；**`tools[].function.parameters` 必须序列化成 JSON 字符串**（上游要求
   string，OpenAI 要求 object）。最后一条尤其隐蔽：写在转换之后赋值不会生效，参数会以
   object 形态发出并被拒。
3. **响应是 SOLO 私有 SSE，不是 OpenAI chunk**。事件名 `output` / `token_usage` /
   `done` / `error`（另有 `metadata` / `timing_cost` / `extra_info`，本包不消费）；正文在
   `output.response`、思考在 `output.reasoning_content`；工具调用内层同样用 `function_call`
   且带 `namespace` / `partial_arguments`，必须清掉。解析要兼容 `data:{...}`（无空格）。

### 登录

浏览器授权 + **本机回环回调**（`src/vendors/trae/login.ts`）。插件先起一个一次性本地页
（`core/local-page.ts`，绑 `127.0.0.1:0`，URL 带随机前缀），把回调地址作为
`auth_callback_url` 参数发给 `www.trae.cn/authorization`，用户在浏览器完成授权后浏览器被
重定向回本地页，插件在那一跳里换凭据。

三个曾经让流程「卡在授权中」的点，都是参数或形态写错：

- 回调参数名是 **`auth_callback_url`**；`callback_url` / `redirect_uri` 会被忽略。
- 回调可能**直接回传 token**（`refreshToken` + `userInfo` / `userJwt` 两个 URL 编码
  JSON），也可能回一个**授权码**（`authCodeInfo.AuthCode`）——两条都要认，见下。
- 回传授权码时，必须用**本次登录自己生成的 PKCE 校验串**去换取令牌。

#### PKCE 是当前客户端唯一的通道（2026-10-16 定位）

用户报障「点登录就显示登录失败 / 网络错误，请刷新页面重试」。这是**控制台自己的页面**
给出的状态，不是本机回调页：把那串 URL 交给无头 Chrome 跑一遍可以确认控制台只会在
`GetRefreshToken` / `ExchangeToken` 成功之后才 `window.location.href` 跳到我们的回调，
所以那个错误发生时本机一个请求都没收到（探针实测：0 个请求）。

对照本机安装的官方客户端（`/Applications/Trae CN.app`，1.107.1，`product.json`）后，
差异是**它走 PKCE，而我们走的是老流程**：

| 项 | 官方客户端 | 本包（修复前，抄自 JetHub） |
|---|---|---|
| 授权参数 | `code_challenge` + `code_challenge_method=S256` | **没有** |
| `plugin_version` | `tronBuildVersion` = `2.3.91092` | `2.3.62834` |
| `x_app_version` | `appVersion` = `3.4.2` | `0.1.52` |
| `client_id` | `authConfig.SOLO.stable` = `en1oxy7wnw8j9n` | 同值（这一项没错） |
| 换令牌 | `POST {host}/trae/api/v3/oauth/ExchangeToken`，体 `{ClientID, AuthCode, CodeVerifier, IDEVersion}` | 走 `cloudide/...` 的 refreshToken 老端点 |

少了 `code_challenge` 时，控制台页面走到它那条老分支（`GetRefreshToken` → 用 refresh
token 换令牌），而这条分支现在会失败——页面把任何失败都渲染成同一句「请检查是否开启了
网络代理」，所以看起来像网络问题。本包现在按官方客户端构造 URL 并发起 PKCE 换取；老的
refreshToken 回调仍然认，作为兜底。

`IDEVersion` 用官方客户端的 `appVersion`（3.4.2）而不是 `0.1.52`：后者是 JetHub 时代
抄来的构建号。

#### 回调地址的形状也是硬约束（同一批实测）

控制台页面在挂载时先校验回调地址：

```js
if (!$ || !Z || !/^http:\/\/127\.0\.0\.1:(\d+)\/authorize$/.test(Z)) { ep(3); return }
```

`ep(3)` 就是「登录失败 / 网络错误」那一屏，而且它发生在 `CheckLogin`、`GetRefreshToken`
之前——所以「本机没收到任何请求」是必然的。无头 Chrome 对照实验（2026-10-16）：

| `auth_callback_url` | 页面 |
|---|---|
| `http://127.0.0.1:18080/<token>/authorize` | 登录失败 / 网络错误，请刷新页面重试 |
| `http://127.0.0.1:18080/authorize` | 正常登录界面（手机号 +86 / 获取验证码 / 抖音 / 苹果 / 企业账号），并跳到 `/login?login_platform=solo&redirect_url=…` |

JetHub 一直用的是根路径 `/authorize`；本包曾把它改成带随机前缀（理由是「回调地址是我们
自己下发的」），那条理由在这里不成立——控制台会校验形状。现在改为 `PageServer` 的
`raw` 模式，并以我们下发的 `login_trace_id` 做校验：控制台会把它原样带回，别的本机进程
伪造的回调对不上。

#### 回调页要能容忍「不是答案的请求」，也要能从粘贴的地址收尾

用户第二次报障的截图是 `127.0.0.1:<port>/authorize?...authCodeInfo=…` 上的
`ERR_CONNECTION_REFUSED`：控制台其实已经成功产出了授权码，只是那一刻本机没人监听。
两个成因都修了：

- **以前任何一次落在 `/authorize` 的请求都会被当成回调**：探活、刷新、favicon 都会让
  插件判定「登录失败」并关掉服务器，随后真正带着授权码的那一跳就打到了死端口。现在只有
  带着答案的请求（`authCodeInfo` / `code` / `refreshToken` / `userJwt` / `error_code` …）
  才算数，其它一律回一页「等待浏览器完成授权」并继续等。
- **宿主提供的粘贴兜底没被用上**。`magpie plugin login` 会提示「把浏览器最后停在的整个
  地址粘回来」，而本包此前忽略 `callback` 的参数。现在粘贴回来的整串地址（或一枚裸
  授权码）会当作一次真实回调处理，仍然校验 `loginTraceID`；浏览器到不了回环地址不再是
  死路。

另外，控制台拒绝授权时会用 `error_code` / `error_msg` 回传（例如设备数超限），现在如实
显示成「控制台拒绝了这次授权（code=20401）：…」，而不是含糊的「回调未携带登录凭据」。

用户昵称在回调里会经 latin-1 误解一次（中文变乱码）。JetHub 的修法是把这个字符串当
latin-1 再解一次 UTF-8；**本包不做这一步**，因为 2026-10-16 实测这一步两头都不成立：
它修不回文档里那个乱码形态（`Óû§8847309959` 解出的是替换字符），却会把本来正常
的名字改坏（`🙂boy` → `=Bboy`、`Москва` → 控制字符、`José` → 替换字符），而这三种
结果都恰好通过了「可打印且无替换字符」这个本该表示「修好了」的判据。因此本包的规则是：
**能打印就原样保留厂商给的名字**，只有空名字或带控制字符时才换成可读占位
（`用户+uid末4位`）。概率上更常见的是后者（回调偶尔给出空昵称）。

### 设备身份（本家最特殊的一处）

登录态里带两个 **32 位 hex** 的设备指纹：

| 字段 | 作用 | 生成时机 |
|---|---|---|
| `machineId` | 上游据它标识设备；换值可能触发重新登录 | 登录时生成，此后**永不重生成** |
| `deviceId` | 签到按**设备**每日一次；同机两账号共用会被「该设备已签到」拦 | 登录时生成，此后**永不重生成** |

续期（`ExchangeToken` 会**轮换 refresh token**）必须把这两个字段原样带回，否则一次续期就
把账号变成「新机器」或让签到额度翻倍。本包在 `api.ts` 的 `applyRefresh` 里显式保留，
并由 `tests/trae.api.test.ts` 钉住。

签到请求本身用的是**另一套派生身份**（不是上面的 `deviceId`）：基于 `uid` 做 SHA-256
确定性派生的 15 位数字 + UUID v4 + 64 hex session id（`api.ts` 的 `seededStream`）。好处是
每个账号天然独立、且插件不需要为签到持久化任何东西。JetHub 把 9074 的自动换设备重试
撤掉了（理由：那等于把「本设备今天已签」伪装成成功），本包沿用。

### 会话与续期

有续期端点，且是**轮转型**：`auth.refresh` 把新的 `access` / `refresh` / `expires` 一起写回
（`refresh_token` 缺省时保留旧值——服务在某些代理后面会省略它，保留旧值才能让账号继续可续期），
同时带回 `machineId` / `deviceId` / `uid`。`refreshLead` 为 5 分钟。

### 模型目录

`batch_get_detail_param` 一次查多个通道，响应 `function_configs[]` 是**每个通道各自一套**
目录。解析与合并规则（`api.ts` 的 `parseBatchCatalog`）：

- 硬性过滤三条，与官方选择器一致：`usage !== "chat_completion"` 剔除、
  `config_switch === false` 剔除、`is_invisible_to_user === true` 剔除。
  ⚠️ `is_custom_model === true`（需自行绑供应商、必然 4001）也在实现里剔除；判据是
  **标志的值，不是模型名**——JetHub 曾据一份过期名单误判，把后来已可用的模型当成该删的。
- 同一模型出现在多个通道时取**信息更全**的一条：能声明推理档位的胜出；都能量则按
  `TRAE_CHANNELS` 的顺序取更靠前者。JetHub 原本是「后面的覆盖前面的」，而上游恰好把最空的
  条目排在最后，导致 13 个模型丢掉推理档位。
- `context_window_tokens.dev` 是常规窗口，`max` 是 1M（需另开 Max 模式），只用 `dev`。
- 倍率来自 `display_contact_config`——它是一个 **JSON 字符串**，不是对象；`rate: 0` 是
  合法值（免费模型）。折扣只在真的降价时报（`discount_type !== "none"`、`before > after`、
  未过期），否则 `before === after` 的 `off_peak` 会显示成「有活动」。

推理档位直接用远端 `reasoning_effort_config.options` 的字符串（那是上游 wire 值），
不做白名单转换。

### 用量卡片与一键签到

积分余额是**包**的形状：`user_entitlement_pack_list[]` 每项给 `quota.credits_limit`（授予）
与 `usage.credits_amount`（已用），剩余即两者之差，总额是各包剩余之和。服务从不公布账号级
上限，因此**每条窗口都是 `aside: true`**（只展示，不参与选号），并由签到状态再加一行
「每日签到 今日可领 N 积分 / 已领取 / 未开放」。

**一键签到**映射到宿主的唯一写钩子 `auth.checkin`：额度卡片的 `Check in now`、
`magpie accounts checkin`、或 Settings › Daily check-in › Plugins 的自动签到，三处都会触发。
流程与几处必须照做的事实：

- 先查 `checkin_credits/status`：活动未开放 → `ineligible`；`checked_in: true` → `done`。
  这一步让「今天已领」不产生任何写请求，自动签到重复触发也不会刷接口。
- 否则发 `claim`（body `{}`）。**claim 响应不含积分数**——实测整份就是
  `{"code":0,"message":"success"}`——所以成功后再查一次 status 取 `credits` 字段，
  以免界面显示「签到成功 +0」。本包在 `credits.ts` 里就是这么做的。
- 业务码 `9074`（当前使用人数太多）如实报失败并给重试提示，**不自动换设备重试**。
- 业务码可能是字符串 `"9074"`（部分网关），只认数字会误判成成功；本包两种形态都读。
- HTTP 401 报登录态失效。

### OpenCode 侧

Trae 也提供 OpenCode V2 子入口（`opencode/trae.ts`）。它与另两家在 OpenCode 上的形态
不同：另两家只需注入请求头，Trae 需要**改写请求与响应**，因此用了适配器的
`bridge`（`opencode/adapter.ts`），改写逻辑与 Magpie 侧共用
`src/vendors/trae/wire.ts` 的同一份函数。

这带来两个只能靠实测确认的前提（登记在 §5 第 16 条）：OpenCode 的
`http.request` / `http.response` 两个 hook 必须允许插件**替换**被交过来的
`Request` / `Response`；OAuth 凭据的 `metadata` 必须能往返保存，因为 Trae 的
`uid` / `machineId` / `deviceId` 三个字段就放在那里。

**签到只在 Magpie 侧**：OpenCode 不消费 `auth.checkin`，所以那边没有一键签到的入口。

### 图标

`TRAE_ICON = https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae_website_prod_cn/favicon.png`
—— 2026-10-16 从 `https://www.trae.cn` 页面声明的 `<link rel="icon" href="…">` 读出。
`HEAD` 回 `200 image/png`、`content-length: 488`，实测字节是 48x48 RGBA PNG（宿主上限
1 MB，尺寸远在界内）。这是厂商在该域名下唯一发布的、可直接取回的 mark：
`/favicon.ico` 回 204、`/logo.svg` 与 `/favicon.svg` 都回 HTML（SPA 兜底），CDN 上的
`logo.png` 是 404。

尺寸说明：48x48 在高分屏上会偏软，但它就是厂商自己声明的那一张。本包不复制品牌资源，
也不自行放大或重绘；若日后厂商发布更大的 mark，换掉这一个常量即可。

## 5. 未验证边界（发布前需知）

以下内容在源码/客户端层面有据，但**没有在 magpie 内实测过**，不要当成已验证事实：

1. 三家厂商的插件都未在 magpie 宿主内跑过真实登录与真实聊天；当前证据是
   `plugin add` 级别的加载与形状检查（见 `developing.md` §3）。Trae 的额外风险单列在
   下方第 11–15 条。
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
10. Loomy 的短信登录**只在一个「已注册过 Loomy」的号码上跑通过**。2026-10-15 在
    magpie 沙箱里用真实号码走完了 `sendMsgCode → checkCode → session`：宿主存下
    32 位 `access` 与 `phone`，`magpie quota` 读到真实额度，`/models`、
    `/points/records`、`/chat/completions` 三个端点都回正常结果。仍未验证的是
    **未注册号码**：`sendMsgCode` 对任意合法号码都回 `000000`（不发短信也回），
    所以「新号码会直接开通账号」这件事没有证据。上线前应拿一个从未登录过 Loomy 的
    号码验一次；若服务其实要求先注册，需要在文档与登录页文案里写明。


11. **Trae 未在 magpie 内跑过真实登录、真实聊天与真实签到**。当前证据是三件事：
   (a) 协议事实来自 JetHub 的 Trae 实现，而 JetHub 自己在真机上验证过这些通道；
   (b) 本包的转换与解析规则由离线测试逐条锁住（`tests/trae.*.test.ts`，含请求体改写、
   SSE 转换、目录合并、签到状态机、回调解析、续期保留设备身份）；
   (c) 插件能通过 `bun run check` 的入口形状与依赖方向门禁。**未做**的是把一次真实
   对话、一次真实签到跑通并比对上游返回值。
12. **Magpie 是否原样消费 loader.fetch 返回的合成 Response（含流式）没有实测**。
   Trae 的整个方案建立在这一点上：`bridgeResponse` 用 `ReadableStream` 现造一个
   `text/event-stream` 响应交回宿主。本包的另两家厂商只改请求体、不改响应，所以这一点
   此前从未被触及。第一次真实聊天前，建议先用一个「返回手写 OpenAI SSE 的 loader.fetch」
   做最小探针；若宿主在这条链路上做了自己的缓冲或校验，需要改成聚合形态（`streamed: false`
   路径已经实现）或另寻通道。
13. **Trae 的回调地址必须是源站根路径的 `/authorize`**（已实测，不再是猜测）：
   控制台用它自己的正则校验，只接受 `http://127.0.0.1:<port>/authorize`，
   端口任意、路径必须是没有前缀的 `/authorize`。带随机前缀时页面在**任何网络请求
   之前**就跳到「登录失败 / 网络错误」那一屏（无头 Chrome 对照实验：同一串参数，
   仅把回调换成 `/<token>/authorize` 就复现失败，换成 `/authorize` 就出现正常登录
   界面）。因此 Trae 用 `PageServer` 的 `raw` 模式（`core/local-page.ts`），并改用
   我们在 URL 里下发的 `login_trace_id` 当作校验（控制台会原样回传它）。端口仍可
   任选，`core/local-page.ts` 绑 `127.0.0.1:0` 由系统分配。
14. **Trae 国际版（`trae-intl`）未接入**。JetHub 有完整实现（域名
   `api5-normal-alisg.mchost.guru` / `api.trae.ai`、独立 client_id、独立 provider id），
   但它的签到实现在 JetHub 里把 host 硬编码成 `api.trae.cn`，国际版是否真有签到、
   走哪个域名，**没有证据**。本包因此只在源码层保留「一家厂商一套 product 事实」的结构，
   等能真机核对时再加第二套 `product`。
15. **Trae 协议是逆向私有接口**，与账号封控和厂商 ToS 风险绑定。本包按「不静默执行有
   副作用的动作」的既有原则，只把签到挂在用户能按的钩子上；但用户仍应知悉这条通道不是
   厂商公开 API。README 的能力表与本节是这件事对外说明的地方。
16. **Trae 的 OpenCode 入口未在真实 OpenCode 里验证**。它依赖两件按 SDK 类型推断、
   未经实测的事：(a) `session.hook("http.request")` 与 `session.hook("http.response")`
   允许插件替换事件里的 `Request` / `Response`（骨架代码 `opencode/adapter.ts` 直接
   给 `event.request` / `event.response` 赋值）；(b) OAuth 凭据的 `metadata` 能往返
   保存 `uid` / `machineId` / `deviceId`。若 (a) 不成立，Trae 在 OpenCode 上无法工作，
   需要改用本地回环 shim（JetHub 与 `dsh-connect-trae` 用的就是那种架构）；若 (b) 不
   成立，这四个字段要改从插件 options / 环境变量读。

发现与上述不符的现象时：先改 `src/vendors/<id>/product.ts` 的常量与本文档，
再补一条回归测试；不要只改实现不留证据。
17. **PKCE 换取令牌的请求体是否够用没有验证过**。本包按官方客户端构造
   `{ClientID, AuthCode, CodeVerifier, IDEVersion}`；官方客户端还额外发一个
   `DeviceInfo` 块（含设备指纹、平台码，以及一对 RSA 公钥/私钥里的**公钥**）。
   服务端是否强制要求它，只有在真机走完一次 PKCE 登录才知道：目前对
   `/trae/api/v3/oauth/ExchangeToken` 的探测（2026-10-16，两个 host 都试过）在没有
   合法 `AuthCode` 时只回 `10101 无效参数`，无法区分「缺 DeviceInfo」与「码是假的」。
   若真机登录报无效参数，第一处要试的就是补上 `DeviceInfo`。

发现与上述不符的现象时：先改 `src/vendors/<id>/product.ts` 的常量与本文档，
再补一条回归测试；不要只改实现不留证据。
