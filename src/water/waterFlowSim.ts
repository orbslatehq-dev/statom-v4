// Water flow simulation — hourly day sim (real forecast) + monthly year sim (climate normals).

import { DailyForecastItem, MonthlyClimateNormal } from '../weather/weatherTypes';
import { DrainagePlan } from './drainageEngine';
import { WATER_CONFIG } from './waterConfig';

export interface ReuseSettings {
  garden: boolean;
  toiletPersons: number; // 0 = off
  wash: boolean;
  animalsL: number; // 0 = off
  pump: boolean;
}

export function dailyDemandL(r: ReuseSettings): number {
  return (
    (r.garden ? WATER_CONFIG.defaultDemand.gardenL : 0) +
    r.toiletPersons * WATER_CONFIG.defaultDemand.toiletPerPersonL +
    (r.wash ? WATER_CONFIG.defaultDemand.washL : 0) +
    r.animalsL
  );
}

export interface WaterHourPoint {
  hour: number;
  rainMm: number;
  inflowL: number;
  overflowL: number;
  demandL: number;
  unmetL: number;
  tankL: number;
}

export interface WaterDaySim {
  dateIso: string;
  dayShort: string;
  hours: WaterHourPoint[];
  totalRainMm: number;
  totalInflowL: number;
  totalOverflowL: number;
  totalDemandL: number;
  totalUnmetL: number;
  savedFromMainsL: number;
  tankEndL: number;
  peakL: number;
}

export interface WaterMonthPoint {
  monthShort: string;
  rainfallMm: number;
  inflowL: number;
  demandL: number;
  spilledL: number;
  unmetL: number;
  tankEndL: number;
}

export interface WaterYearSim {
  months: WaterMonthPoint[];
  annualInflowL: number;
  annualDemandL: number;
  annualSpilledL: number;
  annualUnmetL: number;
  annualMainsSavedL: number;
  coveragePct: number;
  moneySavedLkr: number;
}

/** Hour-by-hour tank evolution for one forecast day (24 hourly rain values). */
export function simulateDay(
  day: DailyForecastItem,
  plan: DrainagePlan,
  runoff: number,
  reuse: ReuseSettings,
  startLevelL: number
): WaterDaySim {
  const cap = plan.tank.capacityL;
  const demandPerHour = dailyDemandL(reuse) / 24;
  const totalCatch = plan.gutters.reduce((s, g) => s + g.catchmentM2, 0);
  let level = startLevelL;
  let ffSkipped = 0; // first-flush bucket for the day (per rain event start)

  const hours: WaterHourPoint[] = [];
  let totIn = 0,
    totOver = 0,
    totDemand = 0,
    totUnmet = 0,
    peak = 0;

  for (let h = 0; h < 24; h++) {
    const hp = day.hourly[h];
    const rainMm = hp ? Math.max(0, hp.rainMm) : 0;

    // First-flush: divert the first ~1mm of a rain event
    let effective = rainMm;
    if (rainMm > 0.05 && ffSkipped < WATER_CONFIG.firstFlushSkipMm) {
      const skip = Math.min(rainMm, WATER_CONFIG.firstFlushSkipMm - ffSkipped);
      ffSkipped += skip;
      effective = rainMm - skip;
    }
    if (rainMm < 0.05) {
      // dry hour slowly resets the first-flush bucket (dust settles again)
      ffSkipped = Math.max(0, ffSkipped - 0.1);
    }

    const grossIn = effective * totalCatch * runoff; // 1mm on 1m² = 1L
    const inflowL = Math.round(grossIn);
    level += grossIn;

    let overflowL = 0;
    if (level > cap) {
      overflowL = level - cap;
      level = cap;
    }

    const demandL = rainMm > 0.05 ? demandPerHour * 0.35 : demandPerHour; // less garden use while raining
    let unmetL = 0;
    if (level >= demandL) {
      level -= demandL;
    } else {
      unmetL = demandL - level;
      level = 0;
    }

    totIn += grossIn;
    totOver += overflowL;
    totDemand += demandL;
    totUnmet += unmetL;
    peak = Math.max(peak, level);

    hours.push({
      hour: h,
      rainMm: Math.round(rainMm * 10) / 10,
      inflowL: Math.round(inflowL),
      overflowL: Math.round(overflowL),
      demandL: Math.round(demandL),
      unmetL: Math.round(unmetL),
      tankL: Math.round(level),
    });
  }

  const saved = totDemand - totUnmet;
  return {
    dateIso: day.date,
    dayShort: day.dayShort,
    hours,
    totalRainMm: Math.round(day.rawRainSumMm * 10) / 10,
    totalInflowL: Math.round(totIn),
    totalOverflowL: Math.round(totOver),
    totalDemandL: Math.round(totDemand),
    totalUnmetL: Math.round(totUnmet),
    savedFromMainsL: Math.round(saved),
    tankEndL: Math.round(level),
    peakL: Math.round(peak),
  };
}

