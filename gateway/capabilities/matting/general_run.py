"""通用主体抠像执行脚本（MatAnyone），由 toolbox_run.py 以子进程方式调用。

单独一个文件、单独一个 venv（`.venv-general`）的原因：MatAnyone 的依赖树与
RVM 那套没有交集，而 RVM 的 `.venv` 是已经上线跑了几个月的环境，没有理由为了
加一个模式去动它。两个模式之间用磁盘上的 PNG 序列交接，编码与音轨合并仍然只
有 toolbox_run.py 一个出口。

契约（不直接对网关，只对 toolbox_run.py）：
  .venv-general/Scripts/python.exe general_run.py
      --input <视频> --mask <首帧掩码PNG> --frames-dir <PNG输出目录>
      --background <B,G,R> [--max-internal-size N] [--warmup N]
  stdout：
    STEP <已完成帧> <总帧数>   —— 供调用方折算成全局进度，避免两处各算一遍
    COVERAGE <0-1 浮点>        —— 全片平均 alpha 覆盖率，供调用方做空抠守卫

许可提醒：MatAnyone 采用 NTU S-Lab License 1.0（非商用）。启用 general 模式
等于把这个约束带进产物链路，详见 gateway/README.md 的「模型许可」一节。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = Path(__file__).resolve().parent
VENDOR_DIR = BASE_DIR / "vendor" / "MatAnyone"
CKPT_PATH = VENDOR_DIR / "pretrained_models" / "matanyone.pth"


def build_processor(device):
    from matanyone.inference.inference_core import InferenceCore
    from matanyone.utils.get_default_model import get_matanyone_model

    network = get_matanyone_model(str(CKPT_PATH), device)
    return InferenceCore(network, cfg=network.cfg)


def load_first_frame_mask(mask_path: Path, size_hw, device):
    """把 BiRefNet 的软 matte 二值化成 MatAnyone 要的首帧掩码。

    官方脚本对掩码做 dilate/erode，而 `gen_dilate` 把「非 0」全当前景——软 matte
    的抗锯齿边缘有大量极小非零值，直接喂进去会把掩码撑开一圈。所以先按 0.5 二值
    化（README 里 auxiliary-free 路线用的也是「二值化成伪掩码」），再交给模型。
    """
    import cv2
    import numpy as np
    import torch
    from PIL import Image

    raw = np.array(Image.open(mask_path).convert("L"))
    if raw.shape != tuple(size_hw):
        raw = cv2.resize(raw, (size_hw[1], size_hw[0]), interpolation=cv2.INTER_NEAREST)
    binary = (raw >= 128).astype(np.float32) * 255.0
    coverage = float((binary > 0).mean())
    return torch.from_numpy(binary).float().to(device), coverage


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--mask", required=True)
    parser.add_argument("--frames-dir", required=True)
    parser.add_argument("--background", required=True, help="B,G,R 三个 0-255 整数")
    parser.add_argument("--warmup", type=int, default=10)
    parser.add_argument(
        "--max-internal-size",
        type=int,
        default=-1,
        help="短边超过该值时模型内部降采样推理再还原；-1 表示原分辨率",
    )
    args = parser.parse_args()

    import cv2
    import numpy as np
    import torch

    if not CKPT_PATH.is_file():
        print(f"缺少 MatAnyone 权重：{CKPT_PATH}", flush=True)
        return 2

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    processor = build_processor(device)
    if args.max_internal_size > 0:
        processor.max_internal_size = args.max_internal_size

    cap = cv2.VideoCapture(str(args.input))
    if not cap.isOpened():
        print("无法读取视频", flush=True)
        return 2
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    mask, mask_coverage = load_first_frame_mask(Path(args.mask), (height, width), device)
    print(f"MASKCOVERAGE {mask_coverage:.6f}", flush=True)

    bgr = np.array([int(v) for v in args.background.split(",")], dtype=np.float32)
    background = np.full((height, width, 3), bgr, dtype=np.float32)

    frames_dir = Path(args.frames_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)

    coverage_sum = 0.0
    idx = 0

    # 上游的 inference_matanyone.py 把整个推理包在 autocast 里跑（模型内部好几处
    # 显式 safe_autocast(enabled=False) 就是在假定外面开着）。这里用它自己的
    # helper 保持一致，别自己另起一套混合精度策略。
    from matanyone.utils.device import safe_autocast

    with torch.inference_mode(), safe_autocast():
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            image = (
                torch.from_numpy(rgb).permute(2, 0, 1).float().div(255).to(device)
            )

            if idx == 0:
                # 首帧：先把掩码编码进记忆，再按官方做法把第一帧重复若干次预热，
                # 让 alpha 在开始传播前先收敛——省掉这步，前几帧边缘会明显发虚。
                processor.step(image, mask, objects=[1])
                for _ in range(max(args.warmup, 0) + 1):
                    output_prob = processor.step(image, first_frame_pred=True)
            else:
                output_prob = processor.step(image)

            alpha = processor.output_prob_to_mask(output_prob)
            pha = alpha.clamp(0, 1).float().cpu().numpy()[..., None]
            coverage_sum += float((pha[..., 0] > 0.5).mean())

            # MatAnyone 只出 alpha，不像 RVM 那样额外回归一张去污的前景色，
            # 所以这里拿原始像素合成：边缘半透明处会残留一点原背景的颜色溢出，
            # 这是该模型的固有取舍，不是合成写错了。
            composite = frame.astype(np.float32) * pha + background * (1 - pha)
            cv2.imwrite(
                str(frames_dir / f"{idx:06d}.png"),
                composite.clip(0, 255).astype(np.uint8),
                [cv2.IMWRITE_PNG_COMPRESSION, 1],
            )

            idx += 1
            print(f"STEP {idx} {total}", flush=True)

    cap.release()
    if idx == 0:
        print("视频没有可读取的帧", flush=True)
        return 2

    print(f"COVERAGE {coverage_sum / idx:.6f}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
