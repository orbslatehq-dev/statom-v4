import { HouseMetrics, LngLatPoint, RoofStyle, Vec2 } from '../types';

const SQM_PER_PERCH = 25.29285264;
const SQFT_PER_SQM = 10.7639104;

export function getMetersPerDegree(latDeg: number) {
  const latRad = (latDeg * Math.PI) / 180;
  const metersPerDegLat =
    111132.92 - 559.82 * Math.cos(2 * latRad) + 1.175 * Math.cos(4 * latRad);
  const metersPerDegLng =
    111412.84 * Math.cos(latRad) - 93.5 * Math.cos(3 * latRad);
  return { metersPerDegLat, metersPerDegLng };
}

export function stripClosingPoint(ring: LngLatPoint[]): LngLatPoint[] {
  if (ring.length < 2) return ring.slice();
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (Math.abs(first[0] - last[0]) < 1e-8 && Math.abs(first[1] - last[1]) < 1e-8) {
    return ring.slice(0, -1);
  }
  return ring.slice();
}

export function computeLngLatCentroid(pts: LngLatPoint[]): LngLatPoint {
  const clean = stripClosingPoint(pts);
  if (clean.length === 0) return [79.9268, 6.8482];
  let sumLng = 0;
  let sumLat = 0;
  for (const [lng, lat] of clean) {
    sumLng += lng;
    sumLat += lat;
  }
  return [sumLng / clean.length, sumLat / clean.length];
}

/**
 * Signed area in North-Up 2D space (X = East, Y = -Z = North).
 * Positive means Counter-Clockwise (CCW) when viewed from above (+Y in Three.js).
 */
export function signedAreaNorthUp(pts: Vec2[]): number {
  let area2 = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const ay = -a.z;
    const by = -b.z;
    area2 += a.x * by - b.x * ay;
  }
  return area2 * 0.5;
}

export function cleanPolygon2D(raw: Vec2[], minEdgeM = 0.14): Vec2[] {
  if (raw.length < 3) return raw.slice();

  // 1. Remove consecutive near-duplicates
  let pts: Vec2[] = [];
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i];
    const prev = pts.length > 0 ? pts[pts.length - 1] : raw[raw.length - 1];
    if (Math.hypot(cur.x - prev.x, cur.z - prev.z) >= minEdgeM) {
      pts.push({ x: cur.x, z: cur.z });
    }
  }
  if (pts.length < 3) return raw.slice(0, 3);

  // Check first vs last
  if (
    pts.length > 3 &&
    Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < minEdgeM
  ) {
    pts.pop();
  }

  // 2. Remove nearly collinear intermediate vertices
  const simplified: Vec2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const v1x = cur.x - prev.x;
    const v1z = cur.z - prev.z;
    const v2x = next.x - cur.x;
    const v2z = next.z - cur.z;
    const l1 = Math.hypot(v1x, v1z);
    const l2 = Math.hypot(v2x, v2z);
    if (l1 < 1e-4 || l2 < 1e-4) continue;
    const cross = Math.abs((v1x * v2z - v1z * v2x) / (l1 * l2));
    const dot = (v1x * v2x + v1z * v2z) / (l1 * l2);
    // Keep unless almost straight forward (dot > 0 and sin(theta) < 0.045 ~ 2.5 deg)
    if (dot > 0 && cross < 0.045 && n > 4) {
      continue;
    }
    simplified.push(cur);
  }

  const finalPts = simplified.length >= 3 ? simplified : pts;

  // 3. Enforce CCW in North-Up space (x, y = -z)
  if (signedAreaNorthUp(finalPts) < 0) {
    finalPts.reverse();
  }

  // 4. Re-center around area centroid so 3D rotation pivots smoothly about house center
  const c = computePolygon2DCentroid(finalPts);
  return finalPts.map((p) => ({ x: p.x - c.x, z: p.z - c.z }));
}

export function computePolygon2DCentroid(pts: Vec2[]): Vec2 {
  const n = pts.length;
  if (n === 0) return { x: 0, z: 0 };
  let area2 = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const cross = a.x * b.z - b.x * a.z;
    area2 += cross;
    cx += (a.x + b.x) * cross;
    cz += (a.z + b.z) * cross;
  }
  if (Math.abs(area2) < 1e-5) {
    const sx = pts.reduce((s, p) => s + p.x, 0) / n;
    const sz = pts.reduce((s, p) => s + p.z, 0) / n;
    return { x: sx, z: sz };
  }
  return {
    x: cx / (3 * area2),
    z: cz / (3 * area2),
  };
}

