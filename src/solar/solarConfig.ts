/**
 * Sri Lanka Rooftop Solar & Net Plus Tariff Configuration
 * lastVerified: 2026-09-15 (Sri Lanka Sep 2026 Net Plus Framework & Market Survey)
 *
 * NOTE: All figures are engineering & financial estimates for feasibility planning only.
 * Verify final connection capacity, smart-meter fees, and tariffs with CEB / LECO and a
 * SLSEA-registered solar installer.
 */

export type ConnectionPhase = 'single' | 'three';

export interface TariffBlock {
  upToKwh: number; // Infinity for top block
  energyRateLkr: number;
  fixedChargeLkr: number;
}

export interface BatteryOptionSpec {
  id: string;
  capacityKwh: number;
  label: string;
  usableDod: number;
  roundTripEfficiency: number;
  maxChargeKw: number;
  maxDischargeKw: number;
}

export interface SolarSystemConfig {
  lastVerified: string;

  // 1. Regulatory — Sri Lanka Net Plus (Effective Sep 2026; Net Metering/Accounting discontinued for new installs)
  regulatory: {
    schemeName: string;
    netPlusFitLe10KwLkr: number; // LKR 23.11/kWh for <= 10 kW
    netPlusFit10To40KwLkr: number; // LKR 19.15/kWh for 10 - 40 kW
    agreementYears: number; // 12 years max contract
    mandatorySmartMeter: boolean;
    batteryPrioritizedPeakFitLkr: number; // LKR 45.53/kWh during prioritized evening peak window
    batteryPeakFitYears: number; // First 15 years
    singlePhaseGuidanceMaxKw: number; // 5 kW standard 30A single-phase guidance
    singlePhaseHardMaxKw: number; // Up to ~10 kW subject to transformer/feeder check
    threePhaseMaxKw: number; // Up to 20 kW domestic three-phase
  };

  // 2. Domestic Retail Electricity Tariff (Tiered CEB/LECO domestic schedule, editable)
  retailTariff: {
    lowUsageBlocks: TariffBlock[]; // Applied when total monthly consumption <= 60 kWh
    highUsageBlocks: TariffBlock[]; // Applied when total monthly consumption > 60 kWh (marginal ~LKR 100/unit >180)
    annualTariffEscalation: number; // 5%/yr retail tariff escalation
  };

  // 3. Real Sri Lankan Market Solar Panel Spec — JA Solar 550W Mono PERC Half-Cell
  panel: {
    brandModel: string;
    watts: number; // 550 Wp
    lengthM: number; // 2.278 m
    widthM: number; // 1.134 m
    thicknessM: number; // 0.030 m (30 mm)
    weightKg: number; // ~30 kg
    unitPriceLkr: number; // ~LKR 23,500 (market range 22,000 - 25,000)
    pitchedStandoffM: number; // 0.10 m (10 cm flush rail standoff)
    perimeterSetbackM: number; // 0.30 m roof edge/ridge/hip setback
    interPanelGapM: number; // 0.020 m (20 mm clamp gap)
    minSectionIrradianceKwhM2Yr: number; // Minimum annual POA to consider placing panels
  };

  // 4. Installed System Line-Item Cost Model (LKR) — calibrated to SL market curves:
  // 1kW: ~310k | 2kW: ~545k | 3kW: ~775k | 5kW: ~1.19M | 10kW: ~2.24M
  costsLkr: {
    inverterBaseLkr: number;
    inverterPerKwLkr: number;
    mountingPerPanelPitchedLkr: number;
    mountingPerPanelFlatTiltLkr: number;
    combinerSpdProtectionBaseLkr: number;
    combinerSpdPerKwLkr: number;
    cablingConduitBaseLkr: number;
    cablingConduitPerKwLkr: number;
    earthingLightningProtectionLkr: number; // Copper earth rods + pit + lightning arrester (mandatory in SL)
    smartMeterAndCebFeesSinglePhaseLkr: number; // Bi-directional smart meter + CEB application/inspection
    smartMeterAndCebFeesThreePhaseLkr: number;
    laborCommissioningBaseLkr: number;
    laborCommissioningPerKwLkr: number;
  };

