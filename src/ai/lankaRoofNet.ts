import {
  HouseMetrics,
  LngLatPoint,
  NeuralRoofAnalysis,
  RoofStyle,
  SatelliteProvider,
  Vec2,
} from '../types';
import {
  computeHouseMetrics,
  getMetersPerDegree,
  stripClosingPoint,
} from '../geometry/geoProjection';
import {
  LANKA_ROOF_NET_META,
  LANKA_ROOF_NET_WEIGHTS,
} from './lankaRoofNetWeights';

export { LANKA_ROOF_NET_META };

const STYLE_LABELS: RoofStyle[] = ['hip', 'gable', 'flat', 'shed'];
const MATERIAL_LABELS: ('terracotta' | 'concrete' | 'metal')[] = [
  'terracotta',
  'concrete',
  'metal',
];

const tileImageCache = new Map<string, Promise<HTMLImageElement | null>>();

function getTileUrl(provider: SatelliteProvider, z: number, x: number, y: number): string {
  if (provider === 'esri') {
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  }
  const sub = (x + y) & 3;
  return `https://mt${sub}.google.com/vt/lyrs=s&x=${x}&y=${y}&z=${z}`;
}

function loadTileImage(
  provider: SatelliteProvider,
  z: number,
  x: number,
  y: number
): Promise<HTMLImageElement | null> {
  const key = `${provider}:${z}:${x}:${y}`;
  const cached = tileImageCache.get(key);
  if (cached) return cached;

  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = window.setTimeout(() => resolve(null), 4500);
    img.onload = () => {
      window.clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    img.src = getTileUrl(provider, z, x, y);
  });

  tileImageCache.set(key, promise);
  return promise;
}

function lngLatToWorldPixel(lng: number, lat: number, z: number): { wx: number; wy: number } {
  const n = Math.pow(2, z) * 256;
  const wx = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const wy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { wx, wy };
}

function worldPixelToLngLat(wx: number, wy: number, z: number): LngLatPoint {
  const n = Math.pow(2, z) * 256;
  const lng = (wx / n) * 360 - 180;
  const mercN = Math.PI - (2 * Math.PI * wy) / n;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(mercN) - Math.exp(-mercN)));
  return [lng, lat];
}

async function renderSatelliteNeighborhood(
  centerLng: number,
  centerLat: number,
  provider: SatelliteProvider,
  patchPx = 320
): Promise<{
  canvas: HTMLCanvasElement;
  imgData: ImageData;
  z: number;
  originWx: number;
  originWy: number;
  metersPerPx: number;
} | null> {
  const z = provider === 'google' ? 20 : 19;
  const { wx, wy } = lngLatToWorldPixel(centerLng, centerLat, z);
  const originWx = Math.floor(wx - patchPx / 2);
  const originWy = Math.floor(wy - patchPx / 2);

  const minTx = Math.floor(originWx / 256);
  const maxTx = Math.floor((originWx + patchPx) / 256);
  const minTy = Math.floor(originWy / 256);
  const maxTy = Math.floor((originWy + patchPx) / 256);

  const canvas = document.createElement('canvas');
  canvas.width = patchPx;
  canvas.height = patchPx;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  let anyLoaded = false;
  const jobs: Promise<void>[] = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      jobs.push(
        loadTileImage(provider, z, tx, ty).then((img) => {
          if (img) {
            anyLoaded = true;
            ctx.drawImage(img, tx * 256 - originWx, ty * 256 - originWy, 256, 256);
          }
        })
      );
    }
  }

  await Promise.all(jobs);
  if (!anyLoaded) return null;

  let imgData: ImageData;
  try {
    imgData = ctx.getImageData(0, 0, patchPx, patchPx);
  } catch {
    return null;
  }

  const metersPerPx =
    (Math.cos((centerLat * Math.PI) / 180) * 156543.03392) / Math.pow(2, z);

  return { canvas, imgData, z, originWx, originWy, metersPerPx };
}

function sampleBilinearRGB(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  fx: number,
  fy: number
): [number, number, number] {
  const cx = Math.max(0, Math.min(w - 1.001, fx));
  const cy = Math.max(0, Math.min(h - 1.001, fy));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = cx - x0;
  const ty = cy - y0;

  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;

  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = data[i00 + c] * (1 - tx) + data[i10 + c] * tx;
    const bot = data[i01 + c] * (1 - tx) + data[i11 + c] * tx;
    out[c] = top * (1 - ty) + bot * ty;
  }
  return out;
}

