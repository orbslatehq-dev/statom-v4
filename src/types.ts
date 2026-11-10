export type LngLatPoint = [number, number]; // [lng, lat]

export interface Vec2 {
  x: number; // meters East (+X)
  z: number; // meters South (+Z), so -Z is North
}

export type RoofStyle = 'hip' | 'gable' | 'flat' | 'shed';

export type ModelFinish = 'maquette' | 'terracotta' | 'blueprint' | 'satellite';

export type SatelliteProvider = 'google' | 'esri';

export interface HouseMetrics {
  areaSqm: number;
  areaSqft: number;
  areaPerches: number; // Sri Lankan Perches (1 perch = 25.29285 m²)
  perimeterM: number;
  lengthM: number; // Major axis of oriented bounding box
  widthM: number; // Minor axis of oriented bounding box
  dominantAngleRad: number;
  edgeLengthsM: number[];
  centroid: LngLatPoint;
  vertices2D: Vec2[]; // Cleaned CCW in (x, -z), i.e. local meters
}

export interface NeuralRoofAnalysis {
  predictedStyle: RoofStyle;
  confidencePct: number;
  styleProbabilities: Record<RoofStyle, number>;
  predictedMaterial: 'terracotta' | 'concrete' | 'metal';
  materialProbabilities: Record<'terracotta' | 'concrete' | 'metal', number>;
  predictedPitchDeg: number;
  ridgeAngleRad: number;
  shedSlopeAngleRad: number;
  inferredStories: 1 | 2 | 3;
  shadowDepthM: number;
  inferenceTimeMs: number;
  neuralScanDataUrl?: string;
  ridgeSegmentsCount: number;
  cornersRefined: boolean;
}

export interface HouseSpec {
  id: string;
  polygon: LngLatPoint[]; // Unclosed ring of [lng, lat] vertices
  stories: 1 | 2 | 3;
  wallHeightM: number; // Auto-calculated scaled wall height
  roofStyle: RoofStyle;
  roofPitchDeg: number;
  eaveOverhangM: number;
  ridgeAngleRad?: number;
  shedSlopeAngleRad?: number;
  satelliteTextureDataUrl?: string;
  detectedMaterialHint?: 'terracotta' | 'concrete' | 'metal';
  neuralAnalysis?: NeuralRoofAnalysis;
}

export interface SriLankaPresetLocation {
  id: string;
  name: string;
  region: string;
  lng: number;
  lat: number;
  zoom: number;
  tag: string;
}
