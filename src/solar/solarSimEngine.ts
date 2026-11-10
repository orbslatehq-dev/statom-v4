import * as THREE from 'three';
import { MonthlyClimateNormal } from '../weather/weatherTypes';
import { SOLAR_CONFIG } from './solarConfig';

export interface Vec2 {
  u: number;
  v: number;
}

export interface Tri2D {
  a: Vec2;
  b: Vec2;
  c: Vec2;
  a3: THREE.Vector3;
  b3: THREE.Vector3;
  c3: THREE.Vector3;
  areaSqm: number;
}

export interface Seg2D {
  p: Vec2;
  q: Vec2;
  lengthM: number;
}

export interface RoofSamplePoint {
  u: number;
  v: number;
  worldPos: THREE.Vector3;
  annualKwhM2: number;
  shadeFactorAnnual: number; // 0..1 (1 = completely unshaded all year)
  monthlyKwhM2: number[]; // length 12
  hourlyPoaKwM2ByMonth: number[][]; // 12 x 24 typical-day POA irradiance (kW/m²)
}

export interface RoofSectionSim {
  id: string; // e.g. 'SEC-A'
  label: string; // e.g. 'SECTION A · SOUTH SLOPE'
  cardinalLabel: string; // 'SOUTH' | 'NORTH' | 'EAST' | 'WEST' | 'FLAT' | ...
  areaSqm: number;
  pitchDeg: number;
  azimuthDeg: number; // 0=N, 90=E, 180=S, 270=W
  isFlat: boolean;
  optimalRackTiltDeg: number; // 0 on pitched; 0 or 10 on flat roofs
  optimalRackAzimuthDeg: number; // matches face azimuth on pitched; rack normal azimuth on flat
  optimalRackLabel: string; // e.g. 'FLUSH 22°' or '10° SOUTH RACK'
  effectivePanelNormal: THREE.Vector3; // World normal of panel surface placed on this section
  origin: THREE.Vector3;
  normal: THREE.Vector3; // Roof surface world normal
  uAxis: THREE.Vector3; // Orthonormal tangent along eave / primary wall
  vAxis: THREE.Vector3; // Orthonormal tangent upslope / across slab
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  triangles2D: Tri2D[];
  boundarySegments2D: Seg2D[];
  samples: RoofSamplePoint[];
  meanAnnualKwhM2: number; // Roof-plane POA kWh/m²/yr (used for heatmap)
  panelPlaneAnnualKwhM2: number; // Optimal rack/flush POA kWh/m²/yr (used for yield)
  meanShadeFactor: number; // 0..1
  monthlyKwhM2: number[]; // 12 monthly POA totals (kWh/m²) on panel plane
  hourlyPoaKwM2ByMonth: number[][]; // 12 x 24 typical-day POA kW/m² on panel plane
}

