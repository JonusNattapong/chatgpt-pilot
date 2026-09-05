[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$clientPath = Join-Path $projectRoot 'tools\tunnel-client-v0.0.13\tunnel-client.exe'
$watchdogPidPath = Join-Path $projectRoot '.tunnel\watch-tunnel.pid'
$ownerPath = Join-Path $projectRoot '.tunnel\runtime-owner.json'

function Clear-OwnClaim {
    # Never delete another checkout's claim; only our own.
    try {
        if (Test-Path -LiteralPath $ownerPath) {
            $claim = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
            if ($claim.owner -eq $projectRoot) { Remove-Item -LiteralPath $ownerPath -Force }
        }
    } catch { }
}

if (-not (Test-Path -LiteralPath $clientPath)) {
    throw "Tunnel client not found: $clientPath"
}

if (Test-Path -LiteralPath $watchdogPidPath) {
    try {
        $watchdogPid = [int](Get-Content -LiteralPath $watchdogPidPath -Raw)
        if (Get-Process -Id $watchdogPid -ErrorAction SilentlyContinue) { Stop-Process -Id $watchdogPid -Force }
    } catch { }
    Remove-Item -LiteralPath $watchdogPidPath -Force -ErrorAction SilentlyContinue
}

$statusJson = & $clientPath runtimes status chatgpt-machine --json 2>$null
if ($LASTEXITCODE -ne 0 -or -not $statusJson) {
    Write-Host 'Tunnel already stopped.'
    Clear-OwnClaim
    exit 0
}
try { $alreadyStopped = -not ($statusJson | ConvertFrom-Json).process_running } catch { $alreadyStopped = $false }
if ($alreadyStopped) {
    Write-Host 'Tunnel already stopped.'
    Clear-OwnClaim
    exit 0
}

# Record the MCP child (node dist/index.js) this daemon is currently running
# before asking the daemon to stop. "tunnel-client runtimes stop" reliably
# stops the tunnel-client.exe daemon itself, but does not reliably terminate
# the node child it spawned -- left running, that orphan keeps serving stale
# code on the next start-tunnel and silently causes every tool call to 502
# until someone notices and kills it by hand.
$statusJson = & $clientPath runtimes status chatgpt-machine --json 2>$null
$daemonPid = $null
if ($LASTEXITCODE -eq 0 -and $statusJson) {
    try { $daemonPid = ($statusJson | ConvertFrom-Json).process.pid } catch { $daemonPid = $null }
}
$children = @()
if ($daemonPid) {
    $children = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' AND ParentProcessId=$daemonPid" -ErrorAction SilentlyContinue)
}

try {
    & $clientPath runtimes stop chatgpt-machine
    if ($LASTEXITCODE -ne 0) { throw "tunnel-client stop failed with exit code $LASTEXITCODE" }
} catch {
    # `runtimes stop` may report failure for an already-dead daemon; verify
    # ground truth before deciding. Only throw when still actually running.
    $verify = & $clientPath runtimes status chatgpt-machine --json 2>$null
    $stillRunning = $false
    if ($LASTEXITCODE -eq 0 -and $verify) {
        try { $stillRunning = ($verify | ConvertFrom-Json).process_running -eq $true } catch { }
    }
    if ($stillRunning) { throw }
    Write-Host 'Tunnel already stopped.'
}

Clear-OwnClaim

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
