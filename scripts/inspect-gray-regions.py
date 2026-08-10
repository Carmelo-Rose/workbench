from pathlib import Path

from PIL import Image, ImageDraw


BASE = Path(r"C:\Users\Administrator.DESKTOP-GRHN4PA\AppData\Local\Temp\codex-comfy-fba-round3-all5-final30")
OUT = Path(r"C:\Users\Administrator.DESKTOP-GRHN4PA\AppData\Local\Temp\gray-region-audit")
CASES = [
    ("8212", "329A8212", (422, 789, 497, 872)),
    ("8218", "codex_test_329A8218", (743, 399, 881, 493)),
    ("8235", "codex-original-8235", (1141, 918, 1253, 1055)),
    ("8211", "codex-original-8211", (752, 647, 1155, 768)),
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for label, stem, component in CASES:
        image = Image.open(BASE / f"{stem}-1.png").convert("RGB")
        x0, y0, x1, y1 = component
        margin = 80
        crop_box = (
            max(0, x0 - margin),
            max(0, y0 - margin),
            min(image.width, x1 + margin),
            min(image.height, y1 + margin),
        )
        crop = image.crop(crop_box)
        crop = crop.resize((crop.width * 3, crop.height * 3), Image.Resampling.LANCZOS)
        draw = ImageDraw.Draw(crop)
        draw.rectangle(
            ((x0 - crop_box[0]) * 3, (y0 - crop_box[1]) * 3, (x1 - crop_box[0]) * 3, (y1 - crop_box[1]) * 3),
            outline=(255, 0, 0),
            width=3,
        )
        crop.save(OUT / f"{label}-gray-component-3x.png")


if __name__ == "__main__":
    main()