export interface SolarSimulationResult {
  sections: RoofSectionSim[]; // Sorted descending by panelPlaneAnnualKwhM2
  totalRoofAreaSqm: number;
  minSampleAnnualKwhM2: number;
  maxSampleAnnualKwhM2: number;
  meanHorizontalGhiKwhM2Day: number;
  climateYearsSpan: string;
  climateSource: 'LIVE' | 'CACHED' | 'OFFLINE';
  monthlyGhiKwhM2Day: number[]; // 12 values
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MID_MONTH_DOY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

interface SunHourState {
  hour: number; // 0..23 (evaluated at hour + 0.5 Asia/Colombo UTC+5:30)
  elevationRad: number;
  azimuthRad: number; // Clockwise from North: 0=N, pi/2=E, pi=S, 3pi/2=W
  sunDir: THREE.Vector3; // Unit vector in Three.js world (+X=East, +Y=Up, -Z=North, +Z=South)
  ghiKwM2: number; // Hourly horizontal irradiance (kW/m², numerically kWh/m² over 1h)
  dhiKwM2: number; // Diffuse horizontal irradiance (kW/m²)
  dniKwM2: number; // Direct normal irradiance (kW/m²)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Deterministic NOAA Solar Position for Sri Lanka Standard Time (Asia/Colombo, UTC+5:30).
 */
export function computeNoaaSolarPosition(
  latDeg: number,
  lngDeg: number,
  doy: number,
  localHourDecimal: number
): { elevationRad: number; azimuthRad: number; sunDir: THREE.Vector3 } {
  const latRad = (latDeg * Math.PI) / 180;
  const utcHour = localHourDecimal - 5.5;
  const gamma = ((2 * Math.PI) / 365) * (doy - 1 + (utcHour - 12) / 24);

  const eqTimeMin =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  const declRad =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  // Sri Lanka standard meridian = 5.5 * 15 = 82.5°E (330 min offset)
  const timeOffsetMin = eqTimeMin + 4 * lngDeg - 330;
  const tstMin = (((localHourDecimal * 60 + timeOffsetMin) % 1440) + 1440) % 1440;
  const haDeg = tstMin / 4 - 180;
  const haRad = (haDeg * Math.PI) / 180;

  const cosZenith = clamp(
    Math.sin(latRad) * Math.sin(declRad) +
      Math.cos(latRad) * Math.cos(declRad) * Math.cos(haRad),
    -1,
    1
  );
  const zenithRad = Math.acos(cosZenith);
  const elevationRad = Math.PI * 0.5 - zenithRad;
  const sinZenith = Math.max(1e-6, Math.sin(zenithRad));

  const cosAz = clamp(
    (Math.sin(declRad) - Math.sin(latRad) * cosZenith) /
      Math.max(1e-6, Math.cos(latRad) * sinZenith),
    -1,
    1
  );
  const rawAz = Math.acos(cosAz);
  const azimuthRad = haDeg > 0 ? 2 * Math.PI - rawAz : rawAz;

  // Map to Three.js world frame: +X = East, +Y = Up, -Z = North, +Z = South
  const cosEl = Math.cos(Math.max(0, elevationRad));
  const sunDir = new THREE.Vector3(
    cosEl * Math.sin(azimuthRad),
    Math.sin(elevationRad),
    -cosEl * Math.cos(azimuthRad)
  ).normalize();

  return { elevationRad, azimuthRad, sunDir };
}

/**
 * Erbs et al. (1982) hourly diffuse fraction correlation from hourly clearness index kt.
 */
function erbsDiffuseFraction(kt: number): number {
  const k = clamp(kt, 0.05, 0.88);
  if (k <= 0.22) {
    return 1.0 - 0.09 * k;
  }
  if (k <= 0.8) {
    return (
      0.9511 -
      0.1604 * k +
      4.388 * k * k -
      16.638 * k * k * k +
      12.336 * k * k * k * k
    );
  }
  return 0.165;
}

/**
 * Builds 12 x 24 hourly solar radiation states from ERA5 monthly daily GHI (kWh/m²/day)
 * using NOAA solar geometry + Collares-Pereira/extraterrestrial hourly distribution + Erbs split.
 */
function buildMonthlyTypicalDaySunTable(
  latDeg: number,
  lngDeg: number,
  monthlyGhiKwhM2Day: number[]
): SunHourState[][] {
  const table: SunHourState[][] = [];

  for (let m = 0; m < 12; m++) {
    const doy = MID_MONTH_DOY[m];
    const targetDailyGhi = clamp(monthlyGhiKwhM2Day[m] ?? 4.9, 2.2, 7.5);
    const iExtNormal = 1.361 * (1 + 0.033 * Math.cos(((2 * Math.PI) / 365) * doy));

    const rawPos: {
      hour: number;
      elevationRad: number;
      azimuthRad: number;
      sunDir: THREE.Vector3;
      i0Horiz: number;
      bellWeight: number;
    }[] = [];

    let sumBell = 0;
    for (let h = 0; h < 24; h++) {
      if (h < 5 || h > 19) {
        rawPos.push({
          hour: h,
          elevationRad: -0.5,
          azimuthRad: 0,
          sunDir: new THREE.Vector3(0, -1, 0),
          i0Horiz: 0,
          bellWeight: 0,
        });
        continue;
      }

      const pos = computeNoaaSolarPosition(latDeg, lngDeg, doy, h + 0.5);
      const sinEl = Math.sin(pos.elevationRad);
      if (sinEl <= 0.015) {
        rawPos.push({
          hour: h,
          elevationRad: pos.elevationRad,
          azimuthRad: pos.azimuthRad,
          sunDir: pos.sunDir,
          i0Horiz: 0,
          bellWeight: 0,
        });
        continue;
      }

      const i0Horiz = iExtNormal * sinEl;
      // Midday atmospheric transmittance slightly sharpens horizontal bell curve vs pure sin(el)
      const bellWeight = i0Horiz * (0.78 + 0.34 * sinEl);
      sumBell += bellWeight;

      rawPos.push({
        hour: h,
        elevationRad: pos.elevationRad,
        azimuthRad: pos.azimuthRad,
        sunDir: pos.sunDir,
        i0Horiz,
        bellWeight,
      });
    }

    const monthHours: SunHourState[] = rawPos.map((p) => {
      if (p.bellWeight <= 0 || sumBell <= 0 || p.i0Horiz <= 0) {
        return {
          hour: p.hour,
          elevationRad: p.elevationRad,
          azimuthRad: p.azimuthRad,
          sunDir: p.sunDir,
          ghiKwM2: 0,
          dhiKwM2: 0,
          dniKwM2: 0,
        };
      }

      const ghiKwM2 = targetDailyGhi * (p.bellWeight / sumBell);
      const kt = clamp(ghiKwM2 / p.i0Horiz, 0.1, 0.82);
      const fd = erbsDiffuseFraction(kt);
      const dhiKwM2 = ghiKwM2 * fd;
      const beamHoriz = Math.max(0, ghiKwM2 - dhiKwM2);
      const sinElSafe = Math.max(0.087, Math.sin(p.elevationRad)); // >= sin(5°)
      const dniKwM2 = Math.min(1.08, beamHoriz / sinElSafe);

      return {
        hour: p.hour,
        elevationRad: p.elevationRad,
        azimuthRad: p.azimuthRad,
        sunDir: p.sunDir,
        ghiKwM2,
        dhiKwM2,
        dniKwM2,
      };
    });

    table.push(monthHours);
  }

  return table;
}

function pointInTri2D(p: Vec2, t: Tri2D, eps = 1e-4): boolean {
  const v0u = t.c.u - t.a.u;
  const v0v = t.c.v - t.a.v;
  const v1u = t.b.u - t.a.u;
  const v1v = t.b.v - t.a.v;
  const v2u = p.u - t.a.u;
  const v2v = p.v - t.a.v;

  const dot00 = v0u * v0u + v0v * v0v;
  const dot01 = v0u * v1u + v0v * v1v;
  const dot02 = v0u * v2u + v0v * v2v;
  const dot11 = v1u * v1u + v1v * v1v;
  const dot12 = v1u * v2u + v1v * v2v;

  const denom = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denom) < 1e-10) return false;
  const inv = 1 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= -eps && v >= -eps && u + v <= 1 + eps;
}

export function isPointInSection2D(section: RoofSectionSim, p: Vec2, eps = 1e-4): boolean {
  if (
    p.u < section.uMin - eps ||
    p.u > section.uMax + eps ||
    p.v < section.vMin - eps ||
    p.v > section.vMax + eps
  ) {
    return false;
  }
  for (let i = 0; i < section.triangles2D.length; i++) {
    if (pointInTri2D(p, section.triangles2D[i], eps)) return true;
  }
  return false;
}

export function distPointToSegment2D(p: Vec2, s: Seg2D): number {
  const du = s.q.u - s.p.u;
  const dv = s.q.v - s.p.v;
  const lenSq = du * du + dv * dv;
  if (lenSq < 1e-10) {
    return Math.hypot(p.u - s.p.u, p.v - s.p.v);
  }
  const t = clamp(((p.u - s.p.u) * du + (p.v - s.p.v) * dv) / lenSq, 0, 1);
  const projU = s.p.u + t * du;
  const projV = s.p.v + t * dv;
  return Math.hypot(p.u - projU, p.v - projV);
}

