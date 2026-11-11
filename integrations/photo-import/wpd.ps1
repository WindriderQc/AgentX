param(
  [ValidateSet('devices','inventory','read')][string]$Action = 'devices',
  [string]$RequestFile
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'WpdReader.cs')
  if ($Action -eq 'devices') {
    $devices = @([AgentX.PhotoImport.Reader]::Devices())
    ConvertTo-Json -InputObject $devices -Depth 8 -Compress
    exit 0
  }
  $request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $reader = New-Object AgentX.PhotoImport.Reader($request.deviceId)
  try {
    if ($Action -eq 'inventory') { $result = $reader.Enumerate(100000) }
    else { $result = $reader.Read($request.objectId, $request.relativePath, $request.destination) }
    ConvertTo-Json -InputObject $result -Depth 10 -Compress
  } finally { $reader.Dispose() }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
