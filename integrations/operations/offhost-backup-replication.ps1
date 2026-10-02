param(
    [Parameter(Mandatory=$true)][string]$SourceHost,
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [string]$DestinationRoot = "$env:USERPROFILE\.agentx\off-host-backups\agentx",
    [ValidateRange(1, 3650)]
    [int]$RetentionDays = 30,
    [switch]$ApplyRetention
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($SourceHost -notmatch '^[A-Za-z0-9_.@:-]+$' -or $SourceHost.StartsWith('-')) { throw 'Invalid source SSH target' }
if ($SourceRoot -notmatch '^/[A-Za-z0-9_./-]+$' -or $SourceRoot.Contains('..')) { throw 'Invalid source backup root' }

function Set-PrivateDirectoryAcl([string]$Path) {
    $directory = Get-Item -LiteralPath $Path
    $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl(
        $directory,
        [System.Security.AccessControl.AccessControlSections]::Access
    )
    $requiredSids = @(
        [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
        [System.Security.Principal.SecurityIdentifier]::new(
            [System.Security.Principal.WellKnownSidType]::LocalSystemSid,
            $null
        ),
        [System.Security.Principal.SecurityIdentifier]::new(
            [System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid,
            $null
        )
    )

    # The configuration archive contains live secrets. Rebuild the explicit
    # access list instead of trusting a previously protected ACL, which may
    # still grant an old or unexpected principal access.
    $acl.SetAccessRuleProtection($true, $false)
    $existingRules = @($acl.GetAccessRules(
        $true,
        $true,
        [System.Security.Principal.SecurityIdentifier]
    ))
    foreach ($existingRule in $existingRules) {
        [void]$acl.RemoveAccessRuleSpecific($existingRule)
    }
    foreach ($sid in $requiredSids) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            'FullControl',
            'ContainerInherit,ObjectInherit',
            'None',
            'Allow'
        )
        [void]$acl.AddAccessRule($rule)
    }
    [System.IO.FileSystemAclExtensions]::SetAccessControl($directory, $acl)

    $verifiedAcl = [System.IO.FileSystemAclExtensions]::GetAccessControl(
        $directory,
        [System.Security.AccessControl.AccessControlSections]::Access
    )
    if (-not $verifiedAcl.AreAccessRulesProtected) {
        throw "Backup ACL inheritance is not disabled: $Path"
    }
    $requiredSidValues = @($requiredSids | ForEach-Object { $_.Value })
    $verifiedRules = @($verifiedAcl.GetAccessRules(
        $true,
        $true,
        [System.Security.Principal.SecurityIdentifier]
    ))
    $unexpectedRules = @($verifiedRules | Where-Object {
        $sidValue = try {
            $_.IdentityReference.Translate(
                [System.Security.Principal.SecurityIdentifier]
            ).Value
        } catch {
            $null
        }
        $_.AccessControlType -ne 'Allow' -or
        $sidValue -notin $requiredSidValues -or
        -not ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl)
    })
    $fullControlSidValues = @($verifiedRules |
        Where-Object {
            $_.AccessControlType -eq 'Allow' -and
            ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl)
        } |
        ForEach-Object {
            try {
                $_.IdentityReference.Translate(
                    [System.Security.Principal.SecurityIdentifier]
                ).Value
            } catch {
                $null
            }
        })
    $missingSids = @($requiredSidValues | Where-Object { $_ -notin $fullControlSidValues })
    if ($unexpectedRules.Count -gt 0 -or $missingSids.Count -gt 0) {
        throw "Backup ACL verification failed; unexpected rules=$($unexpectedRules.Count), missing principals=$($missingSids.Count)"
    }
}

function Invoke-Remote([string]$Command) {
    $output = @(& ssh -o BatchMode=yes -o ConnectTimeout=15 $SourceHost $Command)
    if ($LASTEXITCODE -ne 0) { throw "Remote command failed with exit code $LASTEXITCODE" }
    return $output
}

function Get-LatestRelativePath([string]$RemoteFind) {
    $line = (Invoke-Remote $RemoteFind | Select-Object -First 1)
    if (-not $line) { throw 'No matching source backup was found' }
    $parts = $line -split '\s+', 2
    if ($parts.Count -ne 2 -or -not $parts[1]) { throw "Unexpected source listing: $line" }
    return $parts[1]
}

