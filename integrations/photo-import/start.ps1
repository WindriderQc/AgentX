param(
  [string]$Config = (Join-Path $env:LOCALAPPDATA 'AgentX\photo-import\client.json'),
  [string]$Resume,
  [int]$Limit = 100000,
  [switch]$ListDevices
)
$ErrorActionPreference = 'Stop'
try {
  if (-not (Test-Path -LiteralPath $Config)) { throw "Configuration introuvable : $Config" }
  $settings = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $Resume -and -not $ListDevices -and (Test-Path -LiteralPath $settings.cacheRoot)) {
    $pending = Get-ChildItem -LiteralPath $settings.cacheRoot -Filter '*.json' | Where-Object { $_.BaseName -match '^[a-f0-9-]{36}$' } | Sort-Object LastWriteTime -Descending | ForEach-Object {
      $record = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
      if (@($record.items | Where-Object { -not $_.receipt }).Count -gt 0) { $record }
    } | Select-Object -First 1
    if ($pending) {
      $answer = Read-Host ('Reprendre l''import ' + $pending.runId + ' ? [O/n]')
      if ($answer -notmatch '^[nN]') { $Resume = $pending.runId }
    }
  }
  $arguments = @((Join-Path $PSScriptRoot 'import.cjs'), '--config', $Config, '--limit', [string]$Limit)
  if ($Resume) { $arguments += @('--resume', $Resume) }
  else {
    $json = & powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'wpd.ps1') -Action devices
    if ($LASTEXITCODE -ne 0) { throw 'Lecture des périphériques USB impossible.' }
    $devices = @($json | ConvertFrom-Json)
    if ($ListDevices) { $devices | Format-List; exit 0 }
    if ($devices.Count -eq 0) { throw 'Branchez et déverrouillez Android, puis choisissez Transfert de fichiers USB.' }
    $selected = 0
    if ($devices.Count -gt 1) {
      for ($i = 0; $i -lt $devices.Count; $i++) { Write-Host ("{0} : {1}" -f ($i + 1), $devices[$i].name) }
      $number = 0
      if (-not [int]::TryParse((Read-Host 'Numéro du téléphone'), [ref]$number) -or $number -lt 1 -or $number -gt $devices.Count) { throw 'Sélection invalide.' }
      $selected = $number - 1
    }
    Write-Host ('Téléphone : ' + $devices[$selected].name)
    $arguments += @('--device', $devices[$selected].id)
  }
  & node @arguments
  exit $LASTEXITCODE
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
