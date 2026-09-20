[CmdletBinding()]
param(
    [ValidateRange(5, 300)]
    [int]$IntervalSeconds = 15,
    [ValidateRange(1, 10)]
    [int]$FailureThreshold = 2,
    [ValidateRange(15, 3600)]
    [int]$ReconnectCooldownSeconds = 60,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
$env:MCP_TUNNEL_WATCHDOG = '1'
$projectRoot = Split-Path -Parent $PSScriptRoot
$clientPath = Join-Path $projectRoot 'tools\tunnel-client-v0.0.13\tunnel-client.exe'
$startScript = Join-Path $PSScriptRoot 'start-tunnel.ps1'
$stateDir = Join-Path $projectRoot '.tunnel'
$pidPath = Join-Path $stateDir 'watch-tunnel.pid'
$logPath = Join-Path $stateDir 'watch-tunnel.log'
$statusPath = Join-Path $stateDir 'watch-tunnel-status.json'

function Write-WatchdogLog {
    param([string]$Message)
    if (Test-Path -LiteralPath $logPath) {
        $length = (Get-Item -LiteralPath $logPath).Length
        if ($length -gt 1MB) { Move-Item -LiteralPath $logPath -Destination "$logPath.previous" -Force }
    }
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

function Write-WatchdogStatus {
    param([bool]$Ready, [int]$Failures, [string]$Reason, [Nullable[datetime]]$LastReconnectAt)
    $tmp = "$statusPath.tmp.$PID"
    [ordered]@{
        ready = $Ready
        consecutiveFailures = $Failures
        reason = $Reason
        checkedAt = (Get-Date).ToString('o')
        lastReconnectAt = if ($LastReconnectAt) { $LastReconnectAt.Value.ToString('o') } else { $null }
        watchdogPid = $PID
    } | ConvertTo-Json | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $statusPath -Force
}

function Test-TunnelReady {
    try {
        $raw = & $clientPath runtimes status chatgpt-machine --json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $raw) { return $false }
        $status = $raw | ConvertFrom-Json
        if ($status.process_running -ne $true -or $status.healthy -ne $true -or $status.ready -ne $true) { return $false }

        # readyz only proves the local daemon is alive. Require a recent successful
        # control-plane poll too, otherwise the connector can still discover a
        # cached tool surface while commands never reach this runtime.
        $healthRaw = & $clientPath health --url $status.health_url --pid $status.process.pid --require-control-plane-poll --json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $healthRaw) { return $false }
        $health = $healthRaw | ConvertFrom-Json
        return $health.result -eq 'ok' -and $health.control_plane_poll.ok -eq $true
    } catch { return $false }
}

if (-not (Test-Path -LiteralPath $clientPath)) { throw "Tunnel client not found: $clientPath" }
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$failures = 0
$lastReconnectAt = $null
try {
    while ($true) {
        if (Test-TunnelReady) {
            $failures = 0
            Write-WatchdogStatus -Ready $true -Failures 0 -Reason 'healthy' -LastReconnectAt $lastReconnectAt
        } else {
            $failures++
            $cooldownElapsed = -not $lastReconnectAt -or ((Get-Date) - $lastReconnectAt).TotalSeconds -ge $ReconnectCooldownSeconds
            Write-WatchdogStatus -Ready $false -Failures $failures -Reason $(if ($cooldownElapsed) { 'unhealthy' } else { 'reconnect_cooldown' }) -LastReconnectAt $lastReconnectAt
            if ($failures -ge $FailureThreshold -and $cooldownElapsed) {
                $lastReconnectAt = Get-Date
                Write-WatchdogLog "runtime unhealthy for $failures checks; reconnecting (cooldown=${ReconnectCooldownSeconds}s)"
                try {
                    & $startScript -NoWatchdog 2>&1 | Out-String | ForEach-Object { if ($_.Trim()) { Write-WatchdogLog $_.Trim() } }
                    if (Test-TunnelReady) {
                        $failures = 0
                        Write-WatchdogStatus -Ready $true -Failures 0 -Reason 'recovered' -LastReconnectAt $lastReconnectAt
                    } else {
                        Write-WatchdogStatus -Ready $false -Failures $failures -Reason 'reconnect_did_not_recover' -LastReconnectAt $lastReconnectAt
                    }
                } catch {
                    Write-WatchdogLog "reconnect failed: $($_.Exception.Message)"
                    Write-WatchdogStatus -Ready $false -Failures $failures -Reason 'reconnect_failed' -LastReconnectAt $lastReconnectAt
                }
            }
        }
        if ($Once) { break }
        Start-Sleep -Seconds $IntervalSeconds
    }
} finally {
    if (Test-Path -LiteralPath $pidPath) {
        try { if ([int](Get-Content -LiteralPath $pidPath -Raw) -eq $PID) { Remove-Item -LiteralPath $pidPath -Force } } catch { }
    }
}
