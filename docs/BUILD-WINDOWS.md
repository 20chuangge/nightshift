# 构建 Windows 安装包

产物（`desktop/dist/`）：

| 文件 | 说明 | 大小 |
|---|---|---|
| `Lamplit-Setup-x.y.z.exe` | NSIS 安装包（可选安装目录、建桌面/开始菜单快捷方式、免管理员） | ~80 MB |
| `Lamplit-Portable-x.y.z.exe` | 免安装单文件，双击即用 | ~80 MB |
| `win-unpacked/` | 解包目录，用于调试（`Lamplit.exe` 直接跑） | — |

## 一条命令

```bat
cd <项目目录>
npm run desktop:build
```

等价于：

```bat
cd desktop
npx electron-builder --win --x64
```

## 前置

- Node ≥ 20
- 首次构建会从 GitHub 下载 Electron 与 NSIS 工具链（约 120 MB），之后走本地缓存
- **不需要** Visual Studio、不需要管理员权限（`perMachine: false`，装到 `%LOCALAPPDATA%\Programs\Lamplit`；从旧版升级时沿用原来的目录）

## 结构：为什么不是一个 .exe 里塞满东西

```
Lamplit.exe               ← Electron 壳（只负责开窗 + 起子进程 + 托盘）
resources/app.asar          ← 壳代码 main.mjs
resources/server/           ← 真正的后端（纯 Node，零依赖）
  src/*.mjs
  public/                   ← UI（HTML/CSS/JS 单文件 + 图标）
  config/ skills/ workspace/← 首次启动的种子
%APPDATA%\Desk\             ← 运行时数据（ASSIST_HOME，名字沿用 Desk 时期）
  config/ skills/ public/ workspace/ data/
```

壳用 `ELECTRON_RUN_AS_NODE=1` 把 `resources/server/src/server.mjs` 当纯 Node 进程拉起，端口随机（`PORT=0`），读到 `{"event":"ready","port":N}` 后再 `loadURL`。**好处**：turn 崩了不会带走窗口；同一个 server 就是手机配对后连的那个东西；后端可以单独 `node src/server.mjs` 跑。

`public/` 每次启动都从 `resources/server/public` 覆盖刷新（UI 跟版本走），`config/`、`skills/`、`workspace/` 只在缺失时播种（不覆盖用户数据）。

## 图标

```bat
npm run desktop:icons
```

`desktop/make-icons.mjs` 把一个 1024×1024 的 PNG 组装成 PNG-compressed `.ico`（16/24/32/48/64/128/256），同时生成 `public/icons/*`、`public/favicon.ico`、`apple-touch-icon.png`。图标源图由浏览器渲染（渐变 + D 字标），换 logo 只改 `make-icons.mjs` 里的 HTML 即可。

## 常见坑

| 现象 | 原因 | 解决 |
|---|---|---|
| `Cannot create symbolic link ... libcrypto.dylib` | electron-builder 解压 `winCodeSign` 时含 macOS 符号链接，Windows 非管理员/未开开发者模式无法创建 | 解压产物其实已完整，把 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<随机数>` 复制成 `winCodeSign-2.6.0` 即可跳过重试 |
| 启动白屏 | 端口被占或 server 起不来 | 看 `%APPDATA%\Desk\` 与启动日志；`Lamplit.exe` 会弹错误框并退出 |
| 想改端口 | 默认随机 | 设环境变量 `PORT=4390` 后启动 |
| 换 Electron 版本 | — | 改 `desktop/package.json` 的 `electron`，重装后重建 |

## 未签名说明

当前安装包**未做代码签名**。Windows SmartScreen 会提示"未知发布者"，点"更多信息 → 仍要运行"即可。

要正式分发，需要：

1. 一张 OV/EV 代码签名证书（或 Azure Trusted Signing）；
2. 在 `desktop/electron-builder.yml` 的 `win` 下加 `certificateFile` / `certificatePassword`（或 `signtoolOptions`）；
3. 重新构建，`signtool` 会自动签名 exe 与安装包。

无证书时，也可以在 CI 里用 `signtool` 对 `dist/Lamplit-Setup-*.exe` 做时间戳签名。
