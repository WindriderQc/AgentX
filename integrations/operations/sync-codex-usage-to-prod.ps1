param(
  [string]$Endpoint = 'http://127.0.0.1:3180/api/analytics/codex-usage',
  [ValidateRange(1, 365)]
  [int]$LookbackDays = 45
)

$ErrorActionPreference = 'Stop'
$syncScript = Join-Path $PSScriptRoot 'codex-usage-sync.js'
$node = (Get-Command node -ErrorAction Stop).Source

# Keep this hidden PowerShell parent in Task Scheduler to avoid console focus.
# Node sends only sanitized counters and verifies the API acceptance receipt.
$syncArgs = @($syncScript, '--endpoint', $Endpoint, '--lookback-days', $LookbackDays)
& $node @syncArgs
exit $LASTEXITCODE
