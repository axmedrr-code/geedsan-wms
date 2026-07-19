#Requires -Version 5.1
# NUWACO WMS Post-Reboot Verification Script
# Registered as a Task Scheduler task — fires automatically at logon.
#
# CREDENTIAL POLICY: this script contains NO plaintext passwords.
#   WMS auth  — a temporary test user is created with a random UUID password
#               (generated via bcryptjs inside the backend container), used once,
#               then deleted. No real user credentials are needed or stored.
#   Odoo auth — ADMIN_PASSWORD is read from the running container's environment
#               at test time via `docker exec`. Nothing is hardcoded here.

$ReportFile = "C:\geedsan\geedsan\scripts\post-reboot-report.txt"
$StartTime  = Get-Date

Remove-Item $ReportFile -Force -ErrorAction SilentlyContinue
Add-Content $ReportFile "================================================================"
Add-Content $ReportFile " NUWACO WMS POST-REBOOT VERIFICATION REPORT"
Add-Content $ReportFile " Generated: $StartTime"
Add-Content $ReportFile "================================================================"
Add-Content $ReportFile ""

function Sect { param([string]$t) Add-Content $ReportFile ""; Add-Content $ReportFile "--- $t ---" }
function Row  { param([string]$l) Add-Content $ReportFile $l }

# ── 0. Boot timestamps ─────────────────────────────────────────────────────────
Sect "BOOT TIMESTAMPS"
$bootEvt = Get-WinEvent -FilterHashtable @{ LogName='System'; Id=6005 } -MaxEvents 1 -ErrorAction SilentlyContinue
if ($bootEvt) { Row "Last Windows boot : $($bootEvt.TimeCreated)" }
Row "Verification start: $StartTime"
Row "Running as user   : $env:USERNAME on $env:COMPUTERNAME"

# ── 1. Wait for WMS auto-start task to finish ─────────────────────────────────
Sect "TASK SCHEDULER — WMS AUTO-START"
Row "Waiting for 'NUWACO WMS Auto-Start' task to complete (max 5 min)..."
$wait = 0
do {
    Start-Sleep 10; $wait += 10
    $info = Get-ScheduledTaskInfo -TaskName "NUWACO WMS Auto-Start" -ErrorAction SilentlyContinue
} while ($info -and $info.LastTaskResult -eq 267009 -and $wait -lt 300)

$task = Get-ScheduledTask    -TaskName "NUWACO WMS Auto-Start" -ErrorAction SilentlyContinue
$tinf = Get-ScheduledTaskInfo -TaskName "NUWACO WMS Auto-Start" -ErrorAction SilentlyContinue
if ($task) {
    Row "Task state       : $($task.State)"
    Row "Last run time    : $($tinf.LastRunTime)"
    Row "Last result code : $($tinf.LastTaskResult)  $(if ($tinf.LastTaskResult -eq 0) { '(SUCCESS)' } else { '(FAILURE)' })"
} else {
    Row "ERROR: Task not found"
}

# ── 2. Docker Engine ──────────────────────────────────────────────────────────
Sect "DOCKER ENGINE"
$dInfo = docker info 2>&1
if ($LASTEXITCODE -eq 0) {
    Row "Status           : RUNNING"
    ($dInfo | Select-String "Server Version|Operating System") | ForEach-Object { Row $_.ToString().Trim() }
} else {
    Row "Status           : NOT RUNNING"
    Row ($dInfo -join "; ")
}

# ── 3. Wait for all geedsan containers to reach a stable health state ─────────
Sect "CONTAINER STARTUP WAIT"
$waitHealth = 0
do {
    Start-Sleep 15; $waitHealth += 15
    $starting = docker ps --filter "health=starting" --format "{{.Names}}" 2>&1 | Where-Object { $_ -like "geedsan-*" }
} while ($starting -and $waitHealth -lt 180)
Row "Wait time: ${waitHealth}s"

# ── 4. docker compose ps ─────────────────────────────────────────────────────
Sect "DOCKER COMPOSE PS"
Set-Location "C:\geedsan\geedsan"
docker compose ps 2>&1 | ForEach-Object { Row $_ }

# ── 5. Individual container health ───────────────────────────────────────────
Sect "CONTAINER HEALTH STATUS"
@("geedsan-postgres","geedsan-redis","geedsan-mosquitto",
  "geedsan-backend","geedsan-frontend","geedsan-nginx",
  "geedsan-odoo","geedsan-chirpstack") | ForEach-Object {
    $s = docker inspect $_ --format "{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}" 2>&1
    $r = if ($s -match "running/(healthy|no-healthcheck)") { "PASS" } else { "FAIL" }
    Row "  [$r] $_ : $s"
}

