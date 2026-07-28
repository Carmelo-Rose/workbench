@echo off
rem Restart gateway: stop uvicorn, then relaunch detached. ASCII only: cmd parses bat in OEM codepage.
rem
rem The relaunch goes through WMI Win32_Process.Create. It used to call
rem "schtasks /run /tn video-toolbox-gateway", but that task was never registered on the AILAB
rem host, so this script could stop the gateway and never bring it back. Start-Process is no
rem substitute either: a process launched that way from an SSH session dies with the session.
rem Win32_Process.Create is owned by the WMI service and survives. wmic is likewise gone, so the
rem stop half runs through CIM as well.
cd /d %~dp0

powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'uvicorn app:app' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
rem Start-Sleep rather than timeout: timeout refuses to run when stdin is redirected, which is
rem exactly what happens when this script is driven over SSH.
powershell -NoProfile -Command "Start-Sleep -Seconds 3"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='cmd.exe /c %~dp0start.bat'; CurrentDirectory='%~dp0'} | Out-Null"
powershell -NoProfile -Command "Start-Sleep -Seconds 15"

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { 'gateway back up: ' + (Invoke-WebRequest 'http://127.0.0.1:8100/health' -UseBasicParsing -TimeoutSec 10).Content } catch { 'gateway did NOT come back -- check start.bat manually' }"
