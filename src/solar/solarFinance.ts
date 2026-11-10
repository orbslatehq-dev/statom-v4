import {
  ConnectionPhase,
  SOLAR_CONFIG,
  SolarSystemConfig,
  computeSriLankaDomesticBillLkr,
} from './solarConfig';
import { CandidatePanelSlot, SolarLayoutPlan } from './layoutEngine';

export interface CostLineItem {
  id: string;
  label: string;
  detail: string;
  amountLkr: number;
}

export type InvestmentVerdict = 'STRONG INVESTMENT' | 'MARGINAL' | 'NOT RECOMMENDED';

export type BatteryVerdict =
  | 'BATTERY: WORTH IT'
  | 'BATTERY: SKIP — SELF-CONSUME MORE INSTEAD';

export interface BatteryEvaluationOption {
  capacityKwh: number;
  label: string;
  incrementalCapexLkr: number;
  extraAnnualEarningsLkr: number;
  simplePaybackYears: number;
  eveningOffsetKwhPerDay: number;
  peakExportKwhPerDay: number;
  backupHoursEssentialLoad: number;
}

export interface BatteryInsightSummary {
  verdict: BatteryVerdict;
  reason: string;
  resilienceNote: string;
  recommendedOption: BatteryEvaluationOption;
  allOptions: BatteryEvaluationOption[];
}

export interface CashFlowYearPoint {
  year: number; // 0..25
  annualBillSavingsLkr: number;
  annualExportRevenueLkr: number;
  annualOmAndReplacementLkr: number;
  netAnnualCashFlowLkr: number;
  cumulativeCashFlowLkr: number;
}

export interface SolarFinancialReport {
  panelCount: number;
  recommendedPanelCount: number;
  sizingCapReason: string | null;
  phaseExceedsStandardGuidance: boolean;

  systemKwp: number;
  totalRoofWeightKg: number;
  specificYieldMonthlyKwhPerKwp: number;

  // Generation & Split (Year 1)
  annualGenerationKwh: number;
  meanMonthlyGenerationKwh: number;
  monthlyGenerationKwh: number[]; // 12 values (Jan..Dec)
  annualSelfConsumedKwh: number;
  annualExportedKwh: number;
  selfConsumptionSharePct: number;

  // Bills & Year-1 Revenue
  baselineMonthlyBillLkr: number;
  postSolarMonthlyBillLkr: number;
  monthlyBillSavingsLkr: number;
  monthlyExportRevenueLkr: number;
  totalMonthlyBenefitLkr: number;
  year1GrossBenefitLkr: number;
  netPlusFitRateLkr: number;

  // Cost Breakdown & Lifecycle
  costBreakdown: CostLineItem[];
  totalCapexLkr: number;
  costPerWattLkr: number;
  paybackYears: number | null; // null if never pays back in 25 yrs
  cashFlow25Yr: CashFlowYearPoint[];
  netProfit25YrLkr: number;
  roi25YrPct: number;
  lcoeLkrPerKwh: number;

  // Verdict
  verdict: InvestmentVerdict;
  verdictReason: string;

