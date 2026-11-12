param([string]$Root=(Join-Path $PSScriptRoot '..'))
$ErrorActionPreference='Stop'
$Root=[IO.Path]::GetFullPath($Root)
Add-Type -Path @((Join-Path $Root 'WpdReader.cs'),(Join-Path $Root 'WpdCleanup.cs'),(Join-Path $Root 'test/WpdStreamFixture.cs'))
$temp=Join-Path ([IO.Path]::GetTempPath()) ('agentx-stream-test-'+[guid]::NewGuid().ToString())
$null=New-Item -ItemType Directory -Path $temp
function Refuses([scriptblock]$Action,[string]$Message){
  try{& $Action}catch{if($_.Exception.ToString().Contains($Message)){return};throw}
  throw ('Expected refusal: '+$Message)
}
try {
  [byte[]]$bytes=New-Object byte[] 198765
  for($i=0;$i -lt $bytes.Length;$i++){$bytes[$i]=[byte]($i%251)}
  [IO.File]::WriteAllBytes((Join-Path $temp 'source'),$bytes)
  $hash=(Get-FileHash -Algorithm SHA256 (Join-Path $temp 'source')).Hash.ToLowerInvariant()
  foreach($optimal in @(4096,65536,0)){
    $limit=if($optimal -eq 0){65536}else{$optimal}
    $stream=[AgentX.PhotoImport.Test.SizedStream]::new($bytes,$limit)
    $destination=Join-Path $temp ('copy-'+$optimal)
    $copied=[AgentX.PhotoImport.Reader]::CopyResource($stream,$destination,[uint64]$bytes.Length,[uint32]$optimal)
    if($copied -ne $hash -or (Get-FileHash -Algorithm SHA256 $destination).Hash.ToLowerInvariant() -ne $hash){throw 'Corrupt stream accepted'}
    if($stream.Calls -lt 2){throw 'Partial reads not exercised'}
    Refuses {[AgentX.PhotoImport.Reader]::CopyResource($stream,$destination,1,4096)} ''
    if((Get-FileHash -Algorithm SHA256 $destination).Hash.ToLowerInvariant() -ne $hash){throw 'Existing copy overwritten'}
  }
  $stream=[AgentX.PhotoImport.Test.SizedStream]::new($bytes,4096)
  Refuses {[AgentX.PhotoImport.Reader]::CopyResource($stream,(Join-Path $temp 'short'),[uint64]($bytes.Length+1),4096)} 'incomplete'
  $stream=[AgentX.PhotoImport.Test.SizedStream]::new($bytes,4096)
  Refuses {[AgentX.PhotoImport.Reader]::CopyResource($stream,(Join-Path $temp 'grown'),[uint64]($bytes.Length-1),4096)} 'grew'
  $stream=[AgentX.PhotoImport.Test.SizedStream]::new($bytes,4096);$stream.InvalidCount=$true
  Refuses {[AgentX.PhotoImport.Reader]::CopyResource($stream,(Join-Path $temp 'invalid'),[uint64]$bytes.Length,4096)} 'Invalid WPD read count'
  Refuses {[AgentX.PhotoImport.Reader]::TransferBufferSize([uint32]::MaxValue)} 'Invalid WPD transfer buffer'
  @{driverBuffer='passed';shortReads='passed';sha256='passed';truncated='refused';grown='refused';invalidCounts='refused';overwrite='refused';phoneReads=0;phoneDeletes=0}|ConvertTo-Json -Compress
} finally {Remove-Item -LiteralPath $temp -Recurse -Force}
