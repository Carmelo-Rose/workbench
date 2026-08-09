# ComfyUI-WhiteField

Puts a studio product shot on a pure white background **without cutting it out
and without inventing a shadow**.

Pure numpy/OpenCV. No model weights, no network access, no diffusion — the
product's shape, logo, texture and camera angle all come from the source file.

## Why this instead of matting

A studio shadow is a *multiplicative* attenuation of the light falling on the
seamless. Estimate `B(x,y)` — what the backdrop would have measured with no
object in frame — and `source / B` is the measured shadow transmittance, per
channel. Three things fall out of that one division:

- the backdrop resolves to pure white,
- the paper's colour cast divides out with it,
- the shadow keeps its real direction, shape and falloff.

The shadow is **measured, not modelled**, so nothing has to be re-tuned when the
camera angle changes. This is the difference that matters versus
`ComfyUI-FBA-Matting`, whose `FBA_BottomContactShadow` paints a symmetric
ellipse under the alpha bounding box: that ellipse is byte-identical for a
front, a side and a rear view, so it discards the light direction the
photographer actually set up.

The product mask is used only as a **protection region** — inside it, source
pixels are copied through untouched. There is no cut line, so the failure modes
that live on a cut line (white fringes, chewed hardware, halos) have nowhere to
appear. `WhiteField_Report` measures this directly: `product_delta_max` must
read `0.000`.

## Nodes

- `WhiteField_FitBackdrop` — fits the unoccluded backdrop by coarse-to-fine
  normalised convolution over pixels known to be clean paper. Outputs the field
  plus a debug view of which pixels it trusted. The fit runs downsampled
  (`fit_side`); the field is band-limited well below that, so upsampling it back
  is exact and roughly an order of magnitude cheaper.
- `WhiteField_Normalize` — does the division, then three corrections:
  - **topology**: a flood fill from the frame corners separates outer background
    from background enclosed by the product. The outer region keeps its cast
    shadow (that shadow is what grounds the product); an enclosed hole — a cap's
    rear opening, the gap under a handle — goes pure white. Both are simply
    "darker than the backdrop", so intensity cannot tell them apart and
    connectivity has to.
  - **dust**: isolated specks on the paper are erased. The size ceiling
    (`dust_max_area` / `dust_max_dim`) and the clearance test (`dust_min_gap`)
    are what keep a missed strap tip or a dropped eyelet safe.
  - **white point**: `white_at` is the transmittance at which paper reads as
    clean, which pins the far penumbra to white instead of letting a wash trail
    across the frame. Production keeps `shadow_gain=1` so shadow strength is
    not levelled or deepened.
- `WhiteField_Report` — `product_delta_max`, `backdrop_pure_pct`,
  `backdrop_cast`, `shadow_darkest_L`. Use it as the acceptance gate.

`WhiteField_Normalize` resizes the mask and backdrop to the image internally, so
the mask can be computed at the segmentation model's megapixel ceiling while the
division runs at delivery resolution. That is what keeps the product bit-exact:
it is never resampled by this package.

## Limits

- **Assumes a smooth seamless backdrop.** The backdrop fit cannot represent
  texture or pattern; on a printed or visibly uneven background it will fail.
- Validated on one product family (37 shots of a baseball cap, 6 colourways ×
  5-6 angles). Fur, transparent and strongly specular goods are untested;
  partial transmission has no special handling.
- `dilate_px` defaults to 0. Larger values copy unnormalised backdrop through
  and leave a grey halo hugging the contour.

## Workflow

`config/comfyui-workflows/product-main-image.json` is the production API
workflow. It saves only node 15's 800×800 `_main` file; node 9 returns the QA
text through history, and no 3000px diagnostic image is persisted.

Validated settings: `MASK_LONG_EDGE=2400`, `DELIVER_LONG_EDGE=3000`,
`EXCLUDE_PX=40`, `DILATE_PX=0`, `FEATHER_PX=1`, `WHITE_AT=0.965`,
`SHADOW_GAIN=1`, `HOLE_WHITE=0`, `SQUARE_FILL=0.90`, `SQUARE_SIDE=800`.
