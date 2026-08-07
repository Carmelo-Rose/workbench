"""量 RVM 在采样帧上的 alpha 覆盖率——toolbox_run.py 里 HUMAN_COVERAGE_THRESHOLD
那个数就是这么定出来的，不是拍脑袋。

2026-08-07 实测（各取 10 帧均匀采样）：
  person_test.mp4（真人）          mean 0.154
  erased.mp4（仓鼠，画面里没有人）  mean 0.0076
  test_input.mp4（彩条，没有主体）  mean 0.00016

换了新素材、或者怀疑 auto 判反了的时候，先跑这个看数，再决定动不动阈值。

用法（在 matting 的 .venv 里跑）：
  .venv\\Scripts\\python.exe probe_coverage.py <video> [<video> ...]
"""
import sys
from pathlib import Path

import cv2
import numpy as np
import torch

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))
from model import MattingNetwork  # noqa: E402

SAMPLES = 10


def load_model():
    net = MattingNetwork(variant="mobilenetv3", refiner="deep_guided_filter")
    net.load_state_dict(torch.load(str(BASE / "weights" / "rvm_mobilenetv3.pth"), map_location="cpu"))
    net = net.eval()
    if torch.cuda.is_available():
        net = net.cuda()
    return net


def probe(net, path):
    cap = cv2.VideoCapture(str(path))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    ratio = min(1.0, 512 / max(w, h))
    device = next(net.parameters()).device
    idxs = np.linspace(0, max(total - 1, 0), min(SAMPLES, max(total, 1)), dtype=int)
    covs = []
    with torch.no_grad():
        for i in idxs:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(i))
            ok, frame = cap.read()
            if not ok:
                continue
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            src = torch.from_numpy(rgb).to(device, torch.float32).div(255)
            src = src.permute(2, 0, 1).unsqueeze(0)
            # fresh recurrent state per sample: we want "is there a subject in
            # this frame", not a temporally smoothed answer
            _, pha, *_ = net(src, None, None, None, None, downsample_ratio=ratio)
            a = pha[0, 0].clamp(0, 1).cpu().numpy()
            covs.append(float((a > 0.5).mean()))
    cap.release()
    return total, (w, h), covs


def main():
    net = load_model()
    for p in sys.argv[1:]:
        total, size, covs = probe(net, p)
        if not covs:
            print(f"{p}: no readable frames")
            continue
        print(
            f"{Path(p).name}  {size[0]}x{size[1]}  {total}f\n"
            f"  per-sample coverage: {['%.5f' % c for c in covs]}\n"
            f"  max={max(covs):.5f}  mean={sum(covs)/len(covs):.5f}"
        )


if __name__ == "__main__":
    main()
