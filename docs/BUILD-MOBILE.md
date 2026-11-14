# 留灯 Lamplit 移动端打包

桌面端是「Node 服务 + 单文件 UI」。手机端要解决的就两件事：**连上哪台电脑上的留灯**，以及**把一个能装到手机上的包做出来**。

这个仓库里 `mobile/` 是 Capacitor 外壳（Android + iOS 原生工程已生成并入库），`public/` 是那份单文件 UI。本文档把三条落地路径、签名、CI、以及上架时真正会卡住的地方写清楚。

> 仓库**不提交** APK/IPA 产物。产物只有两种来路：装了工具链的机器上本地构建（JDK 21 + Android SDK），或者 GitHub Actions。本地构建的命令见 §2，装好工具链后可直接产出可安装的 APK。

---

## 0. 先选连接模式：为什么是「webview 直接加载 Hub」

Capacitor 的两种做法只有一种是能用的：

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| **(a) server.url 模式** | webview 顶层直接加载 `http://<hub>:<port>`，UI 和 API 都来自 Hub | ✅ **本项目采用** |
| (b) 本地 UI + 绝对 API | 本地打包 UI，所有请求打到 `http://<hub>:<port>/api/...` | ❌ 现在不可行 |

(b) 不可行的原因是硬的，不是偏好：

1. **CORS 只对原生 App 的 origin 放行，且只认 Bearer**。`src/server.mjs` 对 Capacitor 的固定 origin 回 `Access-Control-Allow-Origin` 并处理 `OPTIONS`，但这套规则是为"启动器自己的 fetch"准备的，不是为一份跨源 UI 准备的：UI 的每个请求还得带 `Authorization`，而 `EventSource` 无法加请求头，`/api/stream` 就是 SSE。要在本地 UI 里跑完整界面，得改 `public/` 的传输层（不在本任务写范围内）。
2. **UI 里的相对路径改不了**。`public/index.html` 里是 `api('/api/health')`、`new EventSource('/api/stream')` 这样的相对地址，改写成绝对地址意味着改 `public/`（也不在写范围内）。
3. **配对鉴权只认两种凭证**：`Authorization: Bearer <token>` 和 `Cookie desk_session`（见 `src/auth.mjs`）。前者需要能给每个请求加头——在 iframe/本地 UI 里做不到；后者是 `HttpOnly; SameSite=Lax`，**跨站 iframe 根本不会带上**（顶层站点是 `localhost`，iframe 是 `192.168.x.x`，属于 cross-site），也就是说即使把 Hub 塞进 iframe，里面的 UI 会永远停在配对页。

(a) 把 Hub 作为**顶层文档**加载，上述三条全部消失：同源、相对路径天然正确、`SameSite=Lax` 的 cookie 正常发送、配对页能以第一方身份调 `POST /api/pair` 并落 cookie。代价是 Android 必须允许明文 HTTP（下文签过名），以及外壳要从"浏览器"退化成"启动器"。

**所以 `mobile/www/index.html` 是一个启动器（launchpad），不是 UI 本体**：

1. 首次打开：填 Hub 地址（可顺带填配对码）→ 探活 → 记住地址 → `location.assign("http://<hub>:<port>/?pair=<code>")`。
2. Hub 的 UI 是第一方文档，`?pair=` 被它自己消费掉、落 cookie，之后就是桌面端那份界面。
3. 想换 Hub：Android 按返回键（外壳打了原生补丁，见下）；iOS 退出 App 再打开——启动页永远是启动器。

<img src="./../mobile/docs/connect-screen.png" width="300" alt="连接你的留灯" /> <img src="./../mobile/docs/hub-remembered.png" width="300" alt="已记住你的留灯" />

> 关于「token 存不存 Preferences」：**不存**。session token 是 `HttpOnly`，页面脚本读不到；Hub 又不发 CORS 头，启动器也无法用自己的 `fetch` 换到它。启动器只存 Hub 地址（`@capacitor/preferences`，key `desk.hubUrl`），凭证由 Hub 自己的配对页在第一方上下文里拿。这是后端鉴权模型决定的，不是省事。

