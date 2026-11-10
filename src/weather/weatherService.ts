import { HouseMetrics, HouseSpec, LngLatPoint } from '../types';
import { applyWeatherNetToDaily } from './lankaWeatherNet';
import {
  getCachedClimateNormals,
  getCachedForecastForToday,
  getCachedModelArtifact,
  getFallbackChampionArtifact,
  getLatestFallbackForecast,
  saveCachedClimateNormals,
  saveCachedForecast,
  StoredModelArtifact,
  toDataGridKey,
  toModelGridKey,
} from './weatherCache';
import {
  buildLearningStateSnapshot,
  initWeatherSelfLearningScheduler,
  triggerSelfLearningForGrid,
} from './weatherSelfLearning';
import {
  CurrentWeather,
  DailyForecastItem,
  HistoricalPairSample,
  HourlyWeatherPoint,
  MonthlyClimateNormal,
  RoofWeatherBundle,
  SoilEnvironmentData,
  SoilHealthStatus,
  WeatherSelfLearningState,
} from './weatherTypes';

const MONTH_SHORTS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];

const DAY_SHORTS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

type Listener = (bundle: RoofWeatherBundle) => void;

const activeBundles = new Map<string, RoofWeatherBundle>();
const listenersByGrid = new Map<string, Set<Listener>>();
const inFlightTasks = new Map<string, Promise<void>>();

function emitBundle(bundle: RoofWeatherBundle) {
  activeBundles.set(bundle.dataGridKey, bundle);
  const subs = listenersByGrid.get(bundle.dataGridKey);
  if (subs) {
    subs.forEach((fn) => fn(bundle));
  }
}

/**
 * Called by weatherSelfLearning whenever a background Daily Learning Cycle starts,
 * completes, or recovers — live-updating every active RoofWeatherBundle in that ~1km cell.
 */
export function notifyModelGridLearningUpdate(
  modelGridKey: string,
  activeArtifact: StoredModelArtifact | null,
  learningState: WeatherSelfLearningState
): void {
  for (const bundle of activeBundles.values()) {
    if (bundle.modelGridKey !== modelGridKey) continue;

    const weights = activeArtifact?.weights ?? bundle.model.weights;
    const accuracy = activeArtifact?.accuracy ?? bundle.model.accuracy;
    const enrichedDaily = weights ? applyWeatherNetToDaily(bundle.daily, weights) : bundle.daily;

    const nextStatus: RoofWeatherBundle['model']['status'] = weights
      ? 'ready'
      : learningState.isRunningCycle
      ? 'calibrating'
      : bundle.model.status;

    emitBundle({
      ...bundle,
      daily: enrichedDaily,
      model: {
        status: nextStatus,
        weights: weights ?? null,
        accuracy: accuracy ?? null,
        useCorrectedDefault: Boolean(accuracy?.beatsRaw),
      },
      learning: learningState,
    });
  }
}

