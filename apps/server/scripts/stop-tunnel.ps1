[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$clientPath = Join-Path $projectRoot 'tools\tunnel-client-v0.0.13\tunnel-client.exe'
$watchdogPidPath = Join-Path $projectRoot '.tunnel\watch-tunnel.pid'

if (-not (Test-Path -LiteralPath $clientPath)) {
    throw "Tunnel client not found: $clientPath"
}

# Windows reuses PIDs. A recorded PID from an earlier session can belong to an
# unrelated process by now, so every PID is re-identified before it is killed.
function Get-ProcessInfo([int]$ProcessId) {
    Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $watchdogPidPath) {
    try {
        $watchdogPid = [int](Get-Content -LiteralPath $watchdogPidPath -Raw)
        $watchdog = Get-ProcessInfo $watchdogPid
        if ($watchdog -and "$($watchdog.CommandLine)" -match 'watch-tunnel') {
            Stop-Process -Id $watchdogPid -Force
        } elseif ($watchdog) {
            Write-Host "Ignoring stale watchdog PID $watchdogPid (now $($watchdog.Name))"
        }
    } catch { }
    Remove-Item -LiteralPath $watchdogPidPath -Force -ErrorAction SilentlyContinue
}

# Record the MCP child (node dist/index.js) this daemon is currently running
# before asking the daemon to stop. "tunnel-client runtimes stop" reliably
# stops the tunnel-client.exe daemon itself, but does not reliably terminate
# the node child it spawned -- left running, that orphan keeps serving stale
# code on the next start-tunnel and silently causes every tool call to 502
# until someone notices and kills it by hand.
$statusJson = & $clientPath runtimes status chatgpt-machine --json 2>$null
$status = $null
$daemonPid = $null
if ($LASTEXITCODE -eq 0 -and $statusJson) {
    try { $status = ($statusJson -join "`n") | ConvertFrom-Json; $daemonPid = $status.process.pid } catch { $status = $null; $daemonPid = $null }
}

# "runtimes stop" kills the recorded daemon PID without checking what it is now.
# When the runtime is already down, that PID may have been reused by another
# process (observed: a Windows system process), so skip the stop entirely.
if ($status) {
    $daemon = if ($daemonPid) { Get-ProcessInfo ([int]$daemonPid) } else { $null }
    $daemonIsTunnelClient = $daemon -and $daemon.Name -ieq 'tunnel-client.exe'
    if (-not $status.process_running -or -not $daemonIsTunnelClient) {
        if ($daemon -and -not $daemonIsTunnelClient) {
            Write-Host "Recorded tunnel-client PID $daemonPid now belongs to $($daemon.Name); not stopping it."
        }
        Write-Host 'Tunnel runtime chatgpt-machine is already stopped.'
        exit 0
    }
}
$children = @()
if ($daemonPid) {
    $children = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' AND ParentProcessId=$daemonPid" -ErrorAction SilentlyContinue)
}

& $clientPath runtimes stop chatgpt-machine

if ($LASTEXITCODE -ne 0) {
    throw "tunnel-client stop failed with exit code $LASTEXITCODE"
}

# Kill only the exact child PIDs recorded above, and only if still alive.
# This never touches processes by image name (e.g. "taskkill /im node.exe"),
# which would affect every unrelated Node process on the machine -- only the
# specific PID this script itself observed as this daemon's child moments ago.
Start-Sleep -Milliseconds 500
foreach ($child in $children) {
    if (Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue) {
        Write-Host "Killing orphaned MCP child process (PID $($child.ProcessId))"
        Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
