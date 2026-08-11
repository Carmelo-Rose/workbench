# Product main-image shadow bundles

Each child directory is an immutable, hash-verified runtime bundle. The raw
flattened samples on the product share are calibration input only and are never
read by a product job.

Build the first approved bundle:

```powershell
npx tsx scripts/build-product-shadow-bundle.ts `
  --source-root 'Z:\型麦-得物-品牌\【详情页】-待审\lj测试111\test'
```

Verify an installed bundle without contacting ComfyUI or the product share:

```powershell
npx tsx scripts/build-product-shadow-bundle.ts --verify
```

To revise the standard, change the version and publish a new sibling directory.
Do not edit files inside a bundle already referenced by a persisted job.