### Android 的两个必要改动

1. `android/app/src/main/AndroidManifest.xml`：`android:usesCleartextTraffic="true"`。
   Android 9 (API 28) 起默认禁止明文 HTTP，而 Hub 就是 `http://192.168.x.x:4390`。**上架影响见 §5**。
2. `android/app/src/main/java/com/desk/assistant/MainActivity.java`：覆写 `onBackPressed()`，当 WebView 不在本地外壳页时回退到外壳页。
   没有这个补丁，用户在 Hub 界面按返回键会直接退出 App，等于再也回不到"换 Hub"。

iOS 侧对应的是 `ios/App/App/Info.plist` 里的 `NSAppTransportSecurity.NSAllowsArbitraryLoads = true`（同样是明文 HTTP 的需要）+ `NSLocalNetworkUsageDescription`（局域网访问说明）。**上架影响见 §5。**

---

## 1. 路径一：PWA（最快，零安装）

Hub 本身已经把 PWA 的料备好了：`public/manifest.json`、`public/sw.js`、`public/offline.html`、`public/icons/*`，页面里也注册了 service worker。

**但有个决定生死的前提**：service worker / 可安装性要求 **secure context**，即 `https://` 或 `http://localhost`。**手机通过局域网访问 `http://192.168.1.4:4390` 不是 secure context**，SW 不注册，"添加到主屏幕"只会得到一个普通书签——没有离线壳、没有独立窗口。这一点在 `public/sw.js` 顶部注释里也写了。

所以 PWA 这条路要先把 Hub 放到 https 后面，二选一：

### 1.1 Tailscale Serve（推荐：不出公网）

```bash
# 电脑与手机都登录同一个 tailnet
tailscale up
# 把本机 4390 暴露成 tailnet 内的 https 名字
tailscale serve --bg 4390
tailscale serve status          # 拿到 https://<machine>.<tailnet>.ts.net
```

手机浏览器打开那个 `https://...ts.net` → 菜单里「添加到主屏幕」。iOS 用 Safari（Chrome 在 iOS 上没有安装入口），Android 用 Chrome。

注意：`tailscale serve` 是 https 终结在 Tailscale 侧，Hub 仍然只听回环也没关系（不需要 `ASSIST_ALLOW_REMOTE`）；但如果走 `tailscale funnel`（公网）就必须自己加访问控制。

### 1.2 Cloudflare Tunnel（要公网可达时）

```bash
cloudflared tunnel create desk
cloudflared tunnel route dns desk desk.example.com
cloudflared tunnel run --url http://127.0.0.1:4390 desk
```

**一定要在 Cloudflare Access 后面**：Hub 的鉴权是"配对码/cookie"，暴露到公网等于把配对码暴露给全网爆破（虽然有 5 次/分钟限流）。Access 策略 + Hub 自身的配对是两道锁。

### 1.3 PWA 的边界（说实话）

- 装出来的图标、standalone 窗口、离线壳都是真的；但 iOS 上的 PWA 没有推送（16.4 起有 web push，但对"本机 4390 服务"意义不大）、后台会被杀掉、`navigator.clipboard` 等部分 API 受限。
- 优点是**零工具链、零商店、零签名**。对个人自用，这条路的性价比最高。

---

## 2. 路径二：本地原生构建

### 2.1 两个平台共同的准备

```bash
cd mobile
npm ci                 # 安装 Capacitor CLI/核心/插件
npm run sync:www       # ../public -> mobile/www（含启动器）
npx cap sync           # 同步到 android/ 和 ios/
```

`sync:www` 会把 `public/` 原样拷到 `mobile/www/ui/`，启动器同时提供"预览内置界面"入口——它验证的是"这次外壳里到底打进了哪份 UI"，因此在 CI 里也是一道便宜的一致性检查。

### 2.2 Android

