# 让长明走 HTTPS（公网直连）

长明的连接默认是明文 HTTP。局域网里无所谓，一旦放到公网（云主机、家里路由器映射、隧道），
配对后的凭据、聊天内容、工作区文件和 Bot 看屏幕的画面都会明文过网；而远程机器上的 Bot 能执行
命令、有的还能 sudo。所以**公网入口必须是加密的**。

四条路，按省事程度排。选一条即可。

---

## 1. Caddy 反代 + Let's Encrypt（推荐，需要域名）

```bash
# Ubuntu / Debian
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`：

```
nightshift.example.com {
    reverse_proxy 127.0.0.1:4390
}
```

Caddy 自动申请并续期证书，只需要域名的 A 记录指向这台机器，安全组放行 80/443。

**关键一步**：反代在前面时，长明必须打开 `ASSIST_TRUST_PROXY=1`，否则它看到的每个请求都来自
127.0.0.1，会被当成本机用户——等于没有认证。启动参数（systemd 里加一行）：

```ini
Environment=ASSIST_TRUST_PROXY=1
```

同时让长明只听本机（代理会转发）：

```ini
Environment=HOST=127.0.0.1
Environment=ASSIST_ALLOW_REMOTE=1
```

> `ASSIST_ALLOW_REMOTE=1` 仍然要开：它决定"是否对外提供服务"（配对码、手机地址、二维码），
> 而不是"是否监听 0.0.0.0"。`HOST=127.0.0.1` + 代理转发是推荐组合。

---

## 2. Cloudflare Tunnel（有域名，不开放任何端口）

适合家里 NAT、不想动安全组：

```bash
cloudflared tunnel login
cloudflared tunnel create nightshift
cloudflared tunnel route dns nightshift nightshift.example.com
cloudflared tunnel run --url http://127.0.0.1:4390 nightshift
```

Cloudflare 负责证书，机器上不用开 80/443。同样要 `ASSIST_TRUST_PROXY=1`。

---

## 3. Tailscale Funnel（不需要买域名）

Tailscale 会给你一个 `机器名.你的tailnet.ts.net` 的域名和一份有效证书：

```bash
sudo tailscale funnel --bg 4390
tailscale funnel status
```

免域名、免端口映射。代价：Funnel 是对整个互联网开放的（不是只对你的设备），所以一定要配合
`ASSIST_REQUIRE_HTTPS=1` 和强配对码。只想给自己的设备用，用 `tailscale serve` 就够（不出公网）。

---

## 4. 自带证书 / 自签（不推荐给浏览器）

长明自己也支持直接跑 https。把证书放进 `data/tls/cert.pem` 和 `data/tls/key.pem`，
或者用环境变量指定：

```bash
ASSIST_TLS_CERT=/etc/ssl/nightshift/fullchain.pem ASSIST_TLS_KEY=/etc/ssl/nightshift/privkey.pem npm start
```

自签证书浏览器会报警告，只适合我们自己的 App（App 里做固定即可）。公开服务请用前三条的正式证书。

---

## 反代不在本机时（docker bridge、另一台机器）

代理和长明不在同一台机器上时，来源地址不是 127.0.0.1，需要再给一个共享密钥：

```ini
Environment=ASSIST_TRUST_PROXY=1
Environment=ASSIST_PROXY_SECRET=<随机字符串>
```

并在代理上转发一个额外的请求头：

```
proxy_set_header X-Nightshift-Proxy <同一个字符串>;
```

没有这个头、来源又不是本机的请求，长明不会相信它自己声称的地址，仍然要求认证（失败关闭）。

---

## 还有两个开关

| 变量 | 作用 |
|---|---|
| `ASSIST_REQUIRE_HTTPS=1` | 非本机来的明文请求一律 426 拒绝（外壳页面除外，好让你看到这条提示） |
| （自动） | 走 HTTPS 时：会话 cookie 带 `Secure`，响应带 `Strict-Transport-Security` |

---

## 上线自检清单

1. `curl -I https://你的域名/` → 200，且有 `strict-transport-security`。
2. `curl -I http://你的域名/` → 应该被 301/308 跳到 https（Caddy 默认就做）。
3. `curl https://你的域名/api/settings` 不带凭据 → **401**（如果返回 200，说明 `ASSIST_TRUST_PROXY` 没配对，所有请求被当成本机，立刻停掉）。
4. 手机扫码配对 → `/api/devices` 里出现那台手机，IP 显示的是手机的**真实**地址（不是 127.0.0.1）。
5. 用 `ASSIST_REQUIRE_HTTPS=1` 时，直接访问 `http://公网IP:4390/api/health` → 426。
