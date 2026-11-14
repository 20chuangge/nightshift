# 把留灯跑在另一台机器上（Hub 模式）

你要的形态：

```
      你的笔记本 / 手机            ← 只是"遥控器"（客户端）
              │  https / 局域网
              ▼
   ┌─────────────────────────────────┐
   │   留灯 Hub（闲置 PC 或云主机）    │   ← 真正干活的地方
   │   · Bot 进程 + 记忆 + 技能    │
   │   · 常驻浏览器（登录态留在那） │
   │   · shell：下载、装软件、跑脚本 │
   │   · http_fetch / MCP：接平台  │
   └──────────────────────────┘
```

**一句话**：留灯本来就是"一个 Node 服务 + 一个网页界面"。服务跑在哪台机器，Bot 就在哪台机器干活；界面只是连上去看。

| 角色 | 装什么 | 怎么连 |
|---|---|---|
| **Hub**（闲置 PC / 云主机） | 推荐：留灯客户端「添加机器」自动装；手动：`sudo bash hub/setup-linux.sh`（Linux）、管理员 PowerShell 里 `powershell -ExecutionPolicy Bypass -File hub/setup-windows.ps1`（Windows：计划任务开机自启、防火墙放行、接电源不睡眠）、Docker | 监听 `0.0.0.0:4390`，启动时打印局域网地址 + 8 位配对码 |
| **你的笔记本** | 安装包（`Lamplit-Setup-*.exe`） | 左上角机器切换器 → 添加机器（填 IP + SSH 账号），装好自动配对并加进列表 |
| **手机** | 浏览器（或后面打的 APK） | 打开 Hub 地址 + 配对码；https 下可"添加到主屏幕" |

---

## 1. 在闲置 PC 上起 Hub（Windows，最快）

```bat
cd <项目目录>
hub\start-hub.bat
```

它做的事只有三件：`HOST=0.0.0.0`、`ASSIST_ALLOW_REMOTE=1`、`node src/server.mjs`。

- 首次放行防火墙：Windows 安全中心 → 允许应用通过防火墙 → 勾 **专用网络** 里的 `node.exe`；或管理员执行：
  ```bat
  netsh advfirewall firewall add rule name="Nightshift Hub" dir=in action=allow protocol=TCP localport=4390
  ```
- 窗口里会打印 `LAN URL` 和 `pairing code`。记下来。
- 那台机器**别睡眠**：电源选项 → 从不。

## 2. 在云主机上起 Hub（Linux）

```bash
sudo mkdir -p /opt/desk && sudo chown $USER /opt/desk
# 把项目拷过去（rsync / scp / git 都行），然后：
cd /opt/desk && bash hub/start-hub.sh
```

想常驻（装 Node、每 Bot 桌面依赖、systemd 服务、放行防火墙，Ubuntu/Debian/Rocky 通用；客户端「添加机器」跑的就是它）：

```bash
sudo bash hub/setup-linux.sh          # 装到 /opt/desk-hub，最后打印地址和配对码
journalctl -u desk-hub -f
```

或者 Docker（带 chromium，浏览器工具开箱可用）：

```bash
cd hub && docker compose up -d --build
docker logs -f desk-hub
```

> 云主机如果是**无桌面**的，浏览器工具需要 `BROWSER_HEADLESS=1`（脚本和 systemd 单元已经设好；Docker 镜像里装了 chromium）。

## 3. 让笔记本 / 手机连上来

**同一局域网**：桌面 App 里「添加机器」填 `http://<hub-ip>:4390`，加好后在菜单 **留灯 → 机器** 或左上角机器切换器里选它。手机浏览器打开同一地址，输配对码。

**不在同一网络**（推荐两种，都不要把 4390 裸奔到公网）：

| 方案 | 做法 | 特点 |
|---|---|---|
| **Tailscale**（最简单） | Hub 和手机都装 Tailscale，用 `http://<hub的tailscale-ip>:4390` | 零配置 NAT 穿透，只有你的设备能访问 |
| **Cloudflare Tunnel** | `cloudflared tunnel --url http://127.0.0.1:4390` | 给一个 https 域名，**手机可装成 PWA**（service worker 需要 https） |

连上之后手机端就是完整工作台：发消息、看工具调用、批准高风险动作、看产物。

## 4. Bot 在 Hub 上能做什么

| 能力 | 现状 | 说明 |
|---|---|---|
| 读写文件、跑命令 | ✅ | 全部发生在 Hub 的 `workspace/` 与 shell 里；下载软件 = `curl/wget/Invoke-WebRequest` 走 shell |
| 打开网页、点击、填表、截图、下载 | ✅（本次升级） | 常驻 Chromium + CDP，**登录态保存在 Hub 的 profile 里**，关掉再开还在 |
| 接开放平台 API | ✅ 通用 / 🟡 预置 | `http_fetch` 可以调任何 REST；MCP 连接器的接口位已留，还没做图形化管理 |
| 定时任务（例程） | ✅ | 在 Hub 上按 cron 跑，笔记本关机也照跑 |
| 人机接管（验证码/短信） | 🟡 | 局域网内可以直接看 Hub 的浏览器窗口；纯云主机需要 VNC/noVNC 或换成 API 登录 |

## 5. 安全（必须看）

- **不要**把 `4390` 直接映射到公网。用 Tailscale / Cloudflare Tunnel，或前置一层带 TLS 的反向代理。
- 非回环访问必须过配对码 / Bearer token。主 token 在 `data/security.json`；每台设备的会话在 `data/devices.json`（界面「设置 → 配对 → 已连接的设备」里可单独移除）。两处都清掉才算全部重新配对。
- Bot 能执行 shell —— 把 Hub 当成"你要托付的机器"：不要用存着网银的机器当 Hub，云主机用独立用户。
- 审批闸门对**远程客户端同样生效**：高危动作仍然会在你手机上弹卡。

## 6. 已知限制

- 桌面 App 的"连 Hub"是**整窗加载 Hub 的界面**：断网时会白屏，菜单里可以切回本机。
- 目前是**单 Hub**：一个客户端连一台。多 Hub / 多用户还没有。
- Hub 上的 `data/` 是全部状态（记忆、会话、例程、凭证），**记得备份**。
- 浏览器工具是单实例单页面，一个 Bot 正在用浏览器时另一个 Bot 会排队。
