"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { Map } from "react-map-gl/maplibre";
import polyline from "@mapbox/polyline";

export type PolylinePlayerSettings = {
  polylineText: string;
  progress: number;
  speed: number;
  followCamera: boolean;
  rotateCamera: boolean;
  zoom: number;
  trailMode: "full" | "progress" | "none";
  dotSize: number;
  dotGlowRadius: number;
  showDot: boolean;
  showStreetNames: boolean;
};

export const defaultPlayerSettings: PolylinePlayerSettings = {
  "polylineText": "kmbcFdtbhVf@AdADv@CF@JAXBCz@ERDJCJDJ@l@ATDPGTC?ID[?EDG?EEA@KAEDKBHm@CKCDIr@GFCGCg@I@FZ?PCFMEQ@DSGFECAFC@i@GAJBHAFJX?DFBQb@JYD?@INGCCDGJNf@TCPED?JJ_@D@BNCH@DB@AHB@HKAGCABMC]LJDHD?HFHABIDCAMBGVBBEDBDAFt@CRBTCDE~@?NeAC@QAU@UCWEBCOE@ADIAKBIGGJCACBKAGH?HHFJAFD@ABBDEFBHAF@BDDE@@@f@BD_@Dc@Ae@@[?MEEDICG@EC@MAmBDyBASPM?GBE@W@ECKBI?UF?BEHC@WGYMCMFENAt@@FAHD\\CJ?JGDAYD@?CEI@cD@Ah@?",
  "progress": 1,
  "speed": 0.04,
  "followCamera": false,
  "rotateCamera": false,
  "zoom": 16.4,
  "trailMode": "progress",
  "dotSize": 2,
  "dotGlowRadius": 5,
  "showDot": true,
  "showStreetNames": true
};

type Coord = [number, number];

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function distance(a: Coord, b: Coord) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function interpolatePath(path: Coord[], progress: number): Coord {
  if (path.length === 0) return [0, 0];
  if (path.length === 1) return path[0];

  const segments: number[] = [];

  let total = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const len = distance(path[i], path[i + 1]);
    segments.push(len);
    total += len;
  }

  const target = total * progress;

  let acc = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (acc + seg >= target) {
      const t = (target - acc) / seg;

      return [
        lerp(path[i][0], path[i + 1][0], t),
        lerp(path[i][1], path[i + 1][1], t),
      ];
    }

    acc += seg;
  }

  return path[path.length - 1];
}

function getBearing(a: Coord, b: Coord) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];

  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

function getProgressedPath(path: Coord[], progress: number): Coord[] {
  if (path.length === 0) return [];
  if (path.length === 1) return [path[0]];
  if (progress <= 0) return [path[0]];
  if (progress >= 1) return path;

  const segments: number[] = [];
  let total = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const len = distance(path[i], path[i + 1]);
    segments.push(len);
    total += len;
  }

  const target = total * progress;
  let acc = 0;
  const result: Coord[] = [path[0]];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const nextAcc = acc + seg;

    if (nextAcc >= target) {
      const t = (target - acc) / seg;
      const interpolated: Coord = [
        lerp(path[i][0], path[i + 1][0], t),
        lerp(path[i][1], path[i + 1][1], t),
      ];

      result.push(interpolated);
      return result;
    }

    result.push(path[i + 1]);
    acc = nextAcc;
  }

  return path;
}

