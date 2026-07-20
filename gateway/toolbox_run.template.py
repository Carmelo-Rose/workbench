"""能力接入壳模板（复制到各能力项目里改名 toolbox_run.py 用）。

作用：把任意能力的现有推理管线适配成网关的子进程约定——
  .venv/Scripts/python.exe toolbox_run.py --input <视频> --output-dir <产物目录> --params <JSON>

约定回顾（详见 gateway/README.md）：
- 退出码 0 = 成功，产物写入 --output-dir；
- stdout 打印「PROGRESS <0-100> <阶段>」驱动前端进度条；
- 其余输出随意，会整体落到任务 log.txt。

部署 smart-erase 时：把下面 run_pipeline() 换成对 smart-erase 实际入口的调用。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def progress(percent: int, stage: str) -> None:
    print(f"PROGRESS {percent} {stage}", flush=True)


def run_pipeline(input_path: Path, output_dir: Path, params: dict) -> None:
    """TODO：替换为能力的真实管线调用。

    smart-erase 示例（按摸底结果改）：
        from pipeline import erase
        progress(5, "加载模型")
        erase(video=str(input_path), target=params.get("instruction", ""),
              out=str(output_dir / "erased.mp4"),
              on_progress=lambda p, s: progress(5 + int(p * 0.9), s))
    """
    raise NotImplementedError("接入时替换本函数")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--params", default="{}")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    params = json.loads(args.params)

    if not input_path.is_file():
        print(f"输入文件不存在：{input_path}", flush=True)
        return 2

    progress(1, "开始处理")
    run_pipeline(input_path, output_dir, params)
    progress(100, "完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