export function computeDominantWallAngleRad(pts: Vec2[]): number {
  let sumCos = 0;
  let sumSin = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.25) continue;
    const ang4 = 4 * Math.atan2(dz, dx);
    // Weight by len^1.5 so long primary building walls dominate over small steps
    const w = Math.pow(len, 1.5);
    sumCos += w * Math.cos(ang4);
    sumSin += w * Math.sin(ang4);
  }
  return 0.25 * Math.atan2(sumSin, sumCos);
}

export function computeOrientedBoundingBox(pts: Vec2[]) {
  if (pts.length === 0) {
    return { lengthM: 10, widthM: 8, angleRad: 0 };
  }

  // Lock onto the building's true length-weighted wall orientation (never skewing diagonally across L/T notches!)
  const wallAngle = computeDominantWallAngleRad(pts);
  const c = Math.cos(-wallAngle);
  const s = Math.sin(-wallAngle);

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    const rx = p.x * c - p.z * s;
    const rz = p.x * s + p.z * c;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (rz < minZ) minZ = rz;
    if (rz > maxZ) maxZ = rz;
  }

  const dx = Math.max(0.5, maxX - minX);
  const dz = Math.max(0.5, maxZ - minZ);

  if (dz > dx) {
    return {
      lengthM: dz,
      widthM: dx,
      angleRad: wallAngle + Math.PI / 2,
    };
  }
  return {
    lengthM: dx,
    widthM: dz,
    angleRad: wallAngle,
  };
}

export function computeHouseMetrics(polygon: LngLatPoint[]): HouseMetrics {
  const cleanRing = stripClosingPoint(polygon);
  const rawCenter = computeLngLatCentroid(cleanRing);
  const { metersPerDegLat, metersPerDegLng } = getMetersPerDegree(rawCenter[1]);

  const raw2D: Vec2[] = cleanRing.map(([lng, lat]) => ({
    x: (lng - rawCenter[0]) * metersPerDegLng,
    z: -(lat - rawCenter[1]) * metersPerDegLat,
  }));

  // Measure centroid shift before re-centering so geographic centroid stays exact
  const preClean = cleanPolygon2DNoRecenter(raw2D);
  const cShift = computePolygon2DCentroid(preClean);
  const trueCentroid: LngLatPoint = [
    rawCenter[0] + cShift.x / metersPerDegLng,
    rawCenter[1] - cShift.z / metersPerDegLat,
  ];

  const vertices2D = preClean.map((p) => ({ x: p.x - cShift.x, z: p.z - cShift.z }));

  const areaSqm = Math.max(0.5, Math.abs(signedAreaNorthUp(vertices2D)));
  const edgeLengthsM: number[] = [];
  let perimeterM = 0;
  for (let i = 0; i < vertices2D.length; i++) {
    const a = vertices2D[i];
    const b = vertices2D[(i + 1) % vertices2D.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    edgeLengthsM.push(len);
    perimeterM += len;
  }

  const ombb = computeOrientedBoundingBox(vertices2D);

  return {
    areaSqm,
    areaSqft: areaSqm * SQFT_PER_SQM,
    areaPerches: areaSqm / SQM_PER_PERCH,
    perimeterM,
    lengthM: ombb.lengthM,
    widthM: ombb.widthM,
    dominantAngleRad: ombb.angleRad,
    edgeLengthsM,
    centroid: trueCentroid,
    vertices2D,
  };
}

function cleanPolygon2DNoRecenter(raw: Vec2[], minEdgeM = 0.14): Vec2[] {
  if (raw.length < 3) return raw.slice();
  const pts: Vec2[] = [];
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i];
    const prev = pts.length > 0 ? pts[pts.length - 1] : raw[raw.length - 1];
    if (Math.hypot(cur.x - prev.x, cur.z - prev.z) >= minEdgeM) {
      pts.push({ x: cur.x, z: cur.z });
    }
  }
  if (pts.length < 3) return raw.slice(0, 3);
  if (
    pts.length > 3 &&
    Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < minEdgeM
  ) {
    pts.pop();
  }
  if (signedAreaNorthUp(pts) < 0) {
    pts.reverse();
  }
  return pts;
}

