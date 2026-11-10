# Statom V4 — Two-Page Summary (printable)

**Statom V4** turns any Sri Lankan rooftop seen on satellite into a 1:1 3D prototype, shows live weather *on* that 3D house, learns to correct its own forecasts per neighbourhood, and tells the homeowner — in LKR — whether rooftop solar pays.

## How it works
1. **Pick your roof** on a fullscreen Sri Lanka satellite map (MapLibre GL, z=21, Nominatim search, Google Maps link import, GPS). Tap 3+ corners; the footprint is orthogonally regularized.
2. **Automatic 3D** — LankaRoofNet v1 (14,836-param in-browser CNN on z=20 tile stitches + shadow geometry) infers roof style (hip/gable/flat/shed), pitch, ridge, material, and stories. The geometry engine builds an exact multi-wing CSG roof at 1:1 metric scale in Three.js.
3. **Weather, right on the house** — a draggable 00:00–24:00 time-lapse (sky shader, Sun/Moon, clouds, rain, shadows) driven by Open-Meteo 7-day + ERA5 climate. Panels show Roof Impact (rain harvesting, PV yield), Climate Normals, and soil 0–7 cm.
4. **Self-learning forecast** — LankaWeatherNet (432-param Residual MLP) corrects the raw forecast per 1 km cell. Daily background learning (Champion vs Challenger gating, exponential recency, ERA5 backfill) lives in IndexedDB with a 365-day journal and sparkline.
5. **Solar studio** — deterministic irradiance (NOAA geometry + Erbs + Raycaster self-shadowing + 0°/10° flat-rack optimization), best-first packing of JA Solar 550W panels (30 cm setback), LKR 23.11/kWh ≤10 kW Net Plus tariffs (Sept 2026, configurable), 12-month + 25-yr cashflow, verdicts, and 5/10/15 kWh LiFePO4 battery dispatch. A grounded Groq AI advisor (openai/gpt-oss-20b, zero hallucinated numbers — every figure from a deterministic FactSheet) answers in EN/SI/TA; works offline without a key.

## Why it matters for Sri Lanka
Electricity bills, monsoons, and flat-roof heat are everyday concerns. By combining open satellite, open weather, and open tariffs in a zero-backend app, Statom V4 gives any homeowner — Maharagama to Jaffna — an honest, visual, first-order answer before calling an installer.

## Tech in one line
Vite + React 19 + TypeScript + Three.js + MapLibre + Tailwind; 100% client-side (IndexedDB/localStorage); Open-Meteo/ERA5 (CC BY 4.0) + OSM Nominatim (ODbL) + Groq — all credited. No personal data collected.

## What we proved vs what we claimed
Neural roof detection 78% style / ±4.2° pitch (honest: small training set, shed confusion); self-learning modest until 30 d cache per cell; solar GHI is ERA5-derived (not satellite GHI) and finance excludes loans — every page says "Estimates only — verify with CEB & your installer." Cinematic weather is the demo highlight.

## Run it
`git clone <url> && npm install && npm run dev` → http://localhost:5173 (optional `VITE_GROQ_API_KEY` in `.env`). `npm run build` → `dist/` deploys to any static host.

Team: 1–4 members (list names here). Rosters lock 6 October. Licence: MIT.
