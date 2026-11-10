import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  BatteryCharging,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Flame,
  Layers,
  MessageCircleQuestion,
  RefreshCw,
  RotateCw,
  Send,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  SunMedium,
  TrendingUp,
  X,
  Zap,
} from 'lucide-react';
import { HouseMetrics, HouseSpec, ModelFinish } from '../types';
import { buildHouseModelGroup } from '../geometry/roofBuilder';
import {
  loadMonthlySolarClimateNormals,
  subscribeWeatherForPoint,
} from '../weather/weatherService';
import {
  AdvisorLanguage,
  AdvisorReportData,
  GroqAdvisorError,
  GroqChatMessage,
  UserIntakeContextFlags,
  abortAllAdvisorRequests,
  askSolarAdvisorChat,
  buildFactSheet,
  computeAdvisorReportCacheKey,
  extractConsumptionIntakeFromText,
  generateSolarAdvisorReport,
  loadCachedAdvisorReport,
  saveCachedAdvisorReport,
} from '../ai/solarAdvisor';
import {
  ConnectionPhase,
  SOLAR_CONFIG,
  computeSriLankaDomesticBillLkr,
  estimateMonthlyUnitsFromBillLkr,
} from '../solar/solarConfig';
import {
  SolarSimulationResult,
  buildRoofHeatmapOverlayGroup,
  disposeThreeGroup,
  runRoofSolarSimulation,
} from '../solar/solarSimEngine';
import {
  SolarLayoutPlan,
  buildBestFirstSolarLayout,
  buildSolarHardwareGroup,
  getHouseSolarStorageKey,
  loadPersistedSolarDesign,
  savePersistedSolarDesign,
} from '../solar/layoutEngine';
import {
  SolarFinancialReport,
   computeRecommendedSizing,
  evaluateSolarFinancials,
} from '../solar/solarFinance';

interface SolarStudioProps {
  spec: HouseSpec | null;
  metrics: HouseMetrics | null;
  finish: ModelFinish;
  isActive: boolean;
  onBackTo3D: () => void;
}

const MONTH_LABELS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];

const CONSUMPTION_PRESETS = [120, 180, 240, 300] as const;

// In-session simulation & layout cache keyed by houseKey so re-opening Solar Studio is instant
const sessionSimCache = new Map<
  string,
  { sim: SolarSimulationResult; layout: SolarLayoutPlan }
>();

function formatLkr(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  return `${sign}LKR ${Math.round(Math.abs(amount)).toLocaleString('en-US')}`;
}

