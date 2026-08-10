# ComfyUI-FBA-Matting

This is an internal adapter around the separately checked-out FBA Matting
implementation. It is deliberately deterministic: it does not invoke a
diffusion model and does not alter the product image through generation.

The official FBA repository and its `FBA.pth` weights must remain installed on
the service machine. Review that repository's license before using the node
for commercial production.

Nodes:

- `FBA_Matting`: runs the official model with a coarse foreground mask.
- `FBA_CleanAlpha`: removes low-confidence edge pixels while retaining a small
  antialiased transition.
- `FBA_ContactShadow`: extracts photographed contact darkness from the source;
  choose its direction per camera angle.
- `FBA_Composite`: produces native-aspect white, dark, alpha, and shadow
  diagnostics.
- `FBA_FitCanvas`: crops around the foreground/shadow, scales from the hard
  foreground bounding box, and places the result on a common canvas without
  using the source canvas dimensions as the scale reference.

`product-cutout-fba.api.json` keeps the native source aspect ratio. The
optional `product-cutout-fba-standard.api.json` adds the common-canvas step;
its numeric tokens are supplied by `scripts/run-comfyui-batch.ts`.
