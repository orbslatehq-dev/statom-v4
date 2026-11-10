export type WeatherSourceBadge = 'LIVE' | 'CACHED' | 'OFFLINE';

export type SoilHealthStatus = 'GOOD' | 'MODERATE' | 'DRY';

export interface CurrentWeather {
  timeIso: string;
  temperatureC: number;
  feelsLikeC: number;
  humidityPct: number;
  rainMm: number;
  precipitationMm: number;
  windSpeedKmh: number;
  windDirectionDeg: number;
  pressureHpa: number;
  cloudCoverPct: number;
  weatherCode: number;
}

export interface HourlyWeatherPoint {
  timeIso: string;
  hourLabel: string;
  temperatureC: number;
  feelsLikeC: number;
  rainMm: number;
  rainProbPct: number;
  cloudCoverPct: number;
  windSpeedKmh: number;
  windDirectionDeg: number;
  humidityPct: number;
  weatherCode: number;
  shortwaveWm2: number;
}

export interface DailyForecastItem {
  date: string; // YYYY-MM-DD
  dayShort: string; // MON, TUE...
  weatherCode: number;
  rawTempMaxC: number;
  rawTempMinC: number;
  rawRainSumMm: number;
  rainProbMaxPct: number;
  windMaxKmh: number;
  humidityMeanPct: number;
  pressureMeanHpa: number;
  solarRadiationWhm2: number;
  // Corrected values populated once LankaWeatherNet finishes training
  correctedTempMaxC?: number;
  correctedTempMinC?: number;
  correctedRainSumMm?: number;
  correctedWetProbPct?: number;
  hourly: HourlyWeatherPoint[];
}

export interface MonthlyClimateNormal {
  monthIndex: number; // 0..11
  monthShort: string; // JAN..DEC
  totalRainfallMm: number; // Mean total monthly rainfall across multi-year archive
  meanTempMaxC: number;
  meanTempMinC: number;
  meanDailyGhiKwhM2: number; // Mean daily global horizontal irradiance (kWh/m²/day)
}

export interface SoilEnvironmentData {
  moistureM3M3: number; // 0-7cm volumetric m³/m³
  temperatureC: number; // 0-7cm °C
  health: SoilHealthStatus;
  healthNote: string;
}

export interface HistoricalPairSample {
  date: string; // YYYY-MM-DD
  doy: number; // 1..366
  // Historical NWP Forecast features
  fTempMaxC: number;
  fTempMinC: number;
  fHumidityPct: number;
  fPressureHpa: number;
  fWindMaxKmh: number;
  fRainMm: number;
  // ERA5 Archive or Provisional Forecast Ground-Truth Actuals
  aTempMaxC: number;
  aTempMinC: number;
  aRainMm: number;
  // True when actuals come from recent past_days forecast before ERA5 archive settles
  provisional?: boolean;
}

export interface SerializedWeatherNetWeights {
  version: number;
  modelGridKey: string;
  trainedAtIso: string;
  lastObservedDate: string;
  totalParameters: number;
  trainSamples: number;
  evalSamples: number;
  wetThreshold: number;
  // Feature normalization stats (8 features)
  xMean: number[];
  xStd: number[];
  // Layer 1: 8 -> 16
  w1: number[];
  b1: number[];
  // Layer 2: 16 -> 12
  w2: number[];
  b2: number[];
  // Output head: 12 -> 4 [dTmax, dTmin, dLogRain, wetLogit]
  w3: number[];
  b3: number[];
  // Direct linear residual skip: 8 -> 4
  wSkip: number[];
}

export interface WeatherAccuracyMetrics {
  trainDays: number;
  heldOutDays: number;
  // Mean Absolute Temp Error (°C) = 0.5 * (|Tmax_err| + |Tmin_err|)
  rawTempMaeC: number;
  correctedTempMaeC: number;
  naiveTempMaeC: number;
  // Wet/Dry (>= 1.0 mm) classification hit-rate (%)
  rawRainHitRatePct: number;
  correctedRainHitRatePct: number;
  naiveRainHitRatePct: number;
  // Rain amount MAE (mm/day)
  rawRainMaeMm: number;
  correctedRainMaeMm: number;
  naiveRainMaeMm: number;
  // Strictly true only if CORRECTED beats RAW on held-out metrics
  beatsRaw: boolean;
  trainingTimeMs: number;
}

export interface WeatherLearningLogEntry {
  dayIso: string; // YYYY-MM-DD (Asia/Colombo learning day)
  trainedAtIso: string; // Full ISO timestamp
  sampleCount: number;
  provisionalCount: number;
  addedSamplesToday: number;
  trainTimeMs: number;
  championAdopted: boolean;
  correctedTempMaeC: number;
  rawTempMaeC: number;
  correctedRainHitRatePct: number;
  rawRainHitRatePct: number;
}

export interface WeatherSelfLearningState {
  isRunningCycle: boolean;
  lastLearningDay: string | null;
  lastTrainedAtIso: string | null;
  totalSamples: number;
  provisionalSamples: number;
  addedSamplesToday: number;
  learningDayCount: number;
  trendStatus: 'IMPROVING' | 'HOLDING';
  journal: WeatherLearningLogEntry[];
}

export interface CalibratedWeatherModelState {
  status: 'idle' | 'calibrating' | 'ready';
  weights: SerializedWeatherNetWeights | null;
  accuracy: WeatherAccuracyMetrics | null;
  useCorrectedDefault: boolean;
}

export interface RoofWeatherBundle {
  dataGridKey: string;
  modelGridKey: string;
  lat: number;
  lng: number;
  elevationM: number;
  locationLabel: string;
  sourceBadge: WeatherSourceBadge;
  fetchedAtIso: string;
  current: CurrentWeather | null;
  daily: DailyForecastItem[];
  soil: SoilEnvironmentData | null;
  climateNormals: MonthlyClimateNormal[];
  climateYearsSpan: string;
  model: CalibratedWeatherModelState;
  learning?: WeatherSelfLearningState;
  isLoadingForecast: boolean;
  isLoadingClimate: boolean;
}