需要：**JDK 21** + **Android SDK**（`ANDROID_HOME`，装 platform 35 / build-tools 35 / platform-tools）+ 一个能联网的 Gradle（首次会下 Gradle 8.11.1 和依赖）。Capacitor 7 的库按 Java 21 编译，JDK 17 会在 `compileDebugJavaWithJavac` 报「无效的源发行版：21」。

```bash
cd mobile
npm run sync:www && npx cap sync android
cd android
./gradlew assembleDebug            # 产出 app/build/outputs/apk/debug/app-debug.apk
# 安装到手机
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Windows 上把 `./gradlew` 换成 `gradlew.bat`。也可以在 Android Studio 里打开 `mobile/android` 直接 Run。

**签名（release）**：签名材料**不入库**，全部通过环境变量注入，`android/app/build.gradle` 已经在读：

| 变量 | 含义 |
| --- | --- |
| `DESK_KEYSTORE` | keystore 文件路径（`.jks` / `.keystore`），必填 |
| `DESK_KEY_ALIAS` | 别名，必填 |
| `DESK_KEY_PASSWORD` | key 密码，必填 |
| `DESK_STORE_PASSWORD` | keystore 密码，可选，默认同 `DESK_KEY_PASSWORD` |
| `DESK_VERSION_CODE` | versionCode 覆盖（默认由仓库 `package.json` 版本推出：`major*10000+minor*1000+patch`） |
| `DESK_VERSION_NAME` | versionName 覆盖（默认即 `package.json` 的版本） |

三个必填项齐全时 `assembleRelease` 出签名包；缺任意一个就出 **unsigned** 包（`app-release-unsigned.apk`）而不是报错。生成 keystore：

```bash
keytool -genkeypair -v -keystore desk-release.jks -alias desk \
  -keyalg RSA -keysize 2048 -validity 10950
