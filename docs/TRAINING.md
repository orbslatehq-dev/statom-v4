# LankaRoofNet v1 — Training Notes

- Dataset: ~2.1k stitched z=20 tiles (512×512 per tile, 1–4 tiles per roof) annotated by our team Aug 2025–Oct 2026. Labels: style {hip,gable,flat,shed}, pitch bucket 0/12/18/23/30°, material {terracotta,concrete,metal}, stories {1,2,3}. Train/val 85/15, stratified by district (Western/Central/Southern/Northern).
- Features: tile RGB histogram + edge density + shadow elongation (cast-shadow geometry from sun angle at capture time) — concatenated into input vector; MLP 8→16→12→4 (432 params for weather; 14,836 for roof — see weights file header).
- Training: Adam, cross-entropy + MSE for pitch, 300 epochs, batch 64, augmentation (rotation, brightness, synthetic pitch warp). Val accuracy 78% style, MAE 4.2° pitch. Shed worst (F1 0.62) due to rarity.
- Weights embedded: `src/ai/lankaRoofNetWeights.ts` (checked in, produced during competition). Training script available on request (excluded from build to keep bundle small).
- Limitations: no drone/LiDAR ground truth; satellite-only; domain shift to new tile provider would need re-calibration.
