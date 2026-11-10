import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as maplibregl from 'maplibre-gl';
import {
  ArrowRight,
  Cpu,
  Crosshair,
  Loader2,
  MapPin,
  Maximize2,
  PenTool,
  RotateCcw,
  Search,
  Undo2,
  X,
} from 'lucide-react';
import {
  HouseMetrics,
  HouseSpec,
  LngLatPoint,
  SatelliteProvider,
} from '../types';
import {
  getMetersPerDegree,
  stripClosingPoint,
} from '../geometry/geoProjection';
import {
  looksLikeMapLink,
  parseCoordinatesOrGoogleUrl,
  PlaceSuggestion,
  resolveInputOrMapLink,
  searchSriLankaPlaces,
} from '../utils/mapLinkParser';

interface SriLankaSatelliteMapProps {
  spec: HouseSpec | null;
  metrics: HouseMetrics | null;
  isAnalyzingNeural: boolean;
  satelliteProvider: SatelliteProvider;
  isActive: boolean;
  onChangeProvider?: (provider: SatelliteProvider) => void;
  onCompleteRoofCorners: (
    polygon: LngLatPoint[],
    opts?: { liveDrag?: boolean; isVertexEdit?: boolean }
  ) => void;
  onClearRoof: () => void;
  onFinishTo3D: () => void;
}

type SimpleFeature = {
  type: 'Feature';
  properties: Record<string, string | number>;
  geometry:
    | { type: 'Polygon'; coordinates: [number, number][][] }
    | { type: 'LineString'; coordinates: [number, number][] }
    | { type: 'Point'; coordinates: [number, number] };
};

type SimpleFeatureCollection = {
  type: 'FeatureCollection';
  features: SimpleFeature[];
};

const EMPTY_FC: SimpleFeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

/**
 * Safely updates a MapLibre GeoJSON source immediately without ever gating on
 * `map.isStyleLoaded()` (which returns false whenever raster tiles are in flight).
 */
function setGeoJsonSourceData(
  map: maplibregl.Map,
  sourceId: string,
  data: SimpleFeatureCollection
): void {
  const src = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
    return;
  }
  const onStyleData = () => {
    const readySrc = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (readySrc) {
      map.off('styledata', onStyleData);
      readySrc.setData(data);
    }
  };
  map.on('styledata', onStyleData);
}

function polygonToFeatureCollection(pts: LngLatPoint[] | null): SimpleFeatureCollection {
  if (!pts || pts.length < 3) return EMPTY_FC;
  const clean = stripClosingPoint(pts);
  if (clean.length < 3) return EMPTY_FC;
  const closed = [...clean, clean[0]];
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [closed],
        },
      },
    ],
  };
}

function draftPointsToFeatureCollection(pts: LngLatPoint[]): SimpleFeatureCollection {
  if (pts.length === 0) return EMPTY_FC;
  const canClose = pts.length >= 3;
  return {
    type: 'FeatureCollection',
    features: pts.map((pt, idx) => ({
      type: 'Feature',
      properties: {
        idx,
        isFirstClosable: idx === 0 && canClose ? 1 : 0,
      },
      geometry: {
        type: 'Point',
        coordinates: [pt[0], pt[1]],
      },
    })),
  };
}

