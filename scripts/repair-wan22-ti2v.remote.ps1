$ErrorActionPreference = "Stop"
$root = "D:\ai\ComfyUINeo50_250719\ComfyUINeo50_250719\ComfyUINeo50"
$target = Join-Path $root "models\diffusion_models\wan2.2_ti2v_5B_fp16.safetensors"
$url = "https://www.modelscope.cn/models/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/master/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors"
$expectedBytes = 9999658848
$expectedSha256 = "456F901338BD9EADBDED3828B819109A9B68E8A525CA5CF8D0049A69FCFECA1E"
$log = "D:\hyk_sort\prod-data\comfyui-neo\logs\wan2.2-repair.log"
$downloadUrl = $url

function Write-Log([string]$message) {
  "[$(Get-Date -Format o)] $message" | Out-File -LiteralPath $log -Append -Encoding utf8
}

try {
  $head = Invoke-WebRequest -Uri $url -Method Head -MaximumRedirection 10 -UseBasicParsing -TimeoutSec 30
  $headLength = $head.Headers["Content-Length"]
  Write-Log "Fixed source HEAD: status=$($head.StatusCode) contentLength=$headLength url=$url"
} catch {
  Write-Log "Fixed source HEAD probe failed; continuing with ModelScope URL: $($_.Exception.Message)"
}

Write-Log "Repair started. Current bytes: $((Get-Item -LiteralPath $target -ErrorAction SilentlyContinue).Length)"
$length = (Get-Item -LiteralPath $target -ErrorAction SilentlyContinue).Length
if ($length -gt $expectedBytes) {
  Remove-Item -LiteralPath $target -Force
  $length = 0
}

function Invoke-AriaDownload([bool]$continue) {
  $continueArg = if ($continue) { "true" } else { "false" }
  Write-Log "Starting aria2 download; continue=$continueArg"
  & aria2c.exe `
    --continue=$continueArg `
    --check-integrity=false `
    --all-proxy= `
    --max-connection-per-server=16 `
    --split=16 `
    --min-split-size=10M `
    --file-allocation=none `
    --allow-overwrite=true `
    --auto-file-renaming=false `
    --dir (Split-Path -Parent $target) `
    --out (Split-Path -Leaf $target) `
    $downloadUrl
  if ($LASTEXITCODE -ne 0) { throw "aria2 download failed with exit code $LASTEXITCODE" }
}

function Test-SafeTensors([string]$path, [int64]$fileLength) {
  $stream = [IO.File]::OpenRead($path)
  try {
    $sizeBytes = New-Object byte[] 8
    if ($stream.Read($sizeBytes, 0, 8) -ne 8) { return $false }
    $headerLength = [BitConverter]::ToInt64($sizeBytes, 0)
    if ($headerLength -lt 2 -or $headerLength -gt 104857600) { return $false }
    $headerBytes = New-Object byte[] $headerLength
    if ($stream.Read($headerBytes, 0, $headerLength) -ne $headerLength) { return $false }
    $header = ([Text.Encoding]::UTF8.GetString($headerBytes) | ConvertFrom-Json)
    $maxEnd = [int64]0
    foreach ($property in $header.PSObject.Properties) {
      if ($property.Name -eq "__metadata__") { continue }
      $offsets = $property.Value.data_offsets
      if ($offsets -and $offsets.Count -eq 2) {
        $end = [int64]$offsets[1]
        if ($end -gt $maxEnd) { $maxEnd = $end }
      }
    }
    return (8 + $headerLength + $maxEnd -le $fileLength)
  } catch {
    return $false
  } finally {
    $stream.Dispose()
  }
}

function Get-ModelSha256([string]$path, [int64]$fileLength) {
  if ($fileLength -ne $expectedBytes) { return $null }
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToUpperInvariant()
}

$length = (Get-Item -LiteralPath $target -ErrorAction SilentlyContinue).Length
if ($length -ne $expectedBytes) {
  Invoke-AriaDownload($true)
  $length = (Get-Item -LiteralPath $target).Length
}
$sha256 = Get-ModelSha256 $target $length
if ($length -ne $expectedBytes -or -not (Test-SafeTensors $target $length) -or $sha256 -ne $expectedSha256) {
  Write-Log "Model validation failed; restarting full download (bytes=$length sha256=$sha256)"
  Remove-Item -LiteralPath $target -Force
  Remove-Item -LiteralPath "$target.aria2" -Force -ErrorAction SilentlyContinue
  Invoke-AriaDownload($false)
  $length = (Get-Item -LiteralPath $target).Length
  $sha256 = Get-ModelSha256 $target $length
}
if ($length -ne $expectedBytes -or -not (Test-SafeTensors $target $length) -or $sha256 -ne $expectedSha256) {
  throw "Wan model verification failed: bytes=$length sha256=$sha256"
}
Write-Log "Wan model verified: bytes=$length sha256=$sha256"

Write-Log "Wan model verified; starting ComfyUI"
Start-ScheduledTask -TaskName "Codex-ComfyUI-ProductStack"
$ready = $false
for ($i = 0; $i -lt 36; $i++) {
  Start-Sleep -Seconds 5
  try {
    $stats = Invoke-RestMethod -Uri "http://192.168.1.198:8188/system_stats" -TimeoutSec 5
    $node = Invoke-RestMethod -Uri "http://192.168.1.198:8188/object_info/Wan22ImageToVideoLatent" -TimeoutSec 5
    if ($stats.system -and $node) { $ready = $true; break }
  } catch { }
}
if (-not $ready) { throw "ComfyUI did not become ready after model repair" }
Write-Log "ComfyUI ready after model repair"
