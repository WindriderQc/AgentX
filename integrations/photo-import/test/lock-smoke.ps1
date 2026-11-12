param([string]$Root=(Join-Path $PSScriptRoot '..'))
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$Root=[IO.Path]::GetFullPath($Root)
Add-Type -Path @((Join-Path $Root 'WpdReader.cs'),(Join-Path $Root 'WpdCleanup.cs'))
foreach($name in @('wpd.ps1','cleanup.ps1','device-lock.ps1')){
  $tokens=$null;$errors=$null
  [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Root $name),[ref]$tokens,[ref]$errors)>$null
  if($errors.Count){throw ($errors|Out-String)}
}
$fake='agentx-synthetic-locked-device'
$sha=[Security.Cryptography.SHA256]::Create()
try{$key=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($fake))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
$testDir=Join-Path ([IO.Path]::GetTempPath()) ('agentx-device-fence-test-'+[guid]::NewGuid().ToString())
$null=New-Item -ItemType Directory -Path $testDir
$request=Join-Path $testDir 'request.json'
@{deviceId=$fake}|ConvertTo-Json|Set-Content -LiteralPath $request -Encoding UTF8
function Invoke-FencedReader([string]$Name,[string]$Expected,[bool]$OtherTemp){
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName='powershell.exe'
  $action=if($Name -eq 'wpd.ps1'){'-Action inventory '}else{''}
  $info.Arguments='-NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File "'+(Join-Path $Root $Name)+'" '+$action+'-RequestFile "'+$request+'"'
  $info.UseShellExecute=$false;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  if($OtherTemp){$info.EnvironmentVariables['TEMP']=$testDir;$info.EnvironmentVariables['TMP']=$testDir}
  $process=[Diagnostics.Process]::Start($info)
  $output=$process.StandardOutput.ReadToEnd()+$process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if($process.ExitCode -ne 1 -or -not $output.Contains($Expected)){throw ('Reader fence failed: '+$Name+' '+$output)}
}
try {
  $lockPath=Join-Path ([IO.Path]::GetTempPath()) ('agentx-wpd-'+$key+'.lock')
  $held=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{foreach($name in @('wpd.ps1','cleanup.ps1')){Invoke-FencedReader $name ('agentx-wpd-'+$key+'.lock') $false}}finally{$held.Dispose()}
  $mutex=[Threading.Mutex]::new($false,('Global\AgentX.PhotoImport.'+$key))
  $owns=$mutex.WaitOne(0)
  if(-not $owns){throw 'Synthetic device mutex is already held'}
  try{foreach($name in @('wpd.ps1','cleanup.ps1')){Invoke-FencedReader $name 'Another WPD reader is active' $true}}finally{$mutex.ReleaseMutex();$mutex.Dispose()}
  @{sdkCompile='passed';powershellParse='passed';legacyReadFence='passed';legacyCleanupFence='passed';crossTempReadMutex='passed';crossTempCleanupMutex='passed';phoneFileReads=0;phoneDeletes=0}|ConvertTo-Json -Compress
}finally{Remove-Item -LiteralPath $testDir -Recurse -Force}
