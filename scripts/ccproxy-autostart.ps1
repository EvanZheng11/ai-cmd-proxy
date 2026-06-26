<#
.SYNOPSIS
  ccproxy 开机自启脚本 - 由任务计划程序调用
.DESCRIPTION
  在系统启动/用户登录时自动启动 CommandCode Proxy。
  由 Windows 任务计划程序 "CCProxyAutostart" 定期触发。
#>

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManagerScript = Join-Path $ScriptDir 'command-code-proxy.ps1'
$LogDir = Join-Path $ScriptDir 'logs'
$PidFile = Join-Path $ScriptDir 'proxy.pid'

# 等待网络就绪
Start-Sleep -Seconds 5

# 检查是否已经在运行
if (Test-Path $PidFile) {
  $rawPid = Get-Content $PidFile -Raw -ErrorAction SilentlyContinue
  if ($rawPid) {
    $proc = Get-Process -Id $rawPid.Trim() -ErrorAction SilentlyContinue
    if ($proc) {
      # 已在运行，不需要再启动
      exit 0
    }
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

# 检查配置文件是否有 API Key
$cfg = & "$PSScriptRoot\command-code-proxy.ps1" status *>&1 | Out-Null
$configFile = Join-Path $ScriptDir 'proxy-config.json'
if (-not (Test-Path $configFile)) {
  # 没有配置，记录日志但退出
  $mgmtLog = Join-Path $LogDir "mgmt-$(Get-Date -Format 'yyyy-MM-dd').log"
  $time = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $mgmtLog -Value "[$time] Autostart: config not found, skipped" -Encoding UTF8 -ErrorAction SilentlyContinue
  exit 0
}

# 启动代理
& $ManagerScript start
