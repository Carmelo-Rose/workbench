@echo off
rem One-time setup for video_matting env (server: D:\hyk_sort\workspace\video-toolbox\matting).
rem Precondition: model\*.py vendored from PeterL1n/RobustVideoMatting and
rem weights\rvm_mobilenetv3.pth downloaded (release CDN is GFW-blocked here;
rem use the local Clash proxy at 127.0.0.1:7890 to fetch it).
rem ASCII only: cmd parses bat files in OEM codepage.
cd /d %~dp0
echo [1/3] venv > install.log
C:\Users\AILAB\AppData\Local\Programs\Python\Python310\python.exe -m venv .venv >> install.log 2>&1
call .venv\Scripts\activate.bat
echo [2/3] pip >> install.log
python -m pip install -q --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple >> install.log 2>&1
echo [3/3] torch cu118 (same combo as erase/enhance, proven on this GPU) + light deps >> install.log
pip install torch==2.0.1+cu118 torchvision==0.15.2+cu118 -f https://mirrors.aliyun.com/pytorch-wheels/cu118/ -i https://pypi.tuna.tsinghua.edu.cn/simple >> install.log 2>&1
pip install numpy==1.26.4 opencv-python==4.10.0.84 imageio-ffmpeg -i https://pypi.tuna.tsinghua.edu.cn/simple >> install.log 2>&1
echo INSTALL_DONE >> install.log
