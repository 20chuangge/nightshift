# Nightshift 发布说明

**版本**：1.2.63
**日期**：2026-11-11

---

## 装哪个

| 你要什么 | 用这个 | 说明 |
|---|---|---|
| Windows 上长期用 | `Nightshift-Setup-1.2.63.exe` | 安装包，装到 `%LOCALAPPDATA%\Programs\Nightshift`，建桌面/开始菜单快捷方式，免管理员，可卸载 |
| 不想装 / 想放 U 盘 | `Nightshift-Portable-1.2.63.exe` | 免安装，双击即用 |
| Android 手机 | `Nightshift-Android-1.2.63.apk` | 侧载安装，允许「安装未知来源应用」即可 |
| iPhone / 临时用 | 浏览器打开电脑上的地址 + 配对码 | 见下「手机」一节 |

桌面端两个 exe 约 80 MB，APK 约 27 MB。Windows 安装包**未签名**（首次运行 SmartScreen 提示「未知发布者」→ 更多信息 → 仍要运行）；APK 用 Android debug key 签名，可直接侧载，但不是商店发布密钥。

数据在 `%APPDATA%\Desk\`（名字沿用 Desk 时期，升级不丢）。卸载不会删它。

---

## 这一版改了什么

- **接管卡一点即达**：手机上点「接管屏幕」现在会真正滑出面板并进入全屏接管；此前 iframe 已挂载但面板藏在视口外，看起来像没反应。
- **接管工具条**：画面下方常驻 键盘 / Ctrl / Alt / Esc / Tab / 剪贴板 / 旋转 / 预览 八个按钮。「键盘」唤起系统输入法直接往远端打字；不再依赖 noVNC 收起的控制栏。
- **旋转按钮**：全屏时一键把画面转 90°（横向桌面铺满竖屏），工具条保持 upright；再点切回。不锁系统横屏，由用户决定。
- **预览点按进全屏**：实时画面遮罩上加了引导，点画面即进全屏。
- **剪贴板抽屉**：文本框模式（与 Parallels HTML5 / noVNC 内置剪贴板同款）：粘贴进框 → 发送到远端 / 发送并 Ctrl+V / 复制到手机；远端复制的文字自动回填。不读手机剪贴板，http 下也能用。附提示：VNC 标准剪贴板通道是 latin1，中文请直接用键盘输入。
- **关面板即断流**：关闭面板会结束接管并卸载 iframe 与 VNC 连接，不再后台耗流量/电。
- **自测**：`npm run smoke` 730 项全绿。

Android 壳无原生改动；这一版是 Web 端手机接管体验。

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
