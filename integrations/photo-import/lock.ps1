param([Parameter(Mandatory=$true)][string]$LockFile)
$ErrorActionPreference = 'Stop'
try {
  # Kernel ownership is released on process exit, including a killed importer.
  # A persistent filename is harmless; neither age nor deletion steals a lock.
  $lock = [System.IO.File]::Open($LockFile, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try {
    [Console]::Out.WriteLine('ready')
    [Console]::Out.Flush()
    $null = [Console]::In.ReadLine()
  } finally { $lock.Dispose() }
} catch {
  [Console]::Error.WriteLine('Another importer holds this local staging lock: ' + $_.Exception.Message)
  exit 1
}
