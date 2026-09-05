[CmdletBinding()]
param(
    [switch]$NoWatchdog
)

$ErrorActionPreference = 'Stop'

# ChatGPTMCP is the sole owner of the `chatgpt-machine` tunnel lifecycle.
# Restart = stop (kills watchdog + orphaned MCP child) then start
# (reclaims the runtime profile if a legacy checkout stole it, respawns watchdog).
$stopScript = Join-Path $PSScriptRoot 'stop-tunnel.ps1'
$startScript = Join-Path $PSScriptRoot 'start-tunnel.ps1'

& $stopScript
if ($LASTEXITCODE -ne 0) {
    throw "restart-tunnel: stop failed with exit code $LASTEXITCODE"
}

if ($NoWatchdog) {
    & $startScript -NoWatchdog
} else {
    & $startScript
}
if ($LASTEXITCODE -ne 0) {
    throw "restart-tunnel: start failed with exit code $LASTEXITCODE"
}
