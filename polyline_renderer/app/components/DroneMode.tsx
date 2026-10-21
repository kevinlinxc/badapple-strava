"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import maplibregl from "maplibre-gl";
import polyline from "@mapbox/polyline";
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output } from "mediabunny";
import {
  type Coord,
  type FrameActivity,
  idle,
  MAP_THEMES,
  regionForPath,
  setLabelVisibility,
  usePersistedState,
} from "../lib/shared";
import { IconButton, ProgressRow, Section, SegRow, SelectRow, SliderRow, TextButton, ToggleRow } from "./controls";

// The drone orbits a focus point on the ground. x/y is that point in meters east/north of the park center, zoom is
// how far back the drone sits, pitch tilts it from straight down towards the horizon, bearing is the direction it
// faces and roll banks it. Keeping the focus fixed while bearing changes flies a circle around it.
type Pose = { x: number; y: number; zoom: number; pitch: number; bearing: number; roll: number };
type CameraKey = Pose & { time: number };
type Easing = "linear" | "smooth";

const CHANNELS: (keyof Pose)[] = ["x", "y", "zoom", "pitch", "bearing", "roll"];

// Starts over the east edge looking west at the center, and swings around to the south edge looking north
const DEFAULT_KEYS: CameraKey[] = [
  { time: 0, x: 0, y: 0, zoom: 17.6, pitch: 55, bearing: -90, roll: 0 },
  { time: 1, x: 0, y: 0, zoom: 17.6, pitch: 55, bearing: 0, roll: 0 },
];
const DEFAULT_DURATION = 12;
const DEFAULT_FOV = 36.87;
const MAX_PITCH = 85;
// A key this close to the playhead is the one being edited
const KEY_SNAP = 0.001;

type ExportSize = "1080p" | "1440p" | "4k";
const EXPORT_SIZES: Record<ExportSize, number> = { "1080p": 1920, "1440p": 2560, "4k": 3840 };
// 16 Mbps at 1080p30, scaled with pixel count and frame rate
const BITRATE_PER_PIXEL = 16_000_000 / (1920 * 1080);
const OUTPUT_NAME = "badapple-strava-drone.mp4";
const KEYS_FILE_NAME = "badapple-strava-drone.json";

