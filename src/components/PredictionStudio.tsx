import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Cloud,
  CloudDrizzle,
  CloudLightning,
  CloudRain,
  CloudSun,
  Cpu,
  Droplets,
  Gauge,
  Navigation,
  RefreshCw,
  Sprout,
  Sun,
  Thermometer,
  TrendingDown,
  WifiOff,
  Wind,
  Zap,
} from 'lucide-react';
import { HouseMetrics, HouseSpec } from '../types';
import { LANKA_WEATHER_NET_PARAMS } from '../weather/lankaWeatherNet';
import {
  computeRoofImpact,
  getColomboTodayIso,
  subscribeWeatherForPoint,
} from '../weather/weatherService';
import {
  DailyForecastItem,
  RoofWeatherBundle,
  WeatherLearningLogEntry,
} from '../weather/weatherTypes';

interface PredictionStudioProps {
  spec: HouseSpec | null;
  metrics: HouseMetrics | null;
  isActive: boolean;
  onBackToStudio: () => void;
}

function degToCompass(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return dirs[idx];
}

function wmoDescription(code: number): string {
  if (code === 0) return 'CLEAR SKY';
  if (code === 1 || code === 2) return 'PARTLY CLOUDY';
  if (code === 3) return 'OVERCAST';
  if (code >= 45 && code <= 48) return 'MIST / FOG';
  if (code >= 51 && code <= 57) return 'LIGHT DRIZZLE';
  if (code >= 61 && code <= 67) return 'MONSOON RAIN';
  if (code >= 80 && code <= 82) return 'RAIN SHOWERS';
  if (code >= 95) return 'THUNDERSTORM';
  return 'TROPICAL SKY';
}

const WeatherCodeIcon: React.FC<{ code: number; className?: string }> = ({
  code,
  className = 'w-5 h-5',
}) => {
  if (code === 0) return <Sun className={className} />;
  if (code === 1 || code === 2) return <CloudSun className={className} />;
  if (code === 3 || (code >= 45 && code <= 48)) return <Cloud className={className} />;
  if (code >= 51 && code <= 57) return <CloudDrizzle className={className} />;
  if (code >= 95) return <CloudLightning className={className} />;
  return <CloudRain className={className} />;
};

function formatLitresCompact(litres: number): string {
  if (litres >= 1_000_000) return `${(litres / 1_000_000).toFixed(2)}M L`;
  if (litres >= 10_000) return `${(litres / 1000).toFixed(1)}K L`;
  return `${litres.toLocaleString()} L`;
}

