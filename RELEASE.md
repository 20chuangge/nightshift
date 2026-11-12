# Nightshift 发布说明

**版本**：1.2.92
**日期**：2026-11-12

---

## 装哪个

| 你要什么 | 用这个 | 说明 |
|---|---|---|
| Windows 上长期用 | `Nightshift-Setup-1.2.92.exe` | 安装包，装到 `%LOCALAPPDATA%\Programs\Nightshift`，建桌面/开始菜单快捷方式，免管理员，可卸载 |
| 不想装 / 想放 U 盘 | `Nightshift-Portable-1.2.92.exe` | 免安装，双击即用 |
| Android 手机 | `Nightshift-Android-1.2.92.apk` | 侧载安装，允许「安装未知来源应用」即可 |
| iPhone / 临时用 | 浏览器打开电脑上的地址 + 配对码 | 见下「手机」一节 |

桌面端两个 exe 约 80 MB，APK 约 27 MB。Windows 安装包**未签名**（首次运行 SmartScreen 提示「未知发布者」→ 更多信息 → 仍要运行）；APK 用 Android debug key 签名，可直接侧载，但不是商店发布密钥。

数据在 `%APPDATA%\Desk\`（名字沿用 Desk 时期，升级不丢）。卸载不会删它。

---

## 这一版改了什么

- **接管屏幕时复制粘贴中文**：以前从手机往远端贴中文会变成 ?，远端复制的中文到手机上也是 ?；手机 App 在局域网的 http 页面里也拿不到系统剪贴板。
  - 手机 App 和电脑版加了原生剪贴板接口（Android ClipboardManager、Electron clipboard），页面是普通 http 也能读写系统剪贴板。远端复制的文字会自动进手机剪贴板；剪贴板面板里多了「粘贴手机剪贴板」。
  - VNC 的剪贴板通道只能传 Latin-1。中文等其他文字改由那台机器的 Hub 直接写进屏幕自己的剪贴板（X11 用 xclip，Wayland 用 wl-clipboard），远端复制的中文也从那里读回真实文字。英文和数字照旧走画面通道。
  - 机器上没有这个工具时，Hub 自己装一次（免密 sudo）：先直接装，不行就刷新软件源再装，Ubuntu 的官方源连不上时再用安装脚本同款的阿里云镜像（单独的源列表，不改系统的源）。新装的机器由安装脚本直接装好。
  - 剪贴板放不进中文的屏幕（Rocky 10 的 Wayland 屏幕没有键盘设备，wl-copy 用不了）：「发送并 Ctrl+V」改为把文字直接输入到机器人浏览器里光标所在的位置。
  - Windows 远程机器的 Hub 是后台服务，碰不到你看到的桌面的剪贴板，所以不去写；那里中文仍请用「键盘」输入。
  - 实测：Ubuntu 的 Hub 自己装上 xclip（第一次 38 秒，走镜像），中文、引号、& 原样写入再读回；Rocky 把「夜班中文粘贴测试 你好」输入到浏览器里 Bing 的搜索框，读回一致；手机 App 在 http 页面上写入并读回「夜班手机剪贴板 测试✓」。
- **自测**：`npm run smoke` 867 项全绿。新增 12 项：各种屏幕选哪个剪贴板工具、缺工具时的提示和安装方式（不改系统的源）、中文和特殊字符经标准输入原样往返、接口的长度限制、不开浏览器时不会去启动一个、页面在什么情况下走 Hub、两个 App 的原生接口。

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
