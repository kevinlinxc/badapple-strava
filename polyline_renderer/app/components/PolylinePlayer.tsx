"use client";

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import DeckGL from "@deck.gl/react";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { Map } from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";
import polyline from "@mapbox/polyline";
import KeyframeSlider from "./KeyframeSlider";

export type Keyframe = { time: number; value: number };

type FrameActivity = { frame: number; distance_m: number; time_s: number; polyline: string };

export type PolylinePlayerSettings = {
  frameIndex: number;
  progress: number;
  speed: number;
  followCamera: boolean;
  rotateCamera: boolean;
  zoom: number;
  pitch: number;
  followStrength: number;
  bearingStrength: number;
  trailMode: "full" | "progress" | "none";
  dotSize: number;
  dotGlowRadius: number;
  showDot: boolean;
  showStreetNames: boolean;
  videoOpacity: number;
  mapTheme?: string;
  finalBlendMode?: string;
  zoomKeyframes: Keyframe[];
  pitchKeyframes: Keyframe[];
  followStrengthKeyframes: Keyframe[];
  bearingStrengthKeyframes: Keyframe[];
  videoOpacityKeyframes: Keyframe[];
};

export const defaultPlayerSettings: PolylinePlayerSettings = {
  "frameIndex": 1815,
  "progress": 1,
  "speed": 0.04,
  "followCamera": true,
  "rotateCamera": true,
  "zoom": 16.4,
  "pitch": 0,
  "followStrength": 100,
  "bearingStrength": 100,
  "trailMode": "progress",
  "dotSize": 1,
  "dotGlowRadius": 3,
  "showDot": true,
  "showStreetNames": false,
  "videoOpacity": 0.77,
  "zoomKeyframes": [
    {
      "time": 0,
      "value": 19.496199819454667
    },
    {
      "time": 0.9609929078014183,
      "value": 15.90121738236726
    },
    {
      "time": 0.521952043228639,
      "value": 19.108661825533698
    }
  ],
  "pitchKeyframes": [
    {
      "time": 0.008611955420466059,
      "value": 63.71581150043336
    },
    {
      "time": 1,
      "value": 0
    }
  ],
  "followStrengthKeyframes": [
    {
      "time": 0,
      "value": 100
    },
    {
      "time": 1,
      "value": 0
    },
    {
      "time": 0.5962512664640324,
      "value": 98.48023388523461
    }
  ],
  "bearingStrengthKeyframes": [
    {
      "time": 0,
      "value": 100
    },
    {
      "time": 0.3159405606214116,
      "value": 0
    },
    {
      "time": 0.2281323877068558,
      "value": 100
    }
  ],
  "videoOpacityKeyframes": [
    {
      "time": 1,
      "value": 1
    },
    {
      "time": 0.6975683890577508,
      "value": 0
    }
  ],
  "mapTheme": "dark-matter",
  "finalBlendMode": "normal"
}

function interpolateKfs(kfs: Keyframe[], progress: number): number | null {
  if (kfs.length === 0) return null;
  const sorted = [...kfs].sort((a, b) => a.time - b.time);
  if (sorted.length === 1) return sorted[0].value;
  if (progress <= sorted[0].time) return sorted[0].value;
  if (progress >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].value;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (progress >= a.time && progress <= b.time) {
      const t = (progress - a.time) / (b.time - a.time || 1);
      return a.value + (b.value - a.value) * t;
    }
  }
  return sorted[sorted.length - 1].value;
}
const SHOW_DEBUG = false;
const DEFAULT_VIEW_COORDINATES: Coord = [-122.080748, 37.3727745];
const VIDEO_FPS = 30;
const VIDEO_TOTAL_FRAMES = 6572;

function frameToVideoTime(frame: number, videoDuration: number): number {
  return (frame / VIDEO_TOTAL_FRAMES) * videoDuration;
}
type Coord = [number, number];

type Activity = {
  frame: number;
  distance_m: number;
  time_s: number;
  polyline: string;
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTimeHMS(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const hh = h.toString().padStart(2, "0");
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");
  return `${hh}h${mm}m${ss}s`;
}

function formatDistanceKm(meters: number): string {
  return `${(meters / 1000).toFixed(2)} km`;
}

function StatPill({ label, current, max, unit }: { label: string; current: number; max: number; unit: string }) {
  const displayValue = max > 0 ? Math.min(current, max) : 0;
  const formatted = unit === "m" ? `${Math.round(displayValue)} m` : unit === "km" ? formatDistanceKm(displayValue) : unit === "hms" ? formatTimeHMS(displayValue) : formatTime(displayValue);
  return (
    <div className="bg-black/50 rounded-2xl px-3 py-1 flex flex-col items-center">
      <span className="text-white/70 text-xs">{label}</span>
      <span className="text-white text-xl font-semibold tabular-nums">{formatted}</span>
    </div>
  );
}

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

function usePersistedState<T>(key: string, defaultValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(defaultValue);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(`polyline-player-${key}`);
      if (stored !== null) setState(JSON.parse(stored));
    } catch {}
  }, [key]);

  useEffect(() => {
    try {
      localStorage.setItem(`polyline-player-${key}`, JSON.stringify(state));
    } catch {}
  }, [key, state]);

  return [state, setState];
}