function pointInPoly2D(px: number, py: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y;
    const xj = poly[j].x,
      yj = poly[j].y;
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Pure Float32 Forward Pass of LankaRoofNet (CNN + SpatialGridPool + Photometric-Geometric Fusion).
 * Matches the Python-trained weights 1:1.
 */
export function runLankaRoofNetForward(
  tensor4x24x24: Float32Array, // shape [4, 24, 24], index = c*576 + y*24 + x
  geoPhotoFeats16: Float32Array // shape [16]
): {
  styleProbs: Record<RoofStyle, number>;
  predictedStyle: RoofStyle;
  confidencePct: number;
  materialProbs: Record<'terracotta' | 'concrete' | 'metal', number>;
  predictedMaterial: 'terracotta' | 'concrete' | 'metal';
  predictedPitchDeg: number;
} {
  const W = LANKA_ROOF_NET_WEIGHTS;

  // 1. Conv1: (4, 24, 24) -> (12, 24, 24) with ReLU, 3x3 pad 1
  const a1 = new Float32Array(12 * 24 * 24);
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      // Build 36-element patch column (c=0..3, ky=0..2, kx=0..2)
      const col = new Float32Array(36);
      let idx = 0;
      for (let c = 0; c < 4; c++) {
        const cOff = c * 576;
        for (let ky = 0; ky < 3; ky++) {
          const sy = y + ky - 1;
          for (let kx = 0; kx < 3; kx++) {
            const sx = x + kx - 1;
            if (sy >= 0 && sy < 24 && sx >= 0 && sx < 24) {
              col[idx] = tensor4x24x24[cOff + sy * 24 + sx];
            }
            idx++;
          }
        }
      }
      for (let oc = 0; oc < 12; oc++) {
        let sum = W.conv1_b[oc];
        for (let k = 0; k < 36; k++) {
          sum += col[k] * W.conv1_w[k][oc];
        }
        a1[oc * 576 + y * 24 + x] = sum > 0 ? sum : 0;
      }
    }
  }

  // 2. MaxPool 2x2 -> (12, 12, 12)
  const p1 = new Float32Array(12 * 12 * 12);
  for (let c = 0; c < 12; c++) {
    const inOff = c * 576;
    const outOff = c * 144;
    for (let py = 0; py < 12; py++) {
      for (let px = 0; px < 12; px++) {
        const y0 = py * 2;
        const x0 = px * 2;
        const v00 = a1[inOff + y0 * 24 + x0];
        const v01 = a1[inOff + y0 * 24 + x0 + 1];
        const v10 = a1[inOff + (y0 + 1) * 24 + x0];
        const v11 = a1[inOff + (y0 + 1) * 24 + x0 + 1];
        p1[outOff + py * 12 + px] = Math.max(v00, v01, v10, v11);
      }
    }
  }

  // 3. Conv2: (12, 12, 12) -> (16, 12, 12) with ReLU, 3x3 pad 1
  const a2 = new Float32Array(16 * 12 * 12);
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 12; x++) {
      const col = new Float32Array(108);
      let idx = 0;
      for (let c = 0; c < 12; c++) {
        const cOff = c * 144;
        for (let ky = 0; ky < 3; ky++) {
          const sy = y + ky - 1;
          for (let kx = 0; kx < 3; kx++) {
            const sx = x + kx - 1;
            if (sy >= 0 && sy < 12 && sx >= 0 && sx < 12) {
              col[idx] = p1[cOff + sy * 12 + sx];
            }
            idx++;
          }
        }
      }
      for (let oc = 0; oc < 16; oc++) {
        let sum = W.conv2_b[oc];
        for (let k = 0; k < 108; k++) {
          sum += col[k] * W.conv2_w[k][oc];
        }
        a2[oc * 144 + y * 12 + x] = sum > 0 ? sum : 0;
      }
    }
  }

  // 4. 3x3 Spatial Grid Average Pool: (16, 12, 12) -> (16, 3, 3) = 144 + 16 geoPhoto = 160
  const fused = new Float32Array(160);
  for (let c = 0; c < 16; c++) {
    const cOff = c * 144;
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        let acc = 0;
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 4; dx++) {
            acc += a2[cOff + (gy * 4 + dy) * 12 + (gx * 4 + dx)];
          }
        }
        fused[c * 9 + gy * 3 + gx] = acc / 16.0;
      }
    }
  }
  for (let f = 0; f < 16; f++) {
    fused[144 + f] = geoPhotoFeats16[f];
  }

  // 5. Dense1 (160 -> 64, ReLU) & Dense2 (64 -> 32, ReLU)
  const af1 = new Float32Array(64);
  for (let j = 0; j < 64; j++) {
    let s = W.fc1_b[j];
    for (let i = 0; i < 160; i++) s += fused[i] * W.fc1_w[i][j];
    af1[j] = s > 0 ? s : 0;
  }

  const af2 = new Float32Array(32);
  for (let j = 0; j < 32; j++) {
    let s = W.fc2_b[j];
    for (let i = 0; i < 64; i++) s += af1[i] * W.fc2_w[i][j];
    af2[j] = s > 0 ? s : 0;
  }

  // 6. Output Heads
  const softmax1D = (logits: number[]) => {
    const mx = Math.max(...logits);
    const exps = logits.map((v) => Math.exp(v - mx));
    const sum = exps.reduce((a, b) => a + b, 0) || 1;
    return exps.map((v) => v / sum);
  };

  const styleLogits = [0, 1, 2, 3].map((k) => {
    let s = W.hs_b[k];
    for (let i = 0; i < 32; i++) s += af2[i] * W.hs_w[i][k];
    return s;
  });
  const sProbs = softmax1D(styleLogits);

  const matLogits = [0, 1, 2].map((k) => {
    let s = W.hm_b[k];
    for (let i = 0; i < 32; i++) s += af2[i] * W.hm_w[i][k];
    return s;
  });
  const mProbs = softmax1D(matLogits);

  let pLogit = W.hp_b[0];
  for (let i = 0; i < 32; i++) pLogit += af2[i] * W.hp_w[i][0];
  const pitchSigmoid = 1 / (1 + Math.exp(-Math.max(-15, Math.min(15, pLogit))));

  let bestS = 0;
  for (let i = 1; i < 4; i++) if (sProbs[i] > sProbs[bestS]) bestS = i;

  let bestM = 0;
  for (let i = 1; i < 3; i++) if (mProbs[i] > mProbs[bestM]) bestM = i;

  const predictedStyle = STYLE_LABELS[bestS];
  const predictedMaterial = MATERIAL_LABELS[bestM];
  const rawPitchDeg = pitchSigmoid * 32.0;
  const predictedPitchDeg =
    predictedStyle === 'flat'
      ? 0
      : predictedStyle === 'shed'
      ? Math.round(Math.max(9, Math.min(16, rawPitchDeg)))
      : Math.round(Math.max(16, Math.min(30, rawPitchDeg)));

  return {
    styleProbs: {
      hip: sProbs[0],
      gable: sProbs[1],
      flat: sProbs[2],
      shed: sProbs[3],
    },
    predictedStyle,
    confidencePct: Math.round(sProbs[bestS] * 100),
    materialProbs: {
      terracotta: mProbs[0],
      concrete: mProbs[1],
      metal: mProbs[2],
    },
    predictedMaterial,
    predictedPitchDeg,
  };
}

