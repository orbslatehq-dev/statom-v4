import * as THREE from 'three';
import { HouseMetrics, HouseSpec } from '../types';
import { ConnectionPhase, SOLAR_CONFIG, SolarSystemConfig } from './solarConfig';
import {
  RoofSectionSim,
  SolarSimulationResult,
  Vec2,
  distPointToSegment2D,
  interpolateSectionSampleKwhM2,
  isPointInSection2D,
  section2DToWorld,
} from './solarSimEngine';

export interface CandidatePanelSlot {
  slotIndex: number; // 0-based rank after best-first sort
  sectionId: string;
  sectionLabel: string;
  isFlatRack: boolean;
  rackTiltDeg: number;
  orientation: 'portrait' | 'landscape';
  uCenter: number;
  vCenter: number;
  uSpanM: number; // Width along section.uAxis
  vSpanM: number; // Length along section.vAxis
  rowIndex: number;
  colIndex: number;
  worldCenterOnRoof: THREE.Vector3;
  panelCenterWorld: THREE.Vector3;
  panelUAxis: THREE.Vector3; // Short or long axis in world space
  panelVAxis: THREE.Vector3; // Tilted upslope axis in world space
  panelNormal: THREE.Vector3;
  heightJitterM: number; // +-2.5 mm realistic installation tolerance
  annualPoaKwhM2: number;
  annualAcKwh: number; // Single-panel Year-1 AC output (kWh/yr)
  shadeFactor: number;
  monthlyAcKwh: number[]; // 12 monthly AC kWh values for this slot
  hourlyAcKwByMonth: number[][]; // 12 x 24 typical-day AC kW output for this slot
}

export interface SolarLayoutPlan {
  allCandidateSlots: CandidatePanelSlot[]; // Ranked best-first across entire roof
  maxRoofPanels: number;
  usableSectionsCount: number;
}

export interface PersistedSolarDesignState {
  houseKey: string;
  monthlyConsumptionKwh: number;
  monthlyBillInputLkr: string;
  phase: ConnectionPhase;
  panelCount: number;
  hasDesigned: boolean;
  hasAC?: boolean;
  plansEV?: boolean;
  intakeNotes?: string;
  updatedAtIso: string;
}

/**
 * Generates a deterministic storage key for a specific traced house footprint + roof geometry.
 */
export function getHouseSolarStorageKey(spec: HouseSpec, metrics: HouseMetrics): string {
  const c0 = metrics.centroid[0].toFixed(5);
  const c1 = metrics.centroid[1].toFixed(5);
  const area = Math.round(metrics.areaSqm);
  return `rm_solar_v1_${c1}_${c0}_${area}_${spec.roofStyle}_${Math.round(spec.roofPitchDeg)}_${spec.stories}`;
}

export function loadPersistedSolarDesign(houseKey: string): PersistedSolarDesignState | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(houseKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSolarDesignState;
    if (
      typeof parsed.monthlyConsumptionKwh === 'number' &&
      typeof parsed.panelCount === 'number'
    ) {
      return parsed;
    }
  } catch {
    // ignore corrupt entry
  }
  return null;
}

export function savePersistedSolarDesign(state: PersistedSolarDesignState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(state.houseKey, JSON.stringify(state));
  } catch {
    // ignore storage quota errors
  }
}

function deterministicJitter(seedA: number, seedB: number): number {
  const x = Math.sin(seedA * 127.1 + seedB * 311.7) * 43758.5453;
  const frac = x - Math.floor(x);
  return (frac - 0.5) * 0.005; // -2.5 mm .. +2.5 mm
}

/**
 * Validates that a candidate 2D panel footprint [uCenter +- uSpan/2, vCenter +- vSpan/2]
 * lies strictly inside the roof section AND maintains >= setbackM clearance from every exterior edge.
 */
