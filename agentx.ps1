$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$envFile = if ($env:AGENTX_ENV_FILE) { $env:AGENTX_ENV_FILE } else { Join-Path $root 'config\agentx.env' }
$projectName = if ($env:AGENTX_PROJECT_NAME) { $env:AGENTX_PROJECT_NAME } else { 'agentx' }
if ($projectName -cnotmatch '^[a-z0-9][a-z0-9_-]*$') { throw 'AGENTX_PROJECT_NAME must be a lowercase Compose project name.' }
$compose = @('--project-name', $projectName, '--env-file', $envFile, '-f', 'docker-compose.yml')
$ollamaCompose = $compose + @('-f', 'docker-compose.ollama.yml')
if ($env:AGENTX_COMPOSE_OVERRIDE) {
    $compose += @('-f', $env:AGENTX_COMPOSE_OVERRIDE)
    $ollamaCompose += @('-f', $env:AGENTX_COMPOSE_OVERRIDE)
}
$initialBuildRevision = $env:AGENTX_BUILD_REVISION
if (-not $env:AGENTX_BUILD_REVISION) {
    if (Get-Command git -ErrorAction SilentlyContinue) {
        $env:AGENTX_BUILD_REVISION = & git rev-parse HEAD 2>$null
        if (& git status --porcelain --untracked-files=normal 2>$null) { $env:AGENTX_BUILD_REVISION += '-dirty' }
    }
    if (-not $env:AGENTX_BUILD_REVISION) { $env:AGENTX_BUILD_REVISION = 'unknown' }
}
$agentXHealthResponseLimitBytes = 64KB
$agentXOllamaVersionResponseLimitBytes = 16KB

function Invoke-AgentXBoundedHttpGet {
    param(
        [Parameter(Mandatory = $true)] [Uri] $Uri,
        [Parameter(Mandatory = $true)] [ValidateRange(1, 60)] [int] $TimeoutSec,
        [Parameter(Mandatory = $true)] [ValidateRange(1, 1048576)] [int] $MaximumResponseBytes,
        [Parameter(Mandatory = $true)] [ValidateRange(0, 0)] [int] $MaximumRedirection
    )

    if ($Uri.Scheme -ne [Uri]::UriSchemeHttp -or -not $Uri.IsLoopback) {
        throw 'Launcher HTTP checks are restricted to unencrypted loopback endpoints.'
    }

    if (-not [Type]::GetType('System.Net.Http.HttpClient, System.Net.Http', $false)) {
        Add-Type -AssemblyName System.Net.Http
    }

    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $handler.UseProxy = $false
    $handler.MaxResponseHeadersLength = 16
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
    $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $Uri)
    $cancellation = New-Object System.Threading.CancellationTokenSource
    $cancellation.CancelAfter([TimeSpan]::FromSeconds($TimeoutSec))

    try {
        $response = $client.SendAsync(
            $request,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead,
            $cancellation.Token
        ).GetAwaiter().GetResult()
        try {
            $statusCode = [int] $response.StatusCode
            if ($statusCode -ge 300 -and $statusCode -lt 400) {
                throw "Launcher HTTP checks reject redirects (HTTP $statusCode)."
            }
            if (-not $response.IsSuccessStatusCode) {
                throw "Launcher HTTP check returned HTTP $statusCode."
            }

            $declaredLength = $response.Content.Headers.ContentLength
            if ($null -ne $declaredLength -and [long] $declaredLength -gt $MaximumResponseBytes) {
                throw "Launcher HTTP response exceeded the $MaximumResponseBytes-byte limit."
            }

            $responseStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            try {
                $body = New-Object System.IO.MemoryStream
                try {
                    $readBuffer = New-Object byte[] ([Math]::Min(8192, $MaximumResponseBytes + 1))
                    while ($true) {
                        $remainingWithSentinel = ($MaximumResponseBytes - [int] $body.Length) + 1
                        $readLength = [Math]::Min($readBuffer.Length, $remainingWithSentinel)
                        $read = $responseStream.ReadAsync(
                            $readBuffer,
                            0,
                            $readLength,
                            $cancellation.Token
                        ).GetAwaiter().GetResult()
                        if ($read -eq 0) { break }
                        if (($body.Length + $read) -gt $MaximumResponseBytes) {
                            throw "Launcher HTTP response exceeded the $MaximumResponseBytes-byte limit."
                        }
                        $body.Write($readBuffer, 0, $read)
                    }

                    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
                    [PSCustomObject]@{
                        StatusCode = $statusCode
                        Content = $utf8.GetString($body.ToArray())
                    }
                }
                finally {
                    $body.Dispose()
                }
            }
            finally {
                $responseStream.Dispose()
            }
        }
        finally {
            $response.Dispose()
        }
    }
    finally {
        $cancellation.Dispose()
        $request.Dispose()
        $client.Dispose()
    }
}