export function getColomboTodayIso(): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Colombo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function shiftIsoDate(isoDate: string, deltaDays: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function dayOfYear(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}

function formatDayShort(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return DAY_SHORTS[wd] || 'DAY';
}

export function classifySoilHealth(moistureM3M3: number): {
  health: SoilHealthStatus;
  healthNote: string;
} {
  if (moistureM3M3 >= 0.24) {
    return {
      health: 'GOOD',
      healthNote: 'OPTIMAL ROOT-ZONE HYDRATION & THERMAL BUFFERING',
    };
  }
  if (moistureM3M3 >= 0.14) {
    return {
      health: 'MODERATE',
      healthNote: 'BALANCED TOPSOIL MOISTURE · MONITOR DRY SPELLS',
    };
  }
  return {
    health: 'DRY',
    healthNote: 'LOW TOPSOIL MOISTURE · IRRIGATION / MULCH ADVISED',
  };
}

async function fetchLocationLabel(lat: number, lng: number): Promise<string> {
  try {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat.toFixed(
        5
      )}&longitude=${lng.toFixed(5)}&localityLanguage=en`
    );
    if (!res.ok) throw new Error('reverse geocode status');
    const data = await res.json();
    const locality = (data.locality || data.city || '').trim();
    const region = (data.principalSubdivision || '').trim();
    if (locality && region) return `${locality}, ${region}`.toUpperCase();
    if (locality) return `${locality}, SRI LANKA`.toUpperCase();
    if (region) return `${region}, SRI LANKA`.toUpperCase();
  } catch {
    // ignore and use Sri Lanka coordinate label
  }
  return 'SRI LANKA MICROCLIMATE CELL';
}

export function buildClearSkyFallbackDay(dateIso?: string): DailyForecastItem {
  const dt = dateIso || getColomboTodayIso();
  const hourly: HourlyWeatherPoint[] = Array.from({ length: 24 }, (_, h) => {
    const hh = String(h).padStart(2, '0');
    const sunCurve = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));
    const temp = Number((24.5 + 6.8 * sunCurve).toFixed(1));
    const feels = Number((temp + 2.6 + 1.8 * sunCurve).toFixed(1));
    return {
      timeIso: `${dt}T${hh}:00`,
      hourLabel: `${hh}:00`,
      temperatureC: temp,
      feelsLikeC: feels,
      rainMm: 0,
      rainProbPct: 5,
      cloudCoverPct: Math.round(14 + 12 * sunCurve),
      windSpeedKmh: Number((7 + 6 * sunCurve).toFixed(1)),
      windDirectionDeg: 235,
      humidityPct: Math.round(86 - 22 * sunCurve),
      weatherCode: h >= 11 && h <= 15 ? 1 : 0,
      shortwaveWm2: Math.round(860 * sunCurve),
    };
  });

  return {
    date: dt,
    dayShort: 'TODAY',
    weatherCode: 1,
    rawTempMaxC: 31.3,
    rawTempMinC: 24.5,
    rawRainSumMm: 0,
    rainProbMaxPct: 10,
    windMaxKmh: 13,
    humidityMeanPct: 76,
    pressureMeanHpa: 1010,
    solarRadiationWhm2: 5850,
    hourly,
  };
}

async function fetchOpenMeteoForecast(lat: number, lng: number) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(5)}&longitude=${lng.toFixed(5)}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m,soil_temperature_0_to_7cm,soil_moisture_0_to_7cm` +
    `&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,cloud_cover,wind_speed_10m,wind_direction_10m,relative_humidity_2m,weather_code,shortwave_radiation,soil_temperature_0_to_7cm,soil_moisture_0_to_7cm` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,shortwave_radiation_sum,wind_speed_10m_max,relative_humidity_2m_mean,surface_pressure_mean` +
    `&forecast_days=7&timezone=Asia%2FColombo`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Forecast HTTP ${res.status}`);
  const json = await res.json();

  const c = json.current || {};
  const current: CurrentWeather = {
    timeIso: String(c.time || ''),
    temperatureC: Number(c.temperature_2m ?? 28),
    feelsLikeC: Number(c.apparent_temperature ?? c.temperature_2m ?? 30),
    humidityPct: Number(c.relative_humidity_2m ?? 78),
    rainMm: Number(c.rain ?? c.precipitation ?? 0),
    precipitationMm: Number(c.precipitation ?? 0),
    windSpeedKmh: Number(c.wind_speed_10m ?? 8),
    windDirectionDeg: Number(c.wind_direction_10m ?? 225),
    pressureHpa: Number(c.surface_pressure ?? 1010),
    cloudCoverPct: Number(c.cloud_cover ?? 50),
    weatherCode: Number(c.weather_code ?? 1),
  };

  const hourly = json.hourly || {};
  const hTimes: string[] = hourly.time || [];
  let soilMoisture: number | null =
    typeof c.soil_moisture_0_to_7cm === 'number' ? c.soil_moisture_0_to_7cm : null;
  let soilTemp: number | null =
    typeof c.soil_temperature_0_to_7cm === 'number' ? c.soil_temperature_0_to_7cm : null;

  if (soilMoisture === null && Array.isArray(hourly.soil_moisture_0_to_7cm)) {
    const found = hourly.soil_moisture_0_to_7cm.find((v: unknown) => typeof v === 'number');
    if (typeof found === 'number') soilMoisture = found;
  }
  if (soilTemp === null && Array.isArray(hourly.soil_temperature_0_to_7cm)) {
    const found = hourly.soil_temperature_0_to_7cm.find((v: unknown) => typeof v === 'number');
    if (typeof found === 'number') soilTemp = found;
  }

  const finalMoisture = Number((soilMoisture ?? 0.28).toFixed(3));
  const finalSoilTemp = Number((soilTemp ?? current.temperatureC).toFixed(1));
  const { health, healthNote } = classifySoilHealth(finalMoisture);
  const soil: SoilEnvironmentData = {
    moistureM3M3: finalMoisture,
    temperatureC: finalSoilTemp,
    health,
    healthNote,
  };

  const hourlyByDate = new Map<string, HourlyWeatherPoint[]>();
  for (let i = 0; i < hTimes.length; i++) {
    const tIso = hTimes[i];
    const dKey = tIso.slice(0, 10);
    const hourLabel = tIso.slice(11, 16) || '00:00';
    const tempVal = Number(hourly.temperature_2m?.[i] ?? 27);
    const pt: HourlyWeatherPoint = {
      timeIso: tIso,
      hourLabel,
      temperatureC: tempVal,
      feelsLikeC: Number(hourly.apparent_temperature?.[i] ?? tempVal + 2.5),
      rainMm: Number(hourly.precipitation?.[i] ?? 0),
      rainProbPct: Number(hourly.precipitation_probability?.[i] ?? 0),
      cloudCoverPct: Number(hourly.cloud_cover?.[i] ?? 35),
      windSpeedKmh: Number(hourly.wind_speed_10m?.[i] ?? 9),
      windDirectionDeg: Number(hourly.wind_direction_10m?.[i] ?? 225),
      humidityPct: Number(hourly.relative_humidity_2m?.[i] ?? 78),
      weatherCode: Number(hourly.weather_code?.[i] ?? 1),
      shortwaveWm2: Number(hourly.shortwave_radiation?.[i] ?? 0),
    };
    const arr = hourlyByDate.get(dKey);
    if (arr) arr.push(pt);
    else hourlyByDate.set(dKey, [pt]);
  }

  const d = json.daily || {};
  const dTimes: string[] = d.time || [];
  const daily: DailyForecastItem[] = dTimes.map((dateStr, idx) => {
    const dayHourly = hourlyByDate.get(dateStr) || [];
    const hourlyWhSum = dayHourly.reduce((acc, h) => acc + Math.max(0, h.shortwaveWm2), 0);
    const mjSum = Number(d.shortwave_radiation_sum?.[idx] ?? 0);
    const solarWhm2 = Math.round(hourlyWhSum > 50 ? hourlyWhSum : mjSum * 277.778);

    return {
      date: dateStr,
      dayShort: idx === 0 ? 'TODAY' : formatDayShort(dateStr),
      weatherCode: Number(d.weather_code?.[idx] ?? 1),
      rawTempMaxC: Number(d.temperature_2m_max?.[idx] ?? 30),
      rawTempMinC: Number(d.temperature_2m_min?.[idx] ?? 24),
      rawRainSumMm: Number(d.precipitation_sum?.[idx] ?? 0),
      rainProbMaxPct: Number(d.precipitation_probability_max?.[idx] ?? 0),
      windMaxKmh: Number(d.wind_speed_10m_max?.[idx] ?? 12),
      humidityMeanPct: Number(d.relative_humidity_2m_mean?.[idx] ?? 78),
      pressureMeanHpa: Number(d.surface_pressure_mean?.[idx] ?? 1010),
      solarRadiationWhm2: solarWhm2,
      hourly: dayHourly,
    };
  });

  const serverDateIso = current.timeIso.slice(0, 10) || dTimes[0] || getColomboTodayIso();

  return {
    elevationM: Number(json.elevation ?? 15),
    serverDateIso,
    current,
    daily,
    soil,
  };
}

