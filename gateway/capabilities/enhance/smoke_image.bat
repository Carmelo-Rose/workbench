@echo off
rem Direct smoke test for toolbox_run_image.py (bypasses gateway). ASCII only.
cd /d %~dp0
.venv\Scripts\python.exe toolbox_run_image.py --input test_input.jpg --output-dir smoke_img --params "{\"outscale\":4,\"face_enhance\":true,\"denoise\":0.5}"
echo SMOKE_IMAGE_EXIT=%ERRORLEVEL%