function Invoke-AgentXBoundedWebRequest {
    param(
        [switch] $UseBasicParsing,
        [Parameter(Mandatory = $true)] [Uri] $Uri,
        [Parameter(Mandatory = $true)] [int] $TimeoutSec,
        [Parameter(Mandatory = $true)] [int] $MaximumResponseBytes,
        [Parameter(Mandatory = $true)] [int] $MaximumRedirection
    )

    Invoke-AgentXBoundedHttpGet `
        -Uri $Uri `
        -TimeoutSec $TimeoutSec `
        -MaximumResponseBytes $MaximumResponseBytes `
        -MaximumRedirection $MaximumRedirection
}

function Invoke-AgentXBoundedRestMethod {
    param(
        [Parameter(Mandatory = $true)] [Uri] $Uri,
        [Parameter(Mandatory = $true)] [int] $TimeoutSec,
        [Parameter(Mandatory = $true)] [int] $MaximumResponseBytes,
        [Parameter(Mandatory = $true)] [int] $MaximumRedirection
    )

    $response = Invoke-AgentXBoundedHttpGet @PSBoundParameters
    $response.Content | ConvertFrom-Json
}

function Assert-DockerReady {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        [Console]::Error.WriteLine('Docker was not found on PATH. Install Docker Desktop, then reopen PowerShell.')
        exit 3
    }

    & docker compose version *> $null
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine('Docker Compose v2 is unavailable. Install or update Docker Desktop.')
        exit 3
    }

    $composeUpHelp = (& docker compose up --help 2>&1) -join "`n"
    if ($composeUpHelp -notmatch '--wait' -or $composeUpHelp -notmatch '--wait-timeout') {
        [Console]::Error.WriteLine('Docker Compose is too old for health-aware startup. Update Docker Desktop or the Compose v2 plugin.')
        exit 3
    }

    & docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine('Docker is installed, but its engine is not reachable. Start Docker Desktop and retry.')
        exit 3
    }
}

