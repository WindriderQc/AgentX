[CmdletBinding()]
param(
    [ValidateSet("status", "start", "stop", "restart")]
    [string]$Action = "status"
)

$ErrorActionPreference = "Stop"
$TaskName = "VoiX-Autostart"
$Port = 8091
$BaseUrl = "http://127.0.0.1:$Port"
$Root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')

function Get-VoiXTask {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Get-VoiXProcesses {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $owned = [Collections.Generic.HashSet[int]]::new()
    foreach ($process in $all) {
        $commandLine = [string]$process.CommandLine
        $exactUvicorn = $commandLine -match "uvicorn\s+app\.service:app" -and
            $commandLine -match "--port\s+$Port"
        $rootBound = $commandLine -match [regex]::Escape($Root)
        if ($exactUvicorn -and $rootBound) {
            $null = $owned.Add([int]$process.ProcessId)
        }
    }

    # Windows virtual-environment launchers can spawn the base interpreter. Its
    # command line no longer contains the repository path, so include descendants
    # only after anchoring the tree to an exact root-bound VoiX uvicorn process.
    do {
        $changed = $false
        foreach ($process in $all) {
            if ($owned.Contains([int]$process.ParentProcessId) -and
                -not $owned.Contains([int]$process.ProcessId)) {
                $null = $owned.Add([int]$process.ProcessId)
                $changed = $true
            }
        }
    } while ($changed)

    @($all | Where-Object { $owned.Contains([int]$_.ProcessId) })
}

function Stop-VoiXProcesses {
    $processes = @(Get-VoiXProcesses)
    if ($processes.Count -eq 0) { return }
    $ids = @($processes | ForEach-Object { [int]$_.ProcessId })
    Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue

    $deadline = (Get-Date).AddSeconds(5)
    do {
        $remaining = @(Get-VoiXProcesses)
        if ($remaining.Count -eq 0) { return }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    $remainingIds = (@(Get-VoiXProcesses) | ForEach-Object ProcessId) -join ", "
    throw "VoiX process tree did not exit cleanly (PIDs: $remainingIds)."
}

function Get-VoiXListener {
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $connection) { return $null }

    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
    $commandLine = if ($processInfo) { [string]$processInfo.CommandLine } else { "" }
    $parentInfo = if ($processInfo) {
        Get-CimInstance Win32_Process -Filter "ProcessId = $($processInfo.ParentProcessId)" -ErrorAction SilentlyContinue
    } else { $null }
    $parentExecutable = if ($parentInfo) { [string]$parentInfo.ExecutablePath } else { "" }
    $parentCommandLine = if ($parentInfo) { [string]$parentInfo.CommandLine } else { "" }
    $exactUvicorn = $commandLine -match "uvicorn\s+app\.service:app" -and
        $commandLine -match "--port\s+$Port"
    $rootBound = $commandLine -match [regex]::Escape($Root) -or
        ($parentExecutable.StartsWith("$Root\", [StringComparison]::OrdinalIgnoreCase) -and
         $parentCommandLine -match "uvicorn\s+app\.service:app" -and
         $parentCommandLine -match "--port\s+$Port")
    $owned = $processInfo -and
        $processInfo.Name -match "python|uvicorn" -and
        $exactUvicorn -and
        $rootBound

    [pscustomobject]@{
        Pid = [int]$connection.OwningProcess
        Name = if ($processInfo) { [string]$processInfo.Name } else { "unknown" }
        OwnedByVoiX = [bool]$owned
    }
}

function Get-VoiXHealth {
    try {
        Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get -TimeoutSec 3
    } catch {
        return $null
    }
}

function Wait-VoiXOnline {
    param([int]$TimeoutSeconds = 180)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $health = Get-VoiXHealth
        if ($health) { return $health }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "VoiX did not become healthy within $TimeoutSeconds seconds."
}

function Show-VoiXStatus {
    $task = Get-VoiXTask
    $listener = Get-VoiXListener
    $health = Get-VoiXHealth
    $config = $null
    if ($health) {
        try { $config = Invoke-RestMethod -Uri "$BaseUrl/config" -TimeoutSec 3 } catch {}
    }

    [pscustomobject]@{
        Service = if ($health) { "online" } else { "offline" }
        Version = if ($health) { $health.version } else { $null }
        ManagedTask = if ($task) { [string]$task.State } else { "not installed" }
        ListenerPid = if ($listener) { $listener.Pid } else { $null }
        ListenerOwnedByVoiX = if ($listener) { $listener.OwnedByVoiX } else { $false }
        Warmup = if ($health) { [string]$health.warmup.state } else { $null }
        Recognition = if ($config) { $config.static.whisper_model } else { $null }
        Synthesis = if ($config) { $config.config.tts_provider } else { $null }
    }
}

function Start-VoiX {
    if (Get-VoiXHealth) {
        Write-Host "VoiX is already online."
        Show-VoiXStatus
        return
    }
    $task = Get-VoiXTask
    if (-not $task) {
        throw "Scheduled task '$TaskName' is not installed. Run .\start.ps1 from $Root for a foreground development launch."
    }
    if ([string]$task.State -eq "Running" -or @(Get-VoiXProcesses).Count -gt 0) {
        Write-Host "Cleaning an unhealthy managed VoiX process before start."
        Stop-VoiX
    }
    Start-ScheduledTask -TaskName $TaskName
    $null = Wait-VoiXOnline
    Write-Host "VoiX is online."
    Show-VoiXStatus
}

function Stop-VoiX {
    $ownedBeforeTaskStop = @(Get-VoiXProcesses)
    $task = Get-VoiXTask
    if ($task -and [string]$task.State -eq "Running") {
        Stop-ScheduledTask -TaskName $TaskName
    }

    $deadline = (Get-Date).AddSeconds(8)
    do {
        $listener = Get-VoiXListener
        $task = Get-VoiXTask
        $processes = @(Get-VoiXProcesses)
        if (-not $listener -and [string]$task.State -ne "Running" -and $processes.Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    # A task can report Ready while its virtual-environment child interpreter is
    # still alive before binding the port. Kill only the exact root-anchored VoiX
    # tree so restart cannot inherit a hidden startup process.
    $capturedIdsStillAlive = @(
        $ownedBeforeTaskStop |
            Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
            ForEach-Object { [int]$_.ProcessId }
    )
    if ($capturedIdsStillAlive.Count -gt 0) {
        Stop-Process -Id $capturedIdsStillAlive -Force -ErrorAction SilentlyContinue
    }
    Stop-VoiXProcesses

    $listener = Get-VoiXListener
    if ($listener) {
        if (-not $listener.OwnedByVoiX) {
            throw "Port $Port is still owned by an unrelated process (PID $($listener.Pid)); refusing to stop it."
        }
        Stop-Process -Id $listener.Pid -Force
    }

    Write-Host "VoiX is offline."
    Show-VoiXStatus
}

switch ($Action) {
    "start" { Start-VoiX }
    "stop" { Stop-VoiX }
    "restart" { Stop-VoiX; Start-VoiX }
    default { Show-VoiXStatus }
}
