@echo off
setlocal
set "ROOT=%~dp0"
py -3.10 -m venv "%ROOT%.venv"
"%ROOT%.venv\Scripts\python.exe" -m pip install --upgrade pip
"%ROOT%.venv\Scripts\pip.exe" install -r "%ROOT%requirements.txt"
set "PRODUCT_CUTOUT_MODEL_ID=ZhengPeng7/BiRefNet_HR-matting"
set "PRODUCT_CUTOUT_MODEL_REVISION=5d6b6f8adcb5b417c871b1d84ceaae9871355b7f"
"%ROOT%.venv\Scripts\python.exe" -c "from huggingface_hub import snapshot_download; snapshot_download('%PRODUCT_CUTOUT_MODEL_ID%', revision='%PRODUCT_CUTOUT_MODEL_REVISION%', local_dir=r'%ROOT%model', local_dir_use_symlinks=False)"
"%ROOT%.venv\Scripts\python.exe" -c "import hashlib,pathlib; p=next(pathlib.Path(r'%ROOT%model').rglob('*.safetensors')); pathlib.Path(r'%ROOT%model.sha256').write_text(hashlib.sha256(p.read_bytes()).hexdigest(), encoding='ascii'); print(p)"