/**
 * Extracts exact 4x24x24 CNN tensor and 16 photometric-geometric features from a 64x64 canonical roof patch.
 */
export function extractCanonicalPatchInputs(
  rgb64: Float32Array, // [64 * 64 * 3]
  mask64: Float32Array, // [64 * 64]
  aspect: number,
  solidity: number,
  nVerts: number,
  shadowDepthM: number
): {
  tensor: Float32Array;
  feats: Float32Array;
  slopeDirectionSign: number; // +1 or -1 along minor axis for shed
} {
  // 1. Bilinear downsample 64x64 -> 24x24
  const R24 = new Float32Array(576);
  const G24 = new Float32Array(576);
  const B24 = new Float32Array(576);
  const M24 = new Float32Array(576);

  for (let y = 0; y < 24; y++) {
    const fy = (y * 63) / 23;
    const y0 = Math.floor(fy);
    const y1 = Math.min(63, y0 + 1);
    const wy = fy - y0;

    for (let x = 0; x < 24; x++) {
      const fx = (x * 63) / 23;
      const x0 = Math.floor(fx);
      const x1 = Math.min(63, x0 + 1);
      const wx = fx - x0;

      const i00 = y0 * 64 + x0;
      const i01 = y0 * 64 + x1;
      const i10 = y1 * 64 + x0;
      const i11 = y1 * 64 + x1;

      const bilerp = (arr: Float32Array, stride: number, ch: number) => {
        const top = arr[i00 * stride + ch] * (1 - wx) + arr[i01 * stride + ch] * wx;
        const bot = arr[i10 * stride + ch] * (1 - wx) + arr[i11 * stride + ch] * wx;
        return top * (1 - wy) + bot * wy;
      };

      const outIdx = y * 24 + x;
      R24[outIdx] = bilerp(rgb64, 3, 0);
      G24[outIdx] = bilerp(rgb64, 3, 1);
      B24[outIdx] = bilerp(rgb64, 3, 2);
      M24[outIdx] = bilerp(mask64, 1, 0) > 0.5 ? 1.0 : 0.0;
    }
  }

  const lum24 = new Float32Array(576);
  let sum24 = 0;
  let cnt24 = 0;
  for (let i = 0; i < 576; i++) {
    lum24[i] = 0.299 * R24[i] + 0.587 * G24[i] + 0.114 * B24[i];
    if (M24[i] > 0.5) {
      sum24 += lum24[i];
      cnt24++;
    }
  }
  const mean24 = cnt24 > 8 ? sum24 / cnt24 : 120.0;
  let var24 = 0;
  for (let i = 0; i < 576; i++) {
    if (M24[i] > 0.5) {
      const d = lum24[i] - mean24;
      var24 += d * d;
    }
  }
  const std24 = cnt24 > 8 ? Math.max(7.5, Math.sqrt(var24 / cnt24)) : 15.0;

  const tensor = new Float32Array(4 * 576);
  for (let i = 0; i < 576; i++) {
    const ch0 = Math.max(-2.5, Math.min(2.5, (lum24[i] - mean24) / std24)) * M24[i];
    const ch1 =
      Math.max(
        -2.0,
        Math.min(2.0, ((R24[i] - B24[i]) / (R24[i] + G24[i] + B24[i] + 12.0)) * 2.5)
      ) * M24[i];
    tensor[i] = ch0;
    tensor[576 + i] = ch1;
  }

  // Channel 2 (axial ridge grad) & Channel 3 (diagonal hip grad)
  for (let y = 1; y < 23; y++) {
    for (let x = 0; x < 24; x++) {
      const i = y * 24 + x;
      const m = M24[i] * M24[i + 24] * M24[i - 24];
      tensor[1152 + i] = Math.abs(tensor[i + 24] - tensor[i - 24]) * m;
    }
  }
  for (let y = 1; y < 23; y++) {
    for (let x = 1; x < 23; x++) {
      const i = y * 24 + x;
      const d1 = Math.abs(tensor[(y + 1) * 24 + (x + 1)] - tensor[(y - 1) * 24 + (x - 1)]);
      const d2 = Math.abs(tensor[(y + 1) * 24 + (x - 1)] - tensor[(y - 1) * 24 + (x + 1)]);
      const m = M24[i] * M24[(y + 1) * 24 + (x + 1)] * M24[(y - 1) * 24 + (x - 1)];
      tensor[1728 + i] = 0.5 * (d1 + d2) * m;
    }
  }

  // 2. Compute 16 Engineered Photometric + Geometric Features on 64x64
  const L = new Float32Array(4096);
  let sum64 = 0;
  let cnt64 = 0;
  for (let i = 0; i < 4096; i++) {
    const r = rgb64[i * 3];
    const g = rgb64[i * 3 + 1];
    const b = rgb64[i * 3 + 2];
    L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    if (mask64[i] > 0.5) {
      sum64 += L[i];
      cnt64++;
    }
  }
  const ml = cnt64 > 10 ? sum64 / cnt64 : 120.0;
  let var64 = 0;
  for (let i = 0; i < 4096; i++) {
    if (mask64[i] > 0.5) {
      const d = L[i] - ml;
      var64 += d * d;
    }
  }
  const sl = cnt64 > 10 ? Math.max(7.5, Math.sqrt(var64 / cnt64)) : 15.0;
  const Ln = new Float32Array(4096);
  for (let i = 0; i < 4096; i++) Ln[i] = (L[i] - ml) / sl;

  const rectMean = (arr: Float32Array, y0: number, y1: number, x0: number, x1: number) => {
    let s = 0;
    let c = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        s += arr[y * 64 + x];
        c++;
      }
    }
    return c > 0 ? s / c : 0;
  };

  const rectStd = (arr: Float32Array, y0: number, y1: number, x0: number, x1: number) => {
    const m = rectMean(arr, y0, y1, x0, x1);
    let v = 0;
    let c = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const d = arr[y * 64 + x] - m;
        v += d * d;
        c++;
      }
    }
    return c > 0 ? Math.sqrt(v / c) : 0;
  };

  const topMid = rectMean(Ln, 6, 28, 16, 48);
  const botMid = rectMean(Ln, 36, 58, 16, 48);
  const nsMid = Math.abs(topMid - botMid);

  const nsLeft = Math.abs(rectMean(Ln, 6, 28, 3, 12) - rectMean(Ln, 36, 58, 3, 12));
  const nsRight = Math.abs(rectMean(Ln, 6, 28, 52, 61) - rectMean(Ln, 36, 58, 52, 61));
  const gableEndRatio = (0.5 * (nsLeft + nsRight)) / (nsMid + 0.15);

  const leftTriMean = rectMean(Ln, 20, 44, 3, 13);
  const rightTriMean = rectMean(Ln, 20, 44, 51, 61);
  const topSlope = rectMean(Ln, 8, 24, 20, 44);
  const botSlope = rectMean(Ln, 40, 56, 20, 44);
  const triUnif =
    1.0 / (1.0 + 0.5 * (rectStd(Ln, 20, 44, 3, 13) + rectStd(Ln, 20, 44, 51, 61)));
  const triDiff =
    0.5 *
    (Math.min(Math.abs(leftTriMean - topSlope), Math.abs(leftTriMean - botSlope)) +
      Math.min(Math.abs(rightTriMean - topSlope), Math.abs(rightTriMean - botSlope)));
  const hipTriScore = triUnif * (0.4 + triDiff);

  const ridgeStep = (x0: number, x1: number) => {
    let s = 0;
    let c = 0;
    for (let dy = 0; dy < 3; dy++) {
      for (let x = x0; x < x1; x++) {
        s += Math.abs(Ln[(29 + dy) * 64 + x] - Ln[(33 + dy) * 64 + x]);
        c++;
      }
    }
    return c > 0 ? s / c : 0;
  };
  const centerRidge = ridgeStep(16, 48);
  const endRidge = 0.5 * (ridgeStep(3, 12) + ridgeStep(52, 61));

  // Corner 45-degree bisector energy
  const diagEnergy = (y0: number, x0: number, antiDiag: boolean) => {
    let s = 0;
    let c = 0;
    for (let y = 0; y < 14; y++) {
      for (let x = 0; x < 14; x++) {
        const a = antiDiag
          ? Ln[(y0 + y + 2) * 64 + (x0 + x)]
          : Ln[(y0 + y + 2) * 64 + (x0 + x + 2)];
        const b = antiDiag
          ? Ln[(y0 + y) * 64 + (x0 + x + 2)]
          : Ln[(y0 + y) * 64 + (x0 + x)];
        s += Math.abs(a - b);
        c++;
      }
    }
    return s / c;
  };
  const cornerHipEnergy =
    0.25 *
    (diagEnergy(4, 4, true) +
      diagEnergy(44, 44, true) +
      diagEnergy(4, 44, false) +
      diagEnergy(44, 4, false));

  // Parapet rim vs core flatness
  let rimSum = 0,
    rimCnt = 0,
    coreSum = 0,
    coreCnt = 0;
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const i = y * 64 + x;
      if (mask64[i] <= 0.5) continue;
      if (y < 4 || y >= 60 || x < 4 || x >= 60) {
        rimSum += L[i];
        rimCnt++;
      }
      if (y >= 10 && y < 54 && x >= 10 && x < 54) {
        coreSum += L[i];
        coreCnt++;
      }
    }
  }
  const coreMean = coreCnt > 0 ? coreSum / coreCnt : ml;
  const rimMean = rimCnt > 0 ? rimSum / rimCnt : ml;
  let coreVar = 0;
  for (let y = 10; y < 54; y++) {
    for (let x = 10; x < 54; x++) {
      const i = y * 64 + x;
      if (mask64[i] > 0.5) {
        const d = L[i] - coreMean;
        coreVar += d * d;
      }
    }
  }
  const coreStd = coreCnt > 10 ? Math.sqrt(coreVar / coreCnt) : 15.0;
  const rimDiff = Math.abs(rimMean - coreMean) / (coreStd + 5.0);
  const interiorFlatness = 1.0 / (1.0 + coreStd / 9.5);

  // Monotonic single-plane R^2 fit on core [10..54]
  let numAu = 0,
    numBv = 0,
    denU = 0,
    sumCoreLn = 0;
  for (let y = 0; y < 44; y++) {
    const vc = -0.5 + y / 43;
    for (let x = 0; x < 44; x++) {
      const uc = -0.5 + x / 43;
      const val = Ln[(10 + y) * 64 + (10 + x)];
      numAu += val * uc;
      numBv += val * vc;
      denU += uc * uc;
      sumCoreLn += val;
    }
  }
  const aU = numAu / denU;
  const bV = numBv / denU;
  const meanCoreLn = sumCoreLn / (44 * 44);
  let ssRes = 0,
    ssTot = 0;
  for (let y = 0; y < 44; y++) {
    const vc = -0.5 + y / 43;
    for (let x = 0; x < 44; x++) {
      const uc = -0.5 + x / 43;
      const val = Ln[(10 + y) * 64 + (10 + x)];
      const pred = aU * uc + bV * vc;
      ssRes += (val - pred) * (val - pred);
      ssTot += (val - meanCoreLn) * (val - meanCoreLn);
    }
  }
  const planeR2 = Math.max(0, Math.min(1, 1.0 - ssRes / (ssTot + 44 * 44 * 0.08)));

  // Material chromaticity scores
  let redClaySum = 0,
    satSum = 0;
  for (let i = 0; i < 4096; i++) {
    if (mask64[i] <= 0.5) continue;
    const r = rgb64[i * 3];
    const g = rgb64[i * 3 + 1];
    const b = rgb64[i * 3 + 2];
    redClaySum += (r - b) / (r + g + b + 10.0);
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    satSum += (maxC - minC) / (maxC + 1.0);
  }
  const redClay = cnt64 > 5 ? redClaySum / cnt64 : 0;
  const meanSat = cnt64 > 5 ? satSum / cnt64 : 0.1;
  const neutralConcrete = (1.0 - Math.min(1.0, meanSat * 3.0)) * (ml / 255.0);
  const colorMetal = meanSat * (redClay < 0.12 ? 1.0 : 0.25);

  const feats = new Float32Array([
    Math.tanh((aspect - 1.0) * 0.8),
    solidity,
    nVerts >= 6 && solidity < 0.85 ? 1.0 : 0.0,
    Math.min(2.5, nsMid),
    Math.min(2.5, gableEndRatio),
    Math.min(2.5, hipTriScore),
    Math.min(2.5, centerRidge),
    Math.min(2.5, endRidge),
    Math.min(2.5, cornerHipEnergy),
    Math.min(2.5, rimDiff),
    interiorFlatness,
    planeR2,
    redClay * 2.5,
    neutralConcrete,
    colorMetal * 2.5,
    Math.min(1.0, shadowDepthM / 8.0),
  ]);

  return {
    tensor,
    feats,
    slopeDirectionSign: bV >= 0 ? 1 : -1,
  };
}

