import {
  DailyForecastItem,
  HistoricalPairSample,
  SerializedWeatherNetWeights,
  WeatherAccuracyMetrics,
} from './weatherTypes';

const IN_DIM = 8;
const H1_DIM = 16;
const H2_DIM = 12;
const OUT_DIM = 4;
export const LANKA_WEATHER_NET_PARAMS =
  IN_DIM * H1_DIM +
  H1_DIM +
  H1_DIM * H2_DIM +
  H2_DIM +
  H2_DIM * OUT_DIM +
  OUT_DIM +
  IN_DIM * OUT_DIM; // 432 params

function dayOfYearFromIso(dateStr: string): number {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return 180;
  const y = Number(parts[0]);
  const m = Number(parts[1]) - 1;
  const d = Number(parts[2]);
  const dt = Date.UTC(y, m, d);
  const jan1 = Date.UTC(y, 0, 1);
  return Math.max(1, Math.floor((dt - jan1) / 86400000) + 1);
}

export function extractRawFeatures(
  fTempMaxC: number,
  fTempMinC: number,
  fHumidityPct: number,
  fPressureHpa: number,
  fWindMaxKmh: number,
  fRainMm: number,
  doy: number
): number[] {
  const angle = (2 * Math.PI * doy) / 365.25;
  return [
    fTempMaxC,
    fTempMinC,
    fHumidityPct,
    fPressureHpa,
    fWindMaxKmh,
    Math.log1p(Math.max(0, fRainMm)),
    Math.sin(angle),
    Math.cos(angle),
  ];
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Pure forward inference pass of LankaWeatherNet on a single forecast day.
 */
export function predictCorrectedDay(
  weights: SerializedWeatherNetWeights,
  input: {
    date: string;
    rawTempMaxC: number;
    rawTempMinC: number;
    humidityMeanPct: number;
    pressureMeanHpa: number;
    windMaxKmh: number;
    rawRainSumMm: number;
  }
): {
  correctedTempMaxC: number;
  correctedTempMinC: number;
  correctedRainSumMm: number;
  correctedWetProbPct: number;
} {
  const doy = dayOfYearFromIso(input.date);
  const rawFeat = extractRawFeatures(
    input.rawTempMaxC,
    input.rawTempMinC,
    input.humidityMeanPct,
    input.pressureMeanHpa,
    input.windMaxKmh,
    input.rawRainSumMm,
    doy
  );

  const x = new Array<number>(IN_DIM);
  for (let i = 0; i < IN_DIM; i++) {
    x[i] = (rawFeat[i] - weights.xMean[i]) / (weights.xStd[i] || 1);
  }

  const h1 = new Array<number>(H1_DIM);
  for (let j = 0; j < H1_DIM; j++) {
    let sum = weights.b1[j];
    const row = j * IN_DIM;
    for (let i = 0; i < IN_DIM; i++) sum += weights.w1[row + i] * x[i];
    h1[j] = Math.tanh(sum);
  }

  const h2 = new Array<number>(H2_DIM);
  for (let k = 0; k < H2_DIM; k++) {
    let sum = weights.b2[k];
    const row = k * H1_DIM;
    for (let j = 0; j < H1_DIM; j++) sum += weights.w2[row + j] * h1[j];
    h2[k] = Math.tanh(sum);
  }

  const out = new Array<number>(OUT_DIM);
  for (let o = 0; o < OUT_DIM; o++) {
    let sum = weights.b3[o];
    const row3 = o * H2_DIM;
    for (let k = 0; k < H2_DIM; k++) sum += weights.w3[row3 + k] * h2[k];
    const rowS = o * IN_DIM;
    for (let i = 0; i < IN_DIM; i++) sum += weights.wSkip[rowS + i] * x[i];
    out[o] = sum;
  }

  const dTmax = clamp(out[0], -4.5, 4.5);
  const dTmin = clamp(out[1], -4.5, 4.5);
  const dLogRain = clamp(out[2], -2.2, 2.2);
  const wetProb = sigmoid(out[3]);

  let cTmax = input.rawTempMaxC + dTmax;
  let cTmin = input.rawTempMinC + dTmin;
  if (cTmax < cTmin + 0.4) {
    const mid = 0.5 * (cTmax + cTmin);
    cTmax = mid + 0.2;
    cTmin = mid - 0.2;
  }

  const baseLogRain = Math.log1p(Math.max(0, input.rawRainSumMm));
  let cRain = Math.max(0, Math.expm1(Math.max(0, baseLogRain + dLogRain)));

  // Suppress false tropical convective drizzle when wet probability is clearly below threshold
  if (wetProb < weights.wetThreshold * 0.65 && input.rawRainSumMm < 2.5) {
    cRain *= clamp(wetProb / Math.max(0.15, weights.wetThreshold), 0, 1);
  }
  if (cRain < 0.12) cRain = 0;

  return {
    correctedTempMaxC: Number(cTmax.toFixed(1)),
    correctedTempMinC: Number(cTmin.toFixed(1)),
    correctedRainSumMm: Number(cRain.toFixed(1)),
    correctedWetProbPct: Math.round(wetProb * 100),
  };
}

export function applyWeatherNetToDaily(
  daily: DailyForecastItem[],
  weights: SerializedWeatherNetWeights | null
): DailyForecastItem[] {
  if (!weights) return daily;
  return daily.map((d) => {
    const corr = predictCorrectedDay(weights, d);
    return {
      ...d,
      ...corr,
    };
  });
}

/**
 * Selects the deterministic held-out evaluation slice: the most recent ~45 non-provisional days.
 */
export function selectHeldOutNonProvisionalIndices(
  samples: HistoricalPairSample[]
): number[] {
  const nTotal = samples.length;
  if (nTotal === 0) return [];
  const nonProv: number[] = [];
  for (let i = 0; i < nTotal; i++) {
    if (!samples[i].provisional) nonProv.push(i);
  }
  if (nonProv.length >= 40) {
    const count = Math.min(45, Math.max(20, Math.floor(nonProv.length * 0.18)));
    return nonProv.slice(nonProv.length - count);
  }
  const fallbackCount = Math.min(45, Math.max(10, Math.floor(nTotal * 0.18)));
  const out: number[] = [];
  for (let i = nTotal - fallbackCount; i < nTotal; i++) {
    if (i >= 0) out.push(i);
  }
  return out;
}

/**
 * Evaluates any saved weights (e.g. current Champion) on the exact same held-out slice
 * (most recent ~45 non-provisional days) for fair Champion-vs-Challenger scoring.
 */
export function evaluateWeightsOnHeldOut(
  weights: SerializedWeatherNetWeights,
  samples: HistoricalPairSample[],
  trainingTimeMs = 0
): WeatherAccuracyMetrics {
  const evalIndices = selectHeldOutNonProvisionalIndices(samples);
  const heldOutDays = evalIndices.length;
  const trainDays = Math.max(0, samples.length - heldOutDays);

  let rawTempErrSum = 0;
  let corrTempErrSum = 0;
  let naiveTempErrSum = 0;

  let rawRainHits = 0;
  let corrRainHits = 0;
  let naiveRainHits = 0;

  let rawRainErrSum = 0;
  let corrRainErrSum = 0;
  let naiveRainErrSum = 0;

  for (let e = 0; e < heldOutDays; e++) {
    const idx = evalIndices[e];
    const s = samples[idx];
    const prev = samples[Math.max(0, idx - 1)];

    const angle = (2 * Math.PI * s.doy) / 365.25;
    const rawFeat = [
      s.fTempMaxC,
      s.fTempMinC,
      s.fHumidityPct,
      s.fPressureHpa,
      s.fWindMaxKmh,
      Math.log1p(Math.max(0, s.fRainMm)),
      Math.sin(angle),
      Math.cos(angle),
    ];

    const x = new Array<number>(IN_DIM);
    for (let i = 0; i < IN_DIM; i++) {
      x[i] = (rawFeat[i] - weights.xMean[i]) / (weights.xStd[i] || 1);
    }

    const h1 = new Array<number>(H1_DIM);
    for (let j = 0; j < H1_DIM; j++) {
      let sum = weights.b1[j];
      const row = j * IN_DIM;
      for (let i = 0; i < IN_DIM; i++) sum += weights.w1[row + i] * x[i];
      h1[j] = Math.tanh(sum);
    }

    const h2 = new Array<number>(H2_DIM);
    for (let k = 0; k < H2_DIM; k++) {
      let sum = weights.b2[k];
      const row = k * H1_DIM;
      for (let j = 0; j < H1_DIM; j++) sum += weights.w2[row + j] * h1[j];
      h2[k] = Math.tanh(sum);
    }

    const out = [0, 0, 0, 0];
    for (let o = 0; o < OUT_DIM; o++) {
      let sum = weights.b3[o];
      const row3 = o * H2_DIM;
      for (let k = 0; k < H2_DIM; k++) sum += weights.w3[row3 + k] * h2[k];
      const rowS = o * IN_DIM;
      for (let i = 0; i < IN_DIM; i++) sum += weights.wSkip[rowS + i] * x[i];
      out[o] = sum;
    }

    const dTmax = clamp(out[0], -4.5, 4.5);
    const dTmin = clamp(out[1], -4.5, 4.5);
    const dLogR = clamp(out[2], -2.2, 2.2);
    const wetProb = sigmoid(out[3]);

    const cTmax = s.fTempMaxC + dTmax;
    const cTmin = s.fTempMinC + dTmin;
    let cRain = Math.max(0, Math.expm1(Math.max(0, Math.log1p(Math.max(0, s.fRainMm)) + dLogR)));
    if (wetProb < weights.wetThreshold * 0.65 && s.fRainMm < 2.5) {
      cRain *= clamp(wetProb / Math.max(0.15, weights.wetThreshold), 0, 1);
    }

    rawTempErrSum += 0.5 * (Math.abs(s.fTempMaxC - s.aTempMaxC) + Math.abs(s.fTempMinC - s.aTempMinC));
    corrTempErrSum += 0.5 * (Math.abs(cTmax - s.aTempMaxC) + Math.abs(cTmin - s.aTempMinC));
    naiveTempErrSum +=
      0.5 * (Math.abs(prev.aTempMaxC - s.aTempMaxC) + Math.abs(prev.aTempMinC - s.aTempMinC));

    const actWet = s.aRainMm >= 1.0;
    if ((s.fRainMm >= 1.0) === actWet) rawRainHits++;
    if ((wetProb >= weights.wetThreshold) === actWet) corrRainHits++;
    if ((prev.aRainMm >= 1.0) === actWet) naiveRainHits++;

    rawRainErrSum += Math.abs(s.fRainMm - s.aRainMm);
    corrRainErrSum += Math.abs(cRain - s.aRainMm);
    naiveRainErrSum += Math.abs(prev.aRainMm - s.aRainMm);
  }

  const invHeld = 1 / Math.max(1, heldOutDays);
  const rawTempMaeC = Number((rawTempErrSum * invHeld).toFixed(2));
  const correctedTempMaeC = Number((corrTempErrSum * invHeld).toFixed(2));
  const naiveTempMaeC = Number((naiveTempErrSum * invHeld).toFixed(2));

  const rawRainHitRatePct = Number((rawRainHits * 100 * invHeld).toFixed(1));
  const correctedRainHitRatePct = Number((corrRainHits * 100 * invHeld).toFixed(1));
  const naiveRainHitRatePct = Number((naiveRainHits * 100 * invHeld).toFixed(1));

  const rawRainMaeMm = Number((rawRainErrSum * invHeld).toFixed(2));
  const correctedRainMaeMm = Number((corrRainErrSum * invHeld).toFixed(2));
  const naiveRainMaeMm = Number((naiveRainErrSum * invHeld).toFixed(2));

  const beatsRaw =
    correctedTempMaeC < rawTempMaeC && correctedRainHitRatePct >= rawRainHitRatePct - 1.5;

  return {
    trainDays,
    heldOutDays,
    rawTempMaeC,
    correctedTempMaeC,
    naiveTempMaeC,
    rawRainHitRatePct,
    correctedRainHitRatePct,
    naiveRainHitRatePct,
    rawRainMaeMm,
    correctedRainMaeMm,
    naiveRainMaeMm,
    beatsRaw,
    trainingTimeMs,
  };
}

/**
 * Combined multi-objective error score (lower = better) across held-out Temp MAE,
 * Rain Hit-Rate error, and Rain MAE.
 */
export function computeCombinedCalibrationLoss(acc: WeatherAccuracyMetrics): number {
  const tempRatio = acc.correctedTempMaeC / Math.max(0.25, acc.rawTempMaeC);
  const rainMissRatio =
    (100 - acc.correctedRainHitRatePct) / Math.max(10, 100 - acc.rawRainHitRatePct + 10);
  const rainMaeRatio = acc.correctedRainMaeMm / Math.max(0.5, acc.rawRainMaeMm);
  return 0.55 * tempRatio + 0.25 * rainMissRatio + 0.2 * rainMaeRatio;
}

/**
 * Champion vs Challenger gate: Challenger deploys ONLY if it keeps beatsRaw === true
 * AND beats the current Champion on the combined held-out score (or rescues a Champion
 * whose beatsRaw degraded on newly arrived actuals).
 */
export function doesChallengerBeatChampion(
  challengerAcc: WeatherAccuracyMetrics,
  championAccOnSameSlice: WeatherAccuracyMetrics
): boolean {
  if (!challengerAcc.beatsRaw) return false;
  if (!championAccOnSameSlice.beatsRaw) return true;
  const chalLoss = computeCombinedCalibrationLoss(challengerAcc);
  const champLoss = computeCombinedCalibrationLoss(championAccOnSameSlice);
  return chalLoss < champLoss - 1e-6;
}

/**
 * Self-contained recency-weighted training & held-out evaluation kernel.
 * Serialized via .toString() into an inline Web Worker — do not reference outer helpers here!
 */
export function trainAndEvaluateKernel(
  modelGridKey: string,
  samples: HistoricalPairSample[],
  previousWeights: SerializedWeatherNetWeights | null,
  totalParams: number
): {
  weights: SerializedWeatherNetWeights;
  accuracy: WeatherAccuracyMetrics;
} {
  const t0 = performance.now();
  const nTotal = samples.length;

  const parseIsoMs = (iso: string): number => {
    const p = iso.split('-');
    if (p.length !== 3) return 0;
    return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  };

  // 1. Identify held-out slice = most recent ~45 non-provisional days
  const nonProv: number[] = [];
  for (let i = 0; i < nTotal; i++) {
    if (!samples[i].provisional) nonProv.push(i);
  }

  let evalIndices: number[];
  if (nonProv.length >= 40) {
    const heldCount = Math.min(45, Math.max(20, Math.floor(nonProv.length * 0.18)));
    evalIndices = nonProv.slice(nonProv.length - heldCount);
  } else {
    const heldCount = Math.min(45, Math.max(10, Math.floor(nTotal * 0.18)));
    evalIndices = [];
    for (let i = Math.max(0, nTotal - heldCount); i < nTotal; i++) evalIndices.push(i);
  }
  const evalSet = new Set<number>(evalIndices);
  const heldOutDays = evalIndices.length;

  // 2. Partition remaining samples into fitIndices + clean non-provisional valIndices
  const trainPoolNonProv: number[] = [];
  const trainPoolProv: number[] = [];
  for (let i = 0; i < nTotal; i++) {
    if (evalSet.has(i)) continue;
    if (samples[i].provisional) trainPoolProv.push(i);
    else trainPoolNonProv.push(i);
  }

  const valCount = Math.max(18, Math.floor(trainPoolNonProv.length * 0.15));
  const valIndices =
    trainPoolNonProv.length > valCount
      ? trainPoolNonProv.slice(trainPoolNonProv.length - valCount)
      : trainPoolNonProv.slice();
  const valSet = new Set<number>(valIndices);

  const fitIndices: number[] = [];
  for (let i = 0; i < nTotal; i++) {
    if (!evalSet.has(i) && !valSet.has(i)) {
      fitIndices.push(i);
    }
  }
  const fitCount = fitIndices.length;
  const trainTotal = nTotal - heldOutDays;

  // 3. Exponential recency weights: weight = 0.5^(ageDays / 120) * (provisional ? 0.45 : 1.0)
  const newestMs = nTotal > 0 ? parseIsoMs(samples[nTotal - 1].date) : 0;
  const rawSampleW = new Float64Array(nTotal);
  let sumFitW = 0;
  for (let i = 0; i < nTotal; i++) {
    const ageDays = Math.max(0, (newestMs - parseIsoMs(samples[i].date)) / 86400000);
    const recency = Math.pow(0.5, ageDays / 120);
    const provFactor = samples[i].provisional ? 0.45 : 1.0;
    rawSampleW[i] = recency * provFactor;
  }
  for (let k = 0; k < fitCount; k++) {
    sumFitW += rawSampleW[fitIndices[k]];
  }
  const normFactor = fitCount / Math.max(1e-6, sumFitW);
  const sampleWeights = new Float64Array(nTotal);
  for (let i = 0; i < nTotal; i++) {
    sampleWeights[i] = rawSampleW[i] * normFactor;
  }

  const rawX: number[][] = samples.map((s) => {
    const angle = (2 * Math.PI * s.doy) / 365.25;
    return [
      s.fTempMaxC,
      s.fTempMinC,
      s.fHumidityPct,
      s.fPressureHpa,
      s.fWindMaxKmh,
      Math.log1p(Math.max(0, s.fRainMm)),
      Math.sin(angle),
      Math.cos(angle),
    ];
  });

  // Compute feature normalization exclusively on fitIndices
  const xMean = new Array<number>(8).fill(0);
  const xStd = new Array<number>(8).fill(0);
  for (let k = 0; k < fitCount; k++) {
    const idx = fitIndices[k];
    for (let f = 0; f < 8; f++) xMean[f] += rawX[idx][f];
  }
  for (let f = 0; f < 8; f++) xMean[f] /= Math.max(1, fitCount);

  for (let k = 0; k < fitCount; k++) {
    const idx = fitIndices[k];
    for (let f = 0; f < 8; f++) {
      const diff = rawX[idx][f] - xMean[f];
      xStd[f] += diff * diff;
    }
  }
  for (let f = 0; f < 8; f++) {
    xStd[f] = Math.max(1e-3, Math.sqrt(xStd[f] / Math.max(1, fitCount)));
  }

  const normX: Float64Array[] = rawX.map((row) => {
    const arr = new Float64Array(8);
    for (let f = 0; f < 8; f++) arr[f] = (row[f] - xMean[f]) / xStd[f];
    return arr;
  });

  // Deterministic PRNG for reproducible weight initialization
  let seed = 133742;
  const randSigned = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };

  const canWarmStart =
    previousWeights &&
    previousWeights.w1.length === 128 &&
    previousWeights.w2.length === 192 &&
    previousWeights.w3.length === 48 &&
    previousWeights.wSkip.length === 32;

  const w1 = canWarmStart
    ? Float64Array.from(previousWeights!.w1)
    : Float64Array.from({ length: 128 }, () => randSigned() * 0.14);
  const b1 = canWarmStart ? Float64Array.from(previousWeights!.b1) : new Float64Array(16);
  const w2 = canWarmStart
    ? Float64Array.from(previousWeights!.w2)
    : Float64Array.from({ length: 192 }, () => randSigned() * 0.12);
  const b2 = canWarmStart ? Float64Array.from(previousWeights!.b2) : new Float64Array(12);
  const w3 = canWarmStart
    ? Float64Array.from(previousWeights!.w3)
    : Float64Array.from({ length: 48 }, () => randSigned() * 0.04);
  const b3 = canWarmStart ? Float64Array.from(previousWeights!.b3) : new Float64Array(4);
  const wSkip = canWarmStart
    ? Float64Array.from(previousWeights!.wSkip)
    : Float64Array.from({ length: 32 }, () => randSigned() * 0.02);

  if (!canWarmStart) {
    let sumDTmax = 0,
      sumDTmin = 0,
      wetCount = 0;
    for (let k = 0; k < fitCount; k++) {
      const s = samples[fitIndices[k]];
      sumDTmax += s.aTempMaxC - s.fTempMaxC;
      sumDTmin += s.aTempMinC - s.fTempMinC;
      if (s.aRainMm >= 1.0) wetCount++;
    }
    b3[0] = sumDTmax / Math.max(1, fitCount);
    b3[1] = sumDTmin / Math.max(1, fitCount);
    const pWet = Math.min(0.9, Math.max(0.1, wetCount / Math.max(1, fitCount)));
    b3[3] = Math.log(pWet / (1 - pWet));
  }

  const params = [w1, b1, w2, b2, w3, b3, wSkip];
  const mBuf = params.map((p) => new Float64Array(p.length));
  const vBuf = params.map((p) => new Float64Array(p.length));

  // Capped daily training session (<= 260 epochs, early-stop on validation loss)
  const maxEpochs = canWarmStart ? 160 : 260;
  const earlyStopPatience = 34;
  const lrBase = canWarmStart ? 0.0036 : 0.0072;
  const weightDecay = 0.0025;

  const h1 = new Float64Array(16);
  const h2 = new Float64Array(12);
  const out = new Float64Array(4);
  const dOut = new Float64Array(4);
  const dH2 = new Float64Array(12);
  const dH1 = new Float64Array(16);

  const huberGrad = (err: number, delta = 0.85): number => {
    if (Math.abs(err) <= delta) return err / delta;
    return err > 0 ? 1 : -1;
  };

  // Seed bestValLoss with initial (warm-start) weights so warm-start never degrades val loss
  const computeValLoss = (): number => {
    let vLoss = 0;
    let vWeightSum = 0;
    for (let v = 0; v < valIndices.length; v++) {
      const idx = valIndices[v];
      const x = normX[idx];
      const s = samples[idx];
      const vw = rawSampleW[idx];
      vWeightSum += vw;
      for (let j = 0; j < 16; j++) {
        let sum = b1[j];
        const r = j * 8;
        for (let i = 0; i < 8; i++) sum += w1[r + i] * x[i];
        h1[j] = Math.tanh(sum);
      }
      for (let k = 0; k < 12; k++) {
        let sum = b2[k];
        const r = k * 16;
        for (let j = 0; j < 16; j++) sum += w2[r + j] * h1[j];
        h2[k] = Math.tanh(sum);
      }
      for (let o = 0; o < 4; o++) {
        let sum = b3[o];
        for (let k = 0; k < 12; k++) sum += w3[o * 12 + k] * h2[k];
        for (let i = 0; i < 8; i++) sum += wSkip[o * 8 + i] * x[i];
        out[o] = sum;
      }
      const pTmax = s.fTempMaxC + out[0];
      const pTmin = s.fTempMinC + out[1];
      const pWet =
        out[3] >= 0 ? 1 / (1 + Math.exp(-out[3])) : Math.exp(out[3]) / (1 + Math.exp(out[3]));
      const tWet = s.aRainMm >= 1.0 ? 1 : 0;
      const sampleLoss =
        0.5 * (Math.abs(pTmax - s.aTempMaxC) + Math.abs(pTmin - s.aTempMinC)) -
        0.4 * (tWet * Math.log(pWet + 1e-6) + (1 - tWet) * Math.log(1 - pWet + 1e-6));
      vLoss += vw * sampleLoss;
    }
    return vLoss / Math.max(1e-6, vWeightSum);
  };

  let bestValLoss = computeValLoss();
  let bestSnap = params.map((p) => Float64Array.from(p));
  let epochsWithoutImprove = 0;
  let step = 0;

  for (let ep = 0; ep < maxEpochs; ep++) {
    const grads = params.map((p) => new Float64Array(p.length));
    const [gw1, gb1, gw2, gb2, gw3, gb3, gwSkip] = grads;

    for (let fIdx = 0; fIdx < fitCount; fIdx++) {
      const idx = fitIndices[fIdx];
      const x = normX[idx];
      const s = samples[idx];
      const sw = sampleWeights[idx];

      for (let j = 0; j < 16; j++) {
        let sum = b1[j];
        const r = j * 8;
        for (let i = 0; i < 8; i++) sum += w1[r + i] * x[i];
        h1[j] = Math.tanh(sum);
      }
      for (let k = 0; k < 12; k++) {
        let sum = b2[k];
        const r = k * 16;
        for (let j = 0; j < 16; j++) sum += w2[r + j] * h1[j];
        h2[k] = Math.tanh(sum);
      }
      for (let o = 0; o < 4; o++) {
        let sum = b3[o];
        const r3 = o * 12;
        for (let k = 0; k < 12; k++) sum += w3[r3 + k] * h2[k];
        const rS = o * 8;
        for (let i = 0; i < 8; i++) sum += wSkip[rS + i] * x[i];
        out[o] = sum;
      }

      const targetDTmax = s.aTempMaxC - s.fTempMaxC;
      const targetDTmin = s.aTempMinC - s.fTempMinC;
      const targetDLogRain =
        Math.log1p(Math.max(0, s.aRainMm)) - Math.log1p(Math.max(0, s.fRainMm));
      const targetWet = s.aRainMm >= 1.0 ? 1 : 0;
      const predWet =
        out[3] >= 0 ? 1 / (1 + Math.exp(-out[3])) : Math.exp(out[3]) / (1 + Math.exp(out[3]));

      dOut[0] = sw * huberGrad(out[0] - targetDTmax, 0.75);
      dOut[1] = sw * huberGrad(out[1] - targetDTmin, 0.75);
      dOut[2] = sw * 0.65 * huberGrad(out[2] - targetDLogRain, 0.6);
      dOut[3] = sw * 0.85 * (predWet - targetWet);

      for (let o = 0; o < 4; o++) {
        const go = dOut[o];
        gb3[o] += go;
        const r3 = o * 12;
        for (let k = 0; k < 12; k++) gw3[r3 + k] += go * h2[k];
        const rS = o * 8;
        for (let i = 0; i < 8; i++) gwSkip[rS + i] += go * x[i];
      }

      for (let k = 0; k < 12; k++) {
        let sum = 0;
        for (let o = 0; o < 4; o++) sum += w3[o * 12 + k] * dOut[o];
        dH2[k] = sum * (1 - h2[k] * h2[k]);
        gb2[k] += dH2[k];
        const r2 = k * 16;
        for (let j = 0; j < 16; j++) gw2[r2 + j] += dH2[k] * h1[j];
      }

      for (let j = 0; j < 16; j++) {
        let sum = 0;
        for (let k = 0; k < 12; k++) sum += w2[k * 16 + j] * dH2[k];
        dH1[j] = sum * (1 - h1[j] * h1[j]);
        gb1[j] += dH1[j];
        const r1 = j * 8;
        for (let i = 0; i < 8; i++) gw1[r1 + i] += dH1[j] * x[i];
      }
    }

    step++;
    const lr = lrBase * (1 - 0.45 * (ep / maxEpochs));
    const b1Pow = 1 - Math.pow(0.9, step);
    const b2Pow = 1 - Math.pow(0.999, step);
    const invN = 1 / Math.max(1, fitCount);

    for (let pIdx = 0; pIdx < params.length; pIdx++) {
      const p = params[pIdx];
      const g = grads[pIdx];
      const m = mBuf[pIdx];
      const v = vBuf[pIdx];
      const isBias = pIdx === 1 || pIdx === 3 || pIdx === 5;
      for (let i = 0; i < p.length; i++) {
        const gi = g[i] * invN + (isBias ? 0 : weightDecay * p[i]);
        m[i] = 0.9 * m[i] + 0.1 * gi;
        v[i] = 0.999 * v[i] + 0.001 * gi * gi;
        const mHat = m[i] / b1Pow;
        const vHat = v[i] / b2Pow;
        p[i] -= (lr * mHat) / (Math.sqrt(vHat) + 1e-8);
      }
    }

    const valLoss = computeValLoss();
    if (valLoss < bestValLoss - 1e-5) {
      bestValLoss = valLoss;
      bestSnap = params.map((p) => Float64Array.from(p));
      epochsWithoutImprove = 0;
    } else {
      epochsWithoutImprove++;
      if (epochsWithoutImprove >= earlyStopPatience) {
        break;
      }
    }
  }

  const [bw1, bb1, bw2, bb2, bw3, bb3, bwSkip] = bestSnap;

  const evalSampleRawOut = (idx: number): [number, number, number, number] => {
    const x = normX[idx];
    for (let j = 0; j < 16; j++) {
      let sum = bb1[j];
      for (let i = 0; i < 8; i++) sum += bw1[j * 8 + i] * x[i];
      h1[j] = Math.tanh(sum);
    }
    for (let k = 0; k < 12; k++) {
      let sum = bb2[k];
      for (let j = 0; j < 16; j++) sum += bw2[k * 16 + j] * h1[j];
      h2[k] = Math.tanh(sum);
    }
    const res: [number, number, number, number] = [0, 0, 0, 0];
    for (let o = 0; o < 4; o++) {
      let sum = bb3[o];
      for (let k = 0; k < 12; k++) sum += bw3[o * 12 + k] * h2[k];
      for (let i = 0; i < 8; i++) sum += bwSkip[o * 8 + i] * x[i];
      res[o] = sum;
    }
    return res;
  };

  // Select optimal wet/dry threshold on non-eval samples (strictly BEFORE held-out evalIndices!)
  let bestThresh = 0.5;
  let bestValAcc = -1;
  for (let th = 0.32; th <= 0.68; th += 0.03) {
    let weightedHits = 0;
    for (let i = 0; i < nTotal; i++) {
      if (evalSet.has(i)) continue;
      const o = evalSampleRawOut(i);
      const prob = o[3] >= 0 ? 1 / (1 + Math.exp(-o[3])) : Math.exp(o[3]) / (1 + Math.exp(o[3]));
      const predWet = prob >= th;
      const actWet = samples[i].aRainMm >= 1.0;
      if (predWet === actWet) weightedHits += rawSampleW[i];
    }
    if (weightedHits > bestValAcc) {
      bestValAcc = weightedHits;
      bestThresh = Number(th.toFixed(2));
    }
  }

  // Strictly unseen Held-Out Evaluation on evalIndices (most recent ~45 non-provisional days)
  let rawTempErrSum = 0;
  let corrTempErrSum = 0;
  let naiveTempErrSum = 0;

  let rawRainHits = 0;
  let corrRainHits = 0;
  let naiveRainHits = 0;

  let rawRainErrSum = 0;
  let corrRainErrSum = 0;
  let naiveRainErrSum = 0;

  for (let e = 0; e < heldOutDays; e++) {
    const idx = evalIndices[e];
    const s = samples[idx];
    const prev = samples[Math.max(0, idx - 1)];
    const o = evalSampleRawOut(idx);

    const dTmax = Math.max(-4.5, Math.min(4.5, o[0]));
    const dTmin = Math.max(-4.5, Math.min(4.5, o[1]));
    const dLogR = Math.max(-2.2, Math.min(2.2, o[2]));
    const wetProb = o[3] >= 0 ? 1 / (1 + Math.exp(-o[3])) : Math.exp(o[3]) / (1 + Math.exp(o[3]));

    const cTmax = s.fTempMaxC + dTmax;
    const cTmin = s.fTempMinC + dTmin;
    let cRain = Math.max(0, Math.expm1(Math.max(0, Math.log1p(Math.max(0, s.fRainMm)) + dLogR)));
    if (wetProb < bestThresh * 0.65 && s.fRainMm < 2.5) {
      cRain *= Math.max(0, Math.min(1, wetProb / Math.max(0.15, bestThresh)));
    }

    rawTempErrSum += 0.5 * (Math.abs(s.fTempMaxC - s.aTempMaxC) + Math.abs(s.fTempMinC - s.aTempMinC));
    corrTempErrSum += 0.5 * (Math.abs(cTmax - s.aTempMaxC) + Math.abs(cTmin - s.aTempMinC));
    naiveTempErrSum +=
      0.5 * (Math.abs(prev.aTempMaxC - s.aTempMaxC) + Math.abs(prev.aTempMinC - s.aTempMinC));

    const actWet = s.aRainMm >= 1.0;
    if ((s.fRainMm >= 1.0) === actWet) rawRainHits++;
    if ((wetProb >= bestThresh) === actWet) corrRainHits++;
    if ((prev.aRainMm >= 1.0) === actWet) naiveRainHits++;

    rawRainErrSum += Math.abs(s.fRainMm - s.aRainMm);
    corrRainErrSum += Math.abs(cRain - s.aRainMm);
    naiveRainErrSum += Math.abs(prev.aRainMm - s.aRainMm);
  }

  const invHeld = 1 / Math.max(1, heldOutDays);
  const rawTempMaeC = Number((rawTempErrSum * invHeld).toFixed(2));
  const correctedTempMaeC = Number((corrTempErrSum * invHeld).toFixed(2));
  const naiveTempMaeC = Number((naiveTempErrSum * invHeld).toFixed(2));

  const rawRainHitRatePct = Number((rawRainHits * 100 * invHeld).toFixed(1));
  const correctedRainHitRatePct = Number((corrRainHits * 100 * invHeld).toFixed(1));
  const naiveRainHitRatePct = Number((naiveRainHits * 100 * invHeld).toFixed(1));

  const rawRainMaeMm = Number((rawRainErrSum * invHeld).toFixed(2));
  const correctedRainMaeMm = Number((corrRainErrSum * invHeld).toFixed(2));
  const naiveRainMaeMm = Number((naiveRainErrSum * invHeld).toFixed(2));

  const beatsRaw =
    correctedTempMaeC < rawTempMaeC && correctedRainHitRatePct >= rawRainHitRatePct - 1.5;

  const weights: SerializedWeatherNetWeights = {
    version: 2,
    modelGridKey,
    trainedAtIso: new Date().toISOString(),
    lastObservedDate: samples[samples.length - 1]?.date || '',
    totalParameters: totalParams,
    trainSamples: trainTotal,
    evalSamples: heldOutDays,
    wetThreshold: bestThresh,
    xMean: xMean.map((v) => Number(v.toFixed(5))),
    xStd: xStd.map((v) => Number(v.toFixed(5))),
    w1: Array.from(bw1, (v) => Number(v.toFixed(6))),
    b1: Array.from(bb1, (v) => Number(v.toFixed(6))),
    w2: Array.from(bw2, (v) => Number(v.toFixed(6))),
    b2: Array.from(bb2, (v) => Number(v.toFixed(6))),
    w3: Array.from(bw3, (v) => Number(v.toFixed(6))),
    b3: Array.from(bb3, (v) => Number(v.toFixed(6))),
    wSkip: Array.from(bwSkip, (v) => Number(v.toFixed(6))),
  };

  const accuracy: WeatherAccuracyMetrics = {
    trainDays: trainTotal,
    heldOutDays,
    rawTempMaeC,
    correctedTempMaeC,
    naiveTempMaeC,
    rawRainHitRatePct,
    correctedRainHitRatePct,
    naiveRainHitRatePct,
    rawRainMaeMm,
    correctedRainMaeMm,
    naiveRainMaeMm,
    beatsRaw,
    trainingTimeMs: Math.max(1, Math.round(performance.now() - t0)),
  };

  return { weights, accuracy };
}

