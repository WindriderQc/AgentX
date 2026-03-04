# AgentX Host Agent — Windows installer
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 -Server "http://192.168.1.100:3000" [-Token "mysecrettoken"]
#
# Creates a scheduled task that:
#   - Runs at system startup
#   - Uses a wrapper script with infinite restart loop (survives crashes)
#   - Restarts on failure with unlimited retries
#
# Prerequisites: Node.js 18+ installed

param(
    [Parameter(Mandatory=$true)]
    [string]$Server,
    [string]$Token = ""
)

$InstallDir = "C:\AgentX-Host-Agent"
$ServiceName = "AgentXHostAgent"
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $NodePath) {
    Write-Error "Node.js not found. Install Node.js 18+ first."
    exit 1
}

Write-Host "Installing AgentX Host Agent..." -ForegroundColor Cyan
Write-Host "  Server: $Server"
Write-Host "  Install dir: $InstallDir"

# Copy files (skip if already running from install dir)
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$SourceDir = (Get-Location).Path
if ($SourceDir -ne $InstallDir) {
    Copy-Item "agent.js", "package.json" -Destination $InstallDir -Force
}

# Install dependencies
Push-Location $InstallDir
& npm install --production --silent 2>$null
Pop-Location

# Generate start.bat wrapper with embedded config and restart loop.
# The loop sleeps 15s on crash then retries — no dependency on env vars.
$TokenLine = if ($Token) { "set AGENT_TOKEN=$Token" } else { "rem no token" }
$BatContent = @"
@echo off
set AGENTX_SERVER=$Server
$TokenLine
cd /d $InstallDir

:loop
echo [%date% %time%] Starting AgentX Host Agent...
node agent.js
echo [%date% %time%] Agent exited (code %errorlevel%). Restarting in 15s...
timeout /t 15 /nobreak >nul
goto loop
"@
Set-Content -Path "$InstallDir\start.bat" -Value $BatContent -Encoding ASCII

# Create scheduled task — runs the wrapper at startup.
# RestartCount is unlimited (999), interval 30s — belt-and-suspenders with the batch loop.
$Action = New-ScheduledTaskAction -Execute "$InstallDir\start.bat" -WorkingDirectory $InstallDir
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest

# Remove existing task if present
$running = Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
if ($running) {
    Stop-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false -ErrorAction SilentlyContinue
}

Register-ScheduledTask -TaskName $ServiceName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description "AgentX Host Monitoring Agent"

# Start immediately
Start-ScheduledTask -TaskName $ServiceName

Write-Host ""
Write-Host "Done! AgentX Host Agent installed and running." -ForegroundColor Green
Write-Host "  Status:  Get-ScheduledTask -TaskName $ServiceName"
Write-Host "  Logs:    type $InstallDir\start.bat (config is embedded)"
Write-Host "  Stop:    Stop-ScheduledTask -TaskName $ServiceName"
Write-Host "  Remove:  Unregister-ScheduledTask -TaskName $ServiceName; Remove-Item -Recurse $InstallDir"