  // Battery Insight (Task 7)
  batteryInsight: BatteryInsightSummary;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Recommends optimal panel count for a household's monthly consumption, respecting
 * single-phase (<=5 kW guidance) / three-phase (<=20 kW) limits and roof capacity.
 */
export function computeRecommendedSizing(params: {
  monthlyConsumptionKwh: number;
  phase: ConnectionPhase;
  layout: SolarLayoutPlan;
  config?: SolarSystemConfig;
}): {
  recommendedPanels: number;
  rawTargetPanels: number;
  phaseGuidanceMaxPanels: number;
  phaseHardMaxPanels: number;
  sizingCapReason: string | null;
} {
  const { monthlyConsumptionKwh, phase, layout, config = SOLAR_CONFIG } = params;
  const kwPerPanel = config.panel.watts / 1000;

  const phaseGuidanceMaxKw =
    phase === 'single'
      ? config.regulatory.singlePhaseGuidanceMaxKw
      : config.regulatory.threePhaseMaxKw;
  const phaseHardMaxKw =
    phase === 'single'
      ? config.regulatory.singlePhaseHardMaxKw
      : config.regulatory.threePhaseMaxKw;

  const phaseGuidanceMaxPanels = Math.max(1, Math.floor(phaseGuidanceMaxKw / kwPerPanel));
  const phaseHardMaxPanels = Math.max(1, Math.floor(phaseHardMaxKw / kwPerPanel));

  if (layout.maxRoofPanels === 0) {
    return {
      recommendedPanels: 0,
      rawTargetPanels: 0,
      phaseGuidanceMaxPanels,
      phaseHardMaxPanels,
      sizingCapReason: 'NO UNSHADED ROOF AREA MEETS 0.30M SETBACK CLEARANCE',
    };
  }

  // Estimate mean monthly yield per panel from top candidate slots
  const sampleCount = Math.min(layout.maxRoofPanels, 8);
  const meanAnnualPerPanel =
    layout.allCandidateSlots
      .slice(0, sampleCount)
      .reduce((acc, s) => acc + s.annualAcKwh, 0) / Math.max(1, sampleCount);
  const meanMonthlyPerPanel = Math.max(35, meanAnnualPerPanel / 12);

  const rawTargetPanels = Math.max(
    2,
    Math.ceil(Math.max(30, monthlyConsumptionKwh) / meanMonthlyPerPanel)
  );

  let recommendedPanels = rawTargetPanels;
  let sizingCapReason: string | null = null;

  if (recommendedPanels > phaseGuidanceMaxPanels) {
    recommendedPanels = phaseGuidanceMaxPanels;
    sizingCapReason =
      phase === 'single'
        ? `CAPPED AT ${ (phaseGuidanceMaxPanels * kwPerPanel).toFixed(2) } KW (SINGLE-PHASE 30A STANDARD GUIDANCE ≤5 KW)`
        : `CAPPED AT ${ (phaseGuidanceMaxPanels * kwPerPanel).toFixed(2) } KW (THREE-PHASE DOMESTIC LIMIT ≤20 KW)`;
  }

  if (recommendedPanels > layout.maxRoofPanels) {
    recommendedPanels = layout.maxRoofPanels;
    sizingCapReason = `CAPPED AT ${layout.maxRoofPanels} PANELS BY USABLE ROOF GEOMETRY (0.30M SETBACK)`;
  }

  return {
    recommendedPanels,
    rawTargetPanels,
    phaseGuidanceMaxPanels,
    phaseHardMaxPanels,
    sizingCapReason,
  };
}

/**
 * Builds the 8-line Sri Lankan solar quotation cost breakdown calibrated to market curves.
 */
function computeSriLankaCostBreakdown(
  activeSlots: CandidatePanelSlot[],
  phase: ConnectionPhase,
  config: SolarSystemConfig
): CostLineItem[] {
  const count = activeSlots.length;
  if (count === 0) return [];

  const kwp = (count * config.panel.watts) / 1000;
  const flatRackCount = activeSlots.filter((s) => s.isFlatRack).length;
  const pitchedCount = count - flatRackCount;

  // Compact micro/small-system taper (<2.5 kW uses smaller single-MPPT inverter & compact combiner)
  const smallScaleFactor = kwp < 2.5 ? 0.68 + 0.128 * kwp : 1.0;

  const panelsCost = Math.round(count * config.panel.unitPriceLkr);
  const ratedInvKw = Number((Math.ceil(kwp * 2) / 2).toFixed(1));
  const inverterCost = Math.round(
    config.costsLkr.inverterBaseLkr * smallScaleFactor +
      kwp * config.costsLkr.inverterPerKwLkr
  );
  const mountingCost = Math.round(
    pitchedCount * config.costsLkr.mountingPerPanelPitchedLkr +
      flatRackCount * config.costsLkr.mountingPerPanelFlatTiltLkr
  );
  const protectionCost = Math.round(
    config.costsLkr.combinerSpdProtectionBaseLkr * smallScaleFactor +
      kwp * config.costsLkr.combinerSpdPerKwLkr
  );
  const cablingCost = Math.round(
    config.costsLkr.cablingConduitBaseLkr * smallScaleFactor +
      kwp * config.costsLkr.cablingConduitPerKwLkr
  );
  const earthingCost = Math.round(
    config.costsLkr.earthingLightningProtectionLkr * (kwp < 2.0 ? 0.85 : 1.0)
  );
  const meterFeesCost = Math.round(
    phase === 'single'
      ? config.costsLkr.smartMeterAndCebFeesSinglePhaseLkr
      : config.costsLkr.smartMeterAndCebFeesThreePhaseLkr
  );
  const laborCost = Math.round(
    config.costsLkr.laborCommissioningBaseLkr * smallScaleFactor +
      kwp * config.costsLkr.laborCommissioningPerKwLkr
  );

  return [
    {
      id: 'panels',
      label: 'SOLAR PV MODULES',
      detail: `${count} × ${config.panel.brandModel}`,
      amountLkr: panelsCost,
    },
    {
      id: 'inverter',
      label: 'STRING INVERTER',
      detail: `${ratedInvKw} kW Grid-Tie WiFi String Inverter (${phase === 'single' ? '1-Phase' : '3-Phase'})`,
      amountLkr: inverterCost,
    },
    {
      id: 'mounting',
      label: 'MOUNTING RAILS & BRACKETS',
      detail:
        flatRackCount > 0
          ? `Anodized Al Rails + ${flatRackCount} Tilted Flat-Roof Triangle Racks`
          : `Anodized Al Rails, SS304 Roof L-Brackets & Mid/End Clamps`,
      amountLkr: mountingCost,
    },
    {
      id: 'protection',
      label: 'DC & AC COMBINER + SPD',
      detail: 'IP65 Enclosures, Type-2 DC/AC Surge Protection, Isolator, MCB & RCD',
      amountLkr: protectionCost,
    },
    {
      id: 'cabling',
      label: 'DC / AC CABLING & CONDUIT',
      detail: '4mm² TUV UV Solar DC Cable, AC Drop Cable & UV Conduit',
      amountLkr: cablingCost,
    },
    {
      id: 'earthing',
      label: 'EARTHING & LIGHTNING ARRESTER',
      detail: 'Dedicated Copper Earth Rods, Earth Pit & Lightning Protection (Mandatory SL)',
      amountLkr: earthingCost,
    },
    {
      id: 'meter',
      label: 'SMART METER + CEB NET PLUS FEES',
      detail: `Mandatory Bi-Directional Smart Meter & ${phase === 'single' ? '30A 1P' : '3P'} Clearance`,
      amountLkr: meterFeesCost,
    },
    {
      id: 'labor',
      label: 'INSTALLATION & COMMISSIONING',
      detail: 'Roof Rigging, Wiring, Testing & SLSEA/CEB Documentation',
      amountLkr: laborCost,
    },
  ];
}

/**
 * Simulates Task 7 LiFePO4 battery options (5 / 10 / 15 kWh) storing midday solar surplus
 * for evening self-consumption + prioritized peak feed-in (LKR 45.53/kWh, first 15 yrs).
 */
function evaluateBatteryInsight(params: {
  monthlyConsumptionKwh: number;
  hourlyPvKwByMonth: number[][]; // 12 x 24 aggregate PV kW
  solarOnlyAnnualBenefitLkr: number;
  netPlusFitRateLkr: number;
  baselineMonthlyBillLkr: number;
  config: SolarSystemConfig;
}): BatteryInsightSummary {
  const {
    monthlyConsumptionKwh,
    hourlyPvKwByMonth,
    solarOnlyAnnualBenefitLkr,
    netPlusFitRateLkr,
    baselineMonthlyBillLkr,
    config,
  } = params;

  const dailyLoadKwh = Math.max(0, monthlyConsumptionKwh) / 30.4375;
  const loadWeights = config.hourlyDomesticLoadWeights;
  const peakFitLkr = config.regulatory.batteryPrioritizedPeakFitLkr; // 45.53 LKR/kWh

  // Check household's marginal evening electricity value vs 45.53 peak export rate
  const billMinus30 = computeSriLankaDomesticBillLkr(
    Math.max(0, monthlyConsumptionKwh - 30),
    config
  );
  const marginalRetailValueLkr = (baselineMonthlyBillLkr - billMinus30) / 30;
  const prioritizeHomeLoadFirst = marginalRetailValueLkr >= peakFitLkr;

  const evaluations: BatteryEvaluationOption[] = config.battery.options.map((opt) => {
    const usableCap = opt.capacityKwh * opt.usableDod;
    const etaChg = Math.sqrt(opt.roundTripEfficiency);
    const etaDis = Math.sqrt(opt.roundTripEfficiency);

    let annualBillSavingsWithBat = 0;
    let annualDayExportKwh = 0;
    let annualPeakExportKwh = 0;
    let totalEveningOffsetKwh = 0;

    for (let m = 0; m < 12; m++) {
      const days = DAYS_IN_MONTH[m];
      const pvRow = hourlyPvKwByMonth[m];

      // Run 2 consecutive typical days so overnight state-of-charge settles to periodic equilibrium
      let soc = 0;
      let dayDirectAndBatSelfKwh = 0;
      let dayNormalExportKwh = 0;
      let dayPeakExportKwh = 0;
      let dayEveningOffsetKwh = 0;

      for (let pass = 0; pass < 2; pass++) {
        dayDirectAndBatSelfKwh = 0;
        dayNormalExportKwh = 0;
        dayPeakExportKwh = 0;
        dayEveningOffsetKwh = 0;

        for (let h = 0; h < 24; h++) {
          const loadKw = dailyLoadKwh * loadWeights[h];
          const pvKw = pvRow[h] ?? 0;

          if (pvKw >= loadKw) {
            // Direct solar covers load; charge battery from midday surplus first
            dayDirectAndBatSelfKwh += loadKw;
            const surplus = pvKw - loadKw;
            const roomInSoc = Math.max(0, usableCap - soc);
            const chgFromPv = Math.min(surplus, opt.maxChargeKw, roomInSoc / etaChg);
            soc += chgFromPv * etaChg;
            dayNormalExportKwh += Math.max(0, surplus - chgFromPv);
          } else {
            // Solar deficit
            dayDirectAndBatSelfKwh += pvKw;
            const deficit = loadKw - pvKw;
            const isEveningPeak = h >= 18 && h <= 21;
            const isNight = h >= 22 || h <= 5;

            if (isEveningPeak) {
              const availAc = Math.min(opt.maxDischargeKw, soc * etaDis);
              if (prioritizeHomeLoadFirst) {
                const toHome = Math.min(deficit, availAc);
                soc -= toHome / etaDis;
                dayDirectAndBatSelfKwh += toHome;
                dayEveningOffsetKwh += toHome;

                // Export excess stored energy in 18:00-22:00 prioritized peak window (spread across 4 peak hrs)
                const hrsLeftInPeak = Math.max(1, 22 - h);
                const reserveForNightHome = Math.min(soc * etaDis, dailyLoadKwh * 0.14);
                const exportableAc = Math.max(
                  0,
                  Math.min(availAc - toHome, (soc * etaDis - reserveForNightHome) / hrsLeftInPeak)
                );
                soc -= exportableAc / etaDis;
                dayPeakExportKwh += exportableAc;
              } else {
                // Low retail tier (<45.53 LKR): prioritized peak export earns more than home offset!
                const hrsLeftInPeak = Math.max(1, 22 - h);
                const targetPeakDis = Math.min(availAc, (soc * etaDis) / hrsLeftInPeak);
                soc -= targetPeakDis / etaDis;
                dayPeakExportKwh += targetPeakDis;
              }
            } else if (isNight && prioritizeHomeLoadFirst && soc > 0.01) {
              const availAc = Math.min(opt.maxDischargeKw, soc * etaDis);
              const toHome = Math.min(deficit, availAc);
              soc -= toHome / etaDis;
              dayDirectAndBatSelfKwh += toHome;
              dayEveningOffsetKwh += toHome;
            }
          }
        }
      }

      const monthlySelfKwh = Math.min(monthlyConsumptionKwh, dayDirectAndBatSelfKwh * days);
      const remGridKwh = Math.max(0, monthlyConsumptionKwh - monthlySelfKwh);
      const postBill = computeSriLankaDomesticBillLkr(remGridKwh, config);
      annualBillSavingsWithBat += Math.max(0, baselineMonthlyBillLkr - postBill);

      annualDayExportKwh += dayNormalExportKwh * days;
      annualPeakExportKwh += dayPeakExportKwh * days;
      totalEveningOffsetKwh += dayEveningOffsetKwh * days;
    }

    const totalWithBatteryAnnualLkr =
      annualBillSavingsWithBat +
      annualDayExportKwh * netPlusFitRateLkr +
      annualPeakExportKwh * peakFitLkr;

    const extraAnnualEarningsLkr = Math.max(
      0,
      Math.round(totalWithBatteryAnnualLkr - solarOnlyAnnualBenefitLkr)
    );

    const incrementalCapexLkr = Math.round(
      opt.capacityKwh * config.battery.installedCostPerKwhLkr +
        config.battery.hybridInverterUpgradeDeltaLkr
    );

    const simplePaybackYears =
      extraAnnualEarningsLkr > 500
        ? Number((incrementalCapexLkr / extraAnnualEarningsLkr).toFixed(1))
        : 99.9;

    const backupHoursEssentialLoad = Number(
      (usableCap / Math.max(0.2, config.battery.essentialBackupLoadKw)).toFixed(1)
    );

    return {
      capacityKwh: opt.capacityKwh,
      label: opt.label,
      incrementalCapexLkr,
      extraAnnualEarningsLkr,
      simplePaybackYears,
      eveningOffsetKwhPerDay: Number((totalEveningOffsetKwh / 365).toFixed(1)),
      peakExportKwhPerDay: Number((annualPeakExportKwh / 365).toFixed(1)),
      backupHoursEssentialLoad,
    };
  });

  // Choose the option with the shortest payback (preferring 5 or 10 kWh when close)
  let bestOpt = evaluations[0];
  for (const ev of evaluations) {
    if (ev.simplePaybackYears < bestOpt.simplePaybackYears - 0.3) {
      bestOpt = ev;
    }
  }

  const worthIt =
    bestOpt.simplePaybackYears <= 9.5 && bestOpt.extraAnnualEarningsLkr >= 35000;
  const verdict: BatteryVerdict = worthIt
    ? 'BATTERY: WORTH IT'
    : 'BATTERY: SKIP — SELF-CONSUME MORE INSTEAD';

  const reason = worthIt
    ? `${bestOpt.label} ADDS ~LKR ${bestOpt.extraAnnualEarningsLkr.toLocaleString()}/YR VIA EVENING TARIFF OFFSET & LKR ${peakFitLkr}/KWH PEAK FEED-IN (${bestOpt.simplePaybackYears} YR PACK PAYBACK).`
    : `AT ~LKR ${config.battery.installedCostPerKwhLkr.toLocaleString()}/KWH LIFEPO4 COST, ${bestOpt.label} ADDS ~LKR ${bestOpt.extraAnnualEarningsLkr.toLocaleString()}/YR (${bestOpt.simplePaybackYears > 35 ? '>25' : bestOpt.simplePaybackYears} YR PAYBACK) — SHIFTING AC/WASHING/EV TO 10AM–3PM IS FAR CHEAPER.`;

  const resilienceNote = `OUTAGE RESILIENCE: ${bestOpt.label} POWERS LIGHTS, FANS, ROUTER & FRIDGE (~${Math.round(
    config.battery.essentialBackupLoadKw * 1000
  )}W) FOR ~${bestOpt.backupHoursEssentialLoad} HRS DURING CEB LOAD-SHEDDING OR GRID FAULTS.`;

  return {
    verdict,
    reason,
    resilienceNote,
    recommendedOption: bestOpt,
    allOptions: evaluations,
  };
}

/**
 * Runs complete Sri Lanka Net Plus financial, hourly self-consumption, 25-year cash-flow,
 * investment verdict, and LiFePO4 battery evaluation for the selected solar array.
 */
export function evaluateSolarFinancials(params: {
  panelCount: number;
  monthlyConsumptionKwh: number;
  phase: ConnectionPhase;
  layout: SolarLayoutPlan;
  config?: SolarSystemConfig;
}): SolarFinancialReport {
  const {
    panelCount,
    monthlyConsumptionKwh,
    phase,
    layout,
    config = SOLAR_CONFIG,
  } = params;

  const sizing = computeRecommendedSizing({
    monthlyConsumptionKwh,
    phase,
    layout,
    config,
  });

  const clampedCount = Math.max(0, Math.min(panelCount, layout.maxRoofPanels));
  const activeSlots = layout.allCandidateSlots.slice(0, clampedCount);
  const systemKwp = Number(((clampedCount * config.panel.watts) / 1000).toFixed(2));
  const totalRoofWeightKg = clampedCount * config.panel.weightKg;

  const phaseExceedsStandardGuidance =
    phase === 'single' && systemKwp > config.regulatory.singlePhaseGuidanceMaxKw + 0.01;

  const netPlusFitRateLkr =
    systemKwp <= 10.0
      ? config.regulatory.netPlusFitLe10KwLkr
      : config.regulatory.netPlusFit10To40KwLkr;

  const baselineMonthlyBillLkr = computeSriLankaDomesticBillLkr(
    monthlyConsumptionKwh,
    config
  );

  // Aggregate hourly PV AC output (12 x 24) across all active panels
  const hourlyPvKwByMonth: number[][] = Array.from({ length: 12 }, () =>
    new Array(24).fill(0)
  );
  const monthlyGenerationKwh = new Array(12).fill(0);

  for (const slot of activeSlots) {
    for (let m = 0; m < 12; m++) {
      monthlyGenerationKwh[m] += slot.monthlyAcKwh[m];
      for (let h = 0; h < 24; h++) {
        hourlyPvKwByMonth[m][h] += slot.hourlyAcKwByMonth[m][h];
      }
    }
  }

  const annualGenerationKwh = Math.round(
    monthlyGenerationKwh.reduce((a, b) => a + b, 0)
  );
  const meanMonthlyGenerationKwh = Math.round(annualGenerationKwh / 12);
  const specificYieldMonthlyKwhPerKwp =
    systemKwp > 0 ? Number((meanMonthlyGenerationKwh / systemKwp).toFixed(1)) : 0;

  // Hourly self-consumption vs Net Plus export split per month
  const dailyLoadKwh = Math.max(0, monthlyConsumptionKwh) / 30.4375;
  const loadWeights = config.hourlyDomesticLoadWeights;

  let annualSelfConsumedKwh = 0;
  let annualExportedKwh = 0;
  let year1BillSavingsLkr = 0;
  let annualPostSolarBillLkr = 0;

  for (let m = 0; m < 12; m++) {
    const days = DAYS_IN_MONTH[m];
    let daySelf = 0;
    let dayExp = 0;

    for (let h = 0; h < 24; h++) {
      const loadKw = dailyLoadKwh * loadWeights[h];
      const pvKw = hourlyPvKwByMonth[m][h];
      const selfKw = Math.min(loadKw, pvKw);
      const expKw = Math.max(0, pvKw - loadKw);
      daySelf += selfKw;
      dayExp += expKw;
    }

    const monthSelf = Math.min(monthlyConsumptionKwh, daySelf * days);
    const monthExp = dayExp * days;
    annualSelfConsumedKwh += monthSelf;
    annualExportedKwh += monthExp;

    const remainingUnits = Math.max(0, monthlyConsumptionKwh - monthSelf);
    const postBill = computeSriLankaDomesticBillLkr(remainingUnits, config);
    annualPostSolarBillLkr += postBill;
    year1BillSavingsLkr += Math.max(0, baselineMonthlyBillLkr - postBill);
  }

  annualSelfConsumedKwh = Math.round(annualSelfConsumedKwh);
  annualExportedKwh = Math.round(annualExportedKwh);
  const selfConsumptionSharePct =
    annualGenerationKwh > 0
      ? Math.round((annualSelfConsumedKwh / annualGenerationKwh) * 100)
      : 0;

  const postSolarMonthlyBillLkr = Math.round(annualPostSolarBillLkr / 12);
  const monthlyBillSavingsLkr = Math.round(year1BillSavingsLkr / 12);
  const year1ExportRevenueLkr = annualExportedKwh * netPlusFitRateLkr;
  const monthlyExportRevenueLkr = Math.round(year1ExportRevenueLkr / 12);
  const totalMonthlyBenefitLkr = monthlyBillSavingsLkr + monthlyExportRevenueLkr;
  const year1GrossBenefitLkr = Math.round(year1BillSavingsLkr + year1ExportRevenueLkr);

  // Cost Breakdown & CAPEX
  const costBreakdown = computeSriLankaCostBreakdown(activeSlots, phase, config);
  const totalCapexLkr = costBreakdown.reduce((acc, item) => acc + item.amountLkr, 0);
  const costPerWattLkr =
    systemKwp > 0 ? Math.round(totalCapexLkr / (systemKwp * 1000)) : 0;

  // 25-Year Lifecycle Cash Flow
  const horizon = config.performance.projectLifeYears;
  const cashFlow25Yr: CashFlowYearPoint[] = [
    {
      year: 0,
      annualBillSavingsLkr: 0,
      annualExportRevenueLkr: 0,
      annualOmAndReplacementLkr: totalCapexLkr,
      netAnnualCashFlowLkr: -totalCapexLkr,
      cumulativeCashFlowLkr: -totalCapexLkr,
    },
  ];

  let cumulative = -totalCapexLkr;
  let paybackYears: number | null = null;
  let discountedCostSum = totalCapexLkr;
  let discountedKwhSum = 0;

  for (let y = 1; y <= horizon; y++) {
    const degFactor = Math.pow(1 - config.performance.degradationPerYear, y - 1);
    const tariffEsc = Math.pow(1 + config.retailTariff.annualTariffEscalation, y - 1);

    const annualBillSavingsLkr = Math.round(year1BillSavingsLkr * degFactor * tariffEsc);

    // Net Plus agreement guarantees FIT for first 12 years; conservative 85% continuation thereafter
    const fitContinuationFactor = y <= config.regulatory.agreementYears ? 1.0 : 0.85;
    const annualExportRevenueLkr = Math.round(
      year1ExportRevenueLkr * degFactor * fitContinuationFactor
    );

    const omLkr = Math.round(
      totalCapexLkr * config.performance.omFractionOfCapexPerYear
    );
    const invReplLkr =
      y === config.performance.inverterReplacementYear && systemKwp > 0
        ? Math.round(systemKwp * config.performance.inverterReplacementPerKwLkr)
        : 0;
    const annualOmAndReplacementLkr = omLkr + invReplLkr;

    const netAnnual =
      annualBillSavingsLkr + annualExportRevenueLkr - annualOmAndReplacementLkr;
    const prevCum = cumulative;
    cumulative += netAnnual;

    if (paybackYears === null && prevCum < 0 && cumulative >= 0 && netAnnual > 0) {
      const frac = -prevCum / netAnnual;
      paybackYears = Number((y - 1 + frac).toFixed(1));
    }

    const disc = Math.pow(1 + config.performance.discountRate, y);
    discountedCostSum += annualOmAndReplacementLkr / disc;
    discountedKwhSum += (annualGenerationKwh * degFactor) / disc;

    cashFlow25Yr.push({
      year: y,
      annualBillSavingsLkr,
      annualExportRevenueLkr,
      annualOmAndReplacementLkr,
      netAnnualCashFlowLkr: netAnnual,
      cumulativeCashFlowLkr: cumulative,
    });
  }

  const netProfit25YrLkr = clampedCount > 0 ? cumulative : 0;
  const roi25YrPct =
    totalCapexLkr > 0 ? Math.round((netProfit25YrLkr / totalCapexLkr) * 100) : 0;
  const lcoeLkrPerKwh =
    discountedKwhSum > 0 ? Number((discountedCostSum / discountedKwhSum).toFixed(2)) : 0;

  // Mean shade factor across placed slots
  const meanShadeFactor =
    activeSlots.length > 0
      ? activeSlots.reduce((acc, s) => acc + s.shadeFactor, 0) / activeSlots.length
      : 0;

  // Verdict Badge & Clear Reason
  let verdict: InvestmentVerdict = 'NOT RECOMMENDED';
  let verdictReason = 'SELECT AT LEAST 1 PANEL TO EVALUATE SYSTEM ECONOMICS.';

  if (clampedCount === 0) {
    verdict = 'NOT RECOMMENDED';
    verdictReason =
      layout.maxRoofPanels === 0
        ? 'ROOF FACETS ARE TOO SMALL OR HEAVILY SHADED TO FIT 550W PANELS WITH 0.30M SETBACK.'
        : 'ARRAY SLIDER IS SET TO 0 PANELS — SLIDE UP OR USE RECOMMENDED SIZE.';
  } else if (
    paybackYears !== null &&
    paybackYears <= 7.5 &&
    roi25YrPct >= 140 &&
    meanShadeFactor >= 0.7
  ) {
    verdict = 'STRONG INVESTMENT';
    verdictReason =
      monthlyConsumptionKwh > 180
        ? `HIGH RETAIL TARIFF TIER (>180 UNITS @ ~LKR 100/UNIT) + STRONG ROOF SUN (${specificYieldMonthlyKwhPerKwp} UNITS/KW/MO) DELIVERS A FAST ${paybackYears}-YEAR PAYBACK.`
        : `UNSHADED ROOF YIELD (${specificYieldMonthlyKwhPerKwp} UNITS/KW/MO) + DAYTIME SELF-CONSUMPTION & LKR ${netPlusFitRateLkr}/KWH NET PLUS EXPORT RECOVERS COST IN ${paybackYears} YEARS.`;
  } else if (paybackYears !== null && paybackYears <= 11.5 && netProfit25YrLkr > 0) {
    verdict = 'MARGINAL';
    if (monthlyConsumptionKwh < 110) {
      verdictReason = `LOW MONTHLY USAGE (${monthlyConsumptionKwh} UNITS IN LOWER CEB BILL BLOCKS) MEANS MOST SOLAR EXPORTS AT LKR ${netPlusFitRateLkr}/KWH — ${paybackYears}-YR PAYBACK.`;
    } else if (meanShadeFactor < 0.78) {
      verdictReason = `PARTIAL ROOF SELF-SHADING (${Math.round(
        (1 - meanShadeFactor) * 100
      )}% BEAM LOSS) MODERATES OUTPUT TO A ${paybackYears}-YR PAYBACK.`;
    } else if (clampedCount > sizing.recommendedPanels + 3) {
      verdictReason = `OVERSIZED VS ${monthlyConsumptionKwh}-UNIT BILL: SURPLUS EXPORTS AT LKR ${netPlusFitRateLkr}/KWH RATHER THAN OFFSETTING HIGH RETAIL TIERS (${paybackYears}-YR PAYBACK).`;
    } else {
      verdictReason = `STEADY ${paybackYears}-YEAR PAYBACK UNDER SEP 2026 NET PLUS (LKR ${netPlusFitRateLkr}/KWH FIT + DAYTIME BILL SAVINGS).`;
    }
  } else {
    verdict = 'NOT RECOMMENDED';
    if (meanShadeFactor < 0.6) {
      verdictReason = `HEAVY ROOF SHADING (${Math.round(
        (1 - meanShadeFactor) * 100
      )}% DIRECT SUN BLOCKED) REDUCES SPECIFIC YIELD BELOW VIABLE PAYBACK.`;
    } else {
      verdictReason = `AT ${monthlyConsumptionKwh} UNITS/MO AND ${systemKwp} KWP CAPEX, LKR ${netPlusFitRateLkr}/KWH EXPORT ALONE TAKES ${
        paybackYears ? `${paybackYears} YRS` : '>12 YRS'
      } — EXCEEDING THE 12-YEAR NET PLUS CONTRACT WINDOW.`;
    }
  }

  const batteryInsight = evaluateBatteryInsight({
    monthlyConsumptionKwh,
    hourlyPvKwByMonth,
    solarOnlyAnnualBenefitLkr: year1GrossBenefitLkr,
    netPlusFitRateLkr,
    baselineMonthlyBillLkr,
    config,
  });

  return {
    panelCount: clampedCount,
    recommendedPanelCount: sizing.recommendedPanels,
    sizingCapReason: sizing.sizingCapReason,
    phaseExceedsStandardGuidance,
    systemKwp,
    totalRoofWeightKg,
    specificYieldMonthlyKwhPerKwp,
    annualGenerationKwh,
    meanMonthlyGenerationKwh,
    monthlyGenerationKwh: monthlyGenerationKwh.map((v) => Math.round(v)),
    annualSelfConsumedKwh,
    annualExportedKwh,
    selfConsumptionSharePct,
    baselineMonthlyBillLkr,
    postSolarMonthlyBillLkr,
    monthlyBillSavingsLkr,
    monthlyExportRevenueLkr,
    totalMonthlyBenefitLkr,
    year1GrossBenefitLkr,
    netPlusFitRateLkr,
    costBreakdown,
    totalCapexLkr,
    costPerWattLkr,
    paybackYears,
    cashFlow25Yr,
    netProfit25YrLkr,
    roi25YrPct,
    lcoeLkrPerKwh,
    verdict,
    verdictReason,
    batteryInsight,
  };
}
