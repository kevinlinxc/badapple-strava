import React, { useEffect, useState } from "react";

export type Coord = [number, number];

export type FrameActivity = {
  frame: number;
  distance_m: number;
  time_s: number;
  // Local wall clock, "YYYY-MM-DD HH:MM:SS"
  start_time?: string;
  end_time?: string;
  date?: string;
  polyline: string;
};

export type Region = {
  id: string;
  center: Coord;
  overlay: [Coord, Coord, Coord, Coord];
};

export const REGIONS: Region[] = [
  {
    id: "sf",
    center: [-122.080748, 37.3727745],
    overlay: [
      [-122.08197, 37.373400],
      [-122.079526, 37.373400],
      [-122.079526, 37.372149],
      [-122.08197, 37.372149],
    ],
  },
  {
    id: "ny",
    center: [-73.9749085, 40.7718945],
    overlay: [
      [-73.976122, 40.772375],
      [-73.973695, 40.772375],
      [-73.973695, 40.771414],
      [-73.976122, 40.771414],
    ],
  },
];

export function regionForPath(path: Coord[]): Region {
  if (path.length === 0) return REGIONS[0];
  let lng = 0;
  let lat = 0;
  for (const p of path) {
    lng += p[0];
    lat += p[1];
  }
  lng /= path.length;
  lat /= path.length;
  let best = REGIONS[0];
  let bestDist = Infinity;
  for (const r of REGIONS) {
    const d = (r.center[0] - lng) ** 2 + (r.center[1] - lat) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}

export const VIDEO_FPS = 30;
export const VIDEO_TOTAL_FRAMES = 6572;

export function usePersistedState<T>(key: string, defaultValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(defaultValue);
  // Nothing is written until the stored value has been read, or the default would overwrite it on mount
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(`polyline-player-${key}`);
      if (stored !== null) setState(JSON.parse(stored));
    } catch {}
    setLoaded(true);
  }, [key]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(`polyline-player-${key}`, JSON.stringify(state));
    } catch {}
  }, [key, state, loaded]);

  return [state, setState];
}

export const BLEND_OPTIONS: { value: string; label: string; title?: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "screen", label: "Screen", title: "White → transparent" },
  { value: "overlay", label: "Overlay", title: "Black → transparent" },
];

export const MAP_THEMES = [
  { id: "dark-matter", label: "Dark Matter", url: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" },
  { id: "positron", label: "Positron", url: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json" },
  { id: "voyager", label: "Voyager", url: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json" },
  { id: "dark-matter-nolabels", label: "Dark Matter (no labels)", url: "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json" },
  { id: "positron-nolabels", label: "Positron (no labels)", url: "https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json" },
  { id: "voyager-nolabels", label: "Voyager (no labels)", url: "https://basemaps.cartocdn.com/gl/voyager-nolabels-gl-style/style.json" },
  { id: "maplibre-demo", label: "MapLibre Demo", url: "https://demotiles.maplibre.org/style.json" },
  { id: "versatiles-colorful", label: "Versatiles Colorful", url: "https://tiles.versatiles.org/assets/styles/colorful/style.json" },
  { id: "versatiles-neutrino", label: "Versatiles Neutrino", url: "https://tiles.versatiles.org/assets/styles/neutrino/style.json" },
  { id: "versatiles-eclipse", label: "Versatiles Eclipse", url: "https://tiles.versatiles.org/assets/styles/eclipse/style.json" },
  { id: "strava-dark", label: "Strava Dark", url: "/map-styles/strava-dark.json" },
];

export function setLabelVisibility(map: maplibregl.Map, visible: boolean) {
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type === "symbol") {
      map.setLayoutProperty(layer.id, "visibility", visible ? "visible" : "none");
    }
  }
}

// Resolves once the map has drawn with every tile it needs
export function idle(map: maplibregl.Map) {
  return new Promise<void>((resolve) => {
    map.once("idle", () => resolve());
    map.triggerRepaint();
  });
}

// Yields to the event loop without a timer or animation frame, neither of which runs reliably in a hidden tab
function yieldTask() {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

// Like idle, but drawn synchronously instead of on animation frames, so it keeps going when the tab is hidden.
// A render requests the tiles the camera needs, and each tile that arrives marks the map dirty for another render.
export async function renderSettled(map: maplibregl.Map) {
  const flags = map as unknown as { _styleDirty: boolean; _sourcesDirty: boolean; _placementDirty: boolean };
  const dirty = () => flags._styleDirty || flags._sourcesDirty || flags._placementDirty;
  for (;;) {
    map.redraw();
    if (map.loaded() && !dirty()) return;
    // Renders again at least every 100ms in case something loads without marking the map dirty
    const start = performance.now();
    while (!dirty() && performance.now() - start < 100) await yieldTask();
  }
}

export function applyBlendMode(ctx: CanvasRenderingContext2D, width: number, height: number, mode: string) {
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