function Show-ProductHealth {
    $services = @(& docker compose @compose config --services)
    if ($LASTEXITCODE -ne 0) { return $false }
    $failed = $false

    foreach ($service in $services) {
        $container = & docker compose @compose ps -a -q $service
        if ($LASTEXITCODE -ne 0) { return $false }
        $state = if ($container) { & docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' $container 2>$null } else { '' }
        if ($LASTEXITCODE -ne 0 -or -not $state) {
            Write-Host ("{0}: not created" -f $service)
            $failed = $true
            continue
        }

        $parts = $state.Trim().Split('|')
        $runtime = $parts[0]
        $health = if ($parts.Count -gt 1) { $parts[1] } else { '' }
        $display = if ($health) { "$runtime/$health" } else { $runtime }
        Write-Host ("{0}: {1}" -f $service, $display)

        if ($runtime -ne 'running' -or ($service -in @('mongo', 'core', 'benchmark', 'rag', 'data', 'ollama') -and $health -ne 'healthy')) {
            $failed = $true
        }
    }

    if ($failed) {
        [Console]::Error.WriteLine('Agent X is not healthy yet. Run ''.\agentx.ps1 status'' and ''.\agentx.ps1 logs core'' for details.')
        return $false
    }

    Write-Host 'Product services are healthy. Ollama and models remain optional.'
    return $true
}

function Wait-PublishedProductEndpoints {
    $services = @(& docker compose @compose config --services)
    if ($LASTEXITCODE -ne 0) { return $false }
    $internalPorts = @{ core = 3080; benchmark = 3081; rag = 3082; data = 3083 }
    $endpoints = @()
    foreach ($service in $services) {
        if (-not $internalPorts.ContainsKey($service)) { continue }
        $published = & docker compose @compose port $service $internalPorts[$service]
        if ($LASTEXITCODE -ne 0) { return $false }
        if ($published -notmatch '^127\.0\.0\.1:[0-9]+$') {
            [Console]::Error.WriteLine("Keep $service published on loopback and put LAN HTTPS in front of it.")
            return $false
        }
        $endpoints += "http://$published/health"
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)

    while ([DateTime]::UtcNow -lt $deadline) {
        $ready = $true
        foreach ($endpoint in $endpoints) {
            try {
                $response = Invoke-AgentXBoundedWebRequest -UseBasicParsing -Uri $endpoint -TimeoutSec 2 -MaximumResponseBytes $agentXHealthResponseLimitBytes -MaximumRedirection 0
                if ($response.StatusCode -ne 200) { $ready = $false }
            }
            catch {
                $ready = $false
            }
        }
        if ($ready) { return $true }
        Start-Sleep -Milliseconds 500
    }

    [Console]::Error.WriteLine('Containers are healthy, but the loopback-published product endpoints did not become reachable within 30 seconds.')
    return $false
}

# Runtime maintenance lease (#93): recreating Core or Benchmark while a
# Benchmark workload runs cuts it and quarantines its host. Core's maintenance
# lease is refused while work is active and keeps new work out while held.
$script:runtimeLease = $null
$script:forceRuntime = [bool]$env:AGENTX_FORCE_RUNTIME
$runtimeLeaseTtlMs = 900000

function Split-ForceRuntime([object[]] $arguments) {
    $kept = @()
    foreach ($argument in $arguments) {
        if ($argument -eq '--force-runtime') { $script:forceRuntime = $true } else { $kept += $argument }
    }
    return ,$kept
}

# Core carries every inference, so recreating it (or every service) needs the
# global lease. Benchmark and its runner carry only Benchmark workloads, so a
# Benchmark-only recreate waits only for those. Returns core, benchmark or ''.
function Get-RuntimeGuardScope([object[]] $arguments) {
    $named = @($arguments | Where-Object { -not "$_".StartsWith('-') })
    if ($named.Count -eq 0 -or $named -contains 'core') { return 'core' }
    if ($named | Where-Object { $_ -in @('benchmark', 'benchmark-runner') }) { return 'benchmark' }
    return ''
}

function Test-RuntimeGuardNeeded([object[]] $arguments) {
    return [bool](Get-RuntimeGuardScope $arguments)
}

function Invoke-RuntimeLeaseRequest([string] $Method, [string] $Path, [hashtable] $Body) {
    $parameters = @{ Method = $Method; Uri = "$($script:runtimeLease.Core)$Path"; TimeoutSec = 10
        Headers = @{ 'X-AgentX-Caller' = 'operator' }; ContentType = 'application/json' }
    if ($Body) { $parameters.Body = ($Body | ConvertTo-Json -Compress) }
    try { return @{ Status = 200; Data = (Invoke-RestMethod @parameters).data } }
    catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        return @{ Status = $status; Data = $null }
    }
}

