param(
  [ValidateSet('devices','inventory','read','prefixes','spool')][string]$Action = 'devices',
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
  $reader=$null
  $deviceLock=$null
  try {
    . (Join-Path $PSScriptRoot 'device-lock.ps1')
    $deviceLock=Enter-PhotoDeviceLock $request.deviceId
    $reader=New-Object AgentX.PhotoImport.Reader($request.deviceId)
    if ($Action -eq 'inventory') { $result = $reader.Enumerate(100000) }
    elseif ($Action -eq 'prefixes') {
      if (@($request.objects).Count -gt 100000) { throw 'Prefix request exceeds object bound' }
      $entries = New-Object System.Collections.Generic.List[object]
      $known = @{}
      $journal = $null
      if ($request.prefixJournal) {
        if (-not [IO.Path]::IsPathRooted($request.prefixJournal)) { throw 'Prefix journal must be absolute' }
        if (Test-Path -LiteralPath $request.prefixJournal) {
          foreach ($line in Get-Content -LiteralPath $request.prefixJournal -Encoding UTF8) {
            try { $record=$line|ConvertFrom-Json; if ($record.fingerprint -and -not $record.entry.error) {$known[$record.fingerprint]=$record.entry} }
            catch { } # an interrupted final read checkpoint can be probed again
          }
        }
        $journal=New-Object IO.StreamWriter($request.prefixJournal,$true,(New-Object Text.UTF8Encoding($false)))
        $journal.AutoFlush=$true
      }
      try {
      $fatalErrors=0
      foreach ($item in $request.objects) {
        $fingerprint=ConvertTo-Json -InputObject @($item.objectId,$item.key,$item.size,$item.modified) -Compress
        if ($known.ContainsKey($fingerprint)) { $entry=$known[$fingerprint] }
        else {
          try { $entry=@{objectId=$item.objectId;header=$reader.ReadPrefix($item.objectId)} }
          catch { $entry=@{objectId=$item.objectId;error=$_.Exception.Message} }
          if ($journal) { $journal.WriteLine((@{fingerprint=$fingerprint;entry=$entry}|ConvertTo-Json -Depth 5 -Compress)) }
        }
        $entries.Add($entry)
        if ($entry.error -match '80070141|800700AA|80070079|8007001F') { $fatalErrors++ } else { $fatalErrors=0 }
        if ($fatalErrors -ge 3) { break }
      }
      } finally { if ($journal) {$journal.Dispose()} }
      $result = @{entries=$entries}
    }
    elseif ($Action -eq 'spool') {
      if (@($request.items).Count -gt 100000 -or -not [IO.Path]::IsPathRooted($request.spoolRoot)) { throw 'Invalid spool request' }
      $null = New-Item -ItemType Directory -Path $request.spoolRoot -Force
      $entries = New-Object System.Collections.Generic.List[object]
      $fatalErrors=0
      foreach ($item in $request.items) {
        $id = [guid]::Empty
        if (-not [guid]::TryParse($item.requestId,[ref]$id)) { throw 'Spool item needs a UUID' }
        $destination = Join-Path $request.spoolRoot ($id.ToString()+'.media')
        $receiptPath = $destination+'.json'
        try {
          $known = $null
          if ((Test-Path -LiteralPath $receiptPath) -and (Test-Path -LiteralPath $destination)) {
            $saved = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($hash -eq $saved.sha256 -and (Get-Item -LiteralPath $destination).Length -eq $item.size -and $saved.source.key -eq $item.key -and $saved.source.modified -eq $item.modified) { $known=$saved }
          }
          if (-not $known) {
            foreach ($partial in @($destination,$receiptPath)) {
              if (Test-Path -LiteralPath $partial) { Move-Item -LiteralPath $partial -Destination ($partial+'.incomplete-'+[guid]::NewGuid().ToString()) }
            }
            $known=$reader.Read($item.objectId,$item.relativePath,$destination)
            if ($known.source.key -ne $item.key -or $known.size -ne $item.size -or $known.source.modified -ne $item.modified) { throw 'Source differs from frozen spool manifest' }
            $bytes=[Text.Encoding]::UTF8.GetBytes(($known|ConvertTo-Json -Depth 10 -Compress))
            $output=[IO.File]::Open($receiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try {$output.Write($bytes,0,$bytes.Length);$output.Flush($true)} finally {$output.Dispose()}
          }
          $entries.Add(@{requestId=$item.requestId;sha256=$known.sha256;size=$known.size})
          $fatalErrors=0
        } catch {
          $message=$_.Exception.Message
          $entries.Add(@{requestId=$item.requestId;error=$message})
          if ($message -match '80070141|800700AA|80070079|8007001F') { $fatalErrors++ } else {$fatalErrors=0}
          if ($fatalErrors -ge 3) { break }
        }
        if ($entries.Count % 100 -eq 0) { [Console]::Error.WriteLine('WPD_SPOOLED '+$entries.Count) }
      }
      $result=@{entries=$entries}
    }
    else { $result = $reader.Read($request.objectId, $request.relativePath, $request.destination) }
    ConvertTo-Json -InputObject $result -Depth 10 -Compress
  } finally { if($reader){$reader.Dispose()};if($deviceLock){Exit-PhotoDeviceLock $deviceLock} }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
