import {
  GROQ_API_KEY,
  GROQ_CHAT_ENDPOINT,
  GROQ_DEFAULT_MODEL,
  GROQ_FALLBACK_MODEL,
} from './groqConfig';
import { HouseMetrics, HouseSpec } from '../types';
import { ConnectionPhase, SOLAR_CONFIG } from '../solar/solarConfig';
import { SolarSimulationResult } from '../solar/solarSimEngine';
import { SolarFinancialReport } from '../solar/solarFinance';

export type AdvisorLanguage = 'en' | 'si' | 'ta';

export type GroqAdvisorErrorKind =
  | 'TimeoutError'
  | 'RateLimitError'
  | 'HttpError'
  | 'BusyError'
  | 'ParseError';

export class GroqAdvisorError extends Error {
  readonly kind: GroqAdvisorErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: GroqAdvisorErrorKind,
    message: string,
    opts?: { status?: number; retryAfterMs?: number }
  ) {
    super(message);
    this.name = 'GroqAdvisorError';
    this.kind = kind;
    this.status = opts?.status;
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

export interface GroqChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface UserIntakeContextFlags {
  hasAC?: boolean;
  plansEV?: boolean;
  notes?: string;
}

/**
 * Compact flat JSON Fact Sheet (<= ~450 tokens) passed to the LLM advisor.
 * Every numeric value is pre-computed and rounded by the deterministic physics/finance engines.
 */
const FACT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export interface SolarAdvisorFactSheet {
  location: string;
  roofAreaSqm: number;
  roofStylePitch: string;
  monthlyConsumptionKwh: number;
  phase: string;
  selectedSystemKwp: number;
  autoRecommendedKwp: number;
  panelCount: number;
  panelSpec: string;
  topSectionsKwhM2Yr: string[];
  worstSectionKwhM2Yr: string;
  monthlyProdKwh: string[]; // 12 labeled values ("Jan:320" .. "Dec:290", incl. May-Jun & Oct-Nov monsoon dips)
  peakMonthProdKwh: string;
  lowestMonsoonMonthProdKwh: string;
  annualProdKwh: number;
  selfConsumptionPct: number;
  exportKwhYr: number;
  baselineBillLkrMo: number;
  postSolarBillLkrMo: number;
  monthlyBenefitLkr: number;
  totalCapexLkr: number;
  top4CostItemsLkr: string[];
  paybackYears: number | string;
  investmentVerdict: string;
  netProfit25YrLkr: number;
  lcoeLkrKwh: number;
  battery: {
    suggestedKwh: number;
    packCapexLkr: number;
    extraAnnualBenefitLkr: number;
    batteryPaybackYears: number | string;
    backupHrs: number;
    verdict: string;
  };
  tariffsUsed: string;
  assumptions: string;
  householdContext?: string;
}

export interface AdvisorReportData {
  headline: string;
  summary: string;
  strengths: [string, string, string];
  watchOuts: [string, string];
  batteryAdvice: string;
  nextSteps: [string, string, string];
}

export interface ConsumptionIntakeExtraction {
  monthlyUnitsKwh: number;
  hasAC: boolean;
  plansEV: boolean;
  notes: string;
}

/**
 * Exact system prompt (~200 tokens) enforcing zero hallucinated numbers.
 */
export const SYSTEM_PROMPT =
  "You are a friendly solar advisor inside ROOFMASS.LK, a Sri Lankan rooftop solar design app. You are given a FACT SHEET of computed engineering results for this user's specific roof. STRICT RULES: every number you state must come from the fact sheet — never invent or recalculate figures. If asked something the fact sheet can't answer, say it needs an on-site survey or a CEB/installer confirmation. Be concise (≤180 words unless asked for detail). Use simple language; LKR for money. Remind once per answer that figures are estimates. Scheme context you may explain qualitatively: Sri Lanka new installs use Net Plus feed-in tariff (12-yr agreement, smart meter); battery systems earn a higher peak-window tariff — use fact-sheet numbers for any amount.";

// Single in-flight request lock & active AbortController registry for clean disposal
let inFlightLock = false;
const activeControllers = new Set<AbortController>();

export function abortAllAdvisorRequests(): void {
  for (const ctrl of activeControllers) {
    try {
      ctrl.abort();
    } catch {
      // ignore
    }
  }
  activeControllers.clear();
  inFlightLock = false;
}

export function isAdvisorBusy(): boolean {
  return inFlightLock;
}

/**
 * Parses Groq `x-ratelimit-reset-tokens` header values such as "3.074s", "450ms", "1m2.5s", or numeric seconds.
 */
export function parseGroqResetHeaderMs(headerVal: string | null): number | null {
  if (!headerVal) return null;
  const trimmed = headerVal.trim();
  if (!trimmed) return null;

  let totalMs = 0;
  let matched = false;

  const minMatch = trimmed.match(/(\d+(?:\.\d+)?)m(?!s)/i);
  if (minMatch) {
    totalMs += parseFloat(minMatch[1]) * 60_000;
    matched = true;
  }

  const msMatch = trimmed.match(/(\d+(?:\.\d+)?)ms/i);
  if (msMatch) {
    totalMs += parseFloat(msMatch[1]);
    matched = true;
  }

  const secMatch = trimmed.match(/(\d+(?:\.\d+)?)s/i);
  if (secMatch && !trimmed.toLowerCase().endsWith('ms')) {
    totalMs += parseFloat(secMatch[1]) * 1_000;
    matched = true;
  }

  if (!matched) {
    const plain = Number(trimmed);
    if (Number.isFinite(plain) && plain > 0) {
      totalMs = plain * 1_000;
      matched = true;
    }
  }

  return matched && totalMs > 0 ? Math.round(totalMs) : null;
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new GroqAdvisorError('TimeoutError', 'REQUEST CANCELLED'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GroqAdvisorError('TimeoutError', 'REQUEST CANCELLED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Pure function building the compact flat JSON Fact Sheet (<= ~450 tokens) from engine results.
 */
export function buildFactSheet(params: {
  locationLabel?: string;
  spec: HouseSpec;
  metrics: HouseMetrics;
  monthlyConsumptionKwh: number;
  phase: ConnectionPhase;
  sim: SolarSimulationResult;
  finance: SolarFinancialReport;
  intakeFlags?: UserIntakeContextFlags;
}): SolarAdvisorFactSheet {
  const {
    locationLabel,
    spec,
    metrics,
    monthlyConsumptionKwh,
    phase,
    sim,
    finance,
    intakeFlags,
  } = params;

  const loc =
    locationLabel && locationLabel.trim().length > 0
      ? locationLabel.trim()
      : `Sri Lanka (${metrics.centroid[1].toFixed(2)}N, ${metrics.centroid[0].toFixed(2)}E)`;

  const topSections = sim.sections.slice(0, 3).map(
    (s) => `${s.id} ${s.cardinalLabel} ${Math.round(s.pitchDeg)}deg: ${Math.round(s.panelPlaneAnnualKwhM2)}`
  );
  const worstSec = sim.sections[sim.sections.length - 1];
  const worstSectionStr = worstSec
    ? `${worstSec.id} ${worstSec.cardinalLabel}: ${Math.round(worstSec.panelPlaneAnnualKwhM2)}`
    : 'N/A';

  const top4Costs = [...finance.costBreakdown]
    .sort((a, b) => b.amountLkr - a.amountLkr)
    .slice(0, 4)
    .map((c) => `${c.label}: ${Math.round(c.amountLkr)}`);

  const recBat = finance.batteryInsight.recommendedOption;

  const ctxParts: string[] = [];
  if (intakeFlags?.hasAC) ctxParts.push('Has air-conditioning (AC)');
  if (intakeFlags?.plansEV) ctxParts.push('Plans electric vehicle (EV)');
  if (intakeFlags?.notes) ctxParts.push(intakeFlags.notes.slice(0, 80));

  const recommendedKwp = Number(
    ((finance.recommendedPanelCount * SOLAR_CONFIG.panel.watts) / 1000).toFixed(2)
  );

  const roundedMonthly = finance.monthlyGenerationKwh.map((v) => Math.round(v));
  const labeledMonthly = roundedMonthly.map((v, i) => `${FACT_MONTHS[i]}:${v}`);
  let minIdx = 0;
  let maxIdx = 0;
  for (let i = 1; i < roundedMonthly.length; i++) {
    if (roundedMonthly[i] < roundedMonthly[minIdx]) minIdx = i;
    if (roundedMonthly[i] > roundedMonthly[maxIdx]) maxIdx = i;
  }

  return {
    location: loc,
    roofAreaSqm: Math.round(metrics.areaSqm),
    roofStylePitch: `${spec.roofStyle} ${Math.round(spec.roofPitchDeg)}deg (${spec.stories}F)`,
    monthlyConsumptionKwh: Math.round(monthlyConsumptionKwh),
    phase: phase === 'single' ? 'SINGLE 30A' : 'THREE-PHASE',
    selectedSystemKwp: Number(finance.systemKwp.toFixed(2)),
    autoRecommendedKwp: recommendedKwp,
    panelCount: finance.panelCount,
    panelSpec: `${SOLAR_CONFIG.panel.watts}W JA Solar Mono`,
    topSectionsKwhM2Yr: topSections,
    worstSectionKwhM2Yr: worstSectionStr,
    monthlyProdKwh: labeledMonthly,
    peakMonthProdKwh: labeledMonthly[maxIdx] ?? 'Mar:0',
    lowestMonsoonMonthProdKwh: labeledMonthly[minIdx] ?? 'Nov:0',
    annualProdKwh: Math.round(finance.annualGenerationKwh),
    selfConsumptionPct: Math.round(finance.selfConsumptionSharePct),
    exportKwhYr: Math.round(finance.annualExportedKwh),
    baselineBillLkrMo: Math.round(finance.baselineMonthlyBillLkr),
    postSolarBillLkrMo: Math.round(finance.postSolarMonthlyBillLkr),
    monthlyBenefitLkr: Math.round(finance.totalMonthlyBenefitLkr),
    totalCapexLkr: Math.round(finance.totalCapexLkr),
    top4CostItemsLkr: top4Costs,
    paybackYears:
      finance.paybackYears !== null ? Number(finance.paybackYears.toFixed(1)) : '>25',
    investmentVerdict: finance.verdict,
    netProfit25YrLkr: Math.round(finance.netProfit25YrLkr),
    lcoeLkrKwh: Number(finance.lcoeLkrPerKwh.toFixed(1)),
    battery: {
      suggestedKwh: recBat.capacityKwh,
      packCapexLkr: Math.round(recBat.incrementalCapexLkr),
      extraAnnualBenefitLkr: Math.round(recBat.extraAnnualEarningsLkr),
      batteryPaybackYears:
        recBat.simplePaybackYears > 35
          ? '>25'
          : Number(recBat.simplePaybackYears.toFixed(1)),
      backupHrs: Number(recBat.backupHoursEssentialLoad.toFixed(1)),
      verdict: finance.batteryInsight.verdict,
    },
    tariffsUsed: `Net Plus FIT ${finance.netPlusFitRateLkr} LKR/kWh (12yr); Battery peak FIT ${SOLAR_CONFIG.regulatory.batteryPrioritizedPeakFitLkr} LKR/kWh (15yr); tiered CEB retail (~100 LKR/unit >180u)`,
    assumptions: 'PR 80%, deg 0.5%/yr, O&M 1%/yr, Yr-10 inverter replacement, 5%/yr tariff escalation',
    ...(ctxParts.length > 0 ? { householdContext: ctxParts.join('; ') } : {}),
  };
}

/**
 * Computes a deterministic cache key hash for a house's active solar design so cached AI reports
 * persist across visits and automatically invalidate when panel count, usage, or phase changes.
 */
export function computeAdvisorReportCacheKey(params: {
  houseKey: string;
  panelCount: number;
  monthlyConsumptionKwh: number;
  phase: ConnectionPhase;
  intakeFlags?: UserIntakeContextFlags;
}): string {
  const { houseKey, panelCount, monthlyConsumptionKwh, phase, intakeFlags } = params;
  const ac = intakeFlags?.hasAC ? '1' : '0';
  const ev = intakeFlags?.plansEV ? '1' : '0';
  return `rm_ai_rep_v1_${houseKey}_p${panelCount}_u${Math.round(monthlyConsumptionKwh)}_${phase}_${ac}${ev}`;
}

export function loadCachedAdvisorReport(cacheKey: string): AdvisorReportData | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return validateAdvisorReportShape(parsed);
  } catch {
    return null;
  }
}

export function saveCachedAdvisorReport(
  cacheKey: string,
  report: AdvisorReportData
): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(cacheKey, JSON.stringify(report));
  } catch {
    // ignore quota errors
  }
}

