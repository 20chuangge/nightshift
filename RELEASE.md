# Nightshift 发布说明

**版本**：1.2.104
**日期**：2026-11-12

---

## 装哪个

| 你要什么 | 用这个 | 说明 |
|---|---|---|
| Windows 上长期用 | `Nightshift-Setup-1.2.104.exe` | 安装包，装到 `%LOCALAPPDATA%\Programs\Nightshift`，建桌面/开始菜单快捷方式，免管理员，可卸载 |
| 不想装 / 想放 U 盘 | `Nightshift-Portable-1.2.104.exe` | 免安装，双击即用 |
| Android 手机 | `Nightshift-Android-1.2.104.apk` | 侧载安装，允许「安装未知来源应用」即可 |
| iPhone / 临时用 | 浏览器打开电脑上的地址 + 配对码 | 见下「手机」一节 |

桌面端两个 exe 约 80 MB，APK 约 27 MB。Windows 安装包**未签名**（首次运行 SmartScreen 提示「未知发布者」→ 更多信息 → 仍要运行）；APK 用 Android debug key 签名，可直接侧载，但不是商店发布密钥。

数据在 `%APPDATA%\Desk\`（名字沿用 Desk 时期，升级不丢）。卸载不会删它。

---

## 这一版改了什么

- **iPhone 主屏幕 App 的顶部、底部和输入（在真机上调好）**：这次通过 Safari 网页检查器直接读了 iPhone 15 Pro Max（iOS 27.2）上的页面，找到了原因。从主屏幕打开时，iOS 把网页从屏幕最顶上（时钟后面）开始画，却把高度少报了一个状态栏（873 / 932），底部那一条由系统自己画、用来放横条。
  - **上面点不到**：顶栏（聊天页）和全屏的设置页、页面查看器现在都从时钟下面开始，返回箭头和 ☰ 都能点到；时钟下那条 iOS 磨砂层后面是实心底色，不再透出模糊的文字。
  - **底部**：页面排到系统那一条的上方，输入框不再被挡；底部横条已经在系统那一条里，不再重复留空。页面固定不动，不会被整体推上去。
  - **打字时页面变宽**：iPhone 上输入框字号小于 16 时，一输入就会把整页放大，右边出屏。iPhone 上的输入框现在都是 16。
  - 这些改动在夜班的网页里，按 iOS 报告的数值和屏幕尺寸判断，不是只对这一台手机：所有 iPhone 从主屏幕打开都生效；状态栏高度按各机型补齐（灵动岛机型 59–62，刘海机型 44–50）；Safari 浏览器里打开不受影响。
- **Android 打包（GitHub Actions）恢复**：之前全部失败的原因是 GitHub 账户计费被锁；解锁后又发现安装 Android SDK 时要的旧组件 `tools` 已经不存在，改成只装 `platform-tools`，Node 升到 22。现在每次推送都会自动出一个 APK。iOS 工作流先停着（需要 Apple 开发者账号）。
- **自测**：`npm run smoke` 932 项全绿，新增 2 项。

---

## 第一次使用

1. 双击 `Nightshift.exe`（或安装后的快捷方式）。窗口打开，模型默认是 `mock · 演示`。
2. 点右上角 **⚙** → 填 **Provider**（OpenAI 兼容端点）、**Base URL**、**Model**、**API Key** → **保存** → **测试连接**。
   - DeepSeek：`https://api.deepseek.com/v1`，模型 `deepseek-chat`
   - OpenAI：`https://api.openai.com/v1`，模型 `gpt-4o-mini`
   - 本地 Ollama / vLLM：填你自己的 `http://127.0.0.1:11434/v1`
3. 回到对话，直接说话。高风险动作会停下来等你批准。

## 手机

1. 电脑上 ⚙ → **配对**，能看到局域网地址和 **8 位配对码**。
   - 如果只显示 `127.0.0.1`，说明只监听了本机：用 `ASSIST_ALLOW_REMOTE=1` 重启，或在设置里打开「手机和外网」。
2. 手机浏览器打开该地址输码，或在 Android App 里扫码 / 填地址 + 码。
3. 装好 App 并配对后，它会在后台保持一条事件连接：任务做完、或助手停下来等你确认时，通知会到手机上。审批通知上的「批准 / 拒绝」直接生效。

---

## 已知限制

- **安装包未签名**：SmartScreen 会警告。正式分发需要 OV/EV 证书。
- **不是沙箱**：工作区外只是路径策略，shell denylist 是正则；审批防手滑，不防恶意模型。
- **手机端还没有附件和语音**：选图、拖文件、录音目前只能在网页端 / 桌面端用。
- **公网访问要自己加一层**：Hub 的鉴权是配对码 / 令牌，暴露公网前请套 Tailscale 或 Cloudflare Tunnel。
- **审批「可恢复」≠「可续跑」**：无人值守任务在重启后只记录决策，需要重跑。
- **记忆不压缩**：只追加，召回靠关键词 + 时间衰减。

## 从源码构建

```bash
npm install
npm start                  # 服务 + 网页界面 http://127.0.0.1:4390
npm run desktop:build      # Windows 安装包 / 免安装 → desktop/dist/
npm run smoke              # 全量自测
```

Android 需要 JDK 21 + Android SDK，步骤见 `docs/BUILD-MOBILE.md`。
