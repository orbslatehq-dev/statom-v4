import {
  HistoricalPairSample,
  MonthlyClimateNormal,
  RoofWeatherBundle,
  SerializedWeatherNetWeights,
  WeatherAccuracyMetrics,
  WeatherLearningLogEntry,
} from './weatherTypes';

const DB_NAME = 'roofmass_weather_db_v1';
const DB_VERSION = 1;
const STORE_NAME = 'kv_store';
const JOURNAL_MAX_ENTRIES = 365;

const memoryCache = new Map<string, unknown>();

/** ~110m precision grid key (3 decimal places) for forecast & soil caching */
export function toDataGridKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)}_${lng.toFixed(3)}`;
}

/** ~1.1km neighborhood grid key (2 decimal places) for LankaWeatherNet model & archive */
export function toModelGridKey(lat: number, lng: number): string {
  return `${lat.toFixed(2)}_${lng.toFixed(2)}`;
}

/** Parses approximate (lat, lng) center from a modelGridKey ("6.85_79.93") */
export function parseCoordsFromModelGridKey(
  modelGridKey: string
): { lat: number; lng: number } | null {
  const parts = modelGridKey.split('_');
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function openIdb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (memoryCache.has(key)) {
    return memoryCache.get(key) as T;
  }

  const db = await openIdb();
  if (db) {
    try {
      const val = await new Promise<T | null>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => resolve((req.result as T) ?? null);
        req.onerror = () => resolve(null);
      });
      if (val !== null && val !== undefined) {
        memoryCache.set(key, val);
        return val;
      }
    } catch {
      // fall through to localStorage
    }
  }

  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(`rm_wx_${key}`);
      if (raw) {
        const parsed = JSON.parse(raw) as T;
        memoryCache.set(key, parsed);
        return parsed;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export async function cacheSet<T>(key: string, value: T): Promise<void> {
  memoryCache.set(key, value);

  const db = await openIdb();
  if (db) {
    try {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
      return;
    } catch {
      // fall through to localStorage
    }
  }

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(`rm_wx_${key}`, JSON.stringify(value));
    } catch {
      // ignore storage quota limits
    }
  }
}

export async function cacheDelete(key: string): Promise<void> {
  memoryCache.delete(key);

  const db = await openIdb();
  if (db) {
    try {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {
      // fall through
    }
  }

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(`rm_wx_${key}`);
    } catch {
      // ignore
    }
  }
}

export interface StoredForecastSnapshot {
  dateKey: string;
  elevationM: number;
  locationLabel: string;
  fetchedAtIso: string;
  current: RoofWeatherBundle['current'];
  daily: RoofWeatherBundle['daily'];
  soil: RoofWeatherBundle['soil'];
}

export interface StoredClimateArchive {
  modelGridKey: string;
  yearsSpan: string;
  normals: MonthlyClimateNormal[];
  updatedMonthKey: string;
}

export interface StoredTrainingPairs {
  modelGridKey: string;
  lat?: number;
  lng?: number;
  lastEndDate: string; // YYYY-MM-DD (latest date in samples, including provisional)
  lastFinalizedDate?: string; // YYYY-MM-DD (latest settled ERA5 date)
  samples: HistoricalPairSample[];
}

export interface StoredModelArtifact {
  modelGridKey: string;
  lastEndDate: string;
  weights: SerializedWeatherNetWeights;
  accuracy: WeatherAccuracyMetrics;
}

export async function getCachedForecastForToday(
  dataGridKey: string,
  todayKey: string
): Promise<StoredForecastSnapshot | null> {
  return cacheGet<StoredForecastSnapshot>(`forecast_v2_${dataGridKey}_${todayKey}`);
}

export async function getLatestFallbackForecast(
  dataGridKey: string
): Promise<StoredForecastSnapshot | null> {
  return cacheGet<StoredForecastSnapshot>(`forecast_v2_latest_${dataGridKey}`);
}

export async function saveCachedForecast(
  dataGridKey: string,
  todayKey: string,
  snapshot: StoredForecastSnapshot
): Promise<void> {
  await Promise.all([
    cacheSet(`forecast_v2_${dataGridKey}_${todayKey}`, snapshot),
    cacheSet(`forecast_v2_latest_${dataGridKey}`, snapshot),
  ]);
}

export async function getCachedClimateNormals(
  modelGridKey: string
): Promise<StoredClimateArchive | null> {
  return cacheGet<StoredClimateArchive>(`climate_v2_${modelGridKey}`);
}

export async function saveCachedClimateNormals(
  modelGridKey: string,
  data: StoredClimateArchive
): Promise<void> {
  await cacheSet(`climate_v2_${modelGridKey}`, data);
}

export async function getCachedTrainingPairs(
  modelGridKey: string
): Promise<StoredTrainingPairs | null> {
  return cacheGet<StoredTrainingPairs>(`pairs_${modelGridKey}`);
}

export async function saveCachedTrainingPairs(
  modelGridKey: string,
  data: StoredTrainingPairs
): Promise<void> {
  await cacheSet(`pairs_${modelGridKey}`, data);
  // Register modelGridKey in known index so background scheduler cycles all cached roofs
  const known = (await cacheGet<string[]>('known_model_grid_keys')) || [];
  if (!known.includes(modelGridKey)) {
    await cacheSet('known_model_grid_keys', [...known, modelGridKey]);
  }
}

/**
 * Lists every modelGridKey present in the pairs cache across IndexedDB, memory, and localStorage.
 */
export async function listKnownModelGridKeys(): Promise<string[]> {
  const found = new Set<string>();

  const indexed = await cacheGet<string[]>('known_model_grid_keys');
  if (Array.isArray(indexed)) {
    for (const k of indexed) {
      if (typeof k === 'string' && k.includes('_')) found.add(k);
    }
  }

  for (const k of memoryCache.keys()) {
    if (k.startsWith('pairs_')) {
      found.add(k.slice('pairs_'.length));
    }
  }

  const db = await openIdb();
  if (db) {
    try {
      const allKeys = await new Promise<IDBValidKey[]>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        if (typeof store.getAllKeys === 'function') {
          const req = store.getAllKeys();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        } else {
          resolve([]);
        }
      });
      for (const rawKey of allKeys) {
        const s = String(rawKey);
        if (s.startsWith('pairs_')) {
          found.add(s.slice('pairs_'.length));
        }
      }
    } catch {
      // ignore
    }
  }

  if (typeof localStorage !== 'undefined') {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('rm_wx_pairs_')) {
          found.add(k.slice('rm_wx_pairs_'.length));
        }
      }
    } catch {
      // ignore
    }
  }

  return Array.from(found);
}

export async function getCachedModelArtifact(
  modelGridKey: string
): Promise<StoredModelArtifact | null> {
  return cacheGet<StoredModelArtifact>(`model_${modelGridKey}`);
}

export async function saveCachedModelArtifact(
  modelGridKey: string,
  artifact: StoredModelArtifact
): Promise<void> {
  await cacheSet(`model_${modelGridKey}`, artifact);
}

export async function getFallbackChampionArtifact(
  modelGridKey: string
): Promise<StoredModelArtifact | null> {
  return cacheGet<StoredModelArtifact>(`model_fallback_${modelGridKey}`);
}

export async function saveFallbackChampionArtifact(
  modelGridKey: string,
  artifact: StoredModelArtifact
): Promise<void> {
  await cacheSet(`model_fallback_${modelGridKey}`, artifact);
}

export async function getLastLearningDay(modelGridKey: string): Promise<string | null> {
  return cacheGet<string>(`learning_day_${modelGridKey}`);
}

export async function setLastLearningDay(
  modelGridKey: string,
  dayIso: string | null
): Promise<void> {
  if (!dayIso) {
    await cacheDelete(`learning_day_${modelGridKey}`);
    return;
  }
  await cacheSet(`learning_day_${modelGridKey}`, dayIso);
}

export async function getLearningJournal(
  modelGridKey: string
): Promise<WeatherLearningLogEntry[]> {
  const list = await cacheGet<WeatherLearningLogEntry[]>(`journal_${modelGridKey}`);
  return Array.isArray(list) ? list : [];
}

export async function appendLearningJournalEntry(
  modelGridKey: string,
  entry: WeatherLearningLogEntry
): Promise<WeatherLearningLogEntry[]> {
  const existing = await getLearningJournal(modelGridKey);
  // Replace same-day entry if re-run after an earlier transient retry, else append chronologically
  const filtered = existing.filter((e) => e.dayIso !== entry.dayIso);
  filtered.push(entry);
  filtered.sort((a, b) => a.dayIso.localeCompare(b.dayIso));
  const capped =
    filtered.length > JOURNAL_MAX_ENTRIES
      ? filtered.slice(filtered.length - JOURNAL_MAX_ENTRIES)
      : filtered;
  await cacheSet(`journal_${modelGridKey}`, capped);
  return capped;
}