/**
 * Low-level Groq OpenAI-compatible chat completions fetch wrapper:
 * - Plain fetch, no SDK, never logs GROQ_API_KEY
 * - Single in-flight request guard
 * - 30s AbortController timeout
 * - max_tokens >= 1024 always + reasoning_format: "hidden"
 * - One automatic HTTP 429 retry honoring `x-ratelimit-reset-tokens` (capped at 15s wait)
 */
export async function callGroq(
  messages: GroqChatMessage[],
  options?: {
    jsonMode?: boolean;
    maxTokens?: number;
    model?: string;
    bypassLock?: boolean;
  }
): Promise<string> {
  const trimmedKey = GROQ_API_KEY.trim();
  if (!trimmedKey) {
    throw new GroqAdvisorError('HttpError', 'GROQ API KEY NOT CONFIGURED');
  }

  if (!options?.bypassLock) {
    if (inFlightLock) {
      throw new GroqAdvisorError('BusyError', 'ADVISOR REQUEST ALREADY IN PROGRESS');
    }
    inFlightLock = true;
  }

  const controller = new AbortController();
  activeControllers.add(controller);
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  const maxTokens = Math.max(1024, options?.maxTokens ?? 1024);
  const model = options?.model ?? GROQ_DEFAULT_MODEL;

  const executeOnce = async (): Promise<Response> => {
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      reasoning_format: 'hidden',
      temperature: 0.25,
      messages,
    };
    if (options?.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    return fetch(GROQ_CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${trimmedKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  };

  try {
    let res = await executeOnce();

    // Handle 429 Rate Limit once using x-ratelimit-reset-tokens (max 15s wait)
    if (res.status === 429) {
      const resetMs =
        parseGroqResetHeaderMs(res.headers.get('x-ratelimit-reset-tokens')) ??
        parseGroqResetHeaderMs(res.headers.get('retry-after')) ??
        3_500;

      if (resetMs <= 15_000) {
        await sleepWithSignal(Math.max(800, resetMs + 250), controller.signal);
        res = await executeOnce();
      }

      if (res.status === 429) {
        throw new GroqAdvisorError(
          'RateLimitError',
          'TRY AGAIN IN A MOMENT',
          { status: 429, retryAfterMs: resetMs }
        );
      }
    }

    if (!res.ok) {
      throw new GroqAdvisorError(
        'HttpError',
        `ADVISOR HTTP ${res.status}`,
        { status: res.status }
      );
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new GroqAdvisorError('ParseError', 'EMPTY ADVISOR RESPONSE');
    }

    return content.trim();
  } catch (err) {
    if (err instanceof GroqAdvisorError) {
      throw err;
    }
    if ((err as Error)?.name === 'AbortError' || controller.signal.aborted) {
      throw new GroqAdvisorError('TimeoutError', 'ADVISOR TIMED OUT (30S)');
    }
    throw new GroqAdvisorError('HttpError', 'NETWORK ERROR REACHING ADVISOR');
  } finally {
    clearTimeout(timeoutId);
    activeControllers.delete(controller);
    if (!options?.bypassLock) {
      inFlightLock = false;
    }
  }
}

/**
 * Validates and normalizes the Task 2 JSON report schema:
 * { headline, summary, strengths: string[3], watchOuts: string[2], batteryAdvice, nextSteps: string[3] }
 */
export function validateAdvisorReportShape(raw: unknown): AdvisorReportData | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const headline = typeof obj.headline === 'string' ? obj.headline.trim() : '';
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  const batteryAdvice =
    typeof obj.batteryAdvice === 'string' ? obj.batteryAdvice.trim() : '';

  const toCleanStringArray = (val: unknown): string[] =>
    Array.isArray(val)
      ? val
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((s) => s.trim())
      : [];

  const strengths = toCleanStringArray(obj.strengths);
  const watchOuts = toCleanStringArray(obj.watchOuts);
  const nextSteps = toCleanStringArray(obj.nextSteps);

  if (
    !headline ||
    !summary ||
    !batteryAdvice ||
    strengths.length < 3 ||
    watchOuts.length < 2 ||
    nextSteps.length < 3
  ) {
    return null;
  }

  return {
    headline,
    summary,
    strengths: [strengths[0], strengths[1], strengths[2]],
    watchOuts: [watchOuts[0], watchOuts[1]],
    batteryAdvice,
    nextSteps: [nextSteps[0], nextSteps[1], nextSteps[2]],
  };
}

/**
 * Task 2: Generates a structured JSON AI Advisor Report for the active solar design.
 * Retries once at max_tokens = 1536 if the first JSON response fails schema validation.
 */
export async function generateSolarAdvisorReport(
  factSheet: SolarAdvisorFactSheet
): Promise<AdvisorReportData> {
  if (inFlightLock) {
    throw new GroqAdvisorError('BusyError', 'ADVISOR REQUEST ALREADY IN PROGRESS');
  }
  inFlightLock = true;

  const schemaPrompt =
    'Return ONLY valid JSON matching exact schema: {"headline":string,"summary":string,"strengths":[string,string,string],"watchOuts":[string,string],"batteryAdvice":string,"nextSteps":[string,string,string]}. Use ONLY numbers present in FACT SHEET. Include one brief reminder in summary that figures are estimates.';

  const messages: GroqChatMessage[] = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n${schemaPrompt}` },
    { role: 'user', content: `FACT SHEET:\n${JSON.stringify(factSheet)}` },
  ];

  try {
    // Attempt 1 at max_tokens = 1024
    try {
      const rawText = await callGroq(messages, {
        jsonMode: true,
        maxTokens: 1024,
        bypassLock: true,
      });
      const parsed = validateAdvisorReportShape(JSON.parse(rawText));
      if (parsed) return parsed;
    } catch (firstErr) {
      if (
        firstErr instanceof GroqAdvisorError &&
        (firstErr.kind === 'RateLimitError' || firstErr.kind === 'TimeoutError')
      ) {
        throw firstErr;
      }
      // Fall through to single retry at max_tokens 1536 on parse/empty failure
    }

    // Retry once at max_tokens = 1536
    const retryText = await callGroq(messages, {
      jsonMode: true,
      maxTokens: 1536,
      bypassLock: true,
    });
    const retryParsed = validateAdvisorReportShape(JSON.parse(retryText));
    if (!retryParsed) {
      throw new GroqAdvisorError('ParseError', 'INVALID ADVISOR REPORT JSON SHAPE');
    }
    return retryParsed;
  } finally {
    inFlightLock = false;
  }
}

/**
 * Task 3: Sends a user question to the AI Solar Advisor with fresh Fact Sheet + last <=6 turns
 * and optional Sinhala / Tamil / English language selection.
 */
export async function askSolarAdvisorChat(params: {
  factSheet: SolarAdvisorFactSheet;
  history: GroqChatMessage[]; // Prior user/assistant turns
  userMessage: string;
  language: AdvisorLanguage;
}): Promise<string> {
  const { factSheet, history, userMessage, language } = params;

  const langDirective =
    language === 'si'
      ? 'Reply fully in Sinhala (සිංහල). Keep technical units (kW, kWh, LKR) clear and use only fact-sheet numbers.'
      : language === 'ta'
      ? 'Reply fully in Tamil (தமிழ்). Keep technical units (kW, kWh, LKR) clear and use only fact-sheet numbers.'
      : 'Reply fully in English.';

  // Trim chat history strictly to last 6 turns to stay well inside 8,000 tokens/min budget
  const recentHistory = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-6);

  const messages: GroqChatMessage[] = [
    {
      role: 'system',
      content: `${SYSTEM_PROMPT}\n${langDirective}\nFACT SHEET: ${JSON.stringify(factSheet)}`,
    },
    ...recentHistory,
    { role: 'user', content: userMessage.trim().slice(0, 500) },
  ];

  try {
    return await callGroq(messages, {
      jsonMode: false,
      maxTokens: 1024,
      model: GROQ_DEFAULT_MODEL,
    });
  } catch (err) {
    // Fallback to gpt-oss-120b only if 20b produced an empty/parse error on a harder multilingual query
    if (err instanceof GroqAdvisorError && err.kind === 'ParseError') {
      return await callGroq(messages, {
        jsonMode: false,
        maxTokens: 1280,
        model: GROQ_FALLBACK_MODEL,
      });
    }
    throw err;
  }
}

/**
 * Task 4: Optional Natural-Language Consumption Intake extractor.
 * Returns null silently on any parse failure, error, or unconfident extraction.
 */
export async function extractConsumptionIntakeFromText(
  freeText: string
): Promise<ConsumptionIntakeExtraction | null> {
  const clean = freeText.trim();
  if (clean.length < 4) return null;

  const sys =
    'Extract Sri Lankan household electricity details from user text into JSON: {"monthlyUnitsKwh":number,"hasAC":boolean,"plansEV":boolean,"notes":string,"confident":boolean}. If user states a monthly LKR bill instead of units, set monthlyUnitsKwh to 0 and confident to false unless units/kWh are clear. Never guess wild numbers.';

  try {
    const raw = await callGroq(
      [
        { role: 'system', content: sys },
        { role: 'user', content: clean.slice(0, 360) },
      ],
      { jsonMode: true, maxTokens: 1024 }
    );
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const units = Number(obj.monthlyUnitsKwh ?? 0);
    const hasAC = Boolean(obj.hasAC);
    const plansEV = Boolean(obj.plansEV);
    const notes = typeof obj.notes === 'string' ? obj.notes.trim().slice(0, 100) : '';
    const confident = obj.confident !== false;

    if (!confident && units <= 0 && !hasAC && !plansEV) {
      return null;
    }

    return {
      monthlyUnitsKwh:
        Number.isFinite(units) && units >= 15 && units <= 3000 ? Math.round(units) : 0,
      hasAC,
      plansEV,
      notes,
    };
  } catch {
    return null;
  }
}
