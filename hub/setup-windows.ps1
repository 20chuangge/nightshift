# =============================================================================
#  setup-windows.ps1 —— 把一台 Windows 电脑变成夜班 Hub
#  支持：Windows 10 1803+ / Windows 11 / Windows Server 2019+（x64、arm64）
#
#  夜班客户端「添加机器」经 SSH 自动调用它（需要那台电脑开着 OpenSSH 服务器，
#  账号是管理员）；也可以在那台电脑上以管理员身份手动运行：
#      powershell -ExecutionPolicy Bypass -File setup-windows.ps1 -Pkg desk-hub.tar.gz
#
#  按顺序做：
#    1. 识别系统，确认是管理员
#    2. Node.js：官方 zip 装进程序目录，不依赖系统里有没有 Node
#    3. 程序：只替换代码；config/、skills/ 只补缺，已有的 Bot 和设置不动
#    4. 计划任务 NightshiftHub：开机就在后台运行（不用登录），挂了自动拉起
#    5. 桌面：TightVNC 服务，只听 127.0.0.1，经 Hub 配对后才能看和接管
#    6. 放行防火墙端口；接电源时不睡眠（闲置电脑要一直能干活）
#    7. 启动并自检
#  重跑是安全的。
#
#  最后几行给 src/remote.mjs 解析（和 setup-linux.sh 相同）：
#      DESK_OS=… DESK_HUB_URL=… DESK_PAIR_CODE=… DESK_HUB_OK=1 DESK_DESKTOP_OK=1
# =============================================================================
param(
  [int]$Port = 4390,
  [string]$Pkg = '',
  [string]$AppDir = '',
  # TightVNC installer uploaded by the client (preferred over downloading here).
  [string]$VncMsi = '',
  # Node.js zip uploaded by the client (preferred over downloading here).
  [string]$NodeZip = '',
  # Test mode: download and unpack only, touch nothing system-wide.
  [switch]$NoSystem
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is 10x slower with the progress bar
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Say([string]$text) { Write-Output "[desk] $text" }
function Warn([string]$text) { Write-Output "[desk] 警告：$text" }
function Fail([string]$text) { Write-Output "[desk] $text"; exit 1 }
# Any unexpected error: one readable line (the installer shows the last lines),
# not PowerShell's multi-line error record.
trap { Write-Output "[desk] 出错：$($_.Exception.Message)（第 $($_.InvocationInfo.ScriptLineNumber) 行）"; exit 1 }

$TaskName = 'NightshiftHub'

# -----------------------------------------------------------------------------
Say '1/7 识别系统'
$os = Get-CimInstance Win32_OperatingSystem
$osName = "$($os.Caption) $($os.Version)".Trim()
$arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { '' } }
if (-not $arch) { Fail "不支持的 CPU 架构：$($env:PROCESSOR_ARCHITECTURE)" }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $NoSystem) { Fail '这个账号不是管理员；请换一个管理员账号（计划任务和防火墙都需要管理员权限）。' }
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { Fail '系统里没有 tar.exe（需要 Windows 10 1803 或更新的版本）。' }

# An existing install keeps its directory, and with it its bots and memory.
if (-not $AppDir) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing -and $existing.Actions[0].WorkingDirectory) { $AppDir = $existing.Actions[0].WorkingDirectory }
}
if (-not $AppDir) { $AppDir = Join-Path $env:ProgramData 'Nightshift\hub' }
Say "$osName（$arch），程序目录 $AppDir，运行账号 $env:USERNAME"
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

