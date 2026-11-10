import * as THREE from 'three';
import { HourlyWeatherPoint } from './weatherTypes';

const MAX_RAIN_PARTICLES = 2200;
const MAX_SPLASH_RINGS = 180;
const CLOUD_CLUSTER_COUNT = 10;
const STAR_COUNT = 320;
const RAIN_BOUNDS_XZ = 27;
const RAIN_TOP_Y = 26;

export interface LivePreviewReadout {
  hourFloat: number; // 0..24
  timeLabel: string; // "14:30"
  temperatureC: number;
  feelsLikeC: number;
  rainMm: number;
  cloudCoverPct: number;
  windSpeedKmh: number;
  windDirectionDeg: number;
  humidityPct: number;
  weatherCode: number;
  isHighHeat: boolean;
  isStorm: boolean;
}

interface SceneOriginalSnapshot {
  background: THREE.Color | THREE.Texture | null;
  fog: THREE.Fog | THREE.FogExp2 | null;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  hemiPos: THREE.Vector3;
  keyColor: THREE.Color;
  keyIntensity: number;
  keyPos: THREE.Vector3;
  keyShadowBias: number;
  keyShadowNormalBias: number;
  rimColor: THREE.Color;
  rimIntensity: number;
  rimPos: THREE.Vector3;
  shadowOpacity: number;
}

interface SkyHexKeyframe {
  hour: number;
  hex: number;
}

// Continuous sRGB hex keyframes — luminous moonlit night (never pitch-black!) + rich tropical day
const SKY_HEX_KEYFRAMES: SkyHexKeyframe[] = [
  { hour: 0.0, hex: 0x1b2d52 },  // 00:00 Luminous moonlit midnight sapphire
  { hour: 4.75, hex: 0x213560 }, // 04:45 Pre-dawn twilight blue
  { hour: 5.45, hex: 0x4b3b66 }, // 05:27 First twilight plum
  { hour: 6.05, hex: 0xeb8458 }, // 06:03 Sunrise warm apricot-coral
  { hour: 6.75, hex: 0x8cc2eb }, // 06:45 Golden morning sky blue
  { hour: 9.5, hex: 0x62aee8 },  // 09:30 Clear tropical azure
  { hour: 12.5, hex: 0x56a5e6 }, // 12:30 Zenith sky blue
  { hour: 16.25, hex: 0x6eb2e3 },// 16:15 Warm afternoon blue
  { hour: 17.55, hex: 0xe88b52 },// 17:33 Golden hour amber
  { hour: 18.15, hex: 0xc95a49 },// 18:09 Sunset crimson-amber
  { hour: 18.85, hex: 0x363661 },// 18:51 Dusk violet-indigo
  { hour: 19.6, hex: 0x1f325a }, // 19:36 Moonlit night sapphire
  { hour: 24.0, hex: 0x1b2d52 }, // 24:00 Luminous moonlit midnight sapphire
];

