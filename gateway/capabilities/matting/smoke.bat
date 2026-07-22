@echo off
rem Direct smoke test for toolbox_run.py (bypasses gateway). ASCII only.
cd /d %~dp0
.venv\Scripts\python.exe toolbox_run.py --input test_input.mp4 --output-dir smoke_out --params "{\"background\":\"white\"}"
echo SMOKE_EXIT=%ERRORLEVEL%