# -----------------------------------------------------------------------------
Say '2/7 Node.js'
function NodeOk([string]$exe) {
  if (-not $exe -or -not (Test-Path $exe)) { return $false }
  # "node -v" -> v22.23.4. (Passing JS with quotes via -p breaks: PowerShell 5.1
  # strips inner double quotes on the way to a native exe.)
  try { return ([int](((& $exe -v) -replace '^v', '') -split '\.')[0]) -ge 20 } catch { return $false }
}
$runtime = Join-Path $AppDir 'runtime'
$nodeExe = Join-Path $runtime 'node.exe'
if (-not (NodeOk $nodeExe) -and $NodeZip -and (Test-Path $NodeZip)) {
  # Brought over by the client: nothing to download here.
  Say '用夜班带过来的 Node（不用下载）'
  try {
    $tmp = Join-Path $env:TEMP "desk-node-$PID"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    Expand-Archive -Force -Path $NodeZip -DestinationPath $tmp
    $unpacked = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like 'node-v*' } | Select-Object -First 1
    if ($unpacked) {
      if (Test-Path $runtime) { Remove-Item -Recurse -Force $runtime }
      Move-Item $unpacked.FullName $runtime
    }
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    Remove-Item -Force $NodeZip -ErrorAction SilentlyContinue
  } catch { Warn "带过来的 Node 解压失败，改为下载：$($_.Exception.Message)" }
}
if (-not (NodeOk $nodeExe)) {
  $nodeExe = ''
  $tmp = Join-Path $env:TEMP "desk-node-$PID"
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  # Official build first, then a mirror that is fast from mainland China.
  foreach ($base in 'https://nodejs.org/dist/latest-v22.x', 'https://npmmirror.com/mirrors/node/latest-v22.x') {
    try {
      $sums = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 "$base/SHASUMS256.txt").Content
      if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
      $line = ($sums -split "`n") | Where-Object { $_ -match "node-v22\.[0-9.]+-win-$arch\.zip\s*$" } | Select-Object -First 1
      if (-not $line) { continue }
      $hash, $file = ($line.Trim() -split '\s+')
      Say "下载 $file（$base）"
      $zip = Join-Path $tmp $file
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 "$base/$file" -OutFile $zip
      if ((Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower() -ne $hash.ToLower()) { Warn "$file 校验不通过，换源"; continue }
      Expand-Archive -Force -Path $zip -DestinationPath $tmp
      $unpacked = Join-Path $tmp ($file -replace '\.zip$', '')
      if (Test-Path $runtime) { Remove-Item -Recurse -Force $runtime }
      Move-Item $unpacked $runtime
      $nodeExe = Join-Path $runtime 'node.exe'
      break
    } catch { Warn "从 $base 下载失败：$($_.Exception.Message)" }
  }
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
if (-not (NodeOk $nodeExe)) { Fail 'Node.js 安装失败（下载不到官方二进制）' }
Say "Node $(& $nodeExe -v)：$nodeExe"

# -----------------------------------------------------------------------------
Say "3/7 程序 → $AppDir"
$stage = Join-Path $env:TEMP "desk-stage-$PID"
New-Item -ItemType Directory -Force -Path $stage | Out-Null
if ($Pkg) {
  $pkgPath = (Resolve-Path $Pkg).Path
  & tar.exe -xzf $pkgPath -C $stage
  if ($LASTEXITCODE -ne 0) { Fail "解不开程序包：$pkgPath" }
} else {
  $src = Split-Path -Parent $PSScriptRoot
  foreach ($item in 'src', 'public', 'config', 'skills', 'hub', 'node_modules', 'package.json') {
    if (Test-Path (Join-Path $src $item)) { Copy-Item -Recurse -Force (Join-Path $src $item) $stage }
  }
}
if (-not (Test-Path (Join-Path $stage 'src\server.mjs'))) { Fail '程序包内容不对，缺 src\server.mjs' }

# Stop a running hub first: Windows will not replace files a process holds.
if (-not $NoSystem) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$AppDir*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}
# Code is replaced wholesale ...
foreach ($item in 'src', 'public', 'hub', 'node_modules') {
  $dst = Join-Path $AppDir $item
  if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
  if (Test-Path (Join-Path $stage $item)) { Copy-Item -Recurse -Force (Join-Path $stage $item) $AppDir }
}
Copy-Item -Force (Join-Path $stage 'package.json') $AppDir
# ... but config\ holds this machine's bots and model settings, and skills\
# what the bots learned: only fill in what is missing.
foreach ($item in 'config', 'skills') {
  $from = Join-Path $stage $item
  if (-not (Test-Path $from)) { continue }
  Get-ChildItem -Recurse -File $from | ForEach-Object {
    $rel = $_.FullName.Substring($from.Length).TrimStart('\')
    $dst = Join-Path (Join-Path $AppDir $item) $rel
    if (-not (Test-Path $dst)) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
      Copy-Item $_.FullName $dst
    }
  }
}
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'data'), (Join-Path $AppDir 'workspace') | Out-Null
# Bump SETUP_VERSION when this script changes the system: a machine set up
# with a lower number cannot take a code-only self-update.
$SETUP_VERSION = 1
Set-Content -Path (Join-Path $AppDir '.setup-version') -Value $SETUP_VERSION -Encoding ASCII

