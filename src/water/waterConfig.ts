// WATER MANAGEMENT CONFIG — every editable number in one place.
// Ballpark estimates for planning only. lastVerified: 2026-11 (Sri Lanka retail ballparks)

export interface WaterConfig {
  // Hydraulics
  downpipeCatchmentCapM2: number; // 75mm PVC downpipe handles ≈ this much roof
  firstFlushSkipMm: number; // first-flush diverter skips this much rain per rain event
  runoffByMaterial: Record<'metal' | 'tile' | 'concrete', number>;

  // Tank catalogue (litres → installed LKR ballparks)
  tankOptionsL: number[];
  tankPriceLkr: Record<number, number>;

  // Kit prices (LKR)
  gutterPerMeterLkr: number;
  downpipeEachLkr: number;
  firstFlushKitLkr: number;
  leafGuardPerMeterLkr: number;
  pumpLkr: number;
  fittingsLkr: number;
  installLabourPct: number;

  // Value of water
  mainsWaterLkrPerM3: number; // LKR per 1000 L saved from mains

  // Default reuse demands (litres/day)
  defaultDemand: {
    gardenL: number;
    toiletPerPersonL: number;
    washL: number;
  };
}

export const WATER_CONFIG: WaterConfig = {
  downpipeCatchmentCapM2: 55,
  firstFlushSkipMm: 1,
  runoffByMaterial: { metal: 0.85, tile: 0.8, concrete: 0.9 },

  tankOptionsL: [1000, 2500, 5000, 10000],
  tankPriceLkr: {
    1000: 20000,
    2500: 42000,
    5000: 75000,
    10000: 135000,
  },

  gutterPerMeterLkr: 2000,
  downpipeEachLkr: 4500,
  firstFlushKitLkr: 11000,
  leafGuardPerMeterLkr: 350,
  pumpLkr: 24000,
  fittingsLkr: 8000,
  installLabourPct: 12,

  mainsWaterLkrPerM3: 40,

  defaultDemand: {
    gardenL: 40,
    toiletPerPersonL: 30,
    washL: 20,
  },
};