function Enter-RuntimeLease([object[]] $arguments) {
    $scope = Get-RuntimeGuardScope $arguments
    if (-not $scope) { return }
    if ($script:forceRuntime) {
        [Console]::Error.WriteLine('--force-runtime: recreating without Core''s runtime lease; a running Benchmark workload may be cut.')
        return
    }
    $published = & docker compose @compose port core 3080 2>$null
    $exists = $LASTEXITCODE -eq 0 -and $published
    $global:LASTEXITCODE = 0
    if (-not $exists) { Write-Output 'Core is not running here; no runtime lease is needed.'; return }
    try {
        Invoke-AgentXBoundedHttpGet -Uri "http://$published/health" -TimeoutSec 5 -MaximumResponseBytes $agentXHealthResponseLimitBytes -MaximumRedirection 0 | Out-Null
    } catch {
        # An unanswering Core may be another recreate in progress (#105).
        [Console]::Error.WriteLine('Core exists but does not answer its health check; another deploy may be in progress. Not recreating; use --force-runtime to recover a Core that is known to be broken.')
        exit 4
    }
    if ($scope -eq 'benchmark') {
        $active = $null
        try { $active = (Invoke-AgentXBoundedRestMethod -Uri "http://$published/api/nerve-center/runtime-coordination/active" -TimeoutSec 10 -MaximumResponseBytes $agentXHealthResponseLimitBytes -MaximumRedirection 0).data } catch { }
        $workloads = @(if ($active) { $active.workloads | Where-Object { $_ } })
        if ($workloads.Count) {
            [Console]::Error.WriteLine('Benchmark work is active. Workloads reported by Core:')
            foreach ($workload in $workloads) { [Console]::Error.WriteLine("  workload $($workload.workloadId) ($($workload.kind)) on $(@($workload.hosts) -join ', ')") }
            [Console]::Error.WriteLine('Not recreating Benchmark: wait for that work to finish, or use --force-runtime for an operator recovery.')
            exit 4
        }
        Write-Output 'No Benchmark workload is active; recreating Benchmark does not touch conversations, so no global lease is taken.'
        return
    }
    $script:runtimeLease = @{ Core = "http://$published" }
    $acquired = Invoke-RuntimeLeaseRequest POST '/api/nerve-center/maintenance-leases' @{
        requestId = "launcher-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())-$PID"; scope = 'runtime-deploy'; ttlMs = $runtimeLeaseTtlMs }
    if ($acquired.Status -eq 200 -and $acquired.Data.leaseId -and $acquired.Data.generation) {
        $script:runtimeLease.Id = $acquired.Data.leaseId
        $script:runtimeLease.Generation = $acquired.Data.generation
        $script:runtimeLease.Heartbeat = Start-Job -ArgumentList $script:runtimeLease.Core, $acquired.Data.leaseId, $acquired.Data.generation, $runtimeLeaseTtlMs -ScriptBlock {
            param($core, $id, $generation, $ttl)
            while ($true) {
                Start-Sleep -Seconds 60
                # Core is briefly down while it is recreated; the TTL covers that gap.
                $body = @{ generation = $generation; ttlMs = $ttl } | ConvertTo-Json -Compress
                try { Invoke-RestMethod -Method POST -Uri "$core/api/nerve-center/maintenance-leases/$id/heartbeat" -TimeoutSec 10 -Headers @{ 'X-AgentX-Caller' = 'operator' } -ContentType 'application/json' -Body $body | Out-Null } catch { }
            }
        }
        Write-Output "Runtime lease $($acquired.Data.leaseId) held: new Benchmark work waits until this recreate finishes."
        return
    }
    $script:runtimeLease = $null
    if ($acquired.Status -eq 409) {
        [Console]::Error.WriteLine('Core refused the runtime lease: work is active. Holders reported by Core:')
        try {
            $active = (Invoke-AgentXBoundedRestMethod -Uri "http://$published/api/nerve-center/runtime-coordination/active" -TimeoutSec 10 -MaximumResponseBytes $agentXHealthResponseLimitBytes -MaximumRedirection 0).data
            foreach ($workload in @($active.workloads)) { if ($workload) { [Console]::Error.WriteLine("  workload $($workload.workloadId) ($($workload.kind)) on $(@($workload.hosts) -join ', ')") } }
            foreach ($inference in @($active.inferences)) { if ($inference) { [Console]::Error.WriteLine("  inference $($inference.kind) $($inference.state) on $($inference.host)") } }
        } catch { }
        [Console]::Error.WriteLine('Not recreating: wait for that work to finish, or use --force-runtime for an operator recovery.')
        exit 4
    }
    [Console]::Error.WriteLine('Core is running but did not grant or refuse the runtime lease. Not recreating; use --force-runtime if the runtime is known to be idle.')
    exit 4
}