# The browser the bots drive: Edge ships with Windows; Chrome if installed.
$browser = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

# The task runs this wrapper: it sets the environment and restarts the hub if
# it ever exits (the Windows equivalent of systemd's Restart=always).
$launcher = Join-Path $AppDir 'start-hub.ps1'
@"
`$env:HOST = '0.0.0.0'
`$env:PORT = '$Port'
`$env:ASSIST_ALLOW_REMOTE = '1'
`$env:DESK_MACHINE_MODE = 'remote'
`$env:BROWSER_HEADLESS = '1'
$(if ($browser) { "`$env:CHROME_PATH = '$browser'" })
Set-Location '$AppDir'
while (`$true) {
  # "`$_" turns PowerShell 5.1's NativeCommandError wrapper back into the plain
  # stderr line, so the log reads like the server wrote it.
  & '$nodeExe' src\server.mjs 2>&1 | ForEach-Object { "`$_" } | Add-Content -Encoding UTF8 -Path '$AppDir\data\hub.log'
  Start-Sleep -Seconds 3
}
"@ | Set-Content -Encoding UTF8 -Path $launcher

if ($NoSystem) {
  Say '测试模式：不注册计划任务、不改防火墙和电源设置'
  Write-Output "DESK_OS=$osName"
  Write-Output "DESK_APP_DIR=$AppDir"
  Write-Output 'DESK_HUB_OK=0'
  exit 0
}

