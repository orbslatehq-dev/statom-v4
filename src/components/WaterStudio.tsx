import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  ArrowLeft,
  CalendarDays,
  Check,
  CloudRain,
  Copy,
  Droplet,
  Droplets,
  Pause,
  Play,
  RotateCw,
  Wallet,
  Wrench,
  X,
} from 'lucide-react';
import { HouseMetrics, HouseSpec, ModelFinish } from '../types';
import { buildHouseModelGroup } from '../geometry/roofBuilder';
import { designDrainage, DrainagePlan, planRunoffCoefficient } from '../water/drainageEngine';
import {
  dailyDemandL,
  estimateCosts,
  ReuseSettings,
  simulateDay,
  simulateYear,
  WaterDaySim,
  WaterYearSim,
} from '../water/waterFlowSim';
import { WATER_CONFIG } from '../water/waterConfig';
import { subscribeWeatherForPoint, buildClearSkyFallbackDay } from '../weather/weatherService';
import { DailyForecastItem, RoofWeatherBundle } from '../weather/weatherTypes';

interface WaterStudioProps {
  spec: HouseSpec | null;
  metrics: HouseMetrics | null;
  finish: ModelFinish;
  isActive: boolean;
  onBackToStudio: () => void;
}

type StudioTab = 'day' | 'year' | 'reuse' | 'costs' | 'care';
type PreviewSpeedSec = 30 | 60 | 120;

interface TankTooltip {
  x: number;
  y: number;
  levelL: number;
  capL: number;
  inflowLph: number;
  hourLabel: string;
  overflowing: boolean;
}

function makeLabelSprite(text: string, bg = '#111111', fg = '#E2FF32', h = 0.55): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontSize = 34;
  ctx.font = `700 ${fontSize}px "IBM Plex Mono", monospace`;
  const w = Math.ceil(ctx.measureText(text).width) + 26;
  canvas.width = w;
  canvas.height = fontSize + 24;
  const c2 = canvas.getContext('2d')!;
  c2.fillStyle = bg;
  c2.fillRect(0, 0, canvas.width, canvas.height);
  c2.strokeStyle = fg;
  c2.lineWidth = 3;
  c2.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  c2.font = `700 ${fontSize}px "IBM Plex Mono", monospace`;
  c2.fillStyle = fg;
  c2.textAlign = 'center';
  c2.textBaseline = 'middle';
  c2.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true }));
  sprite.scale.set(h * (canvas.width / canvas.height), h, 1);
  return sprite;
}