function isPanelFootprintValid(
  section: RoofSectionSim,
  uCenter: number,
  vCenter: number,
  uSpan: number,
  vSpan: number,
  setbackM: number
): boolean {
  const hu = 0.5 * uSpan;
  const hv = 0.5 * vSpan;

  if (
    uCenter - hu < section.uMin + setbackM - 0.01 ||
    uCenter + hu > section.uMax - setbackM + 0.01 ||
    vCenter - hv < section.vMin + setbackM - 0.01 ||
    vCenter + hv > section.vMax - setbackM + 0.01
  ) {
    return false;
  }

  // Test 9 interior/perimeter sample points for exact polygon containment (handles concave L/U roofs)
  const checkPts: Vec2[] = [
    { u: uCenter - hu, v: vCenter - hv },
    { u: uCenter + hu, v: vCenter - hv },
    { u: uCenter + hu, v: vCenter + hv },
    { u: uCenter - hu, v: vCenter + hv },
    { u: uCenter, v: vCenter - hv },
    { u: uCenter + hu, v: vCenter },
    { u: uCenter, v: vCenter + hv },
    { u: uCenter - hu, v: vCenter },
    { u: uCenter, v: vCenter },
  ];

  for (let i = 0; i < checkPts.length; i++) {
    if (!isPointInSection2D(section, checkPts[i], 1e-4)) {
      return false;
    }
  }

  // Enforce >= setbackM distance from all exterior boundary segments (eaves, ridges, hips, valleys, parapets)
  const perimeterPts: Vec2[] = [
    ...checkPts.slice(0, 8),
    { u: uCenter - 0.5 * hu, v: vCenter - hv },
    { u: uCenter + 0.5 * hu, v: vCenter - hv },
    { u: uCenter - 0.5 * hu, v: vCenter + hv },
    { u: uCenter + 0.5 * hu, v: vCenter + hv },
    { u: uCenter - hu, v: vCenter - 0.5 * hv },
    { u: uCenter - hu, v: vCenter + 0.5 * hv },
    { u: uCenter + hu, v: vCenter - 0.5 * hv },
    { u: uCenter + hu, v: vCenter + 0.5 * hv },
  ];

  const minAllowed = Math.max(0.05, setbackM - 0.004);
  for (let s = 0; s < section.boundarySegments2D.length; s++) {
    const seg = section.boundarySegments2D[s];
    for (let p = 0; p < perimeterPts.length; p++) {
      if (distPointToSegment2D(perimeterPts[p], seg) < minAllowed) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Packs JA Solar 550W panels onto each qualifying roof section, scores every slot using
 * simulated raycast irradiance, and ranks all slots best-first across the entire roof.
 */
export function buildBestFirstSolarLayout(
  sim: SolarSimulationResult,
  config: SolarSystemConfig = SOLAR_CONFIG
): SolarLayoutPlan {
  const { lengthM, widthM, interPanelGapM, perimeterSetbackM, watts, pitchedStandoffM } =
    config.panel;
  const pr = config.performance.performanceRatio;
  const kwPerPanel = watts / 1000;

  // Filter sections above minimum irradiance threshold; fallback to all if whole roof is heavily shaded
  const qualifying = sim.sections.filter(
    (s) => s.panelPlaneAnnualKwhM2 >= config.panel.minSectionIrradianceKwhM2Yr
  );
  const targetSections = qualifying.length > 0 ? qualifying : sim.sections;

  const rawSlots: CandidatePanelSlot[] = [];

  for (let sIdx = 0; sIdx < targetSections.length; sIdx++) {
    const sec = targetSections[sIdx];

    // Test both Portrait (1.134m along uAxis x 2.278m along vAxis) and Landscape (2.278m x 1.134m)
    const orientations: {
      mode: 'portrait' | 'landscape';
      uSpan: number;
      vSpan: number;
    }[] = [
      { mode: 'portrait', uSpan: widthM, vSpan: lengthM },
      { mode: 'landscape', uSpan: lengthM, vSpan: widthM },
    ];

    let bestGrid: {
      mode: 'portrait' | 'landscape';
      uSpan: number;
      vSpan: number;
      cells: { u: number; v: number; row: number; col: number }[];
    } | null = null;

    for (const ori of orientations) {
      // On 10°-tilted flat racks, add 0.34m row-to-row pitch spacing to avoid inter-row shading
      const extraRowSpacing = sec.isFlat && sec.optimalRackTiltDeg >= 5 ? 0.34 : 0;
      const stepU = ori.uSpan + interPanelGapM;
      const stepV = ori.vSpan + interPanelGapM + extraRowSpacing;

      // Test several grid phase alignments so arrays center cleanly on symmetric & asymmetric facets
      const uCenterBase = 0.5 * (sec.uMin + sec.uMax);
      const vCenterBase = 0.5 * (sec.vMin + sec.vMax);
      const phaseShifts = [-0.33, -0.16, 0, 0.16, 0.33];

      for (const pu of phaseShifts) {
        for (const pv of phaseShifts) {
          const anchorU = uCenterBase + pu * stepU;
          const anchorV = vCenterBase + pv * stepV;

          const minCol = Math.floor((sec.uMin - anchorU) / stepU) - 1;
          const maxCol = Math.ceil((sec.uMax - anchorU) / stepU) + 1;
          const minRow = Math.floor((sec.vMin - anchorV) / stepV) - 1;
          const maxRow = Math.ceil((sec.vMax - anchorV) / stepV) + 1;

          const validCells: { u: number; v: number; row: number; col: number }[] = [];
          for (let r = maxRow; r >= minRow; r--) {
            // Top-down (ridge toward eave) row ordering
            for (let c = minCol; c <= maxCol; c++) {
              const u = anchorU + c * stepU;
              const v = anchorV + r * stepV;
              if (isPanelFootprintValid(sec, u, v, ori.uSpan, ori.vSpan, perimeterSetbackM)) {
                validCells.push({ u, v, row: maxRow - r, col: c - minCol });
              }
            }
          }

          const effectiveScore =
            validCells.length * (ori.mode === 'portrait' ? 1.02 : 1.0);
          const prevScore = bestGrid
            ? bestGrid.cells.length * (bestGrid.mode === 'portrait' ? 1.02 : 1.0)
            : -1;

          if (validCells.length > 0 && effectiveScore > prevScore) {
            bestGrid = {
              mode: ori.mode,
              uSpan: ori.uSpan,
              vSpan: ori.vSpan,
              cells: validCells,
            };
          }
        }
      }
    }

    if (!bestGrid || bestGrid.cells.length === 0) continue;

    // Build exact 3D panel orientation vectors for this section
    const panelNormal = sec.effectivePanelNormal.clone().normalize();
    const panelUAxis = sec.uAxis.clone().normalize();
    const panelVAxis = new THREE.Vector3().crossVectors(panelNormal, panelUAxis).normalize();

    for (let i = 0; i < bestGrid.cells.length; i++) {
      const cell = bestGrid.cells[i];
      const interp = interpolateSectionSampleKwhM2(sec, cell.u, cell.v);
      const jitterM = deterministicJitter(sIdx * 97 + cell.row, cell.col * 53 + i);

      // Standoff height: 10 cm parallel rail on pitched roofs; ~20 cm rack center height on tilted flat roofs
      const baseStandoff =
        sec.isFlat && sec.optimalRackTiltDeg > 0
          ? 0.12 + 0.5 * bestGrid.vSpan * Math.sin((sec.optimalRackTiltDeg * Math.PI) / 180)
          : pitchedStandoffM;

      const worldCenterOnRoof = section2DToWorld(sec, cell.u, cell.v, 0);
      const panelCenterWorld = section2DToWorld(
        sec,
        cell.u,
        cell.v,
        baseStandoff + jitterM
      );

      const monthlyAcKwh = interp.monthlyKwhM2.map((poa) => poa * kwPerPanel * pr);
      const annualAcKwh = monthlyAcKwh.reduce((a, b) => a + b, 0);
      const hourlyAcKwByMonth = interp.hourlyPoaKwM2ByMonth.map((row) =>
        row.map((poaKw) => poaKw * kwPerPanel * pr)
      );

      rawSlots.push({
        slotIndex: 0,
        sectionId: sec.id,
        sectionLabel: sec.label,
        isFlatRack: sec.isFlat && sec.optimalRackTiltDeg > 0,
        rackTiltDeg: sec.isFlat ? sec.optimalRackTiltDeg : Math.round(sec.pitchDeg),
        orientation: bestGrid.mode,
        uCenter: cell.u,
        vCenter: cell.v,
        uSpanM: bestGrid.uSpan,
        vSpanM: bestGrid.vSpan,
        rowIndex: cell.row,
        colIndex: cell.col,
        worldCenterOnRoof,
        panelCenterWorld,
        panelUAxis,
        panelVAxis,
        panelNormal,
        heightJitterM: jitterM,
        annualPoaKwhM2: interp.annualKwhM2,
        annualAcKwh,
        shadeFactor: interp.shadeFactor,
        monthlyAcKwh,
        hourlyAcKwByMonth,
      });
    }
  }

  // Sort best-first across the whole roof!
  // Within 8 kWh/yr (~1% yield) on the same section, preserve contiguous row/col order so arrays fill neatly!
  rawSlots.sort((a, b) => {
    if (a.sectionId === b.sectionId && Math.abs(b.annualAcKwh - a.annualAcKwh) < 8) {
      if (a.rowIndex !== b.rowIndex) return a.rowIndex - b.rowIndex;
      return a.colIndex - b.colIndex;
    }
    return b.annualAcKwh - a.annualAcKwh;
  });

  rawSlots.forEach((slot, idx) => {
    slot.slotIndex = idx;
  });

  const usableSectionIds = new Set(rawSlots.map((s) => s.sectionId));

  return {
    allCandidateSlots: rawSlots,
    maxRoofPanels: rawSlots.length,
    usableSectionsCount: usableSectionIds.size,
  };
}

/**
 * Generates a high-contrast procedural monocrystalline half-cut PV cell texture (no external image load).
 */
function createMonocrystallineCellTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Deep anti-reflective silicon base
  const grad = ctx.createLinearGradient(0, 0, 256, 512);
  grad.addColorStop(0, '#09162e');
  grad.addColorStop(0.5, '#0e2347');
  grad.addColorStop(1, '#081329');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 512);

  const cols = 6;
  const rows = 12; // 72-cell / 144 half-cut module layout
  const pad = 6;
  const cellW = (256 - pad * 2) / cols;
  const cellH = (512 - pad * 2) / rows;

  // Subtle white backsheet grid lines between cells
  ctx.strokeStyle = 'rgba(205, 220, 242, 0.42)';
  ctx.lineWidth = 1.4;
  for (let c = 0; c <= cols; c++) {
    const x = pad + c * cellW;
    ctx.beginPath();
    ctx.moveTo(x, pad);
    ctx.lineTo(x, 512 - pad);
    ctx.stroke();
  }
  for (let r = 0; r <= rows; r++) {
    const y = pad + r * cellH;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(256 - pad, y);
    ctx.stroke();
  }

  // Center half-cut busbar split line
  ctx.strokeStyle = 'rgba(226, 236, 250, 0.65)';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(pad, 256);
  ctx.lineTo(256 - pad, 256);
  ctx.stroke();

  // Fine multi-busbar silver filaments inside each cell column
  ctx.strokeStyle = 'rgba(160, 188, 224, 0.18)';
  ctx.lineWidth = 0.8;
  for (let c = 0; c < cols; c++) {
    for (let b = 1; b <= 3; b++) {
      const x = pad + c * cellW + (b * cellW) / 4;
      ctx.beginPath();
      ctx.moveTo(x, pad);
      ctx.lineTo(x, 512 - pad);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Locates a clean exterior vertical wall point on houseGroup near targetPos for mounting
 * the string inverter box and routing the DC/AC conduit pipe.
 */
function findExteriorWallMountSite(
  houseGroup: THREE.Group,
  preferredTarget: THREE.Vector3
): {
  wallPoint: THREE.Vector3;
  wallOutwardNormal: THREE.Vector3;
  eaveDropPoint: THREE.Vector3;
} {
  houseGroup.updateMatrixWorld(true);

  let bestScore = Infinity;
  let bestWallPt = new THREE.Vector3(preferredTarget.x, 1.55, preferredTarget.z + 2.5);
  let bestNormal = new THREE.Vector3(0, 0, 1);
  let bestTopY = Math.max(2.8, preferredTarget.y - 0.2);

  houseGroup.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    if (!pos) return;
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
      if (area < 1.2) continue;

      const n = cross.normalize();
      if (Math.abs(n.y) > 0.12) continue; // Strictly vertical walls

      const minY = Math.min(a.y, b.y, c.y);
      const maxY = Math.max(a.y, b.y, c.y);
      if (minY > 0.8 || maxY < 2.2) continue; // Ground-floor exterior wall span

      const mid = new THREE.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3);
      const mountPt = new THREE.Vector3(mid.x, 1.55, mid.z);

      // Ensure normal faces away from house center (origin ~0,0,0)
      const outward = n.clone();
      if (outward.dot(new THREE.Vector3(mid.x, 0, mid.z)) < 0) {
        outward.negate();
      }

      const dHoriz = Math.hypot(mountPt.x - preferredTarget.x, mountPt.z - preferredTarget.z);
      if (dHoriz < bestScore) {
        bestScore = dHoriz;
        bestWallPt = mountPt;
        bestNormal = outward;
        bestTopY = maxY;
      }
    }
  });

  const eaveDropPoint = bestWallPt
    .clone()
    .setY(bestTopY + 0.08)
    .addScaledVector(bestNormal, 0.24);

  return {
    wallPoint: bestWallPt,
    wallOutwardNormal: bestNormal,
    eaveDropPoint,
  };
}

