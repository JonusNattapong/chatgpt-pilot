[CmdletBinding()]
param(
    # Live suite: stops/starts the real chatgpt-machine tunnel. Requires
    # explicit opt-in so it never runs by accident (e.g. from CI).
    [switch]$Live,
    [int]$ReadyTimeoutSeconds = 150
)

$ErrorActionPreference = 'Stop'

if (-not $Live) {
    Write-Host 'Refusing to flap the live tunnel without -Live.'
    Write-Host 'Usage: .\tests\lifecycle.ps1 -Live'
    exit 2
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$clientPath = Join-Path $projectRoot 'tools\tunnel-client-v0.0.13\tunnel-client.exe'
$profileDir = Join-Path $env:APPDATA 'tunnel-client'
$runtimeProfilePath = Join-Path $profileDir 'chatgpt-machine-runtime.yaml'
$ownerPath = Join-Path $projectRoot '.tunnel\runtime-owner.json'
$watchdogPidPath = Join-Path $projectRoot '.tunnel\watch-tunnel.pid'
$serverDist = Join-Path $projectRoot 'apps\server\dist\index.js'
$passed = 0
$failed = 0

function Get-Status {
    try {
        $raw = & $clientPath runtimes status chatgpt-machine --json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

function Test-Ready($s) {
    return $null -ne $s -and $s.process_running -eq $true -and $s.healthy -eq $true -and $s.ready -eq $true
}

function Wait-Ready($timeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Ready (Get-Status)) { return $true }
        Start-Sleep -Seconds 5
    }
    return (Test-Ready (Get-Status))
}

function Get-WatchdogPid {
    try { return [int](Get-Content -LiteralPath $watchdogPidPath -Raw) } catch { return $null }
}

function Assert($name, $condition, $detail) {
    if ($condition) {
        $script:passed++
        Write-Host ("PASS  {0}  {1}" -f $name, $detail)
    } else {
        $script:failed++
        Write-Host ("FAIL  {0}  {1}" -f $name, $detail)
    }
}

function Invoke-RepoScript($file, $scriptArgs) {
    $out = & (Join-Path $projectRoot "scripts\$file") @scriptArgs 2>&1 | Out-String
    return @{ Code = $LASTEXITCODE; Output = $out }
}

Write-Host 'Lifecycle integration suite (live tunnel)'
Write-Host ("Checkout: {0}" -f $projectRoot)

if (-not (Test-Ready (Get-Status))) {
    Write-Host 'ABORT: tunnel is not healthy; fix it with .\scripts\doctor.ps1 first.'
    exit 1
}

try {
    # 1. start twice: second start is a no-op, same daemon -------------------
    $pidBefore = (Get-Status).process.pid
    $r = Invoke-RepoScript 'start-tunnel.ps1' @()
    $pidAfter = (Get-Status).process.pid
    Assert 'start-twice-idempotent' ($r.Code -eq 0 -and $pidBefore -eq $pidAfter) ("exit=$($r.Code) pid $pidBefore -> $pidAfter")

    # 2. watchdog recovery: dead watchdog is healed by idempotent start ------
    $wdBefore = Get-WatchdogPid
    if ($wdBefore) { Stop-Process -Id $wdBefore -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    $r = Invoke-RepoScript 'start-tunnel.ps1' @()
    $wdAfter = Get-WatchdogPid
    $wdAlive = $false
    try { $wdAlive = $null -ne (Get-Process -Id $wdAfter -ErrorAction Stop) } catch { }
    Assert 'watchdog-recovery' ($r.Code -eq 0 -and $wdAlive -and $wdAfter -ne $wdBefore) ("wd $wdBefore -> $wdAfter alive=$wdAlive")

    # 3. restart: full stack, daemon PID must change --------------------------
    $r = Invoke-RepoScript 'restart-tunnel.ps1' @()
    $restartOk = ($r.Code -eq 0) -and (Wait-Ready $ReadyTimeoutSeconds)
    $pidRestarted = (Get-Status).process.pid
    Assert 'restart-full-stack' ($restartOk -and $pidRestarted -ne $pidBefore) ("exit=$($r.Code) pid $pidBefore -> $pidRestarted")

    # 4. stop twice: second stop is a no-op -----------------------------------
    $r1 = Invoke-RepoScript 'stop-tunnel.ps1' @()
    $stopped = -not (Get-Status).process_running
    $r2 = Invoke-RepoScript 'stop-tunnel.ps1' @()
    Assert 'stop-twice-idempotent' ($r1.Code -eq 0 -and $stopped -and $r2.Code -eq 0) ("exits=$($r1.Code)/$($r2.Code) stopped=$stopped")

    # 5. start recovers from stopped -------------------------------------------
    $r = Invoke-RepoScript 'start-tunnel.ps1' @()
    Assert 'start-recovers' (($r.Code -eq 0) -and (Wait-Ready $ReadyTimeoutSeconds)) ("exit=$($r.Code)")

    # 6. stale foreign profile is reclaimed ------------------------------------
    $r = Invoke-RepoScript 'stop-tunnel.ps1' @()
    $backup = (Get-Content -LiteralPath $runtimeProfilePath -Raw) + "`n# lifecycle-test backup marker"
    Set-Content -LiteralPath "$runtimeProfilePath.lifecycle-backup" -Value $backup -Encoding UTF8
    Set-Content -LiteralPath $runtimeProfilePath -Value 'mcp: { commands: [ { command: "node D:/Projects/Github/chatgpt-developer-plugin/apps/server/dist/supervisor.js" } ] }' -Encoding UTF8
    $r = Invoke-RepoScript 'start-tunnel.ps1' @()
    $reclaimed = (Wait-Ready $ReadyTimeoutSeconds) -and ((Get-Content -LiteralPath $runtimeProfilePath -Raw) -like '*ChatGPTMCP*')
    Remove-Item -LiteralPath "$runtimeProfilePath.lifecycle-backup" -Force -ErrorAction SilentlyContinue
    Assert 'stale-profile-recovery' (($r.Code -eq 0) -and $reclaimed) ("exit=$($r.Code) reclaimed=$reclaimed")

    # 7. capability regression: restarted stack exposes the current surface ----
    $legacyTools = @()
    try {
        $legacyRaw = & node $serverDist --check 2>$null
        if ($LASTEXITCODE -eq 0 -and $legacyRaw) { $legacyTools = @(($legacyRaw | ConvertFrom-Json).tools) }
    } catch { }
    Assert 'capability-regression' ($legacyTools -contains 'git_remote_status') ("tools=$($legacyTools.Count) git_remote_status present")
} finally {
    # Always leave the machine serving: best-effort restore + report. ---------
    try {
        if (-not (Wait-Ready 30)) {
            Write-Host 'Restore: tunnel not ready, starting...'
            Invoke-RepoScript 'start-tunnel.ps1' @() | Out-Null
            Wait-Ready $ReadyTimeoutSeconds | Out-Null
        }
    } catch { }
    $final = Get-Status
    Write-Host ("Final: ready={0} pid={1}" -f (Test-Ready $final), $final.process.pid)
}

Write-Host ("Result: {0} passed, {1} failed" -f $passed, $failed)
if ($failed -gt 0) { exit 1 }
