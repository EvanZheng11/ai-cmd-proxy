#Requires -Version 5.1
<#
.SYNOPSIS
  CommandCode Proxy Manager
.DESCRIPTION
  Manage local command-code-proxy: start, stop, restart, status, config, logs.
  Config file stored at proxy-config.json in the same directory.
.EXAMPLE
  .\command-code-proxy.ps1                  # Interactive menu
  .\command-code-proxy.ps1 config          # Set or change API Key
  .\command-code-proxy.ps1 start           # Start proxy
  .\command-code-proxy.ps1 status          # Check status
  .\command-code-proxy.ps1 stop            # Stop proxy
  .\command-code-proxy.ps1 restart         # Restart
  .\command-code-proxy.ps1 logs            # View recent logs
#>

param(
  [Parameter(Position = 0)]
  [ValidateSet('menu', 'config', 'start', 'stop', 'restart', 'status', 'logs')]
  [string]$Command = 'menu'
)

# Paths
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path (Join-Path $ScriptDir '..')
$ProxyBin    = Join-Path $ProjectRoot 'bin\command-code-proxy.exe'
$ConfigFile  = Join-Path $ProjectRoot 'proxy-config.json'
$PidFile     = Join-Path $ProjectRoot 'proxy.pid'
$LogDir      = Join-Path $ProjectRoot 'logs'

# Defaults
$DefaultHost = '127.0.0.1'
$DefaultPort = 55990

function Read-Config {
  if (Test-Path $ConfigFile) {
    $raw = Get-Content $ConfigFile -Raw -Encoding UTF8
    return ($raw | ConvertFrom-Json)
  }
  return $null
}

function Write-Config($cfg) {
  $cfg | ConvertTo-Json -Compress | Set-Content $ConfigFile -Encoding UTF8
}

function Get-Config {
  $cfg = Read-Config
  if (-not $cfg) {
    return @{ host = $DefaultHost; port = $DefaultPort; apiKey = '' }
  }
  return @{
    host   = if ($cfg.host)   { $cfg.host }   else { $DefaultHost }
    port   = if ($cfg.port)   { $cfg.port }   else { $DefaultPort }
    apiKey = if ($cfg.apiKey) { $cfg.apiKey } else { '' }
  }
}

function Get-RunningPid {
  if (Test-Path $PidFile) {
    $rawPid = Get-Content $PidFile -Raw -ErrorAction SilentlyContinue
    if ($rawPid) {
      $rawPid = $rawPid.Trim()
      if ($rawPid) {
        $proc = Get-Process -Id $rawPid -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq 'command-code-proxy') {
          return [int]$rawPid
        }
      }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }
  return $null
}

function Write-Log($msg) {
  $time = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $line = "[$time] $msg"
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
  $mgmtLog = Join-Path $LogDir "mgmt-$(Get-Date -Format 'yyyy-MM-dd').log"
  Add-Content -Path $mgmtLog -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
}

# ---- Commands ----

function Invoke-Config {
  $cfg = Get-Config

  Write-Host 'CommandCode Proxy Configuration' -ForegroundColor Cyan
  Write-Host ''

  $keyPreview = if ($cfg.apiKey) { $cfg.apiKey.Substring(0, [Math]::Min(8, $cfg.apiKey.Length)) + '****' } else { '(not set)' }
  Write-Host "Current API Key : $keyPreview" -ForegroundColor Yellow
  $keyInput = Read-Host "Enter new API Key (leave blank to keep)"
  if ($keyInput) { $cfg.apiKey = $keyInput }

  $portInput = Read-Host "Port (default $($cfg.port), blank to keep)"
  if ($portInput) { $cfg.port = [int]$portInput }

  $hostInput = Read-Host "Bind address (default $($cfg.host), 0.0.0.0 for LAN, blank to keep)"
  if ($hostInput) { $cfg.host = $hostInput }

  Write-Config $cfg
  Write-Host ''
  Write-Host "Config saved to $ConfigFile" -ForegroundColor Green

  $runningPid = Get-RunningPid
  if ($runningPid) {
    Write-Host "Proxy is running (PID $runningPid), run restart to apply changes" -ForegroundColor Yellow
  }
}