# -----------------------------------------------------------------------------
Say "4/7 计划任务 $TaskName"
# S4U: runs at startup without anyone logged in and without storing a
# password. It has no desktop (session 0), so the bots' browser is headless.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`"" -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtStartup
# The account from the Windows identity, not $env:USERDOMAIN\$env:USERNAME:
# over SSH those can name a domain the account does not map to (0x80070534).
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# -----------------------------------------------------------------------------
Say '5/7 桌面：TightVNC（只听本机，经 Hub 配对后才能看和接管）'
# The machine's real screen (login screen when nobody is signed in) for the
# live view and takeover. TightVNC runs as a service; it accepts loopback only
# and has no VNC password, the hub's authenticated relay is the only way in.
$desktopOk = 0
try {
  if (-not (Get-Service tvnserver -ErrorAction SilentlyContinue)) {
    $msi = Join-Path $env:TEMP 'desk-tightvnc.msi'
    if ($VncMsi -and (Test-Path $VncMsi)) {
      # Brought along by the client: no download from this machine at all.
      Move-Item -Force (Resolve-Path $VncMsi).Path $msi
      Say '使用客户端带来的 TightVNC 安装包'
    } else {
      $msiUrl = 'https://www.tightvnc.com/download/2.8.90/tightvnc-2.8.90-gpl-setup-64bit.msi'
      try {
        $page = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 'https://www.tightvnc.com/download.php').Content
        $m = [regex]::Match([string]$page, '/download/([0-9.]+)/tightvnc-[0-9.]+-gpl-setup-64bit\.msi')
        if ($m.Success) { $msiUrl = "https://www.tightvnc.com$($m.Value)" }
      } catch { }
      Say "下载 $(Split-Path -Leaf $msiUrl)"
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 $msiUrl -OutFile $msi
    }
    # No published checksum: require GlavSoft's valid Authenticode signature.
    $sig = Get-AuthenticodeSignature $msi
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'GlavSoft') {
      throw "安装包签名不对（$($sig.Status) $($sig.SignerCertificate.Subject)），不装"
    }
    $msiArgs = @('/i', "`"$msi`"", '/quiet', '/norestart', 'ADDLOCAL=Server', 'SERVER_REGISTER_AS_SERVICE=1',
      'SERVER_ADD_FIREWALL_EXCEPTION=0', 'SET_USEVNCAUTHENTICATION=1', 'VALUE_OF_USEVNCAUTHENTICATION=0',
      'SET_LOOPBACKONLY=1', 'VALUE_OF_LOOPBACKONLY=1', 'SET_ALLOWLOOPBACK=1', 'VALUE_OF_ALLOWLOOPBACK=1',
      'SET_ACCEPTHTTPCONNECTIONS=1', 'VALUE_OF_ACCEPTHTTPCONNECTIONS=0')
    $p = Start-Process msiexec.exe -ArgumentList $msiArgs -Wait -PassThru
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "msiexec 退出码 $($p.ExitCode)" }
    Remove-Item $msi -ErrorAction SilentlyContinue
  }
  # Enforce the safe settings on every run, whoever installed it.
  $reg = 'HKLM:\SOFTWARE\TightVNC\Server'
  if (Test-Path $reg) {
    foreach ($kv in @(@('LoopbackOnly', 1), @('AllowLoopback', 1), @('UseVncAuthentication', 0),
                      @('AcceptHttpConnections', 0), @('RfbPort', 5900), @('RemoveWallpaper', 0))) {
      Set-ItemProperty -Path $reg -Name $kv[0] -Value $kv[1] -Type DWord
    }
  }
  Set-Service tvnserver -StartupType Automatic
  Restart-Service tvnserver -Force
  for ($i = 0; $i -lt 15 -and -not $desktopOk; $i++) {
    Start-Sleep -Seconds 1
    $tcp = New-Object Net.Sockets.TcpClient
    try { $tcp.Connect('127.0.0.1', 5900); $desktopOk = 1 } catch { } finally { $tcp.Close() }
  }
  if (-not $desktopOk) { Warn 'TightVNC 装好了但 5900 端口没起来，实时画面暂时看不到' }
} catch {
  Warn "桌面没配好：$($_.Exception.Message)；Hub 本身不受影响"
}

Say "6/7 放行端口 $Port，接电源时不睡眠"
Get-NetFirewallRule -DisplayName 'Nightshift Hub' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Nightshift Hub' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
& powercfg.exe /change standby-timeout-ac 0 | Out-Null
& powercfg.exe /change hibernate-timeout-ac 0 | Out-Null

# -----------------------------------------------------------------------------
Say '7/7 启动并自检'
Start-ScheduledTask -TaskName $TaskName
$code = ''
for ($i = 0; $i -lt 40 -and -not $code; $i++) {
  Start-Sleep -Seconds 1
  $sec = Join-Path $AppDir 'data\security.json'
  if (Test-Path $sec) {
    try { $code = [string](Get-Content -Raw $sec | ConvertFrom-Json).code } catch { }
  }
}
$hubOk = 0
for ($i = 0; $i -lt 40; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/api/health"
    if ($r.StatusCode -eq 200) { $hubOk = 1; break }
  } catch { }
  Start-Sleep -Seconds 1
}
if (-not $hubOk) {
  Write-Output "[desk] Hub 没能在 $Port 上应答，最近日志："
  Get-Content -Tail 15 (Join-Path $AppDir 'data\hub.log') -ErrorAction SilentlyContinue | ForEach-Object { Write-Output $_ }
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 1).IPAddress
if (-not $ip) { $ip = '127.0.0.1' }
Write-Output "DESK_OS=$osName"
Write-Output "DESK_HUB_URL=http://${ip}:$Port"
Write-Output "DESK_PAIR_CODE=$(if ($code) { $code } else { 'unknown' })"
Write-Output "DESK_APP_DIR=$AppDir"
Write-Output "DESK_HUB_OK=$hubOk"
# One shared desktop on Windows (the console via TightVNC); bots browse headless.
Write-Output "DESK_DESKTOP_OK=$desktopOk"