export function section2DToWorld(section: RoofSectionSim, u: number, v: number, normalOffset = 0): THREE.Vector3 {
  return section.origin
    .clone()
    .addScaledVector(section.uAxis, u)
    .addScaledVector(section.vAxis, v)
    .addScaledVector(section.normal, normalOffset);
}

function azimuthDegFromNormal(normal: THREE.Vector3): number {
  const horiz = Math.hypot(normal.x, normal.z);
  if (horiz < 0.04) return 180;
  // +X = East (90°), -Z = North (0°), +Z = South (180°), -X = West (270°)
  const rad = Math.atan2(normal.x, -normal.z);
  return ((rad * 180) / Math.PI + 360) % 360;
}

function cardinalFromAzimuth(azDeg: number, isFlat: boolean): string {
  if (isFlat) return 'FLAT';
  const dirs = [
    'NORTH',
    'NORTH-EAST',
    'EAST',
    'SOUTH-EAST',
    'SOUTH',
    'SOUTH-WEST',
    'WEST',
    'NORTH-WEST',
  ];
  const idx = Math.round(azDeg / 45) % 8;
  return dirs[idx];
}

interface RawWorldTri {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  normal: THREE.Vector3;
  planeD: number;
  area: number;
  centroid: THREE.Vector3;
}

/**
 * Extracts planar upward roof sections from buildHouseModelGroup without mutating houseGroup.
 */
export function extractPlanarRoofSections(houseGroup: THREE.Group): Omit<
  RoofSectionSim,
  | 'id'
  | 'label'
  | 'optimalRackTiltDeg'
  | 'optimalRackAzimuthDeg'
  | 'optimalRackLabel'
  | 'effectivePanelNormal'
  | 'samples'
  | 'meanAnnualKwhM2'
  | 'panelPlaneAnnualKwhM2'
  | 'meanShadeFactor'
  | 'monthlyKwhM2'
  | 'hourlyPoaKwM2ByMonth'
