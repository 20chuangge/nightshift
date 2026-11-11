# Nightshift 发布说明

**版本**：1.2.74
**日期**：2026-11-11

---

## 装哪个

| 你要什么 | 用这个 | 说明 |
|---|---|---|
| Windows 上长期用 | `Nightshift-Setup-1.2.74.exe` | 安装包，装到 `%LOCALAPPDATA%\Programs\Nightshift`，建桌面/开始菜单快捷方式，免管理员，可卸载 |
| 不想装 / 想放 U 盘 | `Nightshift-Portable-1.2.74.exe` | 免安装，双击即用 |
| Android 手机 | `Nightshift-Android-1.2.74.apk` | 侧载安装，允许「安装未知来源应用」即可 |
| iPhone / 临时用 | 浏览器打开电脑上的地址 + 配对码 | 见下「手机」一节 |

桌面端两个 exe 约 80 MB，APK 约 27 MB。Windows 安装包**未签名**（首次运行 SmartScreen 提示「未知发布者」→ 更多信息 → 仍要运行）；APK 用 Android debug key 签名，可直接侧载，但不是商店发布密钥。

数据在 `%APPDATA%\Desk\`（名字沿用 Desk 时期，升级不丢）。卸载不会删它。

---

## 这一版改了什么

- **轻量桌面空着时会说明**：新机器的机器人屏幕只有 openbox，没有任务栏和图标，空着时是一片灰色。现在画面中间会写着「空着是正常的，机器人打开程序时窗口会出现在这里」，接管后在空白处点右键能打开菜单。
- **缺少屏幕组件时，提示用这台机器自己的安装命令**：Rocky、RHEL 这类系统给出 dnf 命令，不再写 apt。
- **自测**：`npm run smoke` 796 项全绿；远程安装模拟 30 项全绿；中英翻译 1330 条齐全。

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
