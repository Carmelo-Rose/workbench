# Product main-image shadow bundles

Each child directory is an immutable, hash-verified runtime bundle. The raw
flattened samples on the product share are calibration input only and are never
read by a product job.

Generate and inspect a non-publishing calibration candidate with the explicit
V1/PSD/layer/slot/ROI arguments documented by the command:

```powershell
python scripts/calibrate-product-main-shadow.py --help
```

Verify an immutable registered bundle, including its approved PSD hashes:

```powershell
python scripts/validate-product-main-shadow-preset.py `
  --bundle config/product-main-shadows/hat-ps-shadow-v2.1 `
  --registry config/product-main-shadows/registry.json `
  --require-gold-psd
```

Candidates remain outside this directory and cannot publish themselves. After
explicit human approval, publish a new sibling version and registry hash; never
edit a bundle already referenced by a persisted job.

Build a self-contained, hash-pinned candidate package under a fresh candidate
directory (the builder refuses `config/` destinations and existing outputs):

```powershell
python scripts/build-product-main-shadow-candidate-package.py `
  --baseline-bundle config/product-main-shadows/hat-ps-shadow-v2.1 `
  --candidate-root <candidate-root> `
  --output-dir <candidate-root>/<new-candidate-package> `
  --candidate-version hat-ps-shadow-v2.3
```

Audit that non-publishable package explicitly in candidate mode:

```powershell
python scripts/validate-product-main-shadow-preset.py `
  --bundle <candidate-package> `
  --registry <candidate-package>/candidate-registry.json `
  --candidate-mode `
  --require-gold-psd
```

Omitting `--candidate-mode` must reject an awaiting-approval candidate.