/**
 * Orthogonalizes a polygon in meter space along its dominant architectural orientation
 * so slightly hand-drawn or CV-detected edges snap to clean 90-degree house corners.
 */
export function orthogonalizeLngLatPolygon(polygon: LngLatPoint[]): LngLatPoint[] {
  const cleanRing = stripClosingPoint(polygon);
  if (cleanRing.length < 4) return cleanRing;

  const center = computeLngLatCentroid(cleanRing);
  const { metersPerDegLat, metersPerDegLng } = getMetersPerDegree(center[1]);

  const pts: Vec2[] = cleanRing.map(([lng, lat]) => ({
    x: (lng - center[0]) * metersPerDegLng,
    z: -(lat - center[1]) * metersPerDegLat,
  }));

  // Weight edge angles by edge length modulo 90 degrees
  let sumCos = 0;
  let sumSin = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.2) continue;
    const ang4 = 4 * Math.atan2(dz, dx);
    sumCos += len * Math.cos(ang4);
    sumSin += len * Math.sin(ang4);
  }
  const theta = 0.25 * Math.atan2(sumSin, sumCos);
  const c = Math.cos(-theta);
  const s = Math.sin(-theta);

  // Rotate into dominant axis frame
  const rot = pts.map((p) => ({
    x: p.x * c - p.z * s,
    z: p.x * s + p.z * c,
  }));

  // Snap each edge that is within 24 degrees of X or Z axis to exact horizontal/vertical line
  const n = rot.length;
  type LineEq = { nx: number; nz: number; d: number };
  const lines: LineEq[] = [];

  for (let i = 0; i < n; i++) {
    const a = rot[i];
    const b = rot[(i + 1) % n];
    const mx = 0.5 * (a.x + b.x);
    const mz = 0.5 * (a.z + b.z);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    let ux = dx / len;
    let uz = dz / len;

    // Check closeness to horizontal (uz ~ 0) or vertical (ux ~ 0)
    if (Math.abs(uz) < Math.sin((24 * Math.PI) / 180)) {
      ux = ux >= 0 ? 1 : -1;
      uz = 0;
    } else if (Math.abs(ux) < Math.sin((24 * Math.PI) / 180)) {
      ux = 0;
      uz = uz >= 0 ? 1 : -1;
    }
    const nx = -uz;
    const nz = ux;
    const d = nx * mx + nz * mz;
    lines.push({ nx, nz, d });
  }

  // Merge consecutive parallel lines
  const mergedLines: { line: LineEq; fallbackPt: Vec2 }[] = [];
  for (let i = 0; i < n; i++) {
    const cur = lines[i];
    if (mergedLines.length > 0) {
      const prev = mergedLines[mergedLines.length - 1].line;
      if (Math.abs(prev.nx * cur.nz - prev.nz * cur.nx) < 0.08) {
        prev.d = 0.5 * (prev.d + cur.d);
        continue;
      }
    }
    mergedLines.push({ line: { ...cur }, fallbackPt: rot[i] });
  }
  if (
    mergedLines.length > 3 &&
    Math.abs(
      mergedLines[0].line.nx * mergedLines[mergedLines.length - 1].line.nz -
        mergedLines[0].line.nz * mergedLines[mergedLines.length - 1].line.nx
    ) < 0.08
  ) {
    mergedLines[0].line.d = 0.5 * (mergedLines[0].line.d + mergedLines[mergedLines.length - 1].line.d);
    mergedLines.pop();
  }

  if (mergedLines.length < 3) return cleanRing;

  // Intersect adjacent lines
  const snappedRot: Vec2[] = [];
  const m = mergedLines.length;
  for (let i = 0; i < m; i++) {
    const L1 = mergedLines[(i - 1 + m) % m].line;
    const L2 = mergedLines[i].line;
    const det = L1.nx * L2.nz - L1.nz * L2.nx;
    if (Math.abs(det) < 0.08) {
      snappedRot.push(mergedLines[i].fallbackPt);
    } else {
      const ix = (L1.d * L2.nz - L1.nz * L2.d) / det;
      const iz = (L1.nx * L2.d - L1.d * L2.nx) / det;
      // Guard against runaway acute intersections
      if (Math.hypot(ix - mergedLines[i].fallbackPt.x, iz - mergedLines[i].fallbackPt.z) > 4.0) {
        snappedRot.push(mergedLines[i].fallbackPt);
      } else {
        snappedRot.push({ x: ix, z: iz });
      }
    }
  }

  // Rotate back to East-South meter space & convert to [lng, lat]
  const cb = Math.cos(theta);
  const sb = Math.sin(theta);
  return snappedRot.map((p) => {
    const wx = p.x * cb - p.z * sb;
    const wz = p.x * sb + p.z * cb;
    return [center[0] + wx / metersPerDegLng, center[1] - wz / metersPerDegLat] as LngLatPoint;
  });
}

