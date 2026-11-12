# The actual WPD process owns both fences until COM disposal. The global named
# mutex also covers WMI/SSH sessions whose TEMP directories differ. The file
# handle remains compatible with previously installed read-only collectors.
function Enter-PhotoDeviceLock([string]$DeviceId) {
  $sha=[Security.Cryptography.SHA256]::Create()
  try {$key=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($DeviceId))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
  $mutex=[Threading.Mutex]::new($false,('Global\AgentX.PhotoImport.'+$key))
  $held=$false
  $file=$null
  try {
    try {$held=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true}
    if(-not $held){throw 'Another WPD reader is active'}
    $lockFile=Join-Path ([IO.Path]::GetTempPath()) ('agentx-wpd-'+$key+'.lock')
    $file=[IO.File]::Open($lockFile,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    return @{Mutex=$mutex;File=$file}
  }catch{if($file){$file.Dispose()};if($held){$mutex.ReleaseMutex()};$mutex.Dispose();throw}
}
function Exit-PhotoDeviceLock($Lock) {
  if($Lock){try{$Lock.File.Dispose()}finally{$Lock.Mutex.ReleaseMutex();$Lock.Mutex.Dispose()}}
}