function Invoke-Start {
  $proxyPid = Get-RunningPid
  if ($proxyPid) {
    Write-Host "Proxy already running, PID: $proxyPid" -ForegroundColor Yellow
    Write-Host "  Run 'restart' to restart" -ForegroundColor Gray
    return
  }

  $cfg = Get-Config
  if (-not $cfg.apiKey) {
    Write-Host "API Key not set. Run config first" -ForegroundColor Red
    return
  }

  if (-not (Test-Path $ProxyBin)) {
    Write-Host "Binary not found: $ProxyBin" -ForegroundColor Red
    return
  }

  $argsList = @("-host", $cfg.host, "-port", "$($cfg.port)", "-api-key", $cfg.apiKey, "-debug")

  Write-Host "Starting CommandCode Proxy..." -ForegroundColor Cyan
  Write-Host "  Host : $($cfg.host)"
  Write-Host "  Port : $($cfg.port)"
  Write-Host "  Log  : $LogDir"

  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
  $logFile  = Join-Path $LogDir "$(Get-Date -Format 'yyyy-MM-dd').log"
  $errFile  = Join-Path $LogDir "$(Get-Date -Format 'yyyy-MM-dd')-err.log"

  try {
    $process = Start-Process -FilePath $ProxyBin `
      -ArgumentList $argsList `
      -WindowStyle Hidden `
      -RedirectStandardOutput $logFile `
      -RedirectStandardError $errFile `
      -PassThru -ErrorAction Stop
  } catch {
    Write-Host "Failed to start: $_" -ForegroundColor Red
    return
  }

  $process.Id | Out-File $PidFile -Encoding UTF8
  Write-Log 'Proxy started'

  Write-Host ''
  Write-Host "Proxy started, PID: $($process.Id)" -ForegroundColor Green
  Write-Host "  Test   : curl http://$($cfg.host):$($cfg.port)/health"
  Write-Host "  Status : .\command-code-proxy.ps1 status"
  Write-Host "  Logs   : .\command-code-proxy.ps1 logs"
}

function Invoke-Stop {
  $proxyPid = Get-RunningPid
  if (-not $proxyPid) {
    Write-Host 'Proxy is not running' -ForegroundColor Yellow
    return
  }

  Write-Host "Stopping proxy (PID: $proxyPid)..." -ForegroundColor Cyan
  try {
    Stop-Process -Id $proxyPid -Force -ErrorAction Stop
  } catch {
    # Fallback: use WMI to terminate
    try {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $proxyPid" -ErrorAction Stop
      if ($proc) {
        $proc | Invoke-CimMethod -MethodName Terminate -ErrorAction Stop | Out-Null
      }
    } catch {
      Write-Host "Failed to stop: $_" -ForegroundColor Red
      return
    }
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  Write-Log 'Proxy stopped'
  Write-Host 'Proxy stopped' -ForegroundColor Green
}

function Invoke-Restart {
  Invoke-Stop
  Start-Sleep -Seconds 1
  Invoke-Start
}

function Invoke-Status {
  $cfg = Get-Config
  $proxyPid = Get-RunningPid

  Write-Host 'CommandCode Proxy Status' -ForegroundColor Cyan
  Write-Host ''

  if ($proxyPid) {
    $proc = Get-Process -Id $proxyPid
    $mem = [math]::Round($proc.WorkingSet64 / 1MB, 1)
    $cpu = $proc.TotalProcessorTime.TotalSeconds.ToString('F1')
    Write-Host "Status  : Running" -ForegroundColor Green
    Write-Host "PID     : $proxyPid"
    Write-Host "Memory  : ${mem} MB"
    Write-Host "CPU     : ${cpu}s"
  } else {
    Write-Host "Status  : Stopped" -ForegroundColor Red
  }

  Write-Host ''
  Write-Host 'Config:' -ForegroundColor Yellow
  Write-Host "  Host     : $($cfg.host)"
  Write-Host "  Port     : $($cfg.port)"
  $keyStatus = if ($cfg.apiKey) { 'Set' } else { 'Not set' }
  Write-Host "  API Key  : $keyStatus" -ForegroundColor $(if ($cfg.apiKey) { 'Green' } else { 'Red' })

  if ($proxyPid) {
    try {
      $resp = Invoke-WebRequest -Uri "http://$($cfg.host):$($cfg.port)/health" -TimeoutSec 3 -UseBasicParsing
      Write-Host ''
      Write-Host "Health  : OK (HTTP $($resp.StatusCode))" -ForegroundColor Green
    } catch {
      Write-Host ''
      Write-Host "Health  : No response" -ForegroundColor Red
    }
  }

  Write-Host ''
  Write-Host 'Recent mgmt logs:' -ForegroundColor Yellow
  $mgmtLog = Join-Path $LogDir "mgmt-$(Get-Date -Format 'yyyy-MM-dd').log"
  if (Test-Path $mgmtLog) {
    Get-Content $mgmtLog -Tail 5 | ForEach-Object { Write-Host "  $_" }
  } else {
    Write-Host '  (no logs yet)' -ForegroundColor Gray
  }
}

function Invoke-Logs {
  $logFile = Join-Path $LogDir "$(Get-Date -Format 'yyyy-MM-dd').log"
  $mgmtLog = Join-Path $LogDir "mgmt-$(Get-Date -Format 'yyyy-MM-dd').log"
  Write-Host '=== Proxy output ===' -ForegroundColor Cyan
  if (Test-Path $logFile) {
    Get-Content $logFile -Tail 30
  } else {
    Write-Host '  (no proxy output yet)' -ForegroundColor Gray
  }
  Write-Host ''
  Write-Host '=== Management log ===' -ForegroundColor Cyan
  if (Test-Path $mgmtLog) {
    Get-Content $mgmtLog -Tail 20
  } else {
    Write-Host '  (no mgmt log yet)' -ForegroundColor Gray
  }
}

# ---- Menu ----

function Show-Menu {
  $host.UI.RawUI.WindowTitle = 'CommandCode Proxy Manager'

  do {
    Clear-Host
    $cfg = Get-Config
    $proxyPid = Get-RunningPid
    $running = $proxyPid -ne $null

    # Title
    Write-Host '  CommandCode Proxy' -ForegroundColor Cyan
    Write-Host '  ==================' -ForegroundColor Cyan
    Write-Host ''

    # Status bar
    if ($running) {
      $proc = Get-Process -Id $proxyPid
      $mem = [math]::Round($proc.WorkingSet64 / 1MB, 1)
      Write-Host "  [运行中] PID: $proxyPid  内存: ${mem}MB" -ForegroundColor Green
    } else {
      Write-Host '  [已停止]' -ForegroundColor Red
    }

    $keyStatus = if ($cfg.apiKey) { '已设置' } else { '未设置' }
    Write-Host "  http://$($cfg.host):$($cfg.port)  |  API Key: $keyStatus" -ForegroundColor Gray
    Write-Host ''

    # Health check
    if ($running) {
      try {
        $resp = Invoke-WebRequest -Uri "http://$($cfg.host):$($cfg.port)/health" -TimeoutSec 2 -UseBasicParsing
        Write-Host "  [正常] HTTP $($resp.StatusCode)" -ForegroundColor Green
      } catch {
        Write-Host '  [异常] 无响应' -ForegroundColor Red
      }
      Write-Host ''
    }

    # Menu
    Write-Host '  ╔════╤══════════════════╗' -ForegroundColor DarkGray
    Write-Host '  ║ 编号│ 功能             ║' -ForegroundColor DarkGray
    Write-Host '  ╠════╪══════════════════╣' -ForegroundColor DarkGray
    $c1 = if ($running) { 'DarkGray' } else { 'White' }
    $c2 = if ($running) { 'DarkGray' } else { 'White' }
    $c3 = if ($running) { 'White' } else { 'DarkGray' }
    $c4 = if ($running) { 'White' } else { 'DarkGray' }
    Write-Host "  ║ 1  │  [配置] API Key    ║" -ForegroundColor $c1
    Write-Host "  ║ 2  │  [启动] 启动代理    ║" -ForegroundColor $c2
    Write-Host "  ║ 3  │  [停止] 停止代理    ║" -ForegroundColor $c3
    Write-Host "  ║ 4  │  [重启] 重启代理    ║" -ForegroundColor $c4
    Write-Host '  ║ 5  │  [状态] 查看状态    ║' -ForegroundColor White
    Write-Host '  ║ 6  │  [日志] 查看日志    ║' -ForegroundColor White
    Write-Host '  ║ 0  │  [退出] 退出        ║' -ForegroundColor White
    Write-Host '  ╚════╧══════════════════╝' -ForegroundColor DarkGray
    Write-Host ''

    $choice = Read-Host '  请输入编号'

    switch ($choice) {
      '1' { Invoke-Config }
      '2' { Invoke-Start }
      '3' { Invoke-Stop }
      '4' { Invoke-Restart }
      '5' { Invoke-Status }
      '6' { Invoke-Logs }
      '0' { Write-Host '  再见' -ForegroundColor Cyan; break }
      default {
        Write-Host '  无效编号，请重新输入' -ForegroundColor Red
        Start-Sleep -Seconds 1
        continue
      }
    }

    if ($choice -ne '0') {
      Write-Host ''
      $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    }

  } while ($choice -ne '0')

  $host.UI.RawUI.WindowTitle = 'Windows PowerShell'
}

# ---- Entry ----

if ($Command -eq 'menu') {
  Show-Menu
} else {
  switch ($Command) {
    'config'  { Invoke-Config }
    'start'   { Invoke-Start }
    'stop'    { Invoke-Stop }
    'restart' { Invoke-Restart }
    'status'  { Invoke-Status }
    'logs'    { Invoke-Logs }
  }
}
