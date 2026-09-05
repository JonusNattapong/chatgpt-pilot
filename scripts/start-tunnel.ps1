[CmdletBinding()]
param(
    [switch]$NoWatchdog,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$clientPath = Join-Path $projectRoot 'tools\tunnel-client-v0.0.13\tunnel-client.exe'
$keyPath = Join-Path $projectRoot '.tunnel\control-plane-api-key.dpapi'
$profileDir = Join-Path $env:APPDATA 'tunnel-client'
$workspaceRoot = if ([string]::IsNullOrWhiteSpace($env:MCP_WORKSPACE_ROOT)) { Split-Path -Parent $projectRoot } else { $env:MCP_WORKSPACE_ROOT }
$accessMode = if ([string]::IsNullOrWhiteSpace($env:MCP_ACCESS_MODE)) { 'unrestricted' } else { $env:MCP_ACCESS_MODE }
$policy = if ([string]::IsNullOrWhiteSpace($env:MCP_POLICY)) { 'admin' } else { $env:MCP_POLICY }
$approvalMode = if ([string]::IsNullOrWhiteSpace($env:MCP_APPROVAL_MODE)) { 'mrtr' } else { $env:MCP_APPROVAL_MODE }
$machinesFile = if ([string]::IsNullOrWhiteSpace($env:MCP_MACHINES_FILE)) { Join-Path $projectRoot '.chatgpt-machine\machines.json' } else { $env:MCP_MACHINES_FILE }
$supervisorTimeout = if ([string]::IsNullOrWhiteSpace($env:MCP_SUPERVISOR_TIMEOUT_MS)) { '120000' } else { $env:MCP_SUPERVISOR_TIMEOUT_MS }
$toolSurface = if ([string]::IsNullOrWhiteSpace($env:MCP_TOOL_SURFACE)) { if ($accessMode -eq 'unrestricted') { 'hybrid' } else { 'legacy' } } else { $env:MCP_TOOL_SURFACE }
$projectsRoot = Split-Path -Parent $projectRoot
$defaultSkillHub = if (Test-Path (Join-Path $projectRoot 'packages\skill-hub') -PathType Container) { Join-Path $projectRoot 'packages\skill-hub' } else { Join-Path $projectsRoot 'chatgpt-skill-hub' }
$defaultThinkForge = if (Test-Path (Join-Path $projectRoot 'packages\thinkforge') -PathType Container) { Join-Path $projectRoot 'packages\thinkforge' } else { Join-Path $projectsRoot 'ThinkForge-MCP' }
$defaultMemory = if (Test-Path (Join-Path $projectRoot 'packages\memory') -PathType Container) { Join-Path $projectRoot 'packages\memory' } else { Join-Path $projectsRoot 'ourbook' }
$skillHubDir = if ([string]::IsNullOrWhiteSpace($env:MCP_SKILL_HUB_DIR)) { $defaultSkillHub } else { $env:MCP_SKILL_HUB_DIR }
$thinkForgeDir = if ([string]::IsNullOrWhiteSpace($env:MCP_THINKFORGE_DIR)) { $defaultThinkForge } else { $env:MCP_THINKFORGE_DIR }
$memoryDir = if ([string]::IsNullOrWhiteSpace($env:MCP_MEMORY_DIR)) { $defaultMemory } else { $env:MCP_MEMORY_DIR }
$supervisorFile = if (Test-Path (Join-Path $projectRoot 'apps\server\dist\supervisor.js')) {
    Join-Path $projectRoot 'apps\server\dist\supervisor.js'
} else {
    Join-Path $projectRoot 'dist\supervisor.js'
}
$supervisorPath = $supervisorFile.Replace('\', '/')
$watchdogScript = Join-Path $PSScriptRoot 'watch-tunnel.ps1'
$watchdogPidPath = Join-Path $projectRoot '.tunnel\watch-tunnel.pid'
$workspaceArg = $workspaceRoot.Replace('\', '/')
$machinesArg = $machinesFile.Replace('\', '/')
$openArg = if ($accessMode -eq 'unrestricted') { ' --dangerously-open-machine' } else { '' }
$providerArgs = ''
if ($toolSurface -eq 'hybrid') {
    if ($accessMode -ne 'unrestricted') { throw 'Hybrid tool surface requires MCP_ACCESS_MODE=unrestricted.' }
    foreach ($providerDir in @($skillHubDir, $thinkForgeDir, $memoryDir)) {
        if (-not (Test-Path -LiteralPath $providerDir -PathType Container)) { throw "Hybrid provider directory not found: $providerDir" }
    }
    $skillHubArg = $skillHubDir.Replace('\', '/')
    $thinkForgeArg = $thinkForgeDir.Replace('\', '/')
    $memoryArg = $memoryDir.Replace('\', '/')
    $providerArgs = " --tool-surface hybrid --skill-hub-dir `"$skillHubArg`" --thinkforge-dir `"$thinkForgeArg`" --memory-dir `"$memoryArg`""
}
$mcpCommand = "node $supervisorPath --supervisor-timeout $supervisorTimeout --root `"$workspaceArg`" --policy $policy --approval-mode $approvalMode --machines-file `"$machinesArg`"$openArg$providerArgs"

if (-not (Test-Path -LiteralPath $clientPath)) {
    throw "Tunnel client not found: $clientPath"
}

if (-not (Test-Path -LiteralPath $keyPath)) {
    throw "DPAPI runtime key not found: $keyPath"
}

# Ownership guard: ChatGPTMCP is the sole owner of the `chatgpt-machine`
# alias and the `chatgpt-machine-runtime` profile. If the profile currently
# points outside this repo (e.g. a legacy checkout reclaimed it):
#   - daemon alive  -> reject, unless -Force reclaims it
#   - daemon dead   -> stop the stale entry and overwrite the profile below
# If the daemon is alive and already ours, start is a no-op (idempotent).
$ownerPath = Join-Path $projectRoot '.tunnel\runtime-owner.json'
$runtimeProfilePath = Join-Path $profileDir 'chatgpt-machine-runtime.yaml'
$projectMarker = $projectRoot.Replace('\', '/')

function Get-ProfileOwner {
    if (-not (Test-Path -LiteralPath $runtimeProfilePath)) { return $null }
    $text = Get-Content -LiteralPath $runtimeProfilePath -Raw
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    $m = [regex]::Match($text, '(?<repo>[A-Za-z]:[^"\s]*?)/(?:apps/server/)?dist/supervisor\.js')
    if ($m.Success) { return $m.Groups['repo'].Value.Replace('/', '\') }
    if ($text -like "*$projectMarker*") { return $projectRoot }
    return 'unknown-foreign-owner'
}

function Get-DaemonStatus {
    try {
        $raw = & $clientPath runtimes status chatgpt-machine --json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

function Test-DaemonReady($status) {
    return $null -ne $status -and $status.process_running -eq $true -and $status.healthy -eq $true -and $status.ready -eq $true
}

$daemon = Get-DaemonStatus
$profileOwner = Get-ProfileOwner

if (Test-DaemonReady $daemon) {
    if ($profileOwner -eq $projectRoot) {
        Write-Host 'Tunnel already running and owned by this checkout; nothing to do.'
        & (Join-Path $PSScriptRoot 'status-tunnel.ps1')
        exit 0
    }
    if (-not $Force) {
        throw "Runtime already owned by: $profileOwner. Stop it there first, or re-run with -Force to reclaim ownership."
    }
    Write-Warning "Reclaiming live runtime from foreign owner: $profileOwner"
    try { & $clientPath runtimes stop chatgpt-machine 2>$null } catch { }
} elseif ($profileOwner -and $profileOwner -ne $projectRoot) {
    Write-Warning "Runtime profile $runtimeProfilePath points outside this checkout ($profileOwner); reclaiming ownership."
    try { & $clientPath runtimes stop chatgpt-machine 2>$null } catch { }
}

# Build freshness is advisory here (doctor.ps1 is authoritative): warn when
# any TypeScript source is newer than the built output so a stale dist can
# never silently serve an old tool surface.
try {
    $stalePackages = @()
    foreach ($pair in @(
        @{ Src = Join-Path $projectRoot 'apps\server\src'; Dist = Join-Path $projectRoot 'apps\server\dist' },
        @{ Src = Join-Path $projectRoot 'packages\skill-hub\src'; Dist = Join-Path $projectRoot 'packages\skill-hub\dist' },
        @{ Src = Join-Path $projectRoot 'packages\thinkforge\src'; Dist = Join-Path $projectRoot 'packages\thinkforge\dist' },
        @{ Src = Join-Path $projectRoot 'packages\memory\src'; Dist = Join-Path $projectRoot 'packages\memory\dist' }
    )) {
        if (-not (Test-Path -LiteralPath $pair.Src -PathType Container)) { continue }
        if (-not (Test-Path -LiteralPath $pair.Dist -PathType Container)) { $stalePackages += $pair.Src; continue }
        $newestSrc = (Get-ChildItem -LiteralPath $pair.Src -Recurse -Filter '*.ts' -File -ErrorAction SilentlyContinue | Measure-Object -Property LastWriteTime -Maximum).Maximum
        $oldestDist = (Get-ChildItem -LiteralPath $pair.Dist -Recurse -Filter '*.js' -File -ErrorAction SilentlyContinue | Measure-Object -Property LastWriteTime -Minimum).Minimum
        if ($newestSrc -and (-not $oldestDist -or $newestSrc -gt $oldestDist)) { $stalePackages += $pair.Src }
    }
    if ($stalePackages.Count -gt 0) {
        Write-Warning ("Built output looks stale for: " + ($stalePackages -join ', ') + ". Run 'pnpm build' then restart, or see .\scripts\doctor.ps1.")
    }
} catch { }

$secureKey = $null
$runtimeKey = $env:CONTROL_PLANE_API_KEY

try {
    if ([string]::IsNullOrWhiteSpace($runtimeKey)) {
        # Windows PowerShell can fail to autoload Microsoft.PowerShell.Security
        # from a background -File process. Decode in a clean -Command process;
        # only the key path crosses that process boundary and its output stays in memory.
        $env:MCP_RUNTIME_KEY_PATH = $keyPath
        $decoder = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
        if ([string]::IsNullOrWhiteSpace($decoder)) { $decoder = 'powershell.exe' }
        $runtimeKey = (& $decoder -NoLogo -NoProfile -NonInteractive -Command '$cipherText = Get-Content -LiteralPath $env:MCP_RUNTIME_KEY_PATH -Raw; $secureKey = ConvertTo-SecureString $cipherText; [Net.NetworkCredential]::new('''' , $secureKey).Password').Trim()
    }

    if ([string]::IsNullOrWhiteSpace($runtimeKey) -or -not $runtimeKey.StartsWith('sk-')) {
        throw 'The DPAPI file did not decrypt to a valid runtime API key.'
    }

    $env:CONTROL_PLANE_API_KEY = $runtimeKey

    # Claim ownership before connecting so a concurrent foreign start can see
    # who owns the alias; refreshed with the daemon PID after connect.
    try {
        $commit = (& git -C $projectRoot rev-parse HEAD 2>$null)
        if ($LASTEXITCODE -ne 0) { $commit = $null }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ownerPath) | Out-Null
        [ordered]@{
            alias = 'chatgpt-machine'
            owner = $projectRoot
            startedAt = (Get-Date).ToString('o')
            commit = $commit
            supervisor = $supervisorFile
            pid = $null
        } | ConvertTo-Json | Set-Content -LiteralPath $ownerPath -Encoding UTF8
    } catch { }

    & $clientPath runtimes connect `
        --alias chatgpt-machine `
        --admin-profile default `
        --profile chatgpt-machine-runtime `
        --profile-dir $profileDir `
        --tunnel-id tunnel_6a91bbd0be488191912a5abe9f80a711 `
        --organization-id org-Ku85qrWdADBgvNx2WZyjju4O `
        --runtime-api-key env:CONTROL_PLANE_API_KEY `
        --mcp-command $mcpCommand

    if ($LASTEXITCODE -ne 0) {
        throw "tunnel-client connect failed with exit code $LASTEXITCODE"
    }

    & (Join-Path $PSScriptRoot 'status-tunnel.ps1')

    try {
        $after = Get-DaemonStatus
        if ($after -and $after.process.pid) {
            $claim = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
            if ($claim.owner -eq $projectRoot) {
                $claim.pid = $after.process.pid
                $claim | ConvertTo-Json | Set-Content -LiteralPath $ownerPath -Encoding UTF8
            }
        }
    } catch { }

    if (-not $NoWatchdog -and $env:MCP_TUNNEL_WATCHDOG -ne '1' -and (Test-Path -LiteralPath $watchdogScript)) {
        $existingPid = $null
        if (Test-Path -LiteralPath $watchdogPidPath) {
            try { $existingPid = [int](Get-Content -LiteralPath $watchdogPidPath -Raw) } catch { $existingPid = $null }
        }
        if (-not $existingPid -or -not (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
            $watchdogArgs = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $watchdogScript)
            $watchdog = Start-Process powershell.exe -ArgumentList $watchdogArgs -WindowStyle Hidden -PassThru
            Set-Content -LiteralPath $watchdogPidPath -Value $watchdog.Id -Encoding ASCII
            Write-Host "Tunnel watchdog started (PID $($watchdog.Id))"
        }
    }
}
finally {
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:MCP_RUNTIME_KEY_PATH -ErrorAction SilentlyContinue
    $decoder = $null
    $runtimeKey = $null
    if ($null -ne $secureKey) {
        $secureKey.Dispose()
    }
}