function segmentsIntersectProper(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const orient = (p: Vec2, q: Vec2, r: Vec2) =>
    (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < -1e-6 && o3 * o4 < -1e-6;
}

export function isSimplePolygon(pts: Vec2[]): boolean {
  const n = pts.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a1 = pts[i];
    const a2 = pts[(i + 1) % n];
    if (Math.hypot(a2.x - a1.x, a2.z - a1.z) < 0.08) return false;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const b1 = pts[j];
      const b2 = pts[(j + 1) % n];
      if (segmentsIntersectProper(a1, a2, b1, b2)) return false;
    }
  }
  return true;
}

/**
 * Safe mitered polygon offset in meter space.
 * Note: input `pts` is CCW in North-Up space (x, y = -z).
 * `delta > 0` expands outward; `delta < 0` insets inward.
 */
export function offsetPolygon2D(pts: Vec2[], delta: number): Vec2[] {
  if (Math.abs(delta) < 1e-4 || pts.length < 3) return pts.slice();

  const n = pts.length;
  const origArea = signedAreaNorthUp(pts);
  if (origArea <= 0) return pts.slice();

  // In North-Up space (x, y = -z), for CCW edge E = (dx, dy = -dz):
  // Outward unit normal in (x, y) is (dy, -dx)/L = (-dz, -dx)/L
  // Converting back to (x, z = -y): outward normal in (x, z) is (dz, -dx)/L!
  // Let's verify: edge from (0,0) to (10,0) [East]: dx=10, dz=0 -> South is +z!
  // Wait: if polygon is (0,0)->(10,0)->(10,-8)->(0,-8) [North is -z, so y=+8]:
  // Edge 0: (0,0)->(10,0), interior is at z = -4 (North). Outward is +z = (0, +1)!
  // Check formula: (-dz, dx)/L -> (-0, 10)/10 = (0, +1)! YES!
  const outNormals: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    outNormals.push({ x: -dz / len, z: dx / len });
  }

  const candidate: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const nPrev = outNormals[(i - 1 + n) % n];
    const nCurr = outNormals[i];
    let bx = nPrev.x + nCurr.x;
    let bz = nPrev.z + nCurr.z;
    const blen = Math.hypot(bx, bz);
    if (blen < 1e-4) {
      bx = nCurr.x;
      bz = nCurr.z;
    } else {
      bx /= blen;
      bz /= blen;
    }
    const cosHalf = Math.max(0.42, bx * nCurr.x + bz * nCurr.z); // Miter limit ~2.38x
    const scale = delta / cosHalf;
    candidate.push({
      x: pts[i].x + bx * scale,
      z: pts[i].z + bz * scale,
    });
  }

  const newArea = signedAreaNorthUp(candidate);
  if (newArea > 0.25 && isSimplePolygon(candidate)) {
    return candidate;
  }

  // Fallback for very thin necks: try half offset, else return original
  if (Math.abs(delta) > 0.12) {
    const half = offsetPolygon2D(pts, delta * 0.5);
    if (signedAreaNorthUp(half) > 0.25 && isSimplePolygon(half)) {
      return half;
    }
  }
  return pts.slice();
}

