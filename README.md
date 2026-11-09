# Nightshift · 夜班

你睡觉，它值夜班。一个有自己电脑的 AI 助理：说一句要做什么，它在电脑上把事情办完。

**官网和下载：https://20chuangge.github.io/nightshift/**

- **一个助理就够**：默认的「助理」什么都能做，也能自己建 Bot、拉群分工。
- **多台机器**：闲置电脑或云主机填上 IP、账号、密码，自动装好；切换机器，整个界面跟着切。支持 Ubuntu、Rocky、Windows。
- **看得见、能接管**：每台机器的屏幕实时可看，随时接管鼠标键盘。
- **本机先问你，远程机自主**：在你自己的电脑上，删文件、发消息这类操作会先问；远程机器放手干，危险命令一律拦下。
- **记忆、技能、定时任务**：记住你的习惯，把做过的流程存成技能，按时自动跑。
- **附件和语音**：拖文件、贴截图，或者按 Ctrl+D 直接说。
- **一处配置**：模型和语音密钥配一次，所有机器共用。

## 下载

到 [Releases](../../releases) 下载 `Nightshift-Setup-x.y.z.exe`（安装版）或 `Nightshift-Portable-x.y.z.exe`（免安装）。首次打开后在「设置 → 模型」填一个模型密钥（DeepSeek、通义、Kimi、OpenAI 等 OpenAI 兼容接口都行）。

## 从源码运行

```bash
npm install
npm start                # 服务 + 网页界面 http://127.0.0.1:4390
npm run desktop          # 桌面应用
npm run smoke            # 全量自测
npm run desktop:build    # 出 Windows 安装包 → desktop/dist/
```

需要 Node ≥ 20。添加远程机器、空白机测试方案见 `docs/`（`HUB.md`、`TEST-PLAN.md`）。

## 许可证

[MIT](LICENSE)：可以自由使用、修改和再分发，保留版权声明即可。

---

以下是开发参考（架构、接口、扩展方式）。

## Quick start

```bash
# 1) 起后端 + 浏览器打开
npm start                      # http://127.0.0.1:4390
npm run smoke                  # 199 assertions, boots the real server on a free port

# 2) 桌面应用（Electron 壳）
npm run desktop                # 开发模式，等同 npm start 但带窗口/托盘
npm run desktop:build          # 出 Windows 安装包 → desktop/dist/

# 3) 手机端
npm run mobile:sync            # 把 public/ 同步进 mobile/www 并 cap sync
```

`PORT=0 npm start` picks a free port; the server prints one JSON line with the
actual URL and logs to stderr.

### Mock mode (default)

No configuration. `ASSIST_MODEL_PROVIDER` defaults to `mock`: a deterministic
planner that reads keywords out of the last user message and replays a fixed plan
of tool calls (`fs_list` → `fs_write` → `memory_write` → `task_finish`). It is not
a language model — it is a fixture that exercises every code path, which is
exactly what makes the smoke test meaningful.

Try these messages:

| Message | What it exercises |
| --- | --- |
| `List the files in the workspace and write a note` | LOW-risk tools, streaming, memory write |
| `Remember that I prefer metric units` | per-bot memory |
| `Write a note outside the workspace` (Ops) | **HIGH-risk approval card** |
| `Hand off to the researcher: summarise welcome.md` | bot-to-bot handoff, separate turn |
| `Save this as a skill called inbox-triage` (Researcher) | skill library write, auto-approved MEDIUM |
| `Create a routine every 30 minutes` | routine creation |

### Real mode (opt-in)

Any OpenAI-compatible `/chat/completions` endpoint works:

```bash
export ASSIST_MODEL_PROVIDER=openai
export ASSIST_API_KEY=sk-...                      # never committed
export ASSIST_MODEL=gpt-4o-mini                   # optional
export ASSIST_BASE_URL=https://api.openai.com/v1  # optional: any compatible endpoint
npm start
```

