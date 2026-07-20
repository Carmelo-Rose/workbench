@echo off
rem video-toolbox gateway launcher (AILAB server). ASCII only: cmd parses bat in OEM codepage.
cd /d %~dp0
call .venv\Scripts\activate.bat
python -m uvicorn app:app --host 0.0.0.0 --port 8100