>[] {
  houseGroup.updateMatrixWorld(true);

  const roofMeshes: THREE.Mesh[] = [];
  const allMeshes: THREE.Mesh[] = [];

  houseGroup.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    allMeshes.push(mesh);
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const std = mat as THREE.MeshStandardMaterial | undefined;
    // In roofBuilder.ts: roofMat uses roughness 0.72 (or 0.78 with map), whereas
    // wallMat = 0.85, fasciaMat = 0.85, plinthMat = 0.90.
    if (std && ((typeof std.roughness === 'number' && std.roughness < 0.8) || Boolean(std.map))) {
      roofMeshes.push(mesh);
    }
  });

  const targetMeshes = roofMeshes.length > 0 ? roofMeshes : allMeshes;
  const skyCheckRaycaster = new THREE.Raycaster();
  skyCheckRaycaster.near = 0.04;
  skyCheckRaycaster.far = 60;
  const upDir = new THREE.Vector3(0, 1, 0);
  const rawTris: RawWorldTri[] = [];

  for (const mesh of targetMeshes) {
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    if (!pos) continue;
    const index = geo.getIndex();
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);

    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

      const a = new THREE.Vector3().fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      const b = new THREE.Vector3().fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      const c = new THREE.Vector3().fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);

      const ab = new THREE.Vector3().subVectors(b, a);
      const ac = new THREE.Vector3().subVectors(c, a);
      const cross = new THREE.Vector3().crossVectors(ab, ac);
      const area = 0.5 * cross.length();
      if (area < 0.015) continue;

      const normal = cross.normalize();
      // Filter strictly to upward roof surfaces (excludes walls, gables, soffits, undersides)
      if (normal.y <= 0.42) continue;

      const centroid = new THREE.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3);
      if (centroid.y < 1.2) continue; // Excludes ground plinth

      // Discard any internal ceiling/attic triangle occluded directly overhead by the roof shell
      skyCheckRaycaster.set(centroid.clone().addScaledVector(upDir, 0.05), upDir);
      const overheadHits = skyCheckRaycaster.intersectObjects(targetMeshes, false);
      if (overheadHits.length > 0) continue;

      rawTris.push({
        a,
        b,
        c,
        normal,
        planeD: normal.dot(a),
        area,
        centroid,
      });
    }
  }

  // Group triangles into coplanar spatially-connected roof sections
  const used = new Uint8Array(rawTris.length);
  const clusters: RawWorldTri[][] = [];

  const triTouches = (t1: RawWorldTri, t2: RawWorldTri): boolean => {
    const pts1 = [t1.a, t1.b, t1.c];
    const pts2 = [t2.a, t2.b, t2.c];
    let sharedVerts = 0;
    for (const p1 of pts1) {
      for (const p2 of pts2) {
        if (p1.distanceToSquared(p2) < 0.08 * 0.08) {
          sharedVerts++;
          break;
        }
      }
    }
    if (sharedVerts >= 2) return true;
    // Also handle T-junctions from multi-wing CSG clipping where a vertex lies on another tri's edge
    const segDistSq = (p: THREE.Vector3, s0: THREE.Vector3, s1: THREE.Vector3): number => {
      const d = new THREE.Vector3().subVectors(s1, s0);
      const l2 = d.lengthSq();
      if (l2 < 1e-8) return p.distanceToSquared(s0);
      const u = clamp(new THREE.Vector3().subVectors(p, s0).dot(d) / l2, 0, 1);
      const proj = s0.clone().addScaledVector(d, u);
      return p.distanceToSquared(proj);
    };
    let closeContacts = 0;
    for (const p1 of pts1) {
      if (
        segDistSq(p1, pts2[0], pts2[1]) < 0.06 * 0.06 ||
        segDistSq(p1, pts2[1], pts2[2]) < 0.06 * 0.06 ||
        segDistSq(p1, pts2[2], pts2[0]) < 0.06 * 0.06
      ) {
        closeContacts++;
      }
    }
    for (const p2 of pts2) {
      if (
        segDistSq(p2, pts1[0], pts1[1]) < 0.06 * 0.06 ||
        segDistSq(p2, pts1[1], pts1[2]) < 0.06 * 0.06 ||
        segDistSq(p2, pts1[2], pts1[0]) < 0.06 * 0.06
      ) {
        closeContacts++;
      }
    }
    return closeContacts >= 2;
  };

  for (let i = 0; i < rawTris.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const cluster: RawWorldTri[] = [rawTris[i]];
    const queue: number[] = [i];

    while (queue.length > 0) {
      const curIdx = queue.pop()!;
      const cur = rawTris[curIdx];
      for (let j = 0; j < rawTris.length; j++) {
        if (used[j]) continue;
        const cand = rawTris[j];
        if (cur.normal.dot(cand.normal) < 0.996) continue;
        if (Math.abs(cur.planeD - cand.planeD) > 0.07) continue;
        if (!triTouches(cur, cand)) continue;
        used[j] = 1;
        cluster.push(cand);
        queue.push(j);
      }
    }
    clusters.push(cluster);
  }

  const sections: Omit<
    RoofSectionSim,
    | 'id'
    | 'label'
    | 'optimalRackTiltDeg'
    | 'optimalRackAzimuthDeg'
    | 'optimalRackLabel'
    | 'effectivePanelNormal'
    | 'samples'
    | 'meanAnnualKwhM2'
    | 'panelPlaneAnnualKwhM2'
    | 'meanShadeFactor'
    | 'monthlyKwhM2'
    | 'hourlyPoaKwM2ByMonth'
  >[] = [];

  for (const cluster of clusters) {
    let areaSqm = 0;
    const weightedNormal = new THREE.Vector3();
    const weightedOrigin = new THREE.Vector3();

    for (const t of cluster) {
      areaSqm += t.area;
      weightedNormal.addScaledVector(t.normal, t.area);
      weightedOrigin.addScaledVector(t.centroid, t.area);
    }

    if (areaSqm < 1.5) continue; // Ignore tiny sliver facets < 1.5 m²

    const normal = weightedNormal.normalize();
    const origin = weightedOrigin.multiplyScalar(1 / areaSqm);
    const pitchDeg = (Math.acos(clamp(normal.y, -1, 1)) * 180) / Math.PI;
    const isFlat = pitchDeg < 3.0;
    const azimuthDeg = azimuthDegFromNormal(normal);
    const cardinalLabel = cardinalFromAzimuth(azimuthDeg, isFlat);

    // Build orthonormal (uAxis, vAxis, normal) basis:
    // On pitched faces: uAxis is strictly horizontal along eave; vAxis points upslope toward ridge.
    let uAxis: THREE.Vector3;
    let vAxis: THREE.Vector3;

    if (!isFlat) {
      uAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), normal).normalize();
      vAxis = new THREE.Vector3().crossVectors(normal, uAxis).normalize();
    } else {
      // Initial temporary basis to detect longest exterior wall direction on flat slab
      uAxis = new THREE.Vector3(1, 0, 0);
      vAxis = new THREE.Vector3().crossVectors(normal, uAxis).normalize();
      uAxis = new THREE.Vector3().crossVectors(vAxis, normal).normalize();
    }

    const project2D = (p: THREE.Vector3): Vec2 => {
      const rel = new THREE.Vector3().subVectors(p, origin);
      return { u: rel.dot(uAxis), v: rel.dot(vAxis) };
    };

    let triangles2D: Tri2D[] = cluster.map((t) => ({
      a: project2D(t.a),
      b: project2D(t.b),
      c: project2D(t.c),
      a3: t.a,
      b3: t.b,
      c3: t.c,
      areaSqm: t.area,
    }));

    // Helper to extract exterior boundary segments in current (uAxis, vAxis) frame
    const computeBoundarySegs = (tris: Tri2D[]): Seg2D[] => {
      const ptInsideAny = (p: Vec2): boolean => {
        for (let k = 0; k < tris.length; k++) {
          if (pointInTri2D(p, tris[k], 1e-4)) return true;
        }
        return false;
      };

      const segs: Seg2D[] = [];
      for (const t of tris) {
        const edges: [Vec2, Vec2][] = [
          [t.a, t.b],
          [t.b, t.c],
          [t.c, t.a],
        ];
        const triCenter: Vec2 = {
          u: (t.a.u + t.b.u + t.c.u) / 3,
          v: (t.a.v + t.b.v + t.c.v) / 3,
        };

        for (const [p0, p1] of edges) {
          const totalLen = Math.hypot(p1.u - p0.u, p1.v - p0.v);
          if (totalLen < 0.03) continue;

          // Outward 2D normal pointing away from this triangle's interior
          let nu = -(p1.v - p0.v) / totalLen;
          let nv = (p1.u - p0.u) / totalLen;
          const mid: Vec2 = { u: 0.5 * (p0.u + p1.u), v: 0.5 * (p0.v + p1.v) };
          if ((mid.u - triCenter.u) * nu + (mid.v - triCenter.v) * nv < 0) {
            nu = -nu;
            nv = -nv;
          }

          // Subdivide long edges at ~0.25m steps only when needed for T-junction partial seams
          const subCount = Math.max(1, Math.min(16, Math.ceil(totalLen / 0.4)));
          let runStart: Vec2 | null = null;

          for (let s = 0; s < subCount; s++) {
            const f0 = s / subCount;
            const f1 = (s + 1) / subCount;
            const fm = 0.5 * (f0 + f1);
            const testPt: Vec2 = {
              u: p0.u + (p1.u - p0.u) * fm + nu * 0.025,
              v: p0.v + (p1.v - p0.v) * fm + nv * 0.025,
            };
            const isExterior = !ptInsideAny(testPt);
            if (isExterior && !runStart) {
              runStart = { u: p0.u + (p1.u - p0.u) * f0, v: p0.v + (p1.v - p0.v) * f0 };
            } else if (!isExterior && runStart) {
              const runEnd = { u: p0.u + (p1.u - p0.u) * f0, v: p0.v + (p1.v - p0.v) * f0 };
              segs.push({
                p: runStart,
                q: runEnd,
                lengthM: Math.hypot(runEnd.u - runStart.u, runEnd.v - runStart.v),
              });
              runStart = null;
            }
          }
          if (runStart) {
            segs.push({
              p: runStart,
              q: p1,
              lengthM: Math.hypot(p1.u - runStart.u, p1.v - runStart.v),
            });
          }
        }
      }
      return segs;
    };

    let boundarySegments2D = computeBoundarySegs(triangles2D);

    // On flat roofs, rotate (uAxis, vAxis) to align cleanly with the dominant parapet wall!
    if (isFlat && boundarySegments2D.length > 0) {
      let longestSeg = boundarySegments2D[0];
      for (const seg of boundarySegments2D) {
        if (seg.lengthM > longestSeg.lengthM) longestSeg = seg;
      }
      const wallVec3 = uAxis
        .clone()
        .multiplyScalar(longestSeg.q.u - longestSeg.p.u)
        .addScaledVector(vAxis, longestSeg.q.v - longestSeg.p.v);
      if (wallVec3.lengthSq() > 1e-4) {
        uAxis = wallVec3.normalize();
        // Ensure vAxis points generally southward (+Z) or northward consistently
        vAxis = new THREE.Vector3().crossVectors(normal, uAxis).normalize();
        if (vAxis.z < 0) {
          uAxis.negate();
          vAxis.negate();
        }
        triangles2D = cluster.map((t) => ({
          a: project2D(t.a),
          b: project2D(t.b),
          c: project2D(t.c),
          a3: t.a,
          b3: t.b,
          c3: t.c,
          areaSqm: t.area,
        }));
        boundarySegments2D = computeBoundarySegs(triangles2D);
      }
    }

    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const t of triangles2D) {
      for (const p of [t.a, t.b, t.c]) {
        if (p.u < uMin) uMin = p.u;
        if (p.u > uMax) uMax = p.u;
        if (p.v < vMin) vMin = p.v;
        if (p.v > vMax) vMax = p.v;
      }
    }

    sections.push({
      cardinalLabel,
      areaSqm,
      pitchDeg,
      azimuthDeg,
      isFlat,
      origin,
      normal,
      uAxis,
      vAxis,
      uMin,
      uMax,
      vMin,
      vMax,
      triangles2D,
      boundarySegments2D,
    });
  }

  sections.sort((a, b) => b.areaSqm - a.areaSqm);
  return sections;
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Runs deterministic physical POA solar simulation + Three.js Raycaster self-shadowing
 * across every roof section in non-blocking async chunks with progress callbacks.
 */
