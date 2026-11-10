import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import {
  ArrowLeft,
  Box,
  Cloud,
  CloudRain,
  CloudSun,
  CloudSunRain,
  Cpu,
  Download,
  Droplets,
  MoreVertical,
  Pause,
  PenTool,
  Play,
  RotateCw,
  SunMedium,
  Thermometer,
  WifiOff,
  Wind,
  X,
} from 'lucide-react';
import { HouseMetrics, HouseSpec, ModelFinish, RoofStyle } from '../types';
import { buildHouseModelGroup } from '../geometry/roofBuilder';
import { LANKA_ROOF_NET_META } from '../ai/lankaRoofNet';
import {
  buildClearSkyFallbackDay,
  subscribeWeatherForPoint,
} from '../weather/weatherService';
import {
  LivePreviewReadout,
  WeatherPreviewEngine,
} from '../weather/weatherPreviewEngine';
import {
  DailyForecastItem,
  HourlyWeatherPoint,
  RoofWeatherBundle,
} from '../weather/weatherTypes';

interface ThreeHouseStudioProps {
  spec: HouseSpec | null;
  metrics: HouseMetrics | null;
  isAnalyzingNeural: boolean;
  finish: ModelFinish;
  isActive: boolean;
  onBackToMap: () => void;
  onOpenPrediction: () => void;
  onOpenSolar: () => void;
  onOpenWater: () => void;
  onChangeFinish: (finish: ModelFinish) => void;
  onChangeRoofStyle: (style: RoofStyle) => void;
  onChangeStories: (stories: 1 | 2 | 3) => void;
}

type CameraPreset = 'iso' | 'top' | 'front' | 'side';
type PreviewSpeedSec = 30 | 60 | 120;

function compassFromDeg(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

function createTextBadgeSprite(
  text: string,
  bgHex = '#111111',
  fgHex = '#E2FF32',
  scaleHeight = 0.85
): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontSize = 36;
  ctx.font = `700 ${fontSize}px "IBM Plex Mono", monospace`;
  const textWidth = Math.ceil(ctx.measureText(text).width);
  const padX = 26;
  const padY = 16;
  canvas.width = textWidth + padX * 2;
  canvas.height = fontSize + padY * 2;

  ctx.fillStyle = bgHex;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = fgHex;
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);

  ctx.font = `700 ${fontSize}px "IBM Plex Mono", monospace`;
  ctx.fillStyle = fgHex;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  const mat = new THREE.SpriteMaterial({
    map: tex,
    depthTest: true,
    transparent: true,
  });
  const sprite = new THREE.Sprite(mat);
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(scaleHeight * aspect, scaleHeight, 1);
  return sprite;
}

function disposeObject3D(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    if (mesh.material) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const sm = m as THREE.SpriteMaterial;
        if (sm.map && obj instanceof THREE.Sprite) {
          sm.map.dispose();
        }
        m.dispose();
      }
    }
  });
}

