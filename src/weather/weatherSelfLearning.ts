import {
  doesChallengerBeatChampion,
  evaluateWeightsOnHeldOut,
  trainLankaWeatherNetInWorker,
} from './lankaWeatherNet';
import {
  appendLearningJournalEntry,
  getCachedModelArtifact,
  getCachedTrainingPairs,
  getFallbackChampionArtifact,
  getLastLearningDay,
  getLearningJournal,
  listKnownModelGridKeys,
  parseCoordsFromModelGridKey,
  saveCachedModelArtifact,
  saveCachedTrainingPairs,
  saveFallbackChampionArtifact,
  setLastLearningDay,
  StoredModelArtifact,
} from './weatherCache';
import {
  fetchHistoricalPairsRange,
  fetchProvisionalRecentPairs,
  getColomboTodayIso,
  notifyModelGridLearningUpdate,
  shiftIsoDate,
} from './weatherService';
import {
  HistoricalPairSample,
  WeatherLearningLogEntry,
  WeatherSelfLearningState,
} from './weatherTypes';

const MAX_ROLLING_SAMPLES = 800;
const MIN_SAMPLES_FLOOR = 120;
const HOURLY_HEARTBEAT_MS = 60 * 60 * 1000;

const runningCycles = new Map<string, Promise<void>>();
let schedulerInitialized = false;
let heartbeatTimerId: ReturnType<typeof setInterval> | null = null;

function scheduleBackgroundIdle(task: () => void): void {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    (
      window as Window & {
        requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number;
      }
    ).requestIdleCallback(task, { timeout: 2000 });
  } else {
    setTimeout(task, 120);
  }
}

/**
 * Computes IMPROVING vs HOLDING badge from the learning journal:
 * Compares the last up-to-7 entries against the previous up-to-7 entries on correctedTempMaeC.
 */
export function computeJournalTrendStatus(
  journal: WeatherLearningLogEntry[]
): 'IMPROVING' | 'HOLDING' {
  if (journal.length < 2) return 'HOLDING';

  let recentSlice: WeatherLearningLogEntry[];
  let prevSlice: WeatherLearningLogEntry[];

  if (journal.length >= 14) {
    recentSlice = journal.slice(-7);
    prevSlice = journal.slice(-14, -7);
  } else {
    const splitIdx = Math.max(1, journal.length - Math.min(7, Math.floor(journal.length / 2)));
    prevSlice = journal.slice(0, splitIdx);
    recentSlice = journal.slice(splitIdx);
  }

  if (prevSlice.length === 0 || recentSlice.length === 0) return 'HOLDING';

  const meanMae = (arr: WeatherLearningLogEntry[]) =>
    arr.reduce((acc, item) => acc + item.correctedTempMaeC, 0) / arr.length;

  return meanMae(recentSlice) < meanMae(prevSlice) - 1e-4 ? 'IMPROVING' : 'HOLDING';
}

/**
 * Builds a live WeatherSelfLearningState snapshot for UI display from cached pairs & journal.
 */
export async function buildLearningStateSnapshot(
  modelGridKey: string,
  isRunningCycle = runningCycles.has(modelGridKey)
): Promise<WeatherSelfLearningState> {
  const [lastLearningDay, pairs, journal, artifact] = await Promise.all([
    getLastLearningDay(modelGridKey),
    getCachedTrainingPairs(modelGridKey),
    getLearningJournal(modelGridKey),
    getCachedModelArtifact(modelGridKey),
  ]);

  const samples = pairs?.samples || [];
  let provisionalSamples = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].provisional) provisionalSamples++;
  }

  const latestEntry = journal.length > 0 ? journal[journal.length - 1] : null;
  const todayIso = getColomboTodayIso();
  const addedSamplesToday =
    latestEntry && latestEntry.dayIso === todayIso ? latestEntry.addedSamplesToday : 0;

  return {
    isRunningCycle,
    lastLearningDay,
    lastTrainedAtIso: latestEntry?.trainedAtIso ?? artifact?.weights.trainedAtIso ?? null,
    totalSamples: samples.length || latestEntry?.sampleCount || artifact?.weights.trainSamples || 0,
    provisionalSamples,
    addedSamplesToday,
    learningDayCount: journal.length,
    trendStatus: computeJournalTrendStatus(journal),
    journal,
  };
}

export interface LearningTriggerOptions {
  lat?: number;
  lng?: number;
  freshEra5Map?: Map<string, { aTempMaxC: number; aTempMinC: number; aRainMm: number }>;
  todayOverrideIso?: string;
}

/**
 * Checks whether `modelGridKey` needs today's Daily Learning Cycle (or initial calibration)
 * and runs at most ONE background cycle per Colombo calendar day per grid cell.
 */