/**
 * Builds the complete add-on 3D solar installation Group:
 * - Active 550W monocrystalline PV modules with anodized frames, mounting rails/tilted racks & shadows
 * - Exterior wall-mounted string inverter enclosure with heatsink & status LED
 * - Rigid conduit tube connecting the array down the exterior wall to the inverter
 */
export function buildSolarHardwareGroup(params: {
  activeSlots: CandidatePanelSlot[];
  houseGroup: THREE.Group;
  config?: SolarSystemConfig;
}): THREE.Group {
  const { activeSlots, houseGroup, config = SOLAR_CONFIG } = params;
  const group = new THREE.Group();
  group.name = 'solar-hardware-addon';

  if (activeSlots.length === 0) return group;

  const cellTexture = createMonocrystallineCellTexture();

  const frameMat = new THREE.MeshStandardMaterial({
    color: 0xd4dae2,
    metalness: 0.72,
    roughness: 0.3,
  });

  const backsheetMat = new THREE.MeshStandardMaterial({
    color: 0xe9edf2,
    metalness: 0.1,
    roughness: 0.7,
  });

  const cellTopMat = new THREE.MeshStandardMaterial({
    color: cellTexture ? 0xffffff : 0x0c1e3e,
    ...(cellTexture ? { map: cellTexture } : {}),
    metalness: 0.36,
    roughness: 0.16,
  });

  const railMat = new THREE.MeshStandardMaterial({
    color: 0x8a939e,
    metalness: 0.68,
    roughness: 0.42,
  });

  const thick = config.panel.thicknessM; // 0.030 m

  for (let i = 0; i < activeSlots.length; i++) {
    const slot = activeSlots[i];
    const moduleGroup = new THREE.Group();

    // Build orthonormal basis matrix [panelUAxis, panelNormal, -panelVAxis] so BoxGeometry Y is panelNormal
    const xAxis = slot.panelUAxis.clone().normalize();
    const yAxis = slot.panelNormal.clone().normalize();
    const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();

    const rotMatrix = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
    moduleGroup.position.copy(slot.panelCenterWorld);
    moduleGroup.quaternion.setFromRotationMatrix(rotMatrix);

    // 6-face BoxGeometry materials: [+X, -X, +Y (solar cell top), -Y (backsheet), +Z, -Z]
    const panelGeo = new THREE.BoxGeometry(slot.uSpanM, thick, slot.vSpanM);
    const panelMesh = new THREE.Mesh(panelGeo, [
      frameMat,
      frameMat,
      cellTopMat,
      backsheetMat,
      frameMat,
      frameMat,
    ]);
    panelMesh.castShadow = true;
    panelMesh.receiveShadow = true;
    moduleGroup.add(panelMesh);

    // Crisp raised perimeter bezel lip (4 mm) for realistic architectural frame definition
    const rimThickness = 0.024;
    const longBarGeo = new THREE.BoxGeometry(rimThickness, 0.004, slot.vSpanM);
    const shortBarGeo = new THREE.BoxGeometry(slot.uSpanM, 0.004, rimThickness);

    const leftRim = new THREE.Mesh(longBarGeo, frameMat);
    leftRim.position.set(-slot.uSpanM * 0.5 + rimThickness * 0.5, thick * 0.5 + 0.002, 0);
    const rightRim = new THREE.Mesh(longBarGeo, frameMat);
    rightRim.position.set(slot.uSpanM * 0.5 - rimThickness * 0.5, thick * 0.5 + 0.002, 0);
    const topRim = new THREE.Mesh(shortBarGeo, frameMat);
    topRim.position.set(0, thick * 0.5 + 0.002, -slot.vSpanM * 0.5 + rimThickness * 0.5);
    const botRim = new THREE.Mesh(shortBarGeo, frameMat);
    botRim.position.set(0, thick * 0.5 + 0.002, slot.vSpanM * 0.5 - rimThickness * 0.5);

    moduleGroup.add(leftRim, rightRim, topRim, botRim);

    // Under-panel aluminum mounting rails / flat-roof triangle rack legs
    const railGeo = new THREE.BoxGeometry(slot.uSpanM * 0.96, 0.028, 0.035);
    const railA = new THREE.Mesh(railGeo, railMat);
    railA.position.set(0, -thick * 0.5 - 0.016, -slot.vSpanM * 0.28);
    railA.castShadow = true;
    const railB = new THREE.Mesh(railGeo, railMat);
    railB.position.set(0, -thick * 0.5 - 0.016, slot.vSpanM * 0.28);
    railB.castShadow = true;
    moduleGroup.add(railA, railB);

    if (slot.isFlatRack) {
      // Rear & front vertical strut legs down to flat concrete deck
      for (const uSign of [-0.36, 0.36]) {
        const rearLegGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.28, 8);
        const rearLeg = new THREE.Mesh(rearLegGeo, railMat);
        rearLeg.position.set(slot.uSpanM * uSign, -0.15, -slot.vSpanM * 0.32);
        rearLeg.castShadow = true;

        const frontLegGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.12, 8);
        const frontLeg = new THREE.Mesh(frontLegGeo, railMat);
        frontLeg.position.set(slot.uSpanM * uSign, -0.07, slot.vSpanM * 0.32);
        frontLeg.castShadow = true;

        moduleGroup.add(rearLeg, frontLeg);
      }
    }

    group.add(moduleGroup);
  }

  // Mount Wall Inverter Box + Conduit Pipe anchored near the primary solar array
  const leadSlot = activeSlots[0];
  const mount = findExteriorWallMountSite(houseGroup, leadSlot.panelCenterWorld);

  const invGroup = new THREE.Group();
  const wallTangent = new THREE.Vector3()
    .crossVectors(new THREE.Vector3(0, 1, 0), mount.wallOutwardNormal)
    .normalize();
  const invBasis = new THREE.Matrix4().makeBasis(
    wallTangent,
    new THREE.Vector3(0, 1, 0),
    mount.wallOutwardNormal
  );
  invGroup.position
    .copy(mount.wallPoint)
    .addScaledVector(mount.wallOutwardNormal, 0.095);
  invGroup.quaternion.setFromRotationMatrix(invBasis);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xf2f4f7,
    roughness: 0.38,
    metalness: 0.18,
  });
  const darkAccentMat = new THREE.MeshStandardMaterial({
    color: 0x1b2028,
    roughness: 0.5,
    metalness: 0.4,
  });
  const ledMat = new THREE.MeshBasicMaterial({ color: 0x76ff03 });

  const invBody = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.56, 0.18), bodyMat);
  invBody.castShadow = true;
  invBody.receiveShadow = true;

  const invScreen = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.015), darkAccentMat);
  invScreen.position.set(0, 0.08, 0.092);

  const invLed = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.016, 0.018), ledMat);
  invLed.position.set(0, 0.18, 0.093);

  const invBase = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.09, 0.16), darkAccentMat);
  invBase.position.set(0, -0.31, 0);

  invGroup.add(invBody, invScreen, invLed, invBase);
  group.add(invGroup);

  // Smooth galvanized conduit run from array -> eave overhang -> wall drop -> inverter top
  const arrayExit = leadSlot.worldCenterOnRoof
    .clone()
    .addScaledVector(leadSlot.panelNormal, 0.06);
  const midRoof = arrayExit.clone().lerp(mount.eaveDropPoint, 0.65);
  midRoof.y = Math.max(arrayExit.y - 0.15, mount.eaveDropPoint.y + 0.08);
  const wallTopEntry = mount.wallPoint
    .clone()
    .setY(mount.eaveDropPoint.y - 0.12)
    .addScaledVector(mount.wallOutwardNormal, 0.045);
  const invTopEntry = mount.wallPoint
    .clone()
    .setY(mount.wallPoint.y + 0.28)
    .addScaledVector(mount.wallOutwardNormal, 0.055);

  const conduitCurve = new THREE.CatmullRomCurve3(
    [arrayExit, midRoof, mount.eaveDropPoint, wallTopEntry, invTopEntry],
    false,
    'catmullrom',
    0.18
  );
  const conduitGeo = new THREE.TubeGeometry(conduitCurve, 28, 0.018, 8, false);
  const conduitMat = new THREE.MeshStandardMaterial({
    color: 0x5c6470,
    metalness: 0.62,
    roughness: 0.38,
  });
  const conduitMesh = new THREE.Mesh(conduitGeo, conduitMat);
  conduitMesh.castShadow = true;
  group.add(conduitMesh);

  return group;
}
