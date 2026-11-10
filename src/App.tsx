import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HouseSpec,
  LngLatPoint,
  ModelFinish,
  RoofStyle,
  SatelliteProvider,
} from './types';
import {
  computeHouseMetrics,
  inferArchitecturalProportions,
  regularizeArchitecturalFootprint,
} from './geometry/geoProjection';
import { identifyBuildingRoofIntelligent } from './ai/lankaRoofNet';
import { prefetchWeatherForPoint } from './weather/weatherService';
import { initWeatherSelfLearningScheduler } from './weather/weatherSelfLearning';
import { SriLankaSatelliteMap } from './components/SriLankaSatelliteMap';
import { ThreeHouseStudio } from './components/ThreeHouseStudio';
import { PredictionStudio } from './components/PredictionStudio';
import { SolarStudio } from './components/SolarStudio';
import { WaterStudio } from './components/WaterStudio';

type ActiveScreen = 'map' | '3d' | 'prediction' | 'solar' | 'water';

export const App: React.FC = () => {
  const [houseSpec, setHouseSpec] = useState<HouseSpec | null>(null);
  const [isAnalyzingNeural, setIsAnalyzingNeural] = useState<boolean>(false);
  const [satelliteProvider, setSatelliteProvider] = useState<SatelliteProvider>('google');
  const [finish, setFinish] = useState<ModelFinish>('terracotta');
  const [screen, setScreen] = useState<ActiveScreen>('map');

  // Start daily background LankaWeatherNet self-learning heartbeat on app boot
  useEffect(() => {
    initWeatherSelfLearningScheduler();
  }, []);

  const analysisSeqRef = useRef(0);
  const userOverrodeRoofRef = useRef(false);
  const userOverrodeStoriesRef = useRef(false);

  const metrics = useMemo(() => {
    if (!houseSpec || houseSpec.polygon.length < 3) return null;
    return computeHouseMetrics(houseSpec.polygon);
  }, [houseSpec?.polygon]);

  const handleCompleteRoofCorners = useCallback(
    (
      polygon: LngLatPoint[],
      opts?: { liveDrag?: boolean; isVertexEdit?: boolean }
    ) => {
      if (polygon.length < 3) return;

      // 1. Live 60fps corner drag: morph 3D model instantaneously
      if (opts?.liveDrag) {
        setHouseSpec((prev) => (prev ? { ...prev, polygon } : null));
        return;
      }

      // 2. Vertex edit completed (dragend / midpoint split / corner delete): regularize & re-scan roof with CNN
      if (opts?.isVertexEdit && houseSpec) {
        const cleanPolygon = regularizeArchitecturalFootprint(polygon);
        const editMetrics = computeHouseMetrics(cleanPolygon);
        const seq = ++analysisSeqRef.current;
        setHouseSpec((prev) => (prev ? { ...prev, polygon: cleanPolygon } : null));
        setIsAnalyzingNeural(true);

        // Silent background weather & LankaWeatherNet prefetch
        prefetchWeatherForPoint(editMetrics.centroid);

        identifyBuildingRoofIntelligent(cleanPolygon, satelliteProvider, false)
          .then((res) => {
            if (analysisSeqRef.current !== seq) return;
            setHouseSpec((prev) => {
              if (!prev) return null;
              const style = userOverrodeRoofRef.current
                ? prev.roofStyle
                : res.analysis.predictedStyle;
              const stories = userOverrodeStoriesRef.current
                ? prev.stories
                : res.analysis.inferredStories;
              return {
                ...prev,
                roofStyle: style,
                roofPitchDeg:
                  style === 'flat'
                    ? 0
                    : userOverrodeRoofRef.current
                    ? prev.roofPitchDeg
                    : res.analysis.predictedPitchDeg,
                eaveOverhangM: style === 'flat' ? 0.08 : 0.36,
                stories,
                wallHeightM: Number((stories * 3.18).toFixed(2)),
                ridgeAngleRad: res.analysis.ridgeAngleRad,
                shedSlopeAngleRad: res.analysis.shedSlopeAngleRad,
                satelliteTextureDataUrl: res.satelliteTextureDataUrl,
                detectedMaterialHint: res.analysis.predictedMaterial,
                neuralAnalysis: res.analysis,
              };
            });
          })
          .finally(() => {
            if (analysisSeqRef.current === seq) setIsAnalyzingNeural(false);
          });
        return;
      }

      // 3. Brand-new building roof tapped on map!
      userOverrodeRoofRef.current = false;
      userOverrodeStoriesRef.current = false;

      const cleanPolygon = regularizeArchitecturalFootprint(polygon);
      const initialMetrics = computeHouseMetrics(cleanPolygon);
      const fallback = inferArchitecturalProportions(initialMetrics);
      const newId = `lk-house-${Date.now()}`;
      const seq = ++analysisSeqRef.current;

      setHouseSpec({
        id: newId,
        polygon: cleanPolygon,
        stories: fallback.stories,
        wallHeightM: fallback.wallHeightM,
        roofStyle: fallback.roofStyle,
        roofPitchDeg: fallback.roofPitchDeg,
        eaveOverhangM: fallback.eaveOverhangM,
      });

      // Silently kick off background Open-Meteo fetch + LankaWeatherNet calibration immediately!
      prefetchWeatherForPoint(initialMetrics.centroid);

      setIsAnalyzingNeural(true);

      // LankaRoofNet CNN + Cast-Shadow Elevation Scan
      identifyBuildingRoofIntelligent(cleanPolygon, satelliteProvider, false)
        .then((res) => {
          if (analysisSeqRef.current !== seq) return;
          setHouseSpec((prev) => {
            if (!prev || prev.id !== newId) return prev;
            const style = userOverrodeRoofRef.current
              ? prev.roofStyle
              : res.analysis.predictedStyle;
            const stories = userOverrodeStoriesRef.current
              ? prev.stories
              : res.analysis.inferredStories;
            return {
              ...prev,
              polygon: cleanPolygon,
              stories,
              wallHeightM: Number((stories * 3.18).toFixed(2)),
              roofStyle: style,
              roofPitchDeg:
                style === 'flat'
                  ? 0
                  : userOverrodeRoofRef.current
                  ? prev.roofPitchDeg
                  : res.analysis.predictedPitchDeg,
              eaveOverhangM: style === 'flat' ? 0.08 : 0.36,
              ridgeAngleRad: res.analysis.ridgeAngleRad,
              shedSlopeAngleRad: res.analysis.shedSlopeAngleRad,
              satelliteTextureDataUrl: res.satelliteTextureDataUrl,
              detectedMaterialHint: res.analysis.predictedMaterial,
              neuralAnalysis: res.analysis,
            };
          });
        })
        .finally(() => {
          if (analysisSeqRef.current === seq) setIsAnalyzingNeural(false);
        });
    },
    [houseSpec, satelliteProvider]
  );

  const handleClearRoof = useCallback(() => {
    analysisSeqRef.current++;
    setIsAnalyzingNeural(false);
    setHouseSpec(null);
  }, []);

  const handleChangeRoofStyle = useCallback((roofStyle: RoofStyle) => {
    userOverrodeRoofRef.current = true;
    setHouseSpec((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        roofStyle,
        roofPitchDeg:
          roofStyle === 'flat'
            ? 0
            : roofStyle === 'shed'
            ? 12
            : prev.neuralAnalysis?.predictedPitchDeg && prev.neuralAnalysis.predictedPitchDeg >= 16
            ? prev.neuralAnalysis.predictedPitchDeg
            : 23,
        eaveOverhangM: roofStyle === 'flat' ? 0.08 : 0.36,
      };
    });
  }, []);

  const handleChangeStories = useCallback((stories: 1 | 2 | 3) => {
    userOverrodeStoriesRef.current = true;
    setHouseSpec((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        stories,
        wallHeightM: Number((stories * 3.18).toFixed(2)),
      };
    });
  }, []);

  return (
    <main className="relative w-screen h-screen bg-[#161816] text-[#111111] overflow-hidden">
      {/* SCREEN 1: FULLSCREEN SRI LANKA SATELLITE MAP */}
      <section
        className={`absolute inset-0 w-full h-full transition-opacity duration-200 ease-out ${
          screen === 'map'
            ? 'opacity-100 z-20 pointer-events-auto'
            : 'opacity-0 z-0 pointer-events-none'
        }`}
      >
        <SriLankaSatelliteMap
          spec={houseSpec}
          metrics={metrics}
          isAnalyzingNeural={isAnalyzingNeural}
          satelliteProvider={satelliteProvider}
          isActive={screen === 'map'}
          onChangeProvider={setSatelliteProvider}
          onCompleteRoofCorners={handleCompleteRoofCorners}
          onClearRoof={handleClearRoof}
          onFinishTo3D={() => setScreen('3d')}
        />
      </section>

      {/* SCREEN 2: FULLSCREEN 3D ARCHITECTURAL PROTOTYPE */}
      <section
        className={`absolute inset-0 w-full h-full transition-opacity duration-200 ease-out ${
          screen === '3d'
            ? 'opacity-100 z-20 pointer-events-auto'
            : 'opacity-0 z-0 pointer-events-none'
        }`}
      >
        <ThreeHouseStudio
          spec={houseSpec}
          metrics={metrics}
          isAnalyzingNeural={isAnalyzingNeural}
          finish={finish}
          isActive={screen === '3d'}
          onBackToMap={() => setScreen('map')}
          onOpenPrediction={() => setScreen('prediction')}
          onOpenSolar={() => setScreen('solar')}
          onOpenWater={() => setScreen('water')}
          onChangeFinish={setFinish}
          onChangeRoofStyle={handleChangeRoofStyle}
          onChangeStories={handleChangeStories}
        />
      </section>

      {/* SCREEN 3: FULLSCREEN WEATHER, CLIMATE & ROOF IMPACT PREDICTION */}
      <section
        className={`absolute inset-0 w-full h-full transition-opacity duration-200 ease-out ${
          screen === 'prediction'
            ? 'opacity-100 z-20 pointer-events-auto'
            : 'opacity-0 z-0 pointer-events-none'
        }`}
      >
        <PredictionStudio
          spec={houseSpec}
          metrics={metrics}
          isActive={screen === 'prediction'}
          onBackToStudio={() => setScreen('3d')}
        />
      </section>

      {/* SCREEN 4: FULLSCREEN 3D SOLAR PANEL PREVIEW & NET PLUS DESIGN STUDIO */}
      <section
        className={`absolute inset-0 w-full h-full transition-opacity duration-200 ease-out ${
          screen === 'solar'
            ? 'opacity-100 z-20 pointer-events-auto'
            : 'opacity-0 z-0 pointer-events-none'
        }`}
      >
        <SolarStudio
          spec={houseSpec}
          metrics={metrics}
          finish={finish}
          isActive={screen === 'solar'}
          onBackTo3D={() => setScreen('3d')}
        />
      </section>

      {/* SCREEN 5: FULLSCREEN WATER MANAGEMENT & RAIN HARVEST STUDIO */}
      <section
        className={`absolute inset-0 w-full h-full transition-opacity duration-200 ease-out ${
          screen === 'water'
            ? 'opacity-100 z-20 pointer-events-auto'
            : 'opacity-0 z-0 pointer-events-none'
        }`}
      >
        <WaterStudio
          spec={houseSpec}
          metrics={metrics}
          finish={finish}
          isActive={screen === 'water'}
          onBackToStudio={() => setScreen('3d')}
        />
      </section>

    </main>
  );
};

export default App;
