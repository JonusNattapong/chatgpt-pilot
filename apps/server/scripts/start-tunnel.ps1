[CmdletBinding()]
param(
    [switch]$NoWatchdog
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $projectRoot)
$clientPath = Join-Path $projectRoot 'tools\tunnel-client-v0.0.13\tunnel-client.exe'
$keyPath = Join-Path $repoRoot '.tunnel\control-plane-api-key.dpapi'
$profileDir = Join-Path $env:APPDATA 'tunnel-client'
$workspaceRoot = if ([string]::IsNullOrWhiteSpace($env:MCP_WORKSPACE_ROOT)) { $repoRoot } else { $env:MCP_WORKSPACE_ROOT }
$accessMode = if ([string]::IsNullOrWhiteSpace($env:MCP_ACCESS_MODE)) { 'unrestricted' } else { $env:MCP_ACCESS_MODE }
$policy = if ([string]::IsNullOrWhiteSpace($env:MCP_POLICY)) { 'admin' } else { $env:MCP_POLICY }
$approvalMode = if ([string]::IsNullOrWhiteSpace($env:MCP_APPROVAL_MODE)) { 'mrtr' } else { $env:MCP_APPROVAL_MODE }
$machinesFile = if ([string]::IsNullOrWhiteSpace($env:MCP_MACHINES_FILE)) { Join-Path $repoRoot '.chatgpt-machine\machines.json' } else { $env:MCP_MACHINES_FILE }
$supervisorTimeout = if ([string]::IsNullOrWhiteSpace($env:MCP_SUPERVISOR_TIMEOUT_MS)) { '600000' } else { $env:MCP_SUPERVISOR_TIMEOUT_MS }
$toolSurface = if ([string]::IsNullOrWhiteSpace($env:MCP_TOOL_SURFACE)) { if ($accessMode -eq 'unrestricted') { 'hybrid' } else { 'legacy' } } else { $env:MCP_TOOL_SURFACE }
$projectsRoot = Split-Path -Parent $repoRoot
$skillHubDir = if ([string]::IsNullOrWhiteSpace($env:MCP_SKILL_HUB_DIR)) { Join-Path $repoRoot 'packages\skill-hub' } else { $env:MCP_SKILL_HUB_DIR }
$thinkForgeDir = if ([string]::IsNullOrWhiteSpace($env:MCP_THINKFORGE_DIR)) { Join-Path $repoRoot 'packages\thinkforge' } else { $env:MCP_THINKFORGE_DIR }
$memoryDir = if ([string]::IsNullOrWhiteSpace($env:MCP_MEMORY_DIR)) { Join-Path $repoRoot 'packages\memory' } else { $env:MCP_MEMORY_DIR }
$supervisorPath = (Join-Path $projectRoot 'dist\supervisor.js').Replace('\', '/')
$watchdogScript = Join-Path $PSScriptRoot 'watch-tunnel.ps1'
$watchdogPidPath = Join-Path $repoRoot '.tunnel\watch-tunnel.pid'
$receiptPath = Join-Path $repoRoot '.tunnel\last-control-restart.json'
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

    [ordered]@{ state = 'ready'; workerPid = $null; expectedCommit = $null; at = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding UTF8

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


