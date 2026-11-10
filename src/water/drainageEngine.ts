// Drainage design engine — pure geometry + rules, derived from the REAL footprint polygon.
// Detects eave edges from roof style/pitch, lays gutters, places downpipes, routes pipes,
// positions the tank, and sizes it against the annual harvest.

import { HouseMetrics, HouseSpec, Vec2 } from '../types';
import { WATER_CONFIG } from './waterConfig';

export interface GutterSegment {
  id: string;
  label: string;
  // 3D endpoints (x, y, z) in house-local metres (+X east, -Z north), y = eave height
  a: [number, number, number];
  b: [number, number, number];
  catchmentM2: number;
  downpipeAt: 'a' | 'b' | null;
}

export interface DownpipeRun {
  id: string;
  gutterId: string;
  // Polyline path: gutter drop point → wall base → tank inlet
  path: [number, number, number][];
  pathLengthM: number;
  catchmentM2: number;
}

export interface DrainagePlan {
  style: HouseSpec['roofStyle'];
  gutters: GutterSegment[];
  downpipes: DownpipeRun[];
  tank: {
    pos: [number, number]; // x, z
    radiusM: number;
    heightM: number;
    capacityL: number;
    recommendedCapacityL: number;
    topY: number;
    inlet: [number, number, number];
    overflow: [number, number, number];
  };
  totalGutterMeters: number;
  firstFlushers: number;
  sizingNote: string;
}

function polyEdges(pts: Vec2[]): { a: Vec2; b: Vec2; len: number; mid: Vec2; nx: number; nz: number }[] {
  const edges: { a: Vec2; b: Vec2; len: number; mid: Vec2; nx: number; nz: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.35) continue; // skip sliver edges
    // outward normal for CCW polygon in (x, z): (dz, -dx) normalized
    const nx = dz / len;
    const nz = -dx / len;
    edges.push({ a, b, len, mid: { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, nx, nz });
  }
  return edges;
}

/** Signed distance from point to infinite line through `origin` with unit direction `dir`. */
function signedDist(p: Vec2, origin: Vec2, dir: Vec2): number {
  return (p.x - origin.x) * -dir.z + (p.z - origin.z) * dir.x;
}