function Get-RemoteFileEvidence([string]$Kind, [string]$RelativePath) {
    if ($RelativePath -notmatch '^[A-Za-z0-9._/-]+$' -or $RelativePath.Contains('..')) {
        throw "Unsafe remote relative path: $RelativePath"
    }
    $hashLine = (Invoke-Remote "cd '$SourceRoot' && sha256sum -- '$RelativePath'" | Select-Object -First 1)
    $sizeLine = (Invoke-Remote "cd '$SourceRoot' && stat -c '%s' -- '$RelativePath'" | Select-Object -First 1)
    $hash = ($hashLine -split '\s+', 2)[0].ToLowerInvariant()
    if ($hash -notmatch '^[a-f0-9]{64}$') { throw "Invalid SHA-256 for $RelativePath" }
    $size = 0L
    if (-not [long]::TryParse($sizeLine, [ref]$size) -or $size -le 0) {
        throw "Invalid size for $RelativePath"
    }
    return [pscustomobject]@{
        kind = $Kind
        name = [IO.Path]::GetFileName($RelativePath)
        sourceRelativePath = $RelativePath
        bytes = $size
        sha256 = $hash
    }
}

function Invoke-Retention([string]$Root, [int]$Days, [bool]$Apply) {
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $cutoff = [DateTimeOffset]::UtcNow.AddDays(-$Days)
    $candidates = @()
    foreach ($directory in Get-ChildItem -LiteralPath $rootFull -Directory -ErrorAction SilentlyContinue) {
        $parsed = [DateTimeOffset]::MinValue
        if (-not [DateTimeOffset]::TryParseExact(
            $directory.Name,
            'yyyyMMddTHHmmssZ',
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal,
            [ref]$parsed
        )) { continue }
        if ($parsed -ge $cutoff) { continue }
        $resolved = [IO.Path]::GetFullPath($directory.FullName)
        if ([IO.Path]::GetDirectoryName($resolved).TrimEnd('\') -ne $rootFull) {
            throw "Retention target escaped backup root: $resolved"
        }
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Retention refuses reparse point: $resolved"
        }
        $candidates += $resolved
    }
    if ($Apply) {
        foreach ($candidate in $candidates) {
            Remove-Item -LiteralPath $candidate -Recurse -Force
        }
    }
    return @($candidates)
}

$rootFull = [IO.Path]::GetFullPath($DestinationRoot)
New-Item -ItemType Directory -Path $rootFull -Force | Out-Null
Set-PrivateDirectoryAcl $rootFull
$latestRunPath = Join-Path $rootFull 'latest-run.json'
$cutoverReceiptPath = Join-Path $rootFull 'latest-offhost-receipt.json'
$startedAt = [DateTimeOffset]::UtcNow

