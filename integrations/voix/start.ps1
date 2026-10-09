$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

$port = 8091
$healthUrl = "http://127.0.0.1:$port/health"
$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
    Write-Host "Virtual environment not found. Create it with: python -m venv .venv"
    exit 1
}

function Test-VoiXHealth {
    param([string]$Url)

    try {
        $response = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 2
        return $null -ne $response
    } catch {
        return $false
    }
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    $name = if ($process) { $process.Name } else { "unknown" }
    $commandLine = if ($process) { $process.CommandLine } else { "" }

    if (Test-VoiXHealth -Url $healthUrl) {
        Write-Host "VoiX is already running at $healthUrl (PID $($listener.OwningProcess), process $name)."
        exit 0
    }

    $looksLikePython = $name -match "python|uvicorn"
    $looksLikeVoiX = $commandLine -match [regex]::Escape($PSScriptRoot)

    if ($looksLikePython -or $looksLikeVoiX) {
        Write-Host "Stopping existing VoiX-like listener on port $port (PID $($listener.OwningProcess), process $name)"
        Stop-Process -Id $listener.OwningProcess -Force
        Start-Sleep -Seconds 1
    } else {
        Write-Host "Port $port is occupied by PID $($listener.OwningProcess) ($name)."
        if ($commandLine) {
            Write-Host "Command line: $commandLine"
        }
        Write-Host "Refusing to kill an unrelated process. Free the port, then run this script again."
        exit 1
    }
}

$logDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir "voix.log"
# Keep the previous run for post-mortem: a silent startup warm-up failure makes
# the first request pay the model load and is otherwise invisible from a hidden window.
if (Test-Path $log) { Move-Item -Path $log -Destination (Join-Path $logDir "voix.prev.log") -Force }

# uvicorn logs to stderr by design; with ErrorActionPreference=Stop, merging it
# into the success stream would make the first normal log line a terminating error.
$ErrorActionPreference = "Continue"
& $venvPython -u -m uvicorn app.service:app --host 0.0.0.0 --port $port --loop asyncio --http h11 2>&1 | Tee-Object -FilePath $log