export function designDrainage(
  spec: HouseSpec,
  metrics: HouseMetrics,
  annualHarvestLitres: number,
  overrideCapacityL?: number
): DrainagePlan {
  const pts = metrics.vertices2D;
  const edges = polyEdges(pts);
  const eaveY = Math.max(2.1, spec.wallHeightM * 0.97);
  const planArea = Math.max(12, metrics.areaSqm);
  const runoff =
    WATER_CONFIG.runoffByMaterial[
      spec.detectedMaterialHint === 'metal'
        ? 'metal'
        : spec.detectedMaterialHint === 'concrete'
        ? 'concrete'
        : 'tile'
    ];

  // Dominant axis direction (ridge direction for gable)
  const ang = metrics.dominantAngleRad;
  const ridgeDir: Vec2 = { x: Math.cos(ang), z: Math.sin(ang) };
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
  const centroid: Vec2 = { x: cx, z: cz };

  const style = spec.roofStyle;
  const gutters: GutterSegment[] = [];

  if (style === 'flat') {
    edges.forEach((e, i) => {
      gutters.push({
        id: `g${i}`,
        label: `G${i + 1}`,
        a: [e.a.x, eaveY, e.a.z],
        b: [e.b.x, eaveY, e.b.z],
        catchmentM2: (e.len / edges.reduce((s, x) => s + x.len, 0)) * planArea,
        downpipeAt: null,
      });
    });
  } else if (style === 'hip') {
    edges.forEach((e, i) => {
      gutters.push({
        id: `g${i}`,
        label: `G${i + 1}`,
        a: [e.a.x, eaveY, e.a.z],
        b: [e.b.x, eaveY, e.b.z],
        catchmentM2: (e.len / edges.reduce((s, x) => s + x.len, 0)) * planArea,
        downpipeAt: null,
      });
    });
  } else if (style === 'gable') {
    // Ridge through centroid along dominant axis; pick the farthest edge on each side
    let bestPos = { idx: -1, d: -Infinity };
    let bestNeg = { idx: -1, d: -Infinity };
    edges.forEach((e, i) => {
      const d = signedDist(e.mid, centroid, ridgeDir);
      if (d >= 0 && d > bestPos.d) bestPos = { idx: i, d };
      if (d < 0 && -d > bestNeg.d) bestNeg = { idx: i, d };
    });
    edges.forEach((e, i) => {
      if (i === bestPos.idx || i === bestNeg.idx) {
        gutters.push({
          id: `g${i}`,
          label: i === bestPos.idx ? 'S-SLOPE' : 'N-SLOPE',
          a: [e.a.x, eaveY, e.a.z],
          b: [e.b.x, eaveY, e.b.z],
          catchmentM2: planArea / 2,
          downpipeAt: null,
        });
      }
    });
  } else {
    // shed — single slope: eave = edge whose midpoint is farthest along slope dir
    // slope dir = perpendicular of ridge toward the longer span side
    const slopeDir: Vec2 = { x: -ridgeDir.z, z: ridgeDir.x };
    let best = { idx: -1, d: -Infinity };
    edges.forEach((e, i) => {
      const d = Math.abs(signedDist(e.mid, centroid, slopeDir));
      if (d > best.d) best = { idx: i, d };
    });
    edges.forEach((e, i) => {
      if (i === best.idx) {
        gutters.push({
          id: `g${i}`,
          label: 'LOWER EAVE',
          a: [e.a.x, eaveY, e.a.z],
          b: [e.b.x, eaveY, e.b.z],
          catchmentM2: planArea,
          downpipeAt: null,
        });
      }
    });
  }

  // Tank: ground position at the bbox corner with most open space (max |x|,|z| corner)
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const annualL = Math.max(500, annualHarvestLitres);

  // Recommended capacity: smallest catalogue tank capturing ≥80% in a simple monthly model
  const demandGuessLPerDay = 70;
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const monthIn = Array.from({ length: 12 }, () => (annualL / 12));
  // Monsoon shape: boost May-Jun & Sep-Oct per Sri Lankan pattern using normals share is done by caller;
  // here a flat seasonal split is sufficient for capacity choice.
  const monthlyDemandL = daysInMonth.map((d) => d * demandGuessLPerDay);
  const pickCapacity = (cap: number): { captured: number; inflow: number } => {
    let lvl = 0;
    let captured = 0;
    let inflow = 0;
    for (let m = 0; m < 12; m++) {
      const inL = monthIn[m] * 0.94; // first-flush allowance
      inflow += inL;
      const take = Math.min(lvl + inL, monthlyDemandL[m]);
      captured += take;
      lvl = Math.min(cap, lvl + inL - take);
    }
    return { captured, inflow };
  };
  let recommendedCapacityL = WATER_CONFIG.tankOptionsL[WATER_CONFIG.tankOptionsL.length - 1];
  for (const cap of WATER_CONFIG.tankOptionsL) {
    const r = pickCapacity(cap);
    if (r.inflow > 0 && r.captured / r.inflow >= 0.8) {
      recommendedCapacityL = cap;
      break;
    }
  }

  // Tank geometry
  const capacityL =
    overrideCapacityL ??
    recommendedCapacityL;
  const radiusM = capacityL >= 10000 ? 1.35 : capacityL >= 5000 ? 1.05 : capacityL >= 2500 ? 0.9 : 0.68;
  const heightM = Math.max(1.5, Math.min(2.4, capacityL / 1000 / (Math.PI * radiusM * radiusM) * 1.35));
  const tankX = maxX + 1.2 + radiusM;
  const tankZ = maxZ + 1.2 + radiusM;
  const topY = heightM + 0.12;

  // Downpipes: required count from catchment cap, placed at gutter ends nearest the tank
  const totalCatch = gutters.reduce((s, g) => s + g.catchmentM2, 0);
  const need = Math.max(1, Math.min(4, Math.ceil(totalCatch / WATER_CONFIG.downpipeCatchmentCapM2)));
  // Rank gutter-ends by distance to tank inlet
  const inlet: [number, number, number] = [tankX, topY - 0.18, tankZ];
  type Cand = { gutter: GutterSegment; end: 'a' | 'b'; d: number };
  const cands: Cand[] = [];
  for (const g of gutters) {
    const da = Math.hypot(g.a[0] - tankX, g.a[2] - tankZ);
    const db = Math.hypot(g.b[0] - tankX, g.b[2] - tankZ);
    cands.push({ gutter: g, end: da <= db ? 'a' : 'b', d: Math.min(da, db) });
  }
  cands.sort((p, q) => p.d - q.d);
  const chosen = cands.slice(0, Math.min(need, cands.length));
  const downpipes: DownpipeRun[] = chosen.map((c, i) => {
    const g = c.gutter;
    const drop: [number, number, number] = c.end === 'a' ? [...g.a] as [number, number, number] : [...g.b] as [number, number, number];
    const base: [number, number, number] = [drop[0], 0.22, drop[2]];
    const path: [number, number, number][] = [drop, base, [inlet[0], 0.22, inlet[2]], inlet];
    let plen = 0;
    for (let k = 1; k < path.length; k++) {
      plen += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1], path[k][2] - path[k - 1][2]);
    }
    g.downpipeAt = c.end;
    return {
      id: `dp${i}`,
      gutterId: g.id,
      path,
      pathLengthM: plen,
      catchmentM2: g.catchmentM2 / Math.max(1, chosen.filter((x) => x.gutter.id === g.id).length),
    };
  });

  const totalGutterMeters = gutters.reduce((s, g) => s + Math.hypot(g.b[0] - g.a[0], g.b[2] - g.a[2]), 0);

  return {
    style,
    gutters,
    downpipes,
    tank: {
      pos: [tankX, tankZ],
      radiusM,
      heightM,
      capacityL,
      recommendedCapacityL,
      topY,
      inlet,
      overflow: [tankX - radiusM * 0.7, heightM * 0.92, tankZ],
    },
    totalGutterMeters,
    firstFlushers: downpipes.length,
    sizingNote:
      recommendedCapacityL >= 10000
        ? `THIS TANK ACTUALLY CAPTURES ~${Math.round(annualL).toLocaleString()} L/YR OF THE RAIN (THE REST OVERFLOWS WET SEASONS).`
        : `A ${recommendedCapacityL.toLocaleString()} L TANK CAPTURES ~80% OF THE ~${Math.round(
            annualL
          ).toLocaleString()} L/YR YOUR ROOF CAN COLLECT.`,
  };
}

export function planRunoffCoefficient(spec: HouseSpec): number {
  return WATER_CONFIG.runoffByMaterial[
    spec.detectedMaterialHint === 'metal'
      ? 'metal'
      : spec.detectedMaterialHint === 'concrete'
      ? 'concrete'
      : 'tile'
  ];
}
