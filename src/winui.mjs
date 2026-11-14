/**
 * winui.mjs - work desktop programs on Windows without the real mouse.
 *
 * Windows Home/Pro has one interactive desktop, so bots cannot each get a
 * screen of their own the way they do on Linux. What they can do is drive
 * programs through UI Automation (the accessibility API): press a button, set
 * a text box, read what a window says. None of that moves the pointer or takes
 * the keyboard focus from the human, and several bots can do it at once in
 * different windows.
 *
 * Zero dependencies: Windows PowerShell + the UIAutomationClient assembly.
 * The request goes in as base64 JSON in an environment variable and the
 * script is passed as -EncodedCommand, so nothing a model writes is ever
 * parsed as PowerShell.
 */

import { spawn } from 'node:child_process';

export const WINUI_ACTIONS = ['windows', 'controls', 'click', 'type', 'read'];

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
# Session 0 is where services run: no desktop, no windows to see.
if ((Get-Process -Id $PID).SessionId -eq 0) { throw "NO_DESKTOP" }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DESK_WINUI)) | ConvertFrom-Json
$A = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$Any = [System.Windows.Automation.Condition]::TrueCondition
$root = $A::RootElement

function Info($e) {
  $c = $e.Current
  [ordered]@{ name = $c.Name; type = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', ''); id = $c.AutomationId; enabled = $c.IsEnabled }
}
function Win([string]$title) {
  $all = $root.FindAll($Scope::Children, $Any)
  foreach ($w in $all) { if ($w.Current.Name -eq $title) { return $w } }
  foreach ($w in $all) { if ($w.Current.Name -and $w.Current.Name.ToLower().Contains($title.ToLower())) { return $w } }
  throw "NO_WINDOW"
}
function Find($w, [string]$target) {
  $all = $w.FindAll($Scope::Descendants, $Any)
  foreach ($e in $all) { $c = $e.Current; if ($c.AutomationId -eq $target -or $c.Name -eq $target) { return $e } }
  foreach ($e in $all) { $n = $e.Current.Name; if ($n -and $n.ToLower().Contains($target.ToLower())) { return $e } }
  throw "NO_CONTROL"
}
function Pattern($e, $p) {
  $o = $null
  if ($e.TryGetCurrentPattern($p, [ref]$o)) { return $o }
  return $null
}

$res = $null
switch ($req.action) {
  'windows' {
    $out = @()
    foreach ($w in $root.FindAll($Scope::Children, $Any)) {
      if ($w.Current.Name) { $out += [ordered]@{ title = $w.Current.Name; pid = $w.Current.ProcessId } }
    }
    $res = @{ windows = $out }
  }
  'controls' {
    $w = Win $req.window
    $out = @()
    foreach ($e in $w.FindAll($Scope::Descendants, $Any)) {
      $i = Info $e
      if ($i.name -or $i.id) { $out += $i; if ($out.Count -ge 200) { break } }
    }
    $res = @{ window = $w.Current.Name; controls = $out }
  }
  'click' {
    $e = Find (Win $req.window) $req.target
    $p = Pattern $e ([System.Windows.Automation.InvokePattern]::Pattern)
    if ($p) { $p.Invoke() } else {
      $p = Pattern $e ([System.Windows.Automation.TogglePattern]::Pattern)
      if ($p) { $p.Toggle() } else {
        $p = Pattern $e ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($p) { $p.Select() } else {
          $p = Pattern $e ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
          if ($p) { $p.Expand() } else { throw "NO_CLICK" }
        }
      }
    }
    $res = @{ clicked = (Info $e) }
  }
  'type' {
    $w = Win $req.window
    if ($req.target) { $e = Find $w $req.target } else {
      $e = $null
      foreach ($x in $w.FindAll($Scope::Descendants, $Any)) {
        if ((Pattern $x ([System.Windows.Automation.ValuePattern]::Pattern)) -and $x.Current.IsEnabled) { $e = $x; break }
      }
      if (-not $e) { throw "NO_CONTROL" }
    }
    $p = Pattern $e ([System.Windows.Automation.ValuePattern]::Pattern)
    if (-not $p -or $p.Current.IsReadOnly) { throw "NO_TYPE" }
    $p.SetValue([string]$req.text)
    $res = @{ typed = (Info $e); length = ([string]$req.text).Length }
  }
  'read' {
    $w = Win $req.window
    $parts = @()
    foreach ($e in $w.FindAll($Scope::Descendants, $Any)) {
      $v = Pattern $e ([System.Windows.Automation.ValuePattern]::Pattern)
      $t = if ($v) { $v.Current.Value } else { $e.Current.Name }
      if ($t) { $parts += $t }
    }
    $text = ($parts | Select-Object -Unique) -join [Environment]::NewLine
    if ($text.Length -gt 6000) { $text = $text.Substring(0, 6000) }
    $res = @{ window = $w.Current.Name; text = $text }
  }
  default { throw "BAD_ACTION" }
}
$res | ConvertTo-Json -Depth 5 -Compress
`;

const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

const MESSAGES = {
  NO_WINDOW: (r) => `找不到标题里含「${r.window}」的窗口。先用 windows 列出现在打开的窗口。`,
  NO_CONTROL: (r) => `窗口里找不到「${r.target || '可以输入的地方'}」。先用 controls 看看这个窗口里有哪些按钮和输入框。`,
  NO_CLICK: (r) => `「${r.target}」不支持在后台点击（这个程序没有提供无障碍接口）。`,
  NO_TYPE: (r) => `「${r.target || '这个输入框'}」不支持在后台输入，或者是只读的。`,
  BAD_ACTION: (r) => `不认识的操作：${r.action}`,
  NO_DESKTOP: () => '这台 Windows 的 Lamplit 在后台服务里运行，看不到桌面上的窗口。要操作桌面程序，请在登录后的桌面上运行 Lamplit。',
};

/**
 * Run one UI Automation request. -> parsed JSON result.
 * Throws an Error whose message is meant for the model (and the human).
 */
export function runWinUi(request, { timeoutMs = 20000, signal, spawnImpl = spawn } = {}) {
  if (process.platform !== 'win32' && !spawnImpl.fake) {
    return Promise.reject(new Error('只有 Windows 机器能用这个工具；Linux 上每个机器人有自己的屏幕。'));
  }
  const req = { ...request };
  if (!WINUI_ACTIONS.includes(req.action)) return Promise.reject(new Error(MESSAGES.BAD_ACTION(req)));
  // A hub running as a background service (session 0) sees no windows at all:
  // the script asks Windows for its own session and says NO_DESKTOP (an
  // environment variable such as SESSIONNAME is missing for perfectly normal
  // launches too, so it cannot tell).
  return new Promise((resolve, reject) => {
    const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED], {
      env: { ...process.env, DESK_WINUI: Buffer.from(JSON.stringify(req), 'utf8').toString('base64') },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } reject(new Error('桌面程序没有在 20 秒内响应。')); }, timeoutMs);
    const abort = () => { try { child.kill(); } catch { /* gone */ } };
    signal?.addEventListener?.('abort', abort, { once: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      if (code === 0) {
        try { resolve(JSON.parse(out.trim() || '{}')); } catch { reject(new Error(`桌面程序返回了看不懂的结果：${out.slice(0, 200)}`)); }
        return;
      }
      // PowerShell reports errors as CLIXML on stderr: keep the message lines only.
      if (err.includes('CLIXML')) {
        err = (err.match(/<S S="Error">([^<]*)<\/S>/g) || []).map((x) => x.replace(/<\/?S[^>]*>/g, '')).join('').replace(/_x000D__x000A_/g, '\n');
      }
      const key = Object.keys(MESSAGES).find((k) => err.includes(k) || out.includes(k));
      reject(new Error(key ? MESSAGES[key](req) : `操作桌面程序失败：${(err || out).trim().split('\n')[0].slice(0, 300)}`));
    });
  });
}