interface CloudClusterItem {
  group: THREE.Group;
  mat: THREE.MeshStandardMaterial;
  threshold01: number; // Cloud cover % threshold at which this cluster emerges
  baseScale: number;
  currentScale: number;
  driftFactor: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerpAngleDeg(a: number, b: number, t: number): number {
  const diff = ((((b - a) % 360) + 540) % 360) - 180;
  return (((a + diff * t) % 360) + 360) % 360;
}

function formatHourFloat(hourFloat: number): string {
  const clamped = clamp(hourFloat, 0, 23.999);
  const totalMins = Math.floor(clamped * 60);
  const hh = Math.floor(totalMins / 60) % 24;
  const mm = totalMins % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function createSunGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(64, 64, 8, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255, 252, 230, 1.0)');
  grad.addColorStop(0.22, 'rgba(255, 225, 145, 0.85)');
  grad.addColorStop(0.52, 'rgba(255, 170, 75, 0.32)');
  grad.addColorStop(1, 'rgba(255, 140, 40, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createCrispMoonTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);

  // Outer soft silver atmospheric lunar halo
  const halo = ctx.createRadialGradient(64, 64, 24, 64, 64, 62);
  halo.addColorStop(0, 'rgba(210, 228, 255, 0.55)');
  halo.addColorStop(0.5, 'rgba(165, 198, 250, 0.18)');
  halo.addColorStop(1, 'rgba(140, 180, 255, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, 128, 128);

  // Crisp Moon Disc
  const discGrad = ctx.createRadialGradient(56, 54, 4, 64, 64, 27);
  discGrad.addColorStop(0, '#FFFFFF');
  discGrad.addColorStop(0.72, '#E6EEF8');
  discGrad.addColorStop(1, '#BAC9DE');
  ctx.fillStyle = discGrad;
  ctx.beginPath();
  ctx.arc(64, 64, 26, 0, Math.PI * 2);
  ctx.fill();

  // Subtle lunar maria craters so the Moon is unmistakably recognizable
  const craters: [number, number, number, number][] = [
    [55, 56, 7.5, 0.16],
    [72, 58, 6.0, 0.14],
    [61, 71, 8.5, 0.13],
    [74, 70, 4.5, 0.15],
    [50, 67, 4.0, 0.12],
  ];
  for (const [cx, cy, r, a] of craters) {
    ctx.fillStyle = `rgba(95, 114, 145, ${a})`;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createRainStreakTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 16, 128);

  // Bright silver-white raindrop core tapering upward to translucent tail
  const grad = ctx.createLinearGradient(8, 0, 8, 128);
  grad.addColorStop(0, 'rgba(210, 232, 255, 0.0)');
  grad.addColorStop(0.45, 'rgba(225, 240, 255, 0.55)');
  grad.addColorStop(0.88, 'rgba(248, 252, 255, 0.98)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0.25)');
  ctx.fillStyle = grad;
  ctx.fillRect(3, 0, 10, 128);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class WeatherPreviewEngine {
  private scene: THREE.Scene;
  private hemiLight: THREE.HemisphereLight;
  private keyLight: THREE.DirectionalLight;
  private rimLight: THREE.DirectionalLight;
  private groundShadowMat: THREE.ShadowMaterial;

  private snapshot: SceneOriginalSnapshot | null = null;
  private rootGroup: THREE.Group | null = null;
  private fogExp2: THREE.FogExp2 | null = null;

  // Grounded courtyard terrain disc (gives crisp, realistic long cast shadows!)
  private terrainGeo: THREE.CircleGeometry | null = null;
  private terrainMat: THREE.MeshStandardMaterial | null = null;
  private terrainMesh: THREE.Mesh | null = null;

  // Sun 3D sphere + corona sprite, Moon cratered sprite, Night Starfield
  private sunSphereGeo: THREE.SphereGeometry | null = null;
  private sunSphereMat: THREE.MeshBasicMaterial | null = null;
  private sunMesh: THREE.Mesh | null = null;
  private sunGlowTex: THREE.CanvasTexture | null = null;
  private sunGlowSprite: THREE.Sprite | null = null;

  private moonTex: THREE.CanvasTexture | null = null;
  private moonSprite: THREE.Sprite | null = null;

  private starsGeo: THREE.BufferGeometry | null = null;
  private starsMat: THREE.PointsMaterial | null = null;
  private starsPoints: THREE.Points | null = null;

  // 3D Sculpted Cumulus Cloud Clusters
  private puffGeo: THREE.SphereGeometry | null = null;
  private cloudClusters: CloudClusterItem[] = [];

  // High-visibility Rain Streaks + Ground Splash Rings
  private rainTex: THREE.CanvasTexture | null = null;
  private rainGeo: THREE.PlaneGeometry | null = null;
  private rainMat: THREE.MeshBasicMaterial | null = null;
  private rainMesh: THREE.InstancedMesh | null = null;
  private rainPositions: Float32Array = new Float32Array(MAX_RAIN_PARTICLES * 3);
  private rainSpeeds: Float32Array = new Float32Array(MAX_RAIN_PARTICLES);

  private splashGeo: THREE.RingGeometry | null = null;
  private splashMat: THREE.MeshBasicMaterial | null = null;
  private splashMesh: THREE.InstancedMesh | null = null;
  private splashState: Float32Array = new Float32Array(MAX_SPLASH_RINGS * 3); // x, z, phase(0..1)

  private wetness01 = 0;
  private smoothedSkyInitialized = false;

  // Thunderstorm lightning flicker state
  private nextLightningTimer = 3.2;
  private lightningFlickerSeq: number[] = [];
  private lightningFlickerIdx = 0;
  private lightningSubTimer = 0;

  // Pre-allocated scratch math objects (zero per-frame GC allocations)
  private readonly targetSkyColor = new THREE.Color();
  private readonly currentSkyColor = new THREE.Color();
  private readonly colorScratchA = new THREE.Color();
  private readonly colorScratchB = new THREE.Color();
  private readonly cloudColorScratch = new THREE.Color();
  private readonly sunLightColor = new THREE.Color();
  private readonly moonLightColor = new THREE.Color(0xcfe0ff);
  private readonly dummyMat4 = new THREE.Matrix4();
  private readonly dummyPos = new THREE.Vector3();
  private readonly dummyQuat = new THREE.Quaternion();
  private readonly dummyScale = new THREE.Vector3(1, 1, 1);
  private readonly dummyEuler = new THREE.Euler();
  private readonly splashQuat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-Math.PI / 2, 0, 0)
  );

  public isRunning = false;

  private readonly readout: LivePreviewReadout = {
    hourFloat: 0,
    timeLabel: '00:00',
    temperatureC: 27,
    feelsLikeC: 30,
    rainMm: 0,
    cloudCoverPct: 25,
    windSpeedKmh: 8,
    windDirectionDeg: 225,
    humidityPct: 80,
    weatherCode: 1,
    isHighHeat: false,
    isStorm: false,
  };

  constructor(
    scene: THREE.Scene,
    hemiLight: THREE.HemisphereLight,
    keyLight: THREE.DirectionalLight,
    rimLight: THREE.DirectionalLight,
    groundShadowMat: THREE.ShadowMaterial
  ) {
    this.scene = scene;
    this.hemiLight = hemiLight;
    this.keyLight = keyLight;
    this.rimLight = rimLight;
    this.groundShadowMat = groundShadowMat;
  }

  public start(): void {
    if (this.isRunning) return;

    // 1. Snapshot exact original scene state
    this.snapshot = {
      background:
        this.scene.background instanceof THREE.Color
          ? this.scene.background.clone()
          : this.scene.background,
      fog: this.scene.fog,
      hemiSky: this.hemiLight.color.clone(),
      hemiGround: this.hemiLight.groundColor.clone(),
      hemiIntensity: this.hemiLight.intensity,
      hemiPos: this.hemiLight.position.clone(),
      keyColor: this.keyLight.color.clone(),
      keyIntensity: this.keyLight.intensity,
      keyPos: this.keyLight.position.clone(),
      keyShadowBias: this.keyLight.shadow.bias,
      keyShadowNormalBias: this.keyLight.shadow.normalBias,
      rimColor: this.rimLight.color.clone(),
      rimIntensity: this.rimLight.intensity,
      rimPos: this.rimLight.position.clone(),
      shadowOpacity: this.groundShadowMat.opacity,
    };

    // Tune shadow acne bias for crisp low-angle sunrise/sunset shadows
    this.keyLight.shadow.bias = -0.00025;
    this.keyLight.shadow.normalBias = 0.022;
    this.groundShadowMat.opacity = 0; // Physical terrainMesh receives crisp real shadows instead

    const group = new THREE.Group();
    group.name = 'weather-preview-overlay';
    this.rootGroup = group;

    // 2. FogExp2
    this.fogExp2 = new THREE.FogExp2(0x62aee8, 0.0015);
    this.scene.fog = this.fogExp2;

    // 3. Lit Architectural Site Ground Plane (receives crisp sweeping sun/moon shadows & wets in rain!)
    this.terrainGeo = new THREE.CircleGeometry(190, 64);
    this.terrainGeo.rotateX(-Math.PI / 2);
    this.terrainMat = new THREE.MeshStandardMaterial({
      color: 0xd8d3c6,
      roughness: 0.9,
      metalness: 0.04,
    });
    this.terrainMesh = new THREE.Mesh(this.terrainGeo, this.terrainMat);
    this.terrainMesh.position.y = -0.012;
    this.terrainMesh.receiveShadow = true;
    group.add(this.terrainMesh);

    let seed = 421337;
    const rand01 = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    // 4. Night Starfield Dome (fades in smoothly at night, invisible by day)
    const starPos = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const theta = rand01() * Math.PI * 2;
      const elev = 0.08 + rand01() * 0.85; // Above horizon
      const rad = 148;
      starPos[i * 3] = Math.cos(theta) * Math.cos(elev) * rad;
      starPos[i * 3 + 1] = Math.sin(elev) * rad;
      starPos[i * 3 + 2] = Math.sin(theta) * Math.cos(elev) * rad;
    }
    this.starsGeo = new THREE.BufferGeometry();
    this.starsGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.starsMat = new THREE.PointsMaterial({
      color: 0xf4f8ff,
      size: 1.35,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      fog: false,
      depthWrite: false,
    });
    this.starsPoints = new THREE.Points(this.starsGeo, this.starsMat);
    group.add(this.starsPoints);

    // 5. Visible 3D Sun Disc + Corona Halo
    this.sunSphereGeo = new THREE.SphereGeometry(3.1, 24, 24);
    this.sunSphereMat = new THREE.MeshBasicMaterial({
      color: 0xfff6d6,
      transparent: true,
      opacity: 1,
      fog: false,
    });
    this.sunMesh = new THREE.Mesh(this.sunSphereGeo, this.sunSphereMat);
    group.add(this.sunMesh);

    this.sunGlowTex = createSunGlowTexture();
    const sunGlowMat = new THREE.SpriteMaterial({
      map: this.sunGlowTex,
      color: 0xffb84d,
      transparent: true,
      opacity: 0.9,
      fog: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.sunGlowSprite = new THREE.Sprite(sunGlowMat);
    this.sunGlowSprite.scale.set(22, 22, 1);
    group.add(this.sunGlowSprite);

    // 6. Visible Cratered Moon + Silver Lunar Halo
    this.moonTex = createCrispMoonTexture();
    const moonMat = new THREE.SpriteMaterial({
      map: this.moonTex,
      transparent: true,
      opacity: 1,
      fog: false,
      depthWrite: false,
    });
    this.moonSprite = new THREE.Sprite(moonMat);
    this.moonSprite.scale.set(13.5, 13.5, 1);
    group.add(this.moonSprite);

    // 7. Sculpted 3D Cumulus Cloud Clusters (unmistakable volumetric silhouettes!)
    this.puffGeo = new THREE.SphereGeometry(1, 14, 12);
    this.cloudClusters = [];

    const puffOffsets: [number, number, number, number, number, number][] = [
      [0, 0.35, 0, 1.45, 1.05, 1.15],
      [-1.15, 0.05, 0.12, 1.1, 0.82, 0.95],
      [1.18, 0.08, -0.1, 1.15, 0.85, 0.95],
      [-0.55, 0.55, -0.22, 1.0, 0.9, 0.9],
      [0.62, 0.52, 0.22, 0.95, 0.85, 0.88],
      [0.05, -0.12, 0.55, 1.05, 0.68, 0.85],
    ];

    for (let i = 0; i < CLOUD_CLUSTER_COUNT; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.96,
        metalness: 0.0,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      });

      const cGroup = new THREE.Group();
      for (const [ox, oy, oz, sx, sy, sz] of puffOffsets) {
        const puff = new THREE.Mesh(this.puffGeo, mat);
        puff.position.set(
          ox + (rand01() - 0.5) * 0.22,
          oy + (rand01() - 0.5) * 0.12,
          oz + (rand01() - 0.5) * 0.22
        );
        puff.scale.set(sx, sy, sz);
        cGroup.add(puff);
      }

      // Keep clouds high & airy in the sky backdrop behind the house (never near camera!)
      const px = (rand01() * 2 - 1) * 62;
      const py = 20.5 + rand01() * 10.5;
      const pz = -68 + rand01() * 50; // z in [-68, -18]
      const baseScale = 1.5 + rand01() * 1.05;
      cGroup.position.set(px, py, pz);
      cGroup.rotation.y = rand01() * Math.PI * 2;
      cGroup.scale.setScalar(0.001);

      group.add(cGroup);

      this.cloudClusters.push({
        group: cGroup,
        mat,
        threshold01: 0.16 + (i / CLOUD_CLUSTER_COUNT) * 0.78,
        baseScale,
        currentScale: 0.001,
        driftFactor: 0.72 + rand01() * 0.34,
      });
    }

    // 8. High-Visibility Slanted Rain Streaks (InstancedMesh, <= 2200 instances)
    this.rainTex = createRainStreakTexture();
    this.rainGeo = new THREE.PlaneGeometry(0.115, 2.45);
    this.rainMat = new THREE.MeshBasicMaterial({
      map: this.rainTex,
      color: 0xeaf4ff,
      transparent: true,
      opacity: 0.88,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
    });
    this.rainMesh = new THREE.InstancedMesh(
      this.rainGeo,
      this.rainMat,
      MAX_RAIN_PARTICLES
    );
    this.rainMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rainMesh.count = 0;
    this.rainMesh.frustumCulled = false;

    for (let i = 0; i < MAX_RAIN_PARTICLES; i++) {
      this.rainPositions[i * 3] = (rand01() * 2 - 1) * RAIN_BOUNDS_XZ;
      this.rainPositions[i * 3 + 1] = rand01() * RAIN_TOP_Y;
      this.rainPositions[i * 3 + 2] = (rand01() * 2 - 1) * RAIN_BOUNDS_XZ;
      this.rainSpeeds[i] = 24 + rand01() * 11;
    }
    group.add(this.rainMesh);

    // 9. Ground Raindrop Splash Ripples (InstancedMesh, 180 expanding rings)
    this.splashGeo = new THREE.RingGeometry(0.08, 0.14, 16);
    this.splashMat = new THREE.MeshBasicMaterial({
      color: 0xdbeafe,
      transparent: true,
      opacity: 0.62,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.splashMesh = new THREE.InstancedMesh(
      this.splashGeo,
      this.splashMat,
      MAX_SPLASH_RINGS
    );
    this.splashMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.splashMesh.count = 0;
    this.splashMesh.frustumCulled = false;

    for (let i = 0; i < MAX_SPLASH_RINGS; i++) {
      this.splashState[i * 3] = (rand01() * 2 - 1) * 22;
      this.splashState[i * 3 + 1] = (rand01() * 2 - 1) * 22;
      this.splashState[i * 3 + 2] = rand01();
    }
    group.add(this.splashMesh);

    this.wetness01 = 0;
    this.smoothedSkyInitialized = false;
    this.nextLightningTimer = 2.8;
    this.lightningFlickerSeq = [];
    this.scene.add(group);
    this.isRunning = true;
  }

  public stopAndRestore(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.rootGroup) {
      this.scene.remove(this.rootGroup);
      this.rootGroup = null;
    }

    if (this.terrainGeo) {
      this.terrainGeo.dispose();
      this.terrainGeo = null;
    }
    if (this.terrainMat) {
      this.terrainMat.dispose();
      this.terrainMat = null;
    }
    this.terrainMesh = null;

    if (this.starsGeo) {
      this.starsGeo.dispose();
      this.starsGeo = null;
    }
    if (this.starsMat) {
      this.starsMat.dispose();
      this.starsMat = null;
    }
    this.starsPoints = null;

    if (this.sunSphereGeo) {
      this.sunSphereGeo.dispose();
      this.sunSphereGeo = null;
    }
    if (this.sunSphereMat) {
      this.sunSphereMat.dispose();
      this.sunSphereMat = null;
    }
    this.sunMesh = null;

    if (this.sunGlowSprite) {
      this.sunGlowSprite.material.dispose();
      this.sunGlowSprite = null;
    }
    if (this.sunGlowTex) {
      this.sunGlowTex.dispose();
      this.sunGlowTex = null;
    }

    if (this.moonSprite) {
      this.moonSprite.material.dispose();
      this.moonSprite = null;
    }
    if (this.moonTex) {
      this.moonTex.dispose();
      this.moonTex = null;
    }

    for (const c of this.cloudClusters) {
      c.mat.dispose();
    }
    this.cloudClusters = [];
    if (this.puffGeo) {
      this.puffGeo.dispose();
      this.puffGeo = null;
    }

    if (this.rainGeo) {
      this.rainGeo.dispose();
      this.rainGeo = null;
    }
    if (this.rainMat) {
      this.rainMat.dispose();
      this.rainMat = null;
    }
    if (this.rainTex) {
      this.rainTex.dispose();
      this.rainTex = null;
    }
    this.rainMesh = null;

    if (this.splashGeo) {
      this.splashGeo.dispose();
      this.splashGeo = null;
    }
    if (this.splashMat) {
      this.splashMat.dispose();
      this.splashMat = null;
    }
    this.splashMesh = null;
    this.fogExp2 = null;

    // Restore original scene background, fog, lights, and ground shadow identically
    if (this.snapshot) {
      this.scene.background =
        this.snapshot.background instanceof THREE.Color
          ? this.snapshot.background.clone()
          : this.snapshot.background;
      this.scene.fog = this.snapshot.fog;

      this.hemiLight.color.copy(this.snapshot.hemiSky);
      this.hemiLight.groundColor.copy(this.snapshot.hemiGround);
      this.hemiLight.intensity = this.snapshot.hemiIntensity;
      this.hemiLight.position.copy(this.snapshot.hemiPos);

      this.keyLight.color.copy(this.snapshot.keyColor);
      this.keyLight.intensity = this.snapshot.keyIntensity;
      this.keyLight.position.copy(this.snapshot.keyPos);
      this.keyLight.shadow.bias = this.snapshot.keyShadowBias;
      this.keyLight.shadow.normalBias = this.snapshot.keyShadowNormalBias;

      this.rimLight.color.copy(this.snapshot.rimColor);
      this.rimLight.intensity = this.snapshot.rimIntensity;
      this.rimLight.position.copy(this.snapshot.rimPos);

      this.groundShadowMat.opacity = this.snapshot.shadowOpacity;
      this.snapshot = null;
    }
  }

  private sampleSkyBaseColor(hour: number, target: THREE.Color): void {
    const h = clamp(hour, 0, 24);
    for (let i = 0; i < SKY_HEX_KEYFRAMES.length - 1; i++) {
      const k0 = SKY_HEX_KEYFRAMES[i];
      const k1 = SKY_HEX_KEYFRAMES[i + 1];
      if (h >= k0.hour && h <= k1.hour) {
        const t = (h - k0.hour) / Math.max(0.001, k1.hour - k0.hour);
        const smoothT = t * t * (3 - 2 * t);
        this.colorScratchA.setHex(k0.hex);
        this.colorScratchB.setHex(k1.hex);
        target.copy(this.colorScratchA).lerp(this.colorScratchB, smoothT);
        return;
      }
    }
    target.setHex(0x1b2d52);
  }

  private interpolateHourlySmooth(hourly: HourlyWeatherPoint[], hourFloat: number): void {
    const n = hourly.length;
    if (n === 0) return;

    const scaled = clamp(hourFloat, 0, 23.999);
    const idx0 = Math.min(n - 1, Math.floor(scaled));
    const idx1 = Math.min(n - 1, idx0 + 1);
    const rawFrac = scaled - Math.floor(scaled);
    // Smooth cosine/Hermite easing between hourly forecast anchors so values never kink
    const frac = rawFrac * rawFrac * (3 - 2 * rawFrac);

    const a = hourly[idx0];
    const b = hourly[idx1];

    const temp = lerp(a.temperatureC, b.temperatureC, frac);
    const feels = lerp(a.feelsLikeC, b.feelsLikeC, frac);
    const rain = Math.max(0, lerp(a.rainMm, b.rainMm, frac));
    const cloud = clamp(lerp(a.cloudCoverPct, b.cloudCoverPct, frac), 0, 100);
    const windSpd = Math.max(0, lerp(a.windSpeedKmh, b.windSpeedKmh, frac));
    const windDir = lerpAngleDeg(a.windDirectionDeg, b.windDirectionDeg, frac);
    const hum = clamp(lerp(a.humidityPct, b.humidityPct, frac), 0, 100);
    const code = rawFrac < 0.5 ? a.weatherCode : b.weatherCode;

    this.readout.hourFloat = hourFloat;
    this.readout.timeLabel = formatHourFloat(hourFloat);
    this.readout.temperatureC = Number(temp.toFixed(1));
    this.readout.feelsLikeC = Number(feels.toFixed(1));
    this.readout.rainMm = Number(rain.toFixed(2));
    this.readout.cloudCoverPct = Math.round(cloud);
    this.readout.windSpeedKmh = Number(windSpd.toFixed(1));
    this.readout.windDirectionDeg = Math.round(windDir);
    this.readout.humidityPct = Math.round(hum);
    this.readout.weatherCode = code;
    this.readout.isHighHeat = feels >= 35;
    this.readout.isStorm = code >= 95;
  }

  public update(
    dtSec: number,
    hourFloat: number,
    hourly: HourlyWeatherPoint[],
    cameraPosition: THREE.Vector3
  ): LivePreviewReadout {
    if (!this.isRunning) return this.readout;

    const dt = Math.min(0.1, Math.max(0.001, dtSec));
    this.interpolateHourlySmooth(hourly, hourFloat);
    const r = this.readout;

    // Continuous 0..1 daylight curve — ZERO boolean hard cuts anywhere!
    const dawnBlend = smoothstep(5.35, 6.55, hourFloat);
    const duskBlend = 1 - smoothstep(17.45, 18.65, hourFloat);
    const dayFactor = dawnBlend * duskBlend; // 0 at night -> smoothly 1 by day -> smoothly 0 at night

    const cloud01 = r.cloudCoverPct / 100;

    // 1. Continuous Sky Color + Smooth Overcast Blend + Smooth Midday Heat Haze
    this.sampleSkyBaseColor(hourFloat, this.targetSkyColor);

    // Overcast sky color blends continuously between luminous night-overcast and day-overcast
    this.colorScratchA.setHex(0x2b3c59); // Night overcast slate-blue (never pitch dark!)
    this.colorScratchB.setHex(0x7c8794); // Day overcast grey
    this.colorScratchA.lerp(this.colorScratchB, dayFactor);
    const overcastMix = smoothstep(0.18, 1.0, cloud01) * 0.56;
    this.targetSkyColor.lerp(this.colorScratchA, overcastMix);

    // Continuous high-heat warm haze (ramps smoothly from 34.2°C -> 38°C, zero step jump)
    const heatStrength =
      smoothstep(34.2, 38.5, r.feelsLikeC) * dayFactor * (1 - cloud01 * 0.55) * 0.22;
    if (heatStrength > 0.001) {
      this.colorScratchA.setHex(0xe8bc7d);
      this.targetSkyColor.lerp(this.colorScratchA, heatStrength);
    }

    // Exponential temporal smoothing so sky color never jumps even if weather data spikes
    if (!this.smoothedSkyInitialized) {
      this.currentSkyColor.copy(this.targetSkyColor);
      this.smoothedSkyInitialized = true;
    } else {
      const alpha = 1 - Math.exp(-dt * 7.5);
      this.currentSkyColor.lerp(this.targetSkyColor, alpha);
    }

    // 2. Thunderstorm Lightning Flash (only on storm codes 95+)
    let lightningFlash01 = 0;
    if (r.isStorm) {
      if (this.lightningFlickerSeq.length > 0) {
        this.lightningSubTimer -= dt;
        lightningFlash01 = this.lightningFlickerSeq[this.lightningFlickerIdx] || 0;
        if (this.lightningSubTimer <= 0) {
          this.lightningFlickerIdx++;
          if (this.lightningFlickerIdx >= this.lightningFlickerSeq.length) {
            this.lightningFlickerSeq = [];
            this.nextLightningTimer = 3.5 + ((hourFloat * 19.7) % 4.5);
          } else {
            this.lightningSubTimer = 0.055;
          }
        }
      } else {
        this.nextLightningTimer -= dt;
        if (this.nextLightningTimer <= 0) {
          this.lightningFlickerSeq = [0.95, 0.05, 0.72, 0.0, 0.45];
          this.lightningFlickerIdx = 0;
          this.lightningSubTimer = 0.05;
        }
      }
    } else {
      this.lightningFlickerSeq = [];
    }

    this.colorScratchA.copy(this.currentSkyColor);
    if (lightningFlash01 > 0) {
      this.colorScratchB.setHex(0xdce8ff);
      this.colorScratchA.lerp(this.colorScratchB, lightningFlash01 * 0.8);
    }

    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(this.colorScratchA);
    } else {
      this.scene.background = this.colorScratchA.clone();
    }

    // 3. Visible Sun Arc (05:30 -> 18:30) & Visible Moon Arc (18:00 -> 06:00) in Panoramic Sky!
    // Placed along the northern sky backdrop (z = -72m) sweeping East (+X) -> Zenith -> West (-X)
    // so both the Sun and the Moon travel clearly inside the viewport above the roof!
    const sunArcT = clamp((hourFloat - 5.5) / 13.0, 0, 1);
    const sunAngle = sunArcT * Math.PI; // 0 (East +X) -> PI/2 (Noon) -> PI (West -X)
    const sunSkyX = Math.cos(sunAngle) * 52;
    const sunSkyY = -2 + Math.sin(sunAngle) * 33; // Rises from horizon y=-2 to peak y=31m
    const sunSkyZ = -72 + Math.sin(sunAngle) * 10;
    const sunVis = smoothstep(-1.5, 3.5, sunSkyY) * (1 - cloud01 * 0.42);

    // Warm orange (#FF7B29) at horizon -> crisp sunlight (#FFFDF4) high in sky
    const sunElev01 = clamp(Math.sin(sunAngle), 0, 1);
    this.colorScratchA.setHex(0xff7b29);
    this.colorScratchB.setHex(0xfffdf4);
    this.sunLightColor.copy(this.colorScratchA).lerp(
      this.colorScratchB,
      Math.pow(sunElev01, 0.65)
    );

    if (this.sunMesh && this.sunSphereMat && this.sunGlowSprite) {
      this.sunMesh.position.set(sunSkyX, sunSkyY, sunSkyZ);
      this.sunGlowSprite.position.set(sunSkyX, sunSkyY, sunSkyZ);
      this.sunMesh.visible = sunVis > 0.01;
      this.sunGlowSprite.visible = sunVis > 0.01;
      this.sunSphereMat.color.copy(this.sunLightColor);
      this.sunSphereMat.opacity = clamp(sunVis * 1.15, 0, 1);
      this.sunGlowSprite.material.color.copy(this.sunLightColor);
      this.sunGlowSprite.material.opacity = clamp(sunVis * 0.92, 0, 0.95);
      const glowSz = lerp(26, 19, sunElev01);
      this.sunGlowSprite.scale.set(glowSz, glowSz, 1);
    }

    // Moon travels East (+X) at 18:00 -> Midnight Peak (x=0, y=30m!) -> West (-X) at 06:00
    // Wrap at 12:00 Noon (when dayFactor === 1.0 and Moon weight === 0!) so shadows NEVER jump at 18:00!
    const nightElapsed = hourFloat >= 12.0 ? hourFloat - 18.0 : hourFloat + 6.0;
    const moonArcT = clamp(nightElapsed / 12.0, 0, 1);
    const moonAngle = moonArcT * Math.PI;
    const moonSkyX = Math.cos(moonAngle) * 48;
    const moonSkyY = -2 + Math.sin(moonAngle) * 31;
    const moonSkyZ = -70 + Math.sin(moonAngle) * 10;
    const moonVis = (1 - dayFactor) * smoothstep(-1.5, 3.5, moonSkyY) * (1 - cloud01 * 0.35);

    if (this.moonSprite) {
      this.moonSprite.position.set(moonSkyX, moonSkyY, moonSkyZ);
      this.moonSprite.visible = moonVis > 0.01;
      this.moonSprite.material.opacity = clamp(moonVis * 1.15, 0, 1);
    }

    // Night stars fade in smoothly at night when sky isn't overcast
    if (this.starsMat) {
      this.starsMat.opacity = clamp((1 - dayFactor) * (1 - cloud01 * 0.85) * 0.85, 0, 0.85);
    }

    // 4. Smoothly Blended Directional KeyLight (Crisp Shadows Across All Hours — Clear Moonlit Night!)
    const sunShadowX = Math.cos(sunAngle) * 42;
    const sunShadowY = Math.max(5.5, Math.sin(sunAngle) * 44);
    const sunShadowZ = 14; // Slight southern solar rake for rich 3D wall/eave contrast

    const moonShadowX = Math.cos(moonAngle) * 38;
    const moonShadowY = Math.max(10, Math.sin(moonAngle) * 38);
    const moonShadowZ = 14;

    this.keyLight.position.set(
      lerp(moonShadowX, sunShadowX, dayFactor),
      lerp(moonShadowY, sunShadowY, dayFactor),
      lerp(moonShadowZ, sunShadowZ, dayFactor)
    );
    this.keyLight.color.copy(this.moonLightColor).lerp(this.sunLightColor, dayFactor);

    const dayKeyInt = (0.72 + 1.62 * sunElev01) * (1 - cloud01 * 0.52);
    const nightKeyInt = 1.08 * (1 - cloud01 * 0.22); // Crisp silver moonlight so house is clearly lit at night!
    this.keyLight.intensity =
      lerp(nightKeyInt, dayKeyInt, dayFactor) + lightningFlash01 * 2.8;

    // 5. Balanced Hemisphere Fill + Rim Light (100% Readable Night Walls & Crisp Day Shadows!)
    this.colorScratchA.setHex(0x82a3d8); // Luminous cool moonlight sky fill
    this.colorScratchB.setHex(0xdceeff); // Bright day sky fill
    this.hemiLight.color
      .copy(this.colorScratchA)
      .lerp(this.colorScratchB, dayFactor)
      .lerp(this.currentSkyColor, 0.18 * dayFactor);

    this.colorScratchA.setHex(0x525d75); // Clear night ground bounce so shadow walls stay readable
    this.colorScratchB.setHex(0x8d8577); // Warm earth bounce
    this.hemiLight.groundColor.copy(this.colorScratchA).lerp(this.colorScratchB, dayFactor);
    this.hemiLight.intensity = lerp(0.84, 0.58 + 0.16 * cloud01, dayFactor) + lightningFlash01 * 1.4;

    this.colorScratchA.setHex(0xb8d0ff);
    this.colorScratchB.setHex(0xdce8ff);
    this.rimLight.color.copy(this.colorScratchA).lerp(this.colorScratchB, dayFactor);
    this.rimLight.intensity = lerp(0.5, 0.36, dayFactor);

    // Wetness accumulation on terrain ground
    const rainRate01 = r.rainMm > 0.04 ? clamp(Math.sqrt(r.rainMm / 4.5), 0.14, 1.0) : 0;
    if (rainRate01 > 0) {
      this.wetness01 = clamp(this.wetness01 + dt * (0.3 + rainRate01 * 0.55), 0, 1);
    } else {
      this.wetness01 = clamp(this.wetness01 - dt * 0.14, 0, 1);
    }

    if (this.terrainMat) {
      // Dry warm courtyard stone (#D8D3C6) -> wet slate-stone (#807E78) so ground stays clearly visible at night too
      this.colorScratchA.setHex(0xd8d3c6);
      this.colorScratchB.setHex(0x807e78);
      this.terrainMat.color.copy(this.colorScratchA).lerp(this.colorScratchB, this.wetness01 * 0.72);
      this.terrainMat.roughness = lerp(0.92, 0.18, this.wetness01);
      this.terrainMat.metalness = lerp(0.03, 0.24, this.wetness01);
    }

    // 6. Smooth FogExp2 (scales with humidity, rain, and dawn mist)
    if (this.fogExp2) {
      this.fogExp2.color.copy(this.colorScratchA.copy(this.currentSkyColor));
      const hum01 = clamp((r.humidityPct - 64) / 36, 0, 1);
      const dawnMist =
        smoothstep(4.8, 6.0, hourFloat) * (1 - smoothstep(6.3, 7.8, hourFloat)) * hum01 * 0.0032;
      this.fogExp2.density = 0.0008 + hum01 * 0.0016 + rainRate01 * 0.0034 + dawnMist;
    }

    // 7. Wind Vector
    const windToRad = ((r.windDirectionDeg + 180) * Math.PI) / 180;
    const windDirX = Math.sin(windToRad);
    const windDirZ = -Math.cos(windToRad);
    const windSpeedMps = 1.4 + r.windSpeedKmh * 0.26;

    // 8. Soft, Airy 3D Cumulus Cloud Clusters (subtle & natural — never bulky or intrusive!)
    const twilightGlow =
      (smoothstep(5.4, 6.1, hourFloat) * (1 - smoothstep(6.2, 7.0, hourFloat)) +
        smoothstep(17.2, 17.9, hourFloat) * (1 - smoothstep(18.0, 18.7, hourFloat))) *
      (1 - cloud01 * 0.5);

    this.colorScratchA.setHex(0x4b5f85); // Soft moonlit slate-silver night cloud
    this.colorScratchB.setHex(0xfbfcff); // Airy day cumulus white
    this.cloudColorScratch.copy(this.colorScratchA).lerp(this.colorScratchB, dayFactor);

    if (twilightGlow > 0.01) {
      this.colorScratchB.setHex(0xffa475);
      this.cloudColorScratch.lerp(this.colorScratchB, clamp(twilightGlow, 0, 0.55));
    }
    // Gentle storm tint under heavy cloud cover & rain
    const stormDarken = clamp(cloud01 * 0.26 + rainRate01 * 0.22, 0, 0.42);
    this.colorScratchB.setHex(0x5b6475);
    this.cloudColorScratch.lerp(this.colorScratchB, stormDarken * dayFactor);

    const maxCloudOpacity = lerp(0.24, 0.30 + cloud01 * 0.18, dayFactor); // ~0.24 at night, ~0.30..0.48 by day

    for (let i = 0; i < this.cloudClusters.length; i++) {
      const c = this.cloudClusters[i];
      c.group.position.x += windDirX * windSpeedMps * c.driftFactor * dt;
      c.group.position.z += windDirZ * windSpeedMps * c.driftFactor * dt;

      if (c.group.position.x > 64) c.group.position.x -= 128;
      if (c.group.position.x < -64) c.group.position.x += 128;
      if (c.group.position.z > -16) c.group.position.z -= 52;
      if (c.group.position.z < -68) c.group.position.z += 52;

      // Smoothly emerge/dissolve each cloud cluster based on cloudCoverPct
      const targetActive = smoothstep(c.threshold01 - 0.04, c.threshold01 + 0.10, cloud01);
      const targetScale = targetActive * c.baseScale * (0.82 + cloud01 * 0.22);
      c.currentScale = lerp(c.currentScale, targetScale, 1 - Math.exp(-dt * 4.5));

      c.group.visible = c.currentScale > 0.06;
      if (c.group.visible) {
        c.group.scale.set(c.currentScale * 1.22, c.currentScale * 0.65, c.currentScale * 0.92);
        c.mat.color.copy(this.cloudColorScratch);
        c.mat.opacity = clamp(targetActive * maxCloudOpacity, 0, maxCloudOpacity);
      }
    }

    // 9. High-Visibility Rain Streaks + Ground Splash Ripples
    if (this.rainMesh && this.rainMat && this.splashMesh && this.splashMat) {
      // Sensitive curve so even light rain (0.15mm) shows 420 crisp drops & heavy rain shows 2200!
      const activeDrops =
        r.rainMm > 0.04
          ? Math.min(
              MAX_RAIN_PARTICLES,
              Math.round(360 + clamp(r.rainMm / 4.0, 0, 1) * (MAX_RAIN_PARTICLES - 360))
            )
          : 0;
      this.rainMesh.count = activeDrops;

      if (activeDrops > 0) {
        const fallSpeedScale = 0.95 + rainRate01 * 0.85;
        const slantX = windDirX * (r.windSpeedKmh * 0.34);
        const slantZ = windDirZ * (r.windSpeedKmh * 0.34);

        const camYaw = Math.atan2(cameraPosition.x, cameraPosition.z);
        const tiltZ = clamp(-slantX / 24, -0.48, 0.48);
        const tiltX = clamp(slantZ / 24, -0.48, 0.48);
        this.dummyEuler.set(tiltX, camYaw, tiltZ, 'YXZ');
        this.dummyQuat.setFromEuler(this.dummyEuler);
        this.dummyScale.set(1, 0.85 + rainRate01 * 0.55, 1);

        for (let i = 0; i < activeDrops; i++) {
          const idx3 = i * 3;
          const vy = this.rainSpeeds[i] * fallSpeedScale;
          this.rainPositions[idx3] += slantX * dt;
          this.rainPositions[idx3 + 1] -= vy * dt;
          this.rainPositions[idx3 + 2] += slantZ * dt;

          if (this.rainPositions[idx3 + 1] < 0) {
            this.rainPositions[idx3 + 1] += RAIN_TOP_Y;
          }
          if (this.rainPositions[idx3] > RAIN_BOUNDS_XZ) {
            this.rainPositions[idx3] -= RAIN_BOUNDS_XZ * 2;
          } else if (this.rainPositions[idx3] < -RAIN_BOUNDS_XZ) {
            this.rainPositions[idx3] += RAIN_BOUNDS_XZ * 2;
          }
          if (this.rainPositions[idx3 + 2] > RAIN_BOUNDS_XZ) {
            this.rainPositions[idx3 + 2] -= RAIN_BOUNDS_XZ * 2;
          } else if (this.rainPositions[idx3 + 2] < -RAIN_BOUNDS_XZ) {
            this.rainPositions[idx3 + 2] += RAIN_BOUNDS_XZ * 2;
          }

          this.dummyPos.set(
            this.rainPositions[idx3],
            this.rainPositions[idx3 + 1],
            this.rainPositions[idx3 + 2]
          );
          this.dummyMat4.compose(this.dummyPos, this.dummyQuat, this.dummyScale);
          this.rainMesh.setMatrixAt(i, this.dummyMat4);
        }
        this.rainMesh.instanceMatrix.needsUpdate = true;
        this.rainMat.opacity = clamp(0.68 + rainRate01 * 0.28, 0.65, 0.96);

        // Animate ground splash rings
        const activeSplashes = Math.min(
          MAX_SPLASH_RINGS,
          Math.round(45 + rainRate01 * (MAX_SPLASH_RINGS - 45))
        );
        this.splashMesh.count = activeSplashes;
        for (let i = 0; i < activeSplashes; i++) {
          const idx3 = i * 3;
          let phase = this.splashState[idx3 + 2] + dt * (2.6 + rainRate01 * 1.4);
          if (phase >= 1) {
            phase -= 1;
          }
          this.splashState[idx3 + 2] = phase;
          const sc = 0.5 + phase * 2.8;
          this.dummyPos.set(this.splashState[idx3], 0.02, this.splashState[idx3 + 1]);
          this.dummyScale.set(sc, sc, 1);
          this.dummyMat4.compose(this.dummyPos, this.splashQuat, this.dummyScale);
          this.splashMesh.setMatrixAt(i, this.dummyMat4);
        }
        this.splashMesh.instanceMatrix.needsUpdate = true;
        this.splashMat.opacity = clamp(0.45 + rainRate01 * 0.35, 0.4, 0.8);
      } else {
        this.splashMesh.count = 0;
      }
    }

    return this.readout;
  }
}