/** Month-by-month year simulation from 12-month climate normals. */
export function simulateYear(
  normals: MonthlyClimateNormal[],
  planAreaSqm: number,
  runoff: number,
  plan: DrainagePlan,
  reuse: ReuseSettings
): WaterYearSim {
  const cap = plan.tank.capacityL;
  const demandPerDay = dailyDemandL(reuse);
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  const months: WaterMonthPoint[] = [];
  let level = 0;
  let aIn = 0,
    aDem = 0,
    aSpill = 0,
    aUnmet = 0;

  for (let m = 0; m < 12; m++) {
    const n = normals[m];
    const rainMm = n ? n.totalRainfallMm : 0;
    // First-flush allowance: ≈ 6mm of each month's rain diverted (events × ~1mm, approximated)
    const effective = Math.max(0, rainMm - Math.min(6, rainMm * 0.08));
    const inL = effective * planAreaSqm * runoff;
    const demandL = demandPerDay * daysInMonth[m];

    level += inL;
    let spilled = 0;
    if (level > cap) {
      spilled = level - cap;
      level = cap;
    }
    let unmet = 0;
    if (level >= demandL) {
      level -= demandL;
    } else {
      unmet = demandL - level;
      level = 0;
    }

    aIn += inL;
    aDem += demandL;
    aSpill += spilled;
    aUnmet += unmet;

    months.push({
      monthShort: n ? n.monthShort : ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][m],
      rainfallMm: Math.round(rainMm),
      inflowL: Math.round(inL),
      demandL: Math.round(demandL),
      spilledL: Math.round(spilled),
      unmetL: Math.round(unmet),
      tankEndL: Math.round(level),
    });
  }

  const saved = Math.max(0, aDem - aUnmet);
  return {
    months,
    annualInflowL: Math.round(aIn),
    annualDemandL: Math.round(aDem),
    annualSpilledL: Math.round(aSpill),
    annualUnmetL: Math.round(aUnmet),
    annualMainsSavedL: Math.round(saved),
    coveragePct: aDem > 0 ? Math.round((saved / aDem) * 100) : 0,
    moneySavedLkr: Math.round((saved / 1000) * WATER_CONFIG.mainsWaterLkrPerM3),
  };
}

/** Cost estimate for the designed system. */
export interface WaterCostLine {
  label: string;
  hint: string;
  amountLkr: number;
}

export function estimateCosts(plan: DrainagePlan, pump: boolean): {
  lines: WaterCostLine[];
  totalLkr: number;
} {
  const C = WATER_CONFIG;
  const lines: WaterCostLine[] = [
    {
      label: 'Gutters (all eaves)',
      hint: `${plan.totalGutterMeters.toFixed(1)} m PVC + leaf guard`,
      amountLkr:
        plan.totalGutterMeters * (C.gutterPerMeterLkr + C.leafGuardPerMeterLkr),
    },
    {
      label: 'Downpipes & routing',
      hint: `${plan.downpipes.length} × 75mm pipe to tank`,
      amountLkr: plan.downpipes.length * C.downpipeEachLkr,
    },
    {
      label: 'First-flush + mosquito mesh',
      hint: 'Skips the dusty first rain; keeps dengue out',
      amountLkr: C.firstFlushKitLkr + plan.firstFlushers * 1500,
    },
    {
      label: `Tank ${plan.tank.capacityL.toLocaleString()} L`,
      hint: 'Sealed, UV-stable, with tap & overflow',
      amountLkr:
        C.tankPriceLkr[plan.tank.capacityL] ??
        C.tankPriceLkr[C.tankOptionsL[C.tankOptionsL.length - 1]],
    },
  ];
  if (pump) {
    lines.push({ label: 'Booster pump & hose reel', hint: 'Garden pressure from the tank', amountLkr: C.pumpLkr });
  }
  lines.push({ label: 'Fittings & valves', hint: 'Taps, elbows, seals', amountLkr: C.fittingsLkr });

  const sub = lines.reduce((s, l) => s + l.amountLkr, 0);
  lines.push({
    label: 'Installation labour',
    hint: `~${C.installLabourPct}% of kit`,
    amountLkr: Math.round((sub * C.installLabourPct) / 100),
  });

  return { lines, totalLkr: lines.reduce((s, l) => s + l.amountLkr, 0) };
}