/**
 * Trains LankaWeatherNet off the main thread inside a dedicated inline Web Worker
 * (with seamless async fallback if Blob workers are unavailable).
 */
export function trainLankaWeatherNetInWorker(
  modelGridKey: string,
  samples: HistoricalPairSample[],
  previousWeights: SerializedWeatherNetWeights | null
): Promise<{
  weights: SerializedWeatherNetWeights;
  accuracy: WeatherAccuracyMetrics;
}> {
  if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
    return new Promise((resolve) => {
      let settled = false;
      const workerCode = `
        const kernel = ${trainAndEvaluateKernel.toString()};
        self.onmessage = function(e) {
          try {
            const { modelGridKey, samples, previousWeights, totalParams } = e.data;
            const res = kernel(modelGridKey, samples, previousWeights, totalParams);
            self.postMessage({ ok: true, res });
          } catch (err) {
            self.postMessage({ ok: false, error: String(err) });
          }
        };
      `;
      let workerUrl = '';
      try {
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        workerUrl = URL.createObjectURL(blob);
        const worker = new Worker(workerUrl);

        const cleanup = () => {
          worker.terminate();
          if (workerUrl) URL.revokeObjectURL(workerUrl);
        };

        worker.onmessage = (ev: MessageEvent) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (ev.data && ev.data.ok) {
            resolve(ev.data.res);
          } else {
            resolve(
              trainAndEvaluateKernel(
                modelGridKey,
                samples,
                previousWeights,
                LANKA_WEATHER_NET_PARAMS
              )
            );
          }
        };

        worker.onerror = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(
            trainAndEvaluateKernel(
              modelGridKey,
              samples,
              previousWeights,
              LANKA_WEATHER_NET_PARAMS
            )
          );
        };

        worker.postMessage({
          modelGridKey,
          samples,
          previousWeights,
          totalParams: LANKA_WEATHER_NET_PARAMS,
        });
      } catch {
        if (workerUrl) URL.revokeObjectURL(workerUrl);
        if (!settled) {
          settled = true;
          resolve(
            trainAndEvaluateKernel(
              modelGridKey,
              samples,
              previousWeights,
              LANKA_WEATHER_NET_PARAMS
            )
          );
        }
      }
    });
  }

  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(
        trainAndEvaluateKernel(
          modelGridKey,
          samples,
          previousWeights,
          LANKA_WEATHER_NET_PARAMS
        )
      );
    }, 0);
  });
}
