[CmdletBinding()]
param(
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

# ChatGPTMCP Doctor: single diagnostic surface for the unified local runtime.
# Read-only: never starts, stops, builds, or mutates anything.
# Exit 0 = HEALTHY, 1 = anything else.
$projectRoot = Split-Path -Parent $PSScriptRoot
$clientPath = Join-Path $projectRoot 'tools\tunnel-client-v0.0.13\tunnel-client.exe'
$profileDir = Join-Path $env:APPDATA 'tunnel-client'
$runtimeProfilePath = Join-Path $profileDir 'chatgpt-machine-runtime.yaml'
$ownerPath = Join-Path $projectRoot '.tunnel\runtime-owner.json'
$watchdogPidPath = Join-Path $projectRoot '.tunnel\watch-tunnel.pid'
$serverDist = Join-Path $projectRoot 'apps\server\dist\index.js'
$results = @()

function Add-Result($name, $status, $detail) {
    $script:results += [pscustomobject]@{ check = $name; status = $status; detail = [string]$detail }
}

function Get-DaemonStatus {
    try {
        if (-not (Test-Path -LiteralPath $script:clientPath)) { return $null }
        $raw = & $script:clientPath runtimes status chatgpt-machine --json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

function Test-PidAlive($targetPid) {
    try { return $null -ne (Get-Process -Id $targetPid -ErrorAction Stop) } catch { return $false }
}

function Get-ProfileOwner {
    if (-not (Test-Path -LiteralPath $script:runtimeProfilePath)) { return $null }
    $text = Get-Content -LiteralPath $script:runtimeProfilePath -Raw
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    $m = [regex]::Match($text, '(?<repo>[A-Za-z]:[^"\s]*?)/(?:apps/server/)?dist/supervisor\.js')
    if ($m.Success) { return $m.Groups['repo'].Value.Replace('/', '\') }
    $marker = $script:projectRoot.Replace('\', '/')
    if ($text -like "*$marker*") { return $script:projectRoot }
    return 'unknown-foreign-owner'
}

# 1. Runtime owner ---------------------------------------------------------
$claim = $null
if (Test-Path -LiteralPath $ownerPath) {
    try { $claim = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json } catch { }
}
if ($claim -and $claim.owner -eq $projectRoot) {
    Add-Result 'Runtime owner' 'PASS' $projectRoot
} elseif ($claim -and $claim.owner) {
    Add-Result 'Runtime owner' 'FAIL' "claimed by $($claim.owner)"
} else {
    Add-Result 'Runtime owner' 'WARN' 'no claim file (never started from here?)'
}

# 2. Git state --------------------------------------------------------------
try {
    $porcelain = & git -C $projectRoot status --porcelain 2>$null
    if ($LASTEXITCODE -ne 0) { Add-Result 'Git state' 'WARN' 'not a git checkout?' }
    else {
        $dirty = @($porcelain | Where-Object { $_.Trim() -ne '' })
        if ($dirty.Count -eq 0) { Add-Result 'Git state' 'PASS' 'clean' }
        else { Add-Result 'Git state' 'WARN' "$($dirty.Count) dirty file(s)" }
    }
} catch { Add-Result 'Git state' 'WARN' $_.Exception.Message }

# 3. Build freshness ---------------------------------------------------------
$stale = @()
$missing = @()
foreach ($pair in @(
    @{ Name = 'server'; Src = 'apps\server\src'; Dist = 'apps\server\dist' },
    @{ Name = 'skill-hub'; Src = 'packages\skill-hub\src'; Dist = 'packages\skill-hub\dist' },
    @{ Name = 'thinkforge'; Src = 'packages\thinkforge\src'; Dist = 'packages\thinkforge\dist' },
    @{ Name = 'memory'; Src = 'packages\memory\src'; Dist = 'packages\memory\dist' }
)) {
    $src = Join-Path $projectRoot $pair.Src
    $dist = Join-Path $projectRoot $pair.Dist
    if (-not (Test-Path -LiteralPath $src -PathType Container)) { continue }
    if (-not (Test-Path -LiteralPath $dist -PathType Container)) { $missing += $pair.Name; continue }
    $newestSrc = (Get-ChildItem -LiteralPath $src -Recurse -Filter '*.ts' -File -ErrorAction SilentlyContinue | Measure-Object -Property LastWriteTime -Maximum).Maximum
    $oldestDist = (Get-ChildItem -LiteralPath $dist -Recurse -Filter '*.js' -File -ErrorAction SilentlyContinue | Measure-Object -Property LastWriteTime -Minimum).Minimum
    if ($newestSrc -and (-not $oldestDist -or $newestSrc -gt $oldestDist)) { $stale += $pair.Name }
}
if ($missing.Count -gt 0) { Add-Result 'Build freshness' 'FAIL' ("missing dist: " + ($missing -join ', ') + " - run 'pnpm build'") }
elseif ($stale.Count -gt 0) { Add-Result 'Build freshness' 'FAIL' ("stale: " + ($stale -join ', ') + " - run 'pnpm build'") }
else { Add-Result 'Build freshness' 'PASS' 'dist newer than src' }

# 4. Tunnel ------------------------------------------------------------------
$daemon = Get-DaemonStatus
if ($daemon -and $daemon.process_running -eq $true -and $daemon.healthy -eq $true -and $daemon.ready -eq $true) {
    Add-Result 'Tunnel' 'PASS' "connected (pid $($daemon.process.pid))"
} elseif ($daemon) {
    Add-Result 'Tunnel' 'FAIL' "state=$($daemon.runtime_state)"
} else {
    Add-Result 'Tunnel' 'FAIL' 'not connected'
}

# 5. Profile ownership --------------------------------------------------------
$profileOwner = Get-ProfileOwner
if (-not $profileOwner) { Add-Result 'Profile ownership' 'WARN' 'no runtime profile yet' }
elseif ($profileOwner -eq $projectRoot) { Add-Result 'Profile ownership' 'PASS' $projectRoot }
else { Add-Result 'Profile ownership' 'FAIL' "owned by $profileOwner" }

# 6. Supervisor ---------------------------------------------------------------
# Supervisor state lives next to the supervisor entry (apps/server/dist ->
# apps/server/.pilot), with repo-root fallbacks for older layouts.
$liveSupervisor = @(
    (Join-Path $projectRoot 'apps\server\.pilot\supervisor.json'),
    (Join-Path $projectRoot '.pilot\supervisor.json'),
    (Join-Path $projectRoot 'apps\server\.chatgpt-machine\supervisor.json'),
    (Join-Path $projectRoot '.chatgpt-machine\supervisor.json')
) | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object {
    $path = $_
    try { $candidate = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } catch { $candidate = $null }
    if ($candidate -and (Test-PidAlive $candidate.supervisorPid) -and (Test-PidAlive $candidate.workerPid)) {
        [pscustomobject]@{ Path = $path; State = $candidate }
    }
} | Select-Object -First 1
if ($liveSupervisor) {
    $st = $liveSupervisor.State
    Add-Result 'Supervisor' 'PASS' "supervisor=$($st.supervisorPid) worker=$($st.workerPid) restarts=$($st.restarts) ($($liveSupervisor.Path))"
} else {
    $anyState = @(
        (Join-Path $projectRoot 'apps\server\.pilot\supervisor.json'),
        (Join-Path $projectRoot '.pilot\supervisor.json'),
        (Join-Path $projectRoot 'apps\server\.chatgpt-machine\supervisor.json'),
        (Join-Path $projectRoot '.chatgpt-machine\supervisor.json')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $anyState) { Add-Result 'Supervisor' 'WARN' 'no state file (supervisor never ran here?)' }
    else { Add-Result 'Supervisor' 'FAIL' ("stale state in $anyState") }
}

# 7. Watchdog -----------------------------------------------------------------
if (Test-Path -LiteralPath $watchdogPidPath) {
    try {
        $wpid = [int](Get-Content -LiteralPath $watchdogPidPath -Raw)
        if (Test-PidAlive $wpid) { Add-Result 'Watchdog' 'PASS' "pid $wpid" }
        else { Add-Result 'Watchdog' 'FAIL' "stale pid file ($wpid dead)" }
    } catch { Add-Result 'Watchdog' 'WARN' 'unreadable pid file' }
} else {
    Add-Result 'Watchdog' 'WARN' 'not running (starts with start-tunnel)'
}

# 8-10. Providers --------------------------------------------------------------
$providerEntries = @(
    @{ Name = 'Skill Hub'; Dir = Join-Path $projectRoot 'packages\skill-hub'; Entry = @('dist\src\index.js', 'dist\index.js') },
    @{ Name = 'ThinkForge'; Dir = Join-Path $projectRoot 'packages\thinkforge'; Entry = @('dist\index.js') },
    @{ Name = 'Memory'; Dir = Join-Path $projectRoot 'packages\memory'; Entry = @('dist\index.js') }
)
foreach ($p in $providerEntries) {
    $found = $p.Entry | Where-Object { Test-Path -LiteralPath (Join-Path $p.Dir $_) } | Select-Object -First 1
    if ($found) { Add-Result $p.Name 'PASS' $found }
    else { Add-Result $p.Name 'FAIL' 'build output missing' }
}

# 11-12. Capability registry -----------------------------------------------------
# Hybrid --check only exposes toolpy/capability_registry, so assert the full
# machine tool surface with the legacy check (source == built == registered)
# and use the hybrid check for provider attachment.
$legacyTools = $null
if (-not (Test-Path -LiteralPath $serverDist)) {
    Add-Result 'Capability registry' 'FAIL' 'server dist missing'
    Add-Result 'Remote git tool' 'SKIP' 'no server build'
} else {
    try {
        $legacyRaw = & node $serverDist --check 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $legacyRaw) { throw 'legacy check failed' }
        $legacyTools = @(( $legacyRaw | ConvertFrom-Json ).tools)
    } catch {
        Add-Result 'Capability registry' 'FAIL' 'legacy --check did not complete'
        Add-Result 'Remote git tool' 'SKIP' 'check unavailable'
    }
}
if ($legacyTools) {
    $sourceFiles = @(
        (Join-Path $projectRoot 'apps\server\src\tools.ts'),
        (Join-Path $projectRoot 'apps\server\src\machine-router.ts')
    ) | Where-Object { Test-Path -LiteralPath $_ }
    # osint_* only register with --enable-osint; absence in a default check is expected.
    $conditionalTools = @('osint_search', 'osint_fetch')
    $sourceTools = @($sourceFiles | ForEach-Object { Select-String -LiteralPath $_ -Pattern "^\s+name: '([a-z0-9_]+)'," -AllMatches } | ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    $missing = @($sourceTools | Where-Object { ($legacyTools -notcontains $_) -and ($conditionalTools -notcontains $_) })
    $extra = @($legacyTools | Where-Object { $sourceTools -notcontains $_ })
    if ($missing.Count -eq 0 -and $extra.Count -eq 0) {
        Add-Result 'Capability registry' 'PASS' ("source == built == registered (" + $legacyTools.Count + " tools, " + $conditionalTools.Count + " conditional excluded)")
    } else {
        $detail = @()
        if ($missing.Count -gt 0) { $detail += ("missing: " + ($missing -join ', ')) }
        if ($extra.Count -gt 0) { $detail += ("unregistered: " + ($extra -join ', ')) }
        Add-Result 'Capability registry' 'FAIL' ($detail -join '; ')
    }
    if ($legacyTools -contains 'git_remote_status') { Add-Result 'Remote git tool' 'PASS' 'git_remote_status exposed' }
    else { Add-Result 'Remote git tool' 'FAIL' 'git_remote_status NOT in tool surface (stale dist?)' }
    try {
        $hybridRaw = & node $serverDist --tool-surface hybrid --dangerously-open-machine --check 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $hybridRaw) { throw 'hybrid check failed' }
        $hybrid = $hybridRaw | ConvertFrom-Json
        $missingProviders = @('machine', 'skills', 'think', 'memory') | Where-Object { @($hybrid.providers) -notcontains $_ }
        if ($missingProviders.Count -eq 0) {
            Add-Result 'Providers' 'PASS' ("$($hybrid.capabilityCount) caps via " + ($hybrid.providers -join '/'))
        } else {
            Add-Result 'Providers' 'FAIL' ("missing providers: " + ($missingProviders -join ', '))
        }
    } catch {
        Add-Result 'Providers' 'FAIL' 'hybrid --check did not complete'
    }
}

# Report -----------------------------------------------------------------------
if ($Json) {
    $results | ConvertTo-Json -Depth 4
} else {
    Write-Host ''
    Write-Host 'ChatGPTMCP Doctor'
    Write-Host ''
    foreach ($r in $results) {
        Write-Host ("{0,-20} {1,-4} {2}" -f $r.check, $r.status, $r.detail)
    }
    Write-Host ''
}
$failed = @($results | Where-Object { $_.status -eq 'FAIL' })
if ($failed.Count -eq 0) {
    $warned = @($results | Where-Object { $_.status -notin @('PASS', 'SKIP') })
    if ($warned.Count -eq 0) { $overall = 'HEALTHY' } else { $overall = 'HEALTHY (with warnings)' }
    if (-not $Json) { Write-Host ("Overall: " + $overall) }
    exit 0
} else {
    if (-not $Json) { Write-Host ("Overall: UNHEALTHY ($($failed.Count) failing)") }
    exit 1
}