# ── 6. HTTP health endpoints ──────────────────────────────────────────────────
Sect "HTTP HEALTH ENDPOINTS"
@(
    @{ Name="WMS Backend API";  Url="http://localhost:5000/health" },
    @{ Name="WMS Frontend";     Url="http://localhost:3000/" },
    @{ Name="Nginx proxy";      Url="http://localhost:80/health" },
    @{ Name="Odoo";             Url="http://localhost:8069/web/health" },
    @{ Name="ChirpStack";       Url="http://localhost:8080/" }
) | ForEach-Object {
    $ep = $_
    try {
        $r = Invoke-WebRequest -Uri $ep.Url -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop 2>$null
        $ok = $r.StatusCode -ge 200 -and $r.StatusCode -lt 400
        Row "  [$(if ($ok) {'PASS'} else {'FAIL'})] $($ep.Name): HTTP $($r.StatusCode)"
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code -ge 200 -and $code -lt 400) { Row "  [PASS] $($ep.Name): HTTP $code" }
        else { Row "  [FAIL] $($ep.Name): $($_.Exception.Message)" }
    }
}

# ── 7 + 8. WMS auth + Payment API — single temp-user lifecycle block ──────────
# A random UUID password is generated inside the backend container via bcryptjs.
# The temp user exists only for the duration of this block; the finally always
# deletes it. The payment API test runs BEFORE finally so the user is still live.
Sect "WMS AUTH TEST"
$tempEmail    = "hc-$(Get-Date -Format 'yyyyMMddHHmmss')@internal.test"
$tempUsername = "hc_$(Get-Date -Format 'yyyyMMddHHmmss')"
$tempPass     = [System.Guid]::NewGuid().ToString('N')   # random, never logged or stored