The real client sends the tool schemas, parses `tool_calls`, and feeds results
back exactly like the mock path. Streaming tokens from the provider is not
enabled (see "what this replica does NOT do"); the UI still streams the assistant
text because the server emits deltas for each completed message.

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4390` | HTTP port. `0` = any free port. |
| `HOST` | `127.0.0.1` | Bind address. Loopback by default, on purpose. |
| `ASSIST_HOME` | repo root | Relocates the whole installation (used by the smoke test). |
| `ASSIST_DATA_DIR` | `<home>/data` | Sessions, audit, routines, memory. |
| `ASSIST_WORKSPACE_DIR` | `<home>/workspace` | The shared workspace. |
| `ASSIST_MODEL_PROVIDER` | `mock` | `mock` or `openai`. |
| `ASSIST_BASE_URL` / `ASSIST_API_KEY` / `ASSIST_MODEL` | — | Real provider settings. |
| `ASSIST_MODEL_TIMEOUT_MS` | `120000` | Per-request timeout. |
| `CHROME_PATH` | unset | Enables the optional `browser_open` tool. |
| `ALLOW_PRIVATE` | unset | `1` lets `http_fetch`/`browser_open` reach LAN addresses. |

---

## Architecture

```
                          ┌──────────────────────────────────────────┐
   browser (vanilla JS)   │  public/index.html                       │
   ── REST + SSE ────────►│  chat · tool chips · approval cards      │
                          │  Activity | Skills | Routines | Memory   │
                          └───────────────┬──────────────────────────┘
                                          │
                          ┌───────────────▼──────────────────────────┐
                          │  src/server.mjs  (node:http, no deps)    │
                          │  REST routes · SSE fan-out · static ·     │
                          │  graceful shutdown                        │
                          └───┬───────────┬───────────┬──────────────┘
                              │           │           │
              ┌───────────────▼──┐  ┌─────▼──────┐  ┌─▼───────────────┐
              │ src/agent.mjs    │  │ approvals  │  │ src/routines.mjs│
              │ the turn loop    │  │ .mjs       │  │ cron + interval │
              │ 12 steps / 5 min │  │ classify   │  │ 20s tick        │
              │ events + cancel  │  │ queue      │  │ unattended runs │
              └───┬─────────┬────┘  └─────┬──────┘  └─┬───────────────┘
                  │         │             │           │
        ┌─────────▼──┐  ┌───▼────────┐  ┌─▼───────────▼──────────────┐
        │ model.mjs  │  │ tools.mjs  │  │ store.mjs                  │
        │ mock |     │  │ 19 tools   │  │ atomic JSON, JSONL, audit, │
        │ openai     │  │ risk fn    │  │ event bus, path layout     │
        └────────────┘  └───┬────────┘  └────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┬──────────────────┐
        │                   │                   │                  │
   ┌────▼─────┐      ┌──────▼──────┐     ┌──────▼─────┐    ┌───────▼──────┐
   │memory.mjs│      │ skills.mjs  │     │bots.mjs    │    │ shell / fs / │
   │per-bot   │      │ frontmatter │     │ roster,    │    │ http / cdp   │
   │+ shared  │      │ library     │     │ grants     │    │ tools        │
   └────┬─────┘      └──────┬──────┘     └──────┬─────┘    └──────────────┘
        │                   │                   │
   data/memory/         skills/*.md        config/bots/*.json
   <bot>/MEMORY.md                          config/assistant.json
   shared.md
```

### One turn, in order

1. `POST /api/bots/:id/message` mints a `turnId`, returns it immediately, and
   starts `AgentRuntime.runTurn` in the background.
2. The agent builds the system prompt: persona + role + team roster + the
   **one shared workspace** note + memory digest + skills digest + tool digest +
   the approval boundary + working rules.
3. It calls the model with the granted tool schemas (never the ungranted ones).
4. For each `tool_call`: **classify → maybe ask a human → run → feed the result
   back**. Results go back into the transcript as `role:"tool"`.
5. Loop until `task_finish`, a plain answer with no tool calls, 12 steps, 5
   minutes, or cancellation.
6. Every step emits an event on the bus; the server fans it out over SSE and the
   transcript is appended to `data/sessions/<botId>.jsonl`.

### Directory layout

```
config/assistant.json      assistant name, persona, timezone, primary bot, global policy
config/bots/*.json         one file per bot: role, tools, skills, policy
skills/*.md                the shared skill library (frontmatter + markdown)
workspace/                 THE shared computer - every bot sees this
public/index.html          the whole UI (single file, no build)
src/*.mjs                  server, agent, tools, model, approvals, memory, skills, routines, bots, store
scripts/smoke.mjs          end-to-end self test
data/                      created on first boot (gitignored)
  memory/<botId>/MEMORY.md per-bot memory
  memory/shared.md         shared facts
  sessions/<botId>.jsonl   append-only transcript
  audit.jsonl              every tool run + approval decision + routine run
  routines.json            routine definitions and run history
```

---

## The five product surfaces

### Bots
A bot is a durable teammate: `id`, `name`, `avatarColor`, `role`, `persona`,
`tools[]` (grants), `skills[]` (grants), `policy` (auto-approve + denylist +
limits), its own session log and its own memory file. Three ship by default:

| Bot | Role | Grants | Approval stance |
| --- | --- | --- | --- |
| **Chief** (primary) | coordinates, hands off, writes notes | files, memory, skills, routines, `bot_message`, `http_fetch` — **no shell** | strict: MEDIUM asks |
| **Researcher** | reads the web, writes the short version | `http_fetch`, `browser_open`, files, memory, skills — **no shell** | `autoApproveMedium: true` |
| **Ops** | runs commands, keeps the workspace tidy | `shell`, files (incl. delete), memory, routines | strictest: every shell command asks |

The primary bot is also persisted in `config/assistant.json.primaryBotId`;
`POST /api/bots/:id/primary` moves the badge and rewrites that config.

### Memory
Human-readable markdown, one file per bot plus `shared.md`:

```markdown
# chief - memory

<!-- Append-only. One line per entry: "- <iso timestamp> | <fact>". -->

- 2026-11-05T08:12:00.000Z | User prefers metric units
```

Retrieval is keyword overlap plus recency decay (`2 × hits + 1.5 × e^(-age/30d)`),
scoped to the bot with shared facts always visible. No embeddings, by design: a
few hundred lines stay inspectable and correct, and a human can edit them.

### Skills
A skill is a markdown file with YAML-ish frontmatter (`name`, `description`,
`when_to_use`, `inputs`, `steps`, `validation`, `output`, `approval_notes`). The
library is shared; a bot must be **granted** a skill (by slug) to use it. The
system prompt carries only the digest (name + when to use), and the bot calls
`skill_read` to load the full steps — progressive disclosure, so the prompt stays
small as the library grows. "Save what worked" = `skill_save` writes a new file.

### Routines
`{ botId, name, instruction, schedule, timezone, enabled }` where `schedule` is a
5-field cron expression or `every N minutes|hours`. A 20-second tick fires
anything due, records the run, and computes the next one in the routine's own IANA
timezone (via `Intl`, DST-aware for the common cases). **Test** runs it now with
unattended semantics. History keeps `success | failed | needs_approval`.

### Approvals
Every tool call is classified before it runs:

| Risk | Examples | Behaviour |
| --- | --- | --- |
| **LOW** | `fs_list`, `fs_read`, `memory_*`, `skill_list/read`, `bot_message`, `task_finish` | runs immediately |
| **MEDIUM** | `shell` (plain), `http_fetch`, `browser_open`, `skill_save`, `routine_create`, `fs_delete` | runs only if the bot's `autoApproveMedium` is true, else asks |
| **HIGH** | denylisted shell (`rm -rf`, `sudo`, `shutdown`, `format c:`, `curl … \| bash`, …), any write/mkdir/delete **outside** `workspace/` | always asks a human |

The decision function is one place (`approvals.classify`) so the UI, the audit
log and the agent can never disagree. Asking means: emit `approval.request`,
render a card, and **block the turn** until approve/deny — or a 10-minute timeout
which denies. Decisions are written to `data/audit.jsonl` and to the transcript,
so a reloaded page still shows what was asked and what you said.

**Unattended runs** (routines) never auto-approve HIGH: the run parks the card,
ends with status `needs_approval`, and posts a message in chat saying it is
paused. It does not sit there for ten minutes pretending to work.

---

## Event and API contract

### SSE — `GET /api/stream[?botId=…]`

`text/event-stream`, one JSON object per `data:` line, heartbeat comment every
15 s. Events:

| `type` | Payload (beyond `ts`) |
| --- | --- |
| `turn.start` | `botId, botName, turnId, text, source, unattended, depth` |
| `message.delta` | `text` (chunk), `index` |
| `message` | `text`, `final: true`, `system?` |
| `tool.call` | `name, args, risk, decision (auto\|ask\|deny), reason, callId` |
| `tool.result` | `name, ok, risk, result, callId` |
| `approval.request` | `approvalId, tool, args, risk, reason, callId` |
| `approval.resolved` | `approvalId, tool, decision (approved\|denied\|timeout\|needs_approval), note` |
| `approval.decided` | emitted by the HTTP decision route: `approvalId, status, note, late?` |
| `turn.end` | `status (success\|failed\|cancelled\|timeout\|max_steps\|needs_approval)`, `summary`, `steps` |
| `error` | `message` |

### REST

```
GET    /api/health                     {ok, version, model:{provider,model}, bots, routines, …}
GET    /api/config                     assistant config incl. policy.denyPatterns (no secrets)
GET    /api/bots                       [ {id,name,role,avatarColor,primary,tools,skills,policy} ]
POST   /api/bots                       {name, role?} -> {bot}
PATCH  /api/bots/:id                   partial -> {bot}
DELETE /api/bots/:id                   {deleted:true, nextPrimaryId}
POST   /api/bots/:id/primary           -> {bot}
GET    /api/bots/:id                    -> {bot}
GET    /api/bots/:id/messages?limit=200 -> [ {role:'user'|'assistant'|'tool'|'approval'|'status', …} ]
POST   /api/bots/:id/message           {text} -> {turnId}   (turn runs in background)
GET    /api/bots/:id/memory            {memory, shared, entries[], paths}
GET    /api/approvals?status=pending   [ approval records ]
POST   /api/approvals/:id              {decision:'approve'|'deny', note?} -> {approval}
GET    /api/routines                   [ routines with runs[] ]
POST   /api/routines                   {botId, name, instruction, schedule, timezone?} -> {routine}
PATCH  /api/routines/:id               {enabled?, schedule?, instruction?, …} -> {routine}
DELETE /api/routines/:id               {deleted:true}
POST   /api/routines/:id/test          runs now -> {routine, run}
GET    /api/skills[?botId=…]           [ {name, slug, description, steps[], granted?} ]
GET    /api/skills/:name               {skill with body + raw frontmatter}
GET    /api/audit?limit=100            newest-first audit records
GET    /api/events?limit=60            recent in-process events (Activity backfill)
GET    /api/turns                      active turns
POST   /api/turns/:id/cancel           cancel a running turn (also aborts approvals)
```

Every failure is `{ "error": { "code": "SNAKE_CASE", "message": "human sentence" } }`
with a real HTTP status (400/403/404/409/413/500). Bodies are capped at 1 MB;
static files are path-traversal guarded.

---

## How to extend

### Add a bot
Drop a file in `config/bots/` (or click **+ New bot**):

```json
{
  "id": "scribe",
  "name": "Scribe",
  "avatarColor": "#22c55e",
  "role": "Keeps the minutes and never touches a shell.",
  "persona": "You write things down precisely and cite the file you wrote.",
  "primary": false,
  "tools": ["fs_list", "fs_read", "fs_write", "memory_read", "memory_write", "task_finish"],
  "skills": ["weekly-review"],
  "policy": { "autoApproveMedium": false, "maxSteps": 10, "maxTurnMs": 240000 }
}
```

### Add a skill
Click through the UI, or ask a bot to `skill_save`, or just write the file:

```markdown
---
name: inbox-triage
description: Sort the inbox and propose the top three replies.
when_to_use: Morning, or when the inbox is mentioned.
inputs:
  - inbox export path
steps:
  - Call fs_read on the export.
  - Group by sender and urgency.
  - Write notes/inbox.md with the top three.
validation:
  - notes/inbox.md exists and has exactly three items.
output: notes/inbox.md plus a one-line summary.
approval_notes: Reading the export is LOW risk. Nothing leaves the workspace.
---

Free-form body: the reasoning, the anti-patterns, the examples.
```

Grant it to a bot by slug in that bot's `skills[]`.

### Add a tool
In `src/tools.mjs`, inside `createRegistry`:

```js
add({
  name: 'weather_lookup',
  description: 'Look up the forecast for a city.',
  risk: RISK.MEDIUM,                 // or (args, ctx) => ({risk, reason})
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    // ctx = { bot, workspaceDir, turnId, unattended, signal, memory, skills, bots }
    return { city: args.city, forecast: 'sunny' };
  },
});
```

Then add `"weather_lookup"` to a bot's `tools[]`. The schema is what the model
sees; the digest line is what the system prompt shows. Throw
`toolError('CODE', 'message')` for a clean failure the model can read.

---

## What this replica does NOT do (honest limits)

- **No long-lived browser session.** `browser_open` launches a throwaway headless
  Chrome per call, navigates, and reports the title/URL. It does not click, type,
  run page scripts, or screenshot. Without `CHROME_PATH` it returns a structured
  `not_configured` error and nothing breaks.
- **No true OS isolation.** Tools run as *you* in a normal process. "Outside the
  workspace" is a policy check in `resolvePath`, not a sandbox; `fs_*` can reach
  any path you approve. The denylist is a regex heuristic, not a security control
  — a determined command can dodge it. Treat approvals as guard rails against
  accidents, not against a hostile model.
- **One shared workspace, one process.** No per-bot container, no filesystem
  snapshot/undo, no git integration.
- **Approvals and turns are recovered, not resumed.** Pending cards and in-flight
  turns are persisted (`data/pending.json`, `data/turns/`). After a restart a
  restored *live-chat* approval replays exactly the one approved tool call; a
  restored *unattended/routine* card is recorded but never replayed — re-run the
  routine. The model transcript itself is not reconstructed.
- **Memory is not summarised or compacted.** Append-only; retrieval is keyword +
  recency. No embeddings, no dedupe, no conflict resolution.
- **Routine scheduling is single-process** with a 20s tick and no persistence of
  in-flight runs. Overlapping runs are prevented in-memory only. A machine that
  was asleep fires once on the next tick, not once per missed slot.
- **No cross-turn agent loop after a deny.** When you deny a tool, the model sees
  the refusal and continues; it does not re-plan with a different tool unless the
  model decides to.
- **Remote access is a shared secret, not an account system.** One 24-hex token /
  8-digit pairing code per installation, no users, no roles, no revocation UI
  (rotate by deleting `data/security.json` and restarting). It is meant for *your*
  phone on *your* network — put Tailscale or a tunnel in front before exposing it.
- **No telemetry, no analytics, no cloud calls** except the model endpoint you
  configure and any `http_fetch`/`browser_open` you approve.

---

## Tests

```bash
npm run smoke
```

Boots the real server (`src/server.mjs`) on a free port with
`ASSIST_HOME` pointed at a temp copy of `config/`, `skills/`, `public/` and
`workspace/`, drives a scenario over HTTP + SSE, prints `PASS`/`FAIL` per
assertion, and exits non-zero on any failure. It leaves the repo untouched.

Covered: health/config/static, bot CRUD + duplicate/404 shapes, a full chief turn
(SSE events, tool chips, file on disk, memory file), bot-to-bot handoff, approval
**approve** and **deny** (including the audit trail and the file *not* being
written on deny), routines (create, cron nextRun in Asia/Shanghai, test →
`needs_approval`, disable, delete, a successful test), skill save via a bot with
auto-approved MEDIUM, error shapes (404/400/bad JSON/path traversal), and pure
units: risk classification, path-based escalation, private-host blocking,
`browser_open` not_configured, cron parsing/next-run/timezone/errors, frontmatter
parsing, and memory ranking + scoping.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `port 4390 is already in use` | `PORT=0 npm start` (or pick a free port). |
| UI shows "Could not reach the server" | The server died; check the terminal. |
| `browser_open` returns `not_configured` | Set `CHROME_PATH` to `chrome.exe` and restart. |
| `http_fetch` returns `PRIVATE_HOST_BLOCKED` | Loopback/LAN is blocked by default; set `ALLOW_PRIVATE=1`. |
| A turn never finishes | It is waiting for approval. Check **Activity**, or the approval card. 10-min timeout denies. |
| Smoke test fails on a cron assertion | The machine timezone/ICU differs; the assertion is timezone-explicit (`Asia/Shanghai`), so this indicates a real regression. |
| `model HTTP 400: The reasoning_content in the thinking mode must be passed back` | Fixed in 1.0.0 + the first patch. Cause: a reply carrying both text and a tool call used to be pushed back as **two** assistant messages; thinking models reject that. One assistant message per reply, with `content` + `tool_calls` (+ `reasoning_content` when the provider sent one). |

### Debugging the wire

`ASSIST_DEBUG_WIRE=1` appends every outbound request and a response summary to
`<data>/wire.jsonl`. This is how provider quirks (reasoning fields, tool-call
deltas, message-ordering rules) get diagnosed; it is off by default and never
contains your API key.