const MAP_THEMES = [
  { id: "dark-matter", label: "Dark Matter", url: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" },
  { id: "positron", label: "Positron", url: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json" },
  { id: "voyager", label: "Voyager", url: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json" },
  { id: "dark-matter-nolabels", label: "Dark Matter (no labels)", url: "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json" },
  { id: "positron-nolabels", label: "Positron (no labels)", url: "https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json" },
  { id: "voyager-nolabels", label: "Voyager (no labels)", url: "https://basemaps.cartocdn.com/gl/voyager-nolabels-gl-style/style.json" },
];

function applyBlendMode(ctx: CanvasRenderingContext2D, width: number, height: number, mode: string) {
  if (mode === "normal") return;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (mode === "screen") {
      data[i + 3] = 255 - Math.round(lum);
    } else if (mode === "overlay") {
      data[i + 3] = Math.round(lum);
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

export default function PolylinePlayer() {
  const [frameIndex, setFrameIndex] = usePersistedState("frameIndex", defaultPlayerSettings.frameIndex);
  const [frameData, setFrameData] = useState<FrameActivity[] | null>(null);

  const [playing, setPlaying] = useState(false);

  const [progress, setProgress] = usePersistedState("progress", defaultPlayerSettings.progress);

  const [speed, setSpeed] = usePersistedState("speed", defaultPlayerSettings.speed);

  const [followCamera, setFollowCamera] = usePersistedState("followCamera", defaultPlayerSettings.followCamera);

  const [rotateCamera, setRotateCamera] = usePersistedState("rotateCamera", defaultPlayerSettings.rotateCamera);

  const [zoom, setZoom] = usePersistedState("zoom", defaultPlayerSettings.zoom);

  const [pitch, setPitch] = usePersistedState("pitch", defaultPlayerSettings.pitch);
  const [followStrength, setFollowStrength] = usePersistedState("followStrength", defaultPlayerSettings.followStrength);
  const [bearingStrength, setBearingStrength] = usePersistedState("bearingStrength", defaultPlayerSettings.bearingStrength);

  const [trailMode, setTrailMode] = usePersistedState<"full" | "progress" | "none">("trailMode", defaultPlayerSettings.trailMode);

  const [dotSize, setDotSize] = usePersistedState("dotSize", defaultPlayerSettings.dotSize);
  const [dotGlowRadius, setDotGlowRadius] = usePersistedState("dotGlowRadius", defaultPlayerSettings.dotGlowRadius);

  const [showDot, setShowDot] = usePersistedState("showDot", defaultPlayerSettings.showDot);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [showStreetNames, setShowStreetNames] = usePersistedState("showStreetNames", defaultPlayerSettings.showStreetNames);
  const [showStats, setShowStats] = usePersistedState("showStats", true);
  const [mapTheme, setMapTheme] = usePersistedState("mapTheme", "dark-matter");
  const [zoomKf, setZoomKf] = useState<number | null>(null);
  const [pitchKf, setPitchKf] = useState<number | null>(null);
  const [followStrengthKf, setFollowStrengthKf] = useState<number | null>(null);
  const [bearingStrengthKf, setBearingStrengthKf] = useState<number | null>(null);
  const [videoOpacity, setVideoOpacity] = usePersistedState("videoOpacity", defaultPlayerSettings.videoOpacity);
  const [videoOpacityKf, setVideoOpacityKf] = useState<number | null>(null);
  const [zoomKfs, setZoomKfs] = usePersistedState<Keyframe[]>("zoomKfs", defaultPlayerSettings.zoomKeyframes);
  const [pitchKfs, setPitchKfs] = usePersistedState<Keyframe[]>("pitchKfs", defaultPlayerSettings.pitchKeyframes);
  const [followStrengthKfs, setFollowStrengthKfs] = usePersistedState<Keyframe[]>("followStrengthKfs", defaultPlayerSettings.followStrengthKeyframes);
  const [bearingStrengthKfs, setBearingStrengthKfs] = usePersistedState<Keyframe[]>("bearingStrengthKfs", defaultPlayerSettings.bearingStrengthKeyframes);
  const [videoOpacityKfs, setVideoOpacityKfs] = usePersistedState<Keyframe[]>("videoOpacityKfs", defaultPlayerSettings.videoOpacityKeyframes);
  const [videoSourceReady, setVideoSourceReady] = useState(false);

  const [mode, setMode] = useState<"art" | "final">("art");
  const [finalStartFrame, setFinalStartFrame] = usePersistedState("finalStartFrame", 0);
  const [finalShowVideo, setFinalShowVideo] = usePersistedState("finalShowVideo", true);
  const [finalCumulativeDistance, setFinalCumulativeDistance] = useState(0);
  const [finalCumulativeTime, setFinalCumulativeTime] = useState(0);
  const [finalZoom, setFinalZoom] = usePersistedState("finalZoom", 16);
  const [finalShowSilhouette, setFinalShowSilhouette] = usePersistedState("finalShowSilhouette", true);
  const [finalSilhouetteOpacity, setFinalSilhouetteOpacity] = usePersistedState("finalSilhouetteOpacity", 0.5);
  const [finalPlayMusic, setFinalPlayMusic] = usePersistedState("finalPlayMusic", false);
  const [finalVideoLowFps, setFinalVideoLowFps] = usePersistedState("finalVideoLowFps", false);
  const [final1Fps, setFinal1Fps] = usePersistedState("final1Fps", false);
  const [finalShowDebug, setFinalShowDebug] = usePersistedState("finalShowDebug", false);
  const [finalSpeed, setFinalSpeed] = usePersistedState("finalSpeed", 1.0);
  const [finalBlendMode, setFinalBlendMode] = usePersistedState("finalBlendMode", "normal");

  useEffect(() => {
    fetch("/bad_apple_activities.json")
      .then((r) => r.json())
      .then((data: FrameActivity[]) => setFrameData(data))
      .catch(() => {});
  }, []);

  const polylineText = useMemo(() => {
    if (!frameData || frameData.length === 0) return "";
    let best = frameData[0];
    for (const f of frameData) {
      if (f.frame <= frameIndex) best = f;
      else break;
    }
    return best.polyline;
  }, [frameData, frameIndex]);

  const currentActivity = useMemo(() => {
    if (!frameData || frameData.length === 0) return null;
    let best = frameData[0];
    for (const f of frameData) {
      if (f.frame <= frameIndex) best = f;
      else break;
    }
    return best;
  }, [frameData, frameIndex]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const mapRef = useRef<MapRef | null>(null);
  const opacityRef = useRef(1);
  const showStreetNamesRef = useRef(showStreetNames);
  showStreetNamesRef.current = showStreetNames;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);

  const [debug, setDebug] = useState({
    playing: false,
    progress: 0,
    videoTime: 0,
    videoDuration: 0,
    videoPaused: true,
    videoReady: 0,
    expectedTime: 0,
    frameIndex: 0,
  });

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
    const map = mapRef.current?.getMap();
    if (!map) return;
    const visibility = showStreetNames ? "visible" : "none";
    const layers = map.getStyle().layers;
    if (!layers) return;
    for (const layer of layers) {
      if (layer.type === "symbol" && (layer.id.includes("label") || layer.id.includes("place") || layer.id.includes("road") || layer.id.includes("poi") || layer.id.includes("watername") || layer.id.includes("housenumber"))) {
        map.setLayoutProperty(layer.id, "visibility", visibility);
      }
    }
  }, [showStreetNames]);

  const mapThemeUrl = MAP_THEMES.find(t => t.id === mapTheme)?.url ?? MAP_THEMES[0].url;

  const applySettings = (settings: PolylinePlayerSettings) => {
    setFrameIndex(settings.frameIndex);
    setProgress(settings.progress);
    setSpeed(settings.speed);
    setFollowCamera(settings.followCamera);
    setRotateCamera(settings.rotateCamera);
    setZoom(settings.zoom);
    setPitch(settings.pitch);
    setFollowStrength(settings.followStrength);
    setBearingStrength(settings.bearingStrength);
    setTrailMode(settings.trailMode);
    setDotSize(settings.dotSize);
    setDotGlowRadius(settings.dotGlowRadius);
    setShowDot(settings.showDot);
    setShowStreetNames(settings.showStreetNames);
    setVideoOpacity(settings.videoOpacity ?? 1);
    setZoomKfs(settings.zoomKeyframes ?? []);
    setPitchKfs(settings.pitchKeyframes ?? []);
    setFollowStrengthKfs(settings.followStrengthKeyframes ?? []);
    setBearingStrengthKfs(settings.bearingStrengthKeyframes ?? []);
    setVideoOpacityKfs(settings.videoOpacityKeyframes ?? []);
    if (settings.mapTheme) setMapTheme(settings.mapTheme);
    if (settings.finalBlendMode) setFinalBlendMode(settings.finalBlendMode);
  };

  const isValidSettings = (value: any): value is PolylinePlayerSettings => {
    return (
      value &&
      typeof value.frameIndex === "number" &&
      typeof value.progress === "number" &&
      typeof value.speed === "number" &&
      typeof value.followCamera === "boolean" &&
      typeof value.rotateCamera === "boolean" &&
      typeof value.zoom === "number" &&
      typeof value.pitch === "number" &&
      typeof value.followStrength === "number" &&
      typeof value.bearingStrength === "number" &&
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
      frameIndex,
      progress,
      speed,
      followCamera,
      rotateCamera,
      zoom,
      pitch,
      followStrength,
      bearingStrength,
      trailMode,
      dotSize,
      dotGlowRadius,
      showDot,
      showStreetNames,
      videoOpacity,
      zoomKeyframes: zoomKfs,
      pitchKeyframes: pitchKfs,
      followStrengthKeyframes: followStrengthKfs,
      bearingStrengthKeyframes: bearingStrengthKfs,
      videoOpacityKeyframes: videoOpacityKfs,
      mapTheme,
      finalBlendMode,
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

  const finishedPlayingRef = useRef<number | null>(null);
  const VIDEO_TAIL_DURATION = 5;

  useEffect(() => {
    if (mode !== "art" || !playing) return;

    finishedPlayingRef.current = null;
    let last = performance.now();

    const animate = (now: number) => {
      const delta = (now - last) / 1000;

      last = now;

      setProgress((p) => {
        const next = p + delta * speed;

        if (next >= 1) {
          if (finishedPlayingRef.current === null) {
            finishedPlayingRef.current = now;
          }
          if (now - finishedPlayingRef.current >= VIDEO_TAIL_DURATION * 1000) {
            setPlaying(false);
          }
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
  }, [mode, playing, speed]);

  const switchMode = useCallback((newMode: "art" | "final") => {
    setPlaying(false);
    if (newMode === "final") {
      setFrameIndex(finalStartFrame);
      setProgress(0);
      setFinalCumulativeDistance(0);
      setFinalCumulativeTime(0);
    }
    setMode(newMode);
  }, [finalStartFrame]);

  // Final mode animation hook — polyline driven by wall-clock time for smooth progress
  // Helper: find the next frame in data after `current`, optionally skipping one entry for 1fps mode
  const findNextFrame = (current: number, data: FrameActivity[]) => {
    const idx = data.findIndex(d => d.frame >= current);
    if (idx === -1) return null;
    const advance = final1Fps ? 2 : 1;
    const nextIdx = idx + advance;
    return nextIdx < data.length ? data[nextIdx].frame : null;
  };
  useEffect(() => {
    if (mode !== "final" || !playing || !frameData) return;

    const initialNext = findNextFrame(frameIndexRef.current, frameData);
    const stepRef = { current: initialNext != null ? initialNext - frameIndexRef.current : (final1Fps ? 30 : 15) };

    // Use wall-clock time for smooth progress at any speed
    let lastTime = performance.now();
    let pausedProgress = progressRef.current;

    const animate = () => {
      const video = hiddenVideoRef.current;
      if (!video || !isFinite(video.duration)) {
        lastTime = performance.now();
        animationRef.current = requestAnimationFrame(animate);
        return;
      }

      const currentFrame = frameIndexRef.current;
      const polyDuration = stepRef.current / VIDEO_FPS;
      const now = performance.now();
      const delta = (now - lastTime) / 1000;
      lastTime = now;
      pausedProgress += (delta * finalSpeedRef.current) / polyDuration;
      let p = Math.min(pausedProgress, 1);

      if (p >= 1) {
        const activity = frameData.find(d => d.frame === currentFrame);
        if (activity) {
          setFinalCumulativeDistance(d => d + activity.distance_m);
          setFinalCumulativeTime(d => d + activity.time_s);
        }

        const nextFrame = findNextFrame(currentFrame, frameData);

        if (nextFrame != null) {
          stepRef.current = nextFrame - currentFrame;
          frameIndexRef.current = nextFrame;
          progressRef.current = 0;
          setFrameIndex(nextFrame);
          setProgress(0);
          pausedProgress = 0;
          lastTime = performance.now();
        } else {
          progressRef.current = 1;
          setProgress(1);
          setPlaying(false);
          return;
        }
      } else {
        progressRef.current = p;
        setProgress(p);
      }

      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [mode, playing, frameData, final1Fps]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
        if (mode === "art") {
          setProgress((pr) => (pr >= 1 ? 0 : pr));
        } else if (mode === "final") {
          setProgress((pr) => (pr >= 1 ? 0 : pr));
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode]);

  const effectiveSpeed = mode === "final" ? (final1Fps ? 1 : 2) : speed;
  const polylineDuration = 1 / effectiveSpeed;

  useEffect(() => {
    const video = hiddenVideoRef.current;
    const expectedTime = video?.duration && isFinite(video.duration)
      ? Math.max(0, Math.min(video.duration,
          frameToVideoTime(frameIndex, video.duration) - (1 - progress) * polylineDuration))
      : 0;
    setDebug({
      playing,
      progress,
      videoTime: video?.currentTime ?? 0,
      videoDuration: video?.duration ?? 0,
      videoPaused: video?.paused ?? true,
      videoReady: video?.readyState ?? 0,
      expectedTime,
      frameIndex,
    });
  }, [playing, progress]);

  const setupVideo = useCallback((map: maplibregl.Map) => {
    if (map.getSource("badapple-canvas")) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = 240;
    canvas.height = 180;
    map.addSource("badapple-canvas", {
      type: "canvas",
      canvas,
      coordinates: [
        [-122.08197, 37.373400],
        [-122.079526, 37.373400],
        [-122.079526, 37.372149],
        [-122.08197, 37.372149],
      ],
    });
    map.addLayer({
      id: "badapple-video-layer",
      type: "raster",
      source: "badapple-canvas",
      paint: {
        "raster-fade-duration": 0,
        "raster-opacity": opacityRef.current,
      },
    });
    (map.getSource("badapple-canvas") as any)?.play();
    setVideoSourceReady(true);

    const visibility = showStreetNamesRef.current ? "visible" : "none";
    const layers = map.getStyle().layers;
    if (layers) {
      for (const layer of layers) {
        if (layer.type === "symbol" && (layer.id.includes("label") || layer.id.includes("place") || layer.id.includes("road") || layer.id.includes("poi") || layer.id.includes("watername") || layer.id.includes("housenumber"))) {
          map.setLayoutProperty(layer.id, "visibility", visibility);
        }
      }
    }
  }, []);

  const progressRef = useRef(progress);
  progressRef.current = progress;
  const frameIndexRef = useRef(frameIndex);
  frameIndexRef.current = frameIndex;
  const polylineDurationRef = useRef(polylineDuration);
  polylineDurationRef.current = polylineDuration;
  const finalSpeedRef = useRef(finalSpeed);
  finalSpeedRef.current = finalSpeed;
  const finalBlendModeRef = useRef(finalBlendMode);
  finalBlendModeRef.current = finalBlendMode;

  const drawFrame = useCallback(() => {
    const video = hiddenVideoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !isFinite(video.duration)) return;

    const t = Math.max(0, Math.min(video.duration,
      frameToVideoTime(frameIndexRef.current, video.duration) - (1 - progressRef.current) * polylineDurationRef.current));
    video.currentTime = t;

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        applyBlendMode(ctx, canvas.width, canvas.height, finalBlendModeRef.current);
      }
    };

    draw();
    video.addEventListener("seeked", draw, { once: true });
  }, []);

  // Immediate draw on frameIndex change (skip in final mode while playing - video plays naturally)
  useEffect(() => {
    if (mode === "final" && playing) {
      if (finalVideoLowFps) {
        const video = hiddenVideoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas || !isFinite(video.duration)) return;
        video.currentTime = frameToVideoTime(frameIndex, video.duration);
        video.pause();
        const draw = () => {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            applyBlendMode(ctx, canvas.width, canvas.height, finalBlendModeRef.current);
          }
        };
        draw();
        video.addEventListener("seeked", draw, { once: true });
      }
      return;
    }
    drawFrame();
  }, [frameIndex, drawFrame, mode, playing, finalVideoLowFps]);

  // Immediate draw when scrubbing while paused
  useEffect(() => {
    if (playing) return;
    drawFrame();
  }, [progress, playing, drawFrame]);

  // During playback, let the video play naturally and capture frames
  // The video's linear speed matches the polyline's — both cover
  // polylineDuration seconds, so no seeking is needed mid-playback.
  // When progress hasn't reached the point where footage exists, hold on frame 0.
  const prevPlayingRef = useRef(false);

  useEffect(() => {
    const video = hiddenVideoRef.current;
    if (!video) return;
    video.muted = !(mode === "final" && playing && finalPlayMusic);
  }, [mode, playing, finalPlayMusic]);

  useEffect(() => {
    const video = hiddenVideoRef.current;
    if (!video || !isFinite(video.duration)) return;

    if (mode === "final" && finalVideoLowFps) {
      video.pause();
      prevPlayingRef.current = playing;
      return;
    }

    if (playing) {
      if (!prevPlayingRef.current) {
        const calc = frameToVideoTime(frameIndexRef.current, video.duration) - (1 - progressRef.current) * polylineDurationRef.current;
        if (calc < 0) {
          video.currentTime = 0;
          video.pause();
        } else {
          video.playbackRate = mode === "final" ? finalSpeedRef.current : 1;
          video.currentTime = Math.min(calc, video.duration);
          video.play().catch(() => {});
        }
      }
    } else {
      video.pause();
    }
    prevPlayingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    if (!playing) return;
    let raf: number;
    let wasWaiting = false;
    let startedPlaying = false;

    const loop = () => {
      const video = hiddenVideoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || !isFinite(video.duration)) return;

      const desiredTime = frameToVideoTime(frameIndexRef.current, video.duration) - (1 - progressRef.current) * polylineDurationRef.current;

      if (desiredTime < 0) {
        if (!wasWaiting) {
          video.currentTime = 0;
          video.pause();
          wasWaiting = true;
          startedPlaying = false;
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          applyBlendMode(ctx, canvas.width, canvas.height, finalBlendModeRef.current);
        }
      } else if (mode === "final") {
        wasWaiting = false;
        const t = Math.max(0, Math.min(video.duration, desiredTime));
        if (!startedPlaying || Math.abs(video.currentTime - t) > 0.03) {
          video.currentTime = t;
          if (!startedPlaying) {
            video.play().catch(() => {});
            startedPlaying = true;
          }
          const drawExact = () => {
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              applyBlendMode(ctx, canvas.width, canvas.height, finalBlendModeRef.current);
            }
          };
          drawExact();
          video.addEventListener("seeked", drawExact, { once: true });
        } else {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            applyBlendMode(ctx, canvas.width, canvas.height, finalBlendModeRef.current);
          }
        }
      } else {
        wasWaiting = false;
        if (!video.paused) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            applyBlendMode(ctx, canvas.width, canvas.height, finalBlendModeRef.current);
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const effectiveZoom = interpolateKfs(zoomKfs, progress) ?? zoom;
  const effectivePitch = interpolateKfs(pitchKfs, progress) ?? pitch;
  const effectiveFollow = interpolateKfs(followStrengthKfs, progress) ?? followStrength;
  const effectiveBearing = interpolateKfs(bearingStrengthKfs, progress) ?? bearingStrength;
  const effectiveOpacity = mode === "final"
    ? (finalShowVideo ? videoOpacity : 0)
    : (interpolateKfs(videoOpacityKfs, progress) ?? videoOpacity);
  opacityRef.current = effectiveOpacity;

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const opacity = effectiveOpacity;
    if (map.getLayer("badapple-video-layer")) {
      map.setPaintProperty("badapple-video-layer", "raster-opacity", opacity);
    }
  }, [effectiveOpacity, videoSourceReady]);

  const followFactor = followCamera
    ? effectiveFollow / 100
    : 0;

  const viewState = mode === "final"
    ? {
        longitude: DEFAULT_VIEW_COORDINATES[0],
        latitude: DEFAULT_VIEW_COORDINATES[1],
        zoom: finalZoom,
        pitch: 0,
        bearing: 0,
      }
    : {
    longitude: lerp(
      DEFAULT_VIEW_COORDINATES[0],
      currentPosition[0],
      followFactor
    ),

    latitude: lerp(
      DEFAULT_VIEW_COORDINATES[1],
      currentPosition[1],
      followFactor
    ),

    zoom: effectiveZoom + 1,

    pitch: effectivePitch,

    bearing: rotateCamera
      ? currentBearing * (effectiveBearing / 100)
      : 0,
  };

  const layers = [
    mode === "final" && finalShowSilhouette &&
    new PathLayer({
      id: "silhouette",
      data: [{ path }],
      getPath: (d: any) => d.path,
      getColor: [255, 140, 0, Math.round(finalSilhouetteOpacity * 255)],
      widthUnits: "pixels",
      getWidth: 4,
      capRounded: true,
      jointRounded: true,
    }),

    trailMode !== "none" &&
    new PathLayer({
      id: "path",

      data: [{ path: displayedPath }],

      getPath: (d: any) => d.path,

      getColor: [255, 140, 0],

      widthUnits: "pixels",

      getWidth: 6,

      capRounded: true,
      jointRounded: true,
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

  return (
    <div className="fixed inset-0 bg-black text-white flex overflow-hidden">
      <div className="w-[380px] shrink-0 bg-zinc-900 p-4 overflow-y-auto border-r border-zinc-800 z-10">
        <h1 className="text-2xl font-bold mb-4">
          deck.gl Polyline Animator
        </h1>

        <div className="flex gap-1 mb-4">
          <button
            onClick={() => switchMode("art")}
            className={`flex-1 px-3 py-2 rounded-lg transition ${
              mode === "art"
                ? "bg-orange-500 text-white"
                : "bg-zinc-700 hover:bg-zinc-600 text-zinc-300"
            }`}
          >
            Art Mode
          </button>
          <button
            onClick={() => switchMode("final")}
            className={`flex-1 px-3 py-2 rounded-lg transition ${
              mode === "final"
                ? "bg-orange-500 text-white"
                : "bg-zinc-700 hover:bg-zinc-600 text-zinc-300"
            }`}
          >
            Final Mode
          </button>
        </div>

        {mode === "art" && (
          <>
        <div className="mb-5">
          <label className="block mb-2">
            Frame: {frameIndex}
          </label>
          <input
            type="range"
            min={0}
            max={frameData ? frameData.length - 1 : 0}
            step={1}
            value={frameData ? Math.max(0, frameData.findIndex(d => d.frame >= frameIndex)) : 0}
            onChange={(e) => {
              const f = frameData?.[Number(e.target.value)]?.frame;
              if (f != null) setFrameIndex(f);
            }}
            className="w-full"
          />
        </div>

        <div className="mt-6">
          <label className="block mb-2">
            Timeline: {(progress * polylineDuration).toFixed(1)}s / {polylineDuration.toFixed(1)}s
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

        <KeyframeSlider
          label="Zoom"
          value={zoom}
          onChange={setZoom}
          min={3}
          max={20}
          step={0.1}
          formatValue={(v) => v.toFixed(1)}
          progress={progress}
          onProgressChange={setProgress}
          onKeyframeValueChange={setZoomKf}
          keyframes={zoomKfs}
          onKeyframesChange={setZoomKfs}
        />

        <KeyframeSlider
          label="Pitch"
          value={pitch}
          onChange={setPitch}
          min={0}
          max={65}
          step={1}
          formatValue={(v) => `${v.toFixed(0)}°`}
          progress={progress}
          onProgressChange={setProgress}
          onKeyframeValueChange={setPitchKf}
          keyframes={pitchKfs}
          onKeyframesChange={setPitchKfs}
        />

        <KeyframeSlider
          label="Follow Strength"
          value={followStrength}
          onChange={setFollowStrength}
          min={0}
          max={100}
          step={1}
          formatValue={(v) => `${v.toFixed(0)}%`}
          progress={progress}
          onProgressChange={setProgress}
          onKeyframeValueChange={setFollowStrengthKf}
          keyframes={followStrengthKfs}
          onKeyframesChange={setFollowStrengthKfs}
        />

        <KeyframeSlider
          label="Bearing Strength"
          value={bearingStrength}
          onChange={setBearingStrength}
          min={0}
          max={100}
          step={1}
          formatValue={(v) => `${v.toFixed(0)}%`}
          progress={progress}
          onProgressChange={setProgress}
          onKeyframeValueChange={setBearingStrengthKf}
          keyframes={bearingStrengthKfs}
          onKeyframesChange={setBearingStrengthKfs}
        />

        <KeyframeSlider
          label="Video Opacity"
          value={videoOpacity}
          onChange={setVideoOpacity}
          min={0}
          max={1}
          step={0.01}
          formatValue={(v) => v.toFixed(2)}
          progress={progress}
          onProgressChange={setProgress}
          onKeyframeValueChange={setVideoOpacityKf}
          keyframes={videoOpacityKfs}
          onKeyframesChange={setVideoOpacityKfs}
        />

        <div className="space-y-2">
          <label className="block text-sm text-zinc-300">
            Video Blend Mode
          </label>
          <select
            value={finalBlendMode}
            onChange={(e) => setFinalBlendMode(e.target.value)}
            className="w-full bg-zinc-800 rounded-lg p-3"
          >
            <option value="normal">Normal</option>
            <option value="screen">Screen (white → transparent)</option>
            <option value="overlay">Overlay (black → transparent)</option>
          </select>
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

          <div className="space-y-2">
            <label className="block text-sm text-zinc-300">
              Map Theme
            </label>
            <select
              value={mapTheme}
              onChange={(e) => setMapTheme(e.target.value)}
              className="w-full bg-zinc-800 rounded-lg p-3"
            >
              {MAP_THEMES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showStats}
              onChange={(e) => setShowStats(e.target.checked)}
            />
            Show Stats
          </label>
        </div>
          </>
        )}

        {mode === "final" && (
          <div className="space-y-4">
            <div className="mb-5">
              <label className="block mb-2">
                Start Frame: {finalStartFrame}
              </label>
              <input
                type="range"
                min={0}
                max={frameData ? frameData.length - 1 : 0}
                step={1}
                value={frameData ? Math.max(0, frameData.findIndex(d => d.frame >= finalStartFrame)) : 0}
                onChange={(e) => {
                  const f = frameData?.[Number(e.target.value)]?.frame;
                  if (f == null) return;
                  setFinalStartFrame(f);
                  if (!playing) {
                    setFrameIndex(f);
                    setProgress(0);
                    setFinalCumulativeDistance(0);
                    setFinalCumulativeTime(0);
                  }
                }}
                className="w-full"
              />
            </div>

            <div className="mb-5">
              <label className="block mb-2">
                Speed: {finalSpeed.toFixed(2)}x
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={finalSpeed}
                onChange={(e) => setFinalSpeed(Number(e.target.value))}
                className="w-full"
              />
            </div>

            <div className="mb-5">
              <label className="block mb-2">
                Current Frame: {frameIndex}
              </label>
              <div className="w-full bg-zinc-800 rounded-full h-2 mb-1">
                <div
                  className="bg-orange-500 h-2 rounded-full transition-all duration-75"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
              <div className="text-xs text-zinc-500">{(progress * 100).toFixed(0)}%</div>
            </div>

            <div className="flex gap-2 mb-4 flex-wrap">
              <button
                onClick={() => {
                  if (progress >= 1 && frameData) {
                    const nextFrame = findNextFrame(frameIndex, frameData);
                    if (nextFrame != null) {
                      setFrameIndex(nextFrame);
                      setProgress(0);
                    }
                  }
                  setPlaying(true);
                }}
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
                  setFrameIndex(finalStartFrame);
                  setProgress(0);
                  setFinalCumulativeDistance(0);
                  setFinalCumulativeTime(0);
                }}
                className="bg-zinc-700 hover:bg-zinc-600 transition px-3 py-2 rounded-lg"
              >
                Reset
              </button>
            </div>

            <div className="space-y-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={finalShowVideo}
                  onChange={(e) => setFinalShowVideo(e.target.checked)}
                />
                Show Background Video
              </label>

              <div className="space-y-2">
                <label className="block text-sm text-zinc-300">
                  Video Blend Mode
                </label>
                <select
                  value={finalBlendMode}
                  onChange={(e) => setFinalBlendMode(e.target.value)}
                  className="w-full bg-zinc-800 rounded-lg p-3"
                >
                  <option value="normal">Normal</option>
                  <option value="screen">Screen (white → transparent)</option>
                  <option value="overlay">Overlay (black → transparent)</option>
                </select>
              </div>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={finalVideoLowFps}
                  onChange={(e) => setFinalVideoLowFps(e.target.checked)}
                />
                2 FPS Background Video
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={final1Fps}
                  onChange={(e) => setFinal1Fps(e.target.checked)}
                />
                1 FPS Mode (every 30 frames)
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={finalPlayMusic}
                  onChange={(e) => setFinalPlayMusic(e.target.checked)}
                />
                Play Music
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={finalShowSilhouette}
                  onChange={(e) => setFinalShowSilhouette(e.target.checked)}
                />
                Show Finished Silhouette
              </label>

              {finalShowSilhouette && (
                <div className="mb-4 ml-6">
                  <label className="block mb-2 text-sm text-zinc-400">
                    Silhouette Opacity: {(finalSilhouetteOpacity * 100).toFixed(0)}%
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={finalSilhouetteOpacity}
                    onChange={(e) => setFinalSilhouetteOpacity(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
              )}

              <div className="mb-4">
                <label className="block mb-2 text-sm text-zinc-400">
                  Zoom: {finalZoom.toFixed(1)}
                </label>
                <input
                  type="range"
                  min={3}
                  max={20}
                  step={0.1}
                  value={finalZoom}
                  onChange={(e) => setFinalZoom(Number(e.target.value))}
                  className="w-full"
                />
              </div>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={finalShowDebug}
                  onChange={(e) => setFinalShowDebug(e.target.checked)}
                />
                Show Debug Info
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showStats}
                  onChange={(e) => setShowStats(e.target.checked)}
                />
                Show Stats
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showStreetNames}
                  onChange={(e) => setShowStreetNames(e.target.checked)}
                />
                Show Map Labels
              </label>
            </div>
          </div>
        )}

       </div>

      <video
        ref={hiddenVideoRef}
        src="/badapple-small.mp4"
        muted
        loop
        playsInline
        preload="auto"
        crossOrigin="anonymous"
        className="hidden"
      />
      <canvas ref={canvasRef} className="hidden" />

      <div ref={mapContainerRef} className="flex-1 relative">
        {(SHOW_DEBUG || (mode === "final" && finalShowDebug)) && (
        <div className="absolute top-2 left-2 z-30 bg-black/70 text-[11px] font-mono text-green-400 p-2 rounded pointer-events-none">
          <div>playing: {String(debug.playing)}</div>
          <div>progress: {debug.progress.toFixed(4)}</div>
          <div>frameIndex: {debug.frameIndex}</div>
          <div>vid.time: {debug.videoTime.toFixed(2)}s</div>
          <div>vid.frame: {debug.videoDuration ? Math.round(debug.videoTime * VIDEO_FPS) : 0}</div>
          <div>frame→time: {debug.videoDuration ? frameToVideoTime(frameIndex, debug.videoDuration).toFixed(2) : 0}s</div>
          <div>vid.expect: {debug.expectedTime.toFixed(2)}s</div>
          <div>vid.drift: {(debug.videoTime - debug.expectedTime).toFixed(3)}s</div>
          <div>vid.dur: {debug.videoDuration.toFixed(2)}s</div>
          <div>vid.paused: {String(debug.videoPaused)}</div>
          <div>vid.ready: {debug.videoReady}</div>
          <div>speed: {effectiveSpeed.toFixed(1)}</div>
          <div>polyDur: {polylineDuration.toFixed(2)}s</div>
        </div>
        )}
        {mode === "art" && showStats && currentActivity && (
        <div className="absolute bottom-48 left-1/2 -translate-x-1/2 z-30 flex gap-4 pointer-events-none">
          <StatPill label="Distance" current={progress * currentActivity.distance_m} max={currentActivity.distance_m} unit="m" />
          <StatPill label="Time" current={progress * currentActivity.time_s} max={currentActivity.time_s} unit="min" />
        </div>
        )}
        {mode === "final" && showStats && currentActivity && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-30 flex gap-4 pointer-events-none">
          <StatPill label="Distance" current={finalCumulativeDistance + progress * currentActivity.distance_m} max={999999} unit="km" />
          <StatPill label="Time" current={finalCumulativeTime + progress * currentActivity.time_s} max={999999} unit="hms" />
        </div>
        )}
        <DeckGL
          controller={true}
          layers={layers}
          viewState={viewState}
        >
          <Map
            key={mapThemeUrl}
            ref={mapRef}
            mapStyle={mapThemeUrl}
            onLoad={(e: any) => setupVideo(e.target)}
            attributionControl={false}
          />
        </DeckGL>
        </div>
      </div>
  );
}