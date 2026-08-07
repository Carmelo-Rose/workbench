@echo off
REM Build the MatAnyone (general subject) venv for the matting capability.
REM Kept separate from .venv so the shipped RVM human mode keeps its proven
REM torch 2.0.1+cu118 environment untouched.
REM ASCII only: the server console is GBK and mangles UTF-8 comments.
setlocal
set ROOT=D:\hyk_sort\apps\video-toolbox\matting
set VENDOR=%ROOT%\vendor\MatAnyone
set VENV=%ROOT%\.venv-general
set PY=%VENV%\Scripts\python.exe
set PROXY=http://127.0.0.1:7890

if not exist "%VENV%" (
  echo [1/6] create venv
  py -3.10 -m venv "%VENV%"
  if errorlevel 1 exit /b 1
)

echo [2/6] pip tooling
"%PY%" -m pip install --disable-pip-version-check -q --upgrade pip setuptools wheel
if errorlevel 1 exit /b 1

echo [3/6] torch cu118
"%PY%" -m pip install --disable-pip-version-check -q torch==2.0.1+cu118 torchvision==0.15.2+cu118 --index-url https://download.pytorch.org/whl/cu118
if errorlevel 1 exit /b 1

echo [4/6] inference deps
"%PY%" -m pip install --disable-pip-version-check -q "numpy<2" opencv-python pillow einops hydra-core omegaconf huggingface_hub tqdm imageio imageio-ffmpeg
if errorlevel 1 exit /b 1

REM --no-deps on purpose: the upstream pyproject pulls PySide6, gradio,
REM pyqtdarktheme, cchardet, netifaces and friends that only the demo GUI and
REM the training loop need. cchardet in particular has no Python 3.10 wheel.
"%PY%" -m pip install --disable-pip-version-check -q -e "%VENDOR%" --no-deps
if errorlevel 1 exit /b 1

echo [5/6] weights
if not exist "%VENDOR%\pretrained_models" mkdir "%VENDOR%\pretrained_models"
if not exist "%VENDOR%\pretrained_models\matanyone.pth" (
  REM Release assets sit behind objects.githubusercontent.com, which is blocked
  REM here; the local Clash proxy is the way through. -C - so an interrupted
  REM 134 MB pull resumes instead of restarting -- this link drops often enough
  REM that a clean retry from zero is the common case, not the rare one.
  curl -L -C - --retry 5 --retry-delay 5 -x %PROXY% -o "%VENDOR%\pretrained_models\matanyone.pth" https://github.com/pq-yang/MatAnyone/releases/download/v1.0.0/matanyone.pth
  if errorlevel 1 exit /b 1
)

REM MatAnyone's MaskEncoder/PixelEncoder pull torchvision resnet18 + resnet50 on
REM first construction. Left to the first job that means a five-minute stall at
REM ~400 kB/s -- and worse, torch.hub does not verify what it caches, so a
REM truncated download gets renamed into place and then fails on every later
REM load. prewarm_backbones.py fetches both with check_hash=True instead.
echo [6/6] prewarm resnet backbones
"%PY%" "%ROOT%\prewarm_backbones.py"
if errorlevel 1 exit /b 1

echo INSTALL_OK
