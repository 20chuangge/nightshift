# =============================================================================
#  tailscale-windows.ps1 - install Tailscale on Windows and join the human's
#  tailnet with a one-time auth key.
#
#      powershell -File tailscale-windows.ps1 -KeyFile <file> [-Name <device>] [-Log <file>]
#
#  Runs elevated in the background (setup-windows.ps1 when a machine is added,
#  the hub's "Install Tailscale" button otherwise). Tailscale reads the key from
#  the file (never a command line); the file is removed afterwards.
#  --unattended keeps it connected when nobody is signed in.
#  ASCII only: Windows PowerShell 5 reads a file without a BOM in the ANSI code
#  page. Results are codes (DESK_TS=done <ip> | DESK_TS=failed <why>) the hub words.
# =============================================================================
param(
  [Parameter(Mandatory = $true)][string]$KeyFile,
  [string]$Name = '',
  [string]$Log = (Join-Path $env:ProgramData 'Nightshift\tailscale.log')
)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path (Split-Path $Log) | Out-Null
function Say([string]$text) { Add-Content -Path $Log -Value $text -Encoding UTF8 }
Set-Content -Path $Log -Value "start $(Get-Date -Format s)" -Encoding UTF8

try {
  $exe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (-not (Test-Path $exe)) {
    Say 'downloading Tailscale'
    $msi = Join-Path $env:TEMP 'tailscale-setup.msi'
    $url = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi'
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
    # curl.exe (built into Windows 10/11) took 7 s for the 37 MB installer on a
    # VM where Invoke-WebRequest had not finished after minutes.
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path $curl) { & $curl -fsSL --retry 2 --max-time 900 -o $msi $url 2>&1 | ForEach-Object { Say "$_" } }
    if (-not (Test-Path $msi) -or (Get-Item $msi).Length -lt 1000000) {
      # Fallback; without the progress bar it is many times faster.
      $ProgressPreference = 'SilentlyContinue'
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $msi -TimeoutSec 900
    }
    if (-not (Test-Path $msi) -or (Get-Item $msi).Length -lt 1000000) { Say 'DESK_TS=failed download'; exit 1 }
    Say 'installing Tailscale'
    Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/quiet', '/norestart' -Wait
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 60 -and -not (Test-Path $exe); $i++) { Start-Sleep -Seconds 2 }
  }
  if (-not (Test-Path $exe)) { Say 'DESK_TS=failed download'; exit 1 }
  # The service needs a moment after a fresh install.
  for ($i = 0; $i -lt 30; $i++) {
    if ((Get-Service Tailscale -ErrorAction SilentlyContinue).Status -eq 'Running') { break }
    Start-Sleep -Seconds 2
  }
  $tsArgs = @('up', "--auth-key=file:$KeyFile", '--unattended')
  if ($Name) { $tsArgs += "--hostname=$Name" }
  & $exe @tsArgs 2>&1 | ForEach-Object { Say "$_" }
  if ($LASTEXITCODE -eq 0) {
    $ip = (& $exe ip -4 2>$null | Select-Object -First 1)
    Say "DESK_TS=done $ip"
  } else {
    Say 'DESK_TS=failed key'
  }
} catch {
  Say "DESK_TS=failed other $($_.Exception.Message)"
} finally {
  Remove-Item -Force $KeyFile -ErrorAction SilentlyContinue
}