const TRAIL_RGB = "255, 140, 0";
const KEY_COLOR = "#f87171";
const M_PER_DEG = 111_320;
const EARTH_CIRCUMFERENCE = 40_075_016.7;

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function pick(k: CameraKey): Pose {
  return { x: k.x, y: k.y, zoom: k.zoom, pitch: k.pitch, bearing: k.bearing, roll: k.roll };
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function isCameraKey(k: unknown): k is CameraKey {
  return (
    typeof k === "object" &&
    k !== null &&
    ["time", ...CHANNELS].every((c) => typeof (k as Record<string, unknown>)[c] === "number")
  );
}

function sortKeys(keys: CameraKey[]) {
  return [...keys].sort((a, b) => a.time - b.time);
}

function keyIndexAt(keys: CameraKey[], time: number) {
  return keys.findIndex((k) => Math.abs(k.time - time) < KEY_SNAP);
}

// Keys must be sorted by time
function poseAt(keys: CameraKey[], time: number, easing: Easing): Pose | null {
  if (keys.length === 0) return null;
  const last = keys[keys.length - 1];
  if (time <= keys[0].time) return pick(keys[0]);
  if (time >= last.time) return pick(last);
  let i = 0;
  while (i < keys.length - 2 && time > keys[i + 1].time) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.time - a.time;
  const u = span > 0 ? (time - a.time) / span : 1;
  const pose = {} as Pose;
  for (const c of CHANNELS) {
    if (easing === "linear") {
      pose[c] = a[c] + (b[c] - a[c]) * u;
      continue;
    }
    // Cubic through every key with slopes from its neighbors, flat at the first and last key so the drone eases
    // in and out without stopping at the keys in between
    const slope = (j: number) =>
      j <= 0 || j >= keys.length - 1 ? 0 : (keys[j + 1][c] - keys[j - 1][c]) / (keys[j + 1].time - keys[j - 1].time || 1);
    const u2 = u * u;
    const u3 = u2 * u;
    pose[c] =
      (2 * u3 - 3 * u2 + 1) * a[c] +
      (u3 - 2 * u2 + u) * span * slope(i) +
      (-2 * u3 + 3 * u2) * b[c] +
      (u3 - u2) * span * slope(i + 1);
  }
  return pose;
}

function toLngLat(center: Coord, x: number, y: number): Coord {
  return [center[0] + x / (M_PER_DEG * Math.cos((center[1] * Math.PI) / 180)), center[1] + y / M_PER_DEG];
}

function fromLngLat(center: Coord, lng: number, lat: number) {
  return {
    x: (lng - center[0]) * M_PER_DEG * Math.cos((center[1] * Math.PI) / 180),
    y: (lat - center[1]) * M_PER_DEG,
  };
}

// Steps in the faded tail. The gradient is always a step: maplibre samples an interpolated gradient at only 256
// points along the whole line, which made the head of the drawing crawl forward in visible jumps.
const FADE_STEPS = 32;

// Drawn up to `progress` (both as a fraction of the path's length). With a tail, only that much behind the head is
// visible, fading out towards its far end.
function trailGradient(progress: number, tail: number, alpha: number): maplibregl.ExpressionSpecification {
  const clear = `rgba(${TRAIL_RGB}, 0)`;
  if (progress <= 0) return ["step", ["line-progress"], clear, 0, clear];
  if (tail <= 0) return ["step", ["line-progress"], `rgba(${TRAIL_RGB}, ${alpha})`, progress, clear];
  let base = clear;
  const stops: (number | string)[] = [];
  for (let k = 0; k < FADE_STEPS; k++) {
    const start = progress - tail + (k * tail) / FADE_STEPS;
    const color = `rgba(${TRAIL_RGB}, ${((alpha * (k + 1)) / FADE_STEPS).toFixed(4)})`;
    if (start <= 0) base = color;
    else stops.push(start, color);
  }
  return ["step", ["line-progress"], base, ...stops, progress, clear] as maplibregl.ExpressionSpecification;
}

type TrailStyle = { lineWidth: number; glow: boolean; progress: number; tail: number; labels: boolean };

// Used for both the preview map and the export map, after each style load
function addTrail(map: maplibregl.Map, path: Coord[]) {
  map.addSource("drone-trail", {
    type: "geojson",
    lineMetrics: true,
    data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: path } },
  });
  const layout = { "line-cap": "round", "line-join": "round" } as const;
  map.addLayer({ id: "drone-trail-glow", type: "line", source: "drone-trail", layout, paint: { "line-blur": 6 } });
  map.addLayer({ id: "drone-trail", type: "line", source: "drone-trail", layout });
}

function styleTrail(map: maplibregl.Map, { lineWidth, glow, progress, tail, labels }: TrailStyle) {
  if (!map.getLayer("drone-trail")) return;
  setLabelVisibility(map, labels);
  map.setPaintProperty("drone-trail", "line-width", lineWidth);
  map.setPaintProperty("drone-trail", "line-gradient", trailGradient(progress, tail, 1));
  map.setLayoutProperty("drone-trail-glow", "visibility", glow ? "visible" : "none");
  map.setPaintProperty("drone-trail-glow", "line-width", lineWidth * 4);
  map.setPaintProperty("drone-trail-glow", "line-gradient", trailGradient(progress, tail, 0.3));
}

function cameraFor(center: Coord, pose: Pose) {
  return {
    center: toLngLat(center, pose.x, pose.y),
    zoom: pose.zoom,
    pitch: clamp(pose.pitch, 0, MAX_PITCH),
    bearing: pose.bearing,
    roll: pose.roll,
  };
}

