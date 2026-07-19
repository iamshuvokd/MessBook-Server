# Starts the local dev MySQL instance used by mess_manager_server.
#
# This is a project-local, self-contained instance -- separate from any
# other MySQL install on this machine -- so it never needs elevated
# privileges or touches anything else. It does NOT auto-start on reboot;
# run this script (or the Start-Process line below) again after restarting
# the machine.
#
# Root cause of the earlier "Can't create UNDO tablespace" failures: this
# had nothing to do with stale files or locked processes (both were ruled
# out with a from-scratch data directory) -- it was specific to the D:
# drive. Moving the data directory to C:\ fixed it immediately, on both
# MySQL 8.0 and 8.4. Data directory below is intentionally on C:.

$mysqld = "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqld.exe"
$dataDir = "C:\temp\mysql-test-data"
$logFile = "$dataDir\mysqld.log"
$port = 3308

if (-not (Test-Path $dataDir)) {
    Write-Error "Data directory $dataDir not found -- this expects the instance set up in the 2026-07-16 session (see MESS_MANAGER_ONLINE_PLAN.md). Run --initialize-insecure first if starting fresh."
    exit 1
}

Start-Process -FilePath $mysqld -ArgumentList "--datadir=`"$dataDir`"", "--port=$port", "--log-error=`"$logFile`"" -WorkingDirectory $dataDir -WindowStyle Hidden
Start-Sleep -Seconds 3
Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object LocalPort, State, OwningProcess
Write-Output "MySQL dev instance should now be listening on 127.0.0.1:$port -- matches mess_manager_server/.env's DB_HOST/DB_PORT."