export async function runRoofSolarSimulation(params: {
  houseGroup: THREE.Group;
  latDeg: number;
  lngDeg: number;
  climateNormals: MonthlyClimateNormal[];
  climateYearsSpan: string;
  climateSource: 'LIVE' | 'CACHED' | 'OFFLINE';
  albedo?: number;
  onProgress?: (pct: number, statusText: string) => void;
}): Promise<SolarSimulationResult> {
  const {
    houseGroup,
    latDeg,
    lngDeg,
    climateNormals,
    climateYearsSpan,
    climateSource,
    albedo = SOLAR_CONFIG.performance.groundAlbedo,
    onProgress,
  } = params;

  onProgress?.(6, 'EXTRACTING 3D ROOF FACETS…');
  await yieldToMainThread();

  const rawSections = extractPlanarRoofSections(houseGroup);
  const monthlyGhiKwhM2Day = Array.from({ length: 12 }, (_, m) => {
    const found = climateNormals.find((n) => n.monthIndex === m) ?? climateNormals[m];
    return found?.meanDailyGhiKwhM2 ?? 4.9;
  });

  const sunTable = buildMonthlyTypicalDaySunTable(latDeg, lngDeg, monthlyGhiKwhM2Day);

  // Collect all house meshes for self-shadowing (opposing wings, ridges, parapets, clerestory walls)
  const shadowCasterMeshes: THREE.Mesh[] = [];
  houseGroup.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      shadowCasterMeshes.push(obj as THREE.Mesh);
    }
  });

  const raycaster = new THREE.Raycaster();
  raycaster.near = 0.04;
  raycaster.far = 120;

  // Pre-build sample grids across all sections so we know exact raycast work budget
  const sectionSampleCoords: Vec2[][] = rawSections.map((sec) => {
    const stepM = sec.areaSqm > 120 ? 1.05 : 0.8;
    const pts: Vec2[] = [];
    for (let u = sec.uMin + stepM * 0.5; u <= sec.uMax - stepM * 0.15; u += stepM) {
      for (let v = sec.vMin + stepM * 0.5; v <= sec.vMax - stepM * 0.15; v += stepM) {
        const cand = { u, v };
        if (
          sec.triangles2D.some((t) => pointInTri2D(cand, t, 1e-4))
        ) {
          pts.push(cand);
        }
      }
    }
    // Guarantee at least triangle centroids on narrow hip facets
    if (pts.length < 3) {
      for (const t of sec.triangles2D) {
        pts.push({
          u: (t.a.u + t.b.u + t.c.u) / 3,
          v: (t.a.v + t.b.v + t.c.v) / 3,
        });
      }
    }
    return pts;
  });

  const totalSamplePoints = Math.max(
    1,
    sectionSampleCoords.reduce((acc, arr) => acc + arr.length, 0)
  );
  let completedSamples = 0;
  let lastYieldMs = performance.now();

  const evaluatedSections: RoofSectionSim[] = [];
  let minSampleAnnual = Infinity;
  let maxSampleAnnual = -Infinity;

  for (let sIdx = 0; sIdx < rawSections.length; sIdx++) {
    const sec = rawSections[sIdx];
    const coords = sectionSampleCoords[sIdx];

    // Candidate panel normals:
    // - Pitched roof: flush with roof normal
    // - Flat roof: test 0° flat, 10° tilted toward +vAxis (South-ish), and 10° tilted toward -vAxis (North-ish)
    const tilt10Rad = (10 * Math.PI) / 180;
    const flatCandidates: { tiltDeg: number; normal: THREE.Vector3; label: string }[] = sec.isFlat
      ? [
          {
            tiltDeg: 0,
            normal: sec.normal.clone(),
            label: '0° FLUSH RACK',
          },
          {
            tiltDeg: 10,
            normal: sec.normal
              .clone()
              .multiplyScalar(Math.cos(tilt10Rad))
              .addScaledVector(sec.vAxis, Math.sin(tilt10Rad))
              .normalize(),
            label: `10° ${cardinalFromAzimuth(
              azimuthDegFromNormal(
                sec.normal
                  .clone()
                  .multiplyScalar(Math.cos(tilt10Rad))
                  .addScaledVector(sec.vAxis, Math.sin(tilt10Rad))
                  .normalize()
              ),
              false
            )} RACK`,
          },
          {
            tiltDeg: 10,
            normal: sec.normal
              .clone()
              .multiplyScalar(Math.cos(tilt10Rad))
              .addScaledVector(sec.vAxis, -Math.sin(tilt10Rad))
              .normalize(),
            label: `10° ${cardinalFromAzimuth(
              azimuthDegFromNormal(
                sec.normal
                  .clone()
                  .multiplyScalar(Math.cos(tilt10Rad))
                  .addScaledVector(sec.vAxis, -Math.sin(tilt10Rad))
                  .normalize()
              ),
              false
            )} RACK`,
          },
        ]
      : [
          {
            tiltDeg: Math.round(sec.pitchDeg),
            normal: sec.normal.clone(),
            label: `FLUSH ${Math.round(sec.pitchDeg)}°`,
          },
        ];

    const candidateAnnualSums = new Float64Array(flatCandidates.length);
    const candidateMonthlySums: number[][] = flatCandidates.map(() => new Array(12).fill(0));
    const candidateHourlySums: number[][][] = flatCandidates.map(() =>
      Array.from({ length: 12 }, () => new Array(24).fill(0))
    );

    const roofSkyView = 0.5 * (1 + clamp(sec.normal.y, -1, 1));
    const roofGroundView = 0.5 * (1 - clamp(sec.normal.y, -1, 1));

    const samples: RoofSamplePoint[] = [];

    for (let pIdx = 0; pIdx < coords.length; pIdx++) {
      const pt = coords[pIdx];
      const worldPos = sec.origin
        .clone()
        .addScaledVector(sec.uAxis, pt.u)
        .addScaledVector(sec.vAxis, pt.v);
      const rayOrigin = worldPos.clone().addScaledVector(sec.normal, 0.045);

      const sampleMonthlyRoof = new Array(12).fill(0);
      const sampleHourlyRoof: number[][] = Array.from({ length: 12 }, () => new Array(24).fill(0));
      let sampleAnnualRoof = 0;
      let directUnshadedSum = 0;
      let directPotentialSum = 0;

      for (let m = 0; m < 12; m++) {
        const days = DAYS_IN_MONTH[m];
        const mHours = sunTable[m];

        for (let h = 5; h <= 18; h++) {
          const sun = mHours[h];
          if (sun.ghiKwM2 <= 0) continue;

          // Check raycast self-shadowing only if sun is above horizon and faces at least one candidate or roof plane
          const cosRoof = Math.max(0, sun.sunDir.dot(sec.normal));
          let maxCandCos = cosRoof;
          for (let c = 0; c < flatCandidates.length; c++) {
            const cc = sun.sunDir.dot(flatCandidates[c].normal);
            if (cc > maxCandCos) maxCandCos = cc;
          }

          let shadowFree = 1;
          if (maxCandCos > 0.005 && sun.dniKwM2 > 0.005) {
            raycaster.set(rayOrigin, sun.sunDir);
            const hits = raycaster.intersectObjects(shadowCasterMeshes, false);
            if (hits.length > 0) {
              shadowFree = 0;
            }
          }

          if (cosRoof > 0) {
            directPotentialSum += sun.dniKwM2 * cosRoof * days;
            directUnshadedSum += shadowFree * sun.dniKwM2 * cosRoof * days;
          }

          const roofPoaKw =
            shadowFree * sun.dniKwM2 * cosRoof +
            sun.dhiKwM2 * roofSkyView +
            sun.ghiKwM2 * albedo * roofGroundView;

          sampleHourlyRoof[m][h] = roofPoaKw;
          sampleMonthlyRoof[m] += roofPoaKw * days;

          for (let c = 0; c < flatCandidates.length; c++) {
            const cNorm = flatCandidates[c].normal;
            const cSky = 0.5 * (1 + clamp(cNorm.y, -1, 1));
            const cGnd = 0.5 * (1 - clamp(cNorm.y, -1, 1));
            const cosCand = Math.max(0, sun.sunDir.dot(cNorm));
            const candPoaKw =
              shadowFree * sun.dniKwM2 * cosCand +
              sun.dhiKwM2 * cSky +
              sun.ghiKwM2 * albedo * cGnd;

            candidateHourlySums[c][m][h] += candPoaKw;
            candidateMonthlySums[c][m] += candPoaKw * days;
            candidateAnnualSums[c] += candPoaKw * days;
          }
        }

        sampleAnnualRoof += sampleMonthlyRoof[m];
      }

      if (sampleAnnualRoof < minSampleAnnual) minSampleAnnual = sampleAnnualRoof;
      if (sampleAnnualRoof > maxSampleAnnual) maxSampleAnnual = sampleAnnualRoof;

      const shadeFactorAnnual =
        directPotentialSum > 1e-3 ? directUnshadedSum / directPotentialSum : 1.0;

      samples.push({
        u: pt.u,
        v: pt.v,
        worldPos,
        annualKwhM2: sampleAnnualRoof,
        shadeFactorAnnual,
        monthlyKwhM2: sampleMonthlyRoof,
        hourlyPoaKwM2ByMonth: sampleHourlyRoof,
      });

      completedSamples++;
      const now = performance.now();
      if (now - lastYieldMs > 14) {
        const pct = Math.min(96, Math.round(10 + (completedSamples / totalSamplePoints) * 86));
        onProgress?.(
          pct,
          `RAYCASTING SUNLIGHT · SECTION ${sIdx + 1}/${rawSections.length} (${completedSamples}/${totalSamplePoints} PTS)…`
        );
        await yieldToMainThread();
        lastYieldMs = performance.now();
      }
    }

    const nPts = Math.max(1, samples.length);
    const meanAnnualKwhM2 = samples.reduce((acc, s) => acc + s.annualKwhM2, 0) / nPts;
    const meanShadeFactor = samples.reduce((acc, s) => acc + s.shadeFactorAnnual, 0) / nPts;

    // Select highest annual yield rack orientation (matters on flat roofs: 0° vs 10° S vs 10° N)
    let bestCandIdx = 0;
    for (let c = 1; c < flatCandidates.length; c++) {
      if (candidateAnnualSums[c] > candidateAnnualSums[bestCandIdx]) {
        bestCandIdx = c;
      }
    }
    const chosenCand = flatCandidates[bestCandIdx];
    const panelPlaneAnnualKwhM2 = candidateAnnualSums[bestCandIdx] / nPts;
    const monthlyKwhM2 = candidateMonthlySums[bestCandIdx].map((v) => v / nPts);
    const hourlyPoaKwM2ByMonth = candidateHourlySums[bestCandIdx].map((row) =>
      row.map((v) => v / nPts)
    );

    // If best flat candidate differs from roof plane (e.g. 10° tilted rack), scale each sample's
    // yield & hourly curves proportionally so individual slot scoring reflects optimal rack tilt + local shade!
    const rackBoostRatio =
      meanAnnualKwhM2 > 1 ? panelPlaneAnnualKwhM2 / meanAnnualKwhM2 : 1.0;
    if (sec.isFlat && Math.abs(rackBoostRatio - 1.0) > 0.002) {
      for (const sp of samples) {
        sp.monthlyKwhM2 = sp.monthlyKwhM2.map((v) => v * rackBoostRatio);
        sp.hourlyPoaKwM2ByMonth = sp.hourlyPoaKwM2ByMonth.map((row) =>
          row.map((v) => v * rackBoostRatio)
        );
      }
    }

    evaluatedSections.push({
      ...sec,
      id: '',
      label: '',
      optimalRackTiltDeg: chosenCand.tiltDeg,
      optimalRackAzimuthDeg: sec.isFlat
        ? azimuthDegFromNormal(chosenCand.normal)
        : sec.azimuthDeg,
      optimalRackLabel: chosenCand.label,
      effectivePanelNormal: chosenCand.normal.clone(),
      samples,
      meanAnnualKwhM2,
      panelPlaneAnnualKwhM2,
      meanShadeFactor,
      monthlyKwhM2,
      hourlyPoaKwM2ByMonth,
    });
  }

  // Sort sections descending by panel-plane annual yield and assign SECTION A, B, C...
  evaluatedSections.sort((a, b) => b.panelPlaneAnnualKwhM2 - a.panelPlaneAnnualKwhM2);
  evaluatedSections.forEach((sec, idx) => {
    const letter = String.fromCharCode(65 + (idx % 26));
    sec.id = `SEC-${letter}`;
    sec.label = sec.isFlat
      ? `SECTION ${letter} · FLAT TERRACE (${sec.optimalRackLabel})`
      : `SECTION ${letter} · ${sec.cardinalLabel} SLOPE`;
  });

  if (!Number.isFinite(minSampleAnnual)) {
    minSampleAnnual = 1200;
    maxSampleAnnual = 1850;
  }

  const totalRoofAreaSqm = evaluatedSections.reduce((acc, s) => acc + s.areaSqm, 0);
  const meanHorizontalGhiKwhM2Day =
    monthlyGhiKwhM2Day.reduce((a, b) => a + b, 0) / 12;

  onProgress?.(100, 'SOLAR IRRADIANCE SIMULATION COMPLETE');

  return {
    sections: evaluatedSections,
    totalRoofAreaSqm,
    minSampleAnnualKwhM2: minSampleAnnual,
    maxSampleAnnualKwhM2: maxSampleAnnual,
    meanHorizontalGhiKwhM2Day,
    climateYearsSpan,
    climateSource,
    monthlyGhiKwhM2Day,
  };
}

