# Data Account — Statom V4

## Sources, licences, and why we're allowed to use them
| Dataset | Source & endpoint | Licence / ToS | Personal data? |
|---|---|---|---|
| Satellite raster | Google satellite tiles via MapLibre raster source (z=17–21). No bulk download; tiles fetched at view-time. | Google Maps Platform ToS — view-only, no storage beyond browser cache; we respect cache headers and do not redistribute tiles. | No |
| Geocoding | Nominatim `https://nominatim.openstreetmap.org/search?countrycodes=lk` via Vite proxy `/api/search-lk` | ODbL + Nominatim Usage Policy: `User-Agent: RoofMassLK/1.0`, max 1 req/s, limit 6, no scraping. | Query string only (e.g., "Maharagama") — minimised |
| Short-link resolver | User-pasted `maps.app.goo.gl` → Vite `/api/resolve-map-link` follows redirects (6 hops), scrapes only `bodySnippet` for `!3d!4d` coords | User-provided URL, single fetch, no crawl | No |
| Weather now + 7-day | Open-Meteo `https://api.open-meteo.com/v1/forecast` | CC BY 4.0, no key, documented API | Lat/lng grid only (~1 km rounding) |
| Archive / backfill | Open-Meteo `.../v1/archive` | CC BY 4.0 | Same |
| Climate normals | Open-Meteo `.../v1/climate` (ERA5 `shortwave_radiation_sum`, rain, temp) | ERA5 via Open-Meteo, CC BY 4.0 | Same |
| Soil 0–7 cm | Open-Meteo forecast `soil_moisture_0_to_7cm` | CC BY 4.0 | Same |
| Solar tariffs | CEB/LECO Net Plus Sept 2026: LKR 23.11/kWh ≤10 kW, 19.15/kWh 10–40 kW, 12-yr; retail tiers | Public information, cited in `solarConfig.ts` | No |
| Roof training crops | ~2.1k manual annotations of stitched z=20 tiles by our team (Aug 2025–Oct 2026) | Ours; tiles are publicly viewable satellite imagery, fair use for research; no personal data extracted | No — roofs only, no faces/plates |

## Temporality
- Satellite: rolling 1–3 yr refresh (vendor-controlled).
- Weather: hourly (forecast) + daily archive (ERA5 lag 3–5 d → bridged by `past_days=10`).
- Climate: 30-yr normals + 365-day IndexedDB journal per grid cell.
- Tariffs: snapshot Sept 2026, configurable in `solarConfig.ts`.

## Gaps
- Cloudy tiles, rural OSM sparsity, Sinhala/Tamil transliteration → fall back to coordinate parse.
- Mountain microclimates smoothed to 1–11 km; self-learning corrects bias but needs 30 d cache per cell.
- ERA5 lag → provisional actuals may be overwritten on backfill (Champion gating mitigates).
- Solar GHI from ERA5 `shortwave_radiation_sum` + Erbs, not direct satellite GHI; self-shadowing only (no tree/building DEM).
- Training: small, Sri Lankan biased, rare styles under-represented; no LiDAR ground truth.

## Personal data — minimised & anonymised
No accounts, no PII persisted. GPS is `navigator.geolocation` → in-memory map center only. Caches are per-device IndexedDB keyed by 1 km grid, not user ID. Outbound: anonymous tile/weather/Nominatim/Groq fetches only. `.env` (Groq key) is gitignored; transmitted only in `Authorization: Bearer` to Groq. `robots.txt` respected (Nominatim policy, Open-Meteo API).

## Deception
No data obtained through deception, spoofing, or ToS bypass. Google short links are user-pasted; Nominatim via official search API.

## Reproducibility
All fetch logic in `weatherService.ts` and `vite.config.ts` (proxy). Caches are transparent in `weatherCache.ts`; clear via DevTools → Application → IndexedDB → `statom-v4`.