function KeyTimeline({
  keys,
  time,
  onSeek,
  onMoveKey,
  onDeleteKey,
}: {
  keys: CameraKey[];
  time: number;
  onSeek: (time: number) => void;
  onMoveKey: (index: number, time: number) => void;
  onDeleteKey: (index: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ index: number; startX: number; moved: boolean } | null>(null);
  const timeAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  };

  return (
    <div className="py-1.5 px-2 select-none">
      <div
        ref={trackRef}
        className="relative h-7 cursor-ew-resize touch-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          onSeek(timeAt(e.clientX));
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (drag) {
            if (!drag.moved && Math.abs(e.clientX - drag.startX) < 3) return;
            drag.moved = true;
            // Keys stay between their neighbors, so the order and the index being dragged never change
            const lo = drag.index > 0 ? keys[drag.index - 1].time + KEY_SNAP * 2 : 0;
            const hi = drag.index < keys.length - 1 ? keys[drag.index + 1].time - KEY_SNAP * 2 : 1;
            onMoveKey(drag.index, clamp(timeAt(e.clientX), lo, hi));
          } else if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            onSeek(timeAt(e.clientX));
          }
        }}
        onPointerUp={(e) => {
          const drag = dragRef.current;
          dragRef.current = null;
          if (drag && !drag.moved) onSeek(keys[drag.index].time);
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      >
        <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-s-track" />
        <div className="absolute left-0 top-1/2 h-0.5 -translate-y-1/2 bg-s-dim" style={{ width: `${time * 100}%` }} />
        {keys.map((k, i) => {
          const current = Math.abs(k.time - time) < KEY_SNAP;
          return (
            <div
              key={i}
              title="Click to jump, drag to retime, double-click to delete"
              className="absolute top-1/2 w-4 h-4 -translate-x-1/2 -translate-y-1/2 grid place-items-center cursor-grab z-10"
              style={{ left: `${k.time * 100}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                trackRef.current?.setPointerCapture(e.pointerId);
                dragRef.current = { index: i, startX: e.clientX, moved: false };
              }}
              onDoubleClick={() => onDeleteKey(i)}
            >
              <div
                className="w-2 h-2 rotate-45"
                style={{ background: KEY_COLOR, outline: current ? "1.5px solid #fff" : "1px solid #7f1d1d" }}
              />
            </div>
          );
        })}
        <div
          className="absolute top-0 bottom-0 w-px -translate-x-1/2 bg-s-accent pointer-events-none"
          style={{ left: `${time * 100}%` }}
        />
      </div>
    </div>
  );
}

function SmallButton({ children, onClick, primary }: { children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 rounded text-[11px] transition-colors ${
        primary ? "bg-s-accent text-white" : "bg-s-panel text-s-dim hover:text-s-text"
      }`}
    >
      {children}
    </button>
  );
}

export default function DroneMode({
  frameData,
  sidebar,
}: {
  frameData: FrameActivity[] | null;
  sidebar: HTMLElement | null;
}) {
  const [storedKeys, setStoredKeys] = usePersistedState<CameraKey[]>("drone.keys", DEFAULT_KEYS);
  const [time, setTime] = usePersistedState("drone.time", 0);
  const [duration, setDuration] = usePersistedState("drone.duration", DEFAULT_DURATION);
  const [easing, setEasing] = usePersistedState<Easing>("drone.easing", "smooth");
  const [loop, setLoop] = usePersistedState("drone.loop", false);
  const [theme, setTheme] = usePersistedState("drone.theme", "dark-matter");
  const [labels, setLabels] = usePersistedState("drone.labels", false);
  const [fade, setFade] = usePersistedState("drone.fade", false);
  // Bad Apple frames bounding the activities that get drawn, both inclusive
  const [startFrame, setStartFrame] = usePersistedState("drone.startFrame", 0);
  const [endFrame, setEndFrame] = usePersistedState("drone.endFrame", 1000);
  // Seconds of trail kept behind the head when fading
  const [tailSeconds, setTailSeconds] = usePersistedState("drone.tail", 2);
  const [lineWidth, setLineWidth] = usePersistedState("drone.lineWidth", 1.5);
  const [glow, setGlow] = usePersistedState("drone.glow", true);
  const [fov, setFov] = usePersistedState("drone.fov", DEFAULT_FOV);
  const [playing, setPlaying] = useState(false);
  // Camera moved off the keyed path by hand at a time with no key. Kept until it is keyed or the playhead moves.
  const [pending, setPending] = useState<Pose | null>(null);
  const [styleVersion, setStyleVersion] = useState(0);
  const [viewHeight, setViewHeight] = useState(1000);
  const [exportSize, setExportSize] = usePersistedState<ExportSize>("drone.exportSize", "1080p");
  const [exportFps, setExportFps] = usePersistedState("drone.exportFps", 30);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const exportingRef = useRef(false);
  const cancelRef = useRef(false);
  const importRef = useRef<HTMLInputElement | null>(null);

  const keys = useMemo(() => sortKeys(storedKeys), [storedKeys]);
  const setKeys = useCallback(
    (update: (prev: CameraKey[]) => CameraKey[]) => setStoredKeys((prev) => sortKeys(update(sortKeys(prev)))),
    [setStoredKeys],
  );

  const activities = useMemo(
    () => (frameData ?? []).filter((a) => a.frame >= startFrame && a.frame <= endFrame),
    [frameData, startFrame, endFrame],
  );
  // The activities in range in order, each one's end joined to the next one's start
  const path = useMemo(() => {
    const coords: Coord[] = [];
    for (const a of activities) {
      for (const [lat, lng] of polyline.decode(a.polyline) as [number, number][]) coords.push([lng, lat]);
    }
    return coords;
  }, [activities]);
  // Slider position of a frame: the index of the first activity at or after it
  const activityIndex = (frame: number) =>
    frameData ? Math.max(0, frameData.findIndex((d) => d.frame >= frame)) : 0;
  const center = useMemo(() => regionForPath(path).center, [path]);

  const keyIndex = keyIndexAt(keys, time);
  const live: Pose = pending ?? poseAt(keys, time, easing) ?? pick(DEFAULT_KEYS[0]);
  const themeUrl = MAP_THEMES.find((t) => t.id === theme)?.url ?? MAP_THEMES[0].url;
  const tail = fade ? tailSeconds / duration : 0;

  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleRef = useRef(themeUrl);
  // True from the start of a drag, scroll or rotate on the map until it settles, so the keyed camera does not fight it
  const interactingRef = useRef(false);
  const pathRef = useRef(path);
  pathRef.current = path;
  const centerRef = useRef(center);
  centerRef.current = center;
  const liveRef = useRef(live);
  liveRef.current = live;
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const timeRef = useRef(time);
  timeRef.current = time;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  const seek = useCallback(
    (t: number) => {
      setPending(null);
      timeRef.current = t;
      setTime(t);
    },
    [setTime],
  );

  // A change lands on the key under the playhead, or is held as pending when there is none
  const edit = useCallback(
    (patch: Partial<Pose>) => {
      const next = { ...liveRef.current, ...patch };
      liveRef.current = next;
      const t = timeRef.current;
      if (keyIndexAt(keysRef.current, t) < 0) {
        setPending(next);
        return;
      }
      setKeys((prev) => prev.map((k) => (Math.abs(k.time - t) < KEY_SNAP ? { ...k, ...next } : k)));
    },
    [setKeys],
  );

  const addKey = useCallback(() => {
    const t = timeRef.current;
    const pose = liveRef.current;
    setKeys((prev) => [...prev.filter((k) => Math.abs(k.time - t) >= KEY_SNAP), { time: t, ...pose }]);
    setPending(null);
  }, [setKeys]);

  const deleteKey = useCallback(
    (index: number) => {
      setKeys((prev) => prev.filter((_, j) => j !== index));
      setPending(null);
    },
    [setKeys],
  );

  const togglePlaying = useCallback(() => {
    if (exportingRef.current) return;
    if (!playingRef.current && timeRef.current >= 1) seek(0);
    setPending(null);
    setPlaying((p) => !p);
  }, [seek]);

  useEffect(() => {
    if (!mapDivRef.current) return;
    const p = liveRef.current;
    const map = new maplibregl.Map({
      container: mapDivRef.current,
      style: styleRef.current,
      center: toLngLat(centerRef.current, p.x, p.y),
      zoom: p.zoom,
      pitch: p.pitch,
      bearing: p.bearing,
      roll: p.roll,
      maxPitch: MAX_PITCH,
      attributionControl: false,
      fadeDuration: 0,
    });
    mapRef.current = map;

    map.on("style.load", () => {
      addTrail(map, pathRef.current);
      setStyleVersion((v) => v + 1);
    });

    const readCamera = (): Pose => {
      const c = map.getCenter();
      // The map keeps bearing within ±180, so it is unwrapped against the last value to let keys orbit past that
      const previous = liveRef.current.bearing;
      const turn = ((((map.getBearing() - previous) % 360) + 540) % 360) - 180;
      return {
        ...fromLngLat(centerRef.current, c.lng, c.lat),
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: previous + turn,
        roll: map.getRoll(),
      };
    };
    map.on("movestart", (e) => {
      if (!e.originalEvent) return;
      interactingRef.current = true;
      setPlaying(false);
    });
    map.on("move", () => {
      if (interactingRef.current) edit(readCamera());
    });
    map.on("moveend", () => {
      if (!interactingRef.current) return;
      edit(readCamera());
      interactingRef.current = false;
    });

    const container = mapDivRef.current;
    const resize = new ResizeObserver(() => setViewHeight(container.clientHeight || 1000));
    resize.observe(container);

    return () => {
      resize.disconnect();
      mapRef.current = null;
      map.remove();
    };
  }, [edit]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleRef.current === themeUrl) return;
    styleRef.current = themeUrl;
    // A diffed style change would drop the trail layers without firing style.load to put them back
    map.setStyle(themeUrl, { diff: false });
  }, [themeUrl]);

  useEffect(() => {
    const source = mapRef.current?.getSource("drone-trail") as maplibregl.GeoJSONSource | undefined;
    source?.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: path } });
  }, [path, styleVersion]);

  useEffect(() => {
    const map = mapRef.current;
    if (map) styleTrail(map, { lineWidth, glow, progress: time, tail, labels });
  }, [lineWidth, glow, time, tail, labels, styleVersion]);

  useEffect(() => {
    mapRef.current?.setVerticalFieldOfView(fov);
  }, [fov]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || interactingRef.current) return;
    map.jumpTo(cameraFor(center, { x: live.x, y: live.y, zoom: live.zoom, pitch: live.pitch, bearing: live.bearing, roll: live.roll }));
  }, [center, live.x, live.y, live.zoom, live.pitch, live.bearing, live.roll]);

  // Renders every frame on a hidden map sized like the preview in CSS pixels, so zoom frames the shot the same way,
  // with the pixel ratio raised to reach the output resolution. Each frame waits for its tiles before it is captured.
  // The keys go out with the timing and look they were set up with, so an import plays back the same
  const exportKeys = () => {
    const data = {
      keys,
      duration,
      easing,
      fov,
      theme,
      labels,
      fade,
      tailSeconds,
      lineWidth,
      glow,
      startFrame,
      endFrame,
    };
    download(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), KEYS_FILE_NAME);
  };

  const importKeys = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      // A bare array of keys is accepted too
      const imported: unknown = Array.isArray(data) ? data : data?.keys;
      if (!Array.isArray(imported) || imported.length === 0 || !imported.every(isCameraKey)) {
        throw new Error("No valid keys in file");
      }
      setPlaying(false);
      setStoredKeys(imported.map((k) => ({ time: k.time, ...pick(k) })));
      if (!Array.isArray(data)) {
        const num = (v: unknown, set: (n: number) => void) => typeof v === "number" && set(v);
        const bool = (v: unknown, set: (b: boolean) => void) => typeof v === "boolean" && set(v);
        num(data.duration, setDuration);
        num(data.fov, setFov);
        num(data.tailSeconds, setTailSeconds);
        num(data.lineWidth, setLineWidth);
        num(data.startFrame, setStartFrame);
        num(data.endFrame, setEndFrame);
        bool(data.labels, setLabels);
        bool(data.fade, setFade);
        bool(data.glow, setGlow);
        if (data.easing === "smooth" || data.easing === "linear") setEasing(data.easing);
        if (MAP_THEMES.some((t) => t.id === data.theme)) setTheme(data.theme);
      }
      seek(0);
      setError(null);
    } catch (e) {
      setError(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const exportVideo = useCallback(async () => {
    const preview = mapDivRef.current;
    if (!preview || exportingRef.current) return;
    setPlaying(false);
    setError(null);
    setExportProgress(0);
    exportingRef.current = true;
    cancelRef.current = false;

    const outW = EXPORT_SIZES[exportSize];
    const outH = Math.round((outW * 9) / 16 / 2) * 2;
    const box = document.createElement("div");
    box.style.cssText = `position:fixed;left:0;top:0;width:${preview.clientWidth}px;height:${preview.clientHeight}px;opacity:0;pointer-events:none;z-index:-10`;
    document.body.appendChild(box);
    const firstPose = poseAt(keys, 0, easing) ?? pick(DEFAULT_KEYS[0]);
    const map = new maplibregl.Map({
      container: box,
      style: themeUrl,
      ...cameraFor(center, firstPose),
      maxPitch: MAX_PITCH,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      pixelRatio: outW / preview.clientWidth,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    map.on("style.load", () => addTrail(map, path));

    try {
      await new Promise<void>((resolve) => map.once("load", () => resolve()));
      map.setVerticalFieldOfView(fov);

      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d")!;
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
      const videoSource = new CanvasSource(canvas, {
        codec: "avc",
        bitrate: Math.round(BITRATE_PER_PIXEL * outW * outH * (exportFps / 30)),
      });
      output.addVideoTrack(videoSource, { frameRate: exportFps });
      await output.start();

      const frames = Math.max(2, Math.round(duration * exportFps));
      for (let n = 0; n < frames && !cancelRef.current; n++) {
        const t = n / (frames - 1);
        map.jumpTo(cameraFor(center, poseAt(keys, t, easing) ?? firstPose));
        styleTrail(map, { lineWidth, glow, labels, progress: t, tail });
        await idle(map);
        ctx.drawImage(map.getCanvas(), 0, 0, outW, outH);
        await videoSource.add(n / exportFps, 1 / exportFps);
        if (n % 5 === 0) setExportProgress(n / frames);
      }
      videoSource.close();

      if (cancelRef.current) {
        await output.cancel();
      } else {
        await output.finalize();
        download(new Blob([output.target.buffer!], { type: "video/mp4" }), OUTPUT_NAME);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      map.remove();
      box.remove();
      exportingRef.current = false;
      setExportProgress(null);
    }
  }, [keys, easing, duration, center, path, themeUrl, fov, lineWidth, glow, labels, tail, exportSize, exportFps]);
  const exporting = exportProgress !== null;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      let next = timeRef.current + (now - last) / 1000 / durationRef.current;
      last = now;
      if (next >= 1) {
        if (loopRef.current) {
          next %= 1;
        } else {
          timeRef.current = 1;
          setTime(1);
          setPlaying(false);
          return;
        }
      }
      timeRef.current = next;
      setTime(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, setTime]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLSelectElement) return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlaying();
      } else if (e.key === "k") {
        addKey();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlaying, addKey]);

  const previousKey = [...keys].reverse().find((k) => k.time < time - KEY_SNAP);
  const nextKey = keys.find((k) => k.time > time + KEY_SNAP);

  // How far the drone is from the focus point, from the map's projection: the camera sits half the view height over
  // tan(fov / 2) pixels back, and zoom sets the pixels per meter
  const pixelsPerMeter = (512 * 2 ** live.zoom) / (EARTH_CIRCUMFERENCE * Math.cos((center[1] * Math.PI) / 180));
  const range = viewHeight / 2 / Math.tan((fov * Math.PI) / 360) / pixelsPerMeter;
  const pitchRad = (clamp(live.pitch, 0, MAX_PITCH) * Math.PI) / 180;

  const channel = (label: string, c: keyof Pose, min: number, max: number, step: number, format: (v: number) => string) => (
    <SliderRow
      label={label}
      display={format(live[c])}
      min={min}
      max={max}
      step={step}
      value={clamp(live[c], min, max)}
      fill={keyIndex >= 0 ? KEY_COLOR : undefined}
      onChange={(v) => edit({ [c]: v })}
    />
  );

  return (
    <>
      <div className="flex-1 min-w-0 flex items-center justify-center bg-black">
        {/* The largest 16:9 box that fits, so the preview frames the shot like the export. Sized with inline styles
            because maplibre's stylesheet overrides Tailwind's positioning on the map container. */}
        <div ref={mapDivRef} style={{ width: "min(100%, calc(100vh * 16 / 9))", aspectRatio: "16 / 9" }} />
      </div>

      {sidebar &&
        createPortal(
          <>
            <Section title="Activities">
              <SliderRow
                label="Start frame"
                arrows
                display={String(startFrame)}
                min={0}
                max={frameData ? frameData.length - 1 : 0}
                step={1}
                value={activityIndex(startFrame)}
                onChange={(v) => {
                  const f = frameData?.[v]?.frame;
                  if (f == null) return;
                  setStartFrame(f);
                  if (f > endFrame) setEndFrame(f);
                }}
              />
              <SliderRow
                label="End frame"
                arrows
                display={String(endFrame)}
                min={0}
                max={frameData ? frameData.length - 1 : 0}
                step={1}
                value={activityIndex(endFrame)}
                onChange={(v) => {
                  const f = frameData?.[v]?.frame;
                  if (f == null) return;
                  setEndFrame(f);
                  if (f < startFrame) setStartFrame(f);
                }}
              />
              <div className="flex justify-between min-h-[26px] items-center">
                <span className="text-s-dim">Drawn</span>
                <span className="font-mono text-[11px] tabular-nums text-s-dim">
                  {activities.length} of {frameData?.length ?? 0}
                </span>
              </div>
            </Section>

            <Section>
              <KeyTimeline
                keys={keys}
                time={time}
                onSeek={(t) => {
                  setPlaying(false);
                  seek(t);
                }}
                onMoveKey={(index, t) => {
                  setKeys((prev) => prev.map((k, j) => (j === index ? { ...k, time: t } : k)));
                  seek(t);
                }}
                onDeleteKey={deleteKey}
              />
              <SliderRow
                label="Time"
                display={`${(time * duration).toFixed(1)}s`}
                min={0}
                max={1}
                step={0.001}
                value={time}
                onChange={(t) => {
                  setPlaying(false);
                  seek(t);
                }}
              />
              <div className="flex gap-1.5 py-1">
                <IconButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} primary onClick={togglePlaying} />
                <IconButton
                  icon="start"
                  label="Start"
                  onClick={() => {
                    setPlaying(false);
                    seek(0);
                  }}
                />
                <IconButton
                  icon="end"
                  label="End"
                  onClick={() => {
                    setPlaying(false);
                    seek(1);
                  }}
                />
                <div className="flex-1" />
                <IconButton
                  icon="prev"
                  label="Previous key"
                  onClick={() => {
                    if (!previousKey) return;
                    setPlaying(false);
                    seek(previousKey.time);
                  }}
                />
                <IconButton
                  icon="next"
                  label="Next key"
                  onClick={() => {
                    if (!nextKey) return;
                    setPlaying(false);
                    seek(nextKey.time);
                  }}
                />
              </div>
              <SliderRow
                label="Duration"
                display={`${duration.toFixed(0)}s`}
                min={2}
                max={120}
                step={1}
                value={duration}
                onChange={setDuration}
              />
              <SegRow
                label="Easing"
                value={easing}
                onChange={setEasing}
                options={[
                  { value: "smooth", label: "Smooth", title: "Curves through every key, easing in and out at the ends" },
                  { value: "linear", label: "Linear" },
                ]}
              />
              <ToggleRow label="Loop" checked={loop} onChange={setLoop} />
            </Section>

            <Section title="Camera">
              <div className="flex items-center gap-1.5 min-h-[30px]">
                <span className="flex-1 text-s-dim">
                  {keyIndex >= 0
                    ? `Key ${keyIndex + 1} of ${keys.length}`
                    : pending
                      ? "Not keyed"
                      : "Between keys"}
                </span>
                {keyIndex >= 0 ? (
                  <SmallButton onClick={() => deleteKey(keyIndex)}>Delete key</SmallButton>
                ) : (
                  <>
                    {pending && <SmallButton onClick={() => setPending(null)}>Discard</SmallButton>}
                    <SmallButton primary={!!pending} onClick={addKey}>
                      Add key
                    </SmallButton>
                  </>
                )}
              </div>
              {channel("Focus east", "x", -600, 600, 1, (v) => `${v.toFixed(0)}m`)}
              {channel("Focus north", "y", -600, 600, 1, (v) => `${v.toFixed(0)}m`)}
              {channel("Zoom", "zoom", 14, 21, 0.01, (v) => v.toFixed(2))}
              {channel("Pitch", "pitch", 0, MAX_PITCH, 0.1, (v) => `${v.toFixed(0)}°`)}
              {channel("Bearing", "bearing", -360, 360, 0.5, (v) => `${v.toFixed(0)}°`)}
              {channel("Roll", "roll", -45, 45, 0.1, (v) => `${v.toFixed(0)}°`)}
              <div className="flex justify-between min-h-[26px] items-center">
                <span className="text-s-dim">Drone</span>
                <span className="font-mono text-[11px] tabular-nums text-s-dim">
                  {Math.round(range * Math.cos(pitchRad))}m up · {Math.round(range * Math.sin(pitchRad))}m out
                </span>
              </div>
              <p className="pt-1 text-[11px] leading-4 text-s-dim">
                Aim by dragging the map: drag moves the focus, right-drag orbits and tilts, scroll zooms. On a key the
                change edits it; elsewhere press Add key (K). Space plays.
              </p>
            </Section>

            <Section title="View">
              <SelectRow
                label="Theme"
                value={theme}
                onChange={setTheme}
                options={MAP_THEMES.map((t) => ({ value: t.id, label: t.label }))}
              />
              <ToggleRow label="Labels" checked={labels} onChange={setLabels} />
              <ToggleRow label="Fade tail" checked={fade} onChange={setFade} />
              {fade && (
                <SliderRow
                  label="Tail"
                  display={`${tailSeconds.toFixed(1)}s`}
                  min={0.1}
                  max={Math.max(0.1, duration)}
                  step={0.1}
                  value={tailSeconds}
                  onChange={setTailSeconds}
                />
              )}
              <SliderRow
                label="Width"
                display={lineWidth.toFixed(1)}
                min={0.5}
                max={12}
                step={0.5}
                value={lineWidth}
                onChange={setLineWidth}
              />
              <ToggleRow label="Glow" checked={glow} onChange={setGlow} />
              <SliderRow
                label="FOV"
                display={`${fov.toFixed(0)}°`}
                min={10}
                max={90}
                step={1}
                value={fov}
                onChange={setFov}
              />
            </Section>

            <Section title="Export">
              <SegRow
                label="Size"
                value={exportSize}
                onChange={setExportSize}
                options={[
                  { value: "1080p", label: "1080p" },
                  { value: "1440p", label: "1440p" },
                  { value: "4k", label: "4K" },
                ]}
              />
              <SegRow
                label="FPS"
                value={String(exportFps)}
                onChange={(v) => setExportFps(Number(v))}
                options={[
                  { value: "30", label: "30" },
                  { value: "60", label: "60" },
                ]}
              />
              {exporting ? (
                <>
                  <ProgressRow label="Rendering" display={`${Math.round(exportProgress * 100)}%`} fraction={exportProgress} />
                  <div className="flex min-h-[26px] items-center">
                    <TextButton onClick={() => (cancelRef.current = true)}>Cancel</TextButton>
                  </div>
                </>
              ) : (
                <button onClick={exportVideo} className="mt-1 py-1.5 rounded bg-s-accent text-white font-medium">
                  Export MP4
                </button>
              )}
              {error ? <div className="mt-1 text-[11px] text-red-400">{error}</div> : null}
            </Section>

            <Section title="Settings">
              <div className="flex gap-4 min-h-[26px] items-center">
                <TextButton
                  onClick={() => {
                    setPlaying(false);
                    setStoredKeys(DEFAULT_KEYS);
                    setDuration(DEFAULT_DURATION);
                    setFov(DEFAULT_FOV);
                    seek(0);
                  }}
                >
                  Reset to sweep
                </TextButton>
                <TextButton onClick={exportKeys}>Export keys</TextButton>
                <TextButton onClick={() => importRef.current?.click()}>Import keys</TextButton>
                <input
                  ref={importRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) importKeys(file);
                  }}
                />
              </div>
            </Section>
          </>,
          sidebar,
        )}
    </>
  );
}
