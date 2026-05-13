"use client";

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import DeckGL from "@deck.gl/react";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { Map } from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";
import polyline from "@mapbox/polyline";
import KeyframeSlider from "./KeyframeSlider";

export type Keyframe = { time: number; value: number };

type FrameActivity = { frame: number; polyline: string };

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
  zoomKeyframes: Keyframe[];
  pitchKeyframes: Keyframe[];
  followStrengthKeyframes: Keyframe[];
  bearingStrengthKeyframes: Keyframe[];
  videoOpacityKeyframes: Keyframe[];
};

export const defaultPlayerSettings: PolylinePlayerSettings = {
  "frameIndex": 1815,
  "progress": 0.0,
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
      "time": 1,
      "value": 16.52507519939388
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
  ]
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
  const [frameIndex, setFrameIndex] = useState(defaultPlayerSettings.frameIndex);
  const [frameData, setFrameData] = useState<FrameActivity[] | null>(null);

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

  const [pitch, setPitch] = useState(defaultPlayerSettings.pitch);
  const [followStrength, setFollowStrength] = useState(
    defaultPlayerSettings.followStrength
  );
  const [bearingStrength, setBearingStrength] = useState(
    defaultPlayerSettings.bearingStrength
  );

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
  const [zoomKf, setZoomKf] = useState<number | null>(null);
  const [pitchKf, setPitchKf] = useState<number | null>(null);
  const [followStrengthKf, setFollowStrengthKf] = useState<number | null>(null);
  const [bearingStrengthKf, setBearingStrengthKf] = useState<number | null>(null);
  const [videoOpacity, setVideoOpacity] = useState(defaultPlayerSettings.videoOpacity);
  const [videoOpacityKf, setVideoOpacityKf] = useState<number | null>(null);
  const [zoomKfs, setZoomKfs] = useState<Keyframe[]>(defaultPlayerSettings.zoomKeyframes);
  const [pitchKfs, setPitchKfs] = useState<Keyframe[]>(defaultPlayerSettings.pitchKeyframes);
  const [followStrengthKfs, setFollowStrengthKfs] = useState<Keyframe[]>(defaultPlayerSettings.followStrengthKeyframes);
  const [bearingStrengthKfs, setBearingStrengthKfs] = useState<Keyframe[]>(defaultPlayerSettings.bearingStrengthKeyframes);
  const [videoOpacityKfs, setVideoOpacityKfs] = useState<Keyframe[]>(defaultPlayerSettings.videoOpacityKeyframes);
  const [videoSourceReady, setVideoSourceReady] = useState(false);
  const [mapStyle, setMapStyle] = useState<any>(null);

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

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const mapRef = useRef<MapRef | null>(null);
  const opacityRef = useRef(1);
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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
        setProgress((pr) => (pr >= 1 ? 0 : pr));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

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
  }, []);

  const polylineDuration = 1 / speed;
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const frameIndexRef = useRef(frameIndex);
  frameIndexRef.current = frameIndex;
  const polylineDurationRef = useRef(polylineDuration);
  polylineDurationRef.current = polylineDuration;

  const drawFrame = useCallback(() => {
    const video = hiddenVideoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !isFinite(video.duration)) return;

    const t = Math.max(0, Math.min(video.duration,
      frameToVideoTime(frameIndexRef.current, video.duration) - (1 - progressRef.current) * polylineDurationRef.current));
    video.currentTime = t;

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    };

    draw();
    video.addEventListener("seeked", draw, { once: true });
  }, []);

  // Immediate draw on frameIndex change
  useEffect(() => {
    drawFrame();
  }, [frameIndex, drawFrame]);

  // Immediate draw when scrubbing while paused
  useEffect(() => {
    if (playing) return;
    drawFrame();
  }, [progress, playing, drawFrame]);

  // During playback, let the video play naturally and capture frames
  // The video's linear speed matches the polyline's — both cover
  // polylineDuration seconds, so no seeking is needed mid-playback.
  const prevPlayingRef = useRef(false);

  useEffect(() => {
    const video = hiddenVideoRef.current;
    if (!video || !isFinite(video.duration)) return;

    if (playing) {
      if (!prevPlayingRef.current) {
        const t = Math.max(0, Math.min(video.duration,
          frameToVideoTime(frameIndexRef.current, video.duration) - (1 - progressRef.current) * polylineDurationRef.current));
        video.currentTime = t;
      }
      video.play().catch(() => {});
    } else {
      video.pause();
    }
    prevPlayingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    if (!playing) return;
    let raf: number;
    const loop = () => {
      const video = hiddenVideoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && isFinite(video.duration) && !video.paused) {
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
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
  const effectiveOpacity = interpolateKfs(videoOpacityKfs, progress) ?? videoOpacity;
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

  const viewState = {
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

  return (
    <div className="fixed inset-0 bg-black text-white flex overflow-hidden">
      <div className="w-[380px] shrink-0 bg-zinc-900 p-4 overflow-y-auto border-r border-zinc-800 z-10">
        <h1 className="text-2xl font-bold mb-4">
          deck.gl Polyline Animator
        </h1>

        <div className="mb-5">
          <label className="block mb-2">
            Frame: {frameIndex}
          </label>
          <input
            type="range"
            min={0}
            max={frameData ? frameData[frameData.length - 1].frame : 0}
            step={15}
            value={frameIndex}
            onChange={(e) => setFrameIndex(Number(e.target.value))}
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
        {SHOW_DEBUG && (
        <div className="absolute top-2 left-2 z-30 bg-black/70 text-[11px] font-mono text-green-400 p-2 rounded pointer-events-none">
          <div>playing: {String(debug.playing)}</div>
          <div>progress: {debug.progress.toFixed(4)}</div>
          <div>frameIndex: {debug.frameIndex}</div>
          <div>vid.time: {debug.videoTime.toFixed(2)}</div>
          <div>vid.expect: {debug.expectedTime.toFixed(2)}</div>
          <div>vid.drift: {(debug.videoTime - debug.expectedTime).toFixed(3)}s</div>
          <div>vid.dur: {debug.videoDuration.toFixed(2)}</div>
          <div>vid.paused: {String(debug.videoPaused)}</div>
          <div>vid.ready: {debug.videoReady}</div>
        </div>
        )}
        <DeckGL
          controller={true}
          layers={layers}
          viewState={viewState}
        >
          <Map
            ref={mapRef}
            mapStyle={mapStyle || "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"}
            onLoad={(e: any) => setupVideo(e.target)}
            attributionControl={false}
          />
        </DeckGL>
        </div>
      </div>
  );
}