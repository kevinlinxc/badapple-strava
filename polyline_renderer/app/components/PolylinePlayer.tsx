"use client";

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import DeckGL from "@deck.gl/react";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { Map } from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";
import polyline from "@mapbox/polyline";
import KeyframeSlider from "./KeyframeSlider";
import {
  applyBlendMode,
  BLEND_OPTIONS,
  type Coord,
  type FrameActivity,
  MAP_THEMES,
  regionForPath,
  usePersistedState,
  VIDEO_FPS,
  VIDEO_TOTAL_FRAMES,
} from "../lib/shared";
import FinalMode from "./FinalMode";
import DroneMode from "./DroneMode";
import { IconButton, ProgressRow, Section, SegRow, SelectRow, SliderRow, TextButton, ToggleRow } from "./controls";

export type Keyframe = { time: number; value: number };


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
  // Files without this are from when the map was given zoom + 1, so their zoom is shifted up on load
  zoomOffsetRemoved?: boolean;
};

export const defaultPlayerSettings: PolylinePlayerSettings = {
  "frameIndex": 1815,
  "progress": 1,
  "speed": 0.04,
  "followCamera": true,
  "rotateCamera": true,
  "zoomOffsetRemoved": true,
  "zoom": 17.4,
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
      "value": 20.496199819454667
    },
    {
      "time": 0.9609929078014183,
      "value": 16.90121738236726
    },
    {
      "time": 0.521952043228639,
      "value": 20.108661825533698
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


function frameToVideoTime(frame: number, videoDuration: number, frameOffset: number = 0): number {
  const t = (frame + frameOffset + 0.5) / VIDEO_FPS;
  return Math.max(0, Math.min(t, videoDuration));
}
function toReversedFrame(frame: number): number {
  return VIDEO_TOTAL_FRAMES - 1 - frame;
}

function findActivityForFrame(frameData: FrameActivity[] | null, frameIndex: number): FrameActivity | null {
  if (!frameData || frameData.length === 0) return null;
  let best: FrameActivity | null = null;
  let smallest = frameData[0];
  for (const f of frameData) {
    if (f.frame < smallest.frame) smallest = f;
    if (f.frame <= frameIndex && (best === null || f.frame > best.frame)) best = f;
  }
  return best ?? smallest;
}

type Activity = {
  frame: number;
  distance_m: number;
  time_s: number;
  polyline: string;
};

// Art mode used to hand the map zoom + 1 while showing zoom, so it didn't match continuous.
// Shift what's saved in this browser up by one, once, so the art camera looks the same as before.
function migrateArtZoom() {
  const flag = "polyline-player-zoomOffsetRemoved";
  try {
    if (localStorage.getItem(flag)) return;
    const zoom = localStorage.getItem("polyline-player-zoom");
    if (zoom !== null) localStorage.setItem("polyline-player-zoom", JSON.stringify(JSON.parse(zoom) + 1));
    const kfs = localStorage.getItem("polyline-player-zoomKfs");
    if (kfs !== null) {
      const shifted = (JSON.parse(kfs) as Keyframe[]).map((k) => ({ ...k, value: k.value + 1 }));
      localStorage.setItem("polyline-player-zoomKfs", JSON.stringify(shifted));
    }
    localStorage.setItem(flag, "1");
  } catch {}
}
if (typeof window !== "undefined") migrateArtZoom();

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
  const [videoFrameOffset, setVideoFrameOffset] = usePersistedState("videoFrameNudge", 0);

  const [mode, setMode] = usePersistedState<"art" | "continuous" | "final" | "drone">("mode", "art");
  const [finalSidebar, setFinalSidebar] = useState<HTMLDivElement | null>(null);
  // Art and continuous share frameIndex/progress, so art's position is set aside while in continuous
  const [artPosition, setArtPosition] = usePersistedState<{ frameIndex: number; progress: number } | null>("artPosition", null);
  const [continuousStartFrame, setContinuousStartFrame] = usePersistedState("finalStartFrame", 0);
  const [continuousShowVideo, setContinuousShowVideo] = usePersistedState("finalShowVideo", true);
  const [continuousZoom, setContinuousZoom] = usePersistedState("finalZoom", 16);
  const [continuousShowSilhouette, setContinuousShowSilhouette] = usePersistedState("finalShowSilhouette", true);
  const [continuousSilhouetteOpacity, setContinuousSilhouetteOpacity] = usePersistedState("finalSilhouetteOpacity", 0.5);
  const [continuousPlayMusic, setContinuousPlayMusic] = usePersistedState("finalPlayMusic", false);
  const [continuousVideoLowFps, setContinuousVideoLowFps] = usePersistedState("finalVideoLowFps", false);
  const [continuousShowDebug, setContinuousShowDebug] = usePersistedState("finalShowDebug", false);
  const [continuousSpeed, setContinuousSpeed] = usePersistedState("finalSpeed", 1.0);
  const [blendMode, setBlendMode] = usePersistedState("finalBlendMode", "normal");
  const [continuousReverse, setContinuousReverse] = usePersistedState("finalReverse", false);

  useEffect(() => {
    fetch("/bad_apple_activities.json")
      .then((r) => r.json())
      .then((data: FrameActivity[]) => setFrameData([...data].sort((a, b) => a.frame - b.frame)))
      .catch(() => {});
  }, []);

  const currentActivity = useMemo(() => {
    return findActivityForFrame(frameData, frameIndex);
  }, [frameData, frameIndex]);

  // Totals of the activities already finished since the start frame. Derived from the position
  // rather than accumulated during playback, so they survive a reload.
  const [continuousCumulativeDistance, continuousCumulativeTime] = useMemo(() => {
    let distance = 0;
    let time = 0;
    for (const d of frameData ?? []) {
      const done = continuousReverse
        ? d.frame <= continuousStartFrame && d.frame > frameIndex
        : d.frame >= continuousStartFrame && d.frame < frameIndex;
      if (done) {
        distance += d.distance_m;
        time += d.time_s;
      }
    }
    return [distance, time];
  }, [frameData, frameIndex, continuousStartFrame, continuousReverse]);

  const polylineText = currentActivity?.polyline ?? "";

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

  const currentRegion = useMemo(() => regionForPath(path), [path]);
  const currentRegionRef = useRef(currentRegion);
  currentRegionRef.current = currentRegion;

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
      if (layer.type === "symbol" && (layer.id.includes("label") || layer.id.includes("place") || layer.id.includes("road") || layer.id.includes("poi") || layer.id.includes("watername") || layer.id.includes("housenumber") || layer.id.includes("transit"))) {
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
    const zoomShift = settings.zoomOffsetRemoved ? 0 : 1;
    setZoom(settings.zoom + zoomShift);
    setPitch(settings.pitch);
    setFollowStrength(settings.followStrength);
    setBearingStrength(settings.bearingStrength);
    setTrailMode(settings.trailMode);
    setDotSize(settings.dotSize);
    setDotGlowRadius(settings.dotGlowRadius);
    setShowDot(settings.showDot);
    setShowStreetNames(settings.showStreetNames);
    setVideoOpacity(settings.videoOpacity ?? 1);
    setZoomKfs((settings.zoomKeyframes ?? []).map((k) => ({ ...k, value: k.value + zoomShift })));
    setPitchKfs(settings.pitchKeyframes ?? []);
    setFollowStrengthKfs(settings.followStrengthKeyframes ?? []);
    setBearingStrengthKfs(settings.bearingStrengthKeyframes ?? []);
    setVideoOpacityKfs(settings.videoOpacityKeyframes ?? []);
    if (settings.mapTheme) setMapTheme(settings.mapTheme);
    if (settings.finalBlendMode) setBlendMode(settings.finalBlendMode);
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
      finalBlendMode: blendMode,
      zoomOffsetRemoved: true,
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

  const switchMode = useCallback((newMode: "art" | "continuous" | "final" | "drone") => {
    setPlaying(false);
    if (newMode === mode) return;
    if (mode === "art") setArtPosition({ frameIndex, progress });
    if (newMode === "continuous") {
      setFrameIndex(continuousStartFrame);
      setProgress(0);
    } else if (newMode === "art" && artPosition) {
      setFrameIndex(artPosition.frameIndex);
      setProgress(artPosition.progress);
    }
    setMode(newMode);
  }, [mode, frameIndex, progress, artPosition, continuousStartFrame]);

  // Continuous mode animation hook — polyline driven by wall-clock time for smooth progress
  // Helper: find the next (or previous) frame in data, optionally skipping one entry for 1fps mode
  const findNextFrame = (current: number, data: FrameActivity[], reverse: boolean) => {
    const idx = data.findIndex(d => d.frame >= current);
    if (idx === -1) return null;
    if (reverse) {
      const prevIdx = idx - 1;
      return prevIdx >= 0 ? data[prevIdx].frame : null;
    }
    const nextIdx = idx + 1;
    return nextIdx < data.length ? data[nextIdx].frame : null;
  };
  useEffect(() => {
    if (mode !== "continuous" || !playing || !frameData) return;

    const initialNext = findNextFrame(frameIndexRef.current, frameData, continuousReverse);
    const stepRef = { current: initialNext != null ? Math.abs(initialNext - frameIndexRef.current) : 15 };
    actualPolyDurationRef.current = stepRef.current / VIDEO_FPS;

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
      pausedProgress += (delta * continuousSpeedRef.current) / polyDuration;
      let p = Math.min(pausedProgress, 1);

      if (p >= 1) {
        const nextFrame = findNextFrame(currentFrame, frameData, continuousReverse);

        if (nextFrame != null) {
          stepRef.current = continuousReverse ? currentFrame - nextFrame : nextFrame - currentFrame;
          actualPolyDurationRef.current = stepRef.current / VIDEO_FPS;
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
  }, [mode, playing, frameData, continuousReverse]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (mode === "final" || mode === "drone") return;
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
        if (mode === "art") {
          setProgress((pr) => (pr >= 1 ? 0 : pr));
        } else if (mode === "continuous") {
          setProgress((pr) => (pr >= 1 ? 0 : pr));
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode]);

  const effectiveSpeed = mode === "continuous" ? 2 : speed;
  const polylineDuration = 1 / effectiveSpeed;

  useEffect(() => {
    const video = hiddenVideoRef.current;
    const expectedTime = video?.duration && isFinite(video.duration)
      ? Math.max(0, Math.min(video.duration,
          frameToVideoTime(frameIndex, video.duration, videoFrameOffset) - (1 - progress) * polylineDuration))
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
      coordinates: currentRegionRef.current.overlay,
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
        if (layer.type === "symbol" && (layer.id.includes("label") || layer.id.includes("place") || layer.id.includes("road") || layer.id.includes("poi") || layer.id.includes("watername") || layer.id.includes("housenumber") || layer.id.includes("transit"))) {
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
  const continuousSpeedRef = useRef(continuousSpeed);
  continuousSpeedRef.current = continuousSpeed;
  const blendModeRef = useRef(blendMode);
  blendModeRef.current = blendMode;
  const continuousReverseRef = useRef(continuousReverse);
  continuousReverseRef.current = continuousReverse;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const videoFrameOffsetRef = useRef(videoFrameOffset);
  videoFrameOffsetRef.current = videoFrameOffset;

  // Tracks the actual polyline duration from the data's frame gap (not the global speed setting)
  const actualPolyDurationRef = useRef(0.5);

  const drawFrame = useCallback(() => {
    const video = hiddenVideoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !isFinite(video.duration)) return;

    const lookupFrame = (continuousReverseRef.current && modeRef.current === "continuous") ? toReversedFrame(frameIndexRef.current) : frameIndexRef.current;
    const polyDur = modeRef.current === "continuous" ? actualPolyDurationRef.current : polylineDurationRef.current;
    const t = Math.max(0, Math.min(video.duration,
      frameToVideoTime(lookupFrame, video.duration, videoFrameOffsetRef.current) - (1 - progressRef.current) * polyDur));
    video.currentTime = t;

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        applyBlendMode(ctx, canvas.width, canvas.height, blendModeRef.current);
      }
    };

    draw();
    video.addEventListener("seeked", draw, { once: true });
  }, []);

  // Immediate draw on frameIndex change (skip in continuous mode while playing - video plays naturally)
  useEffect(() => {
    if (mode === "continuous" && playing) {
      if (continuousVideoLowFps) {
        const video = hiddenVideoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas || !isFinite(video.duration)) return;
        video.currentTime = frameToVideoTime(frameIndex, video.duration, videoFrameOffsetRef.current);
        video.pause();
        const draw = () => {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            applyBlendMode(ctx, canvas.width, canvas.height, blendModeRef.current);
          }
        };
        draw();
        video.addEventListener("seeked", draw, { once: true });
      }
      return;
    }
    drawFrame();
  }, [frameIndex, drawFrame, mode, playing, continuousVideoLowFps]);

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
  const seekingRef = useRef(false);

  useEffect(() => {
    const video = hiddenVideoRef.current;
    if (!video) return;
    video.muted = !(mode === "continuous" && playing && continuousPlayMusic);
  }, [mode, playing, continuousPlayMusic]);

  useEffect(() => {
    const video = hiddenVideoRef.current;
    if (!video || !isFinite(video.duration)) return;

    if (mode === "continuous" && continuousVideoLowFps) {
      video.pause();
      prevPlayingRef.current = playing;
      return;
    }

    if (playing) {
      if (!prevPlayingRef.current) {
        const polyDur = mode === "continuous" ? actualPolyDurationRef.current : polylineDurationRef.current;
        const calc = frameToVideoTime(frameIndexRef.current, video.duration, videoFrameOffsetRef.current) - (1 - progressRef.current) * polyDur;
        if (calc < 0) {
          video.currentTime = 0;
          video.pause();
        } else {
          video.playbackRate = mode === "continuous" ? continuousSpeedRef.current : 1;
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
    let prevFrame = frameIndexRef.current;

    const loop = () => {
      const video = hiddenVideoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || !isFinite(video.duration)) return;

      const currentFrame = frameIndexRef.current;
      const lookupFrame = (continuousReverseRef.current && modeRef.current === "continuous") ? toReversedFrame(currentFrame) : currentFrame;
      const polyDur = modeRef.current === "continuous" ? actualPolyDurationRef.current : polylineDurationRef.current;
      const desiredTime = frameToVideoTime(lookupFrame, video.duration, videoFrameOffsetRef.current) - (1 - progressRef.current) * polyDur;

      if (desiredTime < 0) {
        if (!wasWaiting) {
          video.currentTime = 0;
          video.pause();
          wasWaiting = true;
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          applyBlendMode(ctx, canvas.width, canvas.height, blendModeRef.current);
        }
      } else {
        if (wasWaiting || currentFrame !== prevFrame) {
          seekingRef.current = true;
          video.currentTime = Math.min(desiredTime, video.duration);
          video.addEventListener("seeked", () => {
            seekingRef.current = false;
          }, { once: true });
          video.playbackRate = mode === "continuous" ? continuousSpeedRef.current : 1;
          video.play().catch(() => {});
          wasWaiting = false;
          prevFrame = currentFrame;
        }
        if (!video.paused && !seekingRef.current) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            applyBlendMode(ctx, canvas.width, canvas.height, blendModeRef.current);
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
  const effectiveOpacity = mode === "continuous"
    ? (continuousShowVideo ? videoOpacity : 0)
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

  useEffect(() => {
    const map = mapRef.current?.getMap();
    const source = map?.getSource("badapple-canvas") as any;
    if (source?.setCoordinates) {
      source.setCoordinates(currentRegion.overlay);
    }
  }, [currentRegion, videoSourceReady]);

  const followFactor = followCamera
    ? effectiveFollow / 100
    : 0;

  const viewState = mode === "continuous"
    ? {
        longitude: currentRegion.center[0],
        latitude: currentRegion.center[1],
        zoom: continuousZoom,
        pitch: 0,
        bearing: 0,
      }
    : {
    longitude: lerp(
      currentRegion.center[0],
      currentPosition[0],
      followFactor
    ),

    latitude: lerp(
      currentRegion.center[1],
      currentPosition[1],
      followFactor
    ),

    zoom: effectiveZoom,

    pitch: effectivePitch,

    bearing: rotateCamera
      ? currentBearing * (effectiveBearing / 100)
      : 0,
  };

  const layers = [
    mode === "continuous" && continuousShowSilhouette &&
    new PathLayer({
      id: "silhouette",
      data: [{ path }],
      getPath: (d: any) => d.path,
      getColor: [255, 140, 0, Math.round(continuousSilhouetteOpacity * 255)],
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
      <div className="w-[320px] shrink-0 bg-s-bg text-s-text text-xs font-sans overflow-y-auto overflow-x-hidden [scrollbar-width:thin] [scrollbar-color:var(--color-s-track)_transparent] border-r border-s-line z-10">
        <div className="flex gap-0.5 px-3 py-2.5 border-b border-s-line">
          {(["art", "continuous", "final", "drone"] as const).map((m) => (
            <button
              key={m}
              onClick={() => switchMode(m)}
              aria-pressed={mode === m}
              className={`flex-1 py-[5px] rounded capitalize transition-colors ${
                mode === m
                  ? "bg-s-track text-s-text"
                  : "text-s-dim hover:text-s-text"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {mode === "art" && (
          <>
            <Section>
              <SliderRow
                label="Frame"
                arrows
                display={String(frameIndex)}
                min={0}
                max={frameData ? frameData.length - 1 : 0}
                step={1}
                value={frameData ? Math.max(0, frameData.findIndex(d => d.frame >= frameIndex)) : 0}
                onChange={(v) => {
                  const f = frameData?.[v]?.frame;
                  if (f != null) setFrameIndex(f);
                }}
              />
              <SliderRow
                label="Timeline"
                display={`${(progress * polylineDuration).toFixed(1)}s`}
                min={0}
                max={1}
                step={0.001}
                value={progress}
                onChange={setProgress}
              />
              <div className="flex gap-1.5 py-1">
                <IconButton
                  icon={playing ? "pause" : "play"}
                  label={playing ? "Pause" : "Play"}
                  primary
                  onClick={() => setPlaying(!playing)}
                />
                <IconButton
                  icon="start"
                  label="Restart"
                  onClick={() => {
                    setPlaying(false);
                    setProgress(0);
                  }}
                />
                <IconButton
                  icon="end"
                  label="End"
                  onClick={() => {
                    setPlaying(false);
                    setProgress(1);
                  }}
                />
              </div>
              <SliderRow
                label="Speed"
                display={speed.toFixed(2)}
                min={0.02}
                max={1}
                step={0.01}
                value={speed}
                onChange={setSpeed}
              />
            </Section>

            <Section title="Camera">
              <KeyframeSlider
                label="Zoom"
                value={zoom}
                onChange={setZoom}
                min={3}
                max={22}
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
                label="Follow"
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
                label="Bearing"
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
              <ToggleRow label="Follow camera" checked={followCamera} onChange={setFollowCamera} />
              <ToggleRow label="Rotate camera" checked={rotateCamera} onChange={setRotateCamera} />
            </Section>

            <Section title="Trail">
              <SegRow
                label="Trail"
                value={trailMode}
                onChange={setTrailMode}
                options={[
                  { value: "full", label: "Full" },
                  { value: "progress", label: "Progress" },
                  { value: "none", label: "None" },
                ]}
              />
              <ToggleRow label="Dot" checked={showDot} onChange={setShowDot} />
              <SliderRow
                label="Dot size"
                display={dotSize.toFixed(0)}
                min={1}
                max={60}
                step={1}
                value={dotSize}
                onChange={setDotSize}
              />
              <SliderRow
                label="Glow"
                display={dotGlowRadius.toFixed(0)}
                min={0}
                max={120}
                step={1}
                value={dotGlowRadius}
                onChange={setDotGlowRadius}
              />
            </Section>

            <Section title="Video">
              <SegRow
                label="Blend"
                value={blendMode}
                onChange={setBlendMode}
                options={BLEND_OPTIONS}
              />
              <SliderRow
                label="Offset"
                display={videoFrameOffset > 0 ? `+${videoFrameOffset}` : String(videoFrameOffset)}
                min={-5}
                max={5}
                step={1}
                value={videoFrameOffset}
                onChange={setVideoFrameOffset}
              />
            </Section>

            <Section title="Map">
              <SelectRow
                label="Theme"
                value={mapTheme}
                onChange={setMapTheme}
                options={MAP_THEMES.map((t) => ({ value: t.id, label: t.label }))}
              />
              <ToggleRow label="Labels" checked={showStreetNames} onChange={setShowStreetNames} />
              <ToggleRow label="Stats" checked={showStats} onChange={setShowStats} />
            </Section>

            <Section title="Settings">
              <div className="flex gap-4 min-h-[26px] items-center">
                <TextButton onClick={exportSettings}>Export</TextButton>
                <TextButton onClick={() => fileInputRef.current?.click()}>Import</TextButton>
                <TextButton onClick={resetDefaults}>Reset</TextButton>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json"
                  className="hidden"
                  onChange={onFileInputChange}
                />
              </div>
              {settingsError ? (
                <div className="mt-1 text-[11px] text-red-400">{settingsError}</div>
              ) : null}
            </Section>
          </>
        )}

        {mode === "continuous" && (
          <>
            <Section>
              <SliderRow
                label="Start frame"
                arrows
                display={String(continuousStartFrame)}
                min={0}
                max={frameData ? frameData.length - 1 : 0}
                step={1}
                value={frameData ? Math.max(0, frameData.findIndex(d => d.frame >= continuousStartFrame)) : 0}
                onChange={(v) => {
                  const f = frameData?.[v]?.frame;
                  if (f == null) return;
                  setContinuousStartFrame(f);
                  if (!playing) {
                    setFrameIndex(f);
                    setProgress(0);
                  }
                }}
              />
              <ProgressRow label="Frame" display={String(frameIndex)} fraction={progress} />
              <div className="flex gap-1.5 py-1">
                <IconButton
                  icon={playing ? "pause" : "play"}
                  label={playing ? "Pause" : "Play"}
                  primary
                  onClick={() => {
                    if (playing) {
                      setPlaying(false);
                      return;
                    }
                    if (progress >= 1 && frameData) {
                      const nextFrame = findNextFrame(frameIndex, frameData, continuousReverse);
                      if (nextFrame != null) {
                        setFrameIndex(nextFrame);
                        setProgress(0);
                      }
                    }
                    setPlaying(true);
                  }}
                />
                <IconButton
                  icon="start"
                  label="Reset"
                  onClick={() => {
                    setPlaying(false);
                    setFrameIndex(continuousStartFrame);
                    setProgress(0);
                  }}
                />
              </div>
              <SliderRow
                label="Speed"
                display={`${continuousSpeed.toFixed(2)}×`}
                min={0}
                max={1}
                step={0.01}
                value={continuousSpeed}
                onChange={setContinuousSpeed}
              />
              <ToggleRow label="Reverse" checked={continuousReverse} onChange={setContinuousReverse} />
              <ToggleRow label="Music" checked={continuousPlayMusic} onChange={setContinuousPlayMusic} />
            </Section>

            <Section title="Video">
              <ToggleRow label="Video" checked={continuousShowVideo} onChange={setContinuousShowVideo} />
              <SliderRow
                label="Opacity"
                display={videoOpacity.toFixed(2)}
                min={0}
                max={1}
                step={0.01}
                value={videoOpacity}
                onChange={setVideoOpacity}
              />
              <SegRow
                label="Blend"
                value={blendMode}
                onChange={setBlendMode}
                options={BLEND_OPTIONS}
              />
              <ToggleRow label="2 fps" checked={continuousVideoLowFps} onChange={setContinuousVideoLowFps} />
            </Section>

            <Section title="Map">
              <SelectRow
                label="Theme"
                value={mapTheme}
                onChange={setMapTheme}
                options={MAP_THEMES.map((t) => ({ value: t.id, label: t.label }))}
              />
              <SliderRow
                label="Zoom"
                display={continuousZoom.toFixed(1)}
                min={3}
                max={22}
                step={0.1}
                value={continuousZoom}
                onChange={setContinuousZoom}
              />
              <ToggleRow label="Labels" checked={showStreetNames} onChange={setShowStreetNames} />
              <ToggleRow label="Silhouette" checked={continuousShowSilhouette} onChange={setContinuousShowSilhouette} />
              {continuousShowSilhouette && (
                <SliderRow
                  label="Opacity"
                  display={`${(continuousSilhouetteOpacity * 100).toFixed(0)}%`}
                  min={0}
                  max={1}
                  step={0.01}
                  value={continuousSilhouetteOpacity}
                  onChange={setContinuousSilhouetteOpacity}
                />
              )}
            </Section>

            <Section title="Overlays">
              <ToggleRow label="Stats" checked={showStats} onChange={setShowStats} />
              <ToggleRow label="Debug" checked={continuousShowDebug} onChange={setContinuousShowDebug} />
            </Section>
          </>
        )}

        {(mode === "final" || mode === "drone") && <div ref={setFinalSidebar} />}
      </div>

      {mode === "final" && <FinalMode frameData={frameData} sidebar={finalSidebar} />}
      {mode === "drone" && <DroneMode frameData={frameData} sidebar={finalSidebar} />}

      <video
        ref={hiddenVideoRef}
        src={mode === "continuous" && continuousReverse ? "/badapple-reversed.mp4" : "/badapple-small.mp4"}
        muted
        loop
        playsInline
        preload="auto"
        crossOrigin="anonymous"
        className="hidden"
      />
      <canvas ref={canvasRef} className="hidden" />

      <div ref={mapContainerRef} className={`flex-1 relative ${mode === "final" || mode === "drone" ? "hidden" : ""}`}>
        {(SHOW_DEBUG || (mode === "continuous" && continuousShowDebug)) && (
        <div className="absolute top-2 left-2 z-30 bg-black/70 text-[11px] font-mono text-green-400 p-2 rounded pointer-events-none">
          <div>playing: {String(debug.playing)}</div>
          <div>progress: {debug.progress.toFixed(4)}</div>
          <div>frameIndex: {debug.frameIndex}</div>
          <div>vid.time: {debug.videoTime.toFixed(2)}s</div>
          <div>vid.frame: {debug.videoDuration ? Math.round(debug.videoTime * VIDEO_FPS) : 0}</div>
          <div>frame→time: {debug.videoDuration ? frameToVideoTime(frameIndex, debug.videoDuration, videoFrameOffset).toFixed(2) : 0}s</div>
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
        {mode === "continuous" && showStats && currentActivity && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-30 flex gap-4 pointer-events-none">
          <StatPill label="Distance" current={continuousCumulativeDistance + progress * currentActivity.distance_m} max={999999} unit="km" />
          <StatPill label="Time" current={continuousCumulativeTime + progress * currentActivity.time_s} max={999999} unit="hms" />
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