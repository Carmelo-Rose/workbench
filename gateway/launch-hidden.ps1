$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$python = "D:\hyk_sort\python\python.exe"
$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (Test-Path $venvPython) {
  $python = $venvPython
}

& $python -m uvicorn app:app --host 0.0.0.0 --port 8100