export const ThreeHouseStudio: React.FC<ThreeHouseStudioProps> = ({
  spec,
  metrics,
  isAnalyzingNeural,
  finish,
  isActive,
  onBackToMap,
  onOpenPrediction,
  onOpenSolar,
  onOpenWater,
  onChangeRoofStyle,
  onChangeStories,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const houseHolderRef = useRef<THREE.Group | null>(null);
  const annotationsHolderRef = useRef<THREE.Group | null>(null);
  const gridGroupRef = useRef<THREE.Group | null>(null);
  const previewEngineRef = useRef<WeatherPreviewEngine | null>(null);

  const [autoRotate, setAutoRotate] = useState<boolean>(false);
  const [peakHeightM, setPeakHeightM] = useState<number>(5.0);
  const [showNeuralHud, setShowNeuralHud] = useState<boolean>(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);

  // Export the current 3D house as a binary GLB model file
  const handleExportGLB = useCallback(() => {
    const holder = houseHolderRef.current;
    if (!holder || isExporting) return;
    setIsExporting(true);
    try {
      const exporter = new GLTFExporter();
      exporter.parse(
        holder,
        (result) => {
          const blob = new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `roofmass-house-${Date.now()}.glb`;
          a.click();
          URL.revokeObjectURL(url);
          setIsExporting(false);
        },
        () => setIsExporting(false),
        { binary: true }
      );
    } catch {
      setIsExporting(false);
    }
  }, [isExporting]);

  // Weather Preview Picker & Playback State
  const [weatherBundle, setWeatherBundle] = useState<RoofWeatherBundle | null>(null);
  const [showPreviewConfig, setShowPreviewConfig] = useState<boolean>(false);
  const [selectedDayIdx, setSelectedDayIdx] = useState<number>(0);
  const [previewSpeedSec, setPreviewSpeedSec] = useState<PreviewSpeedSec>(60);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState<boolean>(false);
  const [isPreviewPaused, setIsPreviewPaused] = useState<boolean>(false);
  const [hudReadout, setHudReadout] = useState<LivePreviewReadout>({
    hourFloat: 0,
    timeLabel: '00:00',
    temperatureC: 26,
    feelsLikeC: 29,
    rainMm: 0,
    cloudCoverPct: 20,
    windSpeedKmh: 8,
    windDirectionDeg: 225,
    humidityPct: 80,
    weatherCode: 1,
    isHighHeat: false,
    isStorm: false,
  });

  // Mutable refs read inside the single shared 60fps requestAnimationFrame loop
  const autoRotateRef = useRef<boolean>(false);
  autoRotateRef.current = autoRotate;
  const finishRef = useRef<ModelFinish>(finish);
  finishRef.current = finish;

  const isPreviewPlayingRef = useRef<boolean>(false);
  isPreviewPlayingRef.current = isPreviewPlaying;
  const isPreviewPausedRef = useRef<boolean>(false);
  isPreviewPausedRef.current = isPreviewPaused;
  const previewSpeedSecRef = useRef<PreviewSpeedSec>(60);
  previewSpeedSecRef.current = previewSpeedSec;
  const previewHourRef = useRef<number>(0);
  const isScrubbingRef = useRef<boolean>(false);
  const activeHourlyRef = useRef<HourlyWeatherPoint[]>([]);
  const lastHudSyncMsRef = useRef<number>(0);

  const lastSpecIdRef = useRef<string | null>(null);
  const lastEmergedIdRef = useRef<string | null>(null);
  const emergeScaleYRef = useRef<number>(1);
  const desiredCamPosRef = useRef<THREE.Vector3 | null>(null);
  const desiredTargetRef = useRef<THREE.Vector3 | null>(null);
  const savedPrePreviewCamRef = useRef<{
    pos: THREE.Vector3;
    target: THREE.Vector3;
    maxPolarAngle: number;
  } | null>(null);
  const satTextureRef = useRef<THREE.Texture | null>(null);
  const satUrlLoadedRef = useRef<string | undefined>(undefined);

  // Subscribe to cached / background Open-Meteo 7-day forecast for current roof centroid
  useEffect(() => {
    if (!metrics) {
      setWeatherBundle(null);
      return;
    }
    setSelectedDayIdx(0);
    const unsub = subscribeWeatherForPoint(metrics.centroid, (nextBundle) => {
      setWeatherBundle({ ...nextBundle });
    });
    return unsub;
  }, [metrics?.centroid[0], metrics?.centroid[1]]);

  const fallbackDay = useMemo(() => buildClearSkyFallbackDay(), []);

  const availableDays: DailyForecastItem[] = useMemo(() => {
    if (weatherBundle?.daily && weatherBundle.daily.length > 0) {
      return weatherBundle.daily;
    }
    return [fallbackDay];
  }, [weatherBundle?.daily, fallbackDay]);

  const isOfflineWeather =
    weatherBundle?.sourceBadge === 'OFFLINE' ||
    (!weatherBundle?.isLoadingForecast && (!weatherBundle?.daily || weatherBundle.daily.length === 0));

  const chosenDay: DailyForecastItem =
    availableDays[Math.min(selectedDayIdx, availableDays.length - 1)] || fallbackDay;

  useEffect(() => {
    activeHourlyRef.current =
      chosenDay.hourly && chosenDay.hourly.length > 0
        ? chosenDay.hourly
        : fallbackDay.hourly;
  }, [chosenDay, fallbackDay]);

  // Cleanly stop weather time-lapse & restore exact scene lighting/sky/fog/camera
  const handleExitPreview = useCallback(() => {
    if (previewEngineRef.current?.isRunning) {
      previewEngineRef.current.stopAndRestore();
    }
    isPreviewPlayingRef.current = false;
    setIsPreviewPlaying(false);
    setIsPreviewPaused(false);

    // Restore CAD floor grid & floating dimension annotations
    if (gridGroupRef.current) {
      gridGroupRef.current.visible = true;
    }
    if (annotationsHolderRef.current) {
      annotationsHolderRef.current.visible = true;
    }

    // Ensure background & OrbitControls autoRotate + saved camera match studio UI settings
    if (sceneRef.current) {
      sceneRef.current.background = new THREE.Color(
        finishRef.current === 'blueprint' ? 0x0a1936 : 0xf2f0e8
      );
    }
    if (controlsRef.current) {
      controlsRef.current.autoRotate = autoRotateRef.current;
      if (savedPrePreviewCamRef.current) {
        controlsRef.current.maxPolarAngle = savedPrePreviewCamRef.current.maxPolarAngle;
        desiredCamPosRef.current = savedPrePreviewCamRef.current.pos.clone();
        desiredTargetRef.current = savedPrePreviewCamRef.current.target.clone();
        savedPrePreviewCamRef.current = null;
      }
    }
  }, []);

  const handleStartPreview = () => {
    const engine = previewEngineRef.current;
    if (!engine) return;

    setShowPreviewConfig(false);
    setShowNeuralHud(false);

    // Save pre-preview studio camera & frame a panoramic architectural hero angle
    // so both the grounded house + cast shadows AND the sky (Sun, Moon, 3D clouds, rain) are clearly in view!
    if (cameraRef.current && controlsRef.current) {
      if (!savedPrePreviewCamRef.current) {
        savedPrePreviewCamRef.current = {
          pos: cameraRef.current.position.clone(),
          target: controlsRef.current.target.clone(),
          maxPolarAngle: controlsRef.current.maxPolarAngle,
        };
      }
      controlsRef.current.autoRotate = false;
      controlsRef.current.maxPolarAngle = Math.PI * 0.495;

      const span = Math.max(12, Math.max(metrics?.lengthM || 12, metrics?.widthM || 10));
      const roofPeak = Math.max(4.2, peakHeightM);
      desiredCamPosRef.current = new THREE.Vector3(
        span * 0.32,
        Math.max(3.6, roofPeak * 0.56),
        Math.max(24, span * 1.85)
      );
      desiredTargetRef.current = new THREE.Vector3(0, roofPeak * 0.95 + 3.6, -14);
    }

    // Hide unlit CAD grid/ruler sprites during cinematic weather playback so shadows & night sky stay crisp
    if (gridGroupRef.current) {
      gridGroupRef.current.visible = false;
    }
    if (annotationsHolderRef.current) {
      annotationsHolderRef.current.visible = false;
    }

    previewHourRef.current = 0; // 00:00 -> 24:00 full selected day
    engine.start();
    isPreviewPlayingRef.current = true;
    isPreviewPausedRef.current = false;
    setIsPreviewPlaying(true);
    setIsPreviewPaused(false);

    if (cameraRef.current) {
      const snap = engine.update(
        0.016,
        0,
        activeHourlyRef.current,
        cameraRef.current.position
      );
      setHudReadout({ ...snap });
    }
  };

  // Automatically exit & restore if leaving 3D screen or clearing roof mid-playback
  useEffect(() => {
    if ((!isActive || !spec) && isPreviewPlayingRef.current) {
      handleExitPreview();
    }
    if (!isActive) {
      setShowPreviewConfig(false);
    }
  }, [isActive, spec, handleExitPreview]);

  // Initialize Three.js Studio Scene + Single Shared Clock & RAF Loop
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf2f0e8);
    sceneRef.current = scene;

    const width = Math.max(100, container.clientWidth);
    const height = Math.max(100, container.clientHeight);

    const camera = new THREE.PerspectiveCamera(38, width / height, 0.2, 600);
    camera.position.set(18, 15, 20);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.065;
    controls.maxPolarAngle = Math.PI * 0.488;
    controls.minDistance = 5;
    controls.maxDistance = 140;
    controls.target.set(0, 2.2, 0);
    controls.autoRotateSpeed = 1.2;
    controlsRef.current = controls;

    const cancelGlide = () => {
      desiredCamPosRef.current = null;
      desiredTargetRef.current = null;
    };
    controls.addEventListener('start', cancelGlide);

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xd8d3c5, 0.92);
    hemiLight.position.set(0, 40, 0);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfffaf0, 1.55);
    keyLight.position.set(22, 34, 18);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 2;
    keyLight.shadow.camera.far = 140;
    const d = 34;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    keyLight.shadow.bias = -0.0004;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xdce8ff, 0.48);
    rimLight.position.set(-20, 16, -18);
    scene.add(rimLight);

    const groundGeo = new THREE.PlaneGeometry(240, 240);
    groundGeo.rotateX(-Math.PI / 2);
    const groundMat = new THREE.ShadowMaterial({ color: 0x111111, opacity: 0.16 });
    const groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.position.y = -0.005;
    groundMesh.receiveShadow = true;
    scene.add(groundMesh);

    const gridGroup = new THREE.Group();
    const minorGrid = new THREE.GridHelper(80, 80, 0xc8c4b8, 0xdedbd0);
    minorGrid.position.y = -0.003;
    const majorGrid = new THREE.GridHelper(80, 16, 0x111111, 0xa8a498);
    majorGrid.position.y = -0.001;
    gridGroup.add(minorGrid);
    gridGroup.add(majorGrid);
    scene.add(gridGroup);
    gridGroupRef.current = gridGroup;

    const houseHolder = new THREE.Group();
    scene.add(houseHolder);
    houseHolderRef.current = houseHolder;

    const annotationsHolder = new THREE.Group();
    scene.add(annotationsHolder);
    annotationsHolderRef.current = annotationsHolder;

    const previewEngine = new WeatherPreviewEngine(
      scene,
      hemiLight,
      keyLight,
      rimLight,
      groundMat
    );
    previewEngineRef.current = previewEngine;

    const clock = new THREE.Clock();
    let rafId = 0;

    const animate = () => {
      rafId = requestAnimationFrame(animate);
      const dt = clock.getDelta();

      if (houseHolderRef.current && Math.abs(1 - emergeScaleYRef.current) > 0.001) {
        emergeScaleYRef.current += (1 - emergeScaleYRef.current) * 0.14;
        if (emergeScaleYRef.current > 0.998) emergeScaleYRef.current = 1;
        houseHolderRef.current.scale.y = emergeScaleYRef.current;
      }

      if (desiredCamPosRef.current && desiredTargetRef.current) {
        camera.position.lerp(desiredCamPosRef.current, 0.09);
        controls.target.lerp(desiredTargetRef.current, 0.11);
        if (camera.position.distanceTo(desiredCamPosRef.current) < 0.08) {
          desiredCamPosRef.current = null;
          desiredTargetRef.current = null;
        }
      }

      // Step 24h Weather Preview inside the single shared RAF loop
      if (isPreviewPlayingRef.current && previewEngine.isRunning) {
        if (!isPreviewPausedRef.current && !isScrubbingRef.current) {
          const hoursPerSec = 24 / previewSpeedSecRef.current;
          previewHourRef.current += dt * hoursPerSec;
          if (previewHourRef.current >= 24) {
            previewHourRef.current -= 24;
          }
        }

        const readout = previewEngine.update(
          dt,
          previewHourRef.current,
          activeHourlyRef.current,
          camera.position
        );

        const nowMs = performance.now();
        if (nowMs - lastHudSyncMsRef.current >= 75) {
          lastHudSyncMsRef.current = nowMs;
          setHudReadout({ ...readout });
        }
      }

      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const ro = new ResizeObserver(() => {
      if (!container) return;
      const w = Math.max(80, container.clientWidth);
      const h = Math.max(80, container.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(container);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      if (previewEngine.isRunning) {
        previewEngine.stopAndRestore();
      }
      previewEngineRef.current = null;
      controls.removeEventListener('start', cancelGlide);
      controls.dispose();
      groundGeo.dispose();
      groundMat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.autoRotate = isPreviewPlaying ? false : autoRotate;
    }
  }, [autoRotate, isPreviewPlaying]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || isPreviewPlayingRef.current) return;
    scene.background = new THREE.Color(finish === 'blueprint' ? 0x0a1936 : 0xf2f0e8);
  }, [finish]);

  const [satTexVersion, setSatTexVersion] = useState(0);
  useEffect(() => {
    const url = spec?.satelliteTextureDataUrl;
    if (!url) {
      satUrlLoadedRef.current = undefined;
      if (satTextureRef.current) {
        satTextureRef.current.dispose();
        satTextureRef.current = null;
      }
      return;
    }
    if (url === satUrlLoadedRef.current) return;
    satUrlLoadedRef.current = url;

    const loader = new THREE.TextureLoader();
    loader.load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      if (satTextureRef.current) satTextureRef.current.dispose();
      satTextureRef.current = tex;
      setSatTexVersion((v) => v + 1);
    });
  }, [spec?.satelliteTextureDataUrl]);

  // Rebuild 3D House Model & True-Scale Metric Floor Annotations
  useEffect(() => {
    const houseHolder = houseHolderRef.current;
    const annotationsHolder = annotationsHolderRef.current;
    if (!houseHolder || !annotationsHolder) return;

    while (houseHolder.children.length > 0) {
      const child = houseHolder.children[0];
      houseHolder.remove(child);
      disposeObject3D(child);
    }
    while (annotationsHolder.children.length > 0) {
      const child = annotationsHolder.children[0];
      annotationsHolder.remove(child);
      disposeObject3D(child);
    }

    if (!spec || !metrics || metrics.vertices2D.length < 3) return;

    const { group, totalHeightM } = buildHouseModelGroup(
      spec,
      metrics,
      finish,
      satTextureRef.current
    );
    houseHolder.add(group);
    setPeakHeightM(totalHeightM);

    const pts = metrics.vertices2D;
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

    const lineColor = finish === 'blueprint' ? 0xe2ff32 : 0x111111;
    const dimMat = new THREE.LineBasicMaterial({ color: lineColor });
    const offset = 1.65;

    const spanX = maxX - minX;
    if (spanX > 1.0) {
      const zLine = maxZ + offset;
      const gX = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(minX, 0.03, zLine - 0.35),
        new THREE.Vector3(minX, 0.03, zLine + 0.35),
        new THREE.Vector3(minX, 0.03, zLine),
        new THREE.Vector3(maxX, 0.03, zLine),
        new THREE.Vector3(maxX, 0.03, zLine - 0.35),
        new THREE.Vector3(maxX, 0.03, zLine + 0.35),
      ]);
      annotationsHolder.add(new THREE.Line(gX, dimMat));

      const lblX = createTextBadgeSprite(
        `${metrics.lengthM.toFixed(1)}m`,
        '#111111',
        '#E2FF32',
        0.72
      );
      lblX.position.set(0.5 * (minX + maxX), 0.55, zLine + 0.35);
      annotationsHolder.add(lblX);
    }

    const spanZ = maxZ - minZ;
    if (spanZ > 1.0) {
      const xLine = maxX + offset;
      const gZ = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(xLine - 0.35, 0.03, minZ),
        new THREE.Vector3(xLine + 0.35, 0.03, minZ),
        new THREE.Vector3(xLine, 0.03, minZ),
        new THREE.Vector3(xLine, 0.03, maxZ),
        new THREE.Vector3(xLine - 0.35, 0.03, maxZ),
        new THREE.Vector3(xLine + 0.35, 0.03, maxZ),
      ]);
      annotationsHolder.add(new THREE.Line(gZ, dimMat));

      const lblZ = createTextBadgeSprite(
        `${metrics.widthM.toFixed(1)}m`,
        '#111111',
        '#F9F8F3',
        0.72
      );
      lblZ.position.set(xLine + 0.45, 0.55, 0.5 * (minZ + maxZ));
      annotationsHolder.add(lblZ);
    }

    const northBadge = createTextBadgeSprite('N ↑', '#FF521B', '#FFFFFF', 0.72);
    northBadge.position.set(0, 0.45, minZ - 2.1);
    annotationsHolder.add(northBadge);

    if (lastSpecIdRef.current !== spec.id) {
      lastSpecIdRef.current = spec.id;
      emergeScaleYRef.current = 0.04;
      houseHolder.scale.y = 0.04;

      const radius = Math.max(7.5, Math.hypot(spanX, spanZ) * 0.68);
      desiredTargetRef.current = new THREE.Vector3(0, totalHeightM * 0.38, 0);
      desiredCamPosRef.current = new THREE.Vector3(
        radius * 1.18,
        Math.max(7.5, radius * 0.92 + totalHeightM * 0.45),
        radius * 1.32
      );
    }
  }, [spec, metrics, finish, satTexVersion]);

  const setCameraPreset = (preset: CameraPreset) => {
    if (!metrics) return;
    const radius = Math.max(8, Math.max(metrics.lengthM, metrics.widthM) * 1.18);
    const targetY = peakHeightM * 0.38;
    desiredTargetRef.current = new THREE.Vector3(0, targetY, 0);

    switch (preset) {
      case 'top':
        desiredCamPosRef.current = new THREE.Vector3(0.01, radius * 1.85, 0.05);
        break;
      case 'front':
        desiredCamPosRef.current = new THREE.Vector3(
          0,
          peakHeightM * 0.7 + 2.5,
          radius * 1.55
        );
        break;
      case 'side':
        desiredCamPosRef.current = new THREE.Vector3(
          radius * 1.55,
          peakHeightM * 0.7 + 2.5,
          0
        );
        break;
      case 'iso':
      default:
        desiredCamPosRef.current = new THREE.Vector3(
          radius * 1.05,
          radius * 0.85 + peakHeightM * 0.35,
          radius * 1.18
        );
        break;
    }
  };

  // Smooth architectural upward emerge when entering Fullscreen 3D for a newly selected roof
  useEffect(() => {
    if (isActive && houseHolderRef.current && spec && lastEmergedIdRef.current !== spec.id) {
      lastEmergedIdRef.current = spec.id;
      emergeScaleYRef.current = 0.08;
      houseHolderRef.current.scale.y = 0.08;
    }
  }, [isActive, spec?.id]);

  const handleScrubChange = (nextHour: number) => {
    previewHourRef.current = nextHour;
    if (previewEngineRef.current?.isRunning && cameraRef.current) {
      const snap = previewEngineRef.current.update(
        0.016,
        nextHour,
        activeHourlyRef.current,
        cameraRef.current.position
      );
      setHudReadout({ ...snap });
    }
  };

  const neural = spec?.neuralAnalysis;
  const materialDisplay =
    neural?.predictedMaterial === 'terracotta'
      ? 'Clay Tile'
      : neural?.predictedMaterial === 'concrete'
      ? 'Concrete Slab'
      : 'Sheet / Zinc';

  return (
    <div className="relative w-full h-full flex flex-col bg-[#F2F0E8] overflow-hidden">
      {/* FULLSCREEN 3D TOP BAR */}
      <div className="z-20 px-3.5 pt-3 pb-2 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
        {/* LEFT GROUP — identity, not noise */}
        <div className="flex flex-wrap items-center gap-2 pointer-events-auto">
          <button
            type="button"
            onClick={onBackToMap}
            className="neo-btn btn-secondary px-3 py-1.5 font-mono-tech text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Map</span>
          </button>

          <h1 className="font-mono-tech text-sm font-bold uppercase tracking-wide text-[#111111] px-1">
            3D HOUSE
          </h1>

          {spec && metrics && (
            <div
              className="neo-card-sm chip-neutral px-2.5 py-1.5 font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5 max-w-[52vw] sm:max-w-none"
              title="Your roof identity: area, perches, style, pitch & material — detected by the AI roof scan"
            >
              <Box className="w-3.5 h-3.5 shrink-0 text-[#E2FF32]" />
              <span className="truncate">
                {metrics.areaSqm.toFixed(0)} m² · {metrics.areaPerches.toFixed(1)} PERCH ·{' '}
                {spec.roofStyle.toUpperCase()}
                {spec.roofStyle !== 'flat' ? ` ${Math.round(spec.roofPitchDeg)}°` : ''} ·{' '}
                {materialDisplay.toUpperCase()}
              </span>
            </div>
          )}
        </div>

        {/* RIGHT GROUP — AI status + one ⋮ tools menu (all utilities live here) */}
        <div className="relative flex flex-wrap items-center gap-1.5 pointer-events-auto">
          {spec && (
            <button
              type="button"
              onClick={() => {
                setToolsMenuOpen(false);
                setShowPreviewConfig(false);
                setShowNeuralHud((v) => !v);
              }}
              className={`neo-btn px-2.5 py-1.5 font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5 cursor-pointer ${
                showNeuralHud ? 'bg-[#E2FF32] text-[#111111]' : 'btn-secondary'
              }`}
              title="AI ROOF SCAN — what the neural engine detected about your roof"
            >
              <Cpu className="w-3.5 h-3.5 text-[#FF521B]" />
              <span className="hidden sm:inline">
                {isAnalyzingNeural
                  ? 'AI SCANNING…'
                  : neural
                  ? `AI: ${neural.predictedStyle.toUpperCase()} ${neural.confidencePct}%`
                  : 'AI SCAN'}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setShowPreviewConfig(false);
              setShowNeuralHud(false);
              setToolsMenuOpen((v) => !v);
            }}
            disabled={isPreviewPlaying}
            className={`neo-btn px-2.5 py-1.5 font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1 cursor-pointer disabled:opacity-45 ${
              toolsMenuOpen ? 'bg-[#E2FF32] text-[#111111]' : 'btn-secondary'
            }`}
            title="Camera, view & model tools"
          >
            <MoreVertical className="w-4 h-4" />
            <span className="hidden md:inline">TOOLS</span>
          </button>

          {/* ⋮ TOOLS MENU PANEL */}
          {spec && toolsMenuOpen && !isPreviewPlaying && (
            <div className="absolute right-0 top-full mt-2 w-72 max-sm:w-[min(92vw,320px)] max-sm:right-auto max-sm:left-1/2 max-sm:-translate-x-1/2 neo-card bg-[#F9F8F3] p-3 space-y-3 z-30">
              <div className="flex items-center justify-between border-b border-[#111111]/20 pb-1.5">
                <span className="font-mono-tech text-[11px] font-bold uppercase">
                  VIEW & MODEL TOOLS
                </span>
                <button
                  type="button"
                  onClick={() => setToolsMenuOpen(false)}
                  className="p-0.5 text-[#555550] hover:text-[#111111] cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Orbit toggle */}
              <button
                type="button"
                onClick={() => setAutoRotate((v) => !v)}
                className={`neo-btn w-full px-2.5 py-1.5 font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5 cursor-pointer ${
                  autoRotate ? 'bg-[#E2FF32] text-[#111111]' : 'btn-secondary'
                }`}
              >
                <RotateCw className={`w-3.5 h-3.5 ${autoRotate ? 'animate-spin' : ''}`} />
                <span>{autoRotate ? 'AUTO-ORBIT: ON' : 'AUTO-ORBIT: OFF'}</span>
              </button>

              {/* Camera presets */}
              <div className="space-y-1">
                <div className="menu-row-label">CAMERA VIEW</div>
                <div className="grid grid-cols-4 gap-1">
                  {(['iso', 'top', 'front', 'side'] as CameraPreset[]).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setCameraPreset(preset)}
                      className="py-1.5 font-mono-tech text-[10px] font-bold uppercase border border-[#111111] bg-[#F2F0E8] hover:bg-[#EAE8DF] cursor-pointer"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              {/* Roof style */}
              <div className="space-y-1">
                <div className="menu-row-label">ROOF STYLE</div>
                <div className="grid grid-cols-4 gap-1">
                  {(
                    [
                      { id: 'hip', label: 'Hip' },
                      { id: 'gable', label: 'Gable' },
                      { id: 'flat', label: 'Flat' },
                      { id: 'shed', label: 'Shed' },
                    ] as { id: RoofStyle; label: string }[]
                  ).map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => onChangeRoofStyle(r.id)}
                      className={`py-1.5 font-mono-tech text-[10px] font-bold uppercase border border-[#111111] cursor-pointer ${
                        spec.roofStyle === r.id
                          ? 'bg-[#E2FF32] shadow-[1.5px_1.5px_0px_#111111]'
                          : 'bg-[#F2F0E8] hover:bg-[#EAE8DF]'
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Stories */}
              <div className="space-y-1">
                <div className="menu-row-label">STORIES</div>
                <div className="grid grid-cols-3 gap-1">
                  {([1, 2, 3] as (1 | 2 | 3)[]).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => onChangeStories(st)}
                      className={`py-1.5 font-mono-tech text-[10px] font-bold uppercase border border-[#111111] cursor-pointer ${
                        spec.stories === st
                          ? 'bg-[#111111] text-[#E2FF32]'
                          : 'bg-[#F2F0E8] hover:bg-[#EAE8DF]'
                      }`}
                    >
                      {st}F
                    </button>
                  ))}
                </div>
              </div>

              {/* Export */}
              <button
                type="button"
                onClick={handleExportGLB}
                disabled={isExporting}
                className="neo-btn btn-secondary w-full px-2.5 py-1.5 font-mono-tech text-[11px] font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-45"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{isExporting ? 'EXPORTING…' : 'EXPORT 3D MODEL (.GLB)'}</span>
              </button>
            </div>
          )}

          {spec && (
            <button
              type="button"
              onClick={() => {
                if (isPreviewPlaying) {
                  handleExitPreview();
                } else {
                  setToolsMenuOpen(false);
                  setShowPreviewConfig((v) => !v);
                }
              }}
              className={`neo-btn px-3 py-1.5 font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5 cursor-pointer ${
                isPreviewPlaying
                  ? 'chip-warn'
                  : 'btn-secondary'
              }`}
              title="Cinematic 24-Hour Weather Time-Lapse on Your 3D House"
            >
              <CloudSunRain className="w-3.5 h-3.5" />
              <span>{isPreviewPlaying ? 'EXIT PREVIEW' : 'WEATHER'}</span>
            </button>
          )}

          {/* INLINE PREVIEW WEATHER PICKER PANEL */}
          {spec && showPreviewConfig && !isPreviewPlaying && (
            <div className="absolute right-0 top-full mt-2 w-80 max-sm:w-[min(92vw,340px)] max-sm:right-auto max-sm:left-1/2 max-sm:-translate-x-1/2 neo-card bg-[#F9F8F3] p-3.5 space-y-3 z-30">
              <div className="flex items-center justify-between border-b border-[#111111]/20 pb-1.5">
                <span className="font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5">
                  <CloudSunRain className="w-3.5 h-3.5 text-[#FF521B]" />
                  <span>24H WEATHER TIME-LAPSE</span>
                </span>
                <button
                  type="button"
                  onClick={() => setShowPreviewConfig(false)}
                  className="p-0.5 text-[#555550] hover:text-[#111111] cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {isOfflineWeather && (
                <div className="px-2 py-1 bg-[#FF521B] text-white border border-[#111111] font-mono-tech text-[10px] font-bold uppercase flex items-center gap-1.5">
                  <WifiOff className="w-3 h-3" />
                  <span>OFFLINE DATA · CLEAR-SKY FALLBACK</span>
                </div>
              )}

              {/* 7-Day Selector */}
              <div className="space-y-1.5">
                <div className="font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
                  SELECT FORECAST DAY (00:00 → 24:00)
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {availableDays.slice(0, 7).map((d, idx) => {
                    const isSel = idx === selectedDayIdx;
                    return (
                      <button
                        key={d.date}
                        type="button"
                        onClick={() => setSelectedDayIdx(idx)}
                        className={`p-1.5 text-left font-mono-tech uppercase border border-[#111111] cursor-pointer transition-colors ${
                          isSel
                            ? 'bg-[#E2FF32] text-[#111111] shadow-[2px_2px_0px_#111111]'
                            : 'bg-[#F2F0E8] text-[#111111] hover:bg-[#EAE8DF]'
                        }`}
                      >
                        <div className="text-[10px] font-bold truncate">{d.dayShort}</div>
                        <div className="text-[9px] text-[#555550]">
                          {d.rawTempMaxC.toFixed(0)}°/{d.rawRainSumMm.toFixed(0)}MM
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Speed / Duration Selector */}
              <div className="space-y-1.5">
                <div className="font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
                  PLAYBACK DURATION
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {([30, 60, 120] as PreviewSpeedSec[]).map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      onClick={() => setPreviewSpeedSec(sec)}
                      className={`py-1.5 font-mono-tech text-[11px] font-bold uppercase border border-[#111111] cursor-pointer ${
                        previewSpeedSec === sec
                          ? 'bg-[#111111] text-[#E2FF32]'
                          : 'bg-[#F2F0E8] text-[#111111] hover:bg-[#EAE8DF]'
                      }`}
                    >
                      {sec}S {sec === 60 ? '(DEF)' : ''}
                    </button>
                  ))}
                </div>
              </div>

              {/* Big Lime Play Button */}
              <button
                type="button"
                onClick={handleStartPreview}
                className="neo-btn w-full py-2.5 bg-[#E2FF32] text-[#111111] font-mono-tech text-xs font-bold uppercase flex items-center justify-center gap-2 cursor-pointer"
              >
                <Play className="w-4 h-4 fill-[#111111]" />
                <span>▶ PLAY PREVIEW</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* LIVE LANKAROOFNET NEURAL IDENTIFICATION DIAGNOSTIC CARD */}
      {spec && neural && showNeuralHud && !isPreviewPlaying && (
        <div className="absolute left-3.5 top-14 z-10 w-64 neo-card p-2.5 bg-[#F9F8F3]/96 pointer-events-auto">
          <div className="flex items-center justify-between border-b border-[#111111]/20 pb-1.5 mb-2">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 bg-[#FF521B]" />
              <span className="font-mono-tech text-[10px] font-bold uppercase tracking-tight">
                LankaRoofNet CNN ({(LANKA_ROOF_NET_META.totalParameters / 1000).toFixed(1)}k params)
              </span>
            </div>
            <span className="font-mono-tech text-[9px] font-semibold px-1 bg-[#111111] text-[#E2FF32]">
              {neural.inferenceTimeMs}ms
            </span>
          </div>

          <div className="flex gap-2.5 items-center">
            {neural.neuralScanDataUrl && (
              <div className="w-16 h-16 shrink-0 border-1.5 border-[#111111] bg-[#111111] overflow-hidden relative">
                <img
                  src={neural.neuralScanDataUrl}
                  alt="Rectified Neural Roof Scan"
                  className="w-full h-full object-cover"
                />
              </div>
            )}

            <div className="flex-1 min-w-0 space-y-1 font-mono-tech text-[10px]">
              <div className="font-bold text-[#111111] uppercase truncate">
                {neural.predictedStyle} Roof · {neural.confidencePct}%
              </div>
              <div className="text-[#444440] truncate">
                Surface: <span className="font-semibold text-[#111111]">{materialDisplay}</span>
              </div>
              <div className="text-[#444440] truncate">
                Shadow:{' '}
                <span className="font-semibold text-[#111111]">
                  {neural.shadowDepthM}m → {neural.inferredStories}F
                </span>
              </div>
            </div>
          </div>

          <div className="mt-2 pt-1.5 border-t border-[#111111]/15 grid grid-cols-4 gap-1">
            {(['hip', 'gable', 'flat', 'shed'] as RoofStyle[]).map((st) => {
              const pct = Math.round((neural.styleProbabilities[st] || 0) * 100);
              const isTop = neural.predictedStyle === st;
              return (
                <div key={st} className="space-y-0.5">
                  <div className="flex justify-between font-mono-tech text-[8px] uppercase font-bold">
                    <span>{st}</span>
                    <span>{pct}%</span>
                  </div>
                  <div className="h-1.5 w-full bg-[#EAE8DF] border border-[#111111]">
                    <div
                      className={`h-full ${isTop ? 'bg-[#FF521B]' : 'bg-[#111111]'}`}
                      style={{ width: `${Math.max(4, pct)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* THREE.JS VIEWPORT */}
      <div
        ref={mountRef}
        className="relative flex-1 w-full min-h-0 cursor-grab active:cursor-grabbing"
      />

      {/* CLEAN EMPTY STATE BEFORE USER TAPS CORNERS */}
      {!spec && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none p-6">
          <div className="neo-card p-5 bg-[#F9F8F3] max-w-xs text-center space-y-2.5">
            <div className="w-10 h-10 mx-auto bg-[#E2FF32] border-2 border-[#111111] shadow-[2px_2px_0px_#111111] flex items-center justify-center">
              <PenTool className="w-5 h-5 text-[#111111]" />
            </div>
            <h3 className="font-bold text-sm uppercase tracking-wide">
              Tap Your Roof Corners on the Map
            </h3>
            <p className="text-xs text-[#444440] leading-relaxed">
              Tap the corners around any Sri Lankan house roof, then click Corner #1 (or{' '}
              <span className="font-mono-tech font-bold text-[#111111]">Finish</span>).{' '}
              <span className="font-semibold text-[#111111]">The AI roof scan</span> will
              automatically identify the roof structure, pitch & height and build your 3D model.
            </p>
          </div>
        </div>
      )}

      {/* ===== BOTTOM-CENTER ACTION DOCK — THE one lime next-step group ===== */}
      {spec && !isPreviewPlaying && (
        <div className="absolute bottom-3.5 left-1/2 -translate-x-1/2 z-20 pointer-events-auto w-[min(96vw,680px)]">
          <div className="flex border-2 border-[#111111] shadow-[4px_4px_0px_#111111] bg-[#F9F8F3]">
            <button
              type="button"
              onClick={() => {
                setToolsMenuOpen(false);
                setShowNeuralHud(false);
                setShowPreviewConfig((v) => !v);
              }}
              className="flex-1 btn-primary py-2.5 px-1 font-mono-tech text-[11px] sm:text-[13px] font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer border-r-2 border-[#111111] hover:bg-[#d4f020] transition-colors"
              title="Watch the forecast come alive on your house"
            >
              <CloudSunRain className="w-4 h-4 shrink-0" />
              <span>WEATHER PLAY</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setShowPreviewConfig(false);
                onOpenPrediction();
              }}
              className="flex-1 btn-primary py-2.5 px-1 font-mono-tech text-[11px] sm:text-[13px] font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer border-r-2 border-[#111111] hover:bg-[#d4f020] transition-colors"
              title="Weather, climate, soil & roof impact numbers"
            >
              <CloudSun className="w-4 h-4 shrink-0" />
              <span>PREDICTION</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setShowPreviewConfig(false);
                onOpenWater();
              }}
              className="flex-1 btn-primary py-2.5 px-1 font-mono-tech text-[11px] sm:text-[13px] font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer hover:bg-[#d4f020] transition-colors"
              title="Design rain gutters & a tank, then watch rain fill it"
            >
              <Droplets className="w-4 h-4 shrink-0" />
              <span>WATER</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setShowPreviewConfig(false);
                onOpenSolar();
              }}
              className="flex-1 btn-primary py-2.5 px-1 font-mono-tech text-[11px] sm:text-[13px] font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer border-l-2 border-[#111111] hover:bg-[#d4f020] transition-colors"
              title="Design rooftop solar & see your payback"
            >
              <SunMedium className="w-4 h-4 shrink-0" />
              <span>SOLAR DESIGN</span>
            </button>
          </div>
        </div>
      )}

      {/* CINEMATIC WEATHER PREVIEW TIMELINE HUD (DURING PLAYBACK) */}
      {spec && isPreviewPlaying && (
        <div className="absolute bottom-3.5 left-3.5 right-3.5 z-20 pointer-events-auto">
          <div className="max-w-5xl mx-auto neo-card bg-[#F9F8F3]/96 p-3 space-y-2.5">
            {/* 24-HOUR DRAGGABLE SCRUBBER */}
            <div className="space-y-1">
              <div className="relative h-5 flex items-center">
                <div className="w-full h-3 bg-[#EAE8DF] border border-[#111111] overflow-hidden">
                  <div
                    className="h-full bg-[#E2FF32] border-r-2 border-[#111111]"
                    style={{
                      width: `${Math.min(100, Math.max(0, (hudReadout.hourFloat / 24) * 100))}%`,
                    }}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={23.98}
                  step={0.04}
                  value={hudReadout.hourFloat}
                  onPointerDown={() => {
                    isScrubbingRef.current = true;
                  }}
                  onPointerUp={() => {
                    isScrubbingRef.current = false;
                  }}
                  onBlur={() => {
                    isScrubbingRef.current = false;
                  }}
                  onChange={(e) => handleScrubChange(Number(e.target.value))}
                  aria-label="24-hour weather timeline scrubber"
                  className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize"
                />
                {/* Playhead Handle */}
                <div
                  className="pointer-events-none absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-5 bg-[#FF521B] border-2 border-[#111111] shadow-[1.5px_1.5px_0px_#111111]"
                  style={{
                    left: `${Math.min(100, Math.max(0, (hudReadout.hourFloat / 24) * 100))}%`,
                  }}
                />
              </div>

              <div className="flex justify-between font-mono-tech text-[9px] font-bold uppercase text-[#555550]">
                <span>00:00 NIGHT</span>
                <span>06:00 DAWN</span>
                <span>12:00 NOON</span>
                <span>18:00 DUSK</span>
                <span>24:00</span>
              </div>
            </div>

            {/* LIVE READOUT CHIPS + PLAYBACK CONTROLS */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5 font-mono-tech uppercase">
                {/* Simulated Clock */}
                <div className="px-2.5 py-1 bg-[#111111] text-[#E2FF32] text-xs font-bold border border-[#111111]">
                  {chosenDay.dayShort} · {hudReadout.timeLabel}
                </div>

                {/* Temp Chip */}
                <div className="px-2 py-1 bg-[#F2F0E8] border border-[#111111] text-[11px] font-bold flex items-center gap-1">
                  <Thermometer className="w-3 h-3 text-[#FF521B]" />
                  <span>{hudReadout.temperatureC.toFixed(1)}°C</span>
                  {hudReadout.isHighHeat && (
                    <span className="px-1 bg-[#FF521B] text-white text-[9px]">HEAT</span>
                  )}
                </div>

                {/* Rain Chip */}
                <div className="px-2 py-1 bg-[#F2F0E8] border border-[#111111] text-[11px] font-bold flex items-center gap-1">
                  <CloudRain className="w-3 h-3 text-[#111111]" />
                  <span>{hudReadout.rainMm.toFixed(1)} MM</span>
                  {hudReadout.isStorm && (
                    <span className="px-1 bg-[#111111] text-[#E2FF32] text-[9px]">STORM</span>
                  )}
                </div>

                {/* Cloud Chip */}
                <div className="px-2 py-1 bg-[#F2F0E8] border border-[#111111] text-[11px] font-bold flex items-center gap-1">
                  <Cloud className="w-3 h-3 text-[#111111]" />
                  <span>{hudReadout.cloudCoverPct}%</span>
                </div>

                {/* Wind Chip */}
                <div className="px-2 py-1 bg-[#F2F0E8] border border-[#111111] text-[11px] font-bold flex items-center gap-1">
                  <Wind className="w-3 h-3 text-[#111111]" />
                  <span>
                    {hudReadout.windSpeedKmh.toFixed(0)} KM/H{' '}
                    {compassFromDeg(hudReadout.windDirectionDeg)}
                  </span>
                </div>

                {isOfflineWeather && (
                  <div className="px-2 py-1 bg-[#FF521B] text-white border border-[#111111] text-[10px] font-bold flex items-center gap-1">
                    <WifiOff className="w-3 h-3" />
                    <span>OFFLINE DATA</span>
                  </div>
                )}
              </div>

              {/* Pause/Resume + Speed Toggle + Exit Preview */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setIsPreviewPaused((p) => !p)}
                  className="neo-btn chip-neutral px-2.5 py-1 font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1 cursor-pointer"
                >
                  {isPreviewPaused ? (
                    <>
                      <Play className="w-3.5 h-3.5 fill-[#111111]" />
                      <span>RESUME</span>
                    </>
                  ) : (
                    <>
                      <Pause className="w-3.5 h-3.5" />
                      <span>PAUSE</span>
                    </>
                  )}
                </button>

                <div className="flex border border-[#111111] bg-[#EAE8DF]">
                  {([30, 60, 120] as PreviewSpeedSec[]).map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      onClick={() => setPreviewSpeedSec(sec)}
                      className={`px-2 py-1 font-mono-tech text-[10px] font-bold uppercase cursor-pointer ${
                        previewSpeedSec === sec
                          ? 'bg-[#111111] text-[#E2FF32]'
                          : 'text-[#111111] hover:bg-[#F9F8F3]'
                      }`}
                    >
                      {sec}S
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={handleExitPreview}
                  className="neo-btn chip-warn px-3 py-1 font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>EXIT PREVIEW</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* (Roof style / stories editing moved into the ⋮ TOOLS menu — one overlay at a time) */}
    </div>
  );
};
