[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$clientPath = Join-Path $projectRoot 'tools\tunnel-client-v0.0.13\tunnel-client.exe'

if (-not (Test-Path -LiteralPath $clientPath)) {
    throw "Tunnel client not found: $clientPath"
}

$statusJson = & $clientPath runtimes status chatgpt-machine --json

if ($LASTEXITCODE -ne 0) {
    throw "tunnel-client status failed with exit code $LASTEXITCODE"
}

$status = $statusJson | ConvertFrom-Json
$watchdogStatusPath = Join-Path $projectRoot '.tunnel\watch-tunnel-status.json'
$watchdog = $null
if (Test-Path -LiteralPath $watchdogStatusPath) {
    try { $watchdog = Get-Content -LiteralPath $watchdogStatusPath -Raw | ConvertFrom-Json } catch { $watchdog = $null }
}
$pollHealthy = $false
if ($status.process_running -eq $true -and $status.health_url -and $status.process.pid) {
    $healthJson = & $clientPath health --url $status.health_url --pid $status.process.pid --require-control-plane-poll --json 2>$null
    if ($LASTEXITCODE -eq 0 -and $healthJson) {
        $health = $healthJson | ConvertFrom-Json
        $pollHealthy = $health.result -eq 'ok' -and $health.control_plane_poll.ok -eq $true
    }
}

[pscustomobject]@{
    alias              = $status.alias
    process_running    = $status.process_running
    healthy            = $status.healthy
    ready              = $status.ready
    control_plane_poll = $pollHealthy
    runtime_state      = if ($status.ready -eq $true -and $pollHealthy) { 'ready' } elseif ($status.process_running -eq $true) { 'degraded' } else { $status.runtime_state }
    watchdog_ready     = if ($watchdog) { $watchdog.ready } else { $null }
    watchdog_failures  = if ($watchdog) { $watchdog.consecutiveFailures } else { $null }
    watchdog_reason    = if ($watchdog) { $watchdog.reason } else { $null }
    watchdog_checked   = if ($watchdog) { $watchdog.checkedAt } else { $null }
    last_reconnect     = if ($watchdog) { $watchdog.lastReconnectAt } else { $null }
    pid                = $status.process.pid
    ui_url             = $status.ui_url
}