export function inferArchitecturalProportions(
  metrics: HouseMetrics,
  osmHeightM?: number,
  osmLevels?: number,
  materialHint?: 'terracotta' | 'concrete' | 'metal'
): {
  stories: 1 | 2 | 3;
  wallHeightM: number;
  roofStyle: RoofStyle;
  roofPitchDeg: number;
  eaveOverhangM: number;
} {
  let stories: 1 | 2 | 3 = 1;
  let wallHeightM = 3.2;

  if (osmLevels && osmLevels >= 1) {
    stories = osmLevels >= 3 ? 3 : osmLevels >= 2 ? 2 : 1;
    wallHeightM = stories * 3.15;
  } else if (osmHeightM && osmHeightM >= 2.4) {
    wallHeightM = Math.min(11.5, Math.max(2.7, osmHeightM * 0.85));
    stories = wallHeightM >= 8.0 ? 3 : wallHeightM >= 5.2 ? 2 : 1;
  } else {
    // Realistic proportional scaling based on Sri Lankan residential house footprint
    const minSpan = Math.min(metrics.widthM, metrics.lengthM);
    if (minSpan < 4.2 || metrics.areaSqm < 32) {
      stories = 1;
      wallHeightM = 2.85;
    } else if (metrics.areaSqm > 210 && minSpan > 9.5) {
      stories = 2;
      wallHeightM = 6.2;
    } else {
      stories = 1;
      wallHeightM = 3.25;
    }
  }

  // Choose default roof style intelligently
  let roofStyle: RoofStyle = 'hip';
  if (materialHint === 'concrete') {
    roofStyle = 'flat';
  } else if (metrics.lengthM / Math.max(1, metrics.widthM) > 2.35 && metrics.vertices2D.length <= 5) {
    roofStyle = 'gable';
  } else {
    roofStyle = 'hip';
  }

  const minSpan = Math.min(metrics.widthM, metrics.lengthM);
  const eaveOverhangM =
    roofStyle === 'flat' ? 0.08 : Math.min(0.42, Math.max(0.18, minSpan * 0.048));

  const roofPitchDeg =
    (roofStyle as RoofStyle) === 'flat' ? 0 : (roofStyle as RoofStyle) === 'shed' ? 11 : 23;

  return {
    stories,
    wallHeightM: Number(wallHeightM.toFixed(2)),
    roofStyle,
    roofPitchDeg,
    eaveOverhangM: Number(eaveOverhangM.toFixed(2)),
  };
}

export function createSmartBoxPolygon(
  center: LngLatPoint,
  lengthM = 11.8,
  widthM = 8.4,
  angleRad = 0.12
): LngLatPoint[] {
  const { metersPerDegLat, metersPerDegLng } = getMetersPerDegree(center[1]);
  const hl = lengthM * 0.5;
  const hw = widthM * 0.5;
  const cornersLocal: Vec2[] = [
    { x: -hl, z: hw },
    { x: hl, z: hw },
    { x: hl, z: -hw },
    { x: -hl, z: -hw },
  ];
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return cornersLocal.map((p) => {
    const rx = p.x * c - p.z * s;
    const rz = p.x * s + p.z * c;
    return [center[0] + rx / metersPerDegLng, center[1] - rz / metersPerDegLat] as LngLatPoint;
  });
}

/**
 * Best-Estimate Clean Architectural Footprint Solver:
 * Automatically transforms noisy hand-tapped corners into clean, aligned architectural walls:
 * 1. Finds the building's true length-weighted dominant wall axis (mod 90°)
 * 2. Merges collinear mid-wall taps and absorbs tiny accidental hand-tap jogs (< 0.95m)
 * 3. Snaps near-orthogonal walls (within 28°) to exact 0°/90° axes and aligns parallel walls
 *    across wings within 0.80m onto shared architectural grid lines so every roof sits 100% cleanly!
 */