try {
    $mongoRelative = Get-LatestRelativePath `
        "find '$SourceRoot' -maxdepth 1 -type f -name 'agentx-*.tar.gz' -printf '%T@ %f\n' | sort -nr | head -1"
    $configRelative = Get-LatestRelativePath `
        "find '$SourceRoot' -maxdepth 1 -type f -name 'config-*.tar.gz' -printf '%T@ %f\n' | sort -nr | head -1"
    $qdrantRelative = Get-LatestRelativePath `
        "find '$SourceRoot/qdrant' -maxdepth 1 -type f -name '*.snapshot' -printf '%T@ qdrant/%f\n' | sort -nr | head -1"
    $criticalVolumesRelative = Get-LatestRelativePath `
        "find '$SourceRoot/volumes' -maxdepth 1 -type f -name 'critical-volumes-*.tar.gz' -printf '%T@ volumes/%f\n' | sort -nr | head -1"

    $files = @(
        Get-RemoteFileEvidence 'mongodb' $mongoRelative
        Get-RemoteFileEvidence 'configuration' $configRelative
        Get-RemoteFileEvidence 'qdrant' $qdrantRelative
        Get-RemoteFileEvidence 'critical-runtime-state' $criticalVolumesRelative
    )
    $hashSignature = ($files.sha256 | Sort-Object) -join ':'
    $previous = Get-ChildItem -LiteralPath $rootFull -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object {
            $manifestPath = Join-Path $_.FullName 'manifest.json'
            if (Test-Path -LiteralPath $manifestPath) {
                try { Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { $null }
            }
        } |
        Where-Object { $_ } |
        Select-Object -First 1
    $previousSignature = if ($previous) { ($previous.files.sha256 | Sort-Object) -join ':' } else { '' }

    $status = 'unchanged'
    $generationPath = if ($previous) { $previous.destinationRoot } else { $null }
    if ($hashSignature -ne $previousSignature) {
        $generation = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')
        $generationPath = Join-Path $rootFull $generation
        if (Test-Path -LiteralPath $generationPath) { throw "Generation path already exists: $generationPath" }
        New-Item -ItemType Directory -Path $generationPath | Out-Null
        Set-PrivateDirectoryAcl $generationPath

        foreach ($file in $files) {
            $remote = "${SourceHost}:$SourceRoot/$($file.sourceRelativePath)"
            & scp -q -o BatchMode=yes -o ConnectTimeout=15 $remote $generationPath
            if ($LASTEXITCODE -ne 0) { throw "SCP failed for $($file.sourceRelativePath)" }
            $localPath = Join-Path $generationPath $file.name
            $localHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $localPath).Hash.ToLowerInvariant()
            if ($localHash -ne $file.sha256) { throw "SHA-256 mismatch for $($file.name)" }
        }

        $manifest = [ordered]@{
            schemaVersion = 3
            sourceHost = $SourceHost
            sourceRoot = $SourceRoot
            copiedAt = [DateTimeOffset]::UtcNow.ToString('o')
            destinationHost = $env:COMPUTERNAME
            destinationRoot = $generationPath
            retentionDays = $RetentionDays
            files = $files
            verification = [ordered]@{
                remoteAndLocalHashesEqual = $true
                restoreDrillPending = $true
            }
        }
        $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $generationPath 'manifest.json') -Encoding utf8NoBOM
        $status = 'copied'
    }

    $retentionCandidates = Invoke-Retention $rootFull $RetentionDays $ApplyRetention.IsPresent
    $completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $receiptArtifacts = @($files | Select-Object kind, name, bytes, sha256)
    $cutoverReceipt = [ordered]@{
        schemaVersion = 3
        kind = 'agentx-offhost-backup'
        status = $status
        completedAt = $completedAt
        hashesVerified = $true
        artifacts = $receiptArtifacts
    }
    $cutoverReceipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $cutoverReceiptPath -Encoding utf8NoBOM
    $remoteReceipt = "$SourceRoot/latest-offhost-receipt.json"
    $remoteReceiptPartial = "$remoteReceipt.partial"
    & scp -q -o BatchMode=yes -o ConnectTimeout=15 $cutoverReceiptPath "${SourceHost}:$remoteReceiptPartial"
    if ($LASTEXITCODE -ne 0) { throw 'Unable to return the sanitized off-host receipt to production' }
    Invoke-Remote "chmod 600 '$remoteReceiptPartial' && mv -- '$remoteReceiptPartial' '$remoteReceipt'" | Out-Null
    $result = [ordered]@{
        schemaVersion = 3
        kind = 'agentx-offhost-backup'
        status = $status
        startedAt = $startedAt.ToString('o')
        completedAt = $completedAt
        generationPath = $generationPath
        files = $files.Count
        artifacts = $receiptArtifacts
        hashesVerified = $true
        retentionDays = $RetentionDays
        retentionApplied = $ApplyRetention.IsPresent
        retentionRemoved = if ($ApplyRetention) { @($retentionCandidates).Count } else { 0 }
    }
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $latestRunPath -Encoding utf8NoBOM
    $result | ConvertTo-Json -Depth 6
}
catch {
    $failure = [ordered]@{
        status = 'failed'
        startedAt = $startedAt.ToString('o')
        completedAt = [DateTimeOffset]::UtcNow.ToString('o')
        message = $_.Exception.Message
    }
    $failure | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $latestRunPath -Encoding utf8NoBOM
    throw
}