export async function triggerSelfLearningForGrid(
  modelGridKey: string,
  opts?: LearningTriggerOptions
): Promise<void> {
  if (runningCycles.has(modelGridKey)) {
    return runningCycles.get(modelGridKey);
  }

  const todayIso = opts?.todayOverrideIso || getColomboTodayIso();
  const [previousLearningDay, existingArtifact, existingPairs] = await Promise.all([
    getLastLearningDay(modelGridKey),
    getCachedModelArtifact(modelGridKey),
    getCachedTrainingPairs(modelGridKey),
  ]);

  const needsInitialModel = !existingArtifact;
  const isNewDay = !previousLearningDay || todayIso > previousLearningDay;

  if (!needsInitialModel && !isNewDay) {
    return;
  }

  // Resolve coordinates for this grid cell
  const parsed = parseCoordsFromModelGridKey(modelGridKey);
  const lat = opts?.lat ?? existingPairs?.lat ?? parsed?.lat;
  const lng = opts?.lng ?? existingPairs?.lng ?? parsed?.lng;
  if (lat === undefined || lng === undefined) {
    return;
  }

  // Claim today's learning slot immediately so parallel triggers never duplicate work.
  // On fetch/offline failure before completion, we restore previousLearningDay so it retries!
  await setLastLearningDay(modelGridKey, todayIso);

  const cyclePromise = runDailyLearningCycle(
    modelGridKey,
    lat,
    lng,
    todayIso,
    previousLearningDay,
    opts?.freshEra5Map
  ).finally(() => {
    runningCycles.delete(modelGridKey);
  });

  runningCycles.set(modelGridKey, cyclePromise);
  return cyclePromise;
}

/**
 * Executes the ordered 6-step Daily Learning Cycle in the background:
 * 1. APPEND finalized ERA5 + backfill previously provisional days
 * 2. FRESH TRUTH: join past_days=10 provisional actuals up to yesterday
 * 3. RETRAIN warm-started with recency weighting 0.5^(ageDays/120) in Web Worker
 * 4. CHAMPION vs CHALLENGER gate on most recent ~45 non-provisional days
 * 5. PERSIST + EMIT live bundle update
 * 6. LEARNING JOURNAL append (capped at 365 entries)
 */
