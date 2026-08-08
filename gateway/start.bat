@echo off
rem video-toolbox gateway launcher (AILAB server). ASCII only: cmd parses bat in OEM codepage.
cd /d %~dp0
rem Load private gateway settings before starting uvicorn. Keep .env out of source control.
if exist .env (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if not "%%A"=="" set "%%A=%%B"
  )
)
call .venv\Scripts\activate.bat
rem pythonw keeps the gateway off the interactive desktop; the launcher can exit cleanly.
set "PYTHONW=pythonw.exe"
if exist "D:\hyk_sort\python\pythonw.exe" set "PYTHONW=D:\hyk_sort\python\pythonw.exe"
start "" /b "%PYTHONW%" -m uvicorn app:app --host 0.0.0.0 --port 8100