/**
 * Maps normalized [0..1] solar irradiance to a crisp scientific thermal ramp:
 * 0.00 Cool Deep Blue -> 0.30 Cyan-Teal -> 0.58 Golden Amber -> 0.82 Bright Orange -> 1.00 Deep Solar Red.
 */
export function irradianceNormalizedToRgb(tNorm: number): [number, number, number] {
  const stops: [number, number, number, number][] = [
    [0.0, 0.11, 0.32, 0.84], // Cool cobalt blue (shaded / worst)
    [0.28, 0.08, 0.68, 0.78], // Cyan-teal
    [0.55, 0.96, 0.79, 0.15], // Warm solar amber-yellow
    [0.8, 0.98, 0.41, 0.09], // Deep tangerine orange
    [1.0, 0.84, 0.11, 0.12], // Peak solar crimson-red (best)
  ];
  const t = clamp(tNorm, 0, 1);
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, r0, g0, b0] = stops[i];
    const [t1, r1, g1, b1] = stops[i + 1];
    if (t <= t1) {
      const f = (t - t0) / Math.max(1e-6, t1 - t0);
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
    }
  }
  return [0.84, 0.11, 0.12];
}

/**
 * Interpolates annual roof-plane irradiance (kWh/m²/yr) at any 2D point (u, v) on a section
 * via inverse-distance weighting of nearby raycast sample points.
 */
