from pathlib import Path
import cv2
import numpy as np

root = Path(r"D:\ai\ComfyUINeo50_250719\ComfyUINeo50_250719\ComfyUINeo50\tmp\codex-round3-targeted-8212-f2-v3")
stem = "329A8212"
white = cv2.imread(str(root / f"{stem}-1.png"), cv2.IMREAD_COLOR)
alpha = cv2.imread(str(root / f"{stem}-3.png"), cv2.IMREAD_GRAYSCALE)
fg = cv2.imread(str(root / f"{stem}-10.png"), cv2.IMREAD_COLOR)
edge = cv2.imread(str(root / f"{stem}-6.png"), cv2.IMREAD_GRAYSCALE)
prefit = cv2.imread(str(root / f"{stem}-9.png"), cv2.IMREAD_GRAYSCALE)
assert white is not None and alpha is not None and fg is not None and edge is not None and prefit is not None
def bb(mask):
    ys, xs = np.where(mask >= 204)
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
print({"final_bbox": bb(alpha), "prefit_bbox": bb(prefit)})
scale = 1100.0 / max(bb(prefit)[2] - bb(prefit)[0], bb(prefit)[3] - bb(prefit)[1])
paste_x = 410 - bb(prefit)[0] * scale
paste_y = 341 - bb(prefit)[1] * scale
px = int(round((416 - paste_x) / scale))
py = int(round((710 - paste_y) / scale))
print({"scale_estimate": scale, "paste": [paste_x, paste_y], "prefit_for_final_416_710": [px, py], "prefit_alpha": int(prefit[py, px]), "prefit_fg_bgr": fg[py, px].tolist(), "prefit_edge": int(edge[py, px])})
smooth = cv2.GaussianBlur(prefit.astype(np.float32) / 255.0, (0, 0), 1.0)
gx = cv2.Sobel(smooth, cv2.CV_32F, 1, 0, ksize=3)
gy = cv2.Sobel(smooth, cv2.CV_32F, 0, 1, ksize=3)
norm = np.sqrt(gx * gx + gy * gy)
dx = float(gx[py, px] / max(norm[py, px], 1e-5))
dy = float(gy[py, px] / max(norm[py, px], 1e-5))
sd = 8 * 0.85
sx = px + dx * sd
sy = py + dy * sd
sample = [int(round(np.clip(sx, 0, fg.shape[1] - 1))), int(round(np.clip(sy, 0, fg.shape[0] - 1)))]
print({"gradient": [dx, dy], "sample": sample, "sample_fg_bgr": fg[sample[1], sample[0]].tolist(), "norm": float(norm[py, px])})
for qx, qy in ((416, 710), (418, 710), (416, 715), (418, 730)):
    print({"final_xy": [qx, qy], "white_bgr": white[qy, qx].tolist(), "alpha": int(alpha[qy, qx])})
for y in range(680, 760, 5):
    vals = []
    for x in range(408, 430, 2):
        if white[y, x].max() < 250 or alpha[y, x] > 0:
            vals.append({"xy": [x, y], "white_bgr": white[y, x].tolist(), "alpha": int(alpha[y, x]), "fg_bgr": fg[y, x].tolist(), "edge": int(edge[y, x])})
    if vals:
        print(vals)
