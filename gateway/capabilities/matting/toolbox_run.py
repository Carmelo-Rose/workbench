"""视频抠像换背景调度脚本（部署于服务机 D:\\hyk_sort\\apps\\video-toolbox\\matting\\）。

两种模式，同一个产物出口：

  human   —— RVM（Robust Video Matting，mobilenetv3 递归时序模型）。只认人像，
             但轻快、时序稳，是有真人时的首选。
  general —— BiRefNet 抠首帧拿掩码 → MatAnyone 记忆传播全片。主体类别无关，
             动物、商品、任意物体都能抠。

  auto（默认）先用 RVM 在全片均匀采样探一遍，有人走 human，没人转 general。
  这条分支是为了修一个真实事故：一段仓鼠视频喂进只认人的 RVM，模型正确地判定
  「没有人」输出空前景，合成结果是一整片纯背景色，而任务还报成功。

网关契约：
  .venv/Scripts/python.exe toolbox_run.py --input <视频> --output-dir <产物目录> --params <JSON>
  params: {"background": "white", "mode": "auto"}
  stdout 的「PROGRESS <0-100> <阶段>」驱动前端进度条。

模型许可（重要）：RVM 是 GPL-3.0，MatAnyone 是 NTU S-Lab License 1.0（非商用，
商用需另行取得作者授权）。详见 gateway/README.md 的「模型许可」一节。

model/ 是 vendor 进来的 PeterL1n/RobustVideoMatting 官方模型定义，权重
weights/rvm_mobilenetv3.pth 是官方 release 资产，二者均未改动。MatAnyone 同样
以未改动的形式 vendor 在 vendor/MatAnyone/，跑在独立的 .venv-general 里。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# 直跑时控制台可能是 GBK，转发子进程输出会因替换字符炸掉；统一成 UTF-8 自洽
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = Path(__file__).resolve().parent
WEIGHTS_PATH = BASE_DIR / "weights" / "rvm_mobilenetv3.pth"
GENERAL_PYTHON = BASE_DIR / ".venv-general" / "Scripts" / "python.exe"
GENERAL_SCRIPT = BASE_DIR / "general_run.py"

MODES = ("auto", "human", "general")

# auto 判据。取自实测（2026-08-07，全片均匀采样 10 帧、每帧独立跑 RVM 后的平均
# 覆盖率）：真人视频 0.154，仓鼠视频 0.0076，纯色条测试图 0.00016。真人与非人
# 之间差约 20 倍，阈值卡在 0.05 时真人有 3 倍余量、仓鼠差 6.5 倍。
#
# 之所以往高了压：两个方向的误判代价不对称。把真人误判成 general，MatAnyone
# 一样抠得出来，只是慢一点；把非人误判成 human，出来的就是一整片背景色——正是
# 这个能力出过的那次事故。所以宁可多走 general。
HUMAN_COVERAGE_THRESHOLD = 0.05
PROBE_SAMPLES = 10

# 空抠守卫。首帧掩码覆盖率低于此值说明 BiRefNet 压根没找到主体，没必要再花几分钟
# 跑传播；产物覆盖率低于此值说明这一趟白跑了，宁可明确失败也不要交一段空白视频。
# 仓鼠那次 RVM 的全片平均覆盖率是 0.0076，落在这条线下面，会被拦住。
MIN_MASK_COVERAGE = 0.01
MIN_OUTPUT_COVERAGE = 0.01

# 背景色名到 BGR（cv2 通道序）的映射；也接受 "#rrggbb" 十六进制。
NAMED_COLORS_BGR = {
    "white": (255, 255, 255),
    "black": (0, 0, 0),
    "green": (0, 177, 64),
    "greenscreen": (0, 177, 64),
    "blue": (255, 0, 0),
    "bluescreen": (255, 0, 0),
    "gray": (128, 128, 128),
    "grey": (128, 128, 128),
    "red": (0, 0, 255),
}


class MattingError(RuntimeError):
    """能对用户讲清楚的失败，main() 负责转成退出码与人话提示。"""


def progress(percent: int, stage: str) -> None:
    print(f"PROGRESS {percent} {stage}", flush=True)


def parse_background_bgr(value: str) -> tuple[int, int, int]:
    v = (value or "").strip().lower()
    if v in NAMED_COLORS_BGR:
        return NAMED_COLORS_BGR[v]
    if v.startswith("#") and len(v) == 7:
        try:
            r, g, b = int(v[1:3], 16), int(v[3:5], 16), int(v[5:7], 16)
            return (b, g, r)
        except ValueError:
            pass
    return NAMED_COLORS_BGR["white"]


def parse_mode(value: str) -> str:
    v = (value or "auto").strip().lower()
    # 模型填参数并不总是规矩（video_enhance 那次 outscale 就传成了字符串），
    # 这里对不认识的值一律回落到 auto，而不是报错打断任务。
    return v if v in MODES else "auto"


def resolve_cutout_dir() -> Path:
    """定位 product-cutout 能力目录（BiRefNet 首帧抠图跑在它自己的 venv 里）。

    部署路径与仓库内的相对布局不一致（服务机上两个能力分别在 apps/video-toolbox/
    matting 和 apps/video-toolbox/gateway/capabilities/product-cutout），所以以
    capabilities.json 里注入的环境变量为准，另外留两条相对路径兜底，方便直接
    在命令行跑脚本调试。
    """
    env = os.environ.get("MATTING_CUTOUT_DIR", "").strip()
    candidates = [Path(env)] if env else []
    candidates += [
        BASE_DIR.parent / "gateway" / "capabilities" / "product-cutout",
        BASE_DIR.parent / "product-cutout",
    ]
    for c in candidates:
        if (c / "toolbox_run.py").is_file():
            return c
    raise MattingError(
        "找不到 product-cutout 能力目录（general 模式要用它抠首帧主体）。"
        "请在 capabilities.json 的 adapter.env 里设置 MATTING_CUTOUT_DIR。"
    )


# --------------------------------------------------------------------------- #
# RVM（human 模式）
# --------------------------------------------------------------------------- #


def build_model():
    import torch
    from model import MattingNetwork

    model = MattingNetwork(variant="mobilenetv3", refiner="deep_guided_filter")
    state_dict = torch.load(str(WEIGHTS_PATH), map_location="cpu")
    model.load_state_dict(state_dict)
    model = model.eval()
    if torch.cuda.is_available():
        model = model.cuda()
    return model


def downsample_ratio_for(width: int, height: int) -> float:
    # 官方推荐：较长边缩到约 512px 再推理，速度/质量的经验平衡点；refiner 会把
    # 结果引导滤波放大回原分辨率，不影响输出画质与尺寸。
    return min(1.0, 512 / max(width, height))


def probe_human_coverage(model, video: Path) -> float:
    """全片均匀采样若干帧，量 RVM 认出的人像面积占比。

    每帧都用全新的递归状态跑：这里要回答的是「这一帧里有没有人」，不是「时序平滑
    之后像不像人」，让上一帧的记忆渗进来反而会把判断拖糊。
    """
    import cv2
    import numpy as np
    import torch

    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise MattingError("无法读取视频")
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    ratio = downsample_ratio_for(width, height)
    device = next(model.parameters()).device

    indices = np.linspace(0, max(total - 1, 0), min(PROBE_SAMPLES, max(total, 1)))
    coverages = []
    with torch.no_grad():
        for i in indices.astype(int):
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(i))
            ok, frame = cap.read()
            if not ok:
                continue
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            src = torch.from_numpy(rgb).to(device, torch.float32).div(255)
            src = src.permute(2, 0, 1).unsqueeze(0)
            _, pha, *_ = model(src, None, None, None, None, downsample_ratio=ratio)
            coverages.append(float((pha[0, 0].clamp(0, 1).cpu().numpy() > 0.5).mean()))
    cap.release()
    if not coverages:
        raise MattingError("视频没有可读取的帧")
    return sum(coverages) / len(coverages)


def matte_frames_rvm(
    model, video: Path, frames_dir: Path, bg_bgr: tuple[int, int, int], frame_count: int
) -> float:
    """逐帧读取→RVM 递归推理→纯色合成→写 PNG 序列，返回全片平均 alpha 覆盖率。

    rec 状态跨帧串行传递，模型本身是递归结构，无法像 Real-ESRGAN 那样分块并行，
    只能顺序处理；好在 mobilenetv3 变体很轻，显存不是这个模型的瓶颈。
    """
    import cv2
    import numpy as np
    import torch

    device = next(model.parameters()).device
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise MattingError("无法读取视频")

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    ratio = downsample_ratio_for(width, height)

    frames_dir.mkdir(parents=True, exist_ok=True)
    bg = np.full((height, width, 3), bg_bgr, dtype=np.uint8).astype(np.float32)

    rec: list = [None, None, None, None]
    idx = 0
    coverage_sum = 0.0
    last_pct = -1
    with torch.no_grad():
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            src = torch.from_numpy(rgb).to(device, torch.float32).div(255)
            src = src.permute(2, 0, 1).unsqueeze(0)  # HWC -> 1CHW

            fgr, pha, *rec = model(src, *rec, downsample_ratio=ratio)

            fgr_np = fgr[0].permute(1, 2, 0).clamp(0, 1).mul(255).byte().cpu().numpy()
            pha_np = pha[0, 0].clamp(0, 1).cpu().numpy()[..., None]
            fgr_bgr = cv2.cvtColor(fgr_np, cv2.COLOR_RGB2BGR).astype(np.float32)
            coverage_sum += float((pha_np[..., 0] > 0.5).mean())

            composite = fgr_bgr * pha_np + bg * (1 - pha_np)
            composite = composite.clip(0, 255).astype(np.uint8)

            cv2.imwrite(
                str(frames_dir / f"{idx:06d}.png"),
                composite,
                [cv2.IMWRITE_PNG_COMPRESSION, 1],
            )
            idx += 1
            pct = 12 + int(idx / frame_count * 78) if frame_count else 12
            if pct != last_pct:
                progress(pct, f"人像抠像合成中 {idx}/{frame_count} 帧")
                last_pct = pct
    cap.release()
    if idx == 0:
        raise MattingError("视频没有可读取的帧")
    return coverage_sum / idx


# --------------------------------------------------------------------------- #
# MatAnyone（general 模式）
# --------------------------------------------------------------------------- #


def extract_first_frame(video: Path, dest: Path) -> None:
    import cv2

    cap = cv2.VideoCapture(str(video))
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise MattingError("视频没有可读取的帧")
    dest.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(dest), frame)


def first_frame_mask(video: Path, work_dir: Path) -> Path:
    """用 product-cutout 的 BiRefNet 抠首帧，产出 MatAnyone 要的首帧掩码。

    走子进程而不是把 BiRefNet 装进本 venv：权重 444MB 已经在那边装好并带校验，
    而且那个 venv 是 numpy 2.x、这边是 numpy 1.x，硬凑到一起只会互相拆台。
    """
    cutout_dir = resolve_cutout_dir()
    cutout_python = cutout_dir / ".venv" / "Scripts" / "python.exe"
    if not cutout_python.is_file():
        raise MattingError(f"product-cutout 的 venv 不存在：{cutout_python}")

    frame_path = work_dir / "_first.png"
    extract_first_frame(video, frame_path)

    result = subprocess.run(
        [
            str(cutout_python),
            "toolbox_run.py",
            "--input",
            str(frame_path),
            "--output-dir",
            str(work_dir),
            "--params",
            "{}",
        ],
        cwd=str(cutout_dir),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    mask_path = work_dir / "mask.png"
    if result.returncode != 0 or not mask_path.is_file():
        tail = (result.stderr or result.stdout or "").strip()[-400:]
        raise MattingError(f"首帧主体检测失败：{tail}")
    return mask_path


def matte_frames_general(
    video: Path,
    mask_path: Path,
    frames_dir: Path,
    bg_bgr: tuple[int, int, int],
    frame_count: int,
) -> float:
    """把全片交给 .venv-general 里的 MatAnyone，返回全片平均 alpha 覆盖率。

    子进程的 STEP/COVERAGE 行在这里折算成全局进度，进度band 的算法只有这一处。
    """
    if not GENERAL_PYTHON.is_file():
        raise MattingError(
            f"general 模式的运行环境不存在：{GENERAL_PYTHON}。"
            "请先在服务机上执行 general-install.bat。"
        )

    frames_dir.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        [
            str(GENERAL_PYTHON),
            str(GENERAL_SCRIPT),
            "--input",
            str(video),
            "--mask",
            str(mask_path),
            "--frames-dir",
            str(frames_dir),
            "--background",
            ",".join(str(v) for v in bg_bgr),
        ],
        cwd=str(BASE_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    coverage = None
    mask_coverage = None
    tail: list[str] = []
    last_pct = -1
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip("\n")
        tail.append(line)
        del tail[:-40]
        if line.startswith("STEP "):
            parts = line.split()
            done, total = int(parts[1]), int(parts[2])
            total = total or frame_count
            pct = 12 + int(done / total * 78) if total else 12
            if pct != last_pct:
                progress(pct, f"通用抠像合成中 {done}/{total} 帧")
                last_pct = pct
        elif line.startswith("COVERAGE "):
            coverage = float(line.split()[1])
        elif line.startswith("MASKCOVERAGE "):
            mask_coverage = float(line.split()[1])
            if mask_coverage < MIN_MASK_COVERAGE:
                proc.kill()
                proc.wait()
                raise MattingError(
                    "首帧没有检测到可抠的主体（覆盖率 "
                    f"{mask_coverage:.2%}）。请确认视频首帧里有清晰的主体，"
                    "或换一段主体一开始就在画面里的素材。"
                )
        else:
            print(line, flush=True)

    if proc.wait() != 0:
        raise MattingError("通用抠像失败：" + "\n".join(tail[-12:]))
    if coverage is None:
        raise MattingError("通用抠像没有返回覆盖率，产物可能不完整")
    return coverage


# --------------------------------------------------------------------------- #
# 产物出口
# --------------------------------------------------------------------------- #


def encode_video(frames_dir: Path, fps: float, dest: Path) -> None:
    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    result = subprocess.run(
        [
            ffmpeg, "-y",
            "-framerate", f"{fps:.3f}",
            "-i", str(frames_dir / "%06d.png"),
            "-c:v", "libx264", "-preset", "fast", "-crf", "18",
            "-pix_fmt", "yuv420p",
            str(dest),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not dest.exists():
        raise MattingError(f"重编码失败：{result.stderr[-300:]}")


def merge_audio(video_no_audio: Path, source: Path, dest: Path) -> None:
    """把原视频音轨并回合成结果；源无音轨或合并失败则直接用无声结果。"""
    try:
        import imageio_ffmpeg

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        result = subprocess.run(
            [
                ffmpeg, "-y",
                "-i", str(video_no_audio),
                "-i", str(source),
                "-map", "0:v:0", "-map", "1:a:0?",
                "-c:v", "copy", "-c:a", "aac", "-shortest",
                str(dest),
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and dest.exists():
            return
        print(f"音轨合并失败，使用无声输出：{result.stderr[-300:]}", flush=True)
    except Exception as exc:
        print(f"音轨合并异常，使用无声输出：{exc}", flush=True)
    shutil.copy2(video_no_audio, dest)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--params", default="{}")
    args = parser.parse_args()

    video = Path(args.input).resolve()
    out_dir = Path(args.output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    params = json.loads(args.params)
    bg_bgr = parse_background_bgr(str(params.get("background", "white")))
    requested_mode = parse_mode(str(params.get("mode", "auto")))

    if not video.is_file():
        print(f"输入视频不存在：{video}", flush=True)
        return 2
    if not WEIGHTS_PATH.is_file():
        print(f"缺少模型权重：{WEIGHTS_PATH}", flush=True)
        return 2

    try:
        progress(2, "读取视频信息")
        import cv2

        cap = cv2.VideoCapture(str(video))
        if not cap.isOpened():
            raise MattingError("无法读取视频")
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()

        frames_dir = out_dir / "_frames"
        mode = requested_mode
        rvm_model = None

        if mode == "auto":
            progress(4, "判定主体类型")
            rvm_model = build_model()
            human_coverage = probe_human_coverage(rvm_model, video)
            mode = "human" if human_coverage >= HUMAN_COVERAGE_THRESHOLD else "general"
            print(
                f"auto 判定：人像采样覆盖率 {human_coverage:.4f}"
                f"（阈值 {HUMAN_COVERAGE_THRESHOLD}）→ {mode} 模式",
                flush=True,
            )

        if mode == "human":
            progress(8, "加载人像抠像模型")
            rvm_model = rvm_model or build_model()
            coverage = matte_frames_rvm(rvm_model, video, frames_dir, bg_bgr, frame_count)
        else:
            progress(8, "检测首帧主体")
            # 首帧图和掩码放进 _work/ 再整个删掉：网关是把 output_dir 下的东西直接
            # 当产物列出来的，中间文件留在根目录会跟着 matted.mp4 一起交出去。
            work_dir = out_dir / "_work"
            try:
                mask_path = first_frame_mask(video, work_dir)
                coverage = matte_frames_general(
                    video, mask_path, frames_dir, bg_bgr, frame_count
                )
            finally:
                shutil.rmtree(work_dir, ignore_errors=True)

        # 空抠守卫：抠不出东西时明确失败。以前这里会一路走完编码、把一段纯背景色
        # 的视频当成功产物交出去，用户拿到手才发现什么都没有。
        if coverage < MIN_OUTPUT_COVERAGE:
            shutil.rmtree(frames_dir, ignore_errors=True)
            raise MattingError(
                f"没有抠出有效主体（全片平均覆盖率 {coverage:.2%}，"
                f"低于 {MIN_OUTPUT_COVERAGE:.0%}），"
                "继续下去只会得到一整片背景色。"
                + (
                    "当前是 human 模式，只认人像；如果主体不是人，请改用 general 模式。"
                    if mode == "human"
                    else "请确认视频里有清晰、完整的主体。"
                )
            )

        progress(92, "重新编码视频")
        encoded = out_dir / "_encoded.mp4"
        encode_video(frames_dir, fps, encoded)
        shutil.rmtree(frames_dir, ignore_errors=True)

        progress(96, "合并原音轨")
        merge_audio(encoded, video, out_dir / "matted.mp4")
        encoded.unlink(missing_ok=True)

        progress(100, "完成")
        return 0
    except MattingError as exc:
        print(str(exc), flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
