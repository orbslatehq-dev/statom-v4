# Technical Report — Statom V4

> What you actually built, and the code behind it.

## 1) What you actually built
Statom V4 is a single-page, 100% client-side web app that lets anyone in Sri Lanka pick their roof on satellite imagery and instantly get a 1:1 3D massing, 24-hour cinematic weather on that massing, a self-improving local forecast, and a rooftop solar + Net Plus financial studio. Five fullscreen "studios" (Map → 3D → Prediction → Solar → Water) share a single `HouseSpec` (polygon, roofStyle, stories, etc.) via React state in `App.tsx`.

## 2) Architecture (see README diagram)
- **Map:** MapLibre GL JS raster (`z=17–21`), custom Vite middleware `/api/search-lk` (Nominatim) and `/api/resolve-map-link` (Google short-link redirect follower). Tap Corners workflow: live rubber-band, numbered badges, orthogonal regularization on finish, vertex/midpoint editing.
- **Neural:** LankaRoofNet v1 — stitches `z=20` tiles for the bbox, extracts tile + shadow features, runs 14,836-param MLP in-browser (no server). Outputs roofStyle, pitch, ridgeAngle, material, stories.
- **Geometry:** `geoProjection.ts` (area via shoelace, centroid, bounds; regularization via orthogonal snap) → `roofBuilder.ts` (exact multi-wing planar CSG upper-envelope, eave overhangs, 1:1 metric scale).
- **3D & Weather Preview:** `ThreeHouseStudio.tsx` + `weatherPreviewEngine.ts` — sRGB sky shader, Sun/Moon ephemeris, clouds, rain/splash, shadows, 00:00–24:00 scrubber.
- **Weather & Learning:** `weatherService.ts` fetches Open-Meteo forecast/archive/climate; `weatherCache.ts` (IndexedDB) keys by 1 km grid; `lankaWeatherNet.ts` (432-param Residual MLP) corrects daily forecasts; `weatherSelfLearning.ts` runs daily Champion-vs-Challenger cycles (exponential recency weighting 0.5^(age/120), past_days=10 bridging, EMA backfill).
- **Solar:** `solarSimEngine.ts` (NOAA solar geometry Asia/Colombo + Erbs diffuse/direct + THREE.Raycaster self-shadowing + flat-rack 0° vs 10° N/S optimization) → `layoutEngine.ts` (best-first packing of JA Solar 550W panels with 30 cm setback, clamps) → `solarFinance.ts` (CEB/LECO Net Plus tariffs Sept 2026, tiered retail offset, 25-yr cashflow) → `solarAdvisor.ts` (Groq grounded LLM with FactSheet).
- **Water:** `drainageEngine.ts` / `waterFlowSim.ts` + harvesting (area × rainfall × runoff coeff).

All data keyed by `toDataGridKey(lat,lng)` (~1 km) and `toModelGridKey` for learning; no user accounts.

## 3) Stack — and why (see README table)
Vite + React 19 + TS 7 for speed and type safety; Three.js for CSG/raycasting; MapLibre for open-source WebGL maps; Tailwind 4 for utility styling; Open-Meteo (CC BY 4.0, no key) for weather/ERA5; Nominatim (ODbL) for geocoding; custom tiny in-browser MLPs for roof & weather correction (proves "produced during competition", zero inference cost); Groq gpt-oss-20b for grounded solar advice (CORS fetch, offline fallback).

## 4) Honest evaluation vs proposal
See README "Honest evaluation" table (grades A/B). Headline: 90% of proposal shipped. We cut: high-res DEM, bill OCR, island-wide prefetch. Neural accuracy 78% style / ±4.2° pitch; self-learning gains modest (~5–10% MAE) until 30-day cache per cell; solar GHI is ERA5-derived, not satellite GHI; finance excludes loans/inflation — disclaimers throughout.

## 5) Data — temporality and gaps (see docs/DATA.md)
Satellite: live rolling (~1–3 yr), no stored tiles. Weather: hourly forecast + ERA5 normals (30-yr) with 3–5 day ERA5 lag bridged by past_days=10 + self-learning. Solar: Sept 2026 tariffs (configurable, cited). Training: 2.1k manual crops (ours, fair-use tiles), hill/monsoon gaps, rare styles under-represented. Personal data: minimised/anonymised, no PII stored, GPS in-memory only, respecting robots.txt.

## 6) Reproducibility
`npm ci && npm run build` → `dist/`. Env: only `VITE_GROQ_API_KEY` optional. No backend. Tested Node 18/20/22.

## 7) Gaps & next steps
Add 30 m DEM for true tree/building shadowing; replace ERA5 GHI with satellite GHI (e.g., NSRDB); add LiDAR ground truth for roof pitch; expand training to 10k crops; add loan/inflation scenarios; on-device tile cache with LRU.

## 8) AI disclosure & open source
See README "AI assistance disclosure" and "Open source attribution" — libraries credited, AI tools listed, work owned by us.
