# 第三方来源与许可（THIRD_PARTY_NOTICES）

本文件记录本包包含或引用的第三方材料，供分发与合规核对。文中每一条都对应仓库里可核对的
文件或路径；无法核实的部分会明说，不做推测。

## 本包许可

本包以 **MIT** 许可发布，全文见 `LICENSE`（Copyright (c) 2026 opencode-cn-ai-auth
contributors）。

## 二维码编码器 `src/core/qr.ts`（移植）

- **来源**：JetHub 插件包 `dsh-codearts-auth` v0.4.2（本地检出路径
  `/Users/guobinbin/.dsh/plugin-src/Jet-Hub`）的 `src/raccoon-qr.ts`。
- **来源许可**：MIT，Copyright (c) 2026 Jet（见 JetHub 包内 `LICENSE`）。
- **移植方式**：按本包的命名与注释习惯重写，算法未改；来源文件声明算法依据
  ISO/IEC 18004，结构与 Nayuki 的 MIT 参考实现一致。
- 这一关系写在 `src/core/qr.ts` 的文件头注释里，本文件是同一条记录的对外版本。

## 厂商协议事实（来自 JetHub 源码的阅读与移植）

Loomy（讯飞）与 Raccoon（商汤小浣熊）的协议事实——端点路径与请求信封、请求头、
签名与加密方式、模型目录与倍率解析规则、积分/额度与新手任务语义、登录流程的每一步——
来自对 JetHub（MIT，同上）源码的阅读与移植：

- Loomy：`src/loomy*.ts`
- Raccoon：`src/raccoon*.ts`

这些都是厂商线上服务的接口事实（事实性数据，不是受保护的表达），本包以自己的代码与
注释重写。除 `src/core/qr.ts` 外，本包没有按文件拷贝 JetHub 的源码；逐项来源（哪个值
取自哪个文件、哪些属于本包的假设）记录在 `docs/vendors.md`。

## 厂商密钥：内嵌一组，其余由使用者提供

本包**内嵌一组厂商客户端常量**，除此之外不含任何厂商密钥：

- **Loomy 客户端 AccessKey**（`accessKeyId` / `accessKeySecret`）：**随包内嵌**在
  `src/vendors/loomy/bundled-credentials.ts`，用于 `account.xfinfr.com` 的签名请求
  ——微信扫码登录，以及首次扫码后的手机号绑定。这对值随官方 Loomy 桌面客户端分发，
  任何人从客户端里都能读出同一对值，**不是使用者的账号凭据**；但它属于厂商，厂商旋转
  或吊销它会让这条登录路径失效，届时需要同步更新本包。
- **讯飞账号 AccessKey**（仅用于可选的独立短信登录）：**不内嵌**，必须由使用者提供
  ——写进插件条目的 options（`accessKeyId` / `accessKeySecret`），或设为环境变量
  `LOOMY_XFYUN_ACCESS_KEY_ID` / `LOOMY_XFYUN_ACCESS_KEY_SECRET`。
- **商汤手机号加密密钥**（`phoneCipherSecret`）：**不内嵌**，必须由使用者提供——写进
  插件条目的 options，或设为环境变量 `RACCOON_PHONE_CIPHER_SECRET`；未配置时短信登录
  方式不注册。

以上取值顺序的实现见 `src/core/credentials.ts`，变量名与从哪里读见 `docs/vendors.md`，
内嵌这一组常量的取舍与风险见 `docs/conventions.md` §7。

## 运行时从第三方加载、未随本包分发

- Raccoon 的登录页会在浏览器里从阿里云 CDN 加载
  `https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`（常量见
  `src/vendors/raccoon/product.ts` 的 `script` 字段）。该滑块由厂商流程要求，本包既不
  打包也不修改它，因此这里不对它的许可证作声明。
- `config.provider[].npm` 里的 `@ai-sdk/openai-compatible` 是**宿主要安装的适配器名**
  （magpie / OpenCode 侧的依赖），不是本包的依赖；本包的 `package.json` 只有
  devDependencies。

## 其它

- 本包没有运行时 npm 依赖；`src/core/qr.ts` 不 import 任何模块（零依赖实现）。
- 除上述来源外，本包没有使用其它第三方代码。