try {
    # Hash via bcryptjs inside the backend container (avoids any local dep on bcrypt)
    $hashCmd = "const b=require('bcryptjs');b.hash(process.argv[1],10,(_,h)=>process.stdout.write(h));"
    $hash = (docker exec geedsan-backend node -e $hashCmd $tempPass 2>&1).Trim()
    if (-not $hash -or -not $hash.StartsWith('$2')) {
        throw "bcrypt hash generation failed (got: $hash)"
    }

    # Insert temp user (admin role so all authenticated API tests can run)
    $sql = "INSERT INTO users (username,email,password_hash,full_name,role,is_active) VALUES ('$tempUsername','$tempEmail','$hash','Health Check Temp','admin',true);"
    $ins = docker exec geedsan-postgres psql -h 127.0.0.1 -U geedsan -d geedsan_wms -c $sql 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Could not create temp user: $ins" }

    # Test login
    $loginBody = "{`"username`":`"$tempEmail`",`"password`":`"$tempPass`"}"
    $loginResp = Invoke-RestMethod -Uri "http://localhost:5000/api/auth/login" `
        -Method Post -Body $loginBody -ContentType "application/json" -TimeoutSec 15

    if ($loginResp.accessToken) {
        Row "  [PASS] WMS Auth: temp-user login succeeded — JWT issued (auth pipeline OK)"
        $script:wmsToken = $loginResp.accessToken
    } else {
        Row "  [FAIL] WMS Auth: login returned no accessToken (response: $($loginResp | ConvertTo-Json -Compress))"
    }

    # ── 8. WMS Payment API (runs here, while temp user still exists in DB) ────
    Sect "WMS PAYMENT API"
    if ($script:wmsToken) {
        try {
            $resp = Invoke-RestMethod -Uri "http://localhost:5000/api/payments" `
                -Headers @{ Authorization = "Bearer $($script:wmsToken)" } -TimeoutSec 10
            Row "  [PASS] Payment API responded (records=$(if ($resp.data) { $resp.data.Count } else { 'ok' }))"
        } catch {
            $code = $_.Exception.Response.StatusCode.value__
            if ($code -eq 200 -or $code -eq 304) { Row "  [PASS] Payment API HTTP $code" }
            else { Row "  [FAIL] Payment API: $($_.Exception.Message)" }
        }
    } else {
        Row "  [SKIP] No token — auth test failed"
    }

} catch {
    Row "  [FAIL] WMS Auth: $($_.Exception.Message)"
    Sect "WMS PAYMENT API"
    Row "  [SKIP] Auth failed — skipping payment test"
} finally {
    # Delete temp user regardless of any outcome above
    $del = "DELETE FROM users WHERE email = '$tempEmail';"
    docker exec geedsan-postgres psql -h 127.0.0.1 -U geedsan -d geedsan_wms -c $del 2>&1 | Out-Null
    Row "  Temp user removed"
}

# ── 9. Odoo auth + Invoicing Dashboard ───────────────────────────────────────
# Password is read from the Odoo container's runtime environment — not hardcoded.
Sect "ODOO DASHBOARD TEST"
try {
    $odooAdminPw = (docker exec geedsan-odoo sh -c 'printf "%s" "$ADMIN_PASSWORD"' 2>&1).Trim()
    if (-not $odooAdminPw) { throw "ADMIN_PASSWORD env var is empty or container not running" }

    $authBody = [PSCustomObject]@{
        jsonrpc = "2.0"; id = 1; method = "call"
        params  = [PSCustomObject]@{ db = "odoo"; login = "admin"; password = $odooAdminPw }
    } | ConvertTo-Json -Depth 5

    $odooAuth = Invoke-RestMethod -Uri "http://localhost:8069/web/session/authenticate" `
        -Method Post -ContentType "application/json" -Body $authBody `
        -SessionVariable odooSess -TimeoutSec 15

    $uid = $odooAuth.result.uid
    Row "  Odoo auth: uid=$uid"

    if ($uid) {
        $dashBody = '{"jsonrpc":"2.0","id":2,"method":"call","params":{"model":"spreadsheet.dashboard","method":"get_readonly_dashboard","args":[[1]],"kwargs":{}}}'
        $dashResp = Invoke-RestMethod `
            -Uri "http://localhost:8069/web/dataset/call_kw/spreadsheet.dashboard/get_readonly_dashboard" `
            -Method Post -ContentType "application/json" -Body $dashBody `
            -WebSession $odooSess -TimeoutSec 15
        if ($dashResp.error) {
            Row "  [FAIL] Invoicing Dashboard: $($dashResp.error.data.message)"
        } else {
            Row "  [PASS] Invoicing Dashboard: loaded OK (no crash)"
        }
    } else {
        Row "  [FAIL] Odoo auth failed (uid=$uid)"
    }
} catch {
    Row "  [FAIL] Odoo: $($_.Exception.Message)"
}

# ── 10. MQTT connectivity ─────────────────────────────────────────────────────
Sect "MQTT CONNECTIVITY"
# MQTT connect/subscribe logs are emitted at container startup — search full log,
# not just --tail N, since the backend may have logged many lines since it started.
$mqttLog = docker logs geedsan-backend 2>&1 | Where-Object { $_ -match "MQTT|mqtt|mosquitto|Subscribed" }
if ($mqttLog) {
    Row "  [PASS] MQTT messages found in backend log:"
    $mqttLog | Select-Object -First 5 | ForEach-Object { Row "    $_" }
} else {
    Row "  [FAIL] No MQTT log entries found in backend (checked full log)"
}

# ── 11. Odoo sync queue ───────────────────────────────────────────────────────
Sect "ODOO SYNC QUEUE"
$syncQ = docker exec geedsan-postgres psql -h 127.0.0.1 -U geedsan -d geedsan_wms `
    -c "SELECT status, COUNT(*) FROM odoo_sync_queue GROUP BY status;" 2>&1
$syncQ | ForEach-Object { Row "  $_" }

# ── 12. IP assignment sanity check ───────────────────────────────────────────
Sect "NETWORK IP ASSIGNMENTS"
$netInspect = docker network inspect geedsan_geedsan-network --format "{{range .Containers}}  {{.Name}}: {{.IPv4Address}}{{println}}{{end}}" 2>&1
$netInspect | ForEach-Object {
    $line = $_.Trim()
    if ($line) {
        # Flag if any container other than postgres is at .2 (the reserved postgres IP)
        $bad = ($line -notmatch "geedsan-postgres") -and ($line -match "172\.28\.0\.2/")
        Row "  $(if ($bad) {'[FAIL]'} else {'[PASS]'}) $line"
    }
}

# ── 13. WMS auto-start log ────────────────────────────────────────────────────
Sect "WMS AUTO-START LOG (last 25 lines)"
$logFile = "C:\geedsan\geedsan\scripts\wms-autostart.log"
if (Test-Path $logFile) {
    Get-Content $logFile | Select-Object -Last 25 | ForEach-Object { Row "  $_" }
} else {
    Row "  Log not found: $logFile"
}

# ── 14. Overall verdict ───────────────────────────────────────────────────────
Sect "FINAL VERDICT"
$elapsed   = [int]((Get-Date) - $StartTime).TotalSeconds
$report    = Get-Content $ReportFile
$failCount = ($report | Select-String "\[FAIL\]").Count
$passCount = ($report | Select-String "\[PASS\]").Count

Row ""
Row "Verification completed in: ${elapsed}s"
Row "PASS: $passCount   FAIL: $failCount"
Row ""
if ($failCount -eq 0) {
    Row "OVERALL RESULT: *** PASS *** — All services started automatically after reboot"
} else {
    Row "OVERALL RESULT: *** FAIL *** — $failCount check(s) failed (see [FAIL] lines above)"
}

Write-Host "Verification complete. Report: $ReportFile"