/**
 * Fetches multi-year ERA5 archive data to compute 12-month long-term climate normals
 * AND returns all non-null ERA5 daily observations so calibration doesn't re-download them.
 */
async function fetchMultiYearArchiveAndNormals(
  lat: number,
  lng: number,
  endDateIso: string
): Promise<{
  normals: MonthlyClimateNormal[];
  yearsSpan: string;
  era5ByDate: Map<string, { aTempMaxC: number; aTempMinC: number; aRainMm: number }>;
}> {
  const endYear = Number(endDateIso.slice(0, 4));
  const startYear = endYear - 5;
  const startDateIso = `${startYear}-01-01`;

  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&start_date=${startDateIso}&end_date=${endDateIso}` +
    `&models=era5&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,shortwave_radiation_sum&timezone=Asia%2FColombo`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Archive HTTP ${res.status}`);
  const json = await res.json();

  const times: string[] = json.daily?.time || [];
  const tMaxArr: (number | null)[] = json.daily?.temperature_2m_max || [];
  const tMinArr: (number | null)[] = json.daily?.temperature_2m_min || [];
  const rainArr: (number | null)[] = json.daily?.precipitation_sum || [];
  const swMjArr: (number | null)[] = json.daily?.shortwave_radiation_sum || [];

  const ymBuckets = new Map<
    string,
    {
      monthIdx: number;
      days: number;
      rainSum: number;
      tMaxSum: number;
      tMinSum: number;
      ghiKwhSum: number;
      ghiDays: number;
    }
  >();
  const era5ByDate = new Map<
    string,
    { aTempMaxC: number; aTempMinC: number; aRainMm: number }
  >();

  for (let i = 0; i < times.length; i++) {
    const dt = times[i];
    const tmax = tMaxArr[i];
    const tmin = tMinArr[i];
    const rain = rainArr[i];
    const swMj = swMjArr[i];
    if (tmax == null || tmin == null || rain == null) continue;

    era5ByDate.set(dt, { aTempMaxC: tmax, aTempMinC: tmin, aRainMm: rain });

    const ym = dt.slice(0, 7);
    const mIdx = Number(dt.slice(5, 7)) - 1;
    const ghiKwh = swMj != null && Number.isFinite(swMj) ? Math.max(0, swMj / 3.6) : null;
    const b = ymBuckets.get(ym);
    if (b) {
      b.days += 1;
      b.rainSum += rain;
      b.tMaxSum += tmax;
      b.tMinSum += tmin;
      if (ghiKwh !== null) {
        b.ghiKwhSum += ghiKwh;
        b.ghiDays += 1;
      }
    } else {
      ymBuckets.set(ym, {
        monthIdx: mIdx,
        days: 1,
        rainSum: rain,
        tMaxSum: tmax,
        tMinSum: tmin,
        ghiKwhSum: ghiKwh ?? 0,
        ghiDays: ghiKwh !== null ? 1 : 0,
      });
    }
  }

  // Typical Sri Lanka monthly daily GHI fallback (kWh/m²/day) if any single month lacks swMj
  const slMonthlyGhiFallback = [5.05, 5.55, 5.78, 5.32, 4.72, 4.58, 4.68, 4.88, 4.95, 4.62, 4.48, 4.68];

  const monthAgg = Array.from({ length: 12 }, (_, m) => ({
    monthIdx: m,
    ymCount: 0,
    rainTotalSum: 0,
    tMaxMeanSum: 0,
    tMinMeanSum: 0,
    ghiDailyMeanSum: 0,
    ghiYmCount: 0,
  }));

  for (const b of ymBuckets.values()) {
    if (b.days < 25) continue;
    const target = monthAgg[b.monthIdx];
    target.ymCount += 1;
    target.rainTotalSum += b.rainSum;
    target.tMaxMeanSum += b.tMaxSum / b.days;
    target.tMinMeanSum += b.tMinSum / b.days;
    if (b.ghiDays >= 20) {
      target.ghiDailyMeanSum += b.ghiKwhSum / b.ghiDays;
      target.ghiYmCount += 1;
    }
  }

  const normals: MonthlyClimateNormal[] = monthAgg.map((m) => {
    const denom = Math.max(1, m.ymCount);
    const meanGhi =
      m.ghiYmCount > 0
        ? Number((m.ghiDailyMeanSum / m.ghiYmCount).toFixed(2))
        : slMonthlyGhiFallback[m.monthIdx];
    return {
      monthIndex: m.monthIdx,
      monthShort: MONTH_SHORTS[m.monthIdx],
      totalRainfallMm: Math.round(m.rainTotalSum / denom),
      meanTempMaxC: Number((m.tMaxMeanSum / denom).toFixed(1)),
      meanTempMinC: Number((m.tMinMeanSum / denom).toFixed(1)),
      meanDailyGhiKwhM2: meanGhi,
    };
  });

  return {
    normals,
    yearsSpan: `${startYear}–${endYear}`,
    era5ByDate,
  };
}