export function interpolateSectionSampleKwhM2(
  section: RoofSectionSim,
  u: number,
  v: number
): {
  annualKwhM2: number;
  shadeFactor: number;
  monthlyKwhM2: number[];
  hourlyPoaKwM2ByMonth: number[][];
} {
  if (section.samples.length === 0) {
    return {
      annualKwhM2: section.panelPlaneAnnualKwhM2,
      shadeFactor: section.meanShadeFactor,
      monthlyKwhM2: section.monthlyKwhM2.slice(),
      hourlyPoaKwM2ByMonth: section.hourlyPoaKwM2ByMonth.map((r) => r.slice()),
    };
  }

  let wSum = 0;
  let annSum = 0;
  let shadeSum = 0;
  const monthly = new Array(12).fill(0);
  const hourly = Array.from({ length: 12 }, () => new Array(24).fill(0));

  // Use 4 nearest samples for crisp spatial locality
  const nearest = section.samples
    .map((sp) => ({
      sp,
      d2: (sp.u - u) * (sp.u - u) + (sp.v - v) * (sp.v - v),
    }))
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, 4);

  for (const item of nearest) {
    const w = 1 / Math.max(0.02, item.d2);
    wSum += w;
    annSum += w * item.sp.annualKwhM2;
    shadeSum += w * item.sp.shadeFactorAnnual;
    for (let m = 0; m < 12; m++) {
      monthly[m] += w * item.sp.monthlyKwhM2[m];
      for (let h = 5; h <= 18; h++) {
        hourly[m][h] += w * item.sp.hourlyPoaKwM2ByMonth[m][h];
      }
    }
  }

  const invW = 1 / Math.max(1e-9, wSum);
  const rackScale =
    section.meanAnnualKwhM2 > 1
      ? section.panelPlaneAnnualKwhM2 / section.meanAnnualKwhM2
      : 1.0;

  return {
    annualKwhM2: annSum * invW * (section.isFlat ? rackScale : 1.0),
    shadeFactor: shadeSum * invW,
    monthlyKwhM2: monthly.map((v) => v * invW),
    hourlyPoaKwM2ByMonth: hourly.map((row) => row.map((v) => v * invW)),
  };
}

