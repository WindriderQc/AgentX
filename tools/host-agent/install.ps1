# AgentX Host Agent — Windows installer (uses NSSM or runs as scheduled task)
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 -Server "http://192.168.1.100:3000" [-Token "mysecrettoken"]
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

# Copy files
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item "agent.js", "package.json" -Destination $InstallDir -Force

# Install dependencies
Push-Location $InstallDir
& npm install --production --silent 2>$null
Pop-Location

# Set environment variables (machine-level)
[System.Environment]::SetEnvironmentVariable("AGENTX_SERVER", $Server, "Machine")
if ($Token) {
    [System.Environment]::SetEnvironmentVariable("AGENT_TOKEN", $Token, "Machine")
}

# Create a scheduled task that runs at startup
$Action = New-ScheduledTaskAction -Execute $NodePath -Argument "$InstallDir\agent.js" -WorkingDirectory $InstallDir
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest

# Remove existing task if present
Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask -TaskName $ServiceName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description "AgentX Host Monitoring Agent"

# Start immediately
Start-ScheduledTask -TaskName $ServiceName

Write-Host ""
Write-Host "Done! AgentX Host Agent installed and running." -ForegroundColor Green
Write-Host "  Status:  Get-ScheduledTask -TaskName $ServiceName"
Write-Host "  Stop:    Stop-ScheduledTask -TaskName $ServiceName"
Write-Host "  Remove:  Unregister-ScheduledTask -TaskName $ServiceName; Remove-Item -Recurse $InstallDir"
