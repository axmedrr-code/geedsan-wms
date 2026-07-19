#Requires -Version 5.1
# NUWACO WMS Auto-Start Script
# Registered as a Windows Task Scheduler task — runs automatically at user logon.
# Waits for Docker Engine to be ready, then runs docker compose up -d to bring
# up all services in dependency order (respecting depends_on + healthchecks).

$ProjectDir = "C:\geedsan\geedsan"
$LogFile    = "C:\geedsan\geedsan\scripts\wms-autostart.log"

function Write-Log {
    param([string]$Msg)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Msg"
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

Write-Log "WMS auto-start triggered (Task Scheduler at logon)"

# ── 0. Ensure Docker Desktop AutoStart is always true ─────────────────────────
# Docker Desktop can overwrite settings-store.json with AutoStart=false on exit.
# We reset it here so it is always true before the engine starts next time.
$ddSettings = "$env:APPDATA\Docker\settings-store.json"
if (Test-Path $ddSettings) {
    try {
        $dd = Get-Content $ddSettings -Raw | ConvertFrom-Json
        if ($dd.AutoStart -ne $true) {
            $dd.AutoStart = $true
            [System.IO.File]::WriteAllText($ddSettings, ($dd | ConvertTo-Json -Depth 20), [System.Text.Encoding]::UTF8)
            Write-Log "Restored AutoStart=true in Docker Desktop settings"
        }
    } catch {
        Write-Log "WARNING: Could not update Docker Desktop settings: $_"
    }
}

# ── 1. Wait for Docker Engine ──────────────────────────────────────────────────
$TimeoutSec = 300
$Elapsed    = 0
$Interval   = 5

Write-Log "Waiting for Docker Engine (timeout=${TimeoutSec}s)..."
while ($Elapsed -lt $TimeoutSec) {
    $info = & docker info 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Log "Docker Engine ready after ${Elapsed}s"
        break
    }
    Start-Sleep -Seconds $Interval
    $Elapsed += $Interval
}

if ($Elapsed -ge $TimeoutSec) {
    Write-Log "ERROR: Docker Engine did not become ready within ${TimeoutSec}s — aborting"
    exit 1
}

# ── 2. Tear down auto-restarted containers before bringing up fresh ────────────
# Docker Engine's unless-stopped policy restarts containers after boot without
# respecting depends_on or static IP reservations. This races with our compose
# up and causes "Address already in use" on postgres's reserved IP (172.28.0.2).
# Fix: bring everything down cleanly first so compose up gets a blank network.
# docker compose down removes containers + network but NOT volumes — data safe.
Write-Log "Tearing down auto-restarted containers (race-condition prevention)..."
Set-Location $ProjectDir
$downResult = & docker compose down 2>&1
$downExit   = $LASTEXITCODE
$downResult | ForEach-Object { Write-Log "  down: $_" }
if ($downExit -ne 0) {
    Write-Log "WARNING: docker compose down exited $downExit (containers may not have existed yet — continuing)"
}
Write-Log "Teardown complete — starting fresh"

# ── 3. docker compose up -d ────────────────────────────────────────────────────
Write-Log "Running: docker compose up -d"

$result = & docker compose up -d 2>&1
$exit   = $LASTEXITCODE

$result | ForEach-Object { Write-Log "  compose: $_" }

if ($exit -ne 0) {
    Write-Log "ERROR: docker compose up -d exited with code $exit"
    exit $exit
}

Write-Log "docker compose up -d completed successfully"

# ── 4. Wait for all healthchecks to pass ──────────────────────────────────────
Write-Log "Waiting for all container healthchecks..."
$HealthTimeout = 180
$HealthElapsed = 0

while ($HealthElapsed -lt $HealthTimeout) {
    $unhealthy = & docker ps --filter "health=unhealthy" --format "{{.Names}}" 2>&1
    $starting  = & docker ps --filter "health=starting"  --format "{{.Names}}" 2>&1

    if (-not $unhealthy -and -not $starting) {
        Write-Log "All containers healthy after ${HealthElapsed}s"
        break
    }

    if ($starting)  { Write-Log "  Still starting: $($starting -join ', ')" }
    if ($unhealthy) { Write-Log "  Unhealthy: $($unhealthy -join ', ')" }

    Start-Sleep -Seconds 10
    $HealthElapsed += 10
}

if ($HealthElapsed -ge $HealthTimeout) {
    Write-Log "WARNING: Some containers did not become healthy within ${HealthTimeout}s"
    # Not fatal — Docker's restart: unless-stopped will keep retrying
}

Write-Log "WMS auto-start complete"
exit 0