/**
 * Builds an add-on Three.js Group rendering a subdivided per-vertex solar irradiance heatmap
 * hovering 1.6 cm above roof faces so original house geometry/materials remain untouched.
 */
export function buildRoofHeatmapOverlayGroup(sim: SolarSimulationResult): THREE.Group {
  const group = new THREE.Group();
  group.name = 'solar-heatmap-overlay';

  // Ensure meaningful visual spread even on single-slope roofs while preserving absolute scale cues
  const spread = Math.max(160, sim.maxSampleAnnualKwhM2 - sim.minSampleAnnualKwhM2);
  const lo = Math.max(600, sim.maxSampleAnnualKwhM2 - spread);
  const hi = sim.maxSampleAnnualKwhM2;

  const positions: number[] = [];
  const colors: number[] = [];

  // Subdivide large triangles recursively so vertex color gradients capture partial roof shadows smoothly
  const emitTri = (
    sec: RoofSectionSim,
    p0: Vec2,
    p1: Vec2,
    p2: Vec2,
    depth: number
  ): void => {
    const l01 = Math.hypot(p1.u - p0.u, p1.v - p0.v);
    const l12 = Math.hypot(p2.u - p1.u, p2.v - p1.v);
    const l20 = Math.hypot(p0.u - p2.u, p0.v - p2.v);
    const maxEdge = Math.max(l01, l12, l20);

    if (maxEdge > 1.15 && depth < 4) {
      if (l01 >= l12 && l01 >= l20) {
        const mid = { u: 0.5 * (p0.u + p1.u), v: 0.5 * (p0.v + p1.v) };
        emitTri(sec, p0, mid, p2, depth + 1);
        emitTri(sec, mid, p1, p2, depth + 1);
      } else if (l12 >= l01 && l12 >= l20) {
        const mid = { u: 0.5 * (p1.u + p2.u), v: 0.5 * (p1.v + p2.v) };
        emitTri(sec, p0, p1, mid, depth + 1);
        emitTri(sec, p0, mid, p2, depth + 1);
      } else {
        const mid = { u: 0.5 * (p2.u + p0.u), v: 0.5 * (p2.v + p0.v) };
        emitTri(sec, p0, p1, mid, depth + 1);
        emitTri(sec, mid, p1, p2, depth + 1);
      }
      return;
    }

    for (const pt of [p0, p1, p2]) {
      const w3 = section2DToWorld(sec, pt.u, pt.v, 0.018);
      positions.push(w3.x, w3.y, w3.z);

      // Interpolate roof-plane irradiance for surface heatmap color
      let wSum = 0;
      let valSum = 0;
      for (let i = 0; i < sec.samples.length; i++) {
        const sp = sec.samples[i];
        const d2 = (sp.u - pt.u) * (sp.u - pt.u) + (sp.v - pt.v) * (sp.v - pt.v);
        const w = 1 / Math.max(0.06, d2);
        wSum += w;
        valSum += w * sp.annualKwhM2;
      }
      const kwh = wSum > 0 ? valSum / wSum : sec.meanAnnualKwhM2;
      const tNorm = clamp((kwh - lo) / Math.max(1, hi - lo), 0, 1);
      const [r, g, b] = irradianceNormalizedToRgb(tNorm);

      // Convert sRGB palette stop to linear for accurate ACES Filmic display
      const col = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
      colors.push(col.r, col.g, col.b);
    }
  };

  for (const sec of sim.sections) {
    for (const tri of sec.triangles2D) {
      emitTri(sec, tri.a, tri.b, tri.c, 0);
    }
  }

  if (positions.length > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.86,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    group.add(mesh);
  }

  return group;
}

/**
 * Cleanly disposes all geometries, materials, and textures inside an add-on Three.js Group.
 */
export function disposeThreeGroup(group: THREE.Object3D | null): void {
  if (!group) return;
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    const mats = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
      ? [mesh.material]
      : [];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial;
      if (std.map) std.map.dispose();
      m.dispose();
    }
  });
}