  // 5. Simulation & Lifecycle Economics
  performance: {
    performanceRatio: number; // 0.80 realistic tropical PR (temp + wiring + inverter + soiling)
    groundAlbedo: number; // 0.20 tropical ground reflectance
    degradationPerYear: number; // 0.005 (0.5%/yr)
    omFractionOfCapexPerYear: number; // 0.01 (1.0%/yr)
    inverterReplacementYear: number; // Year 10
    inverterReplacementPerKwLkr: number; // ~LKR 50,000/kW (~250k at 5 kW scale)
    projectLifeYears: number; // 25 years
    discountRate: number; // 8% real/nominal discount for LCOE reference
  };

  // 6. LiFePO4 Battery Storage Options (Sri Lanka hybrid market)
  battery: {
    installedCostPerKwhLkr: number; // LKR 57,500/kWh (range 50,000 - 65,000/kWh)
    hybridInverterUpgradeDeltaLkr: number; // Incremental hybrid vs string inverter delta
    replacementYear: number; // Year 12 cell pack refresh reserve
    replacementCostFactor: number; // 0.55 of initial pack cost
    essentialBackupLoadKw: number; // ~0.45 kW lights, fans, router, fridge during outage
    options: BatteryOptionSpec[];
  };

  // 7. Normalized 24-Hour Sri Lankan Domestic Load Shape (sums to 1.0 across 00:00..23:00)
  // Captures 06:00-08:00 morning routine, modest daytime base, and 18:00-22:00 evening peak.
  hourlyDomesticLoadWeights: number[];
}

const RAW_SL_HOURLY_LOAD = [
  0.022, // 00:00
  0.020, // 01:00
  0.019, // 02:00
  0.019, // 03:00
  0.022, // 04:00
  0.038, // 05:00
  0.062, // 06:00 morning bump
  0.066, // 07:00 morning bump
  0.048, // 08:00
  0.034, // 09:00
  0.032, // 10:00
  0.034, // 11:00
  0.038, // 12:00 lunch/fans
  0.036, // 13:00
  0.034, // 14:00
  0.035, // 15:00
  0.040, // 16:00
  0.048, // 17:00
  0.072, // 18:00 evening peak start
  0.084, // 19:00 evening peak
  0.082, // 20:00 evening peak
  0.062, // 21:00 evening peak
  0.033, // 22:00
  0.020, // 23:00
];

const LOAD_SUM = RAW_SL_HOURLY_LOAD.reduce((a, b) => a + b, 0);

