# Nightshift 发布说明

**版本**：1.2.60
**日期**：2026-11-11

---

## 装哪个

| 你要什么 | 用这个 | 说明 |
|---|---|---|
| Windows 上长期用 | `Nightshift-Setup-1.2.60.exe` | 安装包，装到 `%LOCALAPPDATA%\Programs\Nightshift`，建桌面/开始菜单快捷方式，免管理员，可卸载 |
| 不想装 / 想放 U 盘 | `Nightshift-Portable-1.2.60.exe` | 免安装，双击即用 |
| Android 手机 | `Nightshift-Android-1.2.60.apk` | 侧载安装，允许「安装未知来源应用」即可 |
| iPhone / 临时用 | 浏览器打开电脑上的地址 + 配对码 | 见下「手机」一节 |

桌面端两个 exe 约 80 MB，APK 约 27 MB。Windows 安装包**未签名**（首次运行 SmartScreen 提示「未知发布者」→ 更多信息 → 仍要运行）；APK 用 Android debug key 签名，可直接侧载，但不是商店发布密钥。

数据在 `%APPDATA%\Desk\`（名字沿用 Desk 时期，升级不丢）。卸载不会删它。

---

## 这一版改了什么

- **通知指向正确的电脑**：通知携带来源机器的地址和审批 id。手机配过两台电脑时，从哪台发来的审批就打开哪台的界面，并定位、高亮那张审批卡；此前一律打开最近使用的那台。
- **通知里直接批准 / 拒绝**：审批通知带两个动作，不用打开 App 就能答复。答案由一个不可导出的接收器直接 POST 给 Hub，设备令牌只在 App 私有存储里读取，不进入任何 Intent。
- **送不出去就回退**：断网或令牌失效时，通知会变成「这一步还没答复」，点开进入审批卡，不会把决策悄悄丢掉。
- **审批来源进审计**：来自手机设备令牌的决定在 `data/audit.jsonl` 里记为 `by: "device"`，本机浏览器记为 `human`。
- **Android 构建链**：CI 与文档统一到 JDK 21（Capacitor 7 的库按 Java 21 编译）；手机端显示名统一为 Nightshift；APK 版本号（`versionName` / `versionCode`）跟随仓库版本，不再固定 `1.0.0`。
- **连接页修正**：连接页底部显示真实版本（此前是 `v1.0.0`）；选择机器页探测离线设备时不再抛空元素错误。
- **自测**：Windows 默认检出（CRLF）与 LF 检出都是全绿，断言覆盖通知深链与通知内答复。

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