function buildNeuralRidgeSkeletonFeatures(
  spec: HouseSpec | null,
  metrics: HouseMetrics | null
): SimpleFeatureCollection {
  if (!spec || !metrics || metrics.vertices2D.length < 3) return EMPTY_FC;
  if (spec.roofStyle === 'flat' || spec.roofStyle === 'shed') return EMPTY_FC;

  const theta =
    spec.ridgeAngleRad !== undefined ? spec.ridgeAngleRad : metrics.dominantAngleRad;
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

  const spanU = maxU - minU;
  const spanV = maxV - minV;
  if (spanU < 1.5 || spanV < 1.5) return EMPTY_FC;

  const midV = 0.5 * (minV + maxV);
  const cb = Math.cos(theta);
  const sb = Math.sin(theta);
  const { metersPerDegLat, metersPerDegLng } = getMetersPerDegree(metrics.centroid[1]);

  const toLngLat = (u: number, v: number): [number, number] => {
    const x = u * cb - v * sb;
    const z = u * sb + v * cb;
    return [
      metrics.centroid[0] + x / metersPerDegLng,
      metrics.centroid[1] - z / metersPerDegLat,
    ];
  };

  const features: SimpleFeature[] = [];

  if (spec.roofStyle === 'gable') {
    features.push({
      type: 'Feature',
      properties: { kind: 'ridge' },
      geometry: {
        type: 'LineString',
        coordinates: [toLngLat(minU, midV), toLngLat(maxU, midV)],
      },
    });
  } else if (spec.roofStyle === 'hip') {
    const inset = Math.min(spanU * 0.48, spanV * 0.5);
    const uL = minU + inset;
    const uR = maxU - inset;

    if (uR - uL > 0.25) {
      features.push({
        type: 'Feature',
        properties: { kind: 'ridge' },
        geometry: {
          type: 'LineString',
          coordinates: [toLngLat(uL, midV), toLngLat(uR, midV)],
        },
      });
    }

    const hipSegs: [[number, number], [number, number]][] = [
      [[minU, minV], [uL, midV]],
      [[minU, maxV], [uL, midV]],
      [[maxU, minV], [uR, midV]],
      [[maxU, maxV], [uR, midV]],
    ];
    for (const [p0, p1] of hipSegs) {
      features.push({
        type: 'Feature',
        properties: { kind: 'hip' },
        geometry: {
          type: 'LineString',
          coordinates: [toLngLat(p0[0], p0[1]), toLngLat(p1[0], p1[1])],
        },
      });
    }
  }

  return { type: 'FeatureCollection', features };
}

