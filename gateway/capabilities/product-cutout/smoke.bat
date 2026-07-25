@echo off
setlocal
if "%~1"=="" (echo Usage: smoke.bat C:\path\to\copied-fixture.jpg & exit /b 2)
set "OUT=%TEMP%\product-cutout-smoke-%RANDOM%"
mkdir "%OUT%"
"%~dp0.venv\Scripts\python.exe" "%~dp0toolbox_run.py" --input "%~1" --output-dir "%OUT%" --params "{}"
if errorlevel 1 exit /b %errorlevel%
echo Smoke output: %OUT%