function isoDateUtcMs(isoDate: string): number {
  const parts = isoDate.split('-');
  if (parts.length !== 3) return 0;
  return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function formatLastTrainedStatus(
  lastTrainedAtIso: string | null | undefined,
  isRunningCycle: boolean | undefined
): string {
  if (isRunningCycle) return 'TRAINING NOW…';
  if (!lastTrainedAtIso) return 'INITIALIZING DAILY LOOP…';

  try {
    const dt = new Date(lastTrainedAtIso);
    if (Number.isNaN(dt.getTime())) return 'TRAINED RECENTLY';

    const trainedDayColombo = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Colombo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(dt);

    const timeColombo = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Colombo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(dt);

    const todayColombo = getColomboTodayIso();
    const diffDays = Math.max(
      0,
      Math.round((isoDateUtcMs(todayColombo) - isoDateUtcMs(trainedDayColombo)) / 86400000)
    );

    if (diffDays === 0) return `LAST TRAINED TODAY ${timeColombo}`;
    if (diffDays === 1) return 'LAST TRAINED 1 DAY AGO';
    return `LAST TRAINED ${diffDays} DAYS AGO`;
  } catch {
    return 'TRAINED TODAY';
  }
}

const LearningJournalSparkline: React.FC<{ journal: WeatherLearningLogEntry[] }> = ({
  journal,
}) => {
  if (journal.length === 0) {
    return (
      <div className="h-16 bg-[#EAE8DF] border border-[#111111]/25 flex items-center justify-center font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
        WAITING FOR FIRST DAILY JOURNAL ENTRY…
      </div>
    );
  }

  const w = 360;
  const h = 64;
  const padL = 34;
  const padR = 34;
  const padT = 10;
  const padB = 12;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const allMae = journal.flatMap((e) => [e.correctedTempMaeC, e.rawTempMaeC]);
  const minVal = Math.max(0, Math.min(...allMae) - 0.12);
  const maxVal = Math.max(minVal + 0.3, Math.max(...allMae) + 0.12);
  const span = Math.max(0.2, maxVal - minVal);

  const xAt = (idx: number) =>
    journal.length === 1
      ? padL + plotW * 0.5
      : padL + (idx / (journal.length - 1)) * plotW;
  const yAt = (val: number) => padT + (1 - (val - minVal) / span) * plotH;

  const corrPoints = journal.map((e, i) => `${xAt(i).toFixed(1)},${yAt(e.correctedTempMaeC).toFixed(1)}`).join(' ');
  const rawPoints = journal.map((e, i) => `${xAt(i).toFixed(1)},${yAt(e.rawTempMaeC).toFixed(1)}`).join(' ');

  const first = journal[0];
  const latest = journal[journal.length - 1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-16 select-none bg-[#F9F8F3] border border-[#111111]">
      {/* Subtle baseline grid */}
      <line
        x1={padL}
        y1={padT}
        x2={w - padR}
        y2={padT}
        stroke="#111111"
        strokeOpacity={0.12}
        strokeDasharray="2,2"
      />
      <line
        x1={padL}
        y1={padT + plotH}
        x2={w - padR}
        y2={padT + plotH}
        stroke="#111111"
        strokeOpacity={0.18}
      />

      {journal.length === 1 ? (
        <>
          <line
            x1={padL}
            y1={yAt(latest.rawTempMaeC)}
            x2={w - padR}
            y2={yAt(latest.rawTempMaeC)}
            stroke="#FF521B"
            strokeWidth="1.4"
            strokeDasharray="3,3"
          />
          <line
            x1={padL}
            y1={yAt(latest.correctedTempMaeC)}
            x2={w - padR}
            y2={yAt(latest.correctedTempMaeC)}
            stroke="#111111"
            strokeWidth="2.2"
          />
          <circle
            cx={xAt(0)}
            cy={yAt(latest.correctedTempMaeC)}
            r="4"
            fill="#E2FF32"
            stroke="#111111"
            strokeWidth="1.6"
          />
        </>
      ) : (
        <>
          {/* Raw MAE dashed comparison */}
          <polyline
            fill="none"
            stroke="#FF521B"
            strokeWidth="1.5"
            strokeDasharray="3,2.5"
            points={rawPoints}
          />
          {/* Corrected Temp MAE downward-learning sparkline */}
          <polyline
            fill="none"
            stroke="#111111"
            strokeWidth="2.4"
            points={corrPoints}
          />
          <circle
            cx={xAt(0)}
            cy={yAt(first.correctedTempMaeC)}
            r="2.8"
            fill="#F9F8F3"
            stroke="#111111"
            strokeWidth="1.4"
          />
          <circle
            cx={xAt(journal.length - 1)}
            cy={yAt(latest.correctedTempMaeC)}
            r="3.8"
            fill="#E2FF32"
            stroke="#111111"
            strokeWidth="1.6"
          />
        </>
      )}

      {/* Left start & right latest Temp MAE labels */}
      <text
        x={padL - 4}
        y={yAt(first.correctedTempMaeC) + 3}
        textAnchor="end"
        fontSize="8.5"
        fontWeight="700"
        fontFamily="IBM Plex Mono, monospace"
        fill="#555550"
      >
        {first.correctedTempMaeC.toFixed(2)}°
      </text>
      <text
        x={w - padR + 4}
        y={yAt(latest.correctedTempMaeC) + 3}
        textAnchor="start"
        fontSize="8.5"
        fontWeight="700"
        fontFamily="IBM Plex Mono, monospace"
        fill="#111111"
      >
        {latest.correctedTempMaeC.toFixed(2)}°
      </text>
    </svg>
  );
};

export const PredictionStudio: React.FC<PredictionStudioProps> = ({
  spec,
  metrics,
  onBackToStudio,
}) => {
  const [bundle, setBundle] = useState<RoofWeatherBundle | null>(null);
  const [selectedDayIdx, setSelectedDayIdx] = useState<number>(0);
  const [hoveredHourIdx, setHoveredHourIdx] = useState<number | null>(null);
  const [manualRawOverride, setManualRawOverride] = useState<boolean | null>(null);
  const [activeTab, setActiveTab] = useState<
    'overview' | 'forecast' | 'climate' | 'roof' | 'model'
  >('overview');

  // Subscribe to background weather + climate + LankaWeatherNet updates for current roof centroid
  useEffect(() => {
    if (!metrics) {
      setBundle(null);
      return;
    }
    setSelectedDayIdx(0);
    setManualRawOverride(null);
    const unsub = subscribeWeatherForPoint(metrics.centroid, (nextBundle) => {
      setBundle({ ...nextBundle });
    });
    return unsub;
  }, [metrics?.centroid[0], metrics?.centroid[1]]);

  const modelBeatsRaw = Boolean(
    bundle?.model.status === 'ready' && bundle?.model.accuracy?.beatsRaw
  );
  const useCorrected =
    manualRawOverride !== null ? !manualRawOverride : modelBeatsRaw;

  const impact = useMemo(() => {
    if (!spec || !metrics) return null;
    return computeRoofImpact(spec, metrics, bundle, useCorrected);
  }, [spec, metrics, bundle, useCorrected]);

  const dailyList = bundle?.daily || [];
  const activeDay: DailyForecastItem | undefined =
    dailyList[Math.min(selectedDayIdx, Math.max(0, dailyList.length - 1))];

  const getDisplayTemps = (d: DailyForecastItem) => {
    if (
      useCorrected &&
      d.correctedTempMaxC !== undefined &&
      d.correctedTempMinC !== undefined
    ) {
      return { max: d.correctedTempMaxC, min: d.correctedTempMinC };
    }
    return { max: d.rawTempMaxC, min: d.rawTempMinC };
  };

  const getDisplayRain = (d: DailyForecastItem) => {
    if (useCorrected && d.correctedRainSumMm !== undefined) {
      return d.correctedRainSumMm;
    }
    return d.rawRainSumMm;
  };

  if (!spec || !metrics) {
    return (
      <div className="w-full h-full bg-[#F2F0E8] flex items-center justify-center p-6">
        <div className="neo-card p-6 bg-[#F9F8F3] max-w-sm text-center space-y-3">
          <CloudSun className="w-8 h-8 mx-auto text-[#FF521B]" />
          <div className="font-mono-tech text-xs font-bold uppercase">
            NO ROOF SELECTED FOR PREDICTION
          </div>
          <button
            type="button"
            onClick={onBackToStudio}
            className="neo-btn px-3.5 py-1.5 bg-[#E2FF32] text-[#111111] font-mono-tech text-xs font-bold uppercase inline-flex items-center gap-1.5 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>BACK TO 3D</span>
          </button>
        </div>
      </div>
    );
  }

  const [lng, lat] = metrics.centroid;
  const current = bundle?.current ?? null;
  const soil = bundle?.soil ?? null;
  const normals = bundle?.climateNormals || [];
  const accuracy = bundle?.model.accuracy ?? null;

  // Hourly SVG geometry for selected day
  const hourlyPts = activeDay?.hourly || [];
  const hChartW = 680;
  const hChartH = 176;
  const padL = 38;
  const padR = 36;
  const padT = 18;
  const padB = 26;
  const plotW = hChartW - padL - padR;
  const plotH = hChartH - padT - padB;

  const hTemps = hourlyPts.map((h) => h.temperatureC);
  const hMinT = hTemps.length ? Math.floor(Math.min(...hTemps) - 1) : 22;
  const hMaxT = hTemps.length ? Math.ceil(Math.max(...hTemps) + 1) : 33;
  const hSpanT = Math.max(2, hMaxT - hMinT);
  const hMaxRain = Math.max(4, ...hourlyPts.map((h) => h.rainMm));

  const tempPolyline = hourlyPts
    .map((h, i) => {
      const x = padL + (i / Math.max(1, hourlyPts.length - 1)) * plotW;
      const y = padT + (1 - (h.temperatureC - hMinT) / hSpanT) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  // Climate 12-month SVG geometry
  const cChartW = 540;
  const cChartH = 168;
  const cPadL = 38;
  const cPadR = 16;
  const cPadT = 16;
  const cPadB = 26;
  const cPlotW = cChartW - cPadL - cPadR;
  const cPlotH = cChartH - cPadT - cPadB;

  const maxClimateRain = Math.max(100, ...normals.map((n) => n.totalRainfallMm));
  const annualClimateRain = normals.reduce((s, n) => s + n.totalRainfallMm, 0);

  const climMinT = normals.length
    ? Math.floor(Math.min(...normals.map((n) => n.meanTempMinC)) - 1.5)
    : 20;
  const climMaxT = normals.length
    ? Math.ceil(Math.max(...normals.map((n) => n.meanTempMaxC)) + 1.5)
    : 34;
  const climSpanT = Math.max(3, climMaxT - climMinT);

  const climMaxLine = normals
    .map((n, i) => {
      const x = cPadL + ((i + 0.5) / 12) * cPlotW;
      const y = cPadT + (1 - (n.meanTempMaxC - climMinT) / climSpanT) * cPlotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const climMinLine = normals
    .map((n, i) => {
      const x = cPadL + ((i + 0.5) / 12) * cPlotW;
      const y = cPadT + (1 - (n.meanTempMinC - climMinT) / climSpanT) * cPlotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const hoveredHour =
    hoveredHourIdx !== null && hourlyPts[hoveredHourIdx]
      ? hourlyPts[hoveredHourIdx]
      : null;

  return (
    <div className="w-full h-full flex flex-col bg-[#F2F0E8] text-[#111111] overflow-hidden">
      {/* STICKY NEO-BRUTALIST TOP BAR & ROOF HEADER STRIP */}
      <header className="shrink-0 z-20 bg-[#F9F8F3] border-b-2 border-[#111111] px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onBackToStudio}
            className="neo-btn px-3 py-1.5 bg-[#E2FF32] text-[#111111] font-mono-tech text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to 3D</span>
          </button>

          <div className="neo-card-sm px-3 py-1.5 bg-[#111111] text-[#E2FF32] font-mono-tech text-xs font-bold uppercase tracking-wider flex items-center gap-1.5">
            <CloudSun className="w-4 h-4 text-[#FF521B]" />
            <span>Weather &amp; Prediction</span>
          </div>

          <div className="neo-card-sm px-2.5 py-1.5 bg-[#F9F8F3] font-mono-tech text-[11px] font-bold uppercase flex items-center gap-2">
            <span className="text-[#FF521B]">LOC</span>
            <span className="truncate max-w-[200px] sm:max-w-[260px]">
              {bundle?.locationLabel || 'SRI LANKA SITE'}
            </span>
            <span className="text-[#555550] hidden sm:inline">·</span>
            <span className="text-[#111111] hidden sm:inline">
              {lat.toFixed(6)}°N, {lng.toFixed(6)}°E
            </span>
          </div>

          <div className="neo-card-sm px-2.5 py-1.5 bg-[#111111] text-[#E2FF32] font-mono-tech text-[11px] font-bold uppercase">
            {metrics.areaSqm.toFixed(0)} M² · {spec.roofStyle.toUpperCase()} ·{' '}
            {spec.roofPitchDeg}°
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Mobile coords pill */}
          <div className="sm:hidden neo-card-sm px-2 py-1 bg-[#EAE8DF] font-mono-tech text-[10px] font-bold uppercase">
            {lat.toFixed(6)}°N, {lng.toFixed(6)}°E
          </div>

          {bundle?.sourceBadge === 'OFFLINE' && (
            <div className="neo-card-sm px-2.5 py-1 bg-[#FF521B] text-white font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5">
              <WifiOff className="w-3.5 h-3.5" />
              <span>OFFLINE DATA</span>
            </div>
          )}

          {modelBeatsRaw ? (
            <button
              type="button"
              onClick={() =>
                setManualRawOverride((prev) =>
                  prev === null ? true : !prev
                )
              }
              className={`neo-btn px-2.5 py-1 font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5 cursor-pointer ${
                useCorrected
                  ? 'bg-[#E2FF32] text-[#111111]'
                  : 'bg-[#F9F8F3] text-[#111111]'
              }`}
              title="Toggle between LankaWeatherNet Corrected Forecast and Raw Open-Meteo"
            >
              <Cpu className="w-3.5 h-3.5 text-[#FF521B]" />
              <span>
                {useCorrected
                  ? 'AI-CORRECTED FORECAST ✓'
                  : 'RAW FORECAST (NO AI FIX)'}
              </span>
            </button>
          ) : (
            <div className="neo-card-sm px-2.5 py-1 bg-[#EAE8DF] text-[#111111] font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-[#FF521B] animate-pulse" />
              <span>CALIBRATING…</span>
            </div>
          )}
        </div>
      </header>

          {/* MAIN SCROLLABLE DASHBOARD */}
          <div className="flex-1 min-h-0 overflow-y-auto p-3.5 sm:p-5 space-y-4">
            <div className="max-w-7xl mx-auto space-y-4 pb-8">
              {/* ===== SUMMARY-FIRST: TAB BAR + HERO KPI STRIP (UI v5) ===== */}
              <div className="space-y-3">
                <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                  {(
                    [
                      { id: 'overview', label: 'OVERVIEW' },
                      { id: 'forecast', label: 'FORECAST' },
                      { id: 'climate', label: 'CLIMATE' },
                      { id: 'roof', label: 'ROOF' },
                      { id: 'model', label: 'MODEL' },
                    ] as { id: typeof activeTab; label: string }[]
                  ).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setActiveTab(t.id)}
                      className={`tab-seg ${activeTab === t.id ? 'tab-seg-active' : ''}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {/* HERO KPI STRIP — the 5 numbers everyone came for */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                  <div className="neo-card-sm bg-[#F9F8F3] p-3">
                    <div className="menu-row-label">NOW</div>
                    <div className="kpi-hero-num text-[#111111]">
                      {current ? `${current.temperatureC.toFixed(0)}°` : '—'}
                    </div>
                    <div className="font-mono-tech text-[10px] font-bold uppercase text-[#555550] mt-0.5 truncate">
                      {current ? wmoDescription(current.weatherCode) : 'LOADING…'}
                    </div>
                  </div>
                  <div className="neo-card-sm bg-[#F9F8F3] p-3">
                    <div className="menu-row-label">RAIN TODAY</div>
                    <div className="kpi-hero-num text-[#111111]">
                      {activeDay ? `${Math.round(activeDay.rainProbMaxPct)}%` : '—'}
                    </div>
                    <div className="font-mono-tech text-[10px] font-bold uppercase text-[#555550] mt-0.5 truncate">
                      {activeDay ? `${activeDay.rawRainSumMm.toFixed(1)} MM EXPECTED` : '…'}
                    </div>
                  </div>
                  <div className="neo-card-sm bg-[#F9F8F3] p-3">
                    <div className="menu-row-label">SOIL</div>
                    <div className="kpi-hero-num">
                      {soil ? (
                        <span
                          className={
                            soil.health === 'GOOD'
                              ? 'text-[#111111]'
                              : soil.health === 'MODERATE'
                              ? 'text-[#FF521B]'
                              : 'text-[#FF521B]'
                          }
                        >
                          {soil.health}
                        </span>
                      ) : (
                        '—'
                      )}
                    </div>
                    <div className="font-mono-tech text-[10px] font-bold uppercase text-[#555550] mt-0.5 truncate">
                      {soil ? `${(soil.moistureM3M3 * 100).toFixed(0)}% MOISTURE` : '…'}
                    </div>
                  </div>
                  <div className="neo-card-sm bg-[#F9F8F3] p-3">
                    <div className="menu-row-label">ROOF RAINWATER</div>
                    <div className="kpi-hero-num text-[#111111]">
                      {impact
                        ? `${(
                            impact.monthlyHarvestLitres[new Date().getMonth()]?.litres ??
                            Math.round(impact.annualHarvestLitres / 12)
                          ).toLocaleString()} L`
                        : '—'}
                    </div>
                    <div className="font-mono-tech text-[10px] font-bold uppercase text-[#555550] mt-0.5 truncate">
                      THIS MONTH · {(impact?.annualHarvestLitres ?? 0) / 1000 >= 1
                        ? `${(impact!.annualHarvestLitres / 1000).toFixed(1)}K L/YR`
                        : 'COLLECTING…'}
                    </div>
                  </div>
                  <div className="neo-card-sm bg-[#F9F8F3] p-3 col-span-2 sm:col-span-1">
                    <div className="menu-row-label">SOLAR ON ROOF</div>
                    <div className="kpi-hero-num text-[#111111]">
                      {impact ? `${impact.estimatedPvKwhPerDay.toFixed(1)}` : '—'}
                      <span className="text-sm"> kWh/DAY</span>
                    </div>
                    <div className="font-mono-tech text-[10px] font-bold uppercase text-[#555550] mt-0.5 truncate">
                      FROM YOUR {metrics ? metrics.areaSqm.toFixed(0) : '—'} m² ROOF
                    </div>
                  </div>
                </div>
              </div>

              {/* OVERVIEW TAB — plain-language verdict */}
              {activeTab === 'overview' && (
                <div className="neo-card bg-[#F9F8F3] p-4 sm:p-5 space-y-3">
                  <div className="flex items-center gap-2 border-b-2 border-[#111111] pb-2">
                    <CloudSun className="w-4 h-4 text-[#FF521B]" />
                    <h3 className="font-mono-tech text-sm font-bold uppercase">
                      YOUR ROOF, PLAINLY
                    </h3>
                  </div>
                  <p className="text-[15px] leading-relaxed text-[#111111] normal-case">
                    {current && activeDay ? (
                      <>
                        Right now it's{' '}
                        <strong>{wmoDescription(current.weatherCode).toLowerCase()}</strong> at{' '}
                        {current.temperatureC.toFixed(0)}°C, feeling like{' '}
                        {current.feelsLikeC.toFixed(0)}°C. Today expect{' '}
                        {Math.round(activeDay.rainProbMaxPct)}% chance of rain (
                        {activeDay.rawRainSumMm.toFixed(1)} mm).
                        {soil && (
                          <>
                            {' '}
                            Your soil is{' '}
                            <strong>{soil.health.toLowerCase()}</strong> —{' '}
                            {soil.healthNote.toLowerCase().replace(/\.$/, '')}.
                          </>
                        )}
                        {impact && (
                          <>
                            {' '}
                            Over a year your roof can collect about{' '}
                            <strong>
                              {impact.annualHarvestLitres.toLocaleString()} litres
                            </strong>{' '}
                            of rainwater and a solar array here would generate roughly{' '}
                            <strong>
                              {Math.round(impact.estimatedPvKwhPerDay * 365).toLocaleString()}{' '}
                              kWh/year
                            </strong>
                            .
                          </>
                        )}
                      </>
                    ) : (
                      <>Crunching live site data for your roof…</>
                    )}
                  </p>
                  {/* NEXT 7 DAYS — quick week strip (tap a day to select it) */}
                  {dailyList.length > 0 && (
                    <div className="pt-1">
                      <div className="menu-row-label pb-1.5">NEXT 7 DAYS — TAP A DAY</div>
                      <div className="grid grid-cols-4 sm:grid-cols-7 gap-1.5">
                        {dailyList.slice(0, 7).map((d, idx) => {
                          const isSel = idx === selectedDayIdx;
                          const rainMm = getDisplayRain(d);
                          const temps = getDisplayTemps(d);
                          return (
                            <button
                              key={d.date}
                              type="button"
                              onClick={() => {
                                setSelectedDayIdx(idx);
                                setHoveredHourIdx(null);
                                setActiveTab('forecast');
                              }}
                              className={`text-left p-2 cursor-pointer transition-all ${
                                isSel
                                  ? 'neo-card-sm bg-[#E2FF32] text-[#111111]'
                                  : 'border border-[#111111] bg-white hover:bg-[#EAE8DF]'
                              }`}
                            >
                              <div className="font-mono-tech text-[11px] font-bold uppercase">{d.dayShort}</div>
                              <div className="font-mono-tech text-[13px] font-bold">
                                {rainMm >= 1 ? `${Math.round(rainMm)} mm` : 'DRY'}
                              </div>
                              <div className="font-mono-tech text-[10px] text-[#555550]">
                                {Math.round(temps.max)}°–{Math.round(temps.min)}° ·{' '}
                                {Math.round(d.rainProbMaxPct)}%
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {/* TODAY HOUR BY HOUR — mini rain bars */}
                  {hourlyPts.length > 0 && (
                    <div className="pt-1">
                      <div className="menu-row-label pb-1.5">TODAY · RAIN HOUR BY HOUR</div>
                      <div className="flex items-end gap-[3px] h-14 border-b-2 border-[#111111] pb-0.5">
                        {hourlyPts.map((h, i) => {
                          const barH = (Math.min(hMaxRain, h.rainMm) / hMaxRain) * 100;
                          return (
                            <div
                              key={h.timeIso}
                              className="flex-1 bg-[#3b82f6] border border-[#111111]/60"
                              style={{ height: `${Math.max(barH, 2)}%` }}
                              title={`${new Date(h.timeIso).getHours()}:00 — ${h.rainMm.toFixed(1)} mm`}
                            />
                          );
                        })}
                      </div>
                      <div className="flex justify-between font-mono-tech text-[9px] font-bold text-[#555550] pt-0.5">
                        <span>00H</span>
                        <span>06H</span>
                        <span>12H</span>
                        <span>18H</span>
                        <span>23H</span>
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-[#555550]">
                    Dig deeper with the tabs above — FORECAST for the week ahead, CLIMATE for the
                    yearly pattern, ROOF for rainwater & solar details, MODEL to see how our
                    self-improving local AI is performing.
                  </p>
                </div>
              )}

              {/* FORECAST TAB */}
              {activeTab === 'forecast' && (
                  <>
              {/* ROW 1: WEATHER NOW + SOIL & ENVIRONMENT */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {/* WEATHER NOW CARD */}
            <div className="lg:col-span-8 neo-card bg-[#F9F8F3] p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#111111]/20 pb-2">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 bg-[#FF521B] border border-[#111111]" />
                  <span className="font-mono-tech text-[11px] font-bold uppercase tracking-wider">
                    WEATHER NOW · REAL-TIME SITE TELEMETRY
                  </span>
                </div>
                <span className="font-mono-tech text-[10px] font-bold uppercase px-2 py-0.5 bg-[#111111] text-[#E2FF32]">
                  {current ? wmoDescription(current.weatherCode) : 'FETCHING…'}
                </span>
              </div>

              {!current && bundle?.isLoadingForecast ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 animate-pulse">
                  {Array.from({ length: 7 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-16 bg-[#EAE8DF] border border-[#111111]/30"
                    />
                  ))}
                </div>
              ) : current ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {/* Primary Temp */}
                  <div className="col-span-2 sm:col-span-1 neo-card-sm p-3 bg-[#E2FF32] flex flex-col justify-between">
                    <div className="flex items-center justify-between">
                      <span className="font-mono-tech text-[10px] font-bold uppercase">
                        TEMPERATURE
                      </span>
                      <WeatherCodeIcon
                        code={current.weatherCode}
                        className="w-5 h-5 text-[#111111]"
                      />
                    </div>
                    <div className="font-mono-tech text-2xl font-bold text-[#111111] mt-1">
                      {current.temperatureC.toFixed(1)}°C
                    </div>
                  </div>

                  {/* Feels Like */}
                  <div className="neo-card-sm p-2.5 bg-[#F9F8F3]">
                    <div className="flex items-center justify-between font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
                      <span>FEELS LIKE</span>
                      <Thermometer className="w-3.5 h-3.5 text-[#FF521B]" />
                    </div>
                    <div className="font-mono-tech text-lg font-bold mt-1">
                      {current.feelsLikeC.toFixed(1)}°C
                    </div>
                  </div>

                  {/* Humidity */}
                  <div className="neo-card-sm p-2.5 bg-[#F9F8F3]">
                    <div className="flex items-center justify-between font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
                      <span>HUMIDITY</span>
                      <Droplets className="w-3.5 h-3.5 text-[#111111]" />
                    </div>
                    <div className="font-mono-tech text-lg font-bold mt-1">
                      {Math.round(current.humidityPct)}%
                    </div>
                  </div>

                  {/* Rain Now */}
                  <div className="neo-card-sm p-2.5 bg-[#F9F8F3]">
                    <div className="flex items-center justify-between font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
                      <span>RAIN NOW</span>
                      <CloudRain className="w-3.5 h-3.5 text-[#FF521B]" />
                    </div>
                    <div className="font-mono-tech text-lg font-bold mt-1">
                      {current.precipitationMm.toFixed(1)} MM
                    </div>
                  </div>

                  {/* Wind Speed + Rotating Arrow */}
                  <div className="col-span-2 neo-card-sm p-2.5 bg-[#F9F8F3] flex items-center justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-1.5 font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
                        <Wind className="w-3.5 h-3.5 text-[#111111]" />
                        <span>WIND SPEED & DIRECTION</span>
                      </div>
                      <div className="font-mono-tech text-base font-bold mt-1">
                        {current.windSpeedKmh.toFixed(1)} KM/H ·{' '}
                        {Math.round(current.windDirectionDeg)}°{' '}
                        {degToCompass(current.windDirectionDeg)}
                      </div>
                    </div>
                    <div
                      className="w-10 h-10 shrink-0 bg-[#111111] text-[#E2FF32] border border-[#111111] flex items-center justify-center"
                      title={`Wind vector ${Math.round(current.windDirectionDeg)}°`}
                    >
                      <Navigation
                        className="w-5 h-5 transition-transform duration-300"
                        style={{
                          transform: `rotate(${current.windDirectionDeg}deg)`,
                        }}
                      />
                    </div>
                  </div>

                  {/* Pressure */}
                  <div className="neo-card-sm p-2.5 bg-[#F9F8F3]">
                    <div className="flex items-center justify-between font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
                      <span>PRESSURE</span>
                      <Gauge className="w-3.5 h-3.5 text-[#111111]" />
                    </div>
                    <div className="font-mono-tech text-base font-bold mt-1">
                      {current.pressureHpa.toFixed(0)} HPA
                    </div>
                  </div>

                  {/* Cloud Cover */}
                  <div className="neo-card-sm p-2.5 bg-[#F9F8F3]">
                    <div className="flex items-center justify-between font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
                      <span>CLOUD COVER</span>
                      <Cloud className="w-3.5 h-3.5 text-[#111111]" />
                    </div>
                    <div className="font-mono-tech text-base font-bold mt-1">
                      {Math.round(current.cloudCoverPct)}%
                    </div>
                  </div>
                </div>
              ) : (
                <div className="font-mono-tech text-xs uppercase text-[#555550] py-4">
                  TELEMETRY CURRENTLY UNAVAILABLE — CHECK CONNECTION
                </div>
              )}
            </div>

            {/* SOIL & ENVIRONMENT CARD */}
            <div className="lg:col-span-4 neo-card bg-[#F9F8F3] p-4 flex flex-col justify-between space-y-3">
              <div className="flex items-center justify-between border-b border-[#111111]/20 pb-2">
                <div className="flex items-center gap-2">
                  <Sprout className="w-4 h-4 text-[#FF521B]" />
                  <span className="font-mono-tech text-[11px] font-bold uppercase tracking-wider">
                    SOIL & ENVIRONMENT (0–7CM)
                  </span>
                </div>
                {soil && (
                  <span
                    className={`px-2 py-0.5 border border-[#111111] font-mono-tech text-[10px] font-bold uppercase ${
                      soil.health === 'GOOD'
                        ? 'bg-[#E2FF32] text-[#111111]'
                        : soil.health === 'MODERATE'
                        ? 'bg-[#EAE8DF] text-[#111111]'
                        : 'bg-[#FF521B] text-white'
                    }`}
                  >
                    HEALTH: {soil.health}
                  </span>
                )}
              </div>

              {!soil && bundle?.isLoadingForecast ? (
                <div className="space-y-2.5 animate-pulse">
                  <div className="h-14 bg-[#EAE8DF] border border-[#111111]/30" />
                  <div className="h-14 bg-[#EAE8DF] border border-[#111111]/30" />
                </div>
              ) : soil ? (
                <>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="neo-card-sm p-2.5 bg-[#F9F8F3]">
                      <div className="font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
                        SOIL MOISTURE
                      </div>
                      <div className="font-mono-tech text-lg font-bold mt-1">
                        {soil.moistureM3M3.toFixed(3)}
                        <span className="text-[10px] ml-1 text-[#555550]">M³/M³</span>
                      </div>
                      <div className="font-mono-tech text-[10px] font-bold text-[#111111]">
                        ({(soil.moistureM3M3 * 100).toFixed(1)}% VOL)
                      </div>
                    </div>

                    <div className="neo-card-sm p-2.5 bg-[#F9F8F3]">
                      <div className="font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
                        SOIL TEMP (0–7CM)
                      </div>
                      <div className="font-mono-tech text-lg font-bold mt-1">
                        {soil.temperatureC.toFixed(1)}°C
                      </div>
                      <div className="font-mono-tech text-[10px] font-bold text-[#555550] uppercase">
                        SUBSURFACE ZONE
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between font-mono-tech text-[9px] font-bold uppercase text-[#555550]">
                      <span>DRY (&lt;0.14)</span>
                      <span>MODERATE</span>
                      <span>GOOD (&ge;0.24)</span>
                    </div>
                    <div className="h-3 w-full bg-[#EAE8DF] border border-[#111111] overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          soil.health === 'GOOD'
                            ? 'bg-[#E2FF32]'
                            : soil.health === 'MODERATE'
                            ? 'bg-[#111111]'
                            : 'bg-[#FF521B]'
                        }`}
                        style={{
                          width: `${Math.min(100, Math.max(6, (soil.moistureM3M3 / 0.48) * 100))}%`,
                        }}
                      />
                    </div>
                    <div className="font-mono-tech text-[10px] font-bold uppercase text-[#111111]">
                      {soil.healthNote}
                    </div>
                  </div>
                </>
              ) : (
                <div className="font-mono-tech text-xs uppercase text-[#555550]">
                  SOIL METRICS UNAVAILABLE
                </div>
              )}
            </div>
          </div>

          {/* ROW 2: 7-DAY FORECAST + SELECTED-DAY 24-HOUR SVG CHART */}
          <div className="neo-card bg-[#F9F8F3] p-4 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#111111]/20 pb-2">
              <div className="flex items-center gap-2">
                <CloudSun className="w-4 h-4 text-[#FF521B]" />
                <span className="font-mono-tech text-[11px] font-bold uppercase tracking-wider">
                  7-DAY FORECAST · TAP ANY DAY FOR HOURLY BREAKDOWN
                </span>
              </div>
              <span className="font-mono-tech text-[10px] font-bold uppercase px-2 py-0.5 bg-[#EAE8DF] border border-[#111111]">
                {useCorrected
                  ? 'MODE: LANKAWEATHERNET CORRECTED'
                  : 'MODE: RAW OPEN-METEO'}
              </span>
            </div>

            {dailyList.length === 0 && bundle?.isLoadingForecast ? (
              <div className="grid grid-cols-2 sm:grid-cols-7 gap-2 animate-pulse">
                {Array.from({ length: 7 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-28 bg-[#EAE8DF] border border-[#111111]/30"
                  />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                {dailyList.map((d, idx) => {
                  const isSel = idx === selectedDayIdx;
                  const temps = getDisplayTemps(d);
                  const rainMm = getDisplayRain(d);
                  return (
                    <button
                      key={d.date}
                      type="button"
                      onClick={() => {
                        setSelectedDayIdx(idx);
                        setHoveredHourIdx(null);
                      }}
                      className={`text-left p-2.5 transition-all cursor-pointer ${
                        isSel
                          ? 'neo-card-sm bg-[#E2FF32] text-[#111111]'
                          : 'border border-[#111111] bg-[#F9F8F3] hover:bg-[#EAE8DF]'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono-tech text-[11px] font-bold uppercase">
                          {d.dayShort}
                        </span>
                        <span className="font-mono-tech text-[9px] font-bold text-[#555550]">
                          {d.date.slice(5)}
                        </span>
                      </div>

                      <div className="my-2 flex items-center justify-between">
                        <WeatherCodeIcon
                          code={d.weatherCode}
                          className="w-5 h-5 text-[#111111]"
                        />
                        <div className="text-right font-mono-tech">
                          <span className="text-sm font-bold">
                            {temps.max.toFixed(0)}°
                          </span>
                          <span className="text-[11px] text-[#555550] ml-1">
                            /{temps.min.toFixed(0)}°
                          </span>
                        </div>
                      </div>

                      <div className="pt-1.5 border-t border-[#111111]/20 flex items-center justify-between font-mono-tech text-[10px] font-bold uppercase">
                        <span>{rainMm.toFixed(1)}MM</span>
                        <span className="text-[#FF521B]">
                          {Math.round(
                            useCorrected && d.correctedWetProbPct !== undefined
                              ? Math.max(d.rainProbMaxPct, d.correctedWetProbPct)
                              : d.rainProbMaxPct
                          )}
                          %
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* SELECTED DAY 24H HOURLY INLINE SVG CHART */}
            {activeDay && hourlyPts.length > 0 && (
              <div className="neo-card-sm bg-[#F2F0E8] p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 font-mono-tech text-[10px] font-bold uppercase">
                  <span>
                    HOURLY PROFILE · {activeDay.dayShort} ({activeDay.date})
                  </span>
                  <div className="flex items-center gap-3">
                    {hoveredHour ? (
                      <span className="px-2 py-0.5 bg-[#111111] text-[#E2FF32]">
                        {hoveredHour.hourLabel} · {hoveredHour.temperatureC.toFixed(1)}°C ·{' '}
                        {hoveredHour.rainMm.toFixed(1)}MM ({hoveredHour.rainProbPct}% PROB)
                      </span>
                    ) : (
                      <>
                        <span className="flex items-center gap-1">
                          <span className="w-2.5 h-1 bg-[#FF521B] inline-block" /> TEMP (°C)
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="w-2.5 h-2.5 bg-[#111111] inline-block" /> RAIN (MM)
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <svg
                  viewBox={`0 0 ${hChartW} ${hChartH}`}
                  className="w-full h-44 select-none overflow-visible"
                  onMouseLeave={() => setHoveredHourIdx(null)}
                >
                  {/* Horizontal Reference Lines */}
                  {[0, 0.5, 1].map((frac, idx) => {
                    const y = padT + frac * plotH;
                    const tVal = (hMaxT - frac * hSpanT).toFixed(0);
                    const rVal = ((1 - frac) * hMaxRain).toFixed(1);
                    return (
                      <g key={idx}>
                        <line
                          x1={padL}
                          y1={y}
                          x2={hChartW - padR}
                          y2={y}
                          stroke="#111111"
                          strokeOpacity={0.16}
                          strokeDasharray="3,3"
                        />
                        <text
                          x={padL - 6}
                          y={y + 3}
                          textAnchor="end"
                          fontSize="9"
                          fontWeight="700"
                          fontFamily="IBM Plex Mono, monospace"
                          fill="#111111"
                        >
                          {tVal}°
                        </text>
                        <text
                          x={hChartW - padR + 5}
                          y={y + 3}
                          textAnchor="start"
                          fontSize="9"
                          fontWeight="700"
                          fontFamily="IBM Plex Mono, monospace"
                          fill="#555550"
                        >
                          {rVal}
                        </text>
                      </g>
                    );
                  })}

                  {/* Hourly Rain Bars */}
                  {hourlyPts.map((h, i) => {
                    const stepW = plotW / Math.max(1, hourlyPts.length);
                    const barW = Math.max(6, stepW * 0.56);
                    const cx = padL + (i / Math.max(1, hourlyPts.length - 1)) * plotW;
                    const barH = (Math.min(hMaxRain, h.rainMm) / hMaxRain) * plotH;
                    const y = padT + plotH - barH;
                    return (
                      <g key={h.timeIso}>
                        {barH > 0.5 && (
                          <rect
                            x={cx - barW / 2}
                            y={y}
                            width={barW}
                            height={barH}
                            fill={hoveredHourIdx === i ? '#E2FF32' : '#111111'}
                            stroke="#111111"
                            strokeWidth="1"
                          />
                        )}
                        {/* X-axis Hour Tick every 3 hours */}
                        {i % 3 === 0 && (
                          <text
                            x={cx}
                            y={hChartH - 6}
                            textAnchor="middle"
                            fontSize="9"
                            fontWeight="700"
                            fontFamily="IBM Plex Mono, monospace"
                            fill="#111111"
                          >
                            {h.hourLabel}
                          </text>
                        )}
                        {/* Invisible wide hover target */}
                        <rect
                          x={cx - stepW / 2}
                          y={padT}
                          width={stepW}
                          height={plotH}
                          fill="transparent"
                          onMouseEnter={() => setHoveredHourIdx(i)}
                          onClick={() => setHoveredHourIdx(i)}
                        />
                      </g>
                    );
                  })}

                  {/* Temperature Line Casing + Vermilion Line */}
                  <polyline
                    fill="none"
                    stroke="#111111"
                    strokeWidth="4.2"
                    strokeLinejoin="round"
                    points={tempPolyline}
                  />
                  <polyline
                    fill="none"
                    stroke="#FF521B"
                    strokeWidth="2.4"
                    strokeLinejoin="round"
                    points={tempPolyline}
                  />

                  {/* Hourly Nodes */}
                  {hourlyPts.map((h, i) => {
                    const cx = padL + (i / Math.max(1, hourlyPts.length - 1)) * plotW;
                    const cy = padT + (1 - (h.temperatureC - hMinT) / hSpanT) * plotH;
                    const isHov = hoveredHourIdx === i;
                    return (
                      <circle
                        key={`pt-${h.timeIso}`}
                        cx={cx}
                        cy={cy}
                        r={isHov ? 5 : 2.6}
                        fill="#E2FF32"
                        stroke="#111111"
                        strokeWidth="1.5"
                        pointerEvents="none"
                      />
                    );
                  })}
                </svg>
              </div>
            )}
          </div>

              </>
              )}

          {/* ROOF TAB: ROOF IMPACT SECTION (TIED DIRECTLY TO USER'S HOUSESPEC) */}
          {activeTab === 'roof' && impact && (
            <div className="neo-card bg-[#F9F8F3] p-4 space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#111111]/20 pb-2">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-[#FF521B]" />
                  <span className="font-mono-tech text-[11px] font-bold uppercase tracking-wider">
                    ROOF IMPACT · DIRECT ARCHITECTURAL COUPLED SIMULATION
                  </span>
                </div>
                <span className="font-mono-tech text-[10px] font-bold uppercase px-2 py-0.5 bg-[#111111] text-[#E2FF32]">
                  SURFACE: {impact.materialLabel} · PITCH {spec.roofPitchDeg}°
                </span>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Rainwater Harvesting Sub-Card */}
                <div className="neo-card-sm bg-[#F2F0E8] p-3.5 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5">
                      <Droplets className="w-4 h-4 text-[#111111]" />
                      <span>RAINWATER HARVESTING POTENTIAL</span>
                    </span>
                    <span className="font-mono-tech text-[10px] font-bold uppercase px-1.5 py-0.5 bg-[#E2FF32] border border-[#111111]">
                      RUNOFF {impact.runoffCoefficient.toFixed(2)}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="bg-[#F9F8F3] border border-[#111111] p-2">
                      <div className="font-mono-tech text-[9px] font-bold uppercase text-[#555550]">
                        ANNUAL YIELD
                      </div>
                      <div className="font-mono-tech text-sm font-bold mt-0.5">
                        {formatLitresCompact(impact.annualHarvestLitres)}
                      </div>
                    </div>
                    <div className="bg-[#F9F8F3] border border-[#111111] p-2">
                      <div className="font-mono-tech text-[9px] font-bold uppercase text-[#555550]">
                        PEAK MONTH
                      </div>
                      <div className="font-mono-tech text-sm font-bold mt-0.5">
                        {formatLitresCompact(impact.peakMonthHarvestLitres)}
                      </div>
                    </div>
                    <div className="bg-[#F9F8F3] border border-[#111111] p-2">
                      <div className="font-mono-tech text-[9px] font-bold uppercase text-[#555550]">
                        NEXT 7 DAYS
                      </div>
                      <div className="font-mono-tech text-sm font-bold text-[#FF521B] mt-0.5">
                        {formatLitresCompact(impact.next7DaysHarvestLitres)}
                      </div>
                    </div>
                  </div>

                  {/* 12-Month Rainwater Harvesting Mini Chart */}
                  {impact.monthlyHarvestLitres.length === 12 ? (
                    <div className="space-y-1">
                      <div className="font-mono-tech text-[9px] font-bold uppercase text-[#555550]">
                        12-MONTH HARVEST CURVE (LITRES / MONTH = {metrics.areaSqm.toFixed(0)}M² × RAIN ×{' '}
                        {impact.runoffCoefficient.toFixed(2)})
                      </div>
                      <svg viewBox="0 0 420 96" className="w-full h-24 select-none">
                        {impact.monthlyHarvestLitres.map((m, idx) => {
                          const maxL = Math.max(1, impact.peakMonthHarvestLitres);
                          const colW = 420 / 12;
                          const bw = colW * 0.66;
                          const x = idx * colW + (colW - bw) / 2;
                          const bh = Math.max(3, (m.litres / maxL) * 64);
                          const y = 74 - bh;
                          return (
                            <g key={m.monthShort}>
                              <rect
                                x={x}
                                y={y}
                                width={bw}
                                height={bh}
                                fill={
                                  m.litres === impact.peakMonthHarvestLitres
                                    ? '#E2FF32'
                                    : '#111111'
                                }
                                stroke="#111111"
                                strokeWidth="1"
                              />
                              <text
                                x={idx * colW + colW / 2}
                                y={90}
                                textAnchor="middle"
                                fontSize="8.5"
                                fontWeight="700"
                                fontFamily="IBM Plex Mono, monospace"
                                fill="#111111"
                              >
                                {m.monthShort.slice(0, 1)}
                              </text>
                            </g>
                          );
                        })}
                      </svg>
                    </div>
                  ) : (
                    <div className="h-24 bg-[#EAE8DF] animate-pulse border border-[#111111]/25" />
                  )}
                </div>

                {/* Sun on Roof Sub-Card */}
                <div className="neo-card-sm bg-[#F2F0E8] p-3.5 space-y-3 flex flex-col justify-between">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5">
                        <Sun className="w-4 h-4 text-[#FF521B]" />
                        <span>SUN ON ROOF · TILTED IRRADIANCE</span>
                      </span>
                      <span className="font-mono-tech text-[10px] font-bold uppercase px-1.5 py-0.5 bg-[#F9F8F3] border border-[#111111]">
                        SLOPED AREA {impact.slopedRoofAreaSqm} M²
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <div className="bg-[#F9F8F3] border border-[#111111] p-2">
                        <div className="font-mono-tech text-[9px] font-bold uppercase text-[#555550]">
                          SOLAR FLUX
                        </div>
                        <div className="font-mono-tech text-sm font-bold mt-0.5">
                          {impact.todayHorizontalWhm2.toLocaleString()}
                          <span className="text-[9px] ml-0.5">WH/M²</span>
                        </div>
                      </div>
                      <div className="bg-[#E2FF32] border border-[#111111] p-2">
                        <div className="font-mono-tech text-[9px] font-bold uppercase text-[#111111]">
                          ROOF INCIDENT
                        </div>
                        <div className="font-mono-tech text-sm font-bold mt-0.5">
                          {impact.tiltedSolarKwhPerDay}
                          <span className="text-[9px] ml-0.5">KWH/D</span>
                        </div>
                      </div>
                      <div className="bg-[#F9F8F3] border border-[#111111] p-2">
                        <div className="font-mono-tech text-[9px] font-bold uppercase text-[#555550]">
                          EST. PV YIELD
                        </div>
                        <div className="font-mono-tech text-sm font-bold text-[#FF521B] mt-0.5">
                          ~{impact.estimatedPvKwhPerDay}
                          <span className="text-[9px] ml-0.5">KWH/D</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 7-Day Daily Solar Radiation Mini Strip */}
                  {dailyList.length > 0 && (
                    <div className="space-y-1">
                      <div className="font-mono-tech text-[9px] font-bold uppercase text-[#555550]">
                        7-DAY SOLAR IRRADIANCE FORECAST (WH/M²/DAY AT {spec.roofPitchDeg}° ROOF TILT)
                      </div>
                      <svg viewBox="0 0 420 82" className="w-full h-20 select-none">
                        {dailyList.map((d, idx) => {
                          const maxWh = Math.max(
                            4000,
                            ...dailyList.map((item) => item.solarRadiationWhm2)
                          );
                          const colW = 420 / dailyList.length;
                          const bw = colW * 0.62;
                          const x = idx * colW + (colW - bw) / 2;
                          const bh = Math.max(4, (d.solarRadiationWhm2 / maxWh) * 52);
                          const y = 62 - bh;
                          return (
                            <g key={`sol-${d.date}`}>
                              <rect
                                x={x}
                                y={y}
                                width={bw}
                                height={bh}
                                fill="#FF521B"
                                stroke="#111111"
                                strokeWidth="1.2"
                              />
                              <text
                                x={idx * colW + colW / 2}
                                y={76}
                                textAnchor="middle"
                                fontSize="8.5"
                                fontWeight="700"
                                fontFamily="IBM Plex Mono, monospace"
                                fill="#111111"
                              >
                                {d.dayShort.slice(0, 3)}
                              </text>
                            </g>
                          );
                        })}
                      </svg>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* CLIMATE TAB: 12-MONTH NORMALS */}
          <div className={`neo-card bg-[#F9F8F3] p-4 space-y-3.5 ${activeTab === 'climate' ? '' : 'hidden'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#111111]/20 pb-2">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 bg-[#111111]" />
                <span className="font-mono-tech text-[11px] font-bold uppercase tracking-wider">
                  CLIMATE · LONG-TERM AVERAGE
                </span>
              </div>
              <span className="font-mono-tech text-[10px] font-bold uppercase px-2 py-0.5 bg-[#E2FF32] border border-[#111111]">
                {bundle?.climateYearsSpan
                  ? `ERA5 REANALYSIS · ${bundle.climateYearsSpan} · ${annualClimateRain} MM/YR`
                  : 'AGGREGATING ERA5 MULTI-YEAR ARCHIVE…'}
              </span>
            </div>

            {normals.length < 12 && bundle?.isLoadingClimate ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 animate-pulse">
                <div className="h-48 bg-[#EAE8DF] border border-[#111111]/30" />
                <div className="h-48 bg-[#EAE8DF] border border-[#111111]/30" />
              </div>
            ) : normals.length === 12 ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* 12-Month Total Rainfall Bar Chart */}
                <div className="neo-card-sm bg-[#F2F0E8] p-3 space-y-1.5">
                  <div className="flex justify-between font-mono-tech text-[10px] font-bold uppercase">
                    <span>MONTHLY TOTAL RAINFALL (MM)</span>
                    <span className="text-[#555550]">YALA & MAHA MONSOONS</span>
                  </div>
                  <svg viewBox={`0 0 ${cChartW} ${cChartH}`} className="w-full h-44 select-none">
                    {[0, 0.5, 1].map((frac, idx) => {
                      const y = cPadT + frac * cPlotH;
                      const val = Math.round((1 - frac) * maxClimateRain);
                      return (
                        <g key={idx}>
                          <line
                            x1={cPadL}
                            y1={y}
                            x2={cChartW - cPadR}
                            y2={y}
                            stroke="#111111"
                            strokeOpacity={0.15}
                            strokeDasharray="3,3"
                          />
                          <text
                            x={cPadL - 5}
                            y={y + 3}
                            textAnchor="end"
                            fontSize="9"
                            fontWeight="700"
                            fontFamily="IBM Plex Mono, monospace"
                            fill="#111111"
                          >
                            {val}
                          </text>
                        </g>
                      );
                    })}

                    {normals.map((n, idx) => {
                      const colW = cPlotW / 12;
                      const bw = colW * 0.64;
                      const x = cPadL + idx * colW + (colW - bw) / 2;
                      const bh = Math.max(2, (n.totalRainfallMm / maxClimateRain) * cPlotH);
                      const y = cPadT + cPlotH - bh;
                      return (
                        <g key={n.monthShort}>
                          <rect
                            x={x}
                            y={y}
                            width={bw}
                            height={bh}
                            fill={n.totalRainfallMm >= maxClimateRain * 0.75 ? '#FF521B' : '#111111'}
                            stroke="#111111"
                            strokeWidth="1"
                          />
                          <text
                            x={cPadL + (idx + 0.5) * colW}
                            y={cChartH - 7}
                            textAnchor="middle"
                            fontSize="9"
                            fontWeight="700"
                            fontFamily="IBM Plex Mono, monospace"
                            fill="#111111"
                          >
                            {n.monthShort}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>

                {/* 12-Month Mean Max / Min Temperature Line Chart */}
                <div className="neo-card-sm bg-[#F2F0E8] p-3 space-y-1.5">
                  <div className="flex justify-between font-mono-tech text-[10px] font-bold uppercase">
                    <span>MONTHLY MEAN MAX / MIN TEMP (°C)</span>
                    <div className="flex items-center gap-2.5">
                      <span className="text-[#FF521B]">■ MAX</span>
                      <span className="text-[#111111]">■ MIN</span>
                    </div>
                  </div>
                  <svg viewBox={`0 0 ${cChartW} ${cChartH}`} className="w-full h-44 select-none">
                    {[0, 0.5, 1].map((frac, idx) => {
                      const y = cPadT + frac * cPlotH;
                      const val = (climMaxT - frac * climSpanT).toFixed(0);
                      return (
                        <g key={idx}>
                          <line
                            x1={cPadL}
                            y1={y}
                            x2={cChartW - cPadR}
                            y2={y}
                            stroke="#111111"
                            strokeOpacity={0.15}
                            strokeDasharray="3,3"
                          />
                          <text
                            x={cPadL - 5}
                            y={y + 3}
                            textAnchor="end"
                            fontSize="9"
                            fontWeight="700"
                            fontFamily="IBM Plex Mono, monospace"
                            fill="#111111"
                          >
                            {val}°
                          </text>
                        </g>
                      );
                    })}

                    <polyline
                      fill="none"
                      stroke="#FF521B"
                      strokeWidth="2.8"
                      points={climMaxLine}
                    />
                    <polyline
                      fill="none"
                      stroke="#111111"
                      strokeWidth="2.6"
                      points={climMinLine}
                    />

                    {normals.map((n, idx) => {
                      const cx = cPadL + ((idx + 0.5) / 12) * cPlotW;
                      const yMax =
                        cPadT + (1 - (n.meanTempMaxC - climMinT) / climSpanT) * cPlotH;
                      const yMin =
                        cPadT + (1 - (n.meanTempMinC - climMinT) / climSpanT) * cPlotH;
                      return (
                        <g key={`t-${n.monthShort}`}>
                          <circle
                            cx={cx}
                            cy={yMax}
                            r="3"
                            fill="#E2FF32"
                            stroke="#111111"
                            strokeWidth="1.4"
                          />
                          <circle
                            cx={cx}
                            cy={yMin}
                            r="3"
                            fill="#F9F8F3"
                            stroke="#111111"
                            strokeWidth="1.4"
                          />
                          <text
                            x={cx}
                            y={cChartH - 7}
                            textAnchor="middle"
                            fontSize="9"
                            fontWeight="700"
                            fontFamily="IBM Plex Mono, monospace"
                            fill="#111111"
                          >
                            {n.monthShort}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>
            ) : (
              <div className="font-mono-tech text-xs uppercase text-[#555550]">
                CLIMATE ARCHIVE UNAVAILABLE OFFLINE
              </div>
            )}
          </div>

          {/* MODEL TAB: MODEL ACCURACY PANEL (LANKAWEATHERNET LOCAL SELF-IMPROVING CALIBRATION) */}
          <div className={`neo-card bg-[#F9F8F3] p-4 space-y-3.5 ${activeTab === 'model' ? '' : 'hidden'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#111111]/20 pb-2">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-[#FF521B]" />
                <span className="font-mono-tech text-[11px] font-bold uppercase tracking-wider">
                  MODEL ACCURACY · LANKAWEATHERNET ({LANKA_WEATHER_NET_PARAMS} PARAMS · IN-BROWSER)
                </span>
              </div>

              {accuracy ? (
                <span
                  className={`px-2.5 py-0.5 border border-[#111111] font-mono-tech text-[10px] font-bold uppercase flex items-center gap-1.5 ${
                    accuracy.beatsRaw
                      ? 'bg-[#E2FF32] text-[#111111]'
                      : 'bg-[#EAE8DF] text-[#111111]'
                  }`}
                >
                  {accuracy.beatsRaw && <CheckCircle2 className="w-3.5 h-3.5" />}
                  <span>
                    {accuracy.beatsRaw
                      ? `CORRECTED BEATS RAW · ${accuracy.trainingTimeMs}MS WORKER`
                      : 'CALIBRATING… · RAW ACTIVE'}
                  </span>
                </span>
              ) : (
                <span className="px-2.5 py-0.5 bg-[#EAE8DF] border border-[#111111] font-mono-tech text-[10px] font-bold uppercase">
                  CALIBRATING…
                </span>
              )}
            </div>

            {!accuracy ? (
              <div className="neo-card-sm bg-[#F2F0E8] p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="font-mono-tech text-xs font-bold uppercase">
                  TRAINING 2-LAYER RESIDUAL MLP IN WEB WORKER ON ~2 YEARS OF LOCAL FORECAST-VS-ERA5 PAIRS…
                </div>
                <span className="px-2.5 py-1 bg-[#111111] text-[#E2FF32] font-mono-tech text-[10px] font-bold uppercase">
                  DISPLAYING RAW OPEN-METEO
                </span>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {/* Temp MAE Comparison */}
                <div className="neo-card-sm bg-[#F2F0E8] p-3 space-y-2">
                  <div className="font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
                    MEAN ABS TEMP ERROR (LOWER = BETTER)
                  </div>
                  <div className="space-y-1.5 font-mono-tech text-xs font-bold uppercase">
                    <div className="flex justify-between items-center p-1.5 bg-[#E2FF32] border border-[#111111]">
                      <span>CORRECTED (NET)</span>
                      <span>{accuracy.correctedTempMaeC.toFixed(2)}°C</span>
                    </div>
                    <div className="flex justify-between items-center p-1.5 bg-[#F9F8F3] border border-[#111111]">
                      <span>RAW FORECAST</span>
                      <span>{accuracy.rawTempMaeC.toFixed(2)}°C</span>
                    </div>
                    <div className="flex justify-between items-center p-1.5 bg-[#EAE8DF] border border-[#111111]/50 text-[#555550]">
                      <span>NAIVE (TOMORROW=TODAY)</span>
                      <span>{accuracy.naiveTempMaeC.toFixed(2)}°C</span>
                    </div>
                  </div>
                </div>

                {/* Rain Hit-Rate Comparison */}
                <div className="neo-card-sm bg-[#F2F0E8] p-3 space-y-2">
                  <div className="font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
                    RAIN HIT-RATE &ge;1MM (HIGHER = BETTER)
                  </div>
                  <div className="space-y-1.5 font-mono-tech text-xs font-bold uppercase">
                    <div className="flex justify-between items-center p-1.5 bg-[#E2FF32] border border-[#111111]">
                      <span>CORRECTED (NET)</span>
                      <span>{accuracy.correctedRainHitRatePct.toFixed(1)}%</span>
                    </div>
                    <div className="flex justify-between items-center p-1.5 bg-[#F9F8F3] border border-[#111111]">
                      <span>RAW FORECAST</span>
                      <span>{accuracy.rawRainHitRatePct.toFixed(1)}%</span>
                    </div>
                    <div className="flex justify-between items-center p-1.5 bg-[#EAE8DF] border border-[#111111]/50 text-[#555550]">
                      <span>NAIVE (TOMORROW=TODAY)</span>
                      <span>{accuracy.naiveRainHitRatePct.toFixed(1)}%</span>
                    </div>
                  </div>
                </div>

                {/* Cell & Dataset Provenance */}
                <div className="neo-card-sm bg-[#F2F0E8] p-3 flex flex-col justify-between space-y-2 font-mono-tech uppercase">
                  <div>
                    <div className="text-[10px] font-bold text-[#555550]">
                      GRID CELL CALIBRATION SUMMARY
                    </div>
                    <div className="text-xs font-bold mt-1.5 space-y-1">
                      <div>CELL ID: {bundle?.modelGridKey} (~1KM)</div>
                      <div>TRAIN SPLIT: {accuracy.trainDays} DAYS</div>
                      <div>HELD-OUT EVAL: {accuracy.heldOutDays} RECENT DAYS</div>
                      <div>
                        RAIN MAE: {accuracy.correctedRainMaeMm}MM VS {accuracy.rawRainMaeMm}MM RAW
                      </div>
                    </div>
                  </div>
                  <div className="text-[9px] font-bold text-[#555550] border-t border-[#111111]/20 pt-1.5">
                    WEIGHTS CACHED IN INDEXEDDB · AUTO-REFINES AS NEW ERA5 DAYS ARRIVE
                  </div>
                </div>
              </div>
            )}

            {/* ADDITIVE DAILY SELF-LEARNING PROGRESS SUB-PANEL */}
            {bundle?.learning && (
              <div className="neo-card-sm bg-[#F2F0E8] p-3.5 space-y-2.5 border-t border-[#111111]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {/* Status Line: LEARNING DAY X · Y SAMPLES · LAST TRAINED ... */}
                  <div className="font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5 text-[#111111]">
                    {bundle.learning.isRunningCycle ? (
                      <RefreshCw className="w-3.5 h-3.5 text-[#FF521B] animate-spin shrink-0" />
                    ) : (
                      <Activity className="w-3.5 h-3.5 text-[#FF521B] shrink-0" />
                    )}
                    <span>
                      LEARNING DAY {Math.max(1, bundle.learning.learningDayCount)} ·{' '}
                      {bundle.learning.totalSamples ||
                        (accuracy ? accuracy.trainDays + accuracy.heldOutDays : 0)}{' '}
                      SAMPLES
                      {bundle.learning.provisionalSamples > 0
                        ? ` (${bundle.learning.provisionalSamples} PROVISIONAL)`
                        : ''}{' '}
                      ·{' '}
                      {formatLastTrainedStatus(
                        bundle.learning.lastTrainedAtIso,
                        bundle.learning.isRunningCycle
                      )}
                    </span>
                  </div>

                  {/* Badges: IMPROVING / HOLDING + +N SAMPLES TODAY */}
                  <div className="flex flex-wrap items-center gap-1.5 font-mono-tech text-[10px] font-bold uppercase">
                    <span
                      className={`px-2 py-0.5 border border-[#111111] flex items-center gap-1 ${
                        bundle.learning.trendStatus === 'IMPROVING'
                          ? 'bg-[#E2FF32] text-[#111111]'
                          : 'bg-[#F9F8F3] text-[#111111]'
                      }`}
                    >
                      {bundle.learning.trendStatus === 'IMPROVING' && (
                        <TrendingDown className="w-3 h-3" />
                      )}
                      <span>{bundle.learning.trendStatus}</span>
                    </span>

                    <span className="px-2 py-0.5 bg-[#111111] text-[#E2FF32] border border-[#111111]">
                      +{bundle.learning.addedSamplesToday} SAMPLES TODAY
                    </span>
                  </div>
                </div>

                {/* Sparkline + Champion Gate Readout */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-center">
                  <div className="lg:col-span-8 space-y-1">
                    <div className="flex items-center justify-between font-mono-tech text-[9px] font-bold uppercase text-[#555550]">
                      <span>DAILY LEARNING JOURNAL · TEMP MAE (°C, LOWER = BETTER)</span>
                      <div className="flex items-center gap-2.5">
                        <span className="text-[#111111]">■ NET MAE</span>
                        <span className="text-[#FF521B]">--- RAW MAE</span>
                      </div>
                    </div>
                    <LearningJournalSparkline journal={bundle.learning.journal} />
                  </div>

                  <div className="lg:col-span-4 bg-[#F9F8F3] border border-[#111111] p-2.5 font-mono-tech uppercase space-y-1">
                    <div className="text-[9px] font-bold text-[#555550]">
                      CHAMPION VS CHALLENGER GATE
                    </div>
                    {bundle.learning.journal.length > 0 ? (
                      (() => {
                        const latest =
                          bundle.learning.journal[bundle.learning.journal.length - 1];
                        return (
                          <>
                            <div className="text-[11px] font-bold text-[#111111]">
                              {latest.championAdopted
                                ? 'NEW CHAMPION DEPLOYED'
                                : 'CHAMPION RETAINED · NO REGRESSION'}
                            </div>
                            <div className="text-[10px] font-semibold text-[#555550]">
                              RAIN HIT-RATE: {latest.correctedRainHitRatePct.toFixed(1)}% VS{' '}
                              {latest.rawRainHitRatePct.toFixed(1)}% RAW
                            </div>
                            <div className="text-[9px] text-[#555550]">
                              RECENCY 0.5^(AGE/120D) · {latest.trainTimeMs}MS CYCLE
                            </div>
                          </>
                        );
                      })()
                    ) : (
                      <div className="text-[10px] font-bold text-[#555550]">
                        CALIBRATING INITIAL CHAMPION…
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