export default function PolylinePlayer() {
  const [polylineText, setPolylineText] = useState(
    defaultPlayerSettings.polylineText
  );

  const [playing, setPlaying] = useState(false);

  const [progress, setProgress] = useState(defaultPlayerSettings.progress);

  const [speed, setSpeed] = useState(defaultPlayerSettings.speed);

  const [followCamera, setFollowCamera] = useState(
    defaultPlayerSettings.followCamera
  );

  const [rotateCamera, setRotateCamera] = useState(
    defaultPlayerSettings.rotateCamera
  );

  const [zoom, setZoom] = useState(defaultPlayerSettings.zoom);

  const [trailMode, setTrailMode] = useState<"full" | "progress" | "none">(
    defaultPlayerSettings.trailMode
  );

  const [dotSize, setDotSize] = useState(defaultPlayerSettings.dotSize);
  const [dotGlowRadius, setDotGlowRadius] = useState(
    defaultPlayerSettings.dotGlowRadius
  );

  const [showDot, setShowDot] = useState(defaultPlayerSettings.showDot);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [showStreetNames, setShowStreetNames] = useState(defaultPlayerSettings.showStreetNames);
  const [mapStyle, setMapStyle] = useState<any>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const animationRef = useRef<number | null>(null);

  const path = useMemo<Coord[]>(() => {
    try {
      const decoded = polyline.decode(polylineText) as [number, number][];

      return decoded.map(([lat, lng]: [number, number]) => [lng, lat]);
    } catch {
      return [];
    }
  }, [polylineText]);

  const currentPosition = useMemo(() => {
    return interpolatePath(path, progress);
  }, [path, progress]);

  const currentBearing = useMemo(() => {
    if (path.length < 2) return 0;

    const nextProgress = Math.min(progress + 0.01, 1);

    const nextPos = interpolatePath(path, nextProgress);

    return getBearing(currentPosition, nextPos);
  }, [path, progress, currentPosition]);

  const displayedPath = useMemo(() => {
    if (trailMode === "none") return [];
    if (trailMode === "progress") return getProgressedPath(path, progress);
    return path;
  }, [path, progress, trailMode]);

  useEffect(() => {
    const fetchAndModifyStyle = async () => {
      try {
        const response = await fetch("https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json");
        const style = await response.json();

        if (!showStreetNames) {
          // Hide label layers by setting visibility to "none"
          style.layers = style.layers.map((layer: any) => {
            if (layer.type === "symbol" && (layer.id.includes("label") || layer.id.includes("place") || layer.id.includes("road"))) {
              return { ...layer, layout: { ...layer.layout, visibility: "none" } };
            }
            return layer;
          });
        }

        setMapStyle(style);
      } catch (error) {
        console.error("Failed to load map style:", error);
        setMapStyle("https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json");
      }
    };

    fetchAndModifyStyle();
  }, [showStreetNames]);

  const applySettings = (settings: PolylinePlayerSettings) => {
    setPolylineText(settings.polylineText);
    setProgress(settings.progress);
    setSpeed(settings.speed);
    setFollowCamera(settings.followCamera);
    setRotateCamera(settings.rotateCamera);
    setZoom(settings.zoom);
    setTrailMode(settings.trailMode);
    setDotSize(settings.dotSize);
    setDotGlowRadius(settings.dotGlowRadius);
    setShowDot(settings.showDot);
    setShowStreetNames(settings.showStreetNames);
  };

  const isValidSettings = (value: any): value is PolylinePlayerSettings => {
    return (
      value &&
      typeof value.polylineText === "string" &&
      typeof value.progress === "number" &&
      typeof value.speed === "number" &&
      typeof value.followCamera === "boolean" &&
      typeof value.rotateCamera === "boolean" &&
      typeof value.zoom === "number" &&
      (value.trailMode === "full" ||
        value.trailMode === "progress" ||
        value.trailMode === "none") &&
      typeof value.dotSize === "number" &&
      typeof value.dotGlowRadius === "number" &&
      typeof value.showDot === "boolean" &&
      typeof value.showStreetNames === "boolean"
    );
  };

  const exportSettings = () => {
    const settings: PolylinePlayerSettings = {
      polylineText,
      progress,
      speed,
      followCamera,
      rotateCamera,
      zoom,
      trailMode,
      dotSize,
      dotGlowRadius,
      showDot,
      showStreetNames,
    };

    const blob = new Blob([JSON.stringify(settings, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "polyline-player-settings.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const importSettings = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (isValidSettings(data)) {
        applySettings(data);
        setSettingsError(null);
      } else {
        setSettingsError("Imported file is not valid settings JSON.");
      }
    } catch {
      setSettingsError("Unable to parse imported JSON file.");
    }
  };

  const onFileInputChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];

    if (file) {
      importSettings(file);
    }
    if (event.target) {
      event.target.value = "";
    }
  };

  const resetDefaults = () => {
    applySettings(defaultPlayerSettings);
    setSettingsError(null);
  };

  useEffect(() => {
    if (!playing) return;

    let last = performance.now();

    const animate = (now: number) => {
      const delta = (now - last) / 1000;

      last = now;

      setProgress((p) => {
        const next = p + delta * speed;

        if (next >= 1) {
          setPlaying(false);
          return 1;
        }

        return next;
      });

      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [playing, speed]);

  const layers = [
    trailMode !== "none" &&
    new PathLayer({
      id: "path",

      data: [{ path: displayedPath }],

      getPath: (d: any) => d.path,

      getColor: [255, 140, 0],

      widthUnits: "pixels",

      getWidth: 6,

      rounded: true,
    }),

    showDot &&
    new ScatterplotLayer({
      id: "dot-glow",

      data: [{ position: currentPosition }],

      getPosition: (d: any) => d.position,

      radiusUnits: "meters",

      getRadius: dotGlowRadius,

      stroked: false,

      filled: true,

      getFillColor: [255, 140, 0, 40],

      billboard: true,
    }),

    showDot &&
    new ScatterplotLayer({
      id: "dot-core",

      data: [{ position: currentPosition }],

      getPosition: (d: any) => d.position,

      radiusUnits: "meters",

      getRadius: dotSize,

      stroked: true,

      getLineColor: [255, 255, 255],

      lineWidthUnits: "pixels",

      getLineWidth: 2,

      getFillColor: [255, 160, 0, 255],

      billboard: true,
    }),
  ].filter(Boolean);

  const viewState = {
    longitude: currentPosition[0] || -122.4,

    latitude: currentPosition[1] || 37.78,

    zoom: zoom + 1,

    pitch: followCamera ? 65 : 0,

    bearing: rotateCamera ? currentBearing : 0,
  };

  return (
    <div className="fixed inset-0 bg-black text-white flex overflow-hidden">
      <div className="w-[380px] shrink-0 bg-zinc-900 p-4 overflow-y-auto border-r border-zinc-800 z-10">
        <h1 className="text-2xl font-bold mb-4">
          deck.gl Polyline Animator
        </h1>

        <div className="mb-4">
          <label className="block mb-2 text-sm text-zinc-300">
            Encoded Polyline
          </label>

          <textarea
            value={polylineText}
            onChange={(e) => setPolylineText(e.target.value)}
            className="w-full h-32 bg-zinc-800 rounded-lg p-3 text-sm font-mono"
          />
        </div>

        <div className="flex gap-2 mb-4 flex-wrap">
          <button
            onClick={() => setPlaying(true)}
            className="bg-orange-500 hover:bg-orange-400 transition px-3 py-2 rounded-lg"
          >
            Play
          </button>

          <button
            onClick={() => setPlaying(false)}
            className="bg-zinc-700 hover:bg-zinc-600 transition px-3 py-2 rounded-lg"
          >
            Pause
          </button>

          <button
            onClick={() => {
              setPlaying(false);
              setProgress(0);
            }}
            className="bg-zinc-700 hover:bg-zinc-600 transition px-3 py-2 rounded-lg"
          >
            Restart
          </button>

          <button
            onClick={() => {
              setPlaying(false);
              setProgress(1);
            }}
            className="bg-zinc-700 hover:bg-zinc-600 transition px-3 py-2 rounded-lg"
          >
            Stop
          </button>
        </div>

        <div className="flex gap-2 mb-4 flex-wrap">
          <button
            onClick={exportSettings}
            className="bg-emerald-500 hover:bg-emerald-400 transition px-3 py-2 rounded-lg"
          >
            Export Settings
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="bg-sky-500 hover:bg-sky-400 transition px-3 py-2 rounded-lg"
          >
            Import Settings
          </button>

          <button
            onClick={resetDefaults}
            className="bg-zinc-700 hover:bg-zinc-600 transition px-3 py-2 rounded-lg"
          >
            Reset Defaults
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={onFileInputChange}
          />
        </div>

        {settingsError ? (
          <div className="mb-4 rounded-lg border border-red-500 bg-red-950/20 p-3 text-sm text-red-200">
            {settingsError}
          </div>
        ) : null}

        <div className="mb-5">
          <label className="block mb-2">
            Speed: {speed.toFixed(2)}
          </label>

          <input
            type="range"
            min={0.02}
            max={1}
            step={0.01}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            className="w-full"
          />
        </div>

        <div className="mb-5">
          <label className="block mb-2">
            Zoom: {zoom.toFixed(1)}
          </label>

          <input
            type="range"
            min={3}
            max={20}
            step={0.1}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-full"
          />
        </div>

        <div className="space-y-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={followCamera}
              onChange={(e) => setFollowCamera(e.target.checked)}
            />
            Follow Camera
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={rotateCamera}
              onChange={(e) => setRotateCamera(e.target.checked)}
            />
            Rotate Camera
          </label>

          <div className="space-y-2">
            <label className="block text-sm text-zinc-300">
              Trail Mode
            </label>
            <select
              value={trailMode}
              onChange={(e) =>
                setTrailMode(e.target.value as "full" | "progress" | "none")
              }
              className="w-full bg-zinc-800 rounded-lg p-3"
            >
              <option value="full">Full Trail</option>
              <option value="progress">Progress Trail</option>
              <option value="none">No Trail</option>
            </select>
          </div>

          <div className="mb-4">
            <label className="block mb-2">
              Dot Size: {dotSize.toFixed(0)}
            </label>
            <input
              type="range"
              min={1}
              max={60}
              step={1}
              value={dotSize}
              onChange={(e) => setDotSize(Number(e.target.value))}
              className="w-full"
            />
          </div>

          <div className="mb-4">
            <label className="block mb-2">
              Dot Glow Radius: {dotGlowRadius.toFixed(0)}
            </label>
            <input
              type="range"
              min={0}
              max={120}
              step={1}
              value={dotGlowRadius}
              onChange={(e) => setDotGlowRadius(Number(e.target.value))}
              className="w-full"
            />
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showDot}
              onChange={(e) => setShowDot(e.target.checked)}
            />
            Show Orange Dot
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showStreetNames}
              onChange={(e) => setShowStreetNames(e.target.checked)}
            />
            Show Street Names
          </label>
        </div>

        <div className="mt-6">
          <label className="block mb-2">
            Timeline: {(progress * 100).toFixed(1)}%
          </label>

          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={progress}
            onChange={(e) => setProgress(Number(e.target.value))}
            className="w-full"
          />
        </div>
      </div>

      <div className="flex-1 relative">
        <DeckGL
          controller={true}
          layers={layers}
          viewState={viewState}
        >
          <Map
            mapStyle={mapStyle || "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"}
          />
        </DeckGL>
      </div>
    </div>
  );
}