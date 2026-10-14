param(
  [string]$Endpoint = 'http://127.0.0.1:3180/api/analytics/codex-usage',
  [ValidateRange(1, 365)]
  [int]$LookbackDays = 45
)

$ErrorActionPreference = 'Stop'
$syncScript = Join-Path $PSScriptRoot 'codex-usage-sync.js'
$node = (Get-Command node -ErrorAction Stop).Source

# For interactive scheduled tasks, use wscript.exe and the adjacent hidden launcher.
# -WindowStyle Hidden alone can flash a console before PowerShell hides it.
# Node sends only sanitized counters and verifies the API acceptance receipt.
$syncArgs = @($syncScript, '--endpoint', $Endpoint, '--lookback-days', $LookbackDays)
& $node @syncArgs
exit $LASTEXITCODE
