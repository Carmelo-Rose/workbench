"""预热 MatAnyone 需要的 torchvision 骨干权重，带哈希校验。

为什么需要这个脚本，而不是让它第一次跑任务时自己下：

1. 慢。这台机器到 download.pytorch.org 大约 400 kB/s，两个骨干加起来约 140 MB，
   第一次 general 任务会在「检测首帧主体」之后干等五六分钟，看上去像卡死。
2. 不可靠。`model_zoo.load_url` 默认 `check_hash=False`，下载被中途截断也照样把
   临时文件重命名进缓存；下一次加载直接炸在
   `_pickle.UnpicklingError: unpickling stack underflow`，而且**每次都炸**，因为
   坏文件已经算缓存命中了。实测踩过：resnet18 下到 41.4M/44.7M 断掉。
3. torch.hub 自己的下载器在这台机器上还会**卡死**——连着两次重试都停在 0 字节，
   而同一个 URL 用 curl 拉稳定有 400 kB/s。所以这里不走 torch.hub 下载，只借用它
   的缓存目录约定，下载和校验都自己来。

文件名里 `-5c106cde` 那截就是 sha256 前缀，torchvision 用它做缓存键，正好拿来当
校验值，不用另外维护一张哈希表。

用法：<任意装了 torch 的 venv>/python.exe prewarm_backbones.py
torch hub 缓存按用户存、不按 venv 存，所以用哪个解释器跑都一样。
"""

from __future__ import annotations

import hashlib
import shutil
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

# MatAnyone 的 MaskEncoder / PixelEncoder 在构造时就会拉这两个
# （matanyone/model/big_modules.py 里的 resnet.resnet18 / resnet50）。
BACKBONE_URLS = (
    "https://download.pytorch.org/models/resnet18-5c106cde.pth",
    "https://download.pytorch.org/models/resnet50-19c8e357.pth",
)
ATTEMPTS = 3
CHUNK = 1 << 20
# 单次读超时。卡死那次是连接建起来了但一个字节都不来，超时比无限等好排查。
TIMEOUT = 60


def expected_prefix(name: str) -> str:
    """从 `resnet18-5c106cde.pth` 里取出 `5c106cde`。"""
    return name.split("-", 1)[1].rsplit(".", 1)[0]


def digest_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url: str, dest: Path) -> None:
    """下到同目录的 .part 再原子改名，中途断掉不会留下一个「看着像成功」的缓存。"""
    staged = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=TIMEOUT) as resp, staged.open("wb") as out:
        shutil.copyfileobj(resp, out, CHUNK)
    staged.replace(dest)


def main() -> int:
    from torch.hub import get_dir

    checkpoints = Path(get_dir()) / "checkpoints"
    checkpoints.mkdir(parents=True, exist_ok=True)

    for url in BACKBONE_URLS:
        name = Path(urlparse(url).path).name
        dest = checkpoints / name
        want = expected_prefix(name)

        if dest.is_file() and digest_of(dest).startswith(want):
            print(f"SKIP {name}（已存在且校验通过）", flush=True)
            continue

        for attempt in range(1, ATTEMPTS + 1):
            try:
                fetch(url, dest)
                got = digest_of(dest)
                if got.startswith(want):
                    print(f"OK {name} ({dest.stat().st_size} bytes)", flush=True)
                    break
                raise ValueError(f"sha256 前缀不符：期望 {want}，实得 {got[:8]}")
            except Exception as exc:
                # 校验失败的文件必须删掉，否则下次被当成缓存命中直接返回坏数据
                dest.unlink(missing_ok=True)
                dest.with_suffix(dest.suffix + ".part").unlink(missing_ok=True)
                print(f"第 {attempt}/{ATTEMPTS} 次失败 {name}：{exc}", flush=True)
                if attempt == ATTEMPTS:
                    print(f"FAILED {name}", flush=True)
                    return 1

    print("PREWARM_OK", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
