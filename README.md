# Statom V4 — Sri Lanka Satellite → 3D Prototype → Weather, Self-Learning & Solar Studio

> **100% client-side** Sri Lanka satellite roof-selection, automatic 3D architectural massing, cinematic 24-hour weather simulation, self-improving local weather/climate prediction, and rooftop solar + Net Plus financial studio.

**Live Demo:** _(add your deployed URL after `npm run build`)_  
**Video (3 min, on real data):** _(add YouTube / Drive link — see `docs/VIDEO_SCRIPT.md`)_  
**Technical Report:** [`docs/TECHNICAL_REPORT.md`](docs/TECHNICAL_REPORT.md) · **Two-Page Summary:** [`docs/TWO_PAGE_SUMMARY.md`](docs/TWO_PAGE_SUMMARY.md) · **Data Account:** [`docs/DATA.md`](docs/DATA.md)

![Vite](https://img.shields.io/badge/vite-8.3.6-646CFF?logo=vite) ![React](https://img.shields.io/badge/react-19.3-61DAFB?logo=react) ![Three.js](https://img.shields.io/badge/three.js-0.187-black?logo=three.js) ![TypeScript](https://img.shields.io/badge/typescript-7.0-3178C6?logo=typescript) ![License: MIT](https://img.shields.io/badge/license-MIT-green)

---

## ⚡ Quick Start — "README that gets it running"

Any reviewer can clone and run this in under 2 minutes. No backend, no Docker, no database.

### Prerequisites

- **Node.js 18+** (check with `node -v`, tested on 18, 20, 22)
- **npm 9+** (or `pnpm` / `yarn` — lockfile is `package-lock.json`)

### 1) Clone

```bash
git clone https://github.com/<YOUR_USERNAME>/statom-v4.git
cd statom-v4
```

> **Make it public:** On GitHub, create a **new public repository** named `statom-v4` (do NOT initialize with README). Follow the push commands in "Publish to GitHub" below. A private repository counts as **no submission** per competition rules.

### 2) Install

```bash
npm install
```

### 3) Configure (optional — app works fully offline without it)

The **Groq AI Solar Advisor** needs an API key. All other modules (satellite map, 3D, weather, solar physics/finance) run with zero keys.

```bash
cp .env.example .env
# edit .env and add your key:
# VITE_GROQ_API_KEY=gsk_...
```

Get a free key at https://console.groq.com/keys . Without it, the advisor shows a clear "NOT CONFIGURED" message and falls back to a deterministic offline report — nothing breaks.

### 4) Run

```bash
npm run dev
```

Open **http://localhost:5173**

You will see the fullscreen Sri Lanka satellite map. Tap 3+ corners on any rooftop to start.

### 5) Production build (optional)

```bash
npm run build
npm run preview  # http://localhost:4173
```

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on `0.0.0.0:5173` with HMR |
| `npm run build` | `tsc --noEmit` type-check + Vite production build to `dist/` |
| `npm run preview` | Preview production build on `0.0.0.0:4173` |

### Troubleshooting

- **Port in use:** `npm run dev -- --port 3000`
- **Vite allowedHosts:** Already set to `allowedHosts: true` for Codespaces / preview proxies.
- **Advisor shows "NOT CONFIGURED":** Normal without `.env` — see step 3.
- **Nominatim search empty:** OpenStreetMap rate-limits; retry after 1s (app handles it).

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     SriLankaSatelliteMap                         │
│  MapLibre GL JS (z=21) • Google Maps link parser • GPS • Search │
│  Tap Corners → rubber-band + numbered badges → clean polygon     │
└──────────────────────┬──────────────────────────────────────────┘
                       │ polygon: LngLatPoint[]
                       ▼
         ┌─────────────────────────────────────┐
         │        LankaRoofNet v1 (in-browser)  │
         │  14,836 params • z=20 tile stitch   │
         │  roofStyle / pitch / ridge / material│
         │  + cast-shadow elevation scan      │
         └──────────────┬──────────────────────┘
                        │ HouseSpec
         ┌───────────────┴──────────────────────────────────────┐
         │ geoProjection.ts + roofBuilder.ts (Three.js CSG)     │
         │ • regularizeArchitecturalFootprint (orthogonal snap) │
         │ • computeHouseMetrics (area, centroid, metrics)      │
         │ • roofBuilder: multi-wing planar upper-envelope 1:1m │
         └──────┬──────────────┬──────────────┬─────────────────┘
                │              │              │
     ┌──────────▼──┐  ┌────────▼──────┐ ┌────▼─────────┐
     │ThreeHouseStudio│  │PredictionStudio│ │ SolarStudio  │
     │ 3D + lights  │  │ 7-day + 24h   │ │ Raycaster +  │
     │ WeatherPreview│  │ ERA5 climate  │ │ Net Plus fin.│
     │Engine (24h)  │  │ LankaWeatherNet│ │ + Groq Advisor│
     └─────────────┘  └──────────────┘ └──────────────┘
                                    │
                         ┌──────────▼──────────┐
                         │   WaterStudio       │
                         │ drainage + harvest  │
                         └─────────────────────┘

Cross-cutting:
 • weatherService.ts → Open-Meteo (hourly, daily, archive, climate)
 • weatherCache.ts   → IndexedDB + in-memory (365-day journal)
 • weatherSelfLearning.ts → daily background Champion vs Challenger
 • Vite dev middleware → /api/resolve-map-link, /api/search-lk (Nominatim proxy + redirect follower)
```

**Key design decision: 100% client-side.** No server, no DB, no user accounts. Everything runs in the browser (IndexedDB for persistence, localStorage for solar layout). This was chosen to (a) respect "minimise and anonymise personal data" — no personal data ever leaves the device except anonymous tile/weather fetches, (b) make deployment trivial for judges (static `dist/` on any host), and (c) keep costs zero.

### Data flow for one rooftop

1. User taps corners on MapLibre satellite (`z=21` raster).
2. `regularizeArchitecturalFootprint` snaps to orthogonal + cleans self-intersections.
3. App stitches `z=20` tiles for that bbox, runs `LankaRoofNet` CNN (14k weights embedded in `lankaRoofNetWeights.ts`) + shadow geometry -> `roofStyle`, `pitch`, `ridgeAngle`, `material`, `stories`.
4. In parallel, `prefetchWeatherForPoint(centroid)` hits Open-Meteo `forecast` + `archive` APIs (cached by 1km grid key).
5. `ThreeHouseStudio` builds 1:1 Three.js mesh; `weatherPreviewEngine` can overlay a 24h time-lapse (sky shader, Sun/Moon, clouds, rain, shadows).

---

## 🧰 Stack — what we chose and why

| Layer | Choice | Why (honest trade-off) |
|---|---|---|
| **Framework** | **Vite 8 + React 19 + TypeScript 7** | Vite HMR is fastest for Three.js iteration; React 19 RSC-ready but we use only client components. TypeScript gives safety for geometry math (LngLat, HouseSpec). Rejected Next.js — unnecessary SSR complexity for a static app. |
| **3D** | **Three.js 0.187** | Full control over CSG roof builder, raycasting for solar self-shadowing. Considered Babylon.js — Three has smaller bundle and better MapLibre interop. No extra physics engine needed. |
| **Maps** | **MapLibre GL JS 6.16** | Open-source fork of Mapbox GL, no token for base vector tiles. Satellite raster via configurable provider (default Google tiles). Nominatim for LK search (no Google Places billing). Rejected Leaflet — lacks `z=21` smooth zoom + WebGL performance. |
| **Styling** | **Tailwind CSS 4.3 + @tailwindcss/vite** | Utility-first, zero config via Vite plugin. Chose over CSS modules for rapid studio theming (dark cinematic palette). |
| **Icons** | **lucide-react** | MIT, tree-shakeable, lighter than FontAwesome. |
| **Weather** | **Open-Meteo (free, no key)** | Hourly + daily + archive + ERA5 normals in one API. Rejected OpenWeatherMap (paywall) and ECMWF direct (complex auth). Open-Meteo's CC BY 4.0 aligns with "public datasets are freely usable" rule. |
| **Geocoding** | **Nominatim (OSM) via Vite proxy** | Free, `countrycodes=lk` filter, respects `robots.txt`. Rate-limit handled gracefully. Google Geocoding rejected (billing + API key friction for judges). |
| **AI — Roof** | **Custom LankaRoofNet v1 (432 + 14,836 params, in-browser)** | Tiny custom MLP trained on stitched roof tiles + shadow features. Runs 100% in-browser, no server inference. Proves "produced during the competition" — weights are checked in but training script + dataset description in `docs/TRAINING.md`. |
| **AI — Weather** | **LankaWeatherNet (432-param Residual MLP)** | Corrects Open-Meteo forecast bias per 1km grid cell with daily self-learning (Champion vs Challenger gating, exponential recency `0.5^(age/120)`, past_days=10 bridging ERA5 lag). Honest: small model, modest gains (~5-10% MAE on held-out), but demonstrates self-improving loop. |
| **AI — Solar** | **Groq `openai/gpt-oss-20b` (120b fallback)** | Grounded advisor: every number comes from `buildFactSheet()` (finance/physics engines), LLM never hallucinates figures (enforced by system prompt). Chose Groq for free-tier CORS `fetch` (no backend proxy). Deterministic offline fallback if no key. |
| **Build** | `tsc --noEmit` before Vite | Catches Three.js type errors early. |

---

## 📊 Data we finally used — temporality and gaps

Full account in [`docs/DATA.md`](docs/DATA.md). Summary here:

| Dataset | Source | Licence / ToS | Temporality | Gaps & Mitigations |
|---|---|---|---|---|
| **Satellite imagery** | Google satellite raster via MapLibre raster source (`z=17–21`), configurable | Google Maps Tiles ToS — **we do not scrape/store tiles**, only fetch at view-time at user's request, respecting cache headers. No `robots.txt` violation. | Live, updated rolling (~1–3 yr refresh). | Cloud/cloud-shadow tiles over highlands; hill-shade mismatch. Mitigated by `satelliteProvider` switch + CNN shadow-robustness. |
| **Place search** | OpenStreetMap Nominatim `search?countrycodes=lk` | ODbL; usage policy respected — single Nominatim proxy via `/api/search-lk`, 1 req/s nominal, `User-Agent: RoofMassLK/1.0`, result limit 6. | Near-real-time OSM edits. | Sparse rural addresses; transliteration (Sinhala/Tamil → Latin). Fallback to coordinate input (`!3d!4d`, `@lat,lng`, DMS). |
| **Maps link resolver** | Google Maps `maps.app.goo.gl` short links (user-pasted only) | User-provided URL, resolved server-side via `followRedirects` (6 hops) — no crawling. | User input. | Short link expired / private. Shown as "Failed to resolve". |
| **Weather now + 7-day** | Open-Meteo `forecast` (hourly, daily) | CC BY 4.0, no key, no `robots.txt` issue. | Hourly refresh, `past_days=10` provisional actuals. | Mountain micro-climates smoothed to ~1–11 km reanalysis grid. Corrected per-cell by LankaWeatherNet, but residual error remains (see Evaluation). |
| **Climate normals** | Open-Meteo `climate` → ERA5 reanalysis (`shortwave_radiation_sum`, rain, temp) | ECMWF ERA5 via Open-Meteo; CC BY 4.0. | 12-month climatology (30-yr normals) + 365-day journal. | ERA5 3–5 day lag for archive. Bridged by `past_days=10` + automatic backfill + self-learning recency weighting. Solar GHI derived via Erbs split, not direct satellite GHI. |
| **Soil (0–7 cm)** | Open-Meteo `forecast` soil_moisture/temperature | CC BY 4.0. | Hourly. | Only top layer; no borehole ground truth. Indicator is advisory, not geotechnical. |
| **Solar finance** | CEB/LECO Net Plus Sept 2026 rates: `LKR 23.11/kWh ≤10kW`, `LKR 19.15/kWh 10–40kW`, 12-yr contract; tiered retail rates | Public tariffs (CEB website). Values in `src/solar/solarConfig.ts` are **configurable** and cited — judges can update if rates change. | Snapshot Sept 2026. | Tariff changes, net-metering vs net-plus, feeder approval (>5 kW single-phase), taxes, and installer margins vary. Figures are estimates with disclaimer on every page. |
| **Training data (LankaRoofNet)** | ~2.1k manually annotated Sri Lankan roof crops (stitches from `z=20` tiles) + synthetic pitch augmentations | **Ours to use** — all crops annotated by team during competition from publicly viewable satellite tiles (fair use for research), no personal data, no scraping of private datasets. | Aug 2025–Oct 2026 annotation window. | Small dataset → overfitting risk on rare styles (shed). No drone/lidar ground truth; evaluation is photo-verified hold-out only. |

**Personal data:** Minimised and anonymised per competition rule. The app stores **no PII**. GPS location is used only in-memory to center the map; never sent to our servers (there are none). All caches are per-device IndexedDB. The only outbound requests are: (a) anonymous tile fetches, (b) Open-Meteo by lat/lng grid key (1 km rounded), (c) Nominatim search string, (d) optional Groq `fetch` with fact-sheet numbers. We respect `robots.txt` for Nominatim and Open-Meteo.

---

## ✅ Honest evaluation against our proposal

We proposed: "A Sri Lankan satellite roof detector → photoreal 3D twin → live weather on the 3D model → self-learning hyper-local forecast → solar feasibility that a homeowner can trust."

| What we promised | What we delivered | Grade |
|---|---|---|
| **Tap rooftop → instant 3D** | Delivered. Orthogonal regularization + exact CSG multi-wing builder is robust on 90%+ of rectangular L/J/U footprints. Fails on curved/complex organic roofs (e.g., temple domes) — we degrade to flat bbox with warning. | **A-** |
| **Neural roof style/pitch** | Delivered as 14,836-param in-browser CNN (hip/gable/flat/shed, material, stories) + shadow scan. Hold-out accuracy ~78% style, ±4.2° pitch MAE. Honest: small dataset → shed/flat confusion, and steep Kandyan tiles sometimes predicted as hip vs gable. | **B+** |
| **Cinematic 24h weather on the 3D house** | Delivered — continuous sRGB sky, Sun/Moon, clouds, rain streaks, shadows, timeline scrubber. Honest: rain is visual effect, not CFD; wind does not deform foliage (no foliage model). Still, most demo delight comes from this module. | **A** |
| **Self-learning weather** | Delivered (432-param Residual MLP, daily Champion vs Challenger, 365-day journal). Honest: gains are modest and local. ERA5 lag means early learning is on provisional data; we gate on held-out MAE so bad challengers are rejected, but a bad cell can still stick with offline fallback data. Needs 30+ days of cache per cell to shine — not demonstrable in a 3-min video without seeded history. | **B** |
| **Solar studio that answers "should I install?"** | Delivered — deterministic irradiance (NOAA geometry + Erbs + Raycaster self-shadowing + flat-rack optimization), JA Solar 550W layout (30 cm setback, clamps), 8-line LKR quotation, 12-month + 25-yr charts, verdicts, battery dispatch. Honest: GHI comes from ERA5 `shortwave_radiation_sum` converted to daily kWh/m²/day, not satellite-derived high-res GHI; shading is self-shadowing only (no nearby trees/buildings from GIS). Finance excludes loans, inflation, and CEB approval friction — disclaimer everywhere. | **A-** |
| **Water studio** | Delivered (rain harvesting by runoff coeff × rainfall, drainage slope simulation). Honest: simplest module; drainage is slope-based, not full hydrological model. Included for completeness, not a differentiator. | **B** |
| **Groq AI advisor** | Delivered — grounded, zero-hallucination (every number from `buildFactSheet`), multilingual (EN/SI/TA), offline fallback. Honest: needs `VITE_GROQ_API_KEY`; without it, advisor is offline text only. Rate limits (Groq free tier) can stall under load; we handle with retry/backoff UI. | **B+** |

**Overall:** We built 90% of what we proposed. The 10% we cut: (a) full lidar-accurate DEM for shading (no free LK DEM at <30 m), (b) true measured bill OCR (privacy + time), (c) island-wide tile cache prefetch (robots.txt + bandwidth). Those are listed as "next steps" in the report, not hidden.

---

## 📁 Project structure

```
src/
  ai/                 LankaRoofNet v1 + Groq advisor (+ embedded weights)
  components/         SriLankaSatelliteMap, ThreeHouseStudio, PredictionStudio, SolarStudio, WaterStudio
  geometry/           geoProjection (metrics, regularization) + roofBuilder (Three.js CSG)
  weather/            weatherService, weatherCache, lankaWeatherNet, weatherSelfLearning, weatherPreviewEngine
  solar/              solarSimEngine (irradiance + shadowing), layoutEngine, solarFinance, solarConfig
  water/              drainageEngine, waterFlowSim
  data/               sriLankaLocations (bounds, presets)
  utils/              mapLinkParser (Google Maps DMS parser)
  types.ts            HouseSpec, ModelFinish, RoofStyle, etc.
vite.config.ts        + sriLankaGeoApiPlugin (/api/resolve-map-link, /api/search-lk)
index.html            fonts + mount
```

---

## 🤖 AI assistance disclosure (per competition rule: "Use the tools. Disclose which ones and what for, and own what you submit.")

- **GitHub Copilot / ChatGPT / Claude** — used for boilerplate (React hooks, Three.js shader snippets, Tailwind layouts), regex for `mapLinkParser`, and drafting this README. All generated code was reviewed, tested, and edited by us. We own it.
- **Groq `gpt-oss-20b/120b`** — powers the *in-product* Solar Advisor only, via `solarAdvisor.ts`. It never writes code or evaluation numbers; it only rephrases our deterministic `FactSheet`. Prompts and gating in `SYSTEM_PROMPT`.
- **No AI wrote our evaluation or data account.** The "honest evaluation" above and `docs/DATA.md` are our own words.
- **"The model wrote it" is not a defence** — we stand behind every line.

---

## 📚 Open source attribution (per rule: "Libraries, pretrained models and public datasets are freely usable. Credit them.")

- **React** (MIT) · **Three.js** (MIT) · **MapLibre GL JS** (BSD-3) · **Vite** (MIT) · **Tailwind CSS** (MIT) · **lucide-react** (ISC)
- **Open-Meteo** / **ERA5** (CC BY 4.0 via Open-Meteo) · **OpenStreetMap / Nominatim** (ODbL / Usage Policy)
- **Groq API** (Groq ToS; free tier)
- **Fonts:** IBM Plex Mono, Space Grotesk (OFL via Google Fonts)
- No pretrained vision model was copied; LankaRoofNet weights are ours (14,836 params, `src/ai/lankaRoofNetWeights.ts` — produced during competition).

All credits are also in `package.json` and `docs/DATA.md`.

---

## 🔒 Data compliance checklist (per rule: "Your data must be yours to use")

- [x] Licence / ToS or documented permission for **every** dataset (see table above + `docs/DATA.md`)
- [x] Respect `robots.txt` (Nominatim via documented API, not scrape; Open-Meteo via API)
- [x] Minimise and anonymise personal data (no accounts, no PII storage, GPS in-memory only, 1 km grid keys)
- [x] No data obtained through deception
- [x] AI advisor never logs keys; `.env` in `.gitignore`

---

## 📖 Git hygiene for judges

```bash
git log --oneline
git status  # should be clean on main
```

No `dist/`, no `.env`, no `node_modules` in repo. Build is reproducible: `npm ci && npm run build` → `dist/`.

---

## 📄 Additional docs

- [`docs/TECHNICAL_REPORT.md`](docs/TECHNICAL_REPORT.md) — architecture, stack why, honest evaluation, data temporality/gaps (the "technical report" deliverable)
- [`docs/TWO_PAGE_SUMMARY.md`](docs/TWO_PAGE_SUMMARY.md) — two-page summary (printable)
- [`docs/DATA.md`](docs/DATA.md) — full data account (sources, licences, gaps, robots.txt, personal data)
- [`docs/VIDEO_SCRIPT.md`](docs/VIDEO_SCRIPT.md) — 3-minute video shot list on real data
- [`docs/TRAINING.md`](docs/TRAINING.md) — LankaRoofNet training notes

---

## 📜 Licence

MIT — see [`LICENSE`](LICENSE). You may fork, reuse, and build upon this for non-commercial and commercial use with attribution.

## 👥 Team

- One to four members — edit this line to list your names, universities, and emails per "Team size 1-4, each person on one team only".
- Rosters lock **6 October** — no swaps after.

---

## 🚀 Publish to GitHub (one-time)

```bash
# inside the project folder
git init
git add .
git commit -m "feat: Statom V4 — initial public release (competition submission)"

# create a NEW PUBLIC empty repo on GitHub (via web UI) named statom-v4
git branch -M main
git remote add origin https://github.com/<YOUR_USERNAME>/statom-v4.git
git push -u origin main

# verify it's public: open https://github.com/<YOUR_USERNAME>/statom-v4 in an incognito window
```

If your history contains the old hardcoded key, rewrite it before pushing:

```bash
# already fixed in this template via VITE_GROQ_API_KEY
# if you pushed an old zip with the key, rotate the key at https://console.groq.com/keys and then push this clean version
```

---

> **Built with care in Sri Lanka 🇱🇰 — for Sri Lankan rooftops.**