/**
 * Fetches historical NWP forecast vs finalized ERA5 pairs over [startDateIso .. endDateIso].
 */
export async function fetchHistoricalPairsRange(
  lat: number,
  lng: number,
  startDateIso: string,
  endDateIso: string,
  existingEra5?: Map<string, { aTempMaxC: number; aTempMinC: number; aRainMm: number }>
): Promise<HistoricalPairSample[]> {
  const hfUrl =
    `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&start_date=${startDateIso}&end_date=${endDateIso}` +
    `&models=gfs_seamless&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,relative_humidity_2m_mean,surface_pressure_mean&timezone=Asia%2FColombo`;

  const needEra5Fetch = !existingEra5 || existingEra5.size === 0;

  const [hfJson, arJson] = await Promise.all([
    fetch(hfUrl).then((r) => {
      if (!r.ok) throw new Error(`HistForecast HTTP ${r.status}`);
      return r.json();
    }),
    needEra5Fetch
      ? fetch(
          `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
            `&start_date=${startDateIso}&end_date=${endDateIso}` +
            `&models=era5&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Asia%2FColombo`
        ).then((r) => {
          if (!r.ok) throw new Error(`Archive HTTP ${r.status}`);
          return r.json();
        })
      : Promise.resolve(null),
  ]);

  const era5Map = new Map<string, { aTempMaxC: number; aTempMinC: number; aRainMm: number }>();
  if (existingEra5) {
    for (const [k, v] of existingEra5.entries()) {
      era5Map.set(k, v);
    }
  }
  if (arJson) {
    const aTimes: string[] = arJson.daily?.time || [];
    for (let i = 0; i < aTimes.length; i++) {
      const tmax = arJson.daily.temperature_2m_max?.[i];
      const tmin = arJson.daily.temperature_2m_min?.[i];
      const rain = arJson.daily.precipitation_sum?.[i];
      if (tmax != null && tmin != null && rain != null) {
        era5Map.set(aTimes[i], { aTempMaxC: tmax, aTempMinC: tmin, aRainMm: rain });
      }
    }
  }

  const samples: HistoricalPairSample[] = [];
  const fTimes: string[] = hfJson.daily?.time || [];
  for (let i = 0; i < fTimes.length; i++) {
    const dt = fTimes[i];
    const actual = era5Map.get(dt);
    const fTmax = hfJson.daily.temperature_2m_max?.[i];
    const fTmin = hfJson.daily.temperature_2m_min?.[i];
    if (!actual || fTmax == null || fTmin == null) continue;

    samples.push({
      date: dt,
      doy: dayOfYear(dt),
      fTempMaxC: Number(fTmax),
      fTempMinC: Number(fTmin),
      fHumidityPct: Number(hfJson.daily.relative_humidity_2m_mean?.[i] ?? 78),
      fPressureHpa: Number(hfJson.daily.surface_pressure_mean?.[i] ?? 1010),
      fWindMaxKmh: Number(hfJson.daily.wind_speed_10m_max?.[i] ?? 11),
      fRainMm: Number(hfJson.daily.precipitation_sum?.[i] ?? 0),
      aTempMaxC: actual.aTempMaxC,
      aTempMinC: actual.aTempMinC,
      aRainMm: actual.aRainMm,
    });
  }

  return samples;
}

/**
 * Fetches provisional actuals for the last ~10 days (covering ERA5 lag window) from
 * Open-Meteo `/v1/forecast?past_days=10` and joins them with historical GFS forecast features.
 */
export async function fetchProvisionalRecentPairs(
  lat: number,
  lng: number,
  startDateIso: string,
  endDateIso: string
): Promise<HistoricalPairSample[]> {
  if (startDateIso > endDateIso) return [];

  const provActualsUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&past_days=10&forecast_days=1` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Asia%2FColombo`;

  const hfUrl =
    `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&start_date=${startDateIso}&end_date=${endDateIso}` +
    `&models=gfs_seamless&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,relative_humidity_2m_mean,surface_pressure_mean&timezone=Asia%2FColombo`;

  const [provJson, hfJson] = await Promise.all([
    fetch(provActualsUrl).then((r) => {
      if (!r.ok) throw new Error(`Provisional actuals HTTP ${r.status}`);
      return r.json();
    }),
    fetch(hfUrl).then((r) => {
      if (!r.ok) throw new Error(`HistForecast prov HTTP ${r.status}`);
      return r.json();
    }),
  ]);

  const provMap = new Map<string, { aTempMaxC: number; aTempMinC: number; aRainMm: number }>();
  const pTimes: string[] = provJson.daily?.time || [];
  for (let i = 0; i < pTimes.length; i++) {
    const dt = pTimes[i];
    if (dt < startDateIso || dt > endDateIso) continue;
    const tmax = provJson.daily.temperature_2m_max?.[i];
    const tmin = provJson.daily.temperature_2m_min?.[i];
    const rain = provJson.daily.precipitation_sum?.[i];
    if (tmax != null && tmin != null && rain != null) {
      provMap.set(dt, {
        aTempMaxC: Number(tmax),
        aTempMinC: Number(tmin),
        aRainMm: Number(rain),
      });
    }
  }

  const samples: HistoricalPairSample[] = [];
  const fTimes: string[] = hfJson.daily?.time || [];
  for (let i = 0; i < fTimes.length; i++) {
    const dt = fTimes[i];
    if (dt < startDateIso || dt > endDateIso) continue;
    const actual = provMap.get(dt);
    const fTmax = hfJson.daily.temperature_2m_max?.[i];
    const fTmin = hfJson.daily.temperature_2m_min?.[i];
    if (!actual || fTmax == null || fTmin == null) continue;

    samples.push({
      date: dt,
      doy: dayOfYear(dt),
      fTempMaxC: Number(fTmax),
      fTempMinC: Number(fTmin),
      fHumidityPct: Number(hfJson.daily.relative_humidity_2m_mean?.[i] ?? 78),
      fPressureHpa: Number(hfJson.daily.surface_pressure_mean?.[i] ?? 1010),
      fWindMaxKmh: Number(hfJson.daily.wind_speed_10m_max?.[i] ?? 11),
      fRainMm: Number(hfJson.daily.precipitation_sum?.[i] ?? 0),
      aTempMaxC: actual.aTempMaxC,
      aTempMinC: actual.aTempMinC,
      aRainMm: actual.aRainMm,
      provisional: true,
    });
  }

  return samples;
}

function createInitialSkeletonBundle(lat: number, lng: number): RoofWeatherBundle {
  const dataGridKey = toDataGridKey(lat, lng);
  const modelGridKey = toModelGridKey(lat, lng);
  return {
    dataGridKey,
    modelGridKey,
    lat,
    lng,
    elevationM: 0,
    locationLabel: 'LOCATING MICROCLIMATE CELL…',
    sourceBadge: 'LIVE',
    fetchedAtIso: new Date().toISOString(),
    current: null,
    daily: [],
    soil: null,
    climateNormals: [],
    climateYearsSpan: '',
    model: {
      status: 'calibrating',
      weights: null,
      accuracy: null,
      useCorrectedDefault: false,
    },
    isLoadingForecast: true,
    isLoadingClimate: true,
  };
}

/**
 * Starts silent background fetching + caching + LankaWeatherNet Daily Self-Learning
 * as soon as a roof is selected on the map. Never blocks the UI.
 */
export function prefetchWeatherForPoint(centroidLngLat: LngLatPoint): void {
  // Ensure global daily heartbeat scheduler is active
  initWeatherSelfLearningScheduler();

  const [lng, lat] = centroidLngLat;
  const dataGridKey = toDataGridKey(lat, lng);

  if (inFlightTasks.has(dataGridKey)) return;

  const task = (async () => {
    const modelGridKey = toModelGridKey(lat, lng);
    const localTodayKey = getColomboTodayIso();

    let bundle = activeBundles.get(dataGridKey) || createInitialSkeletonBundle(lat, lng);
    emitBundle(bundle);

    // Hydrate cached champion model & learning journal immediately (<5ms) if present!
    const [priorChampion, fallbackChampion, initialLearningSnap] = await Promise.all([
      getCachedModelArtifact(modelGridKey),
      getFallbackChampionArtifact(modelGridKey),
      buildLearningStateSnapshot(modelGridKey),
    ]);
    const activeChampion = priorChampion ?? fallbackChampion ?? null;
    if (activeChampion) {
      bundle = {
        ...bundle,
        model: {
          status: 'ready',
          weights: activeChampion.weights,
          accuracy: activeChampion.accuracy,
          useCorrectedDefault: activeChampion.accuracy.beatsRaw,
        },
        learning: initialLearningSnap,
      };
      emitBundle(bundle);
    } else {
      bundle = {
        ...bundle,
        learning: initialLearningSnap,
      };
      emitBundle(bundle);
    }

    // STEP 1: Forecast + Soil + Location (IndexedDB cache first, then Open-Meteo Forecast API)
    let serverTodayIso = localTodayKey;
    const cachedToday = await getCachedForecastForToday(dataGridKey, localTodayKey);

    if (cachedToday && cachedToday.current && cachedToday.daily.length > 0) {
      serverTodayIso = cachedToday.dateKey;
      const dailyWithNet = activeChampion
        ? applyWeatherNetToDaily(cachedToday.daily, activeChampion.weights)
        : cachedToday.daily;
      bundle = {
        ...bundle,
        elevationM: cachedToday.elevationM,
        locationLabel: cachedToday.locationLabel,
        sourceBadge: 'CACHED',
        fetchedAtIso: cachedToday.fetchedAtIso,
        current: cachedToday.current,
        daily: dailyWithNet,
        soil: cachedToday.soil,
        isLoadingForecast: false,
      };
      emitBundle(bundle);
    } else {
      try {
        const [wx, label] = await Promise.all([
          fetchOpenMeteoForecast(lat, lng),
          fetchLocationLabel(lat, lng),
        ]);
        serverTodayIso = wx.serverDateIso;
        const fetchedAtIso = new Date().toISOString();

        await saveCachedForecast(dataGridKey, localTodayKey, {
          dateKey: serverTodayIso,
          elevationM: wx.elevationM,
          locationLabel: label,
          fetchedAtIso,
          current: wx.current,
          daily: wx.daily,
          soil: wx.soil,
        });

        const dailyWithNet = activeChampion
          ? applyWeatherNetToDaily(wx.daily, activeChampion.weights)
          : wx.daily;

        bundle = {
          ...bundle,
          elevationM: wx.elevationM,
          locationLabel: label,
          sourceBadge: 'LIVE',
          fetchedAtIso,
          current: wx.current,
          daily: dailyWithNet,
          soil: wx.soil,
          isLoadingForecast: false,
        };
        emitBundle(bundle);
      } catch {
        const fallback = await getLatestFallbackForecast(dataGridKey);
        const rawFallbackDaily =
          fallback?.daily && fallback.daily.length > 0
            ? fallback.daily
            : [buildClearSkyFallbackDay(localTodayKey)];
        const dailyWithNet = activeChampion
          ? applyWeatherNetToDaily(rawFallbackDaily, activeChampion.weights)
          : rawFallbackDaily;

        bundle = {
          ...bundle,
          elevationM: fallback?.elevationM ?? 15,
          locationLabel: fallback?.locationLabel ?? 'SRI LANKA OFFLINE CACHE',
          sourceBadge: 'OFFLINE',
          fetchedAtIso: fallback?.fetchedAtIso ?? bundle.fetchedAtIso,
          current: fallback?.current ?? null,
          daily: dailyWithNet,
          soil: fallback?.soil ?? null,
          isLoadingForecast: false,
        };
        emitBundle(bundle);
      }
    }

    const yesterdayIso = shiftIsoDate(serverTodayIso, -1);
    const currentMonthKey = serverTodayIso.slice(0, 7);

    // STEP 2: 12-Month Climate Normals (IndexedDB cache or 5+ year ERA5 Archive aggregation)
    let freshEra5Map:
      | Map<string, { aTempMaxC: number; aTempMinC: number; aRainMm: number }>
      | undefined;

    const cachedClimate = await getCachedClimateNormals(modelGridKey);
    if (
      cachedClimate &&
      cachedClimate.normals.length === 12 &&
      cachedClimate.updatedMonthKey === currentMonthKey
    ) {
      bundle = {
        ...bundle,
        climateNormals: cachedClimate.normals,
        climateYearsSpan: cachedClimate.yearsSpan,
        isLoadingClimate: false,
      };
      emitBundle(bundle);
    } else {
      try {
        const arch = await fetchMultiYearArchiveAndNormals(lat, lng, yesterdayIso);
        freshEra5Map = arch.era5ByDate;
        await saveCachedClimateNormals(modelGridKey, {
          modelGridKey,
          yearsSpan: arch.yearsSpan,
          normals: arch.normals,
          updatedMonthKey: currentMonthKey,
        });
        bundle = {
          ...bundle,
          climateNormals: arch.normals,
          climateYearsSpan: arch.yearsSpan,
          isLoadingClimate: false,
        };
        emitBundle(bundle);
      } catch {
        bundle = {
          ...bundle,
          climateNormals: cachedClimate?.normals ?? [],
          climateYearsSpan: cachedClimate?.yearsSpan ?? '',
          sourceBadge: cachedClimate ? 'OFFLINE' : bundle.sourceBadge,
          isLoadingClimate: false,
        };
        emitBundle(bundle);
      }
    }

    // STEP 3: Trigger Daily Self-Learning Cycle (runs if new Colombo day or no model yet)
    await triggerSelfLearningForGrid(modelGridKey, {
      lat,
      lng,
      freshEra5Map,
    });
  })().finally(() => {
    inFlightTasks.delete(dataGridKey);
  });

  inFlightTasks.set(dataGridKey, task);
}

/**
 * Subscribes a UI component to live weather/climate/calibration updates for a roof centroid.
 */
export function subscribeWeatherForPoint(
  centroidLngLat: LngLatPoint,
  listener: Listener
): () => void {
  const [lng, lat] = centroidLngLat;
  const dataGridKey = toDataGridKey(lat, lng);

  let set = listenersByGrid.get(dataGridKey);
  if (!set) {
    set = new Set();
    listenersByGrid.set(dataGridKey, set);
  }
  set.add(listener);

  const existing = activeBundles.get(dataGridKey);
  if (existing) {
    listener(existing);
    // Also check if a new Colombo day started since this bundle was first loaded
    void triggerSelfLearningForGrid(existing.modelGridKey, {
      lat: existing.lat,
      lng: existing.lng,
    });
  } else {
    prefetchWeatherForPoint(centroidLngLat);
  }

  return () => {
    set?.delete(listener);
  };
}

export interface RoofImpactSummary {
  materialLabel: string;
  runoffCoefficient: number;
  monthlyHarvestLitres: { monthShort: string; litres: number; rainfallMm: number }[];
  annualHarvestLitres: number;
  peakMonthHarvestLitres: number;
  next7DaysHarvestLitres: number;
  slopedRoofAreaSqm: number;
  todayHorizontalWhm2: number;
  tiltedSolarKwhPerDay: number;
  estimatedPvKwhPerDay: number;
}

export function computeRoofImpact(
  spec: HouseSpec,
  metrics: HouseMetrics,
  bundle: RoofWeatherBundle | null,
  useCorrected: boolean
): RoofImpactSummary {
  const matHint =
    spec.detectedMaterialHint ?? (spec.roofStyle === 'flat' ? 'concrete' : 'terracotta');

  const runoffCoefficient =
    matHint === 'metal' ? 0.85 : matHint === 'concrete' ? 0.9 : 0.8;

  const materialLabel =
    matHint === 'metal'
      ? 'METAL SHEET (0.85)'
      : matHint === 'concrete'
      ? 'CONCRETE SLAB (0.90)'
      : 'TERRACOTTA TILE (0.80)';

  const normals = bundle?.climateNormals || [];
  const monthlyHarvestLitres = normals.map((m) => ({
    monthShort: m.monthShort,
    rainfallMm: m.totalRainfallMm,
    litres: Math.round(metrics.areaSqm * m.totalRainfallMm * runoffCoefficient),
  }));

  const annualHarvestLitres = monthlyHarvestLitres.reduce((acc, m) => acc + m.litres, 0);
  const peakMonthHarvestLitres = monthlyHarvestLitres.reduce(
    (mx, m) => Math.max(mx, m.litres),
    0
  );

  const daily = bundle?.daily || [];
  const next7RainMm = daily.reduce((acc, d) => {
    const r =
      useCorrected && d.correctedRainSumMm !== undefined ? d.correctedRainSumMm : d.rawRainSumMm;
    return acc + r;
  }, 0);
  const next7DaysHarvestLitres = Math.round(metrics.areaSqm * next7RainMm * runoffCoefficient);

  const pitchRad = (Math.min(60, Math.max(0, spec.roofPitchDeg)) * Math.PI) / 180;
  const slopedRoofAreaSqm = Number((metrics.areaSqm / Math.max(0.5, Math.cos(pitchRad))).toFixed(1));

  const todayHorizontalWhm2 = daily[0]?.solarRadiationWhm2 ?? 0;
  const latDeg = metrics.centroid[1];
  const tiltIncidenceFactor = Math.max(
    0.78,
    Math.cos(((spec.roofPitchDeg - latDeg) * Math.PI) / 180) *
      (spec.roofStyle === 'hip' ? 0.94 : 0.97)
  );

  const tiltedSolarKwhPerDay = Number(
    ((todayHorizontalWhm2 * tiltIncidenceFactor * slopedRoofAreaSqm) / 1000).toFixed(1)
  );
  const estimatedPvKwhPerDay = Number((tiltedSolarKwhPerDay * 0.109).toFixed(1));

  return {
    materialLabel,
    runoffCoefficient,
    monthlyHarvestLitres,
    annualHarvestLitres,
    peakMonthHarvestLitres,
    next7DaysHarvestLitres,
    slopedRoofAreaSqm,
    todayHorizontalWhm2,
    tiltedSolarKwhPerDay,
    estimatedPvKwhPerDay,
  };
}

/**
 * Loads cached or live 12-month ERA5 climate normals (including meanDailyGhiKwhM2 from
 * shortwave_radiation_sum) for rooftop solar simulation without duplicating fetches.
 */
export async function loadMonthlySolarClimateNormals(
  centroidLngLat: LngLatPoint
): Promise<{
  normals: MonthlyClimateNormal[];
  yearsSpan: string;
  source: 'LIVE' | 'CACHED' | 'OFFLINE';
}> {
  const [lng, lat] = centroidLngLat;
  const dataGridKey = toDataGridKey(lat, lng);
  const modelGridKey = toModelGridKey(lat, lng);
  const todayIso = getColomboTodayIso();
  const currentMonthKey = todayIso.slice(0, 7);

  const active = activeBundles.get(dataGridKey);
  if (active && active.climateNormals.length === 12 && active.climateNormals[0]?.meanDailyGhiKwhM2 > 0) {
    return {
      normals: active.climateNormals,
      yearsSpan: active.climateYearsSpan || 'ERA5 ARCHIVE',
      source: active.sourceBadge,
    };
  }

  const cached = await getCachedClimateNormals(modelGridKey);
  if (
    cached &&
    cached.normals.length === 12 &&
    cached.updatedMonthKey === currentMonthKey &&
    cached.normals[0]?.meanDailyGhiKwhM2 > 0
  ) {
    return {
      normals: cached.normals,
      yearsSpan: cached.yearsSpan,
      source: 'CACHED',
    };
  }

  try {
    const yesterdayIso = shiftIsoDate(todayIso, -1);
    const arch = await fetchMultiYearArchiveAndNormals(lat, lng, yesterdayIso);
    await saveCachedClimateNormals(modelGridKey, {
      modelGridKey,
      yearsSpan: arch.yearsSpan,
      normals: arch.normals,
      updatedMonthKey: currentMonthKey,
    });
    return {
      normals: arch.normals,
      yearsSpan: arch.yearsSpan,
      source: 'LIVE',
    };
  } catch {
    if (cached && cached.normals.length === 12 && cached.normals[0]?.meanDailyGhiKwhM2 > 0) {
      return {
        normals: cached.normals,
        yearsSpan: cached.yearsSpan,
        source: 'OFFLINE',
      };
    }

    // Regional Sri Lanka GHI fallback (slightly brighter in northern/eastern dry zone vs SW wet zone)
    const dryZoneBoost = lat > 7.9 || lng > 80.75 ? 1.08 : 1.0;
    const baseGhi = [5.05, 5.55, 5.78, 5.32, 4.72, 4.58, 4.68, 4.88, 4.95, 4.62, 4.48, 4.68];
    const baseRain = [90, 75, 130, 240, 310, 210, 145, 135, 220, 345, 320, 175];
    return {
      normals: MONTH_SHORTS.map((monthShort, idx) => ({
        monthIndex: idx,
        monthShort,
        totalRainfallMm: baseRain[idx],
        meanTempMaxC: 31.0,
        meanTempMinC: 24.5,
        meanDailyGhiKwhM2: Number((baseGhi[idx] * dryZoneBoost).toFixed(2)),
      })),
      yearsSpan: 'SL REGIONAL CLIMATOLOGY',
      source: 'OFFLINE',
    };
  }
}

