# Nightshift 发布说明

**版本**：1.2.143
**日期**：2026-11-13

---

## 装哪个

| 你要什么 | 用这个 | 说明 |
|---|---|---|
| Windows 上长期用 | `Nightshift-Setup-1.2.143.exe` | 安装包，装到 `%LOCALAPPDATA%\Programs\Nightshift`，建桌面/开始菜单快捷方式，免管理员，可卸载 |
| 不想装 / 想放 U 盘 | `Nightshift-Portable-1.2.143.exe` | 免安装，双击即用 |
| Android 手机 | `Nightshift-Android-1.2.143.apk` | 侧载安装，允许「安装未知来源应用」即可 |
| iPhone / 临时用 | 浏览器打开电脑上的地址 + 配对码 | 见下「手机」一节 |

桌面端两个 exe 约 80 MB，APK 约 27 MB。Windows 安装包**未签名**（首次运行 SmartScreen 提示「未知发布者」→ 更多信息 → 仍要运行）；APK 用 Android debug key 签名，可直接侧载，但不是商店发布密钥。

数据在 `%APPDATA%\Desk\`（名字沿用 Desk 时期，升级不丢）。卸载不会删它。

---

## 这一版改了什么

- **编程助手加上 Cursor 和 Qoder，每个都能选模型**：机器人能把写代码的活交给这台机器上的 Claude Code、Codex、Cursor、Qoder，用你自己的订阅额度。
  - 设置 → 模型 →「用订阅额度的编程助手」里，每个装好的助手下面多了一个「默认模型」框：Cursor 和 Qoder 会列出你账号能用的模型（它们自己的 `agent models` / `qodercn --list-models`），Claude Code 列出 sonnet / opus / haiku，也可以直接填模型名。留空就用它自己的默认。
  - 机器人交活时也可以临时换一个模型（比如你说「这次用 opus」）；没说就用你在设置里选的。
  - Cursor 用的是 Cursor 命令行版（`agent`），Qoder 优先用 Qoder CN 的 `qodercn`，也认国际版 `qoder`。需要你自己装好命令行版并登录一次；夜班不读它们的登录信息。没装时设置里会显示装法。
  - 任务内容写进任务文件夹里的 `TASK.md`，不会出现在命令行上；没勾「运行命令」时它们只能改这个文件夹里的文件（Cursor 不加 `--force`，Qoder 用 `accept_edits`），勾了才能运行命令。每次交出去之前照样先问你。
- **生图、生视频加上主流服务和模型**：
  - 生图：新增阿里云百炼（通义万相 wan2.5 / wan2.2、Qwen-Image）、智谱 CogView（cogview-3-flash 免费）、MiniMax image-01、Google Imagen 4、自定义（任何 OpenAI 兼容接口）；豆包加上 Seedream 4.5 和 3.0，OpenAI 加上 gpt-image-1-mini，硅基流动加上 FLUX.1-dev。
  - 生视频：新增阿里云百炼（通义万相 wan2.5 / wan2.2，文生视频和图生视频）、MiniMax 海螺（Hailuo 2.3 / 02）、智谱 CogVideoX（cogvideox-flash 免费）；豆包加上 Seedance 1.5 Pro、1.0 Pro Fast 和 Lite 图生视频。
  - 尺寸会按模型自动换成它接受的（比如 gpt-image 只收三种尺寸，Seedream 4.5 有最小像素要求，MiniMax 用宽高比）。
- **语音**：OpenAI 加上 gpt-4o-transcribe / gpt-4o-mini-transcribe，硅基流动加上 TeleSpeechASR，Groq 加上 whisper-large-v3；朗读多了 5 个 OpenAI 声音。
- **模型框点开能看到全部选项**：以前模型框里已经填着当前模型，浏览器只显示和它匹配的那一个，看起来像只有一个可选。现在点进去会显示整张列表（当前模型显示成灰色提示），不选就还原。设置里所有模型框都这样（聊天模型、生图、生视频、语音、编程助手）。
- **这台电脑自己的屏幕也能看、能接管，和添加的其他机器一样**：装好夜班的 Windows 电脑，夜班会自己准备 TightVNC（只听本机，经夜班配对后才能看和接管）。
  - 夜班打开时它跟着启动，退出夜班时跟着关掉；不需要管理员权限。第一次会从 tightvnc.com 下载安装包（约 2 MB），要有 GlavSoft 的有效签名才用。
  - 以前机器人手工装在工作区里、跟着 Windows 开机启动的那一份（启动项 DeskVncServer）会被停掉并删掉启动项，换成夜班自己管的这一份。
  - 已经按服务方式装了 TightVNC 的机器（夜班帮你添加的那些）不受影响。
  - Tailscale 不跟着夜班开关：它是系统服务，手机和其他机器都靠它连这台电脑，关它也要管理员权限。
- **跟机器人说「停下」，它真的停**：以前在它干活时说「停下」，它只会回一句「收到，我不会再往下做」，任务却还开着，过一会儿（或者夜班重启后）又自己接着做。现在：
  - 只说「停下 / 别做了 / 不要做了 / 取消 / 算了 / stop」这类短话，正在跑的这一轮马上停（和点停止按钮一样），任务也关掉，不会再自动接着做；做好的文件都还在。长一点的话（比如「停下来先告诉我做到哪了」）照常当成一句话交给它。
  - 你问它一句话（「为什么卡住了」）、它只回答没动手时，任务先停在原地等你，不会答完又自己接着做；你回「继续」它干活后，才恢复自动接着做。
- **机器人运行命令不再卡住**：命令里用 start 之类在后台启动的程序（比如一个服务器）会一直占着输出，命令就一直不返回，连超时都停不下来（有一次卡了 191 秒）。现在命令本身结束后 1.5 秒就返回，并提醒机器人「有程序还在后台跑，用别的办法查它」；超时会连同它启动的程序一起结束。
- **认出 Qoder CN 命令行的真实位置**：Qoder CN 的命令行程序是 `qoderclicn`（装在 `.qoder-cn\bin\qoderclicn`），`qodercn` 只是它前面的一个转发脚本；现在两个都认，夜班不重启也能找到刚装好的。
- **自测**：`npm run smoke` 1030 项全部通过。用假的 Cursor / Qoder 程序测了参数、模型列表、登录状态和默认模型；用假的服务端测了百炼、MiniMax、智谱、Imagen 的请求和轮询。Qoder CN 命令行在这台电脑上实测能认出来（1.1.88，还没登录）；Cursor 命令行没装，生图生视频的新服务还没用真密钥跑过。本机屏幕在这台电脑上实测：停掉旧的、装好、启动、退出时关掉、再启动都正常。
- 自测里的服务器不再把这台电脑上自己开着的 VNC（TightVNC 5900）当成机器人桌面。

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