function Exit-RuntimeLease {
    if (-not $script:runtimeLease -or -not $script:runtimeLease.Id) { return $true }
    if ($script:runtimeLease.Heartbeat) {
        Stop-Job $script:runtimeLease.Heartbeat -ErrorAction SilentlyContinue
        Remove-Job $script:runtimeLease.Heartbeat -Force -ErrorAction SilentlyContinue
    }
    foreach ($attempt in 1..5) {
        $released = Invoke-RuntimeLeaseRequest DELETE "/api/nerve-center/maintenance-leases/$($script:runtimeLease.Id)" @{ generation = $script:runtimeLease.Generation }
        if ($released.Status -eq 200) { $script:runtimeLease = $null; return $true }
        Start-Sleep -Seconds 2
    }
    [Console]::Error.WriteLine("The runtime maintenance lease $($script:runtimeLease.Id) was not released. Release it before it expires: DELETE $($script:runtimeLease.Core)/api/nerve-center/maintenance-leases/$($script:runtimeLease.Id) with header X-AgentX-Caller: operator and body {""generation"":""$($script:runtimeLease.Generation)""}.")
    return $false
}

function Show-Usage {
    @"
AgentX

Usage: .\agentx.ps1 <command> [args...]

Commands:
  doctor                Check Docker CLI, Compose, and engine availability
  up                    Start the selected product profile (demo by default) and wait for health
  health                Verify containers in the selected project and profiles
  down                  Stop product and Docker Ollama; preserve volumes
  status                Show product service status
  logs [service]        Follow logs; defaults to core
  rebuild [--no-deps] [service...]
                        Rebuild images, then recreate the requested services
                        Recreating core or benchmark on a running instance first takes
                        Core's runtime lease and stops if Benchmark work is active;
                        --force-runtime skips that check for an operator recovery
  ollama-doctor         Detect native Ollama; never install or download
  ollama-up             Start the opt-in isolated Docker Ollama stack
  ollama-status         Show Docker Ollama status and installed models
  ollama-pull <model>   Explicitly download one model into its named volume
  ollama-down           Stop the Ollama-backed stack; preserve volumes
  reset                 Delete containers, data volumes, and recovery archives

Open http://127.0.0.1:3180/ after startup.
AGENTX_ENV_FILE selects an external env file; AGENTX_PROJECT_NAME isolates an instance.
AGENTX_COMPOSE_OVERRIDE optionally adds one external instance override.
"@
}

$cmd = if ($args.Count -gt 0) { $args[0] } else { '' }
$rest = @(if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() })