async function runDailyLearningCycle(
  modelGridKey: string,
  lat: number,
  lng: number,
  todayIso: string,
  previousLearningDay: string | null,
  freshEra5Map?: Map<string, { aTempMaxC: number; aTempMinC: number; aRainMm: number }>
): Promise<void> {
  const [cachedPairs, championArtifact, fallbackArtifact] = await Promise.all([
    getCachedTrainingPairs(modelGridKey),
    getCachedModelArtifact(modelGridKey),
    getFallbackChampionArtifact(modelGridKey),
  ]);

  // Emit "TRAINING NOW…" indicator while keeping existing champion serving uninterrupted
  const startingState = await buildLearningStateSnapshot(modelGridKey, true);
  notifyModelGridLearningUpdate(modelGridKey, championArtifact, startingState);

  const yesterdayIso = shiftIsoDate(todayIso, -1);

  try {
    const priorSamples = cachedPairs?.samples || [];
    const priorDates = new Set<string>(priorSamples.map((s) => s.date));

    // Identify earliest provisional date so we re-fetch ERA5 over that window to replace provisional -> final!
    let earliestProvisionalDate: string | null = null;
    let latestFinalizedDate: string | null = null;
    for (let i = 0; i < priorSamples.length; i++) {
      const s = priorSamples[i];
      if (s.provisional) {
        if (!earliestProvisionalDate || s.date < earliestProvisionalDate) {
          earliestProvisionalDate = s.date;
        }
      } else {
        if (!latestFinalizedDate || s.date > latestFinalizedDate) {
          latestFinalizedDate = s.date;
        }
      }
    }

    const byDate = new Map<string, HistoricalPairSample>();
    for (let i = 0; i < priorSamples.length; i++) {
      byDate.set(priorSamples[i].date, priorSamples[i]);
    }

    // STEP 1: APPEND finalized ERA5 + backfill previously provisional days
    if (priorSamples.length >= MIN_SAMPLES_FLOOR) {
      let era5Start: string;
      if (earliestProvisionalDate) {
        era5Start = earliestProvisionalDate;
      } else if (latestFinalizedDate) {
        era5Start = shiftIsoDate(latestFinalizedDate, 1);
      } else {
        era5Start = shiftIsoDate(cachedPairs!.lastEndDate, 1);
      }

      if (era5Start <= yesterdayIso) {
        const era5Delta = await fetchHistoricalPairsRange(
          lat,
          lng,
          era5Start,
          yesterdayIso,
          freshEra5Map
        );
        for (let i = 0; i < era5Delta.length; i++) {
          const finalSample = era5Delta[i];
          // Finalized ERA5 overwrites provisional sample & clears provisional flag
          byDate.set(finalSample.date, {
            ...finalSample,
            provisional: undefined,
          });
          if (!latestFinalizedDate || finalSample.date > latestFinalizedDate) {
            latestFinalizedDate = finalSample.date;
          }
        }
      }
    } else {
      // Cold bootstrap (~640 days of historical forecast vs ERA5 pairs)
      const initialStart = shiftIsoDate(yesterdayIso, -645);
      const initialEra5 = await fetchHistoricalPairsRange(
        lat,
        lng,
        initialStart,
        yesterdayIso,
        freshEra5Map
      );
      for (let i = 0; i < initialEra5.length; i++) {
        const s = initialEra5[i];
        byDate.set(s.date, s);
        if (!latestFinalizedDate || s.date > latestFinalizedDate) {
          latestFinalizedDate = s.date;
        }
      }
    }

    // STEP 2: FRESH TRUTH — fetch provisional actuals (past_days=10) for dates newer than settled ERA5
    const provStart = latestFinalizedDate
      ? shiftIsoDate(latestFinalizedDate, 1)
      : shiftIsoDate(yesterdayIso, -9);

    if (provStart <= yesterdayIso) {
      try {
        const provSamples = await fetchProvisionalRecentPairs(
          lat,
          lng,
          provStart,
          yesterdayIso
        );
        for (let i = 0; i < provSamples.length; i++) {
          const ps = provSamples[i];
          const existing = byDate.get(ps.date);
          // Only insert/update if we don't already have finalized ERA5 for that date
          if (!existing || existing.provisional) {
            byDate.set(ps.date, {
              ...ps,
              provisional: true,
            });
          }
        }
      } catch {
        // Provisional endpoint failure is non-fatal if core ERA5 dataset succeeded
      }
    }

    let mergedSamples = Array.from(byDate.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    if (mergedSamples.length < MIN_SAMPLES_FLOOR) {
      // Insufficient samples (e.g. offline): restore flag so next trigger retries quietly
      await setLastLearningDay(modelGridKey, previousLearningDay);
      const idleSnap = await buildLearningStateSnapshot(modelGridKey, false);
      notifyModelGridLearningUpdate(modelGridKey, championArtifact, idleSnap);
      return;
    }

    // Count newly added calendar days before rolling cap trim
    let addedSamplesToday = 0;
    for (let i = 0; i < mergedSamples.length; i++) {
      if (!priorDates.has(mergedSamples[i].date)) {
        addedSamplesToday++;
      }
    }

    // Rolling window cap at ~800 days (never drop below MIN_SAMPLES_FLOOR = 120)
    if (mergedSamples.length > MAX_ROLLING_SAMPLES) {
      mergedSamples = mergedSamples.slice(mergedSamples.length - MAX_ROLLING_SAMPLES);
    }

    let provisionalCount = 0;
    let finalLastSettledDate = '';
    for (let i = 0; i < mergedSamples.length; i++) {
      if (mergedSamples[i].provisional) {
        provisionalCount++;
      } else {
        finalLastSettledDate = mergedSamples[i].date;
      }
    }

    const actualLastDate = mergedSamples[mergedSamples.length - 1].date;

    // STEP 3: RETRAIN warm-started + recency-weighted in Web Worker
    const priorChampion = championArtifact ?? fallbackArtifact ?? null;
    const challenger = await trainLankaWeatherNetInWorker(
      modelGridKey,
      mergedSamples,
      priorChampion?.weights ?? null
    );

    // STEP 4: CHAMPION vs CHALLENGER on the EXACT SAME held-out slice (~45 recent non-provisional days)
    let activeArtifact: StoredModelArtifact;
    let championAdopted = false;

    if (priorChampion) {
      const championEvalOnCurrentSlice = evaluateWeightsOnHeldOut(
        priorChampion.weights,
        mergedSamples,
        0
      );

      if (doesChallengerBeatChampion(challenger.accuracy, championEvalCurrent(championEvalOnCurrentSlice))) {
        // Challenger wins AND keeps beatsRaw: true -> archive old champion as fallback, deploy challenger!
        await saveFallbackChampionArtifact(modelGridKey, priorChampion);
        activeArtifact = {
          modelGridKey,
          lastEndDate: actualLastDate,
          weights: challenger.weights,
          accuracy: challenger.accuracy,
        };
        championAdopted = true;
      } else {
        // Challenger rejected -> never regress! Keep serving current champion weights.
        activeArtifact = {
          modelGridKey,
          lastEndDate: actualLastDate,
          weights: priorChampion.weights,
          accuracy: {
            ...championEvalOnCurrentSlice,
            trainingTimeMs: challenger.accuracy.trainingTimeMs,
          },
        };
        championAdopted = false;
      }
    } else {
      // First model ever trained for this grid cell
      activeArtifact = {
        modelGridKey,
        lastEndDate: actualLastDate,
        weights: challenger.weights,
        accuracy: challenger.accuracy,
      };
      championAdopted = challenger.accuracy.beatsRaw;
      if (championAdopted) {
        await saveFallbackChampionArtifact(modelGridKey, activeArtifact);
      }
    }

    // STEP 5 & 6: PERSIST pairs + active champion + LEARNING JOURNAL (cap 365) + EMIT live
    await Promise.all([
      saveCachedTrainingPairs(modelGridKey, {
        modelGridKey,
        lat,
        lng,
        lastEndDate: actualLastDate,
        lastFinalizedDate: finalLastSettledDate || undefined,
        samples: mergedSamples,
      }),
      saveCachedModelArtifact(modelGridKey, activeArtifact),
    ]);

    const logEntry: WeatherLearningLogEntry = {
      dayIso: todayIso,
      trainedAtIso: new Date().toISOString(),
      sampleCount: mergedSamples.length,
      provisionalCount,
      addedSamplesToday,
      trainTimeMs: challenger.accuracy.trainingTimeMs,
      championAdopted,
      correctedTempMaeC: activeArtifact.accuracy.correctedTempMaeC,
      rawTempMaeC: activeArtifact.accuracy.rawTempMaeC,
      correctedRainHitRatePct: activeArtifact.accuracy.correctedRainHitRatePct,
      rawRainHitRatePct: activeArtifact.accuracy.rawRainHitRatePct,
    };

    await appendLearningJournalEntry(modelGridKey, logEntry);

    const completedState = await buildLearningStateSnapshot(modelGridKey, false);
    notifyModelGridLearningUpdate(modelGridKey, activeArtifact, completedState);
  } catch {
    // Offline / fetch failure: clear/restore lastLearningDay so next trigger retries quietly;
    // keep yesterday's champion serving with zero error shown to user!
    await setLastLearningDay(modelGridKey, previousLearningDay);
    const fallbackServing = championArtifact ?? fallbackArtifact ?? null;
    const recoveredState = await buildLearningStateSnapshot(modelGridKey, false);
    notifyModelGridLearningUpdate(modelGridKey, fallbackServing, recoveredState);
  }
}

function championEvalCurrent<T>(val: T): T {
  return val;
}

/**
 * Sweeps ALL known grid cells present in the pairs cache (not only the currently selected roof)
 * and schedules background daily learning cycles for any cell where Colombo today > lastLearningDay.
 */
export async function sweepAllCachedGridCellsForDailyLearning(): Promise<void> {
  try {
    const keys = await listKnownModelGridKeys();
    const todayIso = getColomboTodayIso();

    for (let i = 0; i < keys.length; i++) {
      const modelGridKey = keys[i];
      if (runningCycles.has(modelGridKey)) continue;
      const lastDay = await getLastLearningDay(modelGridKey);
      if (!lastDay || todayIso > lastDay) {
        // Stagger multiple cached cells slightly so background network/worker load stays feather-light
        await triggerSelfLearningForGrid(modelGridKey);
      }
    }
  } catch {
    // Silent offline safety
  }
}

/**
 * Initializes the app-wide Daily Self-Learning Heartbeat Scheduler:
 * 1. On app boot (idle background callback)
 * 2. Every hour via setInterval
 * 3. On document visibilitychange (tab re-focus)
 */
export function initWeatherSelfLearningScheduler(): void {
  if (schedulerInitialized) return;
  schedulerInitialized = true;

  // 1. App boot background sweep
  scheduleBackgroundIdle(() => {
    void sweepAllCachedGridCellsForDailyLearning();
  });

  // 2. Hourly heartbeat interval
  if (typeof window !== 'undefined') {
    heartbeatTimerId = setInterval(() => {
      scheduleBackgroundIdle(() => {
        void sweepAllCachedGridCellsForDailyLearning();
      });
    }, HOURLY_HEARTBEAT_MS);
    void heartbeatTimerId;
  }

  // 3. Tab re-focus (visibilitychange)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        scheduleBackgroundIdle(() => {
          void sweepAllCachedGridCellsForDailyLearning();
        });
      }
    });
  }
}
