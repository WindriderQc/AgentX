param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$reader=$null
$deviceLock=$null
try {
  Add-Type -Path @((Join-Path $PSScriptRoot 'WpdReader.cs'),(Join-Path $PSScriptRoot 'WpdCleanup.cs'))
  $r=Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8|ConvertFrom-Json
  # The process performing WPD owns the lock itself. Killing its Node parent
  # cannot release the device fence while a native Delete is still running.
  . (Join-Path $PSScriptRoot 'device-lock.ps1')
  $deviceLock=Enter-PhotoDeviceLock $r.deviceId
  if(Test-Path -LiteralPath $r.resultFile){[Console]::WriteLine((Get-Content -LiteralPath $r.resultFile -Raw -Encoding UTF8));exit 0}
  if(Test-Path -LiteralPath $r.dispatchFile){throw 'CLEANUP_UNCERTAIN: original dispatch needs reconciliation'}
  $reader=[AgentX.PhotoImport.Reader]::OpenForCleanup($r.deviceId)
  $item=$r.item
  $prepared=$reader.PrepareRemoval($item.objectId,$item.relativePath,$r.spool,$item.key,$item.name,[ulong]$item.size,$item.modified,$item.sha256)
  [Console]::WriteLine((@{ready=$true;sha256=$prepared.sha256;size=$prepared.size}|ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  if([Console]::ReadLine() -cne ('DELETE:'+$r.operationId+':'+$r.attemptId)) { throw 'Confirmation was not received' }
  $reader.ConfirmRemoval($r.dispatchFile,($r|ConvertTo-Json -Depth 10 -Compress))
  $result=@{operationId=$r.operationId;attemptId=$r.attemptId;planId=$r.planId;digest=$r.digest;requestId=$item.requestId;sha256=$item.sha256;state='deleted'}
  $bytes=[Text.Encoding]::UTF8.GetBytes(($result|ConvertTo-Json -Compress))
  $file=[IO.File]::Open($r.resultFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {$file.Write($bytes,0,$bytes.Length);$file.Flush($true)} finally {$file.Dispose()}
  [Console]::WriteLine(($result|ConvertTo-Json -Compress));[Console]::Out.Flush()
} catch { [Console]::Error.WriteLine($_.Exception.Message);exit 1 }
finally {if($reader){$reader.Dispose()};if($deviceLock){Exit-PhotoDeviceLock $deviceLock}}