try {
switch ($cmd) {
    'doctor' {
        Assert-DockerReady
        Write-Output 'Docker CLI, Compose, and engine are ready.'
    }
    'up' {
        Assert-DockerReady
        $rest = Split-ForceRuntime $rest
        # The lease blocks all inference while held: build first, lease only the recreate.
        if ($rest -contains '--build') {
            $rest = @($rest | Where-Object { $_ -ne '--build' })
            & docker compose @compose build @($rest | Where-Object { -not "$_".StartsWith('-') })
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        Enter-RuntimeLease $rest
        & docker compose @compose up -d --wait --wait-timeout 180 @rest
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine('Startup did not become healthy within 180 seconds. Run ''.\agentx.ps1 status'' and ''.\agentx.ps1 logs core''.')
            exit $LASTEXITCODE
        }
        if (-not (Wait-PublishedProductEndpoints)) { exit 1 }
        if (-not (Exit-RuntimeLease)) { exit 1 }
        $published = & docker compose @compose port core 3080
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Write-Output "AgentX $projectName started: http://$published/"
    }
    'health' {
        Assert-DockerReady
        if (-not (Show-ProductHealth)) { exit 1 }
    }
    'down' {
        Assert-DockerReady
        & docker compose @ollamaCompose down @rest
    }
    { $_ -in 'status', 'ps' } {
        Assert-DockerReady
        & docker compose @ollamaCompose ps
    }
    'logs' {
        Assert-DockerReady
        $service = if ($rest.Count -gt 0) { $rest[0] } else { 'core' }
        & docker compose @ollamaCompose logs -f --tail=200 $service
    }
    'rebuild' {
        Assert-DockerReady
        $rest = Split-ForceRuntime $rest
        # Building touches no running container; only the recreate needs the lease.
        # Options such as --no-deps belong to the recreate, not to the build.
        & docker compose @compose build --no-cache @($rest | Where-Object { -not "$_".StartsWith('-') })
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Enter-RuntimeLease $rest
        & docker compose @compose up -d --wait --wait-timeout 180 @rest
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        if (-not (Wait-PublishedProductEndpoints)) { exit 1 }
        if (-not (Exit-RuntimeLease)) { exit 1 }
    }
    'ollama-doctor' {
        $ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
        try {
            $version = Invoke-AgentXBoundedRestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 3 -MaximumResponseBytes $agentXOllamaVersionResponseLimitBytes -MaximumRedirection 0
            Write-Output "Native Ollama is healthy at http://127.0.0.1:11434 (version $($version.version))."
            if ($ollamaCommand) { Write-Output "CLI: $($ollamaCommand.Source)" }
            exit 0
        }
        catch {
            if ($ollamaCommand) {
                Write-Output "Ollama is installed at $($ollamaCommand.Source), but its API is not responding."
                Write-Output "Start the Ollama app or run 'ollama serve' in another terminal."
                exit 1
            }
            Write-Output 'Ollama is not installed or not on PATH.'
            Write-Output 'Review https://docs.ollama.com/windows; Agent X will not install it automatically.'
            exit 1
        }
    }
    'ollama-up' {
        Assert-DockerReady
        & docker compose @ollamaCompose up -d --wait --wait-timeout 180 @rest
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine('The Docker Ollama stack did not become healthy within 180 seconds. Run ''.\agentx.ps1 status'' and inspect logs.')
            exit $LASTEXITCODE
        }
        if (-not (Wait-PublishedProductEndpoints)) { exit 1 }
        Write-Output 'Agent X started with isolated Docker Ollama. No model was downloaded.'
    }
    'ollama-status' {
        Assert-DockerReady
        & docker compose @ollamaCompose ps
        if ($LASTEXITCODE -eq 0) {
            & docker compose @ollamaCompose exec ollama ollama list
        }
    }
    'ollama-pull' {
        if ($rest.Count -ne 1) { [Console]::Error.WriteLine('Usage: .\agentx.ps1 ollama-pull <model>'); exit 2 }
        Assert-DockerReady
        & docker compose @ollamaCompose exec ollama ollama pull $rest[0]
    }
    'ollama-down' {
        Assert-DockerReady
        & docker compose @ollamaCompose down @rest
    }
    'reset' {
        Assert-DockerReady
        Write-Output "This deletes $projectName containers, network, named data volumes, and persistent recovery archives."
        $confirm = Read-Host "Type 'delete $projectName data and recovery archives' to continue"
        if ($confirm -eq "delete $projectName data and recovery archives") {
            & docker compose @ollamaCompose down --volumes
        }
        else {
            Write-Output 'Cancelled.'
        }
    }
    { $_ -in '', '-h', '--help', 'help' } {
        Show-Usage
    }
    default {
        [Console]::Error.WriteLine("Unknown command: $cmd")
        Show-Usage
        exit 2
    }
}

if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally {
    # A failed recreate still releases the lease it took.
    if ($script:runtimeLease -and $script:runtimeLease.Id) { Exit-RuntimeLease | Out-Null }
    $env:AGENTX_BUILD_REVISION = $initialBuildRevision
}
