@echo off
rem One-time setup for smart-erase env (server: D:\hyk_sort\workspace\video-toolbox\erase).
rem Precondition: ProPainter cloned into this dir; weights reused from D:\ProPainterV14\weights.
rem ASCII only: cmd parses bat files in OEM codepage.
cd /d %~dp0
echo [1/5] venv > install.log
C:\Users\AILAB\AppData\Local\Programs\Python\Python310\python.exe -m venv .venv >> install.log 2>&1
call .venv\Scripts\activate.bat
echo [2/5] pip >> install.log
python -m pip install -q --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple >> install.log 2>&1
echo [3/5] torch cu118 (same combo the packaged tool shipped, proven on this GPU) >> install.log
pip install torch==2.0.1+cu118 torchvision==0.15.2+cu118 -f https://mirrors.aliyun.com/pytorch-wheels/cu118/ -i https://pypi.tuna.tsinghua.edu.cn/simple >> install.log 2>&1
echo [4/5] ProPainter deps >> install.log
pip install -r ProPainter\requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple >> install.log 2>&1
rem torch 2.0.1 is binary-incompatible with numpy 2.x, force downgrade
pip install numpy==1.26.4 -i https://pypi.tuna.tsinghua.edu.cn/simple >> install.log 2>&1
echo [5/5] reuse existing weights >> install.log
copy /Y D:\ProPainterV14\weights\ProPainter.pth ProPainter\weights\ >> install.log 2>&1
copy /Y D:\ProPainterV14\weights\raft-things.pth ProPainter\weights\ >> install.log 2>&1
copy /Y D:\ProPainterV14\weights\recurrent_flow_completion.pth ProPainter\weights\ >> install.log 2>&1
echo INSTALL_DONE >> install.log