export function regularizeArchitecturalFootprint(rawPolygon: LngLatPoint[]): LngLatPoint[] {
  const cleanRing = stripClosingPoint(rawPolygon);
  if (cleanRing.length < 3) return cleanRing;

  const center = computeLngLatCentroid(cleanRing);
  const { metersPerDegLat, metersPerDegLng } = getMetersPerDegree(center[1]);

  let pts: Vec2[] = cleanRing.map(([lng, lat]) => ({
    x: (lng - center[0]) * metersPerDegLng,
    z: -(lat - center[1]) * metersPerDegLat,
  }));

  pts = cleanPolygon2DNoRecenter(pts, 0.28);
  if (pts.length < 3) return cleanRing;

  // Triangle stays a clean 3-point polygon
  if (pts.length === 3) {
    return pts.map(
      (p) => [center[0] + p.x / metersPerDegLng, center[1] - p.z / metersPerDegLat] as LngLatPoint
    );
  }

  const theta = computeDominantWallAngleRad(pts);
  const c = Math.cos(-theta);
  const s = Math.sin(-theta);

  // Rotate into building-aligned frame
  const rpts: Vec2[] = pts.map((p) => ({
    x: p.x * c - p.z * s,
    z: p.x * s + p.z * c,
  }));

  type AxisKind = 'H' | 'V' | 'D';
  type EdgeRun = { kind: AxisKind; pts: Vec2[] };
  const tanThresh = Math.tan((28 * Math.PI) / 180);

  const runs: EdgeRun[] = [];
  for (let i = 0; i < rpts.length; i++) {
    const a = rpts[i];
    const b = rpts[(i + 1) % rpts.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.38) continue;

    let kind: AxisKind = 'D';
    if (Math.abs(dz) <= Math.abs(dx) * tanThresh) {
      kind = 'H';
    } else if (Math.abs(dx) <= Math.abs(dz) * tanThresh) {
      kind = 'V';
    }

    if (runs.length > 0 && runs[runs.length - 1].kind === kind && (kind === 'H' || kind === 'V')) {
      runs[runs.length - 1].pts.push(b);
    } else {
      runs.push({ kind, pts: [a, b] });
    }
  }

  // Merge wrap-around run if first and last share H or V
  if (
    runs.length > 2 &&
    runs[0].kind === runs[runs.length - 1].kind &&
    (runs[0].kind === 'H' || runs[0].kind === 'V')
  ) {
    runs[0].pts = [...runs[runs.length - 1].pts.slice(0, -1), ...runs[0].pts];
    runs.pop();
  }

  // Absorb accidental micro-jogs (< 0.95m) sandwiched between two parallel runs (e.g., H - tiny V - H -> single H)
  let absorbed = true;
  while (absorbed && runs.length >= 6) {
    absorbed = false;
    const m = runs.length;
    for (let i = 0; i < m; i++) {
      const cur = runs[i];
      const firstPt = cur.pts[0];
      const lastPt = cur.pts[cur.pts.length - 1];
      const span = Math.hypot(lastPt.x - firstPt.x, lastPt.z - firstPt.z);
      const prevIdx = (i - 1 + m) % m;
      const nextIdx = (i + 1) % m;
      if (
        span < 0.95 &&
        runs[prevIdx].kind === runs[nextIdx].kind &&
        (runs[prevIdx].kind === 'H' || runs[prevIdx].kind === 'V')
      ) {
        runs[prevIdx].pts.push(...runs[nextIdx].pts);
        const toRemove = [i, nextIdx].sort((u, v) => v - u);
        for (const rIdx of toRemove) runs.splice(rIdx, 1);
        absorbed = true;
        break;
      }
    }
  }

  // Case 1: Purely rectilinear multi-wing / box building (all runs are H or V, alternating)
  const allOrtho = runs.length >= 4 && runs.every((r) => r.kind === 'H' || r.kind === 'V');
  if (allOrtho) {
    // Ensure strict alternation just in case absorption created adjacent identical kinds
    const mergedOrtho: EdgeRun[] = [];
    for (const r of runs) {
      if (mergedOrtho.length > 0 && mergedOrtho[mergedOrtho.length - 1].kind === r.kind) {
        mergedOrtho[mergedOrtho.length - 1].pts.push(...r.pts);
      } else {
        mergedOrtho.push({ kind: r.kind, pts: [...r.pts] });
      }
    }
    if (
      mergedOrtho.length > 2 &&
      mergedOrtho[0].kind === mergedOrtho[mergedOrtho.length - 1].kind
    ) {
      mergedOrtho[0].pts = [
        ...mergedOrtho[mergedOrtho.length - 1].pts,
        ...mergedOrtho[0].pts,
      ];
      mergedOrtho.pop();
    }

    if (mergedOrtho.length >= 4 && mergedOrtho.length % 2 === 0) {
      const coords: number[] = [];
      const weights: number[] = [];

      for (const r of mergedOrtho) {
        const p0 = r.pts[0];
        const p1 = r.pts[r.pts.length - 1];
        const w = Math.max(0.5, Math.hypot(p1.x - p0.x, p1.z - p0.z));
        const val =
          r.kind === 'H'
            ? r.pts.reduce((acc, p) => acc + p.z, 0) / r.pts.length
            : r.pts.reduce((acc, p) => acc + p.x, 0) / r.pts.length;
        coords.push(val);
        weights.push(w);
      }

      // Align nearly-collinear parallel walls across wings within 0.80m onto shared architectural grid lines!
      for (const targetKind of ['H', 'V'] as const) {
        const idxs = mergedOrtho
          .map((r, idx) => (r.kind === targetKind ? idx : -1))
          .filter((idx) => idx >= 0)
          .sort((a, b) => coords[a] - coords[b]);

        type Cluster = { idxs: number[]; wSum: number; wTot: number; mean: number };
        const clusters: Cluster[] = [];
        for (const idx of idxs) {
          const last = clusters[clusters.length - 1];
          if (!last || Math.abs(coords[idx] - last.mean) > 0.8) {
            clusters.push({
              idxs: [idx],
              wSum: weights[idx] * coords[idx],
              wTot: weights[idx],
              mean: coords[idx],
            });
          } else {
            last.idxs.push(idx);
            last.wSum += weights[idx] * coords[idx];
            last.wTot += weights[idx];
            last.mean = last.wSum / last.wTot;
          }
        }
        for (const cl of clusters) {
          for (const idx of cl.idxs) coords[idx] = cl.mean;
        }
      }

      // Reconstruct exact corners by intersecting consecutive H and V lines
      const snappedRot: Vec2[] = [];
      const m = mergedOrtho.length;
      for (let i = 0; i < m; i++) {
        const prevIdx = (i - 1 + m) % m;
        const k1 = mergedOrtho[prevIdx].kind;
        const c1 = coords[prevIdx];
        const k2 = mergedOrtho[i].kind;
        const c2 = coords[i];
        if (k1 === 'H' && k2 === 'V') {
          snappedRot.push({ x: c2, z: c1 });
        } else if (k1 === 'V' && k2 === 'H') {
          snappedRot.push({ x: c1, z: c2 });
        }
      }

      // Remove any zero-length collapsed edges caused by grid alignment
      const deduped = cleanPolygon2DNoRecenter(snappedRot, 0.25);
      if (deduped.length >= 4 && isSimplePolygon(deduped)) {
        const cb = Math.cos(theta);
        const sb = Math.sin(theta);
        const candidateWorld = deduped.map((rp) => ({
          x: rp.x * cb - rp.z * sb,
          z: rp.x * sb + rp.z * cb,
        }));

        // Verify every original vertex stays close to the regularized boundary (<= 1.15m) so points never jump away
        const maxDrift = pts.reduce((mx, origPt) => {
          let bestD = Infinity;
          for (let i = 0; i < candidateWorld.length; i++) {
            const a = candidateWorld[i];
            const b = candidateWorld[(i + 1) % candidateWorld.length];
            const vx = b.x - a.x;
            const vz = b.z - a.z;
            const l2 = vx * vx + vz * vz || 1;
            const t = Math.max(0, Math.min(1, ((origPt.x - a.x) * vx + (origPt.z - a.z) * vz) / l2));
            const d = Math.hypot(origPt.x - (a.x + t * vx), origPt.z - (a.z + t * vz));
            if (d < bestD) bestD = d;
          }
          return Math.max(mx, bestD);
        }, 0);

        if (maxDrift <= 1.15) {
          return candidateWorld.map(
            (wp) =>
              [
                center[0] + wp.x / metersPerDegLng,
                center[1] - wp.z / metersPerDegLat,
              ] as LngLatPoint
          );
        }
      }
    }
  }

  // Fallback for intentionally angled / chamfered polygons: gentle line orthogonalization
  const gentle = orthogonalizeLngLatPolygon(cleanRing);
  const gentle2D = gentle.map(([lng, lat]) => ({
    x: (lng - center[0]) * metersPerDegLng,
    z: -(lat - center[1]) * metersPerDegLat,
  }));
  if (gentle2D.length >= 3 && isSimplePolygon(gentle2D)) {
    return gentle;
  }
  return cleanRing;
}