function formatCompactLkr(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1_000_000) {
    return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}${Math.round(abs / 1_000)}K`;
  }
  return `${sign}${Math.round(abs)}`;
}

function createSolarNorthSprite(): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 140;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#FF521B';
  ctx.fillRect(0, 0, 140, 64);
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 5;
  ctx.strokeRect(2.5, 2.5, 135, 59);
  ctx.font = '700 32px "IBM Plex Mono", monospace';
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N ↑', 70, 33);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.55, 0.72, 1);
  return sprite;
}

export const SolarStudio: React.FC<SolarStudioProps> = ({
  spec,
  metrics,
  finish,
  isActive,
  onBackTo3D,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const houseHolderRef = useRef<THREE.Group | null>(null);
  const heatmapHolderRef = useRef<THREE.Group | null>(null);
  const hardwareHolderRef = useRef<THREE.Group | null>(null);
  const builtHouseGroupRef = useRef<THREE.Group | null>(null);
  const desiredCamPosRef = useRef<THREE.Vector3 | null>(null);
  const desiredTargetRef = useRef<THREE.Vector3 | null>(null);

  const [autoRotate, setAutoRotate] = useState<boolean>(false);
  const autoRotateRef = useRef<boolean>(false);
  autoRotateRef.current = autoRotate;

  // Simulation state
  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  const [simProgressPct, setSimProgressPct] = useState<number>(0);
  const [simStatusText, setSimStatusText] = useState<string>('PREPARING 3D ROOF MODEL…');
  const [simResult, setSimResult] = useState<SolarSimulationResult | null>(null);
  const [layoutPlan, setLayoutPlan] = useState<SolarLayoutPlan | null>(null);

  // User Consumption & System Design State
  const [monthlyConsumptionKwh, setMonthlyConsumptionKwh] = useState<number>(220);
  const [billInputLkr, setBillInputLkr] = useState<string>('');
  const [phase, setPhase] = useState<ConnectionPhase>('single');
  const [panelCount, setPanelCount] = useState<number>(0);
  const [hasDesigned, setHasDesigned] = useState<boolean>(false);
  const [showConsumptionModal, setShowConsumptionModal] = useState<boolean>(true);
  const [showHeatmap, setShowHeatmap] = useState<boolean>(true);
  const [showResultsDeck, setShowResultsDeck] = useState<boolean>(false);
  const [showDetails, setShowDetails] = useState<boolean>(false);
  const [housePeakHeightM, setHousePeakHeightM] = useState<number>(5.5);
  const [locationLabel, setLocationLabel] = useState<string>('');

  // Task 4: Natural-Language Intake Context Flags
  const [intakeFreeText, setIntakeFreeText] = useState<string>('');
  const [intakeFlags, setIntakeFlags] = useState<UserIntakeContextFlags>({});
  const [isExtractingIntake, setIsExtractingIntake] = useState<boolean>(false);
  const [intakeStatusHint, setIntakeStatusHint] = useState<string>('');

  // Task 2: AI Advisor Structured Report State
  const [advisorReport, setAdvisorReport] = useState<AdvisorReportData | null>(null);
  const [isGeneratingReport, setIsGeneratingReport] = useState<boolean>(false);
  const [reportUnavailableMsg, setReportUnavailableMsg] = useState<string | null>(null);
  const [hadReportThisSession, setHadReportThisSession] = useState<boolean>(false);

  // Task 3: Ask the Advisor Chat Drawer State
  const [isChatOpen, setIsChatOpen] = useState<boolean>(false);
  const [chatLang, setChatLang] = useState<AdvisorLanguage>('en');
  const [chatHistory, setChatHistory] = useState<GroqChatMessage[]>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const [isChatSending, setIsChatSending] = useState<boolean>(false);
  const [chatErrorMsg, setChatErrorMsg] = useState<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  const advisorBusy = isGeneratingReport || isChatSending || isExtractingIntake;

  const houseKey = useMemo(() => {
    if (!spec || !metrics) return '';
    return getHouseSolarStorageKey(spec, metrics);
  }, [spec, metrics]);

  // Read cached/reverse-geocoded Sri Lankan locality label for the AI Fact Sheet
  useEffect(() => {
    if (!metrics) {
      setLocationLabel('');
      return;
    }
    const unsub = subscribeWeatherForPoint(metrics.centroid, (bundle) => {
      if (bundle.locationLabel) {
        setLocationLabel(bundle.locationLabel);
      }
    });
    return unsub;
  }, [metrics?.centroid[0], metrics?.centroid[1]]);

  // Cleanly abort any pending Groq request & close drawer when leaving SolarStudio or unmounting
  useEffect(() => {
    if (!isActive) {
      abortAllAdvisorRequests();
      setIsChatOpen(false);
    }
    return () => {
      abortAllAdvisorRequests();
    };
  }, [isActive]);

  // Load persisted consumption/design for this house when houseKey changes
  useEffect(() => {
    if (!houseKey) return;
    setChatHistory([]);
    setChatErrorMsg(null);
    setHadReportThisSession(false);
    setIntakeFreeText('');
    setIntakeStatusHint('');

    const saved = loadPersistedSolarDesign(houseKey);
    if (saved) {
      setMonthlyConsumptionKwh(saved.monthlyConsumptionKwh);
      setBillInputLkr(saved.monthlyBillInputLkr || '');
      setPhase(saved.phase);
      setPanelCount(saved.panelCount);
      setHasDesigned(saved.hasDesigned);
      setIntakeFlags({
        hasAC: saved.hasAC,
        plansEV: saved.plansEV,
        notes: saved.intakeNotes,
      });
      setShowConsumptionModal(!saved.hasDesigned);
      setShowHeatmap(!saved.hasDesigned);
      setShowResultsDeck(saved.hasDesigned);
    } else {
      setMonthlyConsumptionKwh(220);
      setBillInputLkr('');
      setPhase('single');
      setPanelCount(0);
      setHasDesigned(false);
      setIntakeFlags({});
      setShowConsumptionModal(true);
      setShowHeatmap(true);
      setShowResultsDeck(false);
    }
  }, [houseKey]);

  // Mount Three.js Studio Scene ONLY while SolarStudio is active, and dispose 100% on exit/unmount
  useEffect(() => {
    if (!isActive || !spec || !metrics) return;
    const container = mountRef.current;
    if (!container) return;

    let cancelled = false;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(finish === 'blueprint' ? 0x0a1936 : 0xf2f0e8);
    sceneRef.current = scene;

    const width = Math.max(100, container.clientWidth);
    const height = Math.max(100, container.clientHeight);

    const camera = new THREE.PerspectiveCamera(38, width / height, 0.2, 600);
    camera.position.set(18, 16, 20);
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
    controls.minDistance = 4.5;
    controls.maxDistance = 140;
    controls.target.set(0, 2.4, 0);
    controls.autoRotateSpeed = 1.1;
    controlsRef.current = controls;

    const stopGlide = () => {
      desiredCamPosRef.current = null;
      desiredTargetRef.current = null;
    };
    controls.addEventListener('start', stopGlide);

    // Crisp tropical Sri Lanka studio illumination with sharp sun shadows for panels
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xd8d3c5, 0.94);
    hemiLight.position.set(0, 42, 0);
    scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xfffaf0, 1.85);
    sunLight.position.set(18, 34, 16);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 2048;
    sunLight.shadow.mapSize.height = 2048;
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 120;
    const d = 28;
    sunLight.shadow.camera.left = -d;
    sunLight.shadow.camera.right = d;
    sunLight.shadow.camera.top = d;
    sunLight.shadow.camera.bottom = -d;
    sunLight.shadow.bias = -0.0005;
    scene.add(sunLight);

    const fillLight = new THREE.DirectionalLight(0xdce8ff, 0.42);
    fillLight.position.set(-20, 16, -18);
    scene.add(fillLight);

    // Subtle ground shadow receiver + CAD metric grid
    const shadowPlaneGeo = new THREE.PlaneGeometry(180, 180);
    shadowPlaneGeo.rotateX(-Math.PI / 2);
    const shadowPlaneMat = new THREE.ShadowMaterial({ opacity: 0.22 });
    const shadowPlane = new THREE.Mesh(shadowPlaneGeo, shadowPlaneMat);
    shadowPlane.position.y = 0.005;
    shadowPlane.receiveShadow = true;
    scene.add(shadowPlane);

    const gridHelper = new THREE.GridHelper(80, 40, 0xbab5a6, 0xdad6c9);
    gridHelper.position.y = 0.01;
    scene.add(gridHelper);

    const houseHolder = new THREE.Group();
    const heatmapHolder = new THREE.Group();
    const hardwareHolder = new THREE.Group();
    scene.add(houseHolder, heatmapHolder, hardwareHolder);
    houseHolderRef.current = houseHolder;
    heatmapHolderRef.current = heatmapHolder;
    hardwareHolderRef.current = hardwareHolder;

    // Build exact 1:1 house using existing roofBuilder without any modifications
    const built = buildHouseModelGroup(spec, metrics, finish);
    houseHolder.add(built.group);
    builtHouseGroupRef.current = built.group;
    setHousePeakHeightM(built.totalHeightM);

    const bbox = new THREE.Box3().setFromObject(built.group);

    const northSprite = createSolarNorthSprite();
    northSprite.position.set(0, 0.5, bbox.min.z - 2.2);
    houseHolder.add(northSprite);

    // Frame architectural elevated solar view showing all roof planes clearly
    const spanX = bbox.max.x - bbox.min.x;
    const spanZ = bbox.max.z - bbox.min.z;
    const radius = Math.max(8, Math.hypot(spanX, spanZ) * 0.72);
    camera.position.set(
      radius * 1.05,
      Math.max(9.5, radius * 1.02 + built.totalHeightM * 0.52),
      radius * 1.18
    );
    controls.target.set(0, built.totalHeightM * 0.42, 0);
    controls.update();

    const onResize = () => {
      if (!mountRef.current) return;
      const w = Math.max(100, mountRef.current.clientWidth);
      const h = Math.max(100, mountRef.current.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const resizeObs = new ResizeObserver(onResize);
    resizeObs.observe(container);

    let rafId = 0;
    const animate = () => {
      if (cancelled) return;
      rafId = requestAnimationFrame(animate);

      if (desiredCamPosRef.current && desiredTargetRef.current) {
        camera.position.lerp(desiredCamPosRef.current, 0.1);
        controls.target.lerp(desiredTargetRef.current, 0.1);
        if (camera.position.distanceTo(desiredCamPosRef.current) < 0.08) {
          desiredCamPosRef.current = null;
          desiredTargetRef.current = null;
        }
      }

      controls.autoRotate = autoRotateRef.current;
      controls.update();
      renderer.render(scene, camera);
    };
    rafId = requestAnimationFrame(animate);

    // Kick off non-blocking physical solar simulation (or restore from session cache)
    const cachedEntry = sessionSimCache.get(houseKey);
    if (cachedEntry) {
      setSimResult(cachedEntry.sim);
      setLayoutPlan(cachedEntry.layout);
      setIsSimulating(false);
      setSimProgressPct(100);
    } else {
      setIsSimulating(true);
      setSimProgressPct(4);
      setSimStatusText('LOADING ERA5 SOLAR RADIATION NORMALS…');

      (async () => {
        const climate = await loadMonthlySolarClimateNormals(metrics.centroid);
        if (cancelled) return;

        const sim = await runRoofSolarSimulation({
          houseGroup: built.group,
          latDeg: metrics.centroid[1],
          lngDeg: metrics.centroid[0],
          climateNormals: climate.normals,
          climateYearsSpan: climate.yearsSpan,
          climateSource: climate.source,
          onProgress: (pct, text) => {
            if (!cancelled) {
              setSimProgressPct(pct);
              setSimStatusText(text);
            }
          },
        });
        if (cancelled) return;

        const layout = buildBestFirstSolarLayout(sim, SOLAR_CONFIG);
        sessionSimCache.set(houseKey, { sim, layout });
        setSimResult(sim);
        setLayoutPlan(layout);
        setIsSimulating(false);
      })();
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      resizeObs.disconnect();
      controls.removeEventListener('start', stopGlide);
      controls.dispose();

      disposeThreeGroup(heatmapHolder);
      disposeThreeGroup(hardwareHolder);
      disposeThreeGroup(houseHolder);
      shadowPlaneGeo.dispose();
      shadowPlaneMat.dispose();
      gridHelper.geometry.dispose();
      const gMat = gridHelper.material;
      if (Array.isArray(gMat)) gMat.forEach((m) => m.dispose());
      else gMat.dispose();

      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }

      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      houseHolderRef.current = null;
      heatmapHolderRef.current = null;
      hardwareHolderRef.current = null;
      builtHouseGroupRef.current = null;
    };
  }, [isActive, spec, metrics, finish, houseKey]);

  // Rebuild / toggle add-on Roof Heatmap mesh whenever simResult or showHeatmap changes
  useEffect(() => {
    const holder = heatmapHolderRef.current;
    if (!holder) return;
    while (holder.children.length > 0) {
      const child = holder.children[0];
      holder.remove(child);
      disposeThreeGroup(child);
    }
    if (simResult && showHeatmap) {
      const overlay = buildRoofHeatmapOverlayGroup(simResult);
      holder.add(overlay);
    }
  }, [simResult, showHeatmap, isActive]);

  // Rebuild add-on 3D Solar Panels + Wall Inverter + Conduit whenever active panelCount or layout changes
  useEffect(() => {
    const holder = hardwareHolderRef.current;
    const houseGroup = builtHouseGroupRef.current;
    if (!holder || !houseGroup) return;

    while (holder.children.length > 0) {
      const child = holder.children[0];
      holder.remove(child);
      disposeThreeGroup(child);
    }

    if (hasDesigned && layoutPlan && panelCount > 0) {
      const activeSlots = layoutPlan.allCandidateSlots.slice(
        0,
        Math.min(panelCount, layoutPlan.maxRoofPanels)
      );
      const hwGroup = buildSolarHardwareGroup({
        activeSlots,
        houseGroup,
        config: SOLAR_CONFIG,
      });
      holder.add(hwGroup);
    }
  }, [hasDesigned, layoutPlan, panelCount, isActive]);

  // Compute live financial report for the active design
  const financialReport: SolarFinancialReport | null = useMemo(() => {
    if (!layoutPlan) return null;
    return evaluateSolarFinancials({
      panelCount: hasDesigned ? panelCount : 0,
      monthlyConsumptionKwh,
      phase,
      layout: layoutPlan,
      config: SOLAR_CONFIG,
    });
  }, [layoutPlan, hasDesigned, panelCount, monthlyConsumptionKwh, phase]);

  // Preview recommended sizing inside the setup card even before clicking DESIGN MY SYSTEM
  const previewSizing = useMemo(() => {
    if (!layoutPlan) return null;
    return computeRecommendedSizing({
      monthlyConsumptionKwh,
      phase,
      layout: layoutPlan,
      config: SOLAR_CONFIG,
    });
  }, [layoutPlan, monthlyConsumptionKwh, phase]);

  // Compute compact deterministic Fact Sheet for the Groq AI Advisor
  const factSheet = useMemo(() => {
    if (!spec || !metrics || !simResult || !financialReport) return null;
    return buildFactSheet({
      locationLabel,
      spec,
      metrics,
      monthlyConsumptionKwh,
      phase,
      sim: simResult,
      finance: financialReport,
      intakeFlags,
    });
  }, [
    locationLabel,
    spec,
    metrics,
    monthlyConsumptionKwh,
    phase,
    simResult,
    financialReport,
    intakeFlags,
  ]);

  const advisorReportCacheKey = useMemo(() => {
    if (!houseKey || !financialReport || !hasDesigned) return '';
    return computeAdvisorReportCacheKey({
      houseKey,
      panelCount: financialReport.panelCount,
      monthlyConsumptionKwh,
      phase,
      intakeFlags,
    });
  }, [houseKey, financialReport?.panelCount, monthlyConsumptionKwh, phase, intakeFlags, hasDesigned]);

  // Restore cached AI report from localStorage if exact design matches; else reset to GENERATE button
  useEffect(() => {
    setReportUnavailableMsg(null);
    if (!advisorReportCacheKey) {
      setAdvisorReport(null);
      return;
    }
    const cached = loadCachedAdvisorReport(advisorReportCacheKey);
    setAdvisorReport(cached);
    if (cached) {
      setHadReportThisSession(true);
    }
  }, [advisorReportCacheKey]);

  // Auto-scroll chat thread on new messages
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatHistory, isChatSending, isChatOpen]);

  const handleDesignSystem = useCallback(() => {
    if (!layoutPlan || !houseKey) return;
    const sizing = computeRecommendedSizing({
      monthlyConsumptionKwh,
      phase,
      layout: layoutPlan,
      config: SOLAR_CONFIG,
    });

    const nextCount = sizing.recommendedPanels;
    setPanelCount(nextCount);
    setHasDesigned(true);
    setShowConsumptionModal(false);
    setShowHeatmap(false); // Default heatmap OFF once 3D panels are placed so modules stand out clearly
    setShowResultsDeck(true);

    savePersistedSolarDesign({
      houseKey,
      monthlyConsumptionKwh,
      monthlyBillInputLkr: billInputLkr,
      phase,
      panelCount: nextCount,
      hasDesigned: true,
      hasAC: intakeFlags.hasAC,
      plansEV: intakeFlags.plansEV,
      intakeNotes: intakeFlags.notes,
      updatedAtIso: new Date().toISOString(),
    });
  }, [layoutPlan, houseKey, monthlyConsumptionKwh, billInputLkr, phase, intakeFlags]);

  const handleSliderChange = useCallback(
    (nextCount: number) => {
      setPanelCount(nextCount);
      if (!hasDesigned) setHasDesigned(true);
      if (houseKey) {
        savePersistedSolarDesign({
          houseKey,
          monthlyConsumptionKwh,
          monthlyBillInputLkr: billInputLkr,
          phase,
          panelCount: nextCount,
          hasDesigned: true,
          hasAC: intakeFlags.hasAC,
          plansEV: intakeFlags.plansEV,
          intakeNotes: intakeFlags.notes,
          updatedAtIso: new Date().toISOString(),
        });
      }
    },
    [hasDesigned, houseKey, monthlyConsumptionKwh, billInputLkr, phase, intakeFlags]
  );

  // Task 2 Handler: Generate or Regenerate Structured AI Advisor Report
  const handleGenerateAdvisorReport = useCallback(async () => {
    if (!factSheet || !advisorReportCacheKey || advisorBusy) return;
    setIsGeneratingReport(true);
    setReportUnavailableMsg(null);
    try {
      const report = await generateSolarAdvisorReport(factSheet);
      saveCachedAdvisorReport(advisorReportCacheKey, report);
      setAdvisorReport(report);
      setHadReportThisSession(true);
    } catch (err) {
      const msg =
        err instanceof GroqAdvisorError && err.kind === 'RateLimitError'
          ? 'TRY AGAIN IN A MOMENT (RATE LIMIT)'
          : 'ADVISOR UNAVAILABLE';
      setReportUnavailableMsg(msg);
      setAdvisorReport(null);
    } finally {
      setIsGeneratingReport(false);
    }
  }, [factSheet, advisorReportCacheKey, advisorBusy]);

  // Task 3 Handler: Send Chat Question to Groq Solar Advisor
  const handleSendChatQuestion = useCallback(
    async (rawQuestion: string) => {
      const q = rawQuestion.trim();
      if (!q || !factSheet || advisorBusy) return;

      setChatInput('');
      setChatErrorMsg(null);
      const priorHistory = chatHistory;
      const nextWithUser: GroqChatMessage[] = [
        ...priorHistory,
        { role: 'user', content: q },
      ];
      setChatHistory(nextWithUser);
      setIsChatSending(true);

      try {
        const answer = await askSolarAdvisorChat({
          factSheet,
          history: priorHistory,
          userMessage: q,
          language: chatLang,
        });
        setChatHistory((prev) => [...prev, { role: 'assistant', content: answer }]);
      } catch (err) {
        const friendly =
          err instanceof GroqAdvisorError && err.kind === 'RateLimitError'
            ? 'TRY AGAIN IN A MOMENT — TOKEN RATE LIMIT REACHED.'
            : err instanceof GroqAdvisorError && err.kind === 'TimeoutError'
            ? 'ADVISOR TIMED OUT — PLEASE TRY AGAIN.'
            : 'ADVISOR UNAVAILABLE RIGHT NOW — TRY AGAIN IN A MOMENT.';
        setChatErrorMsg(friendly);
      } finally {
        setIsChatSending(false);
      }
    },
    [factSheet, advisorBusy, chatHistory, chatLang]
  );

  // Task 4 Handler: Natural-Language Consumption Intake Prefill
  const handlePrefillIntake = useCallback(async () => {
    const txt = intakeFreeText.trim();
    if (!txt || advisorBusy) return;
    setIsExtractingIntake(true);
    setIntakeStatusHint('');
    try {
      const extracted = await extractConsumptionIntakeFromText(txt);
      if (extracted) {
        if (extracted.monthlyUnitsKwh > 0) {
          setMonthlyConsumptionKwh(extracted.monthlyUnitsKwh);
          setBillInputLkr('');
        }
        setIntakeFlags({
          hasAC: extracted.hasAC,
          plansEV: extracted.plansEV,
          notes: extracted.notes,
        });
        const parts: string[] = [];
        if (extracted.monthlyUnitsKwh > 0) parts.push(`${extracted.monthlyUnitsKwh} U/MO`);
        if (extracted.hasAC) parts.push('AC LOAD');
        if (extracted.plansEV) parts.push('EV PLANNED');
        setIntakeStatusHint(
          parts.length > 0 ? `PREFILLED: ${parts.join(' · ')}` : 'NOTES SAVED FOR ADVISOR'
        );
      } else {
        // Strict silent fallback — user enters numbers manually above
        setIntakeStatusHint('');
      }
    } catch {
      setIntakeStatusHint('');
    } finally {
      setIsExtractingIntake(false);
    }
  }, [intakeFreeText, advisorBusy]);

  const setCameraPreset = (mode: 'iso' | 'top' | 'south') => {
    if (!metrics) return;
    const r = Math.max(8.5, Math.max(metrics.lengthM, metrics.widthM) * 1.15);
    const ty = housePeakHeightM * 0.42;
    desiredTargetRef.current = new THREE.Vector3(0, ty, 0);
    if (mode === 'top') {
      desiredCamPosRef.current = new THREE.Vector3(0.01, r * 1.9, 0.06);
    } else if (mode === 'south') {
      desiredCamPosRef.current = new THREE.Vector3(0, housePeakHeightM * 0.9 + 4, r * 1.5);
    } else {
      desiredCamPosRef.current = new THREE.Vector3(
        r * 1.02,
        r * 0.95 + housePeakHeightM * 0.4,
        r * 1.15
      );
    }
  };

  if (!spec || !metrics) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#F9F8F3] p-6">
        <div className="neo-card bg-white p-6 max-w-md text-center space-y-3">
          <p className="font-mono-tech text-xs font-bold uppercase text-[#111111]">
            NO 3D HOUSE SELECTED YET
          </p>
          <button
            type="button"
            onClick={onBackTo3D}
            className="neo-btn px-4 py-2 bg-[#E2FF32] font-mono-tech text-xs font-bold uppercase cursor-pointer"
          >
            ← BACK TO 3D
          </button>
        </div>
      </div>
    );
  }

  const maxSliderPanels = layoutPlan
    ? Math.min(
        layoutPlan.maxRoofPanels,
        Math.floor(
          ((phase === 'single'
            ? SOLAR_CONFIG.regulatory.singlePhaseHardMaxKw
            : SOLAR_CONFIG.regulatory.threePhaseMaxKw) *
            1000) /
            SOLAR_CONFIG.panel.watts
        )
      )
    : 0;

  const estimatedBaselineBill = computeSriLankaDomesticBillLkr(monthlyConsumptionKwh);

  return (
    <div className="relative w-full h-full flex flex-col bg-[#F2F0E8] overflow-hidden select-none">
      {/* TOP NAVIGATION & SYSTEM STATUS BAR (TASK 1) */}
      <div className="z-30 px-3.5 pt-3 pb-2 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
        {/* LEFT GROUP */}
        <div className="flex flex-wrap items-center gap-2 pointer-events-auto">
          <button
            type="button"
            onClick={onBackTo3D}
            className="neo-btn btn-secondary px-3 py-1.5 font-mono-tech text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>← 3D</span>
          </button>

          <div className="neo-card-sm px-2.5 py-1.5 bg-[#111111] text-[#E2FF32] font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5">
            <SunMedium className="w-3.5 h-3.5 text-[#E2FF32]" />
            <span>SOLAR DESIGN</span>
          </div>

          {hasDesigned && financialReport && (
            <div className="neo-card-sm px-2.5 py-1.5 bg-[#F9F8F3] text-[#111111] font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-[#FF521B]" />
              <span>
                {financialReport.systemKwp.toFixed(2)} KWP · {financialReport.panelCount} PANELS ·{' '}
                {financialReport.paybackYears !== null
                  ? `PAYBACK ${financialReport.paybackYears} YRS`
                  : 'PAYBACK >25 YRS'}
              </span>
            </div>
          )}

          <div className="hidden xl:flex neo-card-sm px-2.5 py-1.5 bg-[#FFF3CD] text-[#111111] font-mono-tech text-[10px] font-bold uppercase items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5 text-[#FF521B]" />
            <span>ESTIMATES ONLY — VERIFY WITH CEB & YOUR INSTALLER</span>
          </div>
        </div>

        {/* RIGHT GROUP */}
        <div className="flex flex-wrap items-center gap-1.5 pointer-events-auto">
          <button
            type="button"
            onClick={() => setShowConsumptionModal((v) => !v)}
            className={`neo-btn px-2.5 py-1.5 font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5 cursor-pointer ${
              showConsumptionModal
                ? 'bg-[#E2FF32] text-[#111111]'
                : 'bg-[#F9F8F3] text-[#111111]'
            }`}
            title="Edit Monthly Electricity Usage & Phase"
          >
            <SlidersHorizontal className="w-3.5 h-3.5 text-[#FF521B]" />
            <span>BILL · {monthlyConsumptionKwh} UNITS/MO</span>
          </button>

          <button
            type="button"
            onClick={() => setShowHeatmap((v) => !v)}
            disabled={!simResult}
            className={`neo-btn px-2.5 py-1.5 font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5 cursor-pointer disabled:opacity-45 ${
              showHeatmap ? 'bg-[#FF521B] text-white' : 'bg-[#F9F8F3] text-[#111111]'
            }`}
            title="Toggle Roof Annual Solar Irradiance Heatmap Overlay"
          >
            <Flame className="w-3.5 h-3.5" />
            <span>{showHeatmap ? 'HEATMAP: ON' : 'HEATMAP: OFF'}</span>
          </button>

          {hasDesigned && (
            <button
              type="button"
              onClick={() => setShowResultsDeck((v) => !v)}
              className={`neo-btn px-2.5 py-1.5 font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1.5 cursor-pointer ${
                showResultsDeck
                  ? 'bg-[#E2FF32] text-[#111111]'
                  : 'bg-[#F9F8F3] text-[#111111]'
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              <span>{showResultsDeck ? 'HIDE REPORT' : 'SOLAR REPORT'}</span>
              {showResultsDeck ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronUp className="w-3.5 h-3.5" />
              )}
            </button>
          )}

          <button
            type="button"
            onClick={() => setAutoRotate((v) => !v)}
            className={`neo-btn px-2.5 py-1.5 font-mono-tech text-[11px] font-bold uppercase flex items-center gap-1 cursor-pointer ${
              autoRotate ? 'bg-[#E2FF32] text-[#111111]' : 'bg-[#F9F8F3] text-[#111111]'
            }`}
          >
            <RotateCw className={`w-3.5 h-3.5 ${autoRotate ? 'animate-spin' : ''}`} />
            <span>ORBIT</span>
          </button>
        </div>
      </div>

      {/* MAIN 3D VIEWPORT + FLOATING OVERLAYS */}
      <div className="relative flex-1 min-h-[260px] w-full overflow-hidden">
        <div ref={mountRef} className="w-full h-full" />

        {/* NON-BLOCKING SUNLIGHT RAYCASTING PROGRESS CARD */}
        {isSimulating && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 w-[min(92vw,420px)] neo-card bg-[#111111] text-[#F9F8F3] p-3.5 space-y-2">
            <div className="flex items-center justify-between font-mono-tech text-xs font-bold uppercase">
              <span className="text-[#E2FF32] flex items-center gap-1.5">
                <SunMedium className="w-4 h-4 animate-spin" />
                SIMULATING SUNLIGHT…
              </span>
              <span>{simProgressPct}%</span>
            </div>
            <div className="w-full h-3 bg-[#262926] border border-[#E2FF32] overflow-hidden">
              <div
                className="h-full bg-[#E2FF32] transition-all duration-150"
                style={{ width: `${simProgressPct}%` }}
              />
            </div>
            <p className="font-mono-tech text-[10px] text-[#F9F8F3]/80 uppercase truncate">
              {simStatusText}
            </p>
          </div>
        )}

        {/* FLOATING 3D SOLAR ARRAY BADGE + LIVE PANEL COUNT SLIDER (TASK 5) */}
        {hasDesigned && financialReport && layoutPlan && !showConsumptionModal && (
          <div className="absolute top-2 left-3.5 z-20 w-[min(90vw,330px)] neo-card-sm bg-[#F9F8F3]/95 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="px-2 py-0.5 bg-[#111111] text-[#E2FF32] font-mono-tech text-[11px] font-bold uppercase">
                YOUR SOLAR DESIGN · {financialReport.systemKwp.toFixed(2)} KWP
              </span>
              <span className="font-mono-tech text-[10px] font-bold uppercase text-[#111111]">
                {financialReport.panelCount}/{maxSliderPanels} PANELS
              </span>
            </div>
            <div className="text-[10px] text-[#111111]/70 normal-case leading-snug">
              Drag to add or remove panels — cost &amp; payback update instantly below.
            </div>

            <div className="space-y-1">
              <input
                type="range"
                min={0}
                max={Math.max(1, maxSliderPanels)}
                step={1}
                value={financialReport.panelCount}
                onChange={(e) => handleSliderChange(Number(e.target.value))}
                className="w-full accent-[#FF521B] cursor-pointer"
              />
              <div className="flex items-center justify-between font-mono-tech text-[10px] uppercase text-[#111111]/80">
                <span>~{financialReport.meanMonthlyGenerationKwh} UNITS/MO</span>
                <span>{formatCompactLkr(financialReport.totalCapexLkr)} LKR</span>
                {financialReport.panelCount !== financialReport.recommendedPanelCount && (
                  <button
                    type="button"
                    onClick={() =>
                      handleSliderChange(financialReport.recommendedPanelCount)
                    }
                    className="underline font-bold text-[#FF521B] cursor-pointer"
                  >
                    REC ({financialReport.recommendedPanelCount})
                  </button>
                )}
              </div>
            </div>

            {financialReport.phaseExceedsStandardGuidance && (
              <div className="px-2 py-1 bg-[#FFF3CD] border border-[#111111] font-mono-tech text-[9px] font-bold uppercase text-[#111111] flex items-center gap-1">
                <AlertTriangle className="w-3 h-3 text-[#FF521B] shrink-0" />
                <span>&gt;5 KW ON SINGLE-PHASE REQUIRES CEB FEEDER APPROVAL</span>
              </div>
            )}
          </div>
        )}

        {/* FLOATING HEATMAP LEGEND OVERLAY WHEN HEATMAP IS ON (TASK 4) */}
        {simResult && showHeatmap && (
          <div className="absolute bottom-3 left-3.5 z-20 w-[min(90vw,310px)] neo-card-sm bg-[#111111] text-[#F9F8F3] p-3 space-y-2">
            <div className="flex items-center justify-between font-mono-tech text-[10px] font-bold uppercase">
              <span className="text-[#E2FF32]">ANNUAL SUN ENERGY (KWH/M²/YR)</span>
              <span className="text-[#F9F8F3]/75">{simResult.climateSource} ERA5</span>
            </div>
            <div
              className="w-full h-3 border border-[#F9F8F3]"
              style={{
                background:
                  'linear-gradient(90deg, #1c52d6 0%, #14adc7 28%, #f5c926 55%, #fa6917 80%, #d61c1f 100%)',
              }}
            />
            <div className="flex items-center justify-between font-mono-tech text-[10px] font-bold">
              <span>{Math.round(simResult.minSampleAnnualKwhM2)} (SHADED)</span>
              <span>
                {Math.round(
                  0.5 * (simResult.minSampleAnnualKwhM2 + simResult.maxSampleAnnualKwhM2)
                )}
              </span>
              <span className="text-[#E2FF32]">
                {Math.round(simResult.maxSampleAnnualKwhM2)} (PEAK)
              </span>
            </div>
            {simResult.sections.length > 0 && (
              <div className="pt-1 border-t border-[#F9F8F3]/20 space-y-0.5 font-mono-tech text-[10px] uppercase">
                {simResult.sections.slice(0, 2).map((s) => (
                  <div key={s.id} className="flex items-center justify-between">
                    <span className="truncate pr-2">{s.label}</span>
                    <span className="text-[#E2FF32] font-bold shrink-0">
                      {Math.round(s.panelPlaneAnnualKwhM2)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* COMPACT CAMERA ANGLE CHIPS + FLOATING ASK ADVISOR BUTTON (BOTTOM RIGHT OF 3D VIEWPORT) */}
        <div className="absolute bottom-3 right-3.5 z-20 flex flex-col items-end gap-2">
          {simResult && financialReport && !isChatOpen && (
            <button
              type="button"
              onClick={() => setIsChatOpen(true)}
              className="neo-btn btn-secondary px-3 py-2 font-mono-tech text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer"
              title="Ask the AI Solar Advisor about your roof, payback, monsoons, or CEB Net Plus"
            >
              <MessageCircleQuestion className="w-4 h-4 text-[#FF521B]" />
              <span>ASK ADVISOR</span>
            </button>
          )}

          <div className="flex items-center gap-1">
            {(['iso', 'top', 'south'] as const).map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setCameraPreset(preset)}
                className="neo-btn px-2 py-1 bg-[#F9F8F3] text-[#111111] font-mono-tech text-[10px] font-bold uppercase cursor-pointer"
              >
                {preset}
              </button>
            ))}
          </div>
        </div>

        {/* TASK 3: "ASK THE ADVISOR" CHAT DRAWER (ANCHORED INSIDE 3D VIEWPORT — NEVER COVERS TOP BACK/EXIT BUTTONS) */}
        {isChatOpen && factSheet && (
          <div className="absolute z-30 neo-card bg-[#F9F8F3] flex flex-col overflow-hidden select-text inset-x-2 bottom-2 h-[72%] sm:inset-x-auto sm:top-2 sm:bottom-3 sm:right-3.5 sm:h-auto sm:w-[min(94vw,400px)]">
            {/* Drawer Header + Language Chips */}
            <div className="px-3 py-2.5 bg-[#111111] text-[#F9F8F3] border-b-2 border-[#111111] space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-mono-tech text-xs font-bold uppercase text-[#E2FF32]">
                  <MessageCircleQuestion className="w-4 h-4" />
                  <span>ASK THE ADVISOR</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="px-1.5 py-0.5 bg-[#FFF3CD] text-[#111111] font-mono-tech text-[9px] font-bold uppercase">
                    ESTIMATES ONLY
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsChatOpen(false)}
                    className="p-1 bg-[#262926] text-[#F9F8F3] hover:bg-[#FF521B] cursor-pointer"
                    title="Close Advisor Drawer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Language Selector Chips: EN | සිංහල | தமிழ் */}
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono-tech text-[10px] uppercase text-[#F9F8F3]/75">
                  LANGUAGE:
                </span>
                <div className="flex items-center gap-1">
                  {(
                    [
                      { code: 'en', label: 'EN' },
                      { code: 'si', label: 'සිංහල' },
                      { code: 'ta', label: 'தமிழ்' },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.code}
                      type="button"
                      onClick={() => setChatLang(item.code)}
                      className={`px-2 py-0.5 border font-mono-tech text-[10px] font-bold cursor-pointer ${
                        chatLang === item.code
                          ? 'bg-[#E2FF32] text-[#111111] border-[#E2FF32]'
                          : 'bg-[#1d201d] text-[#F9F8F3] border-[#F9F8F3]/30'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Starter Suggestion Chips */}
            <div className="px-2.5 py-2 bg-white border-b border-[#111111]/20 flex flex-wrap gap-1">
              {(
                [
                  'WHY THIS PAYBACK?',
                  'MONSOON MONTHS?',
                  'BATTERY WORTH IT?',
                  'HOW DO I START WITH CEB?',
                ] as const
              ).map((chip) => (
                <button
                  key={chip}
                  type="button"
                  disabled={advisorBusy}
                  onClick={() => void handleSendChatQuestion(chip)}
                  className="px-2 py-1 bg-[#F9F8F3] hover:bg-[#E2FF32] border border-[#111111] font-mono-tech text-[9.5px] font-bold uppercase text-[#111111] cursor-pointer disabled:opacity-45"
                >
                  {chip}
                </button>
              ))}
            </div>

            {/* Chat Message Thread */}
            <div
              ref={chatScrollRef}
              className="flex-1 overflow-y-auto p-3 space-y-2.5 bg-[#F9F8F3]"
            >
              {chatHistory.length === 0 && !isChatSending && (
                <div className="neo-card-sm bg-white p-2.5 font-mono-tech text-[11px] text-[#111111]/85 space-y-1">
                  <div className="font-bold uppercase text-[#111111]">
                    GROUNDED IN YOUR ROOF&apos;S COMPUTED NUMBERS
                  </div>
                  <p className="text-[10.5px]">
                    TAP A STARTER CHIP ABOVE OR ASK ANYTHING ABOUT YOUR{' '}
                    <strong>{factSheet.selectedSystemKwp} KWP</strong> SYSTEM, MONSOON DIPS, PAYBACK,
                    BATTERY SIZING, OR CEB NET PLUS CONNECTION.
                  </p>
                </div>
              )}

              {chatHistory.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex ${
                    msg.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  <div
                    className={`max-w-[88%] p-2.5 border-2 border-[#111111] font-mono-tech text-[11px] leading-relaxed whitespace-pre-wrap ${
                      msg.role === 'user'
                        ? 'bg-[#E2FF32] text-[#111111] font-bold'
                        : 'bg-white text-[#111111]'
                    }`}
                  >
                    {msg.content}
                  </div>
                </div>
              ))}

              {isChatSending && (
                <div className="flex justify-start">
                  <div className="px-3 py-2 bg-[#111111] text-[#E2FF32] border-2 border-[#111111] font-mono-tech text-[10px] font-bold uppercase">
                    ADVISOR THINKING…
                  </div>
                </div>
              )}

              {chatErrorMsg && (
                <div className="p-2 bg-[#FFF3CD] border-2 border-[#111111] font-mono-tech text-[10px] font-bold uppercase text-[#111111]">
                  {chatErrorMsg}
                </div>
              )}
            </div>

            {/* Chat Input Form */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSendChatQuestion(chatInput);
              }}
              className="p-2.5 bg-white border-t-2 border-[#111111] flex items-center gap-1.5"
            >
              <input
                type="text"
                value={chatInput}
                disabled={advisorBusy}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder={
                  advisorBusy ? 'WAITING FOR ADVISOR…' : 'ASK ABOUT YOUR SOLAR DESIGN…'
                }
                className="flex-1 neo-card-sm bg-[#F9F8F3] px-2.5 py-1.5 font-mono-tech text-xs text-[#111111] focus:outline-none disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={advisorBusy || !chatInput.trim()}
                className="neo-btn px-3 py-1.5 bg-[#E2FF32] text-[#111111] font-mono-tech text-xs font-bold uppercase flex items-center gap-1 cursor-pointer disabled:opacity-45"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </form>
          </div>
        )}

        {/* TASK 2: FIRST-RUN / REOPENABLE CONSUMPTION SETUP CARD */}
        {showConsumptionModal && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#111111]/35 p-3">
            <div className="w-[min(95vw,460px)] neo-card bg-[#F9F8F3] p-4 sm:p-5 space-y-4 max-h-[90%] overflow-y-auto">
              <div className="flex items-start justify-between gap-2 border-b-2 border-[#111111] pb-2.5">
                <div>
                  <span className="inline-block px-2 py-0.5 bg-[#111111] text-[#E2FF32] font-mono-tech text-[10px] font-bold uppercase">
                    STEP 1 · FIRST QUESTION
                  </span>
                  <h2 className="mt-1 font-mono-tech text-lg sm:text-xl font-bold uppercase text-[#111111]">
                    HOW MUCH POWER DO YOU USE?
                  </h2>
                  <p className="text-sm text-[#111111]/75 normal-case mt-0.5">
                    Grab your CEB bill — copy the "units" number. We size everything from this.
                  </p>
                </div>
                {hasDesigned && (
                  <button
                    type="button"
                    onClick={() => setShowConsumptionModal(false)}
                    className="neo-btn px-2 py-1 bg-white font-mono-tech text-xs font-bold uppercase cursor-pointer"
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* Monthly Consumption kWh Input + Presets */}
              <div className="space-y-1.5">
                <label className="block font-mono-tech text-[11px] font-bold uppercase text-[#111111]">
                  UNITS YOU USE PER MONTH (KWH)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={20}
                    max={3000}
                    value={monthlyConsumptionKwh}
                    onChange={(e) => {
                      const val = Math.max(10, Math.min(3000, Number(e.target.value) || 0));
                      setMonthlyConsumptionKwh(val);
                      setBillInputLkr('');
                    }}
                    className="w-36 neo-card-sm bg-white px-3 py-2.5 font-mono-tech text-lg font-bold text-[#111111] focus:outline-none"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {CONSUMPTION_PRESETS.map((u) => (
                      <button
                        key={u}
                        type="button"
                        onClick={() => {
                          setMonthlyConsumptionKwh(u);
                          setBillInputLkr('');
                        }}
                        className={`neo-btn px-2.5 py-1.5 font-mono-tech text-[11px] font-bold uppercase cursor-pointer ${
                          monthlyConsumptionKwh === u
                            ? 'bg-[#E2FF32] text-[#111111]'
                            : 'bg-white text-[#111111]'
                        }`}
                      >
                        {u}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="font-mono-tech text-[10px] text-[#111111]/75 uppercase">
                  ESTIMATED CURRENT CEB/LECO BILL:{' '}
                  <strong className="text-[#111111]">{formatLkr(estimatedBaselineBill)}/MO</strong>
                </p>
              </div>

              {/* Optional Monthly LKR Bill Back-Estimator */}
              <div className="space-y-1">
                <label className="block font-mono-tech text-[11px] font-bold uppercase text-[#111111]">
                  OR ENTER MONTHLY BILL (LKR) — AUTO-ESTIMATES UNITS
                </label>
                <input
                  type="number"
                  min={0}
                  max={500000}
                  placeholder="E.G. 16500"
                  value={billInputLkr}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setBillInputLkr(raw);
                    const numeric = Number(raw);
                    if (numeric >= 300) {
                      setMonthlyConsumptionKwh(estimateMonthlyUnitsFromBillLkr(numeric));
                    }
                  }}
                  className="w-full neo-card-sm bg-white px-3 py-2 font-mono-tech text-xs font-bold text-[#111111] focus:outline-none"
                />
              </div>

              {/* TASK 4: OPTIONAL NATURAL-LANGUAGE CONSUMPTION INTAKE */}
              <div className="neo-card-sm bg-white p-2.5 space-y-1.5">
                <label className="block font-mono-tech text-[10px] font-bold uppercase text-[#111111] flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-[#FF521B]" />
                  <span>OPTIONAL: DESCRIBE USAGE IN WORDS (AI PREFILL)</span>
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={intakeFreeText}
                    disabled={advisorBusy}
                    onChange={(e) => setIntakeFreeText(e.target.value)}
                    placeholder='E.G. "AROUND 250 UNITS, WE HAVE AC & PLAN AN EV NEXT YEAR"'
                    className="flex-1 border border-[#111111] bg-[#F9F8F3] px-2.5 py-1.5 font-mono-tech text-[11px] text-[#111111] focus:outline-none disabled:opacity-50"
                  />
                  <button
                    type="button"
                    disabled={advisorBusy || intakeFreeText.trim().length < 4}
                    onClick={() => void handlePrefillIntake()}
                    className="neo-btn px-2.5 py-1.5 bg-[#E2FF32] text-[#111111] font-mono-tech text-[10px] font-bold uppercase cursor-pointer disabled:opacity-45 shrink-0"
                  >
                    {isExtractingIntake ? '…' : 'PREFILL'}
                  </button>
                </div>
                {(intakeStatusHint || intakeFlags.hasAC || intakeFlags.plansEV) && (
                  <div className="flex flex-wrap items-center gap-1 pt-0.5 font-mono-tech text-[9.5px] font-bold uppercase">
                    {intakeStatusHint && (
                      <span className="px-1.5 py-0.5 bg-[#E2FF32] text-[#111111]">
                        {intakeStatusHint}
                      </span>
                    )}
                    {intakeFlags.hasAC && (
                      <span className="px-1.5 py-0.5 bg-[#111111] text-[#E2FF32]">
                        AC CONTEXT ACTIVE
                      </span>
                    )}
                    {intakeFlags.plansEV && (
                      <span className="px-1.5 py-0.5 bg-[#111111] text-[#E2FF32]">
                        FUTURE EV ACTIVE
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Connection Phase Selector */}
              <div className="space-y-1.5">
                <label className="block font-mono-tech text-[11px] font-bold uppercase text-[#111111]">
                  CEB / LECO SUPPLY CONNECTION PHASE
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setPhase('single')}
                    className={`neo-btn p-2.5 text-left font-mono-tech uppercase cursor-pointer ${
                      phase === 'single'
                        ? 'bg-[#E2FF32] text-[#111111]'
                        : 'bg-white text-[#111111]'
                    }`}
                  >
                    <div className="text-xs font-bold">SINGLE 30A</div>
                    <div className="text-[10px] opacity-80">STANDARD ≤5 KW GUIDANCE</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPhase('three')}
                    className={`neo-btn p-2.5 text-left font-mono-tech uppercase cursor-pointer ${
                      phase === 'three'
                        ? 'bg-[#E2FF32] text-[#111111]'
                        : 'bg-white text-[#111111]'
                    }`}
                  >
                    <div className="text-xs font-bold">THREE-PHASE</div>
                    <div className="text-[10px] opacity-80">DOMESTIC UP TO 20 KW</div>
                  </button>
                </div>
              </div>

              {/* Instant Roof Capacity Preview */}
              <div className="neo-card-sm bg-white p-2.5 font-mono-tech text-[11px] uppercase space-y-1">
                {isSimulating || !previewSizing || !layoutPlan ? (
                  <div className="text-[#FF521B] font-bold">
                    MEASURING SUN ON YOUR ROOF… {simProgressPct}%
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <span>MAX ROOF CAPACITY (0.30M SETBACK):</span>
                      <strong>
                        {layoutPlan.maxRoofPanels} PANELS (
                        {((layoutPlan.maxRoofPanels * SOLAR_CONFIG.panel.watts) / 1000).toFixed(2)}{' '}
                        KWP)
                      </strong>
                    </div>
                    <div className="flex items-center justify-between text-[#111111]">
                      <span>RECOMMENDED ARRAY SIZE:</span>
                      <strong className="px-1.5 py-0.5 bg-[#E2FF32]">
                        {previewSizing.recommendedPanels} × 550W (
                        {(
                          (previewSizing.recommendedPanels * SOLAR_CONFIG.panel.watts) /
                          1000
                        ).toFixed(2)}{' '}
                        KWP)
                      </strong>
                    </div>
                  </>
                )}
              </div>

              <button
                type="button"
                disabled={isSimulating || !layoutPlan}
                onClick={handleDesignSystem}
                className="w-full neo-btn py-3 bg-[#E2FF32] text-[#111111] font-mono-tech text-sm font-bold uppercase flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                <SunMedium className="w-4 h-4" />
                <span>
                  {isSimulating ? 'MEASURING SUNLIGHT… PLEASE WAIT' : 'DESIGN MY SYSTEM ▶'}
                </span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* TASK 8: NEO-BRUTALIST ENGINEERING, COST, PRODUCTION, CASH-FLOW & BATTERY DECK */}
      {hasDesigned && showResultsDeck && financialReport && simResult && layoutPlan && (
        <div className="z-30 h-[47vh] min-h-[290px] max-h-[520px] w-full bg-[#F9F8F3] border-t-4 border-[#111111] overflow-y-auto px-3.5 py-3.5 space-y-3.5 select-text">
          {/* ===== BREAK-EVEN HERO — the ONLY thing that matters, BIG (UI v6) ===== */}
          <div className="neo-card bg-white p-4 sm:p-6">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span
                className={`inline-block px-3 py-1 border-2 border-[#111111] font-mono-tech text-xs font-bold uppercase ${
                  financialReport.verdict === 'STRONG INVESTMENT'
                    ? 'chip-good'
                    : financialReport.verdict === 'MARGINAL'
                    ? 'bg-[#FFF3CD] text-[#111111]'
                    : 'chip-warn'
                }`}
              >
                {financialReport.verdict === 'STRONG INVESTMENT'
                  ? '✓ '
                  : financialReport.verdict === 'MARGINAL'
                  ? '! '
                  : '✗ '}
                {financialReport.verdict}
              </span>
              <span className="font-mono-tech text-[10px] font-bold uppercase text-[#555550]">
                {financialReport.panelCount} × 550W PANELS ·{' '}
                {financialReport.systemKwp.toFixed(2)} KWP · COVERS{' '}
                {Math.round(financialReport.selfConsumptionSharePct)}% OF YOUR USAGE
              </span>
            </div>

            <div className="menu-row-label" style={{ fontSize: '13px', color: '#111111' }}>
              YOU BREAK EVEN IN
            </div>
            <div
              className="font-mono-tech font-bold text-[#111111] leading-none mt-1"
              style={{ fontSize: 'clamp(36px, 7vw, 52px)', letterSpacing: '-0.02em' }}
            >
              {financialReport.paybackYears !== null
                ? `${financialReport.paybackYears} YEARS`
                : '25+ YEARS'}
            </div>

            <p className="text-base sm:text-[17px] leading-relaxed normal-case text-[#111111] mt-3 max-w-3xl">
              Solar costs{' '}
              <strong>LKR {Math.round(financialReport.totalCapexLkr).toLocaleString()}</strong>{' '}
              fully installed, cuts about{' '}
              <strong>
                LKR {Math.round(financialReport.totalMonthlyBenefitLkr).toLocaleString()}
              </strong>{' '}
              off your bill every month, and makes{' '}
              <strong>LKR {Math.round(financialReport.netProfit25YrLkr).toLocaleString()}</strong>{' '}
              pure profit over 25 years.
            </p>

            {/* Stepper: 1 CONSUMPTION ✓ → 2 SUN & PANELS ✓ → 3 MONEY (you are here) */}
            <div className="flex flex-wrap items-center gap-1.5 border-t-2 border-[#111111]/15 mt-3 pt-2.5">
              {[
                { label: '1 CONSUMPTION', done: true },
                { label: '2 SUN & PANELS', done: true },
                { label: '3 MONEY', done: false },
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
            </div>
          </div>

          {/* MORE DETAILS toggle — everything else lives behind this */}
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className={`tab-seg self-start flex items-center gap-1.5 ${
              showDetails ? 'tab-seg-active' : ''
            }`}
          >
            {showDetails ? '▾ LESS DETAILS' : '▸ MORE DETAILS (PRODUCTION, BATTERY, AI)'}
          </button>

          {/* TASK 2: AI SOLAR ADVISOR REPORT CARD (ON-DEMAND ONLY — NEVER AUTO-CALLED) */}
          <div className={`neo-card bg-white p-3.5 space-y-3 ${showDetails ? '' : 'hidden'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#111111] pb-2">
              <div className="flex flex-wrap items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#FF521B]" />
                <h3 className="font-mono-tech text-xs font-bold uppercase">
                  AI ADVISOR · PERSONALIZED ROOF & NET PLUS BRIEF
                </h3>
                <span className="px-2 py-0.5 bg-[#FFF3CD] border border-[#111111] font-mono-tech text-[9.5px] font-bold uppercase">
                  ESTIMATES ONLY
                </span>
                {!advisorReport && hadReportThisSession && !isGeneratingReport && (
                  <span className="px-2 py-0.5 bg-[#111111] text-[#E2FF32] font-mono-tech text-[9.5px] font-bold uppercase">
                    DESIGN CHANGED — STALE
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {reportUnavailableMsg && (
                  <span className="px-2 py-0.5 bg-[#FF521B] text-white border border-[#111111] font-mono-tech text-[10px] font-bold uppercase">
                    {reportUnavailableMsg}
                  </span>
                )}

                {!advisorReport ? (
                  <button
                    type="button"
                    disabled={advisorBusy}
                    onClick={() => void handleGenerateAdvisorReport()}
                    className="neo-btn px-3 py-1.5 bg-[#E2FF32] text-[#111111] font-mono-tech text-xs font-bold uppercase flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-[#FF521B]" />
                    <span>
                      {isGeneratingReport ? 'GENERATING AI REPORT…' : 'GENERATE AI REPORT'}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={advisorBusy}
                    onClick={() => void handleGenerateAdvisorReport()}
                    className="neo-btn px-2.5 py-1 bg-[#F9F8F3] text-[#111111] font-mono-tech text-[10px] font-bold uppercase flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`w-3 h-3 ${isGeneratingReport ? 'animate-spin' : ''}`}
                    />
                    <span>REGENERATE</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setIsChatOpen(true)}
                  className="neo-btn px-2.5 py-1 bg-[#111111] text-[#E2FF32] font-mono-tech text-[10px] font-bold uppercase flex items-center gap-1 cursor-pointer"
                >
                  <MessageCircleQuestion className="w-3.5 h-3.5" />
                  <span>ASK CHAT</span>
                </button>
              </div>
            </div>

            {isGeneratingReport && (
              <div className="p-3 bg-[#111111] text-[#E2FF32] font-mono-tech text-xs font-bold uppercase flex items-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>BUILDING PERSONALIZED BRIEF FROM YOUR COMPUTED ROOF FACT SHEET…</span>
              </div>
            )}

            {/* Cached / Fresh Structured AI Report */}
            {advisorReport && !isGeneratingReport && (
              <div className="space-y-3 font-mono-tech">
                <div className="p-2.5 bg-[#F9F8F3] border-2 border-[#111111] space-y-1">
                  <div className="text-sm sm:text-base font-bold uppercase text-[#111111]">
                    {advisorReport.headline}
                  </div>
                  <p className="text-xs text-[#111111]/90 leading-relaxed">
                    {advisorReport.summary}
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* STRENGTHS (3) with lime + markers */}
                  <div className="neo-card-sm bg-[#F9F8F3] p-2.5 space-y-1.5">
                    <div className="text-[10px] font-bold uppercase text-[#111111]">
                      KEY STRENGTHS
                    </div>
                    {advisorReport.strengths.map((st, idx) => (
                      <div key={idx} className="flex items-start gap-2 text-[11px]">
                        <span className="w-4 h-4 shrink-0 bg-[#E2FF32] border border-[#111111] flex items-center justify-center font-bold text-xs leading-none">
                          +
                        </span>
                        <span>{st}</span>
                      </div>
                    ))}
                  </div>

                  {/* WATCH-OUTS (2) with orange ! markers */}
                  <div className="neo-card-sm bg-[#F9F8F3] p-2.5 space-y-1.5">
                    <div className="text-[10px] font-bold uppercase text-[#111111]">
                      THINGS TO WATCH OUT FOR
                    </div>
                    {advisorReport.watchOuts.map((wo, idx) => (
                      <div key={idx} className="flex items-start gap-2 text-[11px]">
                        <span className="w-4 h-4 shrink-0 bg-[#FF521B] text-white border border-[#111111] flex items-center justify-center font-bold text-xs leading-none">
                          !
                        </span>
                        <span>{wo}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                  {/* Battery Advice */}
                  <div className="md:col-span-5 neo-card-sm bg-[#111111] text-[#F9F8F3] p-2.5 space-y-1">
                    <div className="text-[10px] font-bold uppercase text-[#E2FF32] flex items-center gap-1">
                      <BatteryCharging className="w-3.5 h-3.5" />
                      <span>BATTERY ADVICE</span>
                    </div>
                    <p className="text-[11px] leading-relaxed">{advisorReport.batteryAdvice}</p>
                  </div>

                  {/* Numbered Next Steps */}
                  <div className="md:col-span-7 neo-card-sm bg-[#F9F8F3] p-2.5 space-y-1">
                    <div className="text-[10px] font-bold uppercase text-[#111111]">
                      RECOMMENDED NEXT STEPS
                    </div>
                    <ol className="space-y-1 text-[11px]">
                      {advisorReport.nextSteps.map((step, idx) => (
                        <li key={idx} className="flex items-start gap-2">
                          <span className="px-1.5 py-0.2 bg-[#111111] text-[#E2FF32] text-[10px] font-bold shrink-0">
                            0{idx + 1}
                          </span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
              </div>
            )}

            {/* Deterministic Fallback when Advisor is Offline / Unavailable */}
            {reportUnavailableMsg && !advisorReport && !isGeneratingReport && (
              <div className="neo-card-sm bg-[#F9F8F3] p-3 font-mono-tech text-[11px] uppercase space-y-1">
                <div className="font-bold text-[#111111]">
                  ENGINE METRICS SUMMARY (OFFLINE FALLBACK):
                </div>
                <div>
                  • SYSTEM: {financialReport.systemKwp.toFixed(2)} KWP ({financialReport.panelCount}{' '}
                  × 550W) · OUTPUT {financialReport.annualGenerationKwh.toLocaleString()} KWH/YR
                </div>
                <div>
                  • CAPEX: {formatLkr(financialReport.totalCapexLkr)} · PAYBACK:{' '}
                  {financialReport.paybackYears !== null
                    ? `${financialReport.paybackYears} YRS`
                    : '>25 YRS'}{' '}
                  ({financialReport.verdict})
                </div>
                <div>
                  • BATTERY: {financialReport.batteryInsight.verdict} (
                  {financialReport.batteryInsight.recommendedOption.label})
                </div>
              </div>
            )}

            {/* Idle prompt before user clicks GENERATE AI REPORT */}
            {!advisorReport && !isGeneratingReport && !reportUnavailableMsg && (
              <p className="font-mono-tech text-[11px] text-[#111111]/80 uppercase">
                CLICK <strong>GENERATE AI REPORT</strong> FOR A PLAIN-LANGUAGE SRI LANKAN NET PLUS
                ASSESSMENT OF YOUR {financialReport.systemKwp.toFixed(2)} KWP DESIGN, OR OPEN{' '}
                <strong>ASK CHAT</strong> (EN / සිංහල / தமிழ்).
              </p>
            )}
          </div>

          {/* DETAILS: SYSTEM SUMMARY + CONSUMPTION & ROOF SECTIONS */}
          <div className={`grid grid-cols-1 lg:grid-cols-12 gap-3.5 ${showDetails ? '' : 'hidden'}`}>
            {/* CARD 3: SYSTEM SUMMARY & INVESTMENT VERDICT */}
            <div className="lg:col-span-7 neo-card bg-white p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#111111] pb-2">
                <div className="flex items-center gap-2">
                  <SunMedium className="w-4 h-4 text-[#FF521B]" />
                  <h3 className="font-mono-tech text-xs font-bold uppercase">
                    HOW WE GOT THESE NUMBERS
                  </h3>
                </div>
                <span
                  className={`px-2.5 py-1 border-2 border-[#111111] font-mono-tech text-xs font-bold uppercase ${
                    financialReport.verdict === 'STRONG INVESTMENT'
                      ? 'bg-[#E2FF32] text-[#111111]'
                      : financialReport.verdict === 'MARGINAL'
                      ? 'bg-[#FFD166] text-[#111111]'
                      : 'bg-[#FF521B] text-white'
                  }`}
                >
                  {financialReport.verdict}
                </span>
              </div>

              <p className="font-mono-tech text-[11px] font-bold uppercase text-[#111111] bg-[#F9F8F3] p-2 border border-[#111111]">
                {financialReport.verdictReason}
              </p>

              {/* Interactive Panel Slider inside report card too */}
              <div className="bg-[#F9F8F3] border-2 border-[#111111] p-2.5 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2 font-mono-tech text-[11px] font-bold uppercase">
                  <span>
                    ACTIVE ARRAY: {financialReport.panelCount} × JA SOLAR 550W (
                    {financialReport.systemKwp.toFixed(2)} KWP · {financialReport.totalRoofWeightKg}{' '}
                    KG)
                  </span>
                  <span className="text-[#FF521B]">
                    RECOMMENDED: {financialReport.recommendedPanelCount} PANELS
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, maxSliderPanels)}
                  step={1}
                  value={financialReport.panelCount}
                  onChange={(e) => handleSliderChange(Number(e.target.value))}
                  className="w-full accent-[#FF521B] cursor-pointer"
                />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono-tech uppercase">
                <div className="neo-card-sm bg-[#F9F8F3] p-2">
                  <div className="text-[9px] text-[#111111]/70">MONTHLY GENERATION</div>
                  <div className="text-sm font-bold">
                    {financialReport.meanMonthlyGenerationKwh} KWH
                  </div>
                  <div className="text-[9px] text-[#111111]/75">
                    {financialReport.specificYieldMonthlyKwhPerKwp} U/KW/MO
                  </div>
                </div>
                <div className="neo-card-sm bg-[#F9F8F3] p-2">
                  <div className="text-[9px] text-[#111111]/70">SELF-USE / EXPORT</div>
                  <div className="text-sm font-bold">
                    {financialReport.selfConsumptionSharePct}% /{' '}
                    {100 - financialReport.selfConsumptionSharePct}%
                  </div>
                  <div className="text-[9px] text-[#111111]/75">
                    {financialReport.annualGenerationKwh.toLocaleString()} KWH/YR
                  </div>
                </div>
                <div className="neo-card-sm bg-[#E2FF32] p-2">
                  <div className="text-[9px] text-[#111111]/80">MONTHLY BENEFIT</div>
                  <div className="text-sm font-bold">
                    {formatLkr(financialReport.totalMonthlyBenefitLkr)}
                  </div>
                  <div className="text-[9px] text-[#111111]/80">
                    SAVE {formatCompactLkr(financialReport.monthlyBillSavingsLkr)} + FIT{' '}
                    {formatCompactLkr(financialReport.monthlyExportRevenueLkr)}
                  </div>
                </div>
                <div className="neo-card-sm bg-[#111111] text-[#E2FF32] p-2">
                  <div className="text-[9px] text-[#F9F8F3]/80">SIMPLE PAYBACK</div>
                  <div className="text-sm font-bold">
                    {financialReport.paybackYears !== null
                      ? `${financialReport.paybackYears} YRS`
                      : '>25 YRS'}
                  </div>
                  <div className="text-[9px] text-[#F9F8F3]/80">
                    ROI {financialReport.roi25YrPct}% · LCOE {financialReport.lcoeLkrPerKwh}
                  </div>
                </div>
              </div>
            </div>

            {/* CARD 1 & 2: CONSUMPTION SIZING + ROOF SECTIONS RANKING */}
            <div className="lg:col-span-5 neo-card bg-white p-3.5 space-y-3">
              <div className="flex items-center justify-between border-b-2 border-[#111111] pb-2">
                <div className="flex items-center gap-1.5">
                  <Layers className="w-4 h-4 text-[#FF521B]" />
                  <h3 className="font-mono-tech text-xs font-bold uppercase">
                    WHERE THE SUN HITS YOUR ROOF BEST
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setShowConsumptionModal(true)}
                  className="neo-btn px-2 py-0.5 bg-[#E2FF32] font-mono-tech text-[10px] font-bold uppercase cursor-pointer"
                >
                  EDIT USAGE
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2 font-mono-tech text-[10px] uppercase">
                <div className="neo-card-sm bg-[#F9F8F3] p-2">
                  <div className="opacity-70">USAGE / PHASE</div>
                  <div className="font-bold text-xs">{monthlyConsumptionKwh} KWH</div>
                  <div>{phase === 'single' ? 'SINGLE 30A' : 'THREE-PHASE'}</div>
                </div>
                <div className="neo-card-sm bg-[#F9F8F3] p-2">
                  <div className="opacity-70">BILL BEFORE → AFTER</div>
                  <div className="font-bold text-xs">
                    {formatCompactLkr(financialReport.baselineMonthlyBillLkr)} →{' '}
                    {formatCompactLkr(financialReport.postSolarMonthlyBillLkr)}
                  </div>
                  <div>LKR / MONTH</div>
                </div>
                <div className="neo-card-sm bg-[#F9F8F3] p-2">
                  <div className="opacity-70">NET PLUS FIT</div>
                  <div className="font-bold text-xs">
                    LKR {financialReport.netPlusFitRateLkr}
                  </div>
                  <div>12-YR CONTRACT</div>
                </div>
              </div>

              {financialReport.sizingCapReason && (
                <div className="px-2.5 py-1.5 bg-[#FFF3CD] border border-[#111111] font-mono-tech text-[10px] font-bold uppercase">
                  {financialReport.sizingCapReason}
                </div>
              )}

              {/* Ranked Roof Sections + Heatmap Bar */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between font-mono-tech text-[10px] font-bold uppercase">
                  <span>ANNUAL SUN ENERGY (KWH/M²/YR)</span>
                  <span>
                    GHI {simResult.meanHorizontalGhiKwhM2Day.toFixed(2)} KWH/M²/D (
                    {simResult.climateYearsSpan})
                  </span>
                </div>
                <div
                  className="w-full h-2.5 border border-[#111111]"
                  style={{
                    background:
                      'linear-gradient(90deg, #1c52d6 0%, #14adc7 28%, #f5c926 55%, #fa6917 80%, #d61c1f 100%)',
                  }}
                />
                <div className="max-h-28 overflow-y-auto divide-y divide-[#111111]/15 border border-[#111111] bg-[#F9F8F3] font-mono-tech text-[10px] uppercase">
                  {simResult.sections.map((sec) => (
                    <div
                      key={sec.id}
                      className="px-2 py-1 flex items-center justify-between gap-2"
                    >
                      <span className="font-bold truncate">{sec.label}</span>
                      <span className="shrink-0">
                        {sec.areaSqm.toFixed(1)} M² · UNSHADED{' '}
                        {Math.round(sec.meanShadeFactor * 100)}% ·{' '}
                        <strong className="text-[#FF521B]">
                          {Math.round(sec.panelPlaneAnnualKwhM2)} KWH/M²
                        </strong>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* WHEN YOU PROFIT: CASH-FLOW (always visible) + MONTHLY PRODUCTION (details) */}
          <div className={`grid grid-cols-1 gap-3.5 ${showDetails ? 'lg:grid-cols-2' : ''}`}>
            {/* CARD 5: 12-BAR MONTHLY PRODUCTION INLINE SVG */}
            <div className={`neo-card bg-white p-3.5 space-y-2.5 ${showDetails ? '' : 'hidden'}`}>
              <div className="flex items-center justify-between border-b-2 border-[#111111] pb-2">
                <div className="flex items-center gap-1.5">
                  <BarChart3 className="w-4 h-4 text-[#FF521B]" />
                  <h3 className="font-mono-tech text-xs font-bold uppercase">
                    MONTHLY SOLAR PRODUCTION (JAN–DEC · KWH)
                  </h3>
                </div>
                <span className="font-mono-tech text-[10px] font-bold uppercase">
                  YEAR 1: {financialReport.annualGenerationKwh.toLocaleString()} KWH
                </span>
              </div>

              {(() => {
                const vals = financialReport.monthlyGenerationKwh;
                const maxVal = Math.max(monthlyConsumptionKwh, ...vals, 50) * 1.14;
                const svgW = 520;
                const svgH = 175;
                const padL = 38;
                const padR = 12;
                const padT = 14;
                const padB = 26;
                const plotW = svgW - padL - padR;
                const plotH = svgH - padT - padB;
                const barStep = plotW / 12;
                const barW = barStep * 0.66;
                const loadY =
                  padT + plotH - (Math.min(monthlyConsumptionKwh, maxVal) / maxVal) * plotH;

                return (
                  <svg
                    viewBox={`0 0 ${svgW} ${svgH}`}
                    className="w-full h-44 bg-[#F9F8F3] border border-[#111111]"
                  >
                    {/* Grid lines */}
                    {[0.25, 0.5, 0.75, 1].map((frac) => {
                      const gy = padT + plotH * (1 - frac);
                      return (
                        <g key={frac}>
                          <line
                            x1={padL}
                            y1={gy}
                            x2={svgW - padR}
                            y2={gy}
                            stroke="#111111"
                            strokeOpacity={0.12}
                            strokeWidth={1}
                          />
                          <text
                            x={padL - 5}
                            y={gy + 3}
                            textAnchor="end"
                            fontSize="9"
                            fontFamily="IBM Plex Mono, monospace"
                            fill="#111111"
                          >
                            {Math.round(maxVal * frac)}
                          </text>
                        </g>
                      );
                    })}

                    {/* 12 Monthly Generation Bars */}
                    {vals.map((v, idx) => {
                      const bh = Math.max(2, (v / maxVal) * plotH);
                      const bx = padL + idx * barStep + (barStep - barW) * 0.5;
                      const by = padT + plotH - bh;
                      const isPeak = v === Math.max(...vals) && v > 0;
                      return (
                        <g key={MONTH_LABELS[idx]}>
                          <rect
                            x={bx}
                            y={by}
                            width={barW}
                            height={bh}
                            fill={isPeak ? '#FF521B' : '#E2FF32'}
                            stroke="#111111"
                            strokeWidth={1.5}
                          />
                          <text
                            x={bx + barW / 2}
                            y={by - 3}
                            textAnchor="middle"
                            fontSize="8.5"
                            fontWeight="700"
                            fontFamily="IBM Plex Mono, monospace"
                            fill="#111111"
                          >
                            {v}
                          </text>
                          <text
                            x={bx + barW / 2}
                            y={svgH - 8}
                            textAnchor="middle"
                            fontSize="9"
                            fontWeight="700"
                            fontFamily="IBM Plex Mono, monospace"
                            fill="#111111"
                          >
                            {MONTH_LABELS[idx]}
                          </text>
                        </g>
                      );
                    })}

                    {/* Household Monthly Consumption Dashed Reference Line */}
                    <line
                      x1={padL}
                      y1={loadY}
                      x2={svgW - padR}
                      y2={loadY}
                      stroke="#FF521B"
                      strokeWidth={2}
                      strokeDasharray="5 4"
                    />
                    <rect
                      x={svgW - padR - 118}
                      y={Math.max(2, loadY - 14)}
                      width={116}
                      height={13}
                      fill="#111111"
                    />
                    <text
                      x={svgW - padR - 60}
                      y={Math.max(11, loadY - 5)}
                      textAnchor="middle"
                      fontSize="8.5"
                      fontWeight="700"
                      fontFamily="IBM Plex Mono, monospace"
                      fill="#E2FF32"
                    >
                      USAGE: {monthlyConsumptionKwh} KWH/MO
                    </text>
                  </svg>
                );
              })()}
            </div>

            {/* CARD 6: WHEN YOU PROFIT — 25-YEAR CASH-FLOW (ALWAYS VISIBLE) */}
            <div className="neo-card bg-white p-3.5 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#111111] pb-2">
                <div>
                  <h3 className="font-mono-tech text-sm font-bold uppercase flex items-center gap-1.5">
                    <TrendingUp className="w-4 h-4 text-[#FF521B]" />
                    WHEN YOU START PROFITING
                  </h3>
                  <p className="text-xs text-[#111111]/70 normal-case">
                    {financialReport.paybackYears !== null
                      ? `Every year after year ${financialReport.paybackYears} is money in your pocket`
                      : 'This setup does not pay itself back within 25 years'}
                  </p>
                </div>
                <span className="font-mono-tech text-[10px] font-bold uppercase bg-[#E2FF32] px-2 py-0.5 border border-[#111111]">
                  25-YR NET PROFIT: {formatLkr(financialReport.netProfit25YrLkr)}
                </span>
              </div>

              {(() => {
                const pts = financialReport.cashFlow25Yr;
                const minC = Math.min(...pts.map((p) => p.cumulativeCashFlowLkr), -100000);
                const maxC = Math.max(...pts.map((p) => p.cumulativeCashFlowLkr), 100000);
                const spanC = Math.max(1, maxC - minC);
                const svgW = 520;
                const svgH = 175;
                const padL = 48;
                const padR = 16;
                const padT = 16;
                const padB = 26;
                const plotW = svgW - padL - padR;
                const plotH = svgH - padT - padB;

                const xOf = (yr: number) => padL + (yr / 25) * plotW;
                const yOf = (val: number) => padT + plotH - ((val - minC) / spanC) * plotH;
                const zeroY = yOf(0);

                const polyPoints = pts
                  .map((p) => `${xOf(p.year).toFixed(1)},${yOf(p.cumulativeCashFlowLkr).toFixed(1)}`)
                  .join(' ');

                const areaPath =
                  `M ${xOf(0).toFixed(1)} ${zeroY.toFixed(1)} ` +
                  pts
                    .map(
                      (p) =>
                        `L ${xOf(p.year).toFixed(1)} ${yOf(p.cumulativeCashFlowLkr).toFixed(1)}`
                    )
                    .join(' ') +
                  ` L ${xOf(25).toFixed(1)} ${zeroY.toFixed(1)} Z`;

                return (
                  <svg
                    viewBox={`0 0 ${svgW} ${svgH}`}
                    className="w-full h-44 bg-[#F9F8F3] border border-[#111111]"
                  >
                    {/* Shaded cumulative area */}
                    <path d={areaPath} fill="#E2FF32" fillOpacity={0.42} />

                    {/* Zero break-even horizontal axis */}
                    <line
                      x1={padL}
                      y1={zeroY}
                      x2={svgW - padR}
                      y2={zeroY}
                      stroke="#111111"
                      strokeWidth={1.6}
                      strokeDasharray="4 3"
                    />
                    <text
                      x={padL - 5}
                      y={zeroY + 3}
                      textAnchor="end"
                      fontSize="8.5"
                      fontWeight="700"
                      fontFamily="IBM Plex Mono, monospace"
                      fill="#111111"
                    >
                      0
                    </text>
                    <text
                      x={padL - 5}
                      y={yOf(minC) - 2}
                      textAnchor="end"
                      fontSize="8.5"
                      fontFamily="IBM Plex Mono, monospace"
                      fill="#FF521B"
                    >
                      {formatCompactLkr(minC)}
                    </text>
                    <text
                      x={padL - 5}
                      y={yOf(maxC) + 8}
                      textAnchor="end"
                      fontSize="8.5"
                      fontFamily="IBM Plex Mono, monospace"
                      fill="#111111"
                    >
                      {formatCompactLkr(maxC)}
                    </text>

                    {/* Cash-flow polyline */}
                    <polyline
                      fill="none"
                      stroke="#111111"
                      strokeWidth={2.6}
                      points={polyPoints}
                    />

                    {/* Year ticks + Year 10 Inverter Replacement note */}
                    {[0, 5, 10, 15, 20, 25].map((yr) => (
                      <g key={yr}>
                        <line
                          x1={xOf(yr)}
                          y1={padT}
                          x2={xOf(yr)}
                          y2={padT + plotH}
                          stroke="#111111"
                          strokeOpacity={0.1}
                        />
                        <text
                          x={xOf(yr)}
                          y={svgH - 8}
                          textAnchor="middle"
                          fontSize="9"
                          fontWeight="700"
                          fontFamily="IBM Plex Mono, monospace"
                          fill="#111111"
                        >
                          Y{yr}
                        </text>
                      </g>
                    ))}

                    {/* Break-even marker */}
                    {financialReport.paybackYears !== null &&
                      financialReport.paybackYears <= 25 && (
                        <g>
                          <circle
                            cx={xOf(financialReport.paybackYears)}
                            cy={zeroY}
                            r={5}
                            fill="#FF521B"
                            stroke="#111111"
                            strokeWidth={2}
                          />
                          <rect
                            x={Math.min(
                              svgW - 134,
                              Math.max(padL + 2, xOf(financialReport.paybackYears) - 58)
                            )}
                            y={Math.max(4, zeroY - 24)}
                            width={118}
                            height={15}
                            fill="#111111"
                          />
                          <text
                            x={Math.min(
                              svgW - 75,
                              Math.max(padL + 61, xOf(financialReport.paybackYears) + 1)
                            )}
                            y={Math.max(14, zeroY - 14)}
                            textAnchor="middle"
                            fontSize="8.5"
                            fontWeight="700"
                            fontFamily="IBM Plex Mono, monospace"
                            fill="#E2FF32"
                          >
                            BREAK-EVEN: {financialReport.paybackYears} YRS
                          </text>
                        </g>
                      )}
                  </svg>
                );
              })()}
            </div>
          </div>

          {/* WHAT IT COSTS (always visible) + BATTERY (details) */}
          <div className={`grid grid-cols-1 gap-3.5 ${showDetails ? 'lg:grid-cols-12' : ''}`}>
            {/* CARD 4: WHAT IT COSTS — GROUPED, PLAIN LANGUAGE (ALWAYS VISIBLE) */}
            <div className={`neo-card bg-white p-3.5 sm:p-4 space-y-2.5 ${showDetails ? 'lg:col-span-7' : ''}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#111111] pb-2">
                <div>
                  <h3 className="font-mono-tech text-sm font-bold uppercase">
                    WHAT IT COSTS
                  </h3>
                  <p className="text-xs text-[#111111]/70 normal-case">
                    Everything included — no hidden extras
                  </p>
                </div>
                <span className="font-mono-tech text-[11px] font-bold uppercase text-[#FF521B]">
                  ~LKR {financialReport.costPerWattLkr}/W INSTALLED
                </span>
              </div>

              <div className="divide-y divide-[#111111]/20 border-2 border-[#111111] bg-[#F9F8F3] font-mono-tech text-[11px]">
                {(() => {
                  const by = (id: string) =>
                    financialReport.costBreakdown
                      .filter((c) => c.id === id)
                      .reduce((a, c) => a + c.amountLkr, 0);
                  const groups: { label: string; hint: string; amount: number }[] = [
                    {
                      label: 'Solar panels',
                      hint: `${financialReport.panelCount} × 550W panels on your roof`,
                      amount: by('panels'),
                    },
                    {
                      label: 'Inverter',
                      hint: 'Converts solar power into power your home uses',
                      amount: by('inverter'),
                    },
                    {
                      label: 'Mounting frame & installation',
                      hint: 'Roof brackets, labour, testing & handover',
                      amount: by('mounting') + by('labor'),
                    },
                    {
                      label: 'Wiring & safety protection',
                      hint: 'Cables, safety breakers, surge & lightning protection, earthing',
                      amount: by('protection') + by('cabling') + by('earthing'),
                    },
                    {
                      label: 'CEB smart meter & connection',
                      hint: 'Bi-directional meter and Net Plus application fees',
                      amount: by('meter'),
                    },
                  ];
                  return groups.map((g) => (
                    <div
                      key={g.label}
                      className="px-2.5 py-2 flex items-center justify-between gap-3 border-b border-[#111111]/10 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <div className="text-[15px] font-semibold normal-case text-[#111111]">
                          {g.label}
                        </div>
                        <div className="text-xs text-[#111111]/70 normal-case truncate">
                          {g.hint}
                        </div>
                      </div>
                      <div className="font-mono-tech font-bold text-[15px] text-right shrink-0">
                        {formatLkr(g.amount)}
                      </div>
                    </div>
                  ));
                })()}
                <div className="px-2.5 py-2.5 bg-[#111111] text-[#E2FF32] flex items-center justify-between">
                  <span className="font-mono-tech text-sm font-bold uppercase">
                    TOTAL TO INSTALL
                  </span>
                  <span
                    className="font-mono-tech font-bold"
                    style={{ fontSize: 'clamp(18px, 3vw, 24px)' }}
                  >
                    {formatLkr(financialReport.totalCapexLkr)}
                  </span>
                </div>
              </div>
            </div>

            {/* CARD 7: BATTERY INSIGHT CARD (TASK 7) */}
            <div className={`neo-card bg-white p-3.5 space-y-2.5 ${showDetails ? 'lg:col-span-5' : 'hidden'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#111111] pb-2">
                <div className="flex items-center gap-1.5">
                  <BatteryCharging className="w-4 h-4 text-[#FF521B]" />
                  <h3 className="font-mono-tech text-xs font-bold uppercase">
                    LIFEPO4 BATTERY INSIGHT
                  </h3>
                </div>
                <span
                  className={`px-2 py-0.5 border-2 border-[#111111] font-mono-tech text-[10px] font-bold uppercase ${
                    financialReport.batteryInsight.verdict === 'BATTERY: WORTH IT'
                      ? 'bg-[#E2FF32] text-[#111111]'
                      : 'bg-[#F9F8F3] text-[#111111]'
                  }`}
                >
                  {financialReport.batteryInsight.verdict}
                </span>
              </div>

              <p className="font-mono-tech text-[10px] font-bold uppercase bg-[#F9F8F3] p-2 border border-[#111111]">
                {financialReport.batteryInsight.reason}
              </p>

              <div className="border-2 border-[#111111] divide-y divide-[#111111]/20 font-mono-tech text-[10px] uppercase bg-[#F9F8F3]">
                {financialReport.batteryInsight.allOptions.map((opt) => {
                  const isRec =
                    opt.capacityKwh ===
                    financialReport.batteryInsight.recommendedOption.capacityKwh;
                  return (
                    <div
                      key={opt.capacityKwh}
                      className={`px-2.5 py-1.5 flex items-center justify-between gap-2 ${
                        isRec ? 'bg-[#E2FF32]/45 font-bold' : ''
                      }`}
                    >
                      <div>
                        <div className="flex items-center gap-1">
                          {isRec && <CheckCircle2 className="w-3 h-3 text-[#FF521B]" />}
                          <span>{opt.label}</span>
                        </div>
                        <div className="text-[9px] opacity-75">
                          +{formatCompactLkr(opt.incrementalCapexLkr)} LKR · BACKUP ~
                          {opt.backupHoursEssentialLoad}H
                        </div>
                      </div>
                      <div className="text-right">
                        <div>+{formatLkr(opt.extraAnnualEarningsLkr)}/YR</div>
                        <div className="text-[9px] text-[#FF521B]">
                          PAYBACK {opt.simplePaybackYears > 35 ? '>25' : opt.simplePaybackYears} YRS
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="px-2.5 py-2 bg-[#111111] text-[#F9F8F3] font-mono-tech text-[10px] uppercase">
                {financialReport.batteryInsight.resilienceNote}
              </div>
            </div>
          </div>

          {/* REGULATORY DISCLAIMER & CONFIG ASSUMPTIONS FOOTER */}
          <div className="neo-card-sm bg-[#FFF3CD] p-2.5 flex flex-wrap items-center justify-between gap-2 font-mono-tech text-[10px] uppercase text-[#111111]">
            <div className="flex items-center gap-1.5 font-bold">
              <ShieldAlert className="w-4 h-4 text-[#FF521B] shrink-0" />
              <span>ESTIMATES ONLY — VERIFY WITH CEB & YOUR INSTALLER</span>
            </div>
            <div className="opacity-85">
              TARIFFS VERIFIED {SOLAR_CONFIG.lastVerified} · NET PLUS LKR{' '}
              {SOLAR_CONFIG.regulatory.netPlusFitLe10KwLkr}/KWH (≤10KW, 12YR) · PEAK BATTERY FIT LKR{' '}
              {SOLAR_CONFIG.regulatory.batteryPrioritizedPeakFitLkr}/KWH · PR 0.80 · 0.5%/YR DEG ·
              YR-10 INVERTER RESERVE
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