export const SOLAR_CONFIG: SolarSystemConfig = {
  // lastVerified: 2026-09-15
  lastVerified: '2026-09-15',

  regulatory: {
    schemeName: 'CEB / LECO NET PLUS (SEP 2026)',
    netPlusFitLe10KwLkr: 23.11,
    netPlusFit10To40KwLkr: 19.15,
    agreementYears: 12,
    mandatorySmartMeter: true,
    batteryPrioritizedPeakFitLkr: 45.53,
    batteryPeakFitYears: 15,
    singlePhaseGuidanceMaxKw: 5.0,
    singlePhaseHardMaxKw: 10.0,
    threePhaseMaxKw: 20.0,
  },

  retailTariff: {
    lowUsageBlocks: [
      { upToKwh: 30, energyRateLkr: 8.0, fixedChargeLkr: 150 },
      { upToKwh: 60, energyRateLkr: 20.0, fixedChargeLkr: 300 },
    ],
    highUsageBlocks: [
      { upToKwh: 60, energyRateLkr: 25.0, fixedChargeLkr: 0 },
      { upToKwh: 90, energyRateLkr: 30.0, fixedChargeLkr: 400 },
      { upToKwh: 120, energyRateLkr: 50.0, fixedChargeLkr: 1000 },
      { upToKwh: 180, energyRateLkr: 75.0, fixedChargeLkr: 1500 },
      { upToKwh: Infinity, energyRateLkr: 100.0, fixedChargeLkr: 2000 },
    ],
    annualTariffEscalation: 0.05,
  },

  panel: {
    brandModel: 'JA Solar 550W Mono (JAM72S30-550/MR)',
    watts: 550,
    lengthM: 2.278,
    widthM: 1.134,
    thicknessM: 0.03,
    weightKg: 30,
    unitPriceLkr: 23500,
    pitchedStandoffM: 0.1,
    perimeterSetbackM: 0.3,
    interPanelGapM: 0.02,
    minSectionIrradianceKwhM2Yr: 980,
  },

  costsLkr: {
    inverterBaseLkr: 68000,
    inverterPerKwLkr: 42000,
    mountingPerPanelPitchedLkr: 13500,
    mountingPerPanelFlatTiltLkr: 21500,
    combinerSpdProtectionBaseLkr: 32000,
    combinerSpdPerKwLkr: 6500,
    cablingConduitBaseLkr: 24000,
    cablingConduitPerKwLkr: 8500,
    earthingLightningProtectionLkr: 42000,
    smartMeterAndCebFeesSinglePhaseLkr: 48000,
    smartMeterAndCebFeesThreePhaseLkr: 76000,
    laborCommissioningBaseLkr: 35000,
    laborCommissioningPerKwLkr: 19500,
  },

  performance: {
    performanceRatio: 0.8,
    groundAlbedo: 0.2,
    degradationPerYear: 0.005,
    omFractionOfCapexPerYear: 0.01,
    inverterReplacementYear: 10,
    inverterReplacementPerKwLkr: 50000,
    projectLifeYears: 25,
    discountRate: 0.08,
  },

  battery: {
    installedCostPerKwhLkr: 57500,
    hybridInverterUpgradeDeltaLkr: 85000,
    replacementYear: 13,
    replacementCostFactor: 0.55,
    essentialBackupLoadKw: 0.45,
    options: [
      {
        id: 'bat-5',
        capacityKwh: 5,
        label: '5 KWH LIFEPO4',
        usableDod: 0.9,
        roundTripEfficiency: 0.9,
        maxChargeKw: 2.5,
        maxDischargeKw: 3.0,
      },
      {
        id: 'bat-10',
        capacityKwh: 10,
        label: '10 KWH LIFEPO4',
        usableDod: 0.9,
        roundTripEfficiency: 0.9,
        maxChargeKw: 5.0,
        maxDischargeKw: 5.0,
      },
      {
        id: 'bat-15',
        capacityKwh: 15,
        label: '15 KWH LIFEPO4',
        usableDod: 0.9,
        roundTripEfficiency: 0.9,
        maxChargeKw: 6.0,
        maxDischargeKw: 6.0,
      },
    ],
  },

  hourlyDomesticLoadWeights: RAW_SL_HOURLY_LOAD.map((w) => w / LOAD_SUM),
};

/**
 * Computes monthly Sri Lankan domestic electricity bill (LKR) from monthly kWh units.
 */
export function computeSriLankaDomesticBillLkr(
  monthlyUnitsKwh: number,
  config: SolarSystemConfig = SOLAR_CONFIG
): number {
  const u = Math.max(0, monthlyUnitsKwh);
  if (u <= 0.01) return 150;

  const blocks =
    u <= 60 ? config.retailTariff.lowUsageBlocks : config.retailTariff.highUsageBlocks;

  let prevCap = 0;
  let energyCharge = 0;
  let fixedCharge = blocks[0].fixedChargeLkr;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (u > prevCap) {
      const inBlock = Math.min(u, b.upToKwh) - prevCap;
      energyCharge += inBlock * b.energyRateLkr;
      fixedCharge = b.fixedChargeLkr;
    }
    prevCap = b.upToKwh;
    if (u <= b.upToKwh) break;
  }

  return Math.round(energyCharge + fixedCharge);
}

/**
 * Back-estimates monthly consumption (kWh/units) from a monthly LKR electricity bill
 * via monotonic binary search on the tiered domestic schedule.
 */
export function estimateMonthlyUnitsFromBillLkr(
  monthlyBillLkr: number,
  config: SolarSystemConfig = SOLAR_CONFIG
): number {
  if (!Number.isFinite(monthlyBillLkr) || monthlyBillLkr <= 150) return 0;
  let lo = 0;
  let hi = 3000;
  for (let iter = 0; iter < 32; iter++) {
    const mid = 0.5 * (lo + hi);
    const bill = computeSriLankaDomesticBillLkr(mid, config);
    if (bill < monthlyBillLkr) lo = mid;
    else hi = mid;
  }
  return Math.max(1, Math.round(0.5 * (lo + hi)));
}