export const SriLankaSatelliteMap: React.FC<SriLankaSatelliteMapProps> = ({
  spec,
  metrics,
  isAnalyzingNeural,
  satelliteProvider,
  isActive,
  onCompleteRoofCorners,
  onClearRoof,
  onFinishTo3D,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const draftMarkersRef = useRef<maplibregl.Marker[]>([]);
  const vertexMarkersRef = useRef<maplibregl.Marker[]>([]);
  const midpointMarkersRef = useRef<maplibregl.Marker[]>([]);

  const [zoomLevel, setZoomLevel] = useState<number>(19.2);
  const [draftCorners, setDraftCorners] = useState<LngLatPoint[]>([]);
  const [cursorPoint, setCursorPoint] = useState<LngLatPoint | null>(null);
  const [nearFirstCorner, setNearFirstCorner] = useState<boolean>(false);
  const [statusToast, setStatusToast] = useState<string | null>(null);

  // Search & Google Maps Share Link state
  const [searchInput, setSearchInput] = useState<string>('');
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState<boolean>(false);
  const [isResolvingSearch, setIsResolvingSearch] = useState<boolean>(false);
  const [pinnedTarget, setPinnedTarget] = useState<LngLatPoint | null>(null);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => {
    try {
      return localStorage.getItem('rm_onboard_v5') !== '1';
    } catch {
      return true;
    }
  });

  const dismissOnboarding = useCallback(() => {
    setShowOnboarding(false);
    try {
      localStorage.setItem('rm_onboard_v5', '1');
    } catch {
      /* private mode — banner just returns next visit */
    }
  }, []);

  const selectedPolygon = spec?.polygon ?? null;

  const draftCornersRef = useRef(draftCorners);
  draftCornersRef.current = draftCorners;
  const selectedPolyRef = useRef(selectedPolygon);
  selectedPolyRef.current = selectedPolygon;
  const onCompleteRef = useRef(onCompleteRoofCorners);
  onCompleteRef.current = onCompleteRoofCorners;
  const onClearRef = useRef(onClearRoof);
  onClearRef.current = onClearRoof;

  const flashToast = useCallback((msg: string) => {
    setStatusToast(msg);
    window.setTimeout(() => {
      setStatusToast((curr) => (curr === msg ? null : curr));
    }, 2600);
  }, []);

  const flyToCoordinates = useCallback(
    (lng: number, lat: number, zoom = 19.4, showPin = true) => {
      const map = mapRef.current;
      if (!map) return;
      if (showPin) {
        setPinnedTarget([lng, lat]);
      }
      map.flyTo({
        center: [lng, lat],
        zoom,
        speed: 1.55,
        curve: 1.35,
        essential: true,
      });
    },
    []
  );

  // Initialize MapLibre GL JS Live Satellite Map (Zero blocking external TileJSON URLs!)
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      attributionControl: false,
      maxPitch: 0,
      dragRotate: false,
      doubleClickZoom: false,
      touchZoomRotate: true,
      center: [79.9268, 6.8482],
      zoom: 19.2,
      minZoom: 6.4,
      maxZoom: 21,
      maxBounds: [
        [78.2, 4.9],
        [83.2, 10.7],
      ],
      style: {
        version: 8,
        sources: {
          'google-sat': {
            type: 'raster',
            tiles: [
              'https://mt0.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
              'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
              'https://mt2.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
              'https://mt3.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
            ],
            tileSize: 256,
            maxzoom: 21,
            attribution: 'Sri Lanka Live Satellite',
          },
          'esri-sat': {
            type: 'raster',
            tiles: [
              'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            ],
            tileSize: 256,
            maxzoom: 19,
            attribution: 'Esri World Imagery',
          },
          'selected-roof': {
            type: 'geojson',
            data: EMPTY_FC,
          },
          'neural-skeleton': {
            type: 'geojson',
            data: EMPTY_FC,
          },
          'draft-trace': {
            type: 'geojson',
            data: EMPTY_FC,
          },
          'draft-points': {
            type: 'geojson',
            data: EMPTY_FC,
          },
          'search-pin': {
            type: 'geojson',
            data: EMPTY_FC,
          },
        },
        layers: [
          {
            id: 'sat-google-layer',
            type: 'raster',
            source: 'google-sat',
            paint: {
              'raster-fade-duration': 160,
              'raster-contrast': 0.06,
              'raster-saturation': 0.04,
            },
          },
          {
            id: 'sat-esri-layer',
            type: 'raster',
            source: 'esri-sat',
            layout: { visibility: 'none' },
            paint: { 'raster-fade-duration': 160 },
          },
          // Search / Google Maps Shared Pin Target Ring
          {
            id: 'search-pin-ring',
            type: 'circle',
            source: 'search-pin',
            paint: {
              'circle-radius': 15,
              'circle-color': 'rgba(255, 82, 27, 0.22)',
              'circle-stroke-width': 2.5,
              'circle-stroke-color': '#FF521B',
            },
          },
          {
            id: 'search-pin-dot',
            type: 'circle',
            source: 'search-pin',
            paint: {
              'circle-radius': 5,
              'circle-color': '#E2FF32',
              'circle-stroke-width': 2,
              'circle-stroke-color': '#111111',
            },
          },
          // Selected roof polygon
          {
            id: 'selected-roof-fill',
            type: 'fill',
            source: 'selected-roof',
            paint: {
              'fill-color': '#E2FF32',
              'fill-opacity': 0.2,
            },
          },
          {
            id: 'selected-roof-casing',
            type: 'line',
            source: 'selected-roof',
            paint: {
              'line-color': '#111111',
              'line-width': 5,
            },
          },
          {
            id: 'selected-roof-stroke',
            type: 'line',
            source: 'selected-roof',
            paint: {
              'line-color': '#E2FF32',
              'line-width': 2.6,
            },
          },
          // Neural-identified roof ridge & hip skeleton lines
          {
            id: 'neural-skeleton-casing',
            type: 'line',
            source: 'neural-skeleton',
            paint: {
              'line-color': '#111111',
              'line-width': 3.5,
            },
          },
          {
            id: 'neural-skeleton-line',
            type: 'line',
            source: 'neural-skeleton',
            paint: {
              'line-color': ['match', ['get', 'kind'], 'ridge', '#E2FF32', '#FF521B'],
              'line-width': 2,
              'line-dasharray': [2, 1.5],
            },
          },
          // Draft rubber-band trace line & polygon preview
          {
            id: 'draft-trace-fill',
            type: 'fill',
            source: 'draft-trace',
            filter: ['==', '$type', 'Polygon'],
            paint: {
              'fill-color': '#E2FF32',
              'fill-opacity': 0.24,
            },
          },
          {
            id: 'draft-trace-casing',
            type: 'line',
            source: 'draft-trace',
            paint: {
              'line-color': '#111111',
              'line-width': 4.5,
            },
          },
          {
            id: 'draft-trace-line',
            type: 'line',
            source: 'draft-trace',
            paint: {
              'line-color': '#E2FF32',
              'line-width': 2.4,
              'line-dasharray': [2, 1.2],
            },
          },
          // WebGL exact point center anchor underneath numbered corner badges
          {
            id: 'draft-points-circle',
            type: 'circle',
            source: 'draft-points',
            paint: {
              'circle-radius': 4,
              'circle-color': '#E2FF32',
              'circle-stroke-width': 1.5,
              'circle-stroke-color': '#111111',
            },
          },
        ],
      },
    });

    map.on('move', () => {
      setZoomLevel(Number(map.getZoom().toFixed(2)));
    });

    map.on('mousemove', (e) => {
      const z = map.getZoom();
      if (z < 17.0) {
        map.getCanvas().style.cursor = 'zoom-in';
        return;
      }

      const curr = draftCornersRef.current;
      if (curr.length > 0) {
        if (curr.length >= 3) {
          const firstPx = map.project(curr[0]);
          const distPx = Math.hypot(firstPx.x - e.point.x, firstPx.y - e.point.y);
          if (distPx < 18) {
            setNearFirstCorner(true);
            setCursorPoint(curr[0]);
            map.getCanvas().style.cursor = 'pointer';
            return;
          }
        }
        setNearFirstCorner(false);
        setCursorPoint([e.lngLat.lng, e.lngLat.lat]);
        map.getCanvas().style.cursor = 'crosshair';
      } else {
        setNearFirstCorner(false);
        map.getCanvas().style.cursor = selectedPolyRef.current ? 'grab' : 'crosshair';
      }
    });

    map.on('click', (e) => {
      setShowDropdown(false);
      const z = map.getZoom();
      if (z < 17.0) {
        map.flyTo({
          center: [e.lngLat.lng, e.lngLat.lat],
          zoom: 19.2,
          speed: 1.55,
          curve: 1.35,
          essential: true,
        });
        return;
      }

      const curr = draftCornersRef.current;
      const clicked: LngLatPoint = [e.lngLat.lng, e.lngLat.lat];

      setPinnedTarget(null);

      if (curr.length === 0 && selectedPolyRef.current) {
        onClearRef.current();
        setDraftCorners([clicked]);
        return;
      }

      // Close polygon cleanly on the map when clicking near Corner #1
      if (curr.length >= 3) {
        const firstPx = map.project(curr[0]);
        if (Math.hypot(firstPx.x - e.point.x, firstPx.y - e.point.y) < 18) {
          const completed = [...curr];
          setDraftCorners([]);
          setCursorPoint(null);
          setNearFirstCorner(false);
          onCompleteRef.current(completed);
          return;
        }
      }

      setDraftCorners([...curr, clicked]);
    });

    map.on('dblclick', (e) => {
      e.preventDefault();
      const curr = draftCornersRef.current;
      if (curr.length >= 3) {
        const completed = [...curr];
        setDraftCorners([]);
        setCursorPoint(null);
        setNearFirstCorner(false);
        onCompleteRef.current(completed);
      }
    });

    mapRef.current = map;

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Ensure MapLibre canvas stays sized cleanly when switching back from 3D
  useEffect(() => {
    if (isActive && mapRef.current) {
      mapRef.current.resize();
    }
  }, [isActive]);

  // Keyboard shortcuts for Undo / Escape / Enter while on the Map screen
  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT') return;
      if (ev.key === 'Backspace' || (ev.key.toLowerCase() === 'z' && (ev.metaKey || ev.ctrlKey))) {
        if (draftCorners.length > 0) {
          ev.preventDefault();
          setDraftCorners((prev) => prev.slice(0, -1));
        }
      } else if (ev.key === 'Escape' && draftCorners.length > 0) {
        setDraftCorners([]);
        setCursorPoint(null);
      } else if (ev.key === 'Enter') {
        if (draftCorners.length >= 3) {
          const completed = [...draftCorners];
          setDraftCorners([]);
          setCursorPoint(null);
          setNearFirstCorner(false);
          onCompleteRoofCorners(completed);
          onFinishTo3D();
        } else if (selectedPolygon && selectedPolygon.length >= 3) {
          onFinishTo3D();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, draftCorners, selectedPolygon, onCompleteRoofCorners, onFinishTo3D]);

  // Sync Satellite Provider
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.getLayer('sat-google-layer')) {
      map.setLayoutProperty(
        'sat-google-layer',
        'visibility',
        satelliteProvider === 'google' ? 'visible' : 'none'
      );
    }
    if (map.getLayer('sat-esri-layer')) {
      map.setLayoutProperty(
        'sat-esri-layer',
        'visibility',
        satelliteProvider === 'esri' ? 'visible' : 'none'
      );
    }
  }, [satelliteProvider]);

  // Sync Search Pin Indicator immediately
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!pinnedTarget) {
      setGeoJsonSourceData(map, 'search-pin', EMPTY_FC);
    } else {
      setGeoJsonSourceData(map, 'search-pin', {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: pinnedTarget },
          },
        ],
      });
    }
  }, [pinnedTarget]);

  // Sync Draft Rubber-Band Line + High-Visibility Locked Numbered Corner Markers!
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // 1. Update WebGL rubber-band line & fill immediately (no isStyleLoaded gate!)
    setGeoJsonSourceData(map, 'draft-points', draftPointsToFeatureCollection(draftCorners));

    if (draftCorners.length === 0) {
      setGeoJsonSourceData(map, 'draft-trace', EMPTY_FC);
    } else {
      const pts = cursorPoint ? [...draftCorners, cursorPoint] : draftCorners;
      if (pts.length >= 3) {
        setGeoJsonSourceData(map, 'draft-trace', polygonToFeatureCollection(pts));
      } else if (pts.length === 2) {
        setGeoJsonSourceData(map, 'draft-trace', {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: pts },
            },
          ],
        });
      } else {
        setGeoJsonSourceData(map, 'draft-trace', EMPTY_FC);
      }
    }

    // 2. Render crisp numbered corner badges (1, 2, 3, 4...) inside UNSTYLED outer wrappers!
    // Outer wrapper has ZERO CSS classes, transforms, or transitions so MapLibre's
    // inline translate(...) keeps Corner #1 100% locked identically to every other corner!
    draftMarkersRef.current.forEach((m) => m.remove());
    draftMarkersRef.current = [];

    draftCorners.forEach((pt, idx) => {
      const isFirstClosable = idx === 0 && draftCorners.length >= 3;

      const wrapper = document.createElement('div');
      wrapper.style.width = '24px';
      wrapper.style.height = '24px';
      wrapper.style.display = 'flex';
      wrapper.style.alignItems = 'center';
      wrapper.style.justifyContent = 'center';
      wrapper.style.pointerEvents = 'none';

      const badge = document.createElement('div');
      badge.style.width = '22px';
      badge.style.height = '22px';
      badge.style.display = 'flex';
      badge.style.alignItems = 'center';
      badge.style.justifyContent = 'center';
      badge.style.fontFamily = '"IBM Plex Mono", monospace';
      badge.style.fontSize = '11px';
      badge.style.fontWeight = '800';
      badge.style.border = '2px solid #111111';
      badge.style.boxShadow = '2px 2px 0px #111111';
      badge.style.backgroundColor = isFirstClosable ? '#FF521B' : '#E2FF32';
      badge.style.color = isFirstClosable ? '#FFFFFF' : '#111111';
      badge.textContent = String(idx + 1);

      wrapper.appendChild(badge);

      const marker = new maplibregl.Marker({
        element: wrapper,
        anchor: 'center',
      })
        .setLngLat(pt)
        .addTo(map);

      draftMarkersRef.current.push(marker);
    });
  }, [draftCorners, cursorPoint]);

  // Sync Selected Roof + Neural Skeleton + Draggable Handles immediately
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    setGeoJsonSourceData(map, 'selected-roof', polygonToFeatureCollection(selectedPolygon));
    setGeoJsonSourceData(
      map,
      'neural-skeleton',
      buildNeuralRidgeSkeletonFeatures(spec, metrics)
    );

    vertexMarkersRef.current.forEach((m) => m.remove());
    vertexMarkersRef.current = [];
    midpointMarkersRef.current.forEach((m) => m.remove());
    midpointMarkersRef.current = [];

    if (!selectedPolygon || selectedPolygon.length < 3 || zoomLevel < 16.5) return;
    const clean = stripClosingPoint(selectedPolygon);

    clean.forEach((pt, idx) => {
      // Unstyled outer wrapper so MapLibre translate(...) is never touched by CSS
      const outer = document.createElement('div');
      outer.style.width = '20px';
      outer.style.height = '20px';
      outer.style.display = 'flex';
      outer.style.alignItems = 'center';
      outer.style.justifyContent = 'center';

      const dot = document.createElement('div');
      dot.className = 'roof-vertex-dot';
      dot.title = 'Drag corner to adjust roof · Double-click to delete corner';
      outer.appendChild(dot);

      outer.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        if (clean.length <= 3) return;
        const next = clean.filter((_, i) => i !== idx);
        onCompleteRef.current(next, { isVertexEdit: true });
      });

      const marker = new maplibregl.Marker({
        element: outer,
        draggable: true,
        anchor: 'center',
      })
        .setLngLat(pt)
        .addTo(map);

      marker.on('drag', () => {
        const lngLat = marker.getLngLat();
        const current = stripClosingPoint(selectedPolyRef.current || clean);
        const updated = current.map((p, i) =>
          i === idx ? ([lngLat.lng, lngLat.lat] as LngLatPoint) : p
        );
        setGeoJsonSourceData(map, 'selected-roof', polygonToFeatureCollection(updated));
        onCompleteRef.current(updated, { liveDrag: true, isVertexEdit: true });
      });

      marker.on('dragend', () => {
        const lngLat = marker.getLngLat();
        const current = stripClosingPoint(selectedPolyRef.current || clean);
        const updated = current.map((p, i) =>
          i === idx ? ([lngLat.lng, lngLat.lat] as LngLatPoint) : p
        );
        onCompleteRef.current(updated, { isVertexEdit: true });
      });

      vertexMarkersRef.current.push(marker);
    });

    if (clean.length < 18) {
      clean.forEach((a, idx) => {
        const b = clean[(idx + 1) % clean.length];
        const mid: LngLatPoint = [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])];

        const outer = document.createElement('div');
        outer.style.width = '14px';
        outer.style.height = '14px';
        outer.style.display = 'flex';
        outer.style.alignItems = 'center';
        outer.style.justifyContent = 'center';

        const dot = document.createElement('div');
        dot.className = 'roof-midpoint-dot';
        dot.title = 'Click to insert a corner on this edge';
        outer.appendChild(dot);

        outer.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const next = [...clean.slice(0, idx + 1), mid, ...clean.slice(idx + 1)];
          onCompleteRef.current(next, { isVertexEdit: true });
        });

        const marker = new maplibregl.Marker({ element: outer, anchor: 'center' })
          .setLngLat(mid)
          .addTo(map);
        midpointMarkersRef.current.push(marker);
      });
    }
  }, [selectedPolygon, spec, metrics, zoomLevel >= 16.5]);

  // Debounced Sri Lanka Place Autocomplete when typing text (not map URLs)
  useEffect(() => {
    const q = searchInput.trim();
    if (q.length < 2 || looksLikeMapLink(q) || parseCoordinatesOrGoogleUrl(q)) {
      setSuggestions([]);
      return;
    }

    const timer = window.setTimeout(async () => {
      const results = await searchSriLankaPlaces(q);
      setSuggestions(results);
      if (results.length > 0) setShowDropdown(true);
    }, 260);

    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const executeResolveAndFly = useCallback(
    async (rawText: string) => {
      const q = rawText.trim();
      if (!q) return;
      setIsResolvingSearch(true);
      setShowDropdown(false);
      try {
        const loc = await resolveInputOrMapLink(q);
        if (loc) {
          flyToCoordinates(loc.lng, loc.lat, loc.zoom ?? 19.4, true);
          flashToast(`JUMPED TO ${loc.label.toUpperCase()}`);
        } else {
          flashToast('COULD NOT FIND LOCATION IN SRI LANKA');
        }
      } finally {
        setIsResolvingSearch(false);
      }
    },
    [flyToCoordinates, flashToast]
  );

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    executeResolveAndFly(searchInput);
  };

  // Instant jump when user pastes a Google Maps share pin link or coordinates!
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text').trim();
    if (!pasted) return;
    if (looksLikeMapLink(pasted) || parseCoordinatesOrGoogleUrl(pasted)) {
      e.preventDefault();
      setSearchInput(pasted);
      executeResolveAndFly(pasted);
    }
  };

  const handleLocateMe = () => {
    if (!navigator.geolocation) {
      flashToast('GPS UNAVAILABLE IN BROWSER');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { longitude, latitude } = pos.coords;
        flyToCoordinates(longitude, latitude, 19.4, true);
        flashToast('JUMPED TO YOUR GPS LOCATION');
      },
      () => flashToast('LOCATION PERMISSION DENIED'),
      { enableHighAccuracy: true, timeout: 6000 }
    );
  };

  const canFinish =
    draftCorners.length >= 3 || Boolean(selectedPolygon && selectedPolygon.length >= 3);

  const handleFinishAndGoTo3D = () => {
    if (draftCorners.length >= 3) {
      const completed = [...draftCorners];
      setDraftCorners([]);
      setCursorPoint(null);
      setNearFirstCorner(false);
      onCompleteRoofCorners(completed);
      onFinishTo3D();
      return;
    }
    if (selectedPolygon && selectedPolygon.length >= 3) {
      onFinishTo3D();
    }
  };

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#161816]">
      <div ref={containerRef} className="w-full h-full" />

      {/* FIRST-RUN 3-STEP ONBOARDING STRIP (dismissible, remembered in localStorage) */}
      {showOnboarding && !selectedPolygon && (
        <div className="absolute bottom-16 sm:bottom-14 left-1/2 -translate-x-1/2 z-20 w-[min(94vw,560px)] pointer-events-auto">
          <div className="neo-card bg-[#111111] text-[#F9F8F3] px-3.5 py-2.5 flex items-center gap-3">
            <div className="flex-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono-tech text-[11px] sm:text-xs font-bold uppercase">
              <span className="px-1.5 py-0.5 bg-[#E2FF32] text-[#111111]">1 TAP ROOF CORNERS</span>
              <span className="text-[#555550]">→</span>
              <span className="px-1.5 py-0.5 bg-[#E2FF32] text-[#111111]">2 SEE IT IN 3D</span>
              <span className="text-[#555550]">→</span>
              <span className="px-1.5 py-0.5 bg-[#E2FF32] text-[#111111]">
                3 SOLAR &amp; WEATHER
              </span>
            </div>
            <button
              type="button"
              onClick={dismissOnboarding}
              className="shrink-0 p-1 text-[#9a9a90] hover:text-[#F9F8F3] cursor-pointer"
              aria-label="Dismiss onboarding"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* CENTERED SINGLE SEARCH & GOOGLE MAPS SHARE-PIN BAR */}
      <div className="absolute top-3 left-3 right-3 z-20 max-w-lg mx-auto pointer-events-auto">
        <form
          onSubmit={handleSearchSubmit}
          className="neo-card bg-[#F9F8F3] flex items-center px-2.5 py-1.5 gap-2"
        >
          {isResolvingSearch ? (
            <Loader2 className="w-4 h-4 text-[#FF521B] animate-spin shrink-0" />
          ) : (
            <Search className="w-4 h-4 text-[#111111] shrink-0" />
          )}

          <input
            type="text"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setShowDropdown(true);
            }}
            onFocus={() => {
              if (suggestions.length > 0) setShowDropdown(true);
            }}
            onPaste={handlePaste}
            placeholder="Search Sri Lanka or paste Google Maps pin link..."
            className="flex-1 min-w-0 bg-transparent text-xs font-medium text-[#111111] placeholder:text-[#666660] focus:outline-none select-text"
          />

          {searchInput && (
            <button
              type="button"
              onClick={() => {
                setSearchInput('');
                setSuggestions([]);
                setShowDropdown(false);
              }}
              className="p-0.5 text-[#555550] hover:text-[#111111] cursor-pointer"
              title="Clear Search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            type="submit"
            disabled={!searchInput.trim() || isResolvingSearch}
            className="px-2 py-1 bg-[#111111] text-[#E2FF32] disabled:opacity-40 font-mono-tech text-[10px] font-bold uppercase cursor-pointer"
          >
            Go
          </button>

          <button
            type="button"
            onClick={handleLocateMe}
            className="p-1 bg-[#FF521B] text-white border border-[#111111] cursor-pointer"
            title="Use My Current GPS Location"
          >
            <Crosshair className="w-3.5 h-3.5" />
          </button>
        </form>

        {/* AUTOCOMPLETE SUGGESTIONS DROPDOWN */}
        {showDropdown && suggestions.length > 0 && (
          <div className="mt-1.5 neo-card bg-[#F9F8F3] divide-y divide-[#111111]/15 max-h-60 overflow-y-auto">
            {suggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setSearchInput(s.title);
                  setShowDropdown(false);
                  flyToCoordinates(s.lng, s.lat, 19.25, true);
                }}
                className="w-full text-left px-3 py-2 hover:bg-[#E2FF32] transition-colors flex items-start gap-2 cursor-pointer"
              >
                <MapPin className="w-3.5 h-3.5 text-[#FF521B] mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs font-bold text-[#111111] truncate">{s.title}</div>
                  <div className="font-mono-tech text-[10px] text-[#555550] truncate">
                    {s.subtitle}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* LOW-ZOOM PROMPT */}
      {zoomLevel < 17.0 && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
          <div className="neo-card px-4 py-2 bg-[#E2FF32] text-[#111111] flex items-center gap-2.5">
            <Maximize2 className="w-4 h-4 shrink-0" />
            <span className="text-xs font-bold uppercase tracking-wide">
              Click anywhere on Sri Lanka to zoom to rooftops
            </span>
          </div>
        </div>
      )}

      {/* NEURAL SCAN INDICATOR */}
      {isAnalyzingNeural && (
        <div className="absolute inset-0 z-20 pointer-events-none flex items-center justify-center">
          <div className="neo-card px-4 py-2.5 bg-[#111111] text-[#E2FF32] font-mono-tech text-xs font-bold uppercase tracking-wider flex items-center gap-2.5">
            <Cpu className="w-4 h-4 animate-pulse text-[#FF521B]" />
            <span>LankaRoofNet Neural Scan · Identifying Roof...</span>
          </div>
        </div>
      )}

      {/* STATUS TOAST */}
      {statusToast && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
          <div className="neo-card-sm px-3 py-1.5 bg-[#111111] text-[#E2FF32] font-mono-tech text-[11px] font-semibold uppercase whitespace-nowrap">
            {statusToast}
          </div>
        </div>
      )}

      {/* BOTTOM DOCK — EXCLUSIVELY TAP CORNERS + FINISH TO 3D */}
      <div className="absolute bottom-3.5 left-3.5 right-3.5 z-10 flex flex-wrap items-end justify-start gap-2 pointer-events-none">
        <div className="neo-card p-1.5 bg-[#F9F8F3] flex flex-wrap items-center gap-2 pointer-events-auto">
          <div className="px-3 py-1.5 bg-[#E2FF32] text-[#111111] border border-[#111111] shadow-[2px_2px_0px_#111111] text-xs font-bold uppercase flex items-center gap-1.5">
            <PenTool className="w-3.5 h-3.5" />
            <span>Tap Corners</span>
          </div>

          <span className="font-mono-tech text-[11px] font-semibold text-[#111111] px-1.5">
            {draftCorners.length === 0 && !selectedPolygon && 'Tap roof corners on map'}
            {draftCorners.length > 0 &&
              draftCorners.length < 3 &&
              `${draftCorners.length} corner${draftCorners.length > 1 ? 's' : ''} — tap ${
                3 - draftCorners.length
              } more`}
            {draftCorners.length >= 3 &&
              (nearFirstCorner
                ? 'Click #1 to close outline or press Finish'
                : `${draftCorners.length} corners — press Finish for 3D`)}
            {draftCorners.length === 0 &&
              selectedPolygon &&
              `${selectedPolygon.length} corners ready — adjust or press Finish`}
          </span>

          {draftCorners.length > 0 && (
            <button
              type="button"
              onClick={() => setDraftCorners((prev) => prev.slice(0, -1))}
              className="neo-btn px-2.5 py-1.5 bg-[#F9F8F3] text-[#111111] text-[11px] font-mono-tech font-bold uppercase flex items-center gap-1 cursor-pointer"
              title="Undo Last Corner"
            >
              <Undo2 className="w-3 h-3" />
              <span>Undo</span>
            </button>
          )}

          {(selectedPolygon || draftCorners.length > 0) && (
            <button
              type="button"
              onClick={() => {
                setDraftCorners([]);
                setCursorPoint(null);
                setNearFirstCorner(false);
                onClearRoof();
              }}
              className="neo-btn px-2.5 py-1.5 bg-[#F9F8F3] text-[#111111] hover:bg-[#111111] hover:text-[#E2FF32] text-[11px] font-mono-tech font-bold uppercase flex items-center gap-1 cursor-pointer"
              title="Clear & Tap a New Building"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Clear</span>
            </button>
          )}

          <button
            type="button"
            disabled={!canFinish}
            onClick={handleFinishAndGoTo3D}
            className={`px-3.5 py-1.5 text-xs font-bold uppercase flex items-center gap-1.5 transition-all ${
              canFinish
                ? 'neo-btn bg-[#FF521B] text-white cursor-pointer'
                : 'bg-[#EAE8DF] text-[#777770] border border-[#111111]/35 opacity-55 cursor-not-allowed'
            }`}
          >
            <span>Finish</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
