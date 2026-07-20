@echo off
rem Direct smoke test for toolbox_run.py (bypasses gateway). ASCII only.
cd /d %~dp0
.venv\Scripts\python.exe toolbox_run.py --input test_input.mp4 --output-dir smoke_out --params "{\"regions\":[{\"x\":0.6,\"y\":0.55,\"w\":0.3,\"h\":0.35}]}"
echo SMOKE_EXIT=%ERRORLEVEL%
