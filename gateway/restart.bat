@echo off
rem Restart gateway: kill running uvicorn, then relaunch via scheduled task. ASCII only.
wmic process where "name='python.exe' and commandline like '%%uvicorn%%app:app%%'" call terminate >nul 2>&1
timeout /t 2 /nobreak >nul
schtasks /run /tn video-toolbox-gateway
