# 名字：哪些能改，哪些不能改

产品名（界面、安装包、官网、文档里给人看的）可以改。下面这些是**内部标识**，已经装好的电脑、配对过的手机、远程机器都靠它们找到彼此和自己的数据。改了，老用户升级后会丢数据、配对失效或远程机器连不上——**不要顺手统一**。

| 标识 | 在哪 | 为什么不能改 |
| --- | --- | --- |
| `com.desk.assistant` | 电脑版 appId、安卓包名 | 换了就是另一个应用：升级变成新装，数据和快捷方式对不上 |
| `%APPDATA%\Desk` | 1.2.150 及更早装的电脑的数据文件夹（新装的是 `%APPDATA%\Lamplit`，见 `desktop/datadir.mjs`） | 机器人、记忆、保险箱、配对都在里面；老电脑不搬 |
| `desk_session` | 配对 cookie 名 | 换了所有配对过的浏览器要重新配对 |
| `desk.*` | 网页本地存储的键 | 界面偏好（主题、上次的机器等） |
| `NightshiftHub` | Windows 计划任务名 | 远程 Windows 机器靠它开机自启、更新 |
| `Nightshift Hub` | Windows 防火墙规则名 | 远程机器的端口放行 |
| `/opt/desk-hub`、`desk-hub` 服务 | Linux 远程机器 | 安装位置和 systemd 服务名 |
| `C:\ProgramData\Nightshift` | Windows 远程机器 | 安装位置和日志 |
| `x-nightshift-proxy`、`x-nightshift-version` | 请求头 | 反向代理配置和机器之间的版本协商 |
| `NightshiftWatcher`、`NightshiftShell`、`NightshiftVoice` | 安卓 Java 类名、网页里的 JS 桥 | 手机壳和页面互相调用的名字 |
| `20chuangge/lamplit`（1.2.151 前叫 nightshift） | GitHub 仓库、官网地址 | 官网的下载按钮（`site/site.js`）从这里取最新发布；再改仓库名时 `site/`、`README.md`、`RELEASE.md` 的链接一起改（GitHub 会自动跳转旧地址） |

检查给人看的地方有没有旧名字：`npm run smoke` 里的 BUG-02 一项会扫一遍界面、手机壳、文档和配置。