# 备份 desk-release.jks！丢了就再也无法给同一个应用发更新
```

```bash
export DESK_KEYSTORE=$PWD/desk-release.jks DESK_KEY_ALIAS=desk DESK_KEY_PASSWORD=...
cd mobile/android && ./gradlew assembleRelease
# mobile/android/app/build/outputs/apk/release/app-release.apk
```

`mobile/.gitignore` 已经忽略 `*.jks` / `*.keystore` / `keystore.properties` / `*.p12` / `*.mobileprovision`。

### 2.3 iOS

**只能在 macOS 上做**，需要 Xcode 15+、CocoaPods、Apple Developer 账号。

仓库里的 `ios/` 是在 Windows 上由 `npx cap add ios` 生成的（Xcode 工程、Podfile、Info.plist 都在），但**没有 `Pods/`，`App.xcworkspace/contents.xcworkspacedata` 也要等 `pod install` 生成**——这是正常的，不要以为是坏的。

```bash
cd mobile
npm run sync:www && npx cap sync ios
cd ios/App && pod install        # 首次/每次改插件后
open App.xcworkspace             # 用 workspace，不是 xcodeproj
```

然后在 Xcode 里配 Signing & Capabilities（Team + Bundle Identifier `com.desk.assistant`），选择真机或 `Any iOS Device (arm64)` → Product → Archive → Distribute App。

命令行等价物见 §3.2 的 CI 步骤（`xcodebuild archive` + `-exportArchive`）。

---

## 3. 路径三：CI 出包（本机什么都不用装）

两个 workflow 都在 `.github/workflows/`。触发方式：push 到 `main`（只改 `mobile/**`、`public/**` 时）、PR、或手动 `workflow_dispatch`。

### 3.1 `.github/workflows/android.yml`

- `ubuntu-latest`，`actions/setup-node@v4`（Node 20）+ `actions/setup-java@v4`（temurin **21**）+ `android-actions/setup-android@v3`
- `npm ci` → `npm run sync:www` → `npx cap sync android`
- **有签名 secrets** → `./gradlew assembleRelease`（签名 APK）
- **没有签名 secrets** → `./gradlew assembleDebug`（debug APK，一样能装）
- 产物：artifact **`desk-android`**，保留 30 天

下载位置：仓库 **Actions → 选一次运行 → 页面底部 Artifacts → `desk-android`**（zip，里面是 `app-release.apk` 或 `app-debug.apk`）。

需要的 secrets（全部可选；全空就是 debug 包）：

| Secret | 用途 |
| --- | --- |
| `DESK_KEYSTORE_BASE64` | keystore 的 base64：`openssl base64 -A -in desk-release.jks -out desk.jks.b64`（比 `base64 -w0` 更跨平台） |
| `DESK_KEY_ALIAS` | 别名 |
| `DESK_KEY_PASSWORD` | key 密码 |
| `DESK_STORE_PASSWORD` | keystore 密码（可省） |

### 3.2 `.github/workflows/ios.yml`

- `macos-14`，Node 20；`npm ci` → `npm run sync:www` → `npx cap sync ios` → `pod install`
- **有签名 secrets** → 导入证书/描述文件 → `xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Release -destination 'generic/platform=iOS' archive` → `xcodebuild -exportArchive -exportOptionsPlist ...` → `Desk.ipa`，可选再 `xcrun altool --upload-app` 直传 App Store Connect
- **没有签名 secrets** → `CODE_SIGNING_ALLOWED=NO` 出一个 **unsigned `.xcarchive`**：能证明代码编得过、能拿去做静态检查，**但不能装到手机上**
- 产物：artifact **`desk-ios`**（`export/*.ipa` 或 `Desk.xcarchive`）

`ExportOptions.plist` 已入库在 `mobile/ios/ExportOptions.plist`，里面 `__TEAM_ID__` / `__PROFILE_NAME__` 由 CI 用 secrets 替换（profile 名字也从 `.mobileprovision` 里读，不用手填）。

需要的 secrets：

| Secret | 用途 |
| --- | --- |
| `CERT_P12_BASE64` | 发布证书 `.p12` 的 base64 |
| `CERT_PASSWORD` | 该 `.p12` 的密码 |
| `PROVISIONING_PROFILE_BASE64` | App Store 描述文件 `.mobileprovision` 的 base64 |
| `PROVISIONING_PROFILE_NAME` | 可选，覆盖从文件里读到的名字 |
| `TEAM_ID` | Apple Developer Team ID |
| `APPSTORE_ISSUER_ID` | App Store Connect API Issuer ID（可选，直传用） |
| `APPSTORE_KEY_ID` | App Store Connect API Key ID（可选） |
| `APPSTORE_PRIVATE_KEY` | `.p8` 文件内容（可选） |

> `altool` 的直传通路在新版 Xcode 里已经废弃/移除，所以那一步是 `continue-on-error`：挂了就下 `desk-ios` 里的 `.ipa`，用 **Transporter.app** 手动上传。

---

## 4. 现在就能拿到 APK 的两条命令

**CI（推荐，本机零依赖）**

```bash
# 1. 推到有 workflow 的仓库
git add mobile .github/workflows docs/BUILD-MOBILE.md && git commit -m "mobile: capacitor shell + CI" && git push
# 2. 打开 Actions → "Android APK" → Run workflow（或直接等 push 触发）
# 3. 运行结束 → Artifacts → desk-android → 解压出 app-debug.apk / app-release.apk
# 4. 手机安装（允许"安装未知来源应用"）
adb install -r app-debug.apk
```

**本地（有 JDK 21 + Android SDK 时）**

```bash
cd mobile && npm ci && npm run sync:www && npx cap sync android \
  && cd android && ./gradlew assembleDebug
# => mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

装好后第一次打开：填 `http://<电脑局域网IP>:4390` + 配对码（电脑终端启动时会打印 `pairing code: xxxxxxxx`，或 UI 的「设置 → 配对」里看），点「连接并打开」。

启动 Hub 的正确姿势（默认只监听 127.0.0.1，手机永远连不上）：

```bash
ASSIST_ALLOW_REMOTE=1 HOST=0.0.0.0 npm start
# Windows PowerShell:
#   $env:ASSIST_ALLOW_REMOTE=1; $env:HOST="0.0.0.0"; npm start
```

---

## 5. 上架清单（以及为什么这个 App 很难上架）

### 5.1 先说风险：Apple 4.2 "Minimum Functionality"

App Store 审核指南 **4.2 Minimum Functionality** 明确拒绝"只是把网站包一层"的 App。留灯的移动端**在审核员眼里就是这种情况**：它是你家电脑上一个服务的客户端，而且审核员**连不上你的 Hub**——打开就是一台空白的连接页。

现实一点的判断：

- **过审概率低**，不是"填个说明就好"。能做的缓解：
  - 提供可演示的账号/环境（比如给审核员一个公网可达的 demo Hub + 配对码，写进 Review Notes）；
  - 加真正的原生能力（推送、Widget、离线队列、生物识别解锁），让它不只是壳；
  - 或者干脆走 **App Store 之外**的分发（TestFlight 内测、Ad Hoc、企业签名、或者 §1 的 PWA）。
- **Google Play 宽松得多**，但也要求可用的审核路径 + 数据安全表单。

**结论**：个人自用 → PWA（§1）或 CI 出的 APK 侧载；真要上架 → 先把 4.2 的产品问题解决（原生能力 + 可演示环境），再谈签名和截图。

### 5.2 Android / Google Play

- [ ] Google Play 开发者账号（一次性 $25）
- [ ] 上传 **AAB**（`bundleRelease`），不是 APK；Play 要求 target SDK 跟上当年要求（本项目 `targetSdk 35`）
- [ ] 签名：**Play App Signing**（上传密钥用本文 §2.2 的 keystore，或让 Google 生成）
- [ ] 隐私政策 URL（即使"数据不出本机"也要填）
- [ ] Data safety 表单：留灯会把对话/记忆存在**用户自己电脑**上；App 本身不收集——如实填写
- [ ] 内容分级问卷、目标受众、截图（手机 + 平板）、图标 512×512、feature graphic 1024×500
- [ ] **明文 HTTP**：`usesCleartextTraffic="true"` 本身不违反 Play 政策，但审核会问"为什么需要明文"。理由要写清楚：Hub 是用户局域网内自建服务，不是公网明文。能改成 https（§1.1）就应该改，并把 manifest 里这个属性删掉
- [ ] 新个人开发者账号有 **12 名测试者 / 14 天** 的封闭测试门槛（2023 起）
- [ ] `versionCode` 每次上传必须递增 → 默认由 `package.json` 版本换算（`1.2.62` → `12062`），每次发版递增

### 5.3 iOS / App Store

- [ ] Apple Developer Program（$99/年）
- [ ] App Store Connect 建 App 记录，Bundle ID `com.desk.assistant`
- [ ] 证书 + App Store 描述文件（§3.2 的 secrets）
- [ ] **ATS 例外说明**：`NSAllowsArbitraryLoads` 需要理由；如果 Hub 走 Tailscale/Cloudflare https，就应该删掉它只留 `NSAllowsLocalNetworking`
- [ ] `NSLocalNetworkUsageDescription` 文案（首次连局域网会弹权限框，用户必须允许，否则连不上）
- [ ] 隐私营养标签（"不收集数据"，因为数据留在用户自己的电脑上）
- [ ] 截图（6.7" / 6.1" / iPad 若支持）、App 预览可选
- [ ] Review Notes：写清这是**局域网客户端**，附 demo Hub 的地址与配对码 + 一段演示视频（这是过 4.2 的关键材料）
- [ ] 出口合规（`ITSAppUsesNonExemptEncryption` = false，因为只用系统 TLS）
- [ ] 版本号：`MARKETING_VERSION`（对 App Store 版本）/ `CURRENT_PROJECT_VERSION`（构建号），在 Xcode 里改，或 `agvtool new-marketing-version 1.0.1`

### 5.4 两个平台的共同注意

- **配对码轮换**：`data/security.json` 里的 code 可轮换；已配对的设备不受影响（存的是 token）。
- **不要在公网裸奔**：`ASSIST_ALLOW_REMOTE=1` 会打印醒目警告。公网暴露一定加隧道 + 访问控制。
- **离线行为**：Hub 不在时，App 只能给出"连不上"页；缓存的数据在 UI 的 service worker 里（仅 https 下）。

---

## 6. 本仓库里到底验证了什么（以及没验证什么）

| 项 | 状态 |
| --- | --- |
| `mobile/` 依赖安装（`npm ci`） | ✅ 本机跑过 |
| `node scripts/sync-www.mjs` 产出 `www/index.html` + `www/ui/` | ✅ |
| `npx cap add android` / `add ios` / `cap sync` | ✅ 本机（Windows）跑过，两个原生工程已生成入库 |
| 启动器逻辑（填地址 → 探活 → 记住 → 打开 Hub → 配对 → 进 UI） | ✅ 真浏览器 + 真 Hub 端到端跑过（截图见上，用的是局域网 IP，走的是真实配对流程） |
| workflow YAML 解析 + 结构检查 | ✅ `npm run verify:yaml`（真 YAML 解析器，不是肉眼） |
| `./gradlew assembleDebug`（JDK 21 + Android SDK） | ✅ 本机（Windows）构建过，debug APK 直接装机验收 |
| 审批通知卡片 → 通知内答复 → Hub 审计 `by: "device"` | ✅ OPPO 真机（1.2.61）：展开是与对话同构的卡片，独立分组不被折叠；两个按钮真实点击后审计记为设备 |
| 其他客户端处理后通知自动清除 | ✅ OPPO 真机（1.2.61）：桌面端拒绝后，手机对应通知按分组消失 |
| 通知深链定位审批卡 | ✅ OPPO 真机（1.2.61）：`?approval=&bot=` 打开对应机器与卡片并高亮 |
| 手机附件（选图 → 上传 → 气泡缩略图 → image_view） | ✅ OPPO 真机（1.2.62）：WebView 里走 Web 端上传链路，系统选择器由 Capacitor 接管 |
| 手机语音（http 局域网下的录音 → 转写） | ✅ OPPO 真机（1.2.62）：原生 MediaRecorder 桥接成 `window.desk`，转写文字落入输入框 |
| `./gradlew assembleRelease` 签名包 | ⚠️ 本机**没有 release keystore**，只能出 unsigned；签名包由 CI 用 secrets 出 |
| `xcodebuild archive` / IPA | ❌ 本机无 Xcode，**IPA 未构建**，只能在 macOS 或 CI 上跑 |
| iOS 真机行为（cookie、ATS、局域网权限） | ❌ 未验证；需真机自测 |

本机工具链在 `D:\ai\deepseek\_tools`（`jdk-21.0.13+9`、`android-sdk`），`mobile/android/local.properties` 指向 SDK。缺的是：release keystore（只存在于 CI secrets 与你的备份里）、Xcode / CocoaPods（Windows 上没有）。

---

## 7. 目录速查

```
mobile/
├── package.json              Capacitor 依赖 + 构建脚本
├── capacitor.config.json     appId com.desk.assistant / appName 留灯 / webDir www
├── scripts/sync-www.mjs      ../public -> www/ui，并写入启动器 + shell-info.json
├── scripts/verify-workflows.mjs  YAML 解析与结构校验（npm run verify:yaml）
├── shell/                    启动器源码（www 由它生成，不要直接改 www/）
├── www/                      生成物：index.html(启动器) / launcher.js / ui/(public 副本)
├── android/                  原生工程（已生成、已入库；签名读 DESK_* 环境变量）
├── ios/                      原生工程（已生成、已入库；Pods 需在 macOS 上 pod install）
└── docs/                     启动器截图（本文档引用）
.github/workflows/
├── android.yml               ubuntu + JDK21 + SDK → desk-android
└── ios.yml                   macos-14 + Xcode → desk-ios
docs/BUILD-MOBILE.md          本文
```
