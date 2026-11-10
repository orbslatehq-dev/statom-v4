import * as THREE from 'three';
import { HouseMetrics, HouseSpec, ModelFinish, Vec2 } from '../types';
import { offsetPolygon2D, signedAreaNorthUp } from './geoProjection';

interface Plane2D {
  nx: number; // Inward unit normal X in (x, z)
  nz: number; // Inward unit normal Z in (x, z)
  c: number;  // Signed inward distance h(x,z) = nx*x + nz*z + c (at tan=1)
}

export interface PaletteColors {
  plinth: number;
  wall: number;
  fascia: number;
  roof: number;
  edge: number;
  slabLine: number;
  wireframeOnly?: boolean;
}

export function getPaletteForFinish(
  finish: ModelFinish,
  materialHint?: 'terracotta' | 'concrete' | 'metal'
): PaletteColors {
  switch (finish) {
    case 'terracotta':
      return {
        plinth: 0x232320,
        wall: 0xf4efe4,
        fascia: 0x2b2927,
        roof:
          materialHint === 'concrete'
            ? 0xbdb9ae
            : materialHint === 'metal'
            ? 0x676d72
            : 0xc85533,
        edge: 0x111111,
        slabLine: 0x111111,
      };
    case 'blueprint':
      return {
        plinth: 0x0d2149,
        wall: 0x183a7a,
        fascia: 0x224da0,
        roof: 0x2758b8,
        edge: 0xe2ff32,
        slabLine: 0x8db5ff,
      };
    case 'satellite':
      return {
        plinth: 0x1e1e1c,
        wall: 0xf2f0e8,
        fascia: 0x2a2a28,
        roof: 0xffffff,
        edge: 0x111111,
        slabLine: 0x111111,
      };
    case 'maquette':
    default:
      return {
        plinth: 0x191918,
        wall: 0xf8f7f2,
        fascia: 0x191918,
        roof: 0xe7e4da,
        edge: 0x111111,
        slabLine: 0x111111,
      };
  }
}

function createExtrudedPrism(poly: Vec2[], height: number, baseY: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(poly[0].x, -poly[0].z);
  for (let i = 1; i < poly.length; i++) {
    shape.lineTo(poly[i].x, -poly[i].z);
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.02, height),
    bevelEnabled: false,
    steps: 1,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, baseY, 0);
  geo.computeVertexNormals();
  return geo;
}

function isConvexPolygonCCW(pts: Vec2[]): boolean {
  const n = pts.length;
  if (n < 3) return false;
  // In North-Up CCW (x, y = -z): edge vector (dx, dy = -dz)
  // Cross product of consecutive edges in (x, y): dx1*dy2 - dy1*dx2 >= 0
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const dx1 = p1.x - p0.x;
    const dy1 = -(p1.z - p0.z);
    const dx2 = p2.x - p1.x;
    const dy2 = -(p2.z - p1.z);
    const cross = dx1 * dy2 - dy1 * dx2;
    if (cross < -1e-3) return false;
  }
  return true;
}

function clipPolygonHalfPlane(poly: Vec2[], a: number, b: number, c: number): Vec2[] {
  // Keeps points where a*x + b*z + c >= -1e-7
  const out: Vec2[] = [];
  const n = poly.length;
  if (n === 0) return out;

  for (let i = 0; i < n; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % n];
    const d1 = a * p1.x + b * p1.z + c;
    const d2 = a * p2.x + b * p2.z + c;
    const in1 = d1 >= -1e-7;
    const in2 = d2 >= -1e-7;

    if (in1 && in2) {
      out.push(p2);
    } else if (in1 && !in2) {
      const denom = d1 - d2;
      const t = Math.abs(denom) > 1e-12 ? d1 / denom : 0;
      out.push({
        x: p1.x + t * (p2.x - p1.x),
        z: p1.z + t * (p2.z - p1.z),
      });
    } else if (!in1 && in2) {
      const denom = d1 - d2;
      const t = Math.abs(denom) > 1e-12 ? d1 / denom : 0;
      out.push({
        x: p1.x + t * (p2.x - p1.x),
        z: p1.z + t * (p2.z - p1.z),
      });
      out.push(p2);
    }
  }
  return out;
}

function computeConvexInwardPlanes(poly: Vec2[]): Plane2D[] {
  // Note: poly is CCW in (x, y = -z).
  // Earlier we proved outward normal in (x, z) is (-dz/L, dx/L).
  // Therefore INWARD unit normal in (x, z) is (+dz/L, -dx/L)!
  // Let's verify: rect (-5, +4) -> (+5, +4) -> (+5, -4) -> (-5, -4)
  // Edge 0: (-5, +4) -> (+5, +4): dx = +10, dz = 0. Interior is z = 0 (North, -z).
  // (+dz/L, -dx/L) = (0, -1)! At (0, 0), nx*0 + nz*0 - (nx*-5 + nz*4) = -(-4) = +4! POSITIVE!
  const planes: Plane2D[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const L = Math.hypot(dx, dz) || 1;
    const nx = dz / L;
    const nz = -dx / L;
    const c = -(nx * a.x + nz * a.z);
    planes.push({ nx, nz, c });
  }
  return planes;
}

function getBounds2D(pts: Vec2[]) {
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
  return { minX, maxX, minZ, maxZ };
}

/**
 * Exact analytical planar Hip or Gable roof builder for any convex polygon.
 */