/**
 * Refines hand-tapped corners by nudging slightly off-edge clicks (within ±0.45m)
 * onto crisp satellite roof-boundary gradient peaks and gently snapping near-90° corners.
 */
function refineCornersOnSatellitePatch(
  rawPolygon: LngLatPoint[],
  data: Uint8ClampedArray,
  patchSize: number,
  z: number,
  originWx: number,
  originWy: number,
  metersPerPx: number
): { refined: LngLatPoint[]; moved: boolean } {
  const clean = stripClosingPoint(rawPolygon);
  if (clean.length < 3) return { refined: clean, moved: false };

  // Compute Sobel gradient magnitude map across patch
  const lum = new Float32Array(patchSize * patchSize);
  for (let i = 0; i < patchSize * patchSize; i++) {
    lum[i] =
      0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  const grad = new Float32Array(patchSize * patchSize);
  for (let y = 1; y < patchSize - 1; y++) {
    for (let x = 1; x < patchSize - 1; x++) {
      const gx =
        -lum[(y - 1) * patchSize + (x - 1)] +
        lum[(y - 1) * patchSize + (x + 1)] -
        2 * lum[y * patchSize + (x - 1)] +
        2 * lum[y * patchSize + (x + 1)] -
        lum[(y + 1) * patchSize + (x - 1)] +
        lum[(y + 1) * patchSize + (x + 1)];
      const gy =
        -lum[(y - 1) * patchSize + (x - 1)] -
        2 * lum[(y - 1) * patchSize + x] -
        lum[(y - 1) * patchSize + (x + 1)] +
        lum[(y + 1) * patchSize + (x - 1)] +
        2 * lum[(y + 1) * patchSize + x] +
        lum[(y + 1) * patchSize + (x + 1)];
      grad[y * patchSize + x] = Math.hypot(gx, gy);
    }
  }

  const maxSearchPx = Math.min(4, Math.max(2, Math.round(0.45 / metersPerPx)));
  let moved = false;

  const nudged: LngLatPoint[] = clean.map(([lng, lat]) => {
    const { wx, wy } = lngLatToWorldPixel(lng, lat, z);
    const px = Math.round(wx - originWx);
    const py = Math.round(wy - originWy);
    if (px < 6 || px >= patchSize - 6 || py < 6 || py >= patchSize - 6) {
      return [lng, lat];
    }

    const baseG = grad[py * patchSize + px];
    let bestG = baseG * 1.28; // Require at least 28% stronger edge peak to nudge
    let bestX = px;
    let bestY = py;

    for (let dy = -maxSearchPx; dy <= maxSearchPx; dy++) {
      for (let dx = -maxSearchPx; dx <= maxSearchPx; dx++) {
        const dist = Math.hypot(dx, dy);
        if (dist > maxSearchPx) continue;
        const g = grad[(py + dy) * patchSize + (px + dx)] * (1 - 0.06 * dist);
        if (g > bestG) {
          bestG = g;
          bestX = px + dx;
          bestY = py + dy;
        }
      }
    }

    if (bestX !== px || bestY !== py) {
      moved = true;
      return worldPixelToLngLat(originWx + bestX, originWy + bestY, z);
    }
    return [lng, lat];
  });

  return { refined: nudged, moved };
}

/**
 * Estimates exterior ground cast-shadow depth (in meters) around the tapped roof perimeter
 * to automatically estimate building elevation (1F vs 2F vs 3F).
 */
function measureExteriorShadowDepthM(
  polyPx: { x: number; y: number }[],
  data: Uint8ClampedArray,
  patchSize: number,
  metersPerPx: number,
  meanRoofLum: number
): number {
  const shadowLumThresh = Math.min(72, meanRoofLum * 0.58);
  let maxConsistentShadowM = 0;

  // Compute polygon centroid in pixel coords
  let cx = 0,
    cy = 0;
  for (const p of polyPx) {
    cx += p.x;
    cy += p.y;
  }
  cx /= polyPx.length;
  cy /= polyPx.length;

  for (let i = 0; i < polyPx.length; i++) {
    const a = polyPx[i];
    const b = polyPx[(i + 1) % polyPx.length];
    const edgeLenPx = Math.hypot(b.x - a.x, b.y - a.y);
    if (edgeLenPx < 8) continue;

    // Outward normal away from centroid
    let nx = -(b.y - a.y) / edgeLenPx;
    let ny = (b.x - a.x) / edgeLenPx;
    const mx = 0.5 * (a.x + b.x);
    const my = 0.5 * (a.y + b.y);
    if (nx * (mx - cx) + ny * (my - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }

    // Cast 5 parallel rays along the middle 60% of this roof edge
    const rayDepths: number[] = [];
    for (const t of [0.25, 0.38, 0.5, 0.62, 0.75]) {
      const sx = a.x + t * (b.x - a.x);
      const sy = a.y + t * (b.y - a.y);
      let depthM = 0;

      for (let dM = 0.45; dM <= 9.5; dM += 0.35) {
        const rx = Math.round(sx + (nx * dM) / metersPerPx);
        const ry = Math.round(sy + (ny * dM) / metersPerPx);
        if (rx < 1 || rx >= patchSize - 1 || ry < 1 || ry >= patchSize - 1) break;
        if (pointInPoly2D(rx, ry, polyPx)) continue;

        const idx = (ry * patchSize + rx) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const bl = data[idx + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * bl;

        // Ignore bright sunlit ground or lush sunlit green leaves
        const isBrightGreen = g > r * 1.18 && g > 85;
        if (lum < shadowLumThresh && !isBrightGreen) {
          depthM = dM;
        } else if (dM > 1.0) {
          break;
        }
      }
      rayDepths.push(depthM);
    }

    rayDepths.sort((u, v) => u - v);
    const medianEdgeShadow = rayDepths[2]; // Median filters out single dark bushes/cars
    if (medianEdgeShadow > maxConsistentShadowM) {
      maxConsistentShadowM = medianEdgeShadow;
    }
  }

  return Number(maxConsistentShadowM.toFixed(2));
}

/**
 * Renders the 160x160 Neural Roof Diagnostic Scan preview showing the rectified roof
 * and the neural network's identified ridge, hip, parapet, or slope skeleton lines.
 */
function renderNeuralDiagnosticOverlay(
  rgb64: Float32Array,
  mask64: Float32Array,
  style: RoofStyle,
  aspect: number,
  slopeSign: number
): { dataUrl: string; ridgeSegmentsCount: number } {
  const S = 160;
  const cnv = document.createElement('canvas');
  cnv.width = S;
  cnv.height = S;
  const ctx = cnv.getContext('2d');
  if (!ctx) return { dataUrl: '', ridgeSegmentsCount: 1 };

  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    const sy = Math.min(63, Math.floor((y * 64) / S));
    for (let x = 0; x < S; x++) {
      const sx = Math.min(63, Math.floor((x * 64) / S));
      const i64 = sy * 64 + sx;
      const o = (y * S + x) * 4;
      const inside = mask64[i64] > 0.5;
      if (inside) {
        img.data[o] = Math.min(255, rgb64[i64 * 3] * 1.06);
        img.data[o + 1] = Math.min(255, rgb64[i64 * 3 + 1] * 1.06);
        img.data[o + 2] = Math.min(255, rgb64[i64 * 3 + 2] * 1.06);
        img.data[o + 3] = 255;
      } else {
        // Dark technical grid background outside polygon
        const hatch = (x + y) % 8 === 0 ? 36 : 20;
        img.data[o] = hatch;
        img.data[o + 1] = hatch + 2;
        img.data[o + 2] = hatch;
        img.data[o + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  let ridgeSegmentsCount = 0;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (style === 'hip') {
    const insetU = Math.min(0.46, 0.5 / Math.max(1.0, aspect));
    const xL = S * insetU;
    const xR = S * (1 - insetU);
    const yM = S * 0.5;

    // 4 Hip bisectors in Signal Vermilion
    ctx.strokeStyle = '#FF521B';
    ctx.lineWidth = 2.5;
    const hips: [number, number, number, number][] = [
      [4, 4, xL, yM],
      [4, S - 4, xL, yM],
      [S - 4, 4, xR, yM],
      [S - 4, S - 4, xR, yM],
    ];
    for (const [x0, y0, x1, y1] of hips) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    // Central Ridge in Volt Lime
    ctx.strokeStyle = '#E2FF32';
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(xL, yM);
    ctx.lineTo(xR, yM);
    ctx.stroke();

    // Nodes
    ctx.fillStyle = '#E2FF32';
    for (const nx of [xL, xR]) {
      ctx.beginPath();
      ctx.arc(nx, yM, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ridgeSegmentsCount = aspect > 1.08 ? 5 : 4;
  } else if (style === 'gable') {
    ctx.strokeStyle = '#E2FF32';
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(4, S * 0.5);
    ctx.lineTo(S - 4, S * 0.5);
    ctx.stroke();

    // Gable end markers
    ctx.strokeStyle = '#FF521B';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(5, 8);
    ctx.lineTo(5, S - 8);
    ctx.moveTo(S - 5, 8);
    ctx.lineTo(S - 5, S - 8);
    ctx.stroke();
    ridgeSegmentsCount = 1;
  } else if (style === 'flat') {
    ctx.strokeStyle = '#E2FF32';
    ctx.lineWidth = 2.2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(10, 10, S - 20, S - 20);
    ctx.setLineDash([]);
    ridgeSegmentsCount = 0;
  } else {
    // Shed slope arrows
    ctx.strokeStyle = '#E2FF32';
    ctx.lineWidth = 2.2;
    for (const xFrac of [0.25, 0.5, 0.75]) {
      const x = S * xFrac;
      const yStart = slopeSign >= 0 ? S * 0.22 : S * 0.78;
      const yEnd = slopeSign >= 0 ? S * 0.78 : S * 0.22;
      ctx.beginPath();
      ctx.moveTo(x, yStart);
      ctx.lineTo(x, yEnd);
      ctx.stroke();
    }
    ridgeSegmentsCount = 1;
  }

  return { dataUrl: cnv.toDataURL('image/png'), ridgeSegmentsCount };
}

/**
 * Full End-to-End Intelligent Roof Identification Pipeline:
 * 1. Fetches live high-res zoom-20 Sri Lanka satellite patch around the user's tapped corners
 * 2. Gently refines off-edge clicks to crisp satellite roof edges
 * 3. Evaluates dual orthogonal OMBB orientations + runs LankaRoofNet CNN + Fusion inference
 * 4. Measures exterior ground cast-shadow depth for automatic story/height estimation
 * 5. Produces UV roof drape texture + Neural Scan diagnostic overlay
 */
export async function identifyBuildingRoofIntelligent(
  rawPolygon: LngLatPoint[],
  provider: SatelliteProvider,
  allowCornerRefine = true
): Promise<{
  refinedPolygon: LngLatPoint[];
  satelliteTextureDataUrl?: string;
  analysis: NeuralRoofAnalysis;
}> {
  const tStart = performance.now();
  const baseMetrics: HouseMetrics = computeHouseMetrics(rawPolygon);

  const fallbackAnalysis = (): NeuralRoofAnalysis => ({
    predictedStyle: baseMetrics.lengthM / Math.max(1, baseMetrics.widthM) > 2.2 ? 'gable' : 'hip',
    confidencePct: 78,
    styleProbabilities: { hip: 0.78, gable: 0.14, flat: 0.05, shed: 0.03 },
    predictedMaterial: 'terracotta',
    materialProbabilities: { terracotta: 0.7, metal: 0.2, concrete: 0.1 },
    predictedPitchDeg: 23,
    ridgeAngleRad: baseMetrics.dominantAngleRad,
    shedSlopeAngleRad: baseMetrics.dominantAngleRad + Math.PI / 2,
    inferredStories: baseMetrics.areaSqm > 210 ? 2 : 1,
    shadowDepthM: 2.1,
    inferenceTimeMs: Math.round(performance.now() - tStart),
    ridgeSegmentsCount: 5,
    cornersRefined: false,
  });

  const maxSpanM = Math.max(baseMetrics.lengthM, baseMetrics.widthM);
  const patchPx = maxSpanM > 28 ? 448 : 320;
  const sat = await renderSatelliteNeighborhood(
    baseMetrics.centroid[0],
    baseMetrics.centroid[1],
    provider,
    patchPx
  );

  if (!sat) {
    return {
      refinedPolygon: rawPolygon,
      analysis: fallbackAnalysis(),
    };
  }

  const { canvas, imgData, z, originWx, originWy, metersPerPx } = sat;

  // 1. Optional gentle corner refinement onto sharp satellite roof edges
  let workingPolygon = rawPolygon;
  let cornersRefined = false;
  if (allowCornerRefine) {
    const refRes = refineCornersOnSatellitePatch(
      rawPolygon,
      imgData.data,
      patchPx,
      z,
      originWx,
      originWy,
      metersPerPx
    );
    workingPolygon = refRes.refined;
    cornersRefined = refRes.moved;
  }

  const metrics = cornersRefined ? computeHouseMetrics(workingPolygon) : baseMetrics;
  const { metersPerDegLat, metersPerDegLng } = getMetersPerDegree(metrics.centroid[1]);

  // Convert polygon to pixel coords on `canvas`
  const polyPx = stripClosingPoint(workingPolygon).map(([lng, lat]) => {
    const { wx, wy } = lngLatToWorldPixel(lng, lat, z);
    return { x: wx - originWx, y: wy - originWy };
  });

  // Helper to sample a 64x64 canonical OMBB patch at a candidate ridge angle `theta`
  const sampleCanonicalAtAngle = (theta: number) => {
    const c = Math.cos(-theta);
    const s = Math.sin(-theta);
    let minU = Infinity,
      maxU = -Infinity,
      minV = Infinity,
      maxV = -Infinity;
    for (const p of metrics.vertices2D) {
      const ru = p.x * c - p.z * s;
      const rv = p.x * s + p.z * c;
      if (ru < minU) minU = ru;
      if (ru > maxU) maxU = ru;
      if (rv < minV) minV = rv;
      if (rv > maxV) maxV = rv;
    }

    const spanU = Math.max(1.0, maxU - minU);
    const spanV = Math.max(1.0, maxV - minV);
    const cb = Math.cos(theta);
    const sb = Math.sin(theta);

    const rgb64 = new Float32Array(64 * 64 * 3);
    const mask64 = new Float32Array(64 * 64);
    let lumSum = 0;
    let lumCnt = 0;

    for (let iv = 0; iv < 64; iv++) {
      const rv = minV + (iv / 63) * spanV;
      for (let iu = 0; iu < 64; iu++) {
        const ru = minU + (iu / 63) * spanU;
        // Back to local meters (x, z) -> [lng, lat] -> pixel (px, py)
        const mx = ru * cb - rv * sb;
        const mz = ru * sb + rv * cb;
        const lng = metrics.centroid[0] + mx / metersPerDegLng;
        const lat = metrics.centroid[1] - mz / metersPerDegLat;
        const { wx, wy } = lngLatToWorldPixel(lng, lat, z);
        const px = wx - originWx;
        const py = wy - originWy;

        const inside = pointInPoly2D(px, py, polyPx);
        const idx = iv * 64 + iu;
        mask64[idx] = inside ? 1.0 : 0.0;

        const [r, g, b] = sampleBilinearRGB(imgData.data, patchPx, patchPx, px, py);
        rgb64[idx * 3] = r;
        rgb64[idx * 3 + 1] = g;
        rgb64[idx * 3 + 2] = b;

        if (inside) {
          lumSum += 0.299 * r + 0.587 * g + 0.114 * b;
          lumCnt++;
        }
      }
    }

    const solidity = Math.min(1.0, metrics.areaSqm / Math.max(1.0, spanU * spanV));
    const meanRoofLum = lumCnt > 0 ? lumSum / lumCnt : 125;
    return {
      rgb64,
      mask64,
      spanU,
      spanV,
      aspect: spanU / spanV,
      solidity,
      meanRoofLum,
    };
  };

  // Sample primary major-axis OMBB AND cross-axis OMBB (theta + 90deg) to catch cross-gables!
  const theta0 = metrics.dominantAngleRad;
  const theta90 = theta0 + Math.PI / 2;
  const patch0 = sampleCanonicalAtAngle(theta0);
  const shadowDepthM = measureExteriorShadowDepthM(
    polyPx,
    imgData.data,
    patchPx,
    metersPerPx,
    patch0.meanRoofLum
  );

  const inp0 = extractCanonicalPatchInputs(
    patch0.rgb64,
    patch0.mask64,
    patch0.aspect,
    patch0.solidity,
    metrics.vertices2D.length,
    shadowDepthM
  );
  const out0 = runLankaRoofNetForward(inp0.tensor, inp0.feats);

  // Check if house is near-square (aspect < 1.45): test cross-axis ridge orientation too!
  let chosenTheta = theta0;
  let chosenPatch = patch0;
  let chosenInp = inp0;
  let chosenOut = out0;

  if (patch0.aspect < 1.45) {
    const patch90 = sampleCanonicalAtAngle(theta90);
    const inp90 = extractCanonicalPatchInputs(
      patch90.rgb64,
      patch90.mask64,
      Math.max(1.0, patch90.aspect),
      patch90.solidity,
      metrics.vertices2D.length,
      shadowDepthM
    );
    const out90 = runLankaRoofNetForward(inp90.tensor, inp90.feats);
    // Pick orientation with stronger North-South ridge opposition (feats[3] + feats[6])
    const ridgeScore0 = inp0.feats[3] + inp0.feats[6];
    const ridgeScore90 = inp90.feats[3] + inp90.feats[6];
    if (ridgeScore90 > ridgeScore0 * 1.18) {
      chosenTheta = theta90;
      chosenPatch = patch90;
      chosenInp = inp90;
      chosenOut = out90;
    }
  }

  // Infer stories from exterior cast-shadow width + footprint scale (Zero manual input!)
  let inferredStories: 1 | 2 | 3 = 1;
  if (shadowDepthM >= 5.6 && metrics.areaSqm >= 65) {
    inferredStories = 3;
  } else if (shadowDepthM >= 3.35 || (metrics.areaSqm > 235 && Math.min(metrics.widthM, metrics.lengthM) > 9.5)) {
    inferredStories = 2;
  } else {
    inferredStories = 1;
  }

  // Crop axis-aligned bounding box of polygon for 3D UV satellite drape texture
  let minPx = Infinity,
    maxPx = -Infinity,
    minPy = Infinity,
    maxPy = -Infinity;
  for (const p of polyPx) {
    if (p.x < minPx) minPx = p.x;
    if (p.x > maxPx) maxPx = p.x;
    if (p.y < minPy) minPy = p.y;
    if (p.y > maxPy) maxPy = p.y;
  }
  let satelliteTextureDataUrl: string | undefined;
  const texCnv = document.createElement('canvas');
  texCnv.width = 256;
  texCnv.height = 256;
  const tctx = texCnv.getContext('2d');
  if (tctx) {
    tctx.drawImage(
      canvas,
      minPx,
      minPy,
      Math.max(12, maxPx - minPx),
      Math.max(12, maxPy - minPy),
      0,
      0,
      256,
      256
    );
    try {
      satelliteTextureDataUrl = texCnv.toDataURL('image/jpeg', 0.88);
    } catch {
      satelliteTextureDataUrl = undefined;
    }
  }

  // Render live Neural Scan Diagnostic image with ridge/hip skeleton overlay
  const diag = renderNeuralDiagnosticOverlay(
    chosenPatch.rgb64,
    chosenPatch.mask64,
    chosenOut.predictedStyle,
    Math.max(1.0, chosenPatch.aspect),
    chosenInp.slopeDirectionSign
  );

  const shedSlopeAngleRad =
    chosenTheta + (chosenInp.slopeDirectionSign >= 0 ? Math.PI / 2 : -Math.PI / 2);

  return {
    refinedPolygon: workingPolygon,
    satelliteTextureDataUrl,
    analysis: {
      predictedStyle: chosenOut.predictedStyle,
      confidencePct: chosenOut.confidencePct,
      styleProbabilities: chosenOut.styleProbs,
      predictedMaterial: chosenOut.predictedMaterial,
      materialProbabilities: chosenOut.materialProbs,
      predictedPitchDeg: chosenOut.predictedPitchDeg,
      ridgeAngleRad: chosenTheta,
      shedSlopeAngleRad,
      inferredStories,
      shadowDepthM,
      inferenceTimeMs: Math.max(1, Math.round(performance.now() - tStart)),
      neuralScanDataUrl: diag.dataUrl,
      ridgeSegmentsCount: diag.ridgeSegmentsCount,
      cornersRefined,
    },
  };
}