export const WaterStudio: React.FC<WaterStudioProps> = ({
  spec,
  metrics,
  finish,
  isActive,
  onBackToStudio,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const addonsRef = useRef<THREE.Group | null>(null);
  const tankMeshesRef = useRef<THREE.Mesh[]>([]);
  const waterMeshRef = useRef<THREE.Mesh | null>(null);
  const rainLinesRef = useRef<THREE.LineSegments | null>(null);
  const rainVelRef = useRef<Float32Array | null>(null);
  const gutterStripsRef = useRef<THREE.Mesh[]>([]);
  const inletJetRef = useRef<THREE.Mesh | null>(null);
  const rippleRef = useRef<THREE.Mesh | null>(null);
  const reuseGroupRef = useRef<THREE.Group | null>(null);
  const flowCurvesRef = useRef<{ curve: THREE.CatmullRomCurve3; points: THREE.Points; ts: Float32Array; len: number }[]>([]);
  const sunLightRef = useRef<THREE.DirectionalLight | null>(null);
  const simRef = useRef<WaterDaySim | null>(null);

  const [bundle, setBundle] = useState<RoofWeatherBundle | null>(null);
  const [plan, setPlan] = useState<DrainagePlan | null>(null);
  const [hasDesigned, setHasDesigned] = useState(false);
  const [annualHarvestL, setAnnualHarvestL] = useState(0);
  const [activeTab, setActiveTab] = useState<StudioTab>('day');
  const [dayIdx, setDayIdx] = useState(0);
  const [speedSec, setSpeedSec] = useState<PreviewSpeedSec>(60);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tooltip, setTooltip] = useState<TankTooltip | null>(null);
  const [reuse, setReuse] = useState<ReuseSettings>({
    garden: true,
    toiletPersons: 4,
    wash: false,
    animalsL: 0,
    pump: false,
  });
  const [hud, setHud] = useState({ timeLabel: '00:00', rainMm: 0, inflowL: 0, tankL: 0, overflow: false });

  const playingRef = useRef(false);
  playingRef.current = isPlaying;
  const pausedRef = useRef(false);
  pausedRef.current = isPaused;
  const speedRef = useRef<PreviewSpeedSec>(60);
  speedRef.current = speedSec;
  const hourRef = useRef(0);
  const scrubbingRef = useRef(false);
  const autoRotateRef = useRef(false);
  autoRotateRef.current = autoRotate;
  const desiredCamRef = useRef<{ pos: THREE.Vector3; tgt: THREE.Vector3 } | null>(null);

  // ---- weather data subscription ----
  useEffect(() => {
    if (!metrics) return;
    const unsub = subscribeWeatherForPoint(metrics.centroid, (next) => setBundle({ ...next }));
    return unsub;
  }, [metrics?.centroid[0], metrics?.centroid[1]]);

  const availableDays: DailyForecastItem[] = useMemo(() => {
    if (bundle?.daily && bundle.daily.length > 0) return bundle.daily;
    return [buildClearSkyFallbackDay()];
  }, [bundle?.daily]);

  const normals = bundle?.climateNormals ?? [];
  const runoff = spec ? planRunoffCoefficient(spec) : 0.8;

  // Annual harvest: from real monthly normals once loaded, sensible SL fallback meanwhile
  useEffect(() => {
    if (!metrics) return;
    if (normals.length === 12) {
      const mm = normals.reduce((s, n) => s + n.totalRainfallMm, 0);
      setAnnualHarvestL(Math.round(mm * metrics.areaSqm * runoff));
    } else {
      setAnnualHarvestL(Math.round(1800 * metrics.areaSqm * runoff));
    }
  }, [metrics?.areaSqm, normals.length, runoff, metrics]);

  // ---- design once on entry ----
  useEffect(() => {
    if (!isActive || !spec || !metrics) return;
    setPlan(designDrainage(spec, metrics, annualHarvestL));
    setHasDesigned(true);
    // start on the rainiest forecast day for the full show
    if (bundle?.daily && bundle.daily.length > 1) {
      let best = 0;
      bundle.daily.forEach((d, i) => {
        if (d.rawRainSumMm > bundle.daily[best].rawRainSumMm) best = i;
      });
      setDayIdx(best);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, spec?.id, annualHarvestL > 0]);

  const chosenDay = availableDays[Math.min(dayIdx, availableDays.length - 1)];

  // ---- sims ----
  const simDay: WaterDaySim | null = useMemo(() => {
    if (!plan || !chosenDay) return null;
    return simulateDay(chosenDay, plan, runoff, reuse, 0);
  }, [plan, chosenDay, runoff, reuse]);

  simRef.current = simDay;

  const yearSim: WaterYearSim | null = useMemo(() => {
    if (!plan || !metrics) return null;
    return simulateYear(
      normals.length === 12
        ? normals
        : Array.from({ length: 12 }, (_, i) => ({
            monthIndex: i,
            monthShort: ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][i],
            totalRainfallMm: 150,
            meanTempMaxC: 31,
            meanTempMinC: 24,
            meanDailyGhiKwhM2: 5.2,
          })),
      metrics.areaSqm,
      runoff,
      plan,
      reuse
    );
  }, [plan, metrics, normals, runoff, reuse]);

  const costs = useMemo(() => (plan ? estimateCosts(plan, reuse.pump) : null), [plan, reuse.pump]);

  // ---- scene mount (only while active) ----
  useEffect(() => {
    if (!isActive || !spec || !metrics || !plan) return;
    const container = mountRef.current;
    if (!container) return;
    let cancelled = false;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf2f0e8);
    sceneRef.current = scene;

    const width = Math.max(100, container.clientWidth);
    const height = Math.max(100, container.clientHeight);
    const camera = new THREE.PerspectiveCamera(38, width / height, 0.2, 600);
    camera.position.set(18, 15, 20);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
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
    controls.minDistance = 4.5;
    controls.maxDistance = 140;
    controls.autoRotateSpeed = 1.1;
    controlsRef.current = controls;

    const hemi = new THREE.HemisphereLight(0xffffff, 0xd8d3c5, 0.94);
    hemi.position.set(0, 42, 0);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfffaf0, 1.85);
    sun.position.set(18, 34, 16);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 120;
    const d = 30;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.bias = -0.0005;
    scene.add(sun);
    sunLightRef.current = sun;
    const fill = new THREE.DirectionalLight(0xdce8ff, 0.42);
    fill.position.set(-20, 16, -18);
    scene.add(fill);

    const shadowGeo = new THREE.PlaneGeometry(180, 180);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.ShadowMaterial({ opacity: 0.22 });
    const shadowPlane = new THREE.Mesh(shadowGeo, shadowMat);
    shadowPlane.position.y = 0.005;
    shadowPlane.receiveShadow = true;
    scene.add(shadowPlane);
    const grid = new THREE.GridHelper(80, 40, 0xbab5a6, 0xdad6c9);
    grid.position.y = 0.01;
    scene.add(grid);

    const houseHolder = new THREE.Group();
    const built = buildHouseModelGroup(spec, metrics, finish);
    houseHolder.add(built.group);
    scene.add(houseHolder);

    const addons = new THREE.Group();
    scene.add(addons);
    addonsRef.current = addons;

    // ===== DRAINAGE ADD-ONS =====
    const tx = plan.tank.pos[0];
    const tz = plan.tank.pos[1];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, ccx = 0, ccz = 0;
    for (const p of metrics.vertices2D) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
      ccx += p.x; ccz += p.z;
    }
    ccx /= metrics.vertices2D.length;
    ccz /= metrics.vertices2D.length;

    const gutterMat = new THREE.MeshStandardMaterial({ color: 0x232a31, roughness: 0.45, metalness: 0.6 });
    const pipeMat = new THREE.MeshPhongMaterial({ color: 0xb9c2c9, shininess: 30, transparent: true, opacity: 0.55 });
    const waterBlue = 0x35b6ef;

    // Real half-round U-channel gutter: floor + 2 walls + hanging brackets
    const buildGutter = (len: number): THREE.Group => {
      const grp = new THREE.Group();
      const floor = new THREE.Mesh(new THREE.BoxGeometry(len, 0.04, 0.2), gutterMat);
      floor.position.y = -0.05;
      const wallL = new THREE.Mesh(new THREE.BoxGeometry(len, 0.14, 0.03), gutterMat);
      wallL.position.set(0, 0.02, 0.095);
      const wallR = wallL.clone();
      wallR.position.z = -0.095;
      grp.add(floor, wallL, wallR);
      const brackets = Math.max(2, Math.floor(len / 1.6));
      for (let i = 0; i < brackets; i++) {
        const bx = -len / 2 + ((i + 0.5) * len) / brackets;
        const br = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.18, 0.035), gutterMat);
        br.position.set(bx, -0.16, 0);
        grp.add(br);
      }
      return grp;
    };

    for (const g of plan.gutters) {
      const dx = g.b[0] - g.a[0];
      const dz = g.b[2] - g.a[2];
      const len = Math.hypot(dx, dz);
      const mx = (g.a[0] + g.b[0]) / 2;
      const mz = (g.a[2] + g.b[2]) / 2;
      const ox = mx - ccx;
      const oz = mz - ccz;
      const ol = Math.hypot(ox, oz) || 1;
      const gut = buildGutter(len);
      gut.position.set(mx + (ox / ol) * 0.06, g.a[1] - 0.1, mz + (oz / ol) * 0.06);
      gut.rotation.y = -Math.atan2(dz, dx);
      gut.traverse((o) => {
        (o as THREE.Mesh).castShadow = true;
      });
      addons.add(gut);

      // visible water strip inside the channel (fades in with rain)
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(len * 0.98, 0.025, 0.13),
        new THREE.MeshBasicMaterial({ color: waterBlue, transparent: true, opacity: 0 })
      );
      strip.position.set(mx + (ox / ol) * 0.06, g.a[1] - 0.115, mz + (oz / ol) * 0.06);
      strip.rotation.y = -Math.atan2(dz, dx);
      addons.add(strip);
      gutterStripsRef.current.push(strip);
    }

    // flow-particle factory: bright blue drops riding a curve (visible through translucent pipes)
    const addFlow = (curve: THREE.CatmullRomCurve3, N: number, approxLen: number) => {
      const positions = new Float32Array(N * 3);
      const ts = new Float32Array(N);
      for (let i = 0; i < N; i++) ts[i] = i / N;
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const pm = new THREE.PointsMaterial({ color: waterBlue, size: 0.14, transparent: true, opacity: 0.95 });
      const pts = new THREE.Points(pg, pm);
      pts.visible = false;
      addons.add(pts);
      flowCurvesRef.current.push({ curve, points: pts, ts, len: Math.max(1, approxLen) });
    };

    for (const dp of plan.downpipes) {
      const v = dp.path.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
      const curve = new THREE.CatmullRomCurve3(v, false, 'catmullrom', 0.0);
      const tube = new THREE.TubeGeometry(curve, 48, 0.055, 14, false);
      const mesh = new THREE.Mesh(tube, pipeMat);
      mesh.castShadow = true;
      addons.add(mesh);

      // hopper at gutter drop
      const hop = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.22, 0.26), gutterMat);
      hop.position.set(dp.path[0][0], dp.path[0][1] - 0.17, dp.path[0][2]);
      addons.add(hop);

      addFlow(curve, 130, dp.pathLengthM);
    }

    // visible water flow ALONG the open gutters toward each downpipe
    for (const g of plan.gutters) {
      if (!g.downpipeAt) continue;
      const dropEnd = g.downpipeAt === 'a' ? g.a : g.b;
      const farEnd = g.downpipeAt === 'a' ? g.b : g.a;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(farEnd[0], g.a[1] - 0.13, farEnd[2]),
        new THREE.Vector3(dropEnd[0], g.a[1] - 0.13, dropEnd[2]),
      ]);
      const glen = Math.hypot(dropEnd[0] - farEnd[0], dropEnd[2] - farEnd[2]);
      addFlow(curve, 90, glen);
    }

    // ===== TANK =====
    const tankGroup = new THREE.Group();
    const wallMat = new THREE.MeshPhongMaterial({
      color: 0x2e6fb0,
      transparent: true,
      opacity: 0.45,
      shininess: 60,
    });
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(plan.tank.radiusM, plan.tank.radiusM, plan.tank.heightM, 28, 1, true), wallMat);
    wall.position.set(tx, plan.tank.heightM / 2, tz);
    tankGroup.add(wall);
    const bottom = new THREE.Mesh(
      new THREE.CircleGeometry(plan.tank.radiusM, 28),
      new THREE.MeshBasicMaterial({ color: 0x1c3a5e, side: THREE.DoubleSide })
    );
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.set(tx, 0.02, tz);
    tankGroup.add(bottom);
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(plan.tank.radiusM, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshPhongMaterial({ color: 0x245a94, shininess: 50 })
    );
    dome.position.set(tx, plan.tank.heightM, tz);
    dome.castShadow = true;
    tankGroup.add(dome);

    const water = new THREE.Mesh(
      new THREE.CylinderGeometry(plan.tank.radiusM * 0.93, plan.tank.radiusM * 0.93, 1, 24),
      new THREE.MeshPhongMaterial({ color: 0x2fa3d7, transparent: true, opacity: 0.85, shininess: 90 })
    );
    water.position.set(tx, 0.01, tz);
    water.scale.y = 0.001;
    tankGroup.add(water);
    waterMeshRef.current = water;

    // inlet jet + splash ripple (animate while water pours in)
    const jet = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.032, 0.5, 10),
      new THREE.MeshBasicMaterial({ color: waterBlue, transparent: true, opacity: 0.9 })
    );
    jet.position.set(plan.tank.inlet[0], plan.tank.inlet[1] - 0.32, plan.tank.inlet[2]);
    jet.visible = false;
    tankGroup.add(jet);
    inletJetRef.current = jet;
    const ripple = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.17, 22),
      new THREE.MeshBasicMaterial({ color: 0x9fdcf5, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
    );
    ripple.rotation.x = -Math.PI / 2;
    ripple.position.set(plan.tank.inlet[0], 0.07, plan.tank.inlet[2]);
    ripple.visible = false;
    tankGroup.add(ripple);
    rippleRef.current = ripple;

    const inletLabel = makeLabelSprite(`TANK ${plan.tank.capacityL.toLocaleString()} L`, '#111111', '#E2FF32', 0.5);
    inletLabel.position.set(tx, plan.tank.topY + 0.55, tz);
    tankGroup.add(inletLabel);

    // reuse plumbing accessories live in their own group (rebuilt on toggle)
    const reuseGroup = new THREE.Group();
    addons.add(reuseGroup);
    reuseGroupRef.current = reuseGroup;

    addons.add(tankGroup);
    tankMeshesRef.current = [wall, dome, water];

    // ===== RAIN — real streaks, not dots =====
    const RN = 2400;
    const rpos = new Float32Array(RN * 6);
    const rvel = new Float32Array(RN);
    for (let i = 0; i < RN; i++) {
      const x = (Math.random() - 0.5) * 60;
      const y = Math.random() * 28;
      const z = (Math.random() - 0.5) * 60;
      const len = 0.35 + Math.random() * 0.3;
      rpos[i * 6] = x;
      rpos[i * 6 + 1] = y;
      rpos[i * 6 + 2] = z;
      rpos[i * 6 + 3] = x;
      rpos[i * 6 + 4] = y - len;
      rpos[i * 6 + 5] = z;
      rvel[i] = 16 + Math.random() * 10;
    }
    const rgeo = new THREE.BufferGeometry();
    rgeo.setAttribute('position', new THREE.BufferAttribute(rpos, 3));
    const rmat = new THREE.LineBasicMaterial({ color: 0xaecbdd, transparent: true, opacity: 0 });
    const rain = new THREE.LineSegments(rgeo, rmat);
    scene.add(rain);
    rainLinesRef.current = rain;
    rainVelRef.current = rvel;

    // camera frame including tank
    const span = Math.max(12, Math.hypot(maxX - minX, maxZ - minZ));
    const radius = Math.max(9, span * 0.78);
    camera.position.set(radius * 1.02, Math.max(9, radius * 0.95 + built.totalHeightM * 0.5), radius * 1.3);
    controls.target.set((maxX) / 2.6, built.totalHeightM * 0.38, (maxZ) / 2.6);
    controls.update();

    const onResize = () => {
      if (!mountRef.current) return;
      const w = Math.max(100, mountRef.current.clientWidth);
      const h = Math.max(100, mountRef.current.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    // hover tooltip raycast
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onPointerMove = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(tankMeshesRef.current, false);
      if (hits.length > 0) {
        const s = simRef.current;
        const idx = Math.min(23, Math.floor(hourRef.current));
        const hp = s ? s.hours[idx] : null;
        setTooltip({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          levelL: hp ? hp.tankL : s?.tankEndL ?? 0,
          capL: plan.tank.capacityL,
          inflowLph: hp ? hp.inflowL : 0,
          hourLabel: `${String(idx).padStart(2, '0')}:00`,
          overflowing: hp ? hp.overflowL > 0 : false,
        });
      } else {
        setTooltip(null);
      }
    };
    const onPointerLeave = () => setTooltip(null);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);

    // ===== SHARED RAF =====
    const clock = new THREE.Clock();
    let rafId = 0;
    let hudSync = 0;
    const bgRain = new THREE.Color(0x9aabb8);
    const bgClear = new THREE.Color(0xf2f0e8);
    const bgCur = new THREE.Color(0xf2f0e8);

    const animate = () => {
      if (cancelled) return;
      rafId = requestAnimationFrame(animate);
      const dt = Math.min(0.05, clock.getDelta());

      if (desiredCamRef.current) {
        camera.position.lerp(desiredCamRef.current.pos, 0.1);
        controls.target.lerp(desiredCamRef.current.tgt, 0.1);
        if (camera.position.distanceTo(desiredCamRef.current.pos) < 0.08) desiredCamRef.current = null;
      }
      controls.autoRotate = autoRotateRef.current && !playingRef.current;
      controls.update();

      const s = simRef.current;
      // advance playback
      if (playingRef.current && !pausedRef.current && !scrubbingRef.current && s) {
        hourRef.current += (dt * 24) / speedRef.current;
        if (hourRef.current >= 24) hourRef.current -= 24;
      }
      const idx = s ? Math.min(23, Math.floor(hourRef.current)) : 0;
      const hp = s ? s.hours[idx] : null;
      const rainMm = hp ? hp.rainMm : 0;
      const rainI = Math.min(1, rainMm / 6);

      // sky & sun mood
      const target = rainI > 0.03 ? bgRain : bgClear;
      bgCur.lerp(target, 0.05);
      (scene.background as THREE.Color).copy(bgCur);
      if (sunLightRef.current) {
        sunLightRef.current.intensity += ((1.85 - rainI * 1.25) - sunLightRef.current.intensity) * 0.05;
      }

      // rain streaks fall with a slight wind slant
      if (rainLinesRef.current && rainVelRef.current) {
        const rm = rainLinesRef.current.material as THREE.LineBasicMaterial;
        rm.opacity += ((rainI > 0.02 ? 0.32 + rainI * 0.4 : 0) - rm.opacity) * 0.1;
        rainLinesRef.current.visible = rm.opacity > 0.02;
        if (rainLinesRef.current.visible) {
          const arr = rainLinesRef.current.geometry.attributes.position.array as Float32Array;
          const vel = rainVelRef.current;
          for (let i = 0; i < vel.length; i++) {
            const fall = vel[i] * dt * (0.9 + rainI);
            const drift = rainI * dt * 1.6;
            arr[i * 6] += drift;
            arr[i * 6 + 1] -= fall;
            arr[i * 6 + 3] += drift;
            arr[i * 6 + 4] -= fall;
            if (arr[i * 6 + 4] < 0) {
              const x = (Math.random() - 0.5) * 60;
              const y = 26 + Math.random() * 3;
              const z = (Math.random() - 0.5) * 60;
              const len = 0.35 + Math.random() * 0.3;
              arr[i * 6] = x;
              arr[i * 6 + 1] = y;
              arr[i * 6 + 2] = z;
              arr[i * 6 + 3] = x;
              arr[i * 6 + 4] = y - len;
              arr[i * 6 + 5] = z;
            }
          }
          rainLinesRef.current.geometry.attributes.position.needsUpdate = true;
        }
      }

      // gutter channels visibly carry water while raining
      const stripOp = rainI > 0.03 ? Math.min(0.85, 0.25 + rainI) : 0;
      for (const s of gutterStripsRef.current) {
        const m = s.material as THREE.MeshBasicMaterial;
        m.opacity += (stripOp - m.opacity) * 0.08;
        s.visible = m.opacity > 0.02;
      }

      // pour jet + splash rings at the tank inlet while filling
      const filling = hp ? hp.inflowL > 1 : false;
      if (inletJetRef.current) {
        inletJetRef.current.visible = filling;
        if (filling) {
          inletJetRef.current.scale.y = 0.8 + Math.sin(performance.now() * 0.02) * 0.25;
        }
      }
      if (rippleRef.current) {
        rippleRef.current.visible = filling;
        if (filling) {
          const t = (performance.now() * 0.0009) % 1;
          rippleRef.current.scale.setScalar(0.6 + t * 2.2);
          (rippleRef.current.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - t);
        }
      }

      // tank water level
      if (waterMeshRef.current && s) {
        const frac = Math.max(0.001, hp ? hp.tankL / plan.tank.capacityL : 0);
        const cur = waterMeshRef.current.scale.y;
        const next = cur + (frac - cur) * 0.08;
        waterMeshRef.current.scale.y = next;
        waterMeshRef.current.position.y = (next * plan.tank.heightM) / 2 + 0.01;
      }

      // flow particles along pipes
      const inflow = hp ? hp.inflowL : 0;
      for (const fc of flowCurvesRef.current) {
        fc.points.visible = inflow > 0.5;
        if (!fc.points.visible) continue;
        const speed = (0.5 + Math.min(2.6, inflow / 120)) * 3.6;
        const pos = fc.points.geometry.attributes.position.array as Float32Array;
        for (let i = 0; i < fc.ts.length; i++) {
          fc.ts[i] = (fc.ts[i] + (speed * dt) / Math.max(1, fc.len)) % 1;
          const p = fc.curve.getPointAt(fc.ts[i]);
          pos[i * 3] = p.x;
          pos[i * 3 + 1] = p.y;
          pos[i * 3 + 2] = p.z;
        }
        fc.points.geometry.attributes.position.needsUpdate = true;
      }

      // HUD sync ~10Hz
      const now = performance.now();
      if (now - hudSync > 90 && s && hp) {
        hudSync = now;
        setHud({
          timeLabel: `${String(idx).padStart(2, '0')}:${String(Math.floor((hourRef.current % 1) * 60)).padStart(2, '0')}`,
          rainMm: rainMm,
          inflowL: hp.inflowL,
          tankL: hp.tankL,
          overflow: hp.overflowL > 0,
        });
      }

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      flowCurvesRef.current = [];
      tankMeshesRef.current = [];
      gutterStripsRef.current = [];
      waterMeshRef.current = null;
      rainLinesRef.current = null;
      inletJetRef.current = null;
      rippleRef.current = null;
      reuseGroupRef.current = null;
      addons.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) {
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          mats.forEach((mm) => {
            const sm = mm as THREE.SpriteMaterial;
            if (sm.map) sm.map.dispose();
            mm.dispose();
          });
        }
      });
      houseHolder.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) {
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          mats.forEach((mm) => mm.dispose());
        }
      });
      rgeo.dispose();
      rmat.dispose();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === container) container.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, spec, metrics, plan]);

  // ===== VISIBLE REUSE PLUMBING — 3D accessories rebuilt whenever toggles change =====
  useEffect(() => {
    const group = reuseGroupRef.current;
    if (!group || !plan) return;
    while (group.children.length > 0) {
      const c = group.children[0];
      group.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) {
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          mats.forEach((mm) => {
            const sm = mm as THREE.SpriteMaterial;
            if (sm.map) sm.map.dispose();
            mm.dispose();
          });
        }
      });
    }

    const tx = plan.tank.pos[0];
    const tz = plan.tank.pos[1];
    const R = plan.tank.radiusM;
    const grey = new THREE.MeshStandardMaterial({ color: 0x8a9aa8, roughness: 0.45, metalness: 0.3 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.35, metalness: 0.7 });
    const green = new THREE.MeshStandardMaterial({ color: 0x3f8f4f, roughness: 0.6 });
    const bluePipe = new THREE.MeshStandardMaterial({ color: 0x2e6fb0, roughness: 0.5 });

    const tube = (pts: [number, number, number][], r: number, mat: THREE.Material) => {
      const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, r, 10, false), mat);
      mesh.castShadow = true;
      return mesh;
    };
    const tag = (text: string, x: number, y: number, z: number, bg = '#111111') => {
      const s = makeLabelSprite(text, bg, '#FFFFFF', 0.36);
      s.position.set(x, y, z);
      return s;
    };

    // Filter + first-flush chamber (always present — hygiene)
    const ff = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.14, 1.25, 14),
      new THREE.MeshStandardMaterial({ color: 0xe8eef2, roughness: 0.35 })
    );
    ff.position.set(tx - R * 0.55, 0.75, tz + R + 0.45);
    ff.castShadow = true;
    group.add(ff, tag('FILTER · FIRST FLUSH', ff.position.x, 1.62, ff.position.z, '#FF521B'));

    // Overflow pipe → soak pit (always present)
    group.add(
      tube(
        [
          [tx + R * 0.6, plan.tank.heightM * 0.9, tz],
          [tx + R + 0.25, plan.tank.heightM * 0.9, tz + 0.5],
          [tx + R + 0.5, 0.9, tz + 1.5],
          [tx + R + 0.5, 0.12, tz + 1.6],
        ],
        0.045,
        grey
      )
    );
    const soak = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 20),
      new THREE.MeshBasicMaterial({ color: 0x7ba05b, transparent: true, opacity: 0.5 })
    );
    soak.rotation.x = -Math.PI / 2;
    soak.position.set(tx + R + 0.5, 0.015, tz + 1.6);
    group.add(soak, tag('SOAK PIT', soak.position.x, 0.4, soak.position.z, '#3f5d33'));

    // Garden tap + coiled green hose
    if (reuse.garden) {
      const tapX = tx - R - 0.12;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 10), brass);
      stem.position.set(tapX, 0.35, tz);
      const spout = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.06), brass);
      spout.position.set(tapX - 0.1, 0.42, tz);
      group.add(stem, spout, tag('GARDEN', tapX, 0.78, tz));
      const coil: [number, number, number][] = [];
      for (let a = 0; a <= Math.PI * 4.5; a += 0.35) {
        coil.push([
          tapX - 0.55 + Math.cos(a) * 0.22,
          0.09 + Math.sin(a) * 0.02,
          tz + 0.75 + Math.sin(a) * 0.22,
        ]);
      }
      group.add(tube(coil, 0.032, green));
      group.add(
        tube(
          [
            [tapX - 0.1, 0.38, tz],
            [tapX - 0.35, 0.2, tz + 0.35],
            coil[0],
          ],
          0.032,
          green
        )
      );
    }

    // Toilet flushing line running toward the house
    if (reuse.toiletPersons > 0) {
      group.add(
        tube(
          [
            [tx + R * 0.5, 0.45, tz - 0.2],
            [tx + R + 0.6, 0.45, tz - 0.9],
            [tx / 2 + 1.5, 0.45, tz - 2.2],
          ],
          0.04,
          bluePipe
        )
      );
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.16), bluePipe);
      box.position.set(tx / 2 + 1.5, 0.45, tz - 2.35);
      group.add(box, tag(`TOILET ×${reuse.toiletPersons}`, box.position.x, 0.95, box.position.z, '#2e6fb0'));
    }

    // Outdoor wash tap
    if (reuse.wash) {
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 10), brass);
      stem.position.set(tx + R + 0.12, 0.35, tz - 0.4);
      group.add(stem, tag('WASH', tx + R + 0.12, 0.72, tz - 0.4));
    }

    // Animal trough with water
    if (reuse.animalsL > 0) {
      const trough = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 0.25, 0.4),
        new THREE.MeshStandardMaterial({ color: 0x5d8aa8, roughness: 0.5 })
      );
      trough.position.set(tx - 0.3, 0.125, tz + R + 1.0);
      group.add(trough, tag('ANIMALS', trough.position.x, 0.55, trough.position.z, '#5d8aa8'));
    }

    // Booster pump block
    if (reuse.pump) {
      const pump = new THREE.Mesh(
        new THREE.BoxGeometry(0.34, 0.3, 0.3),
        new THREE.MeshStandardMaterial({ color: 0x232a31, roughness: 0.4, metalness: 0.5 })
      );
      pump.position.set(tx - R - 0.55, 0.15, tz - 0.35);
      const top = new THREE.Mesh(
        new THREE.BoxGeometry(0.34, 0.05, 0.3),
        new THREE.MeshStandardMaterial({ color: 0xff521b })
      );
      top.position.set(pump.position.x, 0.33, pump.position.z);
      group.add(pump, top, tag('PUMP', pump.position.x, 0.7, pump.position.z));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reuse, plan, isActive, finish]);

  const setCameraPreset = (preset: 'iso' | 'top' | 'front' | 'side') => {
    if (!metrics || !plan) return;
    const radius = Math.max(9, Math.max(metrics.lengthM, metrics.widthM) * 1.25);
    let pos: THREE.Vector3;
    switch (preset) {
      case 'top': pos = new THREE.Vector3(0.01, radius * 1.9, 0.05); break;
      case 'front': pos = new THREE.Vector3(0, 6, radius * 1.5); break;
      case 'side': pos = new THREE.Vector3(radius * 1.5, 6, 0); break;
      default: pos = new THREE.Vector3(radius, radius * 0.85, radius * 1.25);
    }
    desiredCamRef.current = { pos, tgt: new THREE.Vector3(0, 1.6, 0) };
  };

  const handlePlay = () => {
    if (!simDay) return;
    hourRef.current = 0;
    setIsPlaying(true);
    setIsPaused(false);
    setActiveTab('day');
  };
  const handleExitPlayback = () => {
    playingRef.current = false;
    setIsPlaying(false);
    setIsPaused(false);
  };

  const copySummary = async () => {
    if (!plan || !yearSim || !simDay || !metrics) return;
    const lines = [
      `ROOFMASS.LK — WATER MANAGEMENT SUMMARY`,
      `Roof: ${metrics.areaSqm.toFixed(0)} m² (${plan.style}) · runoff ${runoff}`,
      `Gutters: ${plan.gutters.length} · Downpipes: ${plan.downpipes.length} · First-flush: yes · Mosquito mesh: yes`,
      `Tank: ${plan.tank.capacityL.toLocaleString()} L (recommended)`,
      `Annual harvest: ~${yearSim.annualInflowL.toLocaleString()} L · Mains water saved: ${yearSim.annualMainsSavedL.toLocaleString()} L/yr (${yearSim.coveragePct}% of uses)`,
      `Value saved: ~LKR ${yearSim.moneySavedLkr.toLocaleString()}/yr · System estimate: ~LKR ${(costs?.totalLkr ?? 0).toLocaleString()}`,
      `Chosen day (${simDay.dayShort}, ${simDay.totalRainMm} mm): collected ${simDay.totalInflowL.toLocaleString()} L, overflow ${simDay.totalOverflowL.toLocaleString()} L`,
      `ESTIMATES ONLY — size with your plumber.`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  };

  const demandNow = dailyDemandL(reuse);
  const maxMonthIn = yearSim ? Math.max(1, ...yearSim.months.map((m) => Math.max(m.inflowL, m.demandL))) : 1;
  const fmtL = (v: number) => (v >= 100000 ? `${(v / 1000).toFixed(0)}K` : v >= 10000 ? `${(v / 1000).toFixed(1)}K` : v.toLocaleString());

  return (
    <div className="relative w-full h-full flex flex-col bg-[#F2F0E8] overflow-hidden select-none">
      {/* TOP BAR */}
      <div className="z-30 px-3.5 pt-3 pb-2 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
        <div className="flex flex-wrap items-center gap-2 pointer-events-auto">
          <button
            type="button"
            onClick={onBackToStudio}
            className="neo-btn btn-secondary px-3 py-1.5 font-mono-tech text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>← 3D</span>
          </button>
          <div className="neo-card-sm px-2.5 py-1.5 bg-[#111111] text-[#E2FF32] font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5">
            <Droplets className="w-3.5 h-3.5" />
            <span>WATER MANAGEMENT</span>
          </div>
          {plan && yearSim && (
            <div className="neo-card-sm chip-neutral px-2.5 py-1.5 font-mono-tech text-[11px] font-bold uppercase hidden md:flex items-center gap-1.5">
              <Droplet className="w-3.5 h-3.5 text-[#E2FF32]" />
              <span>
                {fmtL(yearSim.annualInflowL)} L/YR · {plan.tank.capacityL.toLocaleString()} L TANK ·{' '}
                {yearSim.coveragePct}% COVER
              </span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pointer-events-auto">
          <button
            type="button"
            onClick={() => setAutoRotate((v) => !v)}
            className={`neo-btn px-2.5 py-1.5 font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1 cursor-pointer ${
              autoRotate ? 'bg-[#E2FF32] text-[#111111]' : 'btn-secondary'
            }`}
          >
            <RotateCw className={`w-3.5 h-3.5 ${autoRotate ? 'animate-spin' : ''}`} />
            <span>ORBIT</span>
          </button>
          <div className="flex border border-[#111111] bg-[#EAE8DF]">
            {(['iso', 'top', 'front', 'side'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setCameraPreset(p)}
                className="px-2 py-1 font-mono-tech text-[10px] font-bold uppercase hover:bg-[#F9F8F3] cursor-pointer"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 3D VIEWPORT */}
      <div className="relative flex-1 min-h-0 w-full overflow-hidden">
        <div ref={mountRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

        {/* TANK HOVER TOOLTIP */}
        {tooltip && (
          <div
            className="absolute z-30 neo-card-sm bg-[#111111] text-[#F9F8F3] px-3 py-2 font-mono-tech pointer-events-none"
            style={{ left: Math.min(tooltip.x + 14, 9999), top: Math.max(8, tooltip.y - 64) }}
          >
            <div className="text-xs font-bold uppercase text-[#E2FF32]">
              TANK {tooltip.levelL.toLocaleString()} / {tooltip.capL.toLocaleString()} L
            </div>
            <div className="text-[10px] uppercase mt-0.5">
              {chosenDay.dayShort} {tooltip.hourLabel} · +{tooltip.inflowLph} L/H ·{' '}
              {Math.round((tooltip.levelL / Math.max(1, tooltip.capL)) * 100)}% FULL
            </div>
            {tooltip.overflowing && (
              <div className="text-[10px] font-bold uppercase text-[#FF521B] mt-0.5">
                OVERFLOWING → SOAK PIT
              </div>
            )}
          </div>
        )}

        {/* PLAYBACK HUD */}
        {isPlaying && simDay && (
          <div className="absolute bottom-3 left-3.5 right-3.5 z-20 pointer-events-auto">
            <div className="max-w-5xl mx-auto neo-card bg-[#F9F8F3]/96 p-3 space-y-2.5">
              <div className="relative h-5 flex items-center">
                <div className="w-full h-3 bg-[#EAE8DF] border border-[#111111] overflow-hidden">
                  <div
                    className="h-full bg-[#2fa3d7] border-r-2 border-[#111111]"
                    style={{ width: `${(hud.timeLabel === '00:00' ? 0 : (hourRef.current / 24) * 100).toFixed(1)}%` }}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={23.98}
                  step={0.04}
                  value={hourRef.current}
                  onPointerDown={() => (scrubbingRef.current = true)}
                  onPointerUp={() => (scrubbingRef.current = false)}
                  onBlur={() => (scrubbingRef.current = false)}
                  onChange={(e) => {
                    hourRef.current = Number(e.target.value);
                  }}
                  aria-label="24-hour water timeline scrubber"
                  className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize"
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5 font-mono-tech uppercase text-[11px] font-bold">
                  <span className="px-2.5 py-1 bg-[#111111] text-[#E2FF32] text-xs border border-[#111111]">
                    {simDay.dayShort} · {hud.timeLabel}
                  </span>
                  <span className="px-2 py-1 bg-[#F2F0E8] border border-[#111111] flex items-center gap-1">
                    <CloudRain className="w-3 h-3 text-[#2fa3d7]" /> {hud.rainMm.toFixed(1)} MM/H
                  </span>
                  <span className="px-2 py-1 bg-[#F2F0E8] border border-[#111111] flex items-center gap-1">
                    <Droplets className="w-3 h-3 text-[#2fa3d7]" /> +{hud.inflowL} L/H
                  </span>
                  <span className="px-2 py-1 bg-[#F2F0E8] border border-[#111111]">
                    TANK {Math.round((hud.tankL / Math.max(1, plan?.tank.capacityL ?? 1)) * 100)}%
                  </span>
                  {hud.overflow && (
                    <span className="px-2 py-1 chip-warn text-[10px]">OVERFLOW → SOAK PIT</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setIsPaused((p) => !p)}
                    className="neo-btn chip-neutral px-2.5 py-1 font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1 cursor-pointer"
                  >
                    {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                    <span>{isPaused ? 'RESUME' : 'PAUSE'}</span>
                  </button>
                  <div className="flex border border-[#111111] bg-[#EAE8DF]">
                    {([30, 60, 120] as PreviewSpeedSec[]).map((sec) => (
                      <button
                        key={sec}
                        type="button"
                        onClick={() => setSpeedSec(sec)}
                        className={`px-2 py-1 font-mono-tech text-[10px] font-bold uppercase cursor-pointer ${
                          speedSec === sec ? 'bg-[#111111] text-[#E2FF32]' : 'hover:bg-[#F9F8F3]'
                        }`}
                      >
                        {sec}S
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={handleExitPlayback}
                    className="neo-btn chip-warn px-3 py-1 font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>EXIT</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* RESULTS DECK */}
      {hasDesigned && plan && !isPlaying && (
        <div className="z-30 h-[46vh] min-h-[300px] max-h-[540px] w-full bg-[#F9F8F3] border-t-4 border-[#111111] overflow-y-auto px-3.5 py-3.5 space-y-3.5 select-text">
          {/* HERO — SUMMARY FIRST */}
          <div className="neo-card bg-white p-4 sm:p-5">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div>
                <div className="menu-row-label">RAIN YOUR ROOF CATCHES / YEAR</div>
                <div className="kpi-hero-num text-[#111111]">
                  {fmtL(yearSim?.annualInflowL ?? annualHarvestL)} L
                </div>
              </div>
              <div>
                <div className="menu-row-label">RECOMMENDED TANK</div>
                <div className="kpi-hero-num text-[#111111]">{plan.tank.capacityL.toLocaleString()} L</div>
              </div>
              <div className="col-span-2 sm:col-span-1">
                <div className="menu-row-label">YOUR USES COVERED</div>
                <div className="kpi-hero-num text-[#111111]">{yearSim?.coveragePct ?? 0}%</div>
              </div>
            </div>
            <p className="text-[15px] sm:text-base leading-relaxed normal-case text-[#111111] mt-3">
              Your {metrics ? metrics.areaSqm.toFixed(0) : '—'} m² roof can catch about{' '}
              <strong>{(yearSim?.annualInflowL ?? annualHarvestL).toLocaleString()} litres a year</strong>. We
              designed {plan.gutters.length} gutters, {plan.downpipes.length} downpipes and a{' '}
              <strong>{plan.tank.capacityL.toLocaleString()} L tank</strong> for it — covering roughly{' '}
              <strong>{yearSim?.coveragePct ?? 0}%</strong> of the uses you pick below, worth about{' '}
              <strong>LKR {(yearSim?.moneySavedLkr ?? 0).toLocaleString()}/yr</strong> in saved mains water.
            </p>
            {plan.sizingNote && (
              <p className="font-mono-tech text-[10px] font-bold uppercase text-[#555550] mt-1.5">{plan.sizingNote}</p>
            )}
            <div className="flex flex-wrap items-center gap-1.5 border-t-2 border-[#111111]/15 mt-3 pt-2.5">
              {[
                { label: '1 DESIGN', done: true },
                { label: '2 SIMULATE', done: hasDesigned },
                { label: '3 REUSE', done: false },
              ].map((s, i) => (
                <span
                  key={s.label}
                  className={`px-2 py-0.5 border-2 border-[#111111] font-mono-tech text-[10px] font-bold uppercase flex items-center gap-1 ${
                    s.done ? 'chip-good' : 'chip-neutral'
                  }`}
                >
                  {s.done ? '✓' : '▸'} {s.label}
                  {i < 2 && <span className="ml-1 text-[#555550]">→</span>}
                </span>
              ))}
              <button
                type="button"
                onClick={copySummary}
                className="neo-btn btn-secondary ml-auto px-2.5 py-1 font-mono-tech text-[10px] font-bold uppercase flex items-center gap-1 cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'COPIED' : 'COPY SUMMARY'}</span>
              </button>
            </div>
          </div>

          {/* TABS */}
          <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            {(
              [
                { id: 'day', label: 'SIMULATE DAY', icon: CloudRain },
                { id: 'year', label: 'YEAR', icon: CalendarDays },
                { id: 'reuse', label: 'REUSE', icon: Droplets },
                { id: 'costs', label: 'COSTS', icon: Wallet },
                { id: 'care', label: 'CARE', icon: Wrench },
              ] as { id: StudioTab; label: string; icon: typeof CloudRain }[]
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`tab-seg flex items-center gap-1.5 ${activeTab === t.id ? 'tab-seg-active' : ''}`}
              >
                <t.icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            ))}
          </div>

          {/* DAY TAB */}
          {activeTab === 'day' && (
            <div className="neo-card bg-white p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#111111] pb-2">
                <h3 className="font-mono-tech text-sm font-bold uppercase">PICK A DAY — WATCH THE RAIN FILL YOUR TANK</h3>
                <span className="font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
                  REAL HOURLY FORECAST
                </span>
              </div>
              <div className="grid grid-cols-4 sm:grid-cols-7 gap-1.5">
                {availableDays.slice(0, 7).map((d, i) => (
                  <button
                    key={d.date}
                    type="button"
                    onClick={() => setDayIdx(i)}
                    className={`p-2 text-left font-mono-tech uppercase border-2 border-[#111111] cursor-pointer ${
                      i === dayIdx ? 'bg-[#E2FF32] shadow-[2px_2px_0px_#111111]' : 'bg-[#F2F0E8] hover:bg-[#EAE8DF]'
                    }`}
                  >
                    <div className="text-[11px] font-bold">{d.dayShort}</div>
                    <div className="text-[10px] text-[#555550]">
                      {d.rawTempMaxC.toFixed(0)}° · {d.rawRainSumMm.toFixed(0)}MM
                    </div>
                  </button>
                ))}
              </div>
              {simDay && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="neo-card-sm bg-[#F9F8F3] p-2.5">
                    <div className="menu-row-label">RAIN THAT DAY</div>
                    <div className="font-mono-tech text-lg font-bold">{simDay.totalRainMm} MM</div>
                  </div>
                  <div className="neo-card-sm bg-[#F9F8F3] p-2.5">
                    <div className="menu-row-label">INTO TANK</div>
                    <div className="font-mono-tech text-lg font-bold text-[#2fa3d7]">{simDay.totalInflowL.toLocaleString()} L</div>
                  </div>
                  <div className="neo-card-sm bg-[#F9F8F3] p-2.5">
                    <div className="menu-row-label">TANK AT MIDNIGHT</div>
                    <div className="font-mono-tech text-lg font-bold">
                      {simDay.tankEndL.toLocaleString()} L ({Math.round((simDay.tankEndL / plan.tank.capacityL) * 100)}%)
                    </div>
                  </div>
                  <div className="neo-card-sm bg-[#F9F8F3] p-2.5">
                    <div className="menu-row-label">OVERFLOWED</div>
                    <div className={`font-mono-tech text-lg font-bold ${simDay.totalOverflowL > 0 ? 'text-[#FF521B]' : ''}`}>
                      {simDay.totalOverflowL.toLocaleString()} L
                    </div>
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={handlePlay}
                className="neo-btn btn-primary w-full py-3 font-mono-tech text-sm font-bold uppercase flex items-center justify-center gap-2 cursor-pointer"
              >
                <Play className="w-4 h-4 fill-[#111111]" />
                <span>▶ PLAY THE RAIN ON YOUR HOUSE</span>
              </button>
            </div>
          )}

          {/* YEAR TAB */}
          {activeTab === 'year' && yearSim && (
            <div className="neo-card bg-white p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#111111] pb-2">
                <div>
                  <h3 className="font-mono-tech text-sm font-bold uppercase">YOUR WHOLE YEAR OF WATER</h3>
                  <p className="text-xs text-[#111111]/70 normal-case">
                    Bars = rain collected · line = what your uses need · orange top = tank full & spilling
                  </p>
                </div>
                <span className="font-mono-tech text-[10px] font-bold uppercase bg-[#E2FF32] px-2 py-0.5 border border-[#111111]">
                  SAVES ~LKR {yearSim.moneySavedLkr.toLocaleString()}/YR
                </span>
              </div>
              <svg viewBox="0 0 680 190" className="w-full" role="img" aria-label="Monthly water collected vs needed">
                {yearSim.months.map((m, i) => {
                  const bw = 40;
                  const gap = (680 - 12 * bw) / 13;
                  const x = gap + i * (bw + gap);
                  const hIn = (m.inflowL / maxMonthIn) * 130;
                  const hSpill = (m.spilledL / maxMonthIn) * 130;
                  return (
                    <g key={m.monthShort}>
                      <rect x={x} y={160 - hIn} width={bw} height={Math.max(1, hIn)} fill="#2fa3d7" stroke="#111111" strokeWidth="1.5" />
                      {m.spilledL > 0 && (
                        <rect x={x} y={160 - hIn} width={bw} height={Math.min(hIn, hSpill)} fill="#FF521B" opacity="0.85" />
                      )}
                      <text x={x + bw / 2} y={176} textAnchor="middle" fontSize="10" fontWeight="700" fontFamily="IBM Plex Mono, monospace" fill="#555550">
                        {m.monthShort}
                      </text>
                    </g>
                  );
                })}
                {(() => {
                  const pts = yearSim.months
                    .map((m, i) => {
                      const bw = 40;
                      const gap = (680 - 12 * bw) / 13;
                      const x = gap + i * (bw + gap) + bw / 2;
                      const y = 160 - (m.demandL / maxMonthIn) * 130;
                      return `${x.toFixed(0)},${y.toFixed(0)}`;
                    })
                    .join(' ');
                  return <polyline points={pts} fill="none" stroke="#111111" strokeWidth="2.5" strokeDasharray="5 4" />;
                })()}
              </svg>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="neo-card-sm bg-[#F9F8F3] p-2.5">
                  <div className="menu-row-label">COLLECTED / YR</div>
                  <div className="font-mono-tech text-base font-bold text-[#2fa3d7]">{yearSim.annualInflowL.toLocaleString()} L</div>
                </div>
                <div className="neo-card-sm bg-[#F9F8F3] p-2.5">
                  <div className="menu-row-label">MAINSAVED / YR</div>
                  <div className="font-mono-tech text-base font-bold">{yearSim.annualMainsSavedL.toLocaleString()} L</div>
                </div>
                <div className="neo-card-sm bg-[#F9F8F3] p-2.5">
                  <div className="menu-row-label">SPILLED (TANK FULL)</div>
                  <div className="font-mono-tech text-base font-bold text-[#FF521B]">{yearSim.annualSpilledL.toLocaleString()} L</div>
                </div>
                <div className="neo-card-sm bg-[#F9F8F3] p-2.5">
                  <div className="menu-row-label">UNMET (USED MAINS)</div>
                  <div className="font-mono-tech text-base font-bold">{yearSim.annualUnmetL.toLocaleString()} L</div>
                </div>
              </div>
            </div>
          )}

          {/* REUSE TAB */}
          {activeTab === 'reuse' && (
            <div className="neo-card bg-white p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#111111] pb-2">
                <div>
                  <h3 className="font-mono-tech text-sm font-bold uppercase">PUT THE WATER BACK TO WORK</h3>
                  <p className="text-xs text-[#111111]/70 normal-case">
                    Toggle what the tank supplies — simulations and coverage update instantly
                  </p>
                </div>
                <span className="font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
                  USING {demandNow} L/DAY
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setReuse((r) => ({ ...r, garden: !r.garden }))}
                  className={`neo-btn px-3 py-2.5 text-left font-mono-tech text-xs font-bold uppercase flex items-center justify-between cursor-pointer ${
                    reuse.garden ? 'bg-[#E2FF32]' : 'btn-secondary'
                  }`}
                >
                  <span>GARDEN TAP + HOSE (~40 L/DAY)</span>
                  <span>{reuse.garden ? '✓ ON' : 'OFF'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setReuse((r) => ({ ...r, wash: !r.wash }))}
                  className={`neo-btn px-3 py-2.5 text-left font-mono-tech text-xs font-bold uppercase flex items-center justify-between cursor-pointer ${
                    reuse.wash ? 'bg-[#E2FF32]' : 'btn-secondary'
                  }`}
                >
                  <span>FLOOR & OUTDOOR WASHING (~20 L/DAY)</span>
                  <span>{reuse.wash ? '✓ ON' : 'OFF'}</span>
                </button>
                <div className="neo-card-sm bg-[#F9F8F3] p-3 flex items-center justify-between gap-2">
                  <span className="font-mono-tech text-xs font-bold uppercase">TOILET FLUSHING (30 L/PERSON)</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setReuse((r) => ({ ...r, toiletPersons: Math.max(0, r.toiletPersons - 1) }))}
                      className="w-7 h-7 border-2 border-[#111111] bg-white font-bold cursor-pointer"
                    >
                      −
                    </button>
                    <span className="font-mono-tech font-bold w-8 text-center">{reuse.toiletPersons}</span>
                    <button
                      type="button"
                      onClick={() => setReuse((r) => ({ ...r, toiletPersons: Math.min(10, r.toiletPersons + 1) }))}
                      className="w-7 h-7 border-2 border-[#111111] bg-white font-bold cursor-pointer"
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="neo-card-sm bg-[#F9F8F3] p-3 flex items-center justify-between gap-2">
                  <span className="font-mono-tech text-xs font-bold uppercase">ANIMALS / LIVESTOCK (L/DAY)</span>
                  <input
                    type="number"
                    min={0}
                    max={2000}
                    step={10}
                    value={reuse.animalsL}
                    onChange={(e) => setReuse((r) => ({ ...r, animalsL: Math.max(0, Math.min(2000, Number(e.target.value) || 0)) }))}
                    className="w-20 neo-card-sm bg-white px-2 py-1 font-mono-tech text-sm font-bold focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setReuse((r) => ({ ...r, pump: !r.pump }))}
                  className={`neo-btn px-3 py-2.5 text-left font-mono-tech text-xs font-bold uppercase flex items-center justify-between cursor-pointer ${
                    reuse.pump ? 'bg-[#E2FF32]' : 'btn-secondary'
                  }`}
                >
                  <span>BOOSTER PUMP + HOSE REEL (+LKR {WATER_CONFIG.pumpLkr.toLocaleString()})</span>
                  <span>{reuse.pump ? '✓ ON' : 'OFF'}</span>
                </button>
                <div className="neo-card-sm bg-[#FFF3CD] p-3 font-mono-tech text-[10px] font-bold uppercase text-[#111111] flex items-center">
                  TOILET LINE NEEDS A PLUMBER-BACKFLOW DEVICE — ASK YOUR INSTALLER
                </div>
              </div>
              {yearSim && (
                <div className="neo-card-sm bg-[#F9F8F3] p-3 text-sm normal-case text-[#111111]">
                  With these uses your tank covers <strong>{yearSim.coveragePct}%</strong> of the year — dry-season
                  months dip, monsoon months fill fast.
                </div>
              )}
            </div>
          )}

          {/* COSTS TAB */}
          {activeTab === 'costs' && costs && (
            <div className="neo-card bg-white p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#111111] pb-2">
                <div>
                  <h3 className="font-mono-tech text-sm font-bold uppercase">WHAT IT COSTS</h3>
                  <p className="text-xs text-[#111111]/70 normal-case">Ballpark installed prices — get real quotes</p>
                </div>
                <span className="font-mono-tech text-[10px] font-bold uppercase text-[#555550]">ESTIMATES ONLY</span>
              </div>
              <div className="divide-y divide-[#111111]/15 border-2 border-[#111111] bg-[#F9F8F3]">
                {costs.lines.map((l) => (
                  <div key={l.label} className="px-3 py-2 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[15px] font-semibold normal-case text-[#111111]">{l.label}</div>
                      <div className="text-xs text-[#111111]/70 normal-case truncate">{l.hint}</div>
                    </div>
                    <div className="font-mono-tech font-bold text-[15px] shrink-0">LKR {l.amountLkr.toLocaleString()}</div>
                  </div>
                ))}
                <div className="px-3 py-2.5 bg-[#111111] text-[#E2FF32] flex items-center justify-between">
                  <span className="font-mono-tech text-sm font-bold uppercase">TOTAL TO INSTALL</span>
                  <span className="font-mono-tech font-bold" style={{ fontSize: 'clamp(18px, 3vw, 24px)' }}>
                    LKR {costs.totalLkr.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* CARE TAB */}
          {activeTab === 'care' && (
            <div className="neo-card bg-white p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#111111] pb-2">
                <div>
                  <h3 className="font-mono-tech text-sm font-bold uppercase">KEEP IT SAFE & CLEAN</h3>
                  <p className="text-xs text-[#111111]/70 normal-case">Five habits — that's the whole maintenance plan</p>
                </div>
              </div>
              <div className="space-y-2">
                {[
                  ['CLEAN GUTTERS BEFORE EACH MONSOON', 'Leaves and dust are the #1 water spoiler.'],
                  ['PURGE THE FIRST-FLUSH AFTER DRY SPELLS', 'Open its tap for a minute when rain returns.'],
                  ['CHECK THE MOSQUITO MESH MONTHLY', 'Sealed tank + mesh = no dengue risk.'],
                  ['NEVER DRINK WITHOUT TREATMENT', 'This water is for garden, toilet & cleaning — not drinking unless properly filtered/boiled.'],
                  ['RINSE THE TANK YEARLY', 'One bucket-brush scrub a year keeps sludge away.'],
                ].map(([t, d]) => (
                  <div key={t} className="neo-card-sm bg-[#F9F8F3] p-3 flex items-start gap-2.5">
                    <span className="w-5 h-5 shrink-0 bg-[#E2FF32] border-2 border-[#111111] flex items-center justify-center font-mono-tech text-[10px] font-bold">
                      ✓
                    </span>
                    <div>
                      <div className="font-mono-tech text-xs font-bold uppercase text-[#111111]">{t}</div>
                      <div className="text-sm normal-case text-[#111111]/75">{d}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default WaterStudio;
