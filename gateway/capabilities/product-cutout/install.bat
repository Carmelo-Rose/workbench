@echo off
setlocal
set "ROOT=%~dp0"
py -3.11 -m venv "%ROOT%.venv"
"%ROOT%.venv\Scripts\python.exe" -m pip install --upgrade pip
"%ROOT%.venv\Scripts\pip.exe" install -r "%ROOT%requirements.txt"
echo Install the approved BiRefNet_HR-matting revision into %ROOT%model before enabling production traffic.
