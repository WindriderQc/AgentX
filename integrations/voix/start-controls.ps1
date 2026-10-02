param(
    [Parameter(Mandatory = $true)][string]$VoiXRoot,
    [Parameter(Mandatory = $true)][string]$ModelDirectory,
    [int]$Port = 8091
)
$ErrorActionPreference = 'Stop'
$voiceRoot = (Resolve-Path -LiteralPath $VoiXRoot).Path
$voiceModel = (Resolve-Path -LiteralPath $ModelDirectory).Path
$voicePython = Join-Path $voiceRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $voicePython)) { throw 'The existing VoiX Python environment is required.' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw 'The voice port is in use. Stop the verified voice process before changing adapters.'
}
$env:VOIX_CONTROL_MODEL_DIR = $voiceModel
$env:PYTHONPATH = $PSScriptRoot + ';' + $voiceRoot + $(if ($env:PYTHONPATH) { ';' + $env:PYTHONPATH })
Set-Location -LiteralPath $voiceRoot
$voiceLogDir = Join-Path $voiceRoot 'logs'
New-Item -ItemType Directory -Path $voiceLogDir -Force | Out-Null
$voiceLog = Join-Path $voiceLogDir 'voix.log'
if (Test-Path -LiteralPath $voiceLog) {
    Move-Item -LiteralPath $voiceLog -Destination (Join-Path $voiceLogDir 'voix.prev.log') -Force
}
$ErrorActionPreference = 'Continue'
& $voicePython -u -m uvicorn agentx_voix_controls:app --host 0.0.0.0 --port $Port --loop asyncio --http h11 --ws websockets 2>&1 |
    Tee-Object -FilePath $voiceLog
exit $LASTEXITCODE