function buildConvexPlanarRoofGeometry(
  poly: Vec2[],
  baseY: number,
  pitchDeg: number,
  gableAxisAngleRad: number | null,
  uvBounds: { minX: number; maxX: number; minZ: number; maxZ: number }
): THREE.BufferGeometry {
  const planes = computeConvexInwardPlanes(poly);
  const n = poly.length;
  const tanP = Math.tan((pitchDeg * Math.PI) / 180);

  // Determine which edges are sloped vs vertical gable ends
  const isGableEnd = new Array<boolean>(n).fill(false);
  if (gableAxisAngleRad !== null && n >= 4) {
    // Major axis unit vector (ridge runs along major axis; gable ends face along major axis!)
    const gx = Math.cos(gableAxisAngleRad);
    const gz = Math.sin(gableAxisAngleRad);
    for (let i = 0; i < n; i++) {
      const align = Math.abs(planes[i].nx * gx + planes[i].nz * gz);
      if (align > 0.72) {
        isGableEnd[i] = true;
      }
    }
    // Ensure at least 2 sloped planes remain
    const slopedCount = isGableEnd.filter((g) => !g).length;
    if (slopedCount < 2) {
      isGableEnd.fill(false);
    }
  }

  const bounds = getBounds2D(poly);
  const pad = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) + 20;
  const cx = 0.5 * (bounds.minX + bounds.maxX);
  const cz = 0.5 * (bounds.minZ + bounds.maxZ);
  // CCW quad in North-Up space (x, y = -z): (-,+)->(+,+)->(+,-)->(-,-)
  const initQuad: Vec2[] = [
    { x: cx - pad, z: cz + pad },
    { x: cx + pad, z: cz + pad },
    { x: cx + pad, z: cz - pad },
    { x: cx - pad, z: cz - pad },
  ];

  const positions: number[] = [];
  const uvs: number[] = [];

  const pushTri = (
    p0: { x: number; y: number; z: number },
    p1: { x: number; y: number; z: number },
    p2: { x: number; y: number; z: number }
  ) => {
    // Ensure upward/outward normal check when needed
    positions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
    const spanX = Math.max(0.1, uvBounds.maxX - uvBounds.minX);
    const spanZ = Math.max(0.1, uvBounds.maxZ - uvBounds.minZ);
    for (const v of [p0, p1, p2]) {
      uvs.push((v.x - uvBounds.minX) / spanX, 1 - (v.z - uvBounds.minZ) / spanZ);
    }
  };

  // 1. Sloped roof planes
  for (let i = 0; i < n; i++) {
    if (isGableEnd[i]) continue;
    const pi = planes[i];

    // Clip against ALL polygon boundary edges so roof never leaves footprint
    let cell = initQuad;
    for (let k = 0; k < n; k++) {
      cell = clipPolygonHalfPlane(cell, planes[k].nx, planes[k].nz, planes[k].c);
      if (cell.length < 3) break;
    }
    if (cell.length < 3) continue;

    // Clip against all OTHER sloped planes: h_j(x,z) - h_i(x,z) >= 0
    for (let j = 0; j < n; j++) {
      if (j === i || isGableEnd[j]) continue;
      const pj = planes[j];
      cell = clipPolygonHalfPlane(cell, pj.nx - pi.nx, pj.nz - pi.nz, pj.c - pi.c);
      if (cell.length < 3) break;
    }
    if (cell.length < 3) continue;

    // Ensure CCW in North-Up so upward normal is +Y
    if (signedAreaNorthUp(cell) < 0) {
      cell.reverse();
    }

    const lifted = cell.map((p) => ({
      x: p.x,
      y: baseY + Math.max(0, (pi.nx * p.x + pi.nz * p.z + pi.c) * tanP),
      z: p.z,
    }));

    // In Three.js right-handed (X, Y, Z):
    // Let's check cross product of (lifted[1]-lifted[0]) x (lifted[2]-lifted[0]):
    // For CCW in (x, -z): v1=(1,0,0), v2=(0,0,-1) -> v1 x v2 = (0* -1 - 0*0, 0*0 - 1*-1, 0) = (0, +1, 0) = +Y!
    for (let t = 1; t < lifted.length - 1; t++) {
      pushTri(lifted[0], lifted[t], lifted[t + 1]);
    }
  }

  // 2. Vertical Gable End Wall Triangles
  for (let g = 0; g < n; g++) {
    if (!isGableEnd[g]) continue;
    const A = poly[g];
    const B = poly[(g + 1) % n];

    // Sample points along edge A -> B and lift to min sloped roof height
    const steps = 16;
    const samples: { x: number; y: number; z: number }[] = [];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = A.x + t * (B.x - A.x);
      const pz = A.z + t * (B.z - A.z);
      let minH = Infinity;
      for (let j = 0; j < n; j++) {
        if (isGableEnd[j]) continue;
        const h = (planes[j].nx * px + planes[j].nz * pz + planes[j].c) * tanP;
        if (h < minH) minH = h;
      }
      samples.push({
        x: px,
        y: baseY + Math.max(0, Number.isFinite(minH) ? minH : 0),
        z: pz,
      });
    }

    // Build vertical wall quads from baseY up to roof profile (outward normal = -planes[g])
    for (let s = 0; s < steps; s++) {
      const s0 = samples[s];
      const s1 = samples[s + 1];
      if (s0.y <= baseY + 1e-4 && s1.y <= baseY + 1e-4) continue;
      const b0 = { x: s0.x, y: baseY, z: s0.z };
      const b1 = { x: s1.x, y: baseY, z: s1.z };
      // Check outward winding: from A to B (CCW in x,-z), v_along = B - A, v_up = +Y
      // (B - A) x (+Y): for (+1, 0, 0) x (0, 1, 0) = (0, 0, +1), which IS outward South!
      pushTri(b0, b1, s1);
      pushTri(b0, s1, s0);
    }
  }

  // 3. Bottom soffit cap so looking from low angles is 100% watertight
  const soffitContour = poly.map((p) => new THREE.Vector2(p.x, -p.z));
  const soffitTris = THREE.ShapeUtils.triangulateShape(soffitContour, []);
  for (const [i0, i1, i2] of soffitTris) {
    const a = poly[i0];
    const b = poly[i1];
    const c = poly[i2];
    pushTri(
      { x: a.x, y: baseY, z: a.z },
      { x: c.x, y: baseY, z: c.z },
      { x: b.x, y: baseY, z: b.z }
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

function pointInPolyXZ(px: number, pz: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      zi = poly[i].z;
    const xj = poly[j].x,
      zj = poly[j].z;
    const intersect =
      zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function dedupPoly2D(poly: Vec2[], eps = 1e-4): Vec2[] {
  const out: Vec2[] = [];
  for (const p of poly) {
    if (out.length === 0 || Math.hypot(p.x - out[out.length - 1].x, p.z - out[out.length - 1].z) > eps) {
      out.push(p);
    }
  }
  if (
    out.length > 1 &&
    Math.hypot(out[0].x - out[out.length - 1].x, out[0].z - out[out.length - 1].z) <= eps
  ) {
    out.pop();
  }
  return out;
}

interface ExtractedOrthoWing {
  polyWorld: Vec2[]; // 4-corner CCW in North-Up (x, -z)
  outerEdgeFlags: [boolean, boolean, boolean, boolean]; // Whether each of the 4 edges lies on the true exterior boundary
  area: number;
}

/**
 * Extracts maximal inscribed axis-aligned rectangular wings inside a concave orthogonal polygon
 * in its wall-locked dominant orientation frame, sorted largest-wing-first with strict containment pruning.
 */
function extractMaximalOrthoWings(
  poly: Vec2[],
  dominantAngleRad: number
): ExtractedOrthoWing[] | null {
  const c = Math.cos(-dominantAngleRad);
  const s = Math.sin(-dominantAngleRad);
  const rot = poly.map((p) => ({
    x: p.x * c - p.z * s,
    z: p.x * s + p.z * c,
  }));

  const clusterCoords = (vals: number[]) => {
    const sorted = [...vals].sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of sorted) {
      if (out.length === 0 || Math.abs(v - out[out.length - 1]) > 0.22) {
        out.push(v);
      } else {
        out[out.length - 1] = 0.5 * (out[out.length - 1] + v);
      }
    }
    return out;
  };

  const xs = clusterCoords(rot.map((p) => p.x));
  const zs = clusterCoords(rot.map((p) => p.z));
  const nx = xs.length - 1;
  const nz = zs.length - 1;
  if (nx < 1 || nz < 1 || nx > 14 || nz > 14) return null;

  const active: boolean[][] = Array.from({ length: nx }, () => new Array<boolean>(nz).fill(false));
  let coveredArea = 0;

  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      const mx = 0.5 * (xs[ix] + xs[ix + 1]);
      const mz = 0.5 * (zs[iz] + zs[iz + 1]);
      if (pointInPolyXZ(mx, mz, rot)) {
        active[ix][iz] = true;
        coveredArea += (xs[ix + 1] - xs[ix]) * (zs[iz + 1] - zs[iz]);
      }
    }
  }

  const totalArea = Math.abs(signedAreaNorthUp(poly));
  if (coveredArea < totalArea * 0.93 || coveredArea > totalArea * 1.07) {
    return null;
  }

  type RawBox = { x0: number; x1: number; z0: number; z1: number; area: number };
  const seen = new Set<string>();
  const boxes: RawBox[] = [];

  const canFill = (ax0: number, ax1: number, az0: number, az1: number) => {
    for (let x = ax0; x <= ax1; x++) {
      for (let z = az0; z <= az1; z++) {
        if (!active[x][z]) return false;
      }
    }
    return true;
  };

  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      if (!active[ix][iz]) continue;
      for (const horizFirst of [true, false]) {
        let x0 = ix,
          x1 = ix,
          z0 = iz,
          z1 = iz;
        if (horizFirst) {
          while (x0 > 0 && canFill(x0 - 1, x1, z0, z1)) x0--;
          while (x1 < nx - 1 && canFill(x0, x1 + 1, z0, z1)) x1++;
          while (z0 > 0 && canFill(x0, x1, z0 - 1, z1)) z0--;
          while (z1 < nz - 1 && canFill(x0, x1, z0, z1 + 1)) z1++;
        } else {
          while (z0 > 0 && canFill(x0, x1, z0 - 1, z1)) z0--;
          while (z1 < nz - 1 && canFill(x0, x1, z0, z1 + 1)) z1++;
          while (x0 > 0 && canFill(x0 - 1, x1, z0, z1)) x0--;
          while (x1 < nx - 1 && canFill(x0, x1 + 1, z0, z1)) x1++;
        }
        const key = `${x0},${x1},${z0},${z1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const area = (xs[x1 + 1] - xs[x0]) * (zs[z1 + 1] - zs[z0]);
        boxes.push({ x0, x1, z0, z1, area });
      }
    }
  }

  // Sort largest wing first and prune any box strictly contained in another box or redundant
  boxes.sort((a, b) => b.area - a.area);
  const maximalBoxes = boxes.filter(
    (b, i) =>
      !boxes.some(
        (other, j) =>
          j !== i &&
          other.x0 <= b.x0 &&
          other.x1 >= b.x1 &&
          other.z0 <= b.z0 &&
          other.z1 >= b.z1
      )
  );

  // Greedy minimal cover so redundant bridge rectangles already covered by main wings are dropped!
  const coveredCell: boolean[][] = Array.from({ length: nx }, () =>
    new Array<boolean>(nz).fill(false)
  );
  const selectedBoxes: RawBox[] = [];
  for (const b of maximalBoxes) {
    let addsUncoveredCell = false;
    for (let x = b.x0; x <= b.x1; x++) {
      for (let z = b.z0; z <= b.z1; z++) {
        if (!coveredCell[x][z]) addsUncoveredCell = true;
      }
    }
    if (addsUncoveredCell) {
      selectedBoxes.push(b);
      for (let x = b.x0; x <= b.x1; x++) {
        for (let z = b.z0; z <= b.z1; z++) {
          coveredCell[x][z] = true;
        }
      }
    }
  }

  if (selectedBoxes.length === 0) return null;

  const cb = Math.cos(dominantAngleRad);
  const sb = Math.sin(dominantAngleRad);

  return selectedBoxes.map((b) => {
    const rx0 = xs[b.x0],
      rx1 = xs[b.x1 + 1],
      rz0 = zs[b.z0],
      rz1 = zs[b.z1 + 1];

    // Check whether each of the 4 edges has NO active building cells immediately outside it
    // Edge 0: (rx0, rz1) -> (rx1, rz1) [South +z side, iz = b.z1 + 1]
    const outSouth =
      b.z1 === nz - 1 ||
      Array.from({ length: b.x1 - b.x0 + 1 }, (_, k) => !active[b.x0 + k][b.z1 + 1]).every(Boolean);
    // Edge 1: (rx1, rz1) -> (rx1, rz0) [East +x side, ix = b.x1 + 1]
    const outEast =
      b.x1 === nx - 1 ||
      Array.from({ length: b.z1 - b.z0 + 1 }, (_, k) => !active[b.x1 + 1][b.z0 + k]).every(Boolean);
    // Edge 2: (rx1, rz0) -> (rx0, rz0) [North -z side, iz = b.z0 - 1]
    const outNorth =
      b.z0 === 0 ||
      Array.from({ length: b.x1 - b.x0 + 1 }, (_, k) => !active[b.x0 + k][b.z0 - 1]).every(Boolean);
    // Edge 3: (rx0, rz0) -> (rx0, rz1) [West -x side, ix = b.x0 - 1]
    const outWest =
      b.x0 === 0 ||
      Array.from({ length: b.z1 - b.z0 + 1 }, (_, k) => !active[b.x0 - 1][b.z0 + k]).every(Boolean);

    const rectRot: Vec2[] = [
      { x: rx0, z: rz1 },
      { x: rx1, z: rz1 },
      { x: rx1, z: rz0 },
      { x: rx0, z: rz0 },
    ];
    const polyWorld = rectRot.map((rp) => ({
      x: rp.x * cb - rp.z * sb,
      z: rp.x * sb + rp.z * cb,
    }));

    return {
      polyWorld,
      outerEdgeFlags: [outSouth, outEast, outNorth, outWest],
      area: b.area,
    };
  });
}

function partitionConvexAgainstConvex(
  subjectPolys: Vec2[][],
  clipPolyCCW: Vec2[]
): { outside: Vec2[][]; inside: Vec2[][] } {
  const edges = computeConvexInwardPlanes(clipPolyCCW);
  const outside: Vec2[][] = [];
  const inside: Vec2[][] = [];

  for (const sub of subjectPolys) {
    let rem = sub;
    for (const e of edges) {
      const outPiece = dedupPoly2D(clipPolygonHalfPlane(rem, -e.nx, -e.nz, -e.c));
      if (outPiece.length >= 3 && Math.abs(signedAreaNorthUp(outPiece)) > 1e-4) {
        outside.push(outPiece);
      }
      rem = dedupPoly2D(clipPolygonHalfPlane(rem, e.nx, e.nz, e.c));
      if (rem.length < 3 || Math.abs(signedAreaNorthUp(rem)) <= 1e-4) {
        rem = [];
        break;
      }
    }
    if (rem.length >= 3 && Math.abs(signedAreaNorthUp(rem)) > 1e-4) {
      inside.push(rem);
    }
  }

  return { outside, inside };
}

/**
 * Exact Multi-Wing Planar CSG Upper-Envelope Roof Builder + Pure Crease-Only Line Extractor!
 * Produces a 100% watertight, non-overlapping multi-wing roof with ZERO internal crisscross lines.
 */
function buildExactMultiWingPlanarRoof(
  fullFootprint: Vec2[],
  wings: ExtractedOrthoWing[],
  baseY: number,
  pitchDeg: number,
  isGable: boolean,
  uvBounds: { minX: number; maxX: number; minZ: number; maxZ: number }
): {
  roofGeo: THREE.BufferGeometry;
  creaseGeo: THREE.BufferGeometry;
  gableWallGeo: THREE.BufferGeometry | null;
  peakY: number;
} {
  const tanP = Math.tan((pitchDeg * Math.PI) / 180);

  type PlanarFace = {
    poly: Vec2[];
    ax: number; // height above baseY = ax*x + az*z + c0
    az: number;
    c0: number;
  };

  // 1. Build exact planar faces for each wing
  const wingFacesList: PlanarFace[][] = [];
  const wingSlopePlanesList: { ax: number; az: number; c0: number }[][] = [];
  const gableEndSegments: { a: Vec2; b: Vec2; wingIdx: number }[] = [];

  wings.forEach((wing, wIdx) => {
    const wPoly = wing.polyWorld;
    const planes = computeConvexInwardPlanes(wPoly);
    const isEdgeGable = [false, false, false, false];

    if (isGable) {
      const len0 = Math.hypot(wPoly[1].x - wPoly[0].x, wPoly[1].z - wPoly[0].z);
      const len1 = Math.hypot(wPoly[2].x - wPoly[1].x, wPoly[2].z - wPoly[1].z);
      // Gable ends are the shorter pair of edges ONLY where they lie on the outer building perimeter!
      if (len0 <= len1) {
        isEdgeGable[0] = wing.outerEdgeFlags[0];
        isEdgeGable[2] = wing.outerEdgeFlags[2];
      } else {
        isEdgeGable[1] = wing.outerEdgeFlags[1];
        isEdgeGable[3] = wing.outerEdgeFlags[3];
      }
    }

    const faces: PlanarFace[] = [];
    const slopePlanes: { ax: number; az: number; c0: number }[] = [];

    for (let i = 0; i < 4; i++) {
      if (isEdgeGable[i]) {
        gableEndSegments.push({ a: wPoly[i], b: wPoly[(i + 1) % 4], wingIdx: wIdx });
        continue;
      }
      const pi = planes[i];
      const ax = pi.nx * tanP;
      const az = pi.nz * tanP;
      const c0 = pi.c * tanP;
      slopePlanes.push({ ax, az, c0 });

      let cell = wPoly.slice();
      for (let j = 0; j < 4; j++) {
        if (j === i || isEdgeGable[j]) continue;
        const pj = planes[j];
        cell = dedupPoly2D(
          clipPolygonHalfPlane(cell, pj.nx - pi.nx, pj.nz - pi.nz, pj.c - pi.c)
        );
        if (cell.length < 3) break;
      }
      if (cell.length >= 3 && Math.abs(signedAreaNorthUp(cell)) > 1e-4) {
        if (signedAreaNorthUp(cell) < 0) cell.reverse();
        faces.push({ poly: cell, ax, az, c0 });
      }
    }

    wingFacesList.push(faces);
    wingSlopePlanesList.push(slopePlanes);
  });

  // 2. Exact CSG Upper-Envelope across all wings (zero hidden overlap, zero coplanar duplicates)
  const finalPieces: PlanarFace[] = [];

  for (let k = 0; k < wingFacesList.length; k++) {
    for (const fk of wingFacesList[k]) {
      let fragments: Vec2[][] = [fk.poly];

      for (let j = 0; j < wingFacesList.length; j++) {
        if (j === k) continue;
        for (const fj of wingFacesList[j]) {
          const { outside, inside } = partitionConvexAgainstConvex(fragments, fj.poly);
          const keptInside: Vec2[][] = [];
          const dax = fk.ax - fj.ax;
          const daz = fk.az - fj.az;
          const dc0 = fk.c0 - fj.c0;

          if (Math.abs(dax) < 1e-5 && Math.abs(daz) < 1e-5 && Math.abs(dc0) < 1e-4) {
            // Identical coplanar corner slope: tie-break cleanly to wing k < j!
            if (k < j) keptInside.push(...inside);
          } else {
            for (const ins of inside) {
              const vis = dedupPoly2D(clipPolygonHalfPlane(ins, dax, daz, dc0));
              if (vis.length >= 3 && Math.abs(signedAreaNorthUp(vis)) > 1e-4) {
                keptInside.push(vis);
              }
            }
          }

          fragments = [...outside, ...keptInside];
          if (fragments.length === 0) break;
        }
        if (fragments.length === 0) break;
      }

      for (const frag of fragments) {
        if (signedAreaNorthUp(frag) < 0) frag.reverse();
        finalPieces.push({ poly: frag, ax: fk.ax, az: fk.az, c0: fk.c0 });
      }
    }
  }

  // 3. Build Unified Roof Mesh + Soffit Cap
  const positions: number[] = [];
  const uvs: number[] = [];
  const spanX = Math.max(0.1, uvBounds.maxX - uvBounds.minX);
  const spanZ = Math.max(0.1, uvBounds.maxZ - uvBounds.minZ);
  let peakY = baseY + 0.5;

  const pushTri = (
    p0: { x: number; y: number; z: number },
    p1: { x: number; y: number; z: number },
    p2: { x: number; y: number; z: number }
  ) => {
    positions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
    for (const v of [p0, p1, p2]) {
      if (v.y > peakY) peakY = v.y;
      uvs.push((v.x - uvBounds.minX) / spanX, 1 - (v.z - uvBounds.minZ) / spanZ);
    }
  };

  for (const piece of finalPieces) {
    const lifted = piece.poly.map((p) => ({
      x: p.x,
      y: baseY + Math.max(0, piece.ax * p.x + piece.az * p.z + piece.c0),
      z: p.z,
    }));
    for (let t = 1; t < lifted.length - 1; t++) {
      pushTri(lifted[0], lifted[t], lifted[t + 1]);
    }
  }

  // Watertight soffit underside
  const soffitContour = fullFootprint.map((p) => new THREE.Vector2(p.x, -p.z));
  const soffitTris = THREE.ShapeUtils.triangulateShape(soffitContour, []);
  for (const [i0, i1, i2] of soffitTris) {
    const a = fullFootprint[i0];
    const b = fullFootprint[i1];
    const c = fullFootprint[i2];
    pushTri(
      { x: a.x, y: baseY, z: a.z },
      { x: c.x, y: baseY, z: c.z },
      { x: b.x, y: baseY, z: b.z }
    );
  }

  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  roofGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  roofGeo.computeVertexNormals();

  // 4. Optional Outer Gable End Wall Triangles
  let gableWallGeo: THREE.BufferGeometry | null = null;
  if (gableEndSegments.length > 0) {
    const gPos: number[] = [];
    for (const seg of gableEndSegments) {
      const steps = 16;
      const samples: { x: number; y: number; z: number }[] = [];
      const slopes = wingSlopePlanesList[seg.wingIdx];
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = seg.a.x + t * (seg.b.x - seg.a.x);
        const pz = seg.a.z + t * (seg.b.z - seg.a.z);
        let minH = Infinity;
        for (const sp of slopes) {
          const h = sp.ax * px + sp.az * pz + sp.c0;
          if (h < minH) minH = h;
        }
        samples.push({
          x: px,
          y: baseY + Math.max(0, Number.isFinite(minH) ? minH : 0),
          z: pz,
        });
      }
      for (let s = 0; s < steps; s++) {
        const s0 = samples[s];
        const s1 = samples[s + 1];
        if (s0.y <= baseY + 1e-4 && s1.y <= baseY + 1e-4) continue;
        gPos.push(s0.x, baseY, s0.z, s1.x, baseY, s1.z, s1.x, s1.y, s1.z);
        gPos.push(s0.x, baseY, s0.z, s1.x, s1.y, s1.z, s0.x, s0.y, s0.z);
      }
    }
    if (gPos.length > 0) {
      gableWallGeo = new THREE.BufferGeometry();
      gableWallGeo.setAttribute('position', new THREE.Float32BufferAttribute(gPos, 3));
      gableWallGeo.computeVertexNormals();
    }
  }

  // 5. Pure Analytical Crease-Only Line Extractor (ONLY True Eaves, Ridges, Hips, & Valleys!)
  const evalEnvelopePlaneAt = (px: number, pz: number): { ax: number; az: number; h: number } | null => {
    let bestH = -Infinity;
    let bestPlane: { ax: number; az: number; h: number } | null = null;
    for (let wIdx = 0; wIdx < wings.length; wIdx++) {
      if (!pointInPolyXZ(px, pz, wings[wIdx].polyWorld)) continue;
      const slopes = wingSlopePlanesList[wIdx];
      if (slopes.length === 0) continue;
      let minWingH = Infinity;
      let minSlope = slopes[0];
      for (const sp of slopes) {
        const h = sp.ax * px + sp.az * pz + sp.c0;
        if (h < minWingH) {
          minWingH = h;
          minSlope = sp;
        }
      }
      if (minWingH > bestH + 1e-5) {
        bestH = minWingH;
        bestPlane = { ax: minSlope.ax, az: minSlope.az, h: Math.max(0, minWingH) };
      }
    }
    return bestPlane;
  };

  // Collect all unique 2D vertices to split T-junctions cleanly
  const allVerts: Vec2[] = [];
  for (const piece of finalPieces) {
    for (const v of piece.poly) {
      if (!allVerts.some((u) => Math.hypot(v.x - u.x, v.z - u.z) < 1e-3)) {
        allVerts.push(v);
      }
    }
  }

  const linePositions: number[] = [];
  const seenSegs = new Set<string>();

  for (const piece of finalPieces) {
    const m = piece.poly.length;
    for (let i = 0; i < m; i++) {
      const A = piece.poly[i];
      const B = piece.poly[(i + 1) % m];
      const dx = B.x - A.x;
      const dz = B.z - A.z;
      const L = Math.hypot(dx, dz);
      if (L < 1e-3) continue;

      const ts = [0, 1];
      for (const V of allVerts) {
        const t = ((V.x - A.x) * dx + (V.z - A.z) * dz) / (L * L);
        if (t > 1e-3 && t < 1 - 1e-3) {
          const px = A.x + t * dx;
          const pz = A.z + t * dz;
          if (Math.hypot(V.x - px, V.z - pz) < 2e-3) {
            ts.push(t);
          }
        }
      }
      ts.sort((a, b) => a - b);

      const nx = -dz / L;
      const nz = dx / L;
      const eps = 0.02;

      for (let sIdx = 0; sIdx < ts.length - 1; sIdx++) {
        const t0 = ts[sIdx];
        const t1 = ts[sIdx + 1];
        if ((t1 - t0) * L < 5e-3) continue;

        const p0x = A.x + t0 * dx;
        const p0z = A.z + t0 * dz;
        const p1x = A.x + t1 * dx;
        const p1z = A.z + t1 * dz;

        const k0 = `${p0x.toFixed(2)},${p0z.toFixed(2)}`;
        const k1 = `${p1x.toFixed(2)},${p1z.toFixed(2)}`;
        const segKey = k0 < k1 ? `${k0}_${k1}` : `${k1}_${k0}`;
        if (seenSegs.has(segKey)) continue;
        seenSegs.add(segKey);

        const mx = 0.5 * (p0x + p1x);
        const mz = 0.5 * (p0z + p1z);
        const leftP = evalEnvelopePlaneAt(mx + eps * nx, mz + eps * nz);
        const rightP = evalEnvelopePlaneAt(mx - eps * nx, mz - eps * nz);

        const isOuterEave = (leftP === null) !== (rightP === null);
        const isSlopeCrease =
          leftP !== null &&
          rightP !== null &&
          Math.abs(leftP.ax - rightP.ax) + Math.abs(leftP.az - rightP.az) > 1e-3;

        if (isOuterEave || isSlopeCrease) {
          const y0 = baseY + Math.max(0, piece.ax * p0x + piece.az * p0z + piece.c0) + 0.004;
          const y1 = baseY + Math.max(0, piece.ax * p1x + piece.az * p1z + piece.c0) + 0.004;
          linePositions.push(p0x, y0, p0z, p1x, y1, p1z);
        }
      }
    }
  }

  const creaseGeo = new THREE.BufferGeometry();
  creaseGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));

  return { roofGeo, creaseGeo, gableWallGeo, peakY };
}

function distToSegment(px: number, pz: number, a: Vec2, b: Vec2): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const wx = px - a.x;
  const wz = pz - a.z;
  const c1 = vx * wx + vz * wz;
  if (c1 <= 0) return Math.hypot(px - a.x, pz - a.z);
  const c2 = vx * vx + vz * vz;
  if (c2 <= c1) return Math.hypot(px - b.x, pz - b.z);
  const t = c1 / c2;
  return Math.hypot(px - (a.x + t * vx), pz - (a.z + t * vz));
}

function minBoundaryDist(px: number, pz: number, poly: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = distToSegment(px, pz, poly[i], poly[(i + 1) % poly.length]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Universal fallback pitched roof builder for non-orthogonal concave polygons.
 * Uses adaptive fine triangulation strictly clipped inside `poly` so ANY roof outline succeeds cleanly.
 */
function buildArbitraryConcavePitchedRoof(
  poly: Vec2[],
  baseY: number,
  pitchDeg: number,
  uvBounds: { minX: number; maxX: number; minZ: number; maxZ: number }
): THREE.BufferGeometry {
  const tanP = Math.tan((pitchDeg * Math.PI) / 180);
  const bounds = getBounds2D(poly);
  const step = Math.max(0.35, Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 26);

  // Build Delaunay / Bowyer-Watson over boundary subdivisions + interior grid
  const pts: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const divs = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < divs; k++) {
      const t = k / divs;
      pts.push({ x: a.x + t * (b.x - a.x), z: a.z + t * (b.z - a.z) });
    }
  }

  for (let x = bounds.minX + step * 0.5; x < bounds.maxX; x += step) {
    for (let z = bounds.minZ + step * 0.5; z < bounds.maxZ; z += step) {
      if (pointInPolyXZ(x, z, poly) && minBoundaryDist(x, z, poly) > step * 0.35) {
        pts.push({ x, z });
      }
    }
  }

  const tris = bowyerWatson2D(pts);
  const positions: number[] = [];
  const uvs: number[] = [];
  const spanX = Math.max(0.1, uvBounds.maxX - uvBounds.minX);
  const spanZ = Math.max(0.1, uvBounds.maxZ - uvBounds.minZ);

  for (const [i0, i1, i2] of tris) {
    const p0 = pts[i0];
    const p1 = pts[i1];
    const p2 = pts[i2];
    const cx = (p0.x + p1.x + p2.x) / 3;
    const cz = (p0.z + p1.z + p2.z) / 3;
    if (!pointInPolyXZ(cx, cz, poly)) continue;

    // Ensure CCW in North-Up (x, -z) -> upward +Y normal
    const cross = (p1.x - p0.x) * -(p2.z - p0.z) - -(p1.z - p0.z) * (p2.x - p0.x);
    const ordered = cross >= 0 ? [p0, p1, p2] : [p0, p2, p1];

    for (const v of ordered) {
      const d = minBoundaryDist(v.x, v.z, poly);
      const y = baseY + (d < 0.04 ? 0 : d * tanP);
      positions.push(v.x, y, v.z);
      uvs.push((v.x - uvBounds.minX) / spanX, 1 - (v.z - uvBounds.minZ) / spanZ);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

function bowyerWatson2D(pts: Vec2[]): [number, number, number][] {
  if (pts.length < 3) return [];
  const b = getBounds2D(pts);
  const dmax = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 10 + 100;
  const mx = 0.5 * (b.minX + b.maxX);
  const mz = 0.5 * (b.minZ + b.maxZ);

  const all = [
    ...pts,
    { x: mx - 2 * dmax, z: mz - dmax },
    { x: mx, z: mz + 2 * dmax },
    { x: mx + 2 * dmax, z: mz - dmax },
  ];
  const s0 = pts.length;
  let triangles: [number, number, number][] = [[s0, s0 + 1, s0 + 2]];

  for (let i = 0; i < pts.length; i++) {
    const p = all[i];
    const bad: [number, number, number][] = [];
    for (const tri of triangles) {
      if (inCircumcircle(p, all[tri[0]], all[tri[1]], all[tri[2]])) {
        bad.push(tri);
      }
    }

    const edgeCount = new Map<string, [number, number, number]>();
    for (const tri of bad) {
      const edges: [number, number][] = [
        [tri[0], tri[1]],
        [tri[1], tri[2]],
        [tri[2], tri[0]],
      ];
      for (const [u, v] of edges) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        const prev = edgeCount.get(key);
        if (prev) {
          prev[2]++;
        } else {
          edgeCount.set(key, [u, v, 1]);
        }
      }
    }

    const badSet = new Set(bad);
    triangles = triangles.filter((t) => !badSet.has(t));
    for (const [u, v, count] of edgeCount.values()) {
      if (count === 1) {
        triangles.push([u, v, i]);
      }
    }
  }

  return triangles.filter((t) => t[0] < s0 && t[1] < s0 && t[2] < s0);
}

function inCircumcircle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const ax = a.x - p.x,
    az = a.z - p.z;
  const bx = b.x - p.x,
    bz = b.z - p.z;
  const cx = c.x - p.x,
    cz = c.z - p.z;
  const det =
    (ax * ax + az * az) * (bx * cz - cx * bz) -
    (bx * bx + bz * bz) * (ax * cz - cx * az) +
    (cx * cx + cz * cz) * (ax * bz - bx * az);
  const orient = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  return orient > 0 ? det > 1e-10 : det < -1e-10;
}

/**
 * Builds a mono-pitch Shed roof + clean sloped wall extension up to the shed plane.
 */
function buildShedRoofMeshes(
  roofPoly: Vec2[],
  wallPoly: Vec2[],
  eaveBaseY: number,
  pitchDeg: number,
  slopeAngleRad: number,
  uvBounds: { minX: number; maxX: number; minZ: number; maxZ: number }
): { slabGeo: THREE.BufferGeometry; clerestoryWallGeo: THREE.BufferGeometry } {
  const nx = Math.cos(slopeAngleRad);
  const nz = Math.sin(slopeAngleRad);
  let minProj = Infinity;
  for (const p of roofPoly) {
    const proj = p.x * nx + p.z * nz;
    if (proj < minProj) minProj = proj;
  }
  const tanP = Math.tan((Math.max(8, Math.min(18, pitchDeg)) * Math.PI) / 180);
  const heightAt = (x: number, z: number) => eaveBaseY + Math.max(0, (x * nx + z * nz - minProj) * tanP);

  // Triangulate roofPoly using THREE.ShapeUtils
  const contour = roofPoly.map((p) => new THREE.Vector2(p.x, -p.z));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  const roofThickness = 0.18;

  const pos: number[] = [];
  const uvs: number[] = [];
  const spanX = Math.max(0.1, uvBounds.maxX - uvBounds.minX);
  const spanZ = Math.max(0.1, uvBounds.maxZ - uvBounds.minZ);

  const pushTri = (
    p0: { x: number; y: number; z: number },
    p1: { x: number; y: number; z: number },
    p2: { x: number; y: number; z: number }
  ) => {
    pos.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
    for (const v of [p0, p1, p2]) {
      uvs.push((v.x - uvBounds.minX) / spanX, 1 - (v.z - uvBounds.minZ) / spanZ);
    }
  };

  // Top & bottom sloped slab
  for (const [i0, i1, i2] of faces) {
    const a = roofPoly[i0],
      b = roofPoly[i1],
      c = roofPoly[i2];
    pushTri(
      { x: a.x, y: heightAt(a.x, a.z) + roofThickness, z: a.z },
      { x: b.x, y: heightAt(b.x, b.z) + roofThickness, z: b.z },
      { x: c.x, y: heightAt(c.x, c.z) + roofThickness, z: c.z }
    );
    pushTri(
      { x: a.x, y: heightAt(a.x, a.z), z: a.z },
      { x: c.x, y: heightAt(c.x, c.z), z: c.z },
      { x: b.x, y: heightAt(b.x, b.z), z: b.z }
    );
  }

  // Sloped fascia perimeter
  for (let i = 0; i < roofPoly.length; i++) {
    const a = roofPoly[i];
    const b = roofPoly[(i + 1) % roofPoly.length];
    const ha = heightAt(a.x, a.z);
    const hb = heightAt(b.x, b.z);
    pushTri({ x: a.x, y: ha, z: a.z }, { x: b.x, y: hb, z: b.z }, { x: b.x, y: hb + roofThickness, z: b.z });
    pushTri({ x: a.x, y: ha, z: a.z }, { x: b.x, y: hb + roofThickness, z: b.z }, { x: a.x, y: ha + roofThickness, z: a.z });
  }

  const slabGeo = new THREE.BufferGeometry();
  slabGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  slabGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  slabGeo.computeVertexNormals();

  // Clerestory wall infill from eaveBaseY up to shed underside along wallPoly
  const wPos: number[] = [];
  for (let i = 0; i < wallPoly.length; i++) {
    const a = wallPoly[i];
    const b = wallPoly[(i + 1) % wallPoly.length];
    const ha = heightAt(a.x, a.z);
    const hb = heightAt(b.x, b.z);
    wPos.push(a.x, eaveBaseY, a.z, b.x, eaveBaseY, b.z, b.x, hb, b.z);
    wPos.push(a.x, eaveBaseY, a.z, b.x, hb, b.z, a.x, ha, a.z);
  }
  const clerestoryWallGeo = new THREE.BufferGeometry();
  clerestoryWallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
  clerestoryWallGeo.computeVertexNormals();

  return { slabGeo, clerestoryWallGeo };
}

/**
 * Main Three.js House Prototype Assembly Builder.
 * Produces a clean, windowless, architecturally proportioned 3D massing model with crisp CAD edges.
 */
export function buildHouseModelGroup(
  spec: HouseSpec,
  metrics: HouseMetrics,
  finish: ModelFinish,
  satelliteTexture?: THREE.Texture | null
): { group: THREE.Group; totalHeightM: number } {
  const group = new THREE.Group();
  group.name = 'SriLankaHousePrototype';

  const roofPoly = metrics.vertices2D;
  if (roofPoly.length < 3) {
    return { group, totalHeightM: 3.5 };
  }

  const palette = getPaletteForFinish(finish, spec.detectedMaterialHint);
  const uvBounds = getBounds2D(roofPoly);

  const plinthHeight = 0.24;
  const wallHeight = spec.wallHeightM;
  const eaveBaseY = plinthHeight + wallHeight;

  // Wall footprint inset cleanly inside roof overhang
  const wallInset = spec.roofStyle === 'flat' ? -0.04 : -spec.eaveOverhangM;
  const wallPoly = offsetPolygon2D(roofPoly, wallInset);
  const plinthPoly = offsetPolygon2D(wallPoly, 0.18);

  const plinthMat = new THREE.MeshStandardMaterial({
    color: palette.plinth,
    roughness: 0.9,
    metalness: 0.05,
  });

  const wallMat = new THREE.MeshStandardMaterial({
    color: palette.wall,
    roughness: 0.85,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const fasciaMat = new THREE.MeshStandardMaterial({
    color: palette.fascia,
    roughness: 0.85,
    metalness: 0.05,
  });

  const useSatTex = finish === 'satellite' && Boolean(satelliteTexture);
  const roofMat = new THREE.MeshStandardMaterial({
    color: palette.roof,
    map: useSatTex ? satelliteTexture! : null,
    roughness: useSatTex ? 0.78 : 0.72,
    metalness: 0.04,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const edgeMat = new THREE.LineBasicMaterial({
    color: palette.edge,
    transparent: true,
    opacity: finish === 'blueprint' ? 0.95 : 0.88,
  });

  const addMeshWithEdges = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    thresholdDeg = 14,
    castShadow = true
  ) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    group.add(mesh);

    const edgesGeo = new THREE.EdgesGeometry(geo, thresholdDeg);
    const lines = new THREE.LineSegments(edgesGeo, edgeMat);
    group.add(lines);
  };

  // 1. Stepped Foundation Plinth
  const plinthGeo = createExtrudedPrism(plinthPoly, plinthHeight, 0);
  addMeshWithEdges(plinthGeo, plinthMat, 15, true);

  // 2. Clean Windowless Architectural Wall Mass
  const wallGeo = createExtrudedPrism(wallPoly, wallHeight, plinthHeight);
  addMeshWithEdges(wallGeo, wallMat, 15, true);

  // Subtle floor-slab architectural reveal line for multi-story houses (no windows, pure scale cue)
  if (spec.stories > 1) {
    const slabLineMat = new THREE.LineBasicMaterial({
      color: palette.slabLine,
      transparent: true,
      opacity: 0.45,
    });
    for (let f = 1; f < spec.stories; f++) {
      const y = plinthHeight + (wallHeight / spec.stories) * f;
      const loopPts = wallPoly.map((p) => new THREE.Vector3(p.x * 1.002, y, p.z * 1.002));
      loopPts.push(loopPts[0].clone());
      const loopGeo = new THREE.BufferGeometry().setFromPoints(loopPts);
      group.add(new THREE.Line(loopGeo, slabLineMat));
    }
  }

  let peakHeightY = eaveBaseY + 0.5;

  // 3. Roof Massing by Style
  if (spec.roofStyle === 'flat') {
    // Modern Sri Lankan Box-Model Parapet Roof:
    // Recessed flat terrace slab + crisp outer parapet wall coping
    const parapetH = 0.68;
    const deckH = 0.22;

    // Inner recessed roof deck with UV projection for satellite mode
    const deckGeo = buildConvexOrConcaveFlatCap(roofPoly, eaveBaseY + deckH, uvBounds);
    const deckMesh = new THREE.Mesh(deckGeo, roofMat);
    deckMesh.receiveShadow = true;
    group.add(deckMesh);

    // Outer parapet ring (difference between roofPoly and inset Poly)
    const innerParapet = offsetPolygon2D(roofPoly, -0.28);
    if (innerParapet !== roofPoly && Math.abs(signedAreaNorthUp(innerParapet)) > 1.2) {
      const parapetShape = new THREE.Shape();
      parapetShape.moveTo(roofPoly[0].x, -roofPoly[0].z);
      for (let i = 1; i < roofPoly.length; i++) parapetShape.lineTo(roofPoly[i].x, -roofPoly[i].z);
      parapetShape.closePath();

      const holePath = new THREE.Path();
      // Hole must have opposite winding (CW in x, -z)
      for (let i = innerParapet.length - 1; i >= 0; i--) {
        if (i === innerParapet.length - 1) holePath.moveTo(innerParapet[i].x, -innerParapet[i].z);
        else holePath.lineTo(innerParapet[i].x, -innerParapet[i].z);
      }
      holePath.closePath();
      parapetShape.holes.push(holePath);

      const parapetGeo = new THREE.ExtrudeGeometry(parapetShape, {
        depth: parapetH,
        bevelEnabled: false,
        steps: 1,
      });
      parapetGeo.rotateX(-Math.PI / 2);
      parapetGeo.translate(0, eaveBaseY, 0);
      parapetGeo.computeVertexNormals();
      addMeshWithEdges(parapetGeo, wallMat, 15, true);

      // Crisp dark coping rim on top of parapet
      const copingGeo = new THREE.ExtrudeGeometry(parapetShape, {
        depth: 0.07,
        bevelEnabled: false,
        steps: 1,
      });
      copingGeo.rotateX(-Math.PI / 2);
      copingGeo.translate(0, eaveBaseY + parapetH, 0);
      copingGeo.computeVertexNormals();
      addMeshWithEdges(copingGeo, fasciaMat, 15, true);
    } else {
      const slabGeo = createExtrudedPrism(roofPoly, 0.32, eaveBaseY);
      addMeshWithEdges(slabGeo, wallMat, 15, true);
    }

    peakHeightY = eaveBaseY + parapetH + 0.07;
  } else if (spec.roofStyle === 'shed') {
    const shedSlopeAngle =
      spec.shedSlopeAngleRad !== undefined
        ? spec.shedSlopeAngleRad
        : metrics.dominantAngleRad + Math.PI / 2;
    const { slabGeo, clerestoryWallGeo } = buildShedRoofMeshes(
      roofPoly,
      wallPoly,
      eaveBaseY,
      spec.roofPitchDeg || 11,
      shedSlopeAngle,
      uvBounds
    );
    addMeshWithEdges(clerestoryWallGeo, wallMat, 15, true);
    addMeshWithEdges(slabGeo, roofMat, 12, true);
    slabGeo.computeBoundingBox();
    peakHeightY = slabGeo.boundingBox ? slabGeo.boundingBox.max.y : eaveBaseY + 1.5;
  } else {
    // HIP or GABLE pitched roof
    const fasciaH = 0.16;
    const fasciaGeo = createExtrudedPrism(roofPoly, fasciaH, eaveBaseY);
    addMeshWithEdges(fasciaGeo, fasciaMat, 15, true);

    const roofStart = eaveBaseY + fasciaH;
    const pitch = Math.max(12, Math.min(38, spec.roofPitchDeg || 23));
    const gableAngle =
      spec.roofStyle === 'gable'
        ? spec.ridgeAngleRad !== undefined
          ? spec.ridgeAngleRad
          : metrics.dominantAngleRad
        : null;

    if (isConvexPolygonCCW(roofPoly)) {
      const roofGeo = buildConvexPlanarRoofGeometry(
        roofPoly,
        roofStart,
        pitch,
        gableAngle,
        uvBounds
      );
      addMeshWithEdges(roofGeo, roofMat, 6, true);
      roofGeo.computeBoundingBox();
      peakHeightY = roofGeo.boundingBox ? roofGeo.boundingBox.max.y : roofStart + 2.0;
    } else {
      // Concave polygon (L-shape, T-shape, U-shape, stepped multi-wing footprint):
      // Build exact unified CSG Upper-Envelope roof with pure analytical crease-only lines!
      const orthoWings = extractMaximalOrthoWings(roofPoly, metrics.dominantAngleRad);
      if (orthoWings && orthoWings.length > 0) {
        const { roofGeo, creaseGeo, gableWallGeo, peakY } = buildExactMultiWingPlanarRoof(
          roofPoly,
          orthoWings,
          roofStart,
          pitch,
          spec.roofStyle === 'gable',
          uvBounds
        );

        const roofMesh = new THREE.Mesh(roofGeo, roofMat);
        roofMesh.castShadow = true;
        roofMesh.receiveShadow = true;
        group.add(roofMesh);

        group.add(new THREE.LineSegments(creaseGeo, edgeMat));

        if (gableWallGeo) {
          addMeshWithEdges(gableWallGeo, wallMat, 15, true);
        }

        peakHeightY = peakY;
      } else {
        const roofGeo = buildArbitraryConcavePitchedRoof(roofPoly, roofStart, pitch, uvBounds);
        addMeshWithEdges(roofGeo, roofMat, 12, true);
        roofGeo.computeBoundingBox();
        peakHeightY = roofGeo.boundingBox ? roofGeo.boundingBox.max.y : roofStart + 2.0;
      }
    }
  }

  return { group, totalHeightM: peakHeightY };
}

function buildConvexOrConcaveFlatCap(
  poly: Vec2[],
  y: number,
  uvBounds: { minX: number; maxX: number; minZ: number; maxZ: number }
): THREE.BufferGeometry {
  const contour = poly.map((p) => new THREE.Vector2(p.x, -p.z));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  const pos: number[] = [];
  const uvs: number[] = [];
  const spanX = Math.max(0.1, uvBounds.maxX - uvBounds.minX);
  const spanZ = Math.max(0.1, uvBounds.maxZ - uvBounds.minZ);

  for (const [i0, i1, i2] of faces) {
    for (const idx of [i0, i1, i2]) {
      const p = poly[idx];
      pos.push(p.x, y, p.z);
      uvs.push((p.x - uvBounds.minX) / spanX, 1 - (p.z - uvBounds.minZ) / spanZ);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}
