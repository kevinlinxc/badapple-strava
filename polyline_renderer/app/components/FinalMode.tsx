"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import maplibregl from "maplibre-gl";
import polyline from "@mapbox/polyline";
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  UrlSource,
  type VideoSample,
  VideoSampleSink,
} from "mediabunny";
import {
  applyBlendMode,
  BLEND_OPTIONS,
  type Coord,
  type FrameActivity,
  idle,
  MAP_THEMES,
  type Region,
  regionForPath,
  REGIONS,
  setLabelVisibility,
  usePersistedState,
  VIDEO_FPS,
  VIDEO_TOTAL_FRAMES,
} from "../lib/shared";
import { IconButton, ProgressRow, Section, SegRow, SelectRow, SliderRow, TextButton, ToggleRow } from "./controls";

// Output frame: map on the left; on the right an orange totals block, the weekly chart, then the screenshot card
const W = 1920;
const H = 1080;
const MAP_W = 1440;
const SIDE_W = W - MAP_W;
const PAD = 24;
// The card is shaped like the widest screenshot by the tallest one. Every screenshot is drawn at the same
// scale and centered in it, so smaller ones get a margin instead of being stretched.
const SCREENSHOT_MAX_W = 1206;
const SCREENSHOT_MAX_H = 1505;
const CARD_MARGIN = 16;
const CARD_W = SIDE_W - CARD_MARGIN * 2;
const SCREENSHOT_SCALE = CARD_W / SCREENSHOT_MAX_W;
const CARD_H = Math.round(SCREENSHOT_MAX_H * SCREENSHOT_SCALE);
const CARD_Y = H - CARD_MARGIN - CARD_H;
const HERO_H = 250;
const CHART_Y = HERO_H;
const CHART_H = CARD_Y - CARD_MARGIN - CHART_Y;

const APPLE_SRC = "/badapple-small.mp4";
// Copied from strava_data/screenshots/uncensored/uncensored-removed
const screenshotSrc = (frame: number) => `/uncensored-removed/badapple-strava-${String(frame).padStart(4, "0")}.jpg`;
const OUTPUT_NAME = "badapple-strava-final.mp4";
const BITRATE = 16_000_000;
const AUDIO_BITRATE = 256_000;
// Samples of padding macOS Chrome's AAC encoder puts in front of the audio. Measured on an export: without
// removing them the music lands 2112 / 44100 s late.
const AAC_PRIMING_SAMPLES = 2112;

// Bad Apple is held on frame 0 this long while the first polyline draws, so the totals start from zero.
// Frames are numbered by Bad Apple frame throughout, which makes the intro -INTRO_FRAMES..-1.
const INTRO_FRAMES = 30;
const OUTPUT_FRAMES = INTRO_FRAMES + VIDEO_TOTAL_FRAMES;

const ORANGE = "#fc5200";
const PANEL = "#0b0b0d";
const LINE = "#25252a";
const DIM = "#85858f";
const TEXT = "#f2f2f4";

const DAY_MS = 86_400_000;
// Longest gap between two activities that still counts as the same visit to the park
const SESSION_BREAK_S = 3600;
// Step count of every activity, in the same order as bad_apple_activities.json (sorted by frame). Strava's API
// does not expose steps, so these were read off the "Steps" stat in the screenshots in
// public/uncensored-removed. Add a new activity's steps here by hand.
const STEPS = [
  1044, 1030, 1000, 914, 1090, 984, 878, 734, 924, 946, 672, 920, 740, 826, 878, 1020, 1038, 1092,
  974, 1100, 1180, 1158, 1146, 790, 950, 222, 306, 314, 334, 452, 1144, 1118, 1916, 1092, 1064, 1428,
  876, 522, 406, 528, 528, 542, 530, 566, 1102, 1116, 1150, 1142, 1202, 1202, 958, 804, 792, 906,
  202, 154, 130, 282, 408, 530, 536, 600, 598, 752, 760, 622, 764, 902, 934, 816, 1012, 492,
  546, 1094, 1302, 1316, 1350, 1398, 1004, 1154, 1048, 972, 240, 334, 340, 840, 1508, 202, 228, 324,
  384, 1248, 602, 758, 620, 650, 626, 930, 1020, 232, 368, 2068, 1942, 2044, 1972, 2112, 1464, 1890,
  1932, 2528, 2316, 2322, 2102, 2280, 2080, 2322, 1602, 830, 2192, 2462, 2870, 2652, 2582, 1724, 1970, 2080,
  2286, 1994, 818, 842, 888, 824, 1034, 1052, 1216, 1060, 656, 290, 642, 824, 1438, 2016, 1408, 1416,
  576, 968, 1050, 1334, 1082, 1368, 160, 608, 752, 816, 1220, 1048, 1322, 1298, 962, 1434, 1700, 1700,
  1554, 1748, 1696, 1164, 1088, 1188, 1174, 1200, 1158, 474, 864, 862, 566, 1026, 972, 1126, 780, 1408,
  2274, 2352, 978, 1804, 1382, 1468, 656, 900, 550, 916, 790, 886, 1174, 2014, 1226, 646, 806, 1240,
  784, 1124, 446, 542, 1250, 1150, 1102, 896, 508, 772, 1434, 720, 668, 734, 1152, 718, 472, 546,
  1026, 710, 1188, 678, 850, 1352, 1342, 1204, 1252, 1448, 166, 624, 1128, 1260, 1236, 1450, 1492, 1586,
  878, 136, 290, 892, 1056, 1124, 474, 536, 708, 966, 698, 810, 472, 1030, 1010, 632, 1012, 994,
  924, 812, 1160, 1756, 1660, 1368, 1208, 1100, 1052, 920, 238, 40, 616, 708, 398, 450, 814, 722,
  1276, 994, 1214, 1560, 1594, 1378, 1556, 1364, 874, 884, 832, 666, 940, 782, 1014, 748,
];

// The second total under the distance. Time is time at the park, days is days walked.
type Metric = "steps" | "hours" | "minutes" | "days";
const METRIC_OPTIONS: { value: Metric; label: string }[] = [
  { value: "steps", label: "Steps" },
  { value: "hours", label: "Hours" },
  { value: "minutes", label: "Minutes" },
  { value: "days", label: "Days" },
];

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
// Calendar days visible in the weekly chart, and where "now" sits in that window while it scrolls
const CHART_DAYS = 84;
const CHART_ANCHOR = 0.78;
// Frames of smoothing on the chart's scroll position, applied twice
const SCROLL_SMOOTHING = 30;

type Item = {
  frame: number;
  // Bad Apple frames this polyline takes to draw; it completes on `frame`
  gap: number;
  region: Region;
  // Web mercator, 0..1
  points: Coord[];
  cumulative: number[];
  distance: number;
  time: number;
  distanceBefore: number;
  timeBefore: number;
  steps: number;
  stepsBefore: number;
  // Distinct days walked up to and including this activity
  days: number;
  // Activity date as days since 1970, and its week counted from the first activity's Monday
  day: number;
  week: number;
};

type Timeline = {
  items: Item[];
  // Chart "now" for every Bad Apple frame, in days since 1970
  cursor: Float64Array;
  weekBase: number;
  weeks: number;
  // Top of the chart's y axis, km
  yMax: number;
  start: number;
  end: number;
};

type Drawer = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void;

type Scene = {
  timeline: Timeline;
  zoom: number;
  snapshots: Record<string, ImageBitmap>;
  // One per timeline item, already scaled for the card. Empty slots are still loading.
  screenshots: (ImageBitmap | undefined)[];
  opacity: number;
  blend: string;
  metric: Metric;
  scratch: HTMLCanvasElement;
  sans: string;
  mono: string;
};

function mercator([lng, lat]: Coord): Coord {
  const phi = (lat * Math.PI) / 180;
  return [(lng + 180) / 360, (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2];
}

function smooth(src: Float64Array, radius: number) {
  const out = new Float64Array(src.length);
  for (let n = 0; n < src.length; n++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[Math.max(0, Math.min(src.length - 1, n + k))];
    out[n] = sum / (radius * 2 + 1);
  }
  return out;
}

// Time at the park per activity: from the previous activity's end to this one's end, so the walk back to the
// start between frames counts too. A gap longer than SESSION_BREAK_S means I left and came back, so that
// activity starts a new visit and only counts its own duration. Falls back to moving time without timestamps.
function parkTimes(data: FrameActivity[]): number[] {
  const seconds = (s: string) => Date.parse(`${s.replace(" ", "T")}Z`) / 1000;
  const times = data.map((a) => a.time_s);
  const timed = data
    .map((a, i) => ({ i, start: a.start_time ? seconds(a.start_time) : NaN, end: a.end_time ? seconds(a.end_time) : NaN }))
    .filter((t) => Number.isFinite(t.start) && Number.isFinite(t.end))
    .sort((a, b) => a.start - b.start);
  let previousEnd = -Infinity;
  for (const { i, start, end } of timed) {
    const gap = start - previousEnd;
    times[i] = gap >= 0 && gap <= SESSION_BREAK_S ? end - previousEnd : end - start;
    previousEnd = end;
  }
  return times;
}

function buildTimeline(data: FrameActivity[]): Timeline {
  const times = parkTimes(data);
  let distance = 0;
  let time = 0;
  let steps = 0;
  const days = new Set<string>();
  const items = data.map((a, i) => {
    if (a.date) days.add(a.date);
    const path = (polyline.decode(a.polyline) as [number, number][]).map(([lat, lng]): Coord => [lng, lat]);
    const cumulative = [0];
    for (let k = 1; k < path.length; k++) {
      cumulative.push(cumulative[k - 1] + Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]));
    }
    const item: Item = {
      frame: a.frame,
      gap: i > 0 ? a.frame - data[i - 1].frame : INTRO_FRAMES,
      region: regionForPath(path),
      points: path.map(mercator),
      cumulative,
      distance: a.distance_m,
      time: times[i],
      distanceBefore: distance,
      timeBefore: time,
      steps: STEPS[i] ?? 0,
      stepsBefore: steps,
      days: days.size,
      day: a.date ? Math.floor(Date.parse(`${a.date}T00:00:00Z`) / DAY_MS) : 0,
      week: 0,
    };
    distance += a.distance_m;
    time += times[i];
    steps += STEPS[i] ?? 0;
    return item;
  });

  const first = items[0]?.day ?? 0;
  const last = items[items.length - 1]?.day ?? 0;
  // Day 0 was a Thursday
  const weekBase = first - ((first + 3) % 7);
  const weeks = Math.floor((last - weekBase) / 7) + 1;
  const totals = new Float64Array(weeks);
  for (const item of items) {
    item.week = Math.floor((item.day - weekBase) / 7);
    totals[item.week] += item.distance;
  }

  // The date moves from one activity's to the next while the polyline draws, then is smoothed so month-long
  // gaps scroll past instead of jumping
  let cursor = new Float64Array(VIDEO_TOTAL_FRAMES);
  if (items.length > 0) {
    for (let n = 0; n < cursor.length; n++) {
      const { i, progress } = stateAt(items, n);
      const from = items[Math.max(0, i - 1)].day;
      cursor[n] = from + (items[i].day - from) * progress;
    }
    const smoothed = smooth(smooth(cursor, SCROLL_SMOOTHING), SCROLL_SMOOTHING);
    // Delayed a little so the chart trails the activity on screen more than it runs ahead of it
    cursor = smoothed.map((_, n) => smoothed[Math.max(0, n - SCROLL_SMOOTHING)]);
  }

  return {
    items,
    cursor,
    weekBase,
    weeks,
    yMax: Math.max(3, Math.ceil(Math.max(0, ...totals) / 1000 / 3) * 3),
    start: first - 14,
    end: last + 7,
  };
}

// Everything on screen is a function of the Bad Apple frame number alone
function stateAt(items: Item[], n: number) {
  const i = items.findIndex((it) => it.frame >= n);
  if (i === -1) return { i: items.length - 1, progress: 1 };
  return { i, progress: Math.max(0, 1 - (items[i].frame - n) / items[i].gap) };
}

function drawChart(ctx: CanvasRenderingContext2D, scene: Scene, n: number, i: number, progress: number) {
  const { items, cursor, weekBase, weeks, yMax, start, end } = scene.timeline;
  const left = MAP_W + PAD;
  const width = SIDE_W - PAD * 2;
  const top = CHART_Y + 68;
  const bottom = CHART_Y + 178;
  const height = bottom - top;

  const now = cursor[Math.max(0, Math.min(n, cursor.length - 1))];
  const from = Math.max(start, Math.min(end - CHART_DAYS, now - CHART_DAYS * CHART_ANCHOR));
  const xOf = (day: number) => left + ((day - from) / CHART_DAYS) * width;
  const yOf = (meters: number) => bottom - Math.min(1, meters / 1000 / yMax) * height;
  const xNow = xOf(now);

  // Weekly distance as of this frame
  const totals = new Float64Array(weeks);
  for (let k = 0; k < i; k++) totals[items[k].week] += items[k].distance;
  totals[items[i].week] += progress * items[i].distance;
  const total = (w: number) => (w >= 0 && w < weeks ? totals[w] : 0);
  const weekCenter = (w: number) => weekBase + w * 7 + 3.5;

  const date = new Date(Math.floor(now) * DAY_MS);
  ctx.font = `500 18px ${scene.sans}`;
  ctx.letterSpacing = "2px";
  ctx.textAlign = "left";
  ctx.fillStyle = DIM;
  ctx.fillText("KM PER WEEK", left, CHART_Y + 42);
  ctx.textAlign = "right";
  ctx.fillStyle = TEXT;
  ctx.fillText(`${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`, left + width, CHART_Y + 42);

  ctx.font = `400 13px ${scene.mono}`;
  ctx.letterSpacing = "0px";
  for (const fraction of [0, 0.5, 1]) {
    const y = Math.round(bottom - fraction * height);
    ctx.fillStyle = LINE;
    ctx.fillRect(left, y, width, 1);
    if (fraction > 0) {
      ctx.fillStyle = DIM;
      ctx.fillText(String(yMax * fraction), left + width, y - 6);
    }
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top - 14, width, CHART_Y + CHART_H - top + 14);
  ctx.clip();

  // Months
  ctx.font = `500 15px ${scene.sans}`;
  ctx.letterSpacing = "1.6px";
  ctx.textAlign = "left";
  const month = new Date((Math.floor(from) - 31) * DAY_MS);
  month.setUTCDate(1);
  for (; month.getTime() / DAY_MS < from + CHART_DAYS; month.setUTCMonth(month.getUTCMonth() + 1)) {
    const x = Math.round(xOf(month.getTime() / DAY_MS));
    const january = month.getUTCMonth() === 0;
    ctx.fillStyle = LINE;
    ctx.fillRect(x, top, 1, height + 8);
    ctx.fillStyle = january ? TEXT : DIM;
    ctx.fillText(january ? String(month.getUTCFullYear()) : MONTHS[month.getUTCMonth()], x + 7, bottom + 30);
  }

  // Line and fill, revealed up to now
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top - 12, Math.max(0, xNow - left), height + 24);
  ctx.clip();
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(xOf(weekCenter(-1)), bottom);
    for (let w = 0; w <= weeks; w++) ctx.lineTo(xOf(weekCenter(w)), yOf(total(w)));
  };
  const fill = ctx.createLinearGradient(0, top, 0, bottom);
  fill.addColorStop(0, "rgba(252, 82, 0, 0.38)");
  fill.addColorStop(1, "rgba(252, 82, 0, 0)");
  trace();
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  trace();
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.strokeStyle = ORANGE;
  ctx.stroke();
  ctx.restore();

  // One dot per week, growing in as now passes it
  ctx.lineWidth = 2;
  for (let w = 0; w < weeks; w++) {
    const grow = Math.min(1, (now - weekCenter(w)) / 2);
    if (grow <= 0) break;
    ctx.beginPath();
    ctx.arc(xOf(weekCenter(w)), yOf(total(w)), 4 * grow, 0, Math.PI * 2);
    ctx.fillStyle = PANEL;
    ctx.fill();
    ctx.strokeStyle = ORANGE;
    ctx.stroke();
  }

  // Now
  const position = (now - weekCenter(0)) / 7;
  const week = Math.floor(position);
  const value = total(week) + (total(week + 1) - total(week)) * (position - week);
  const yNow = yOf(value);
  ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
  ctx.fillRect(Math.round(xNow), yNow, 1, bottom - yNow);
  ctx.beginPath();
  ctx.arc(xNow, yNow, 13, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(252, 82, 0, 0.25)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(xNow, yNow, 6, 0, Math.PI * 2);
  ctx.fillStyle = ORANGE;
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.stroke();

  // Fade what scrolls off the left
  const fade = ctx.createLinearGradient(left, 0, left + 20, 0);
  fade.addColorStop(0, PANEL);
  fade.addColorStop(1, "rgba(11, 11, 13, 0)");
  ctx.fillStyle = fade;
  ctx.fillRect(left, top - 14, 20, CHART_H);
  ctx.restore();
}

function renderFrame(ctx: CanvasRenderingContext2D, n: number, scene: Scene, apple: Drawer | null) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  const { items } = scene.timeline;
  if (items.length === 0) return;

  const { i, progress } = stateAt(items, n);
  const item = items[i];

  // Map panel
  const scale = 512 * 2 ** scene.zoom;
  const center = mercator(item.region.center);
  const toPx = (m: Coord): Coord => [(m[0] - center[0]) * scale + MAP_W / 2, (m[1] - center[1]) * scale + H / 2];

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, MAP_W, H);
  ctx.clip();

  const snapshot = scene.snapshots[item.region.id];
  if (snapshot) ctx.drawImage(snapshot, 0, 0, MAP_W, H);

  if (apple && scene.opacity > 0) {
    const { scratch } = scene;
    const sctx = scratch.getContext("2d", { willReadFrequently: true });
    if (sctx) {
      sctx.clearRect(0, 0, scratch.width, scratch.height);
      apple(sctx, 0, 0, scratch.width, scratch.height);
      applyBlendMode(sctx, scratch.width, scratch.height, scene.blend);
      const [x0, y0] = toPx(mercator(item.region.overlay[0]));
      const [x1, y1] = toPx(mercator(item.region.overlay[2]));
      ctx.globalAlpha = scene.opacity;
      ctx.drawImage(scratch, x0, y0, x1 - x0, y1 - y0);
      ctx.globalAlpha = 1;
    }
  }

  const { points, cumulative } = item;
  if (points.length > 0) {
    const target = cumulative[cumulative.length - 1] * progress;
    let head = toPx(points[0]);
    ctx.beginPath();
    ctx.moveTo(head[0], head[1]);
    for (let k = 1; k < points.length; k++) {
      const next = toPx(points[k]);
      if (cumulative[k] >= target) {
        const seg = cumulative[k] - cumulative[k - 1];
        const t = seg > 0 ? (target - cumulative[k - 1]) / seg : 1;
        head = [head[0] + (next[0] - head[0]) * t, head[1] + (next[1] - head[1]) * t];
        ctx.lineTo(head[0], head[1]);
        break;
      }
      head = next;
      ctx.lineTo(head[0], head[1]);
    }
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgb(255, 140, 0)";
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(head[0], head[1], 7, 0, Math.PI * 2);
    ctx.fillStyle = "#ffa000";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
  }
  ctx.restore();

  // Totals
  const distance = item.distanceBefore + progress * item.distance;
  const time = item.timeBefore + progress * item.time;
  const metric = {
    steps: Math.round(item.stepsBefore + progress * item.steps).toLocaleString("en-US"),
    hours: (time / 3600).toFixed(1),
    minutes: Math.floor(time / 60).toLocaleString("en-US"),
    days: String(item.days),
  }[scene.metric];
  const left = MAP_W + PAD;
  const right = W - PAD;

  ctx.fillStyle = PANEL;
  ctx.fillRect(MAP_W, 0, SIDE_W, H);
  ctx.fillStyle = ORANGE;
  ctx.fillRect(MAP_W, 0, SIDE_W, HERO_H);

  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.font = `600 18px ${scene.sans}`;
  ctx.letterSpacing = "2px";
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.fillText("DISTANCE", left, 46);
  ctx.fillText(scene.metric.toUpperCase(), left, 216);

  ctx.fillStyle = "#fff";
  ctx.font = `600 96px ${scene.mono}`;
  ctx.letterSpacing = "-2px";
  const km = (distance / 1000).toFixed(2);
  ctx.fillText(km, left - 4, 140);
  const kmWidth = ctx.measureText(km).width;
  ctx.font = `600 30px ${scene.sans}`;
  ctx.letterSpacing = "1px";
  ctx.fillText("KM", left + kmWidth + 8, 140);

  ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
  ctx.fillRect(left, 172, SIDE_W - PAD * 2, 2);

  ctx.fillStyle = "#fff";
  ctx.font = `600 44px ${scene.mono}`;
  ctx.letterSpacing = "-1px";
  ctx.textAlign = "right";
  ctx.fillText(metric, right, 224);
  ctx.textAlign = "left";

  drawChart(ctx, scene, n, i, progress);

  // Screenshot card
  const cardX = MAP_W + CARD_MARGIN;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(cardX, CARD_Y, CARD_W, CARD_H, 16);
  ctx.clip();
  ctx.fillStyle = "#141414";
  ctx.fillRect(cardX, CARD_Y, CARD_W, CARD_H);
  // The screenshot of the activity being drawn, from the moment its polyline starts until the next one starts
  const screenshot = scene.screenshots[i];
  if (screenshot) {
    ctx.drawImage(
      screenshot,
      cardX + Math.round((CARD_W - screenshot.width) / 2),
      CARD_Y + Math.round((CARD_H - screenshot.height) / 2),
    );
  }
  ctx.restore();
  ctx.beginPath();
  ctx.roundRect(cardX + 0.5, CARD_Y + 0.5, CARD_W - 1, CARD_H - 1, 16);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
  ctx.stroke();
}

const videoDrawer = (video: HTMLVideoElement | null): Drawer | null =>
  video && video.readyState >= 2 ? (ctx, x, y, w, h) => ctx.drawImage(video, x, y, w, h) : null;

export default function FinalMode({
  frameData,
  sidebar,
}: {
  frameData: FrameActivity[] | null;
  sidebar: HTMLElement | null;
}) {
  const [zoom, setZoom] = usePersistedState("final.zoom", 18.3);
  const [theme, setTheme] = usePersistedState("final.theme", "dark-matter");
  const [labels, setLabels] = usePersistedState("final.labels", false);
  const [opacity, setOpacity] = usePersistedState("final.opacity", 0.5);
  const [blend, setBlend] = usePersistedState("final.blend", "normal");
  const [metric, setMetric] = usePersistedState<Metric>("final.metric", "steps");
  const [frame, setFrame] = useState(-INTRO_FRAMES);
  const [playing, setPlaying] = useState(false);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timeline = useMemo(() => buildTimeline(frameData ?? []), [frameData]);
  const themeUrl = MAP_THEMES.find((t) => t.id === theme)?.url ?? MAP_THEMES[0].url;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleRef = useRef(themeUrl);
  const appleRef = useRef<HTMLVideoElement | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const fontsRef = useRef({ sans: "sans-serif", mono: "monospace" });
  const snapshotsRef = useRef<{ zoom: number; images: Record<string, ImageBitmap> }>({ zoom, images: {} });
  const snapshotsReadyRef = useRef<Promise<void>>(Promise.resolve());
  const screenshotsRef = useRef<(ImageBitmap | undefined)[]>([]);
  const screenshotsReadyRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const frameRef = useRef(-INTRO_FRAMES);
  // Preview clock for the intro, where the videos are held and cannot keep time
  const introClockRef = useRef({ frame: -INTRO_FRAMES, time: 0 });
  const videosRunningRef = useRef(false);
  const playingRef = useRef(false);
  playingRef.current = playing;
  const exportingRef = useRef(false);
  const cancelRef = useRef(false);
  const settingsRef = useRef({ opacity, blend, metric });
  settingsRef.current = { opacity, blend, metric };
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

  const scene = useCallback((): Scene => {
    if (!scratchRef.current) {
      scratchRef.current = document.createElement("canvas");
      scratchRef.current.width = 480;
      scratchRef.current.height = 360;
    }
    return {
      timeline: timelineRef.current,
      zoom: snapshotsRef.current.zoom,
      snapshots: snapshotsRef.current.images,
      screenshots: screenshotsRef.current,
      scratch: scratchRef.current,
      ...settingsRef.current,
      ...fontsRef.current,
    };
  }, []);

  useEffect(() => {
    const root = getComputedStyle(document.documentElement);
    const sans = root.getPropertyValue("--font-geist-sans").trim() || "sans-serif";
    const mono = root.getPropertyValue("--font-geist-mono").trim() || "monospace";
    Promise.all([document.fonts.load(`500 13px ${sans}`), document.fonts.load(`500 50px ${mono}`)])
      .catch(() => {})
      .then(() => {
        fontsRef.current = { sans, mono };
      });
  }, []);

  useEffect(() => {
    if (!mapDivRef.current) return;
    const map = new maplibregl.Map({
      container: mapDivRef.current,
      style: styleRef.current,
      center: REGIONS[0].center,
      zoom: 18,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      pixelRatio: 1,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    mapRef.current = map;
    return () => {
      generationRef.current++;
      mapRef.current = null;
      map.remove();
    };
  }, []);

  // The map only changes with region and settings, so it is rendered once per region and reused for every frame
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const generation = ++generationRef.current;
    snapshotsReadyRef.current = (async () => {
      if (styleRef.current !== themeUrl) {
        styleRef.current = themeUrl;
        map.setStyle(themeUrl);
      }
      await idle(map);
      if (generation !== generationRef.current) return;
      setLabelVisibility(map, labels);
      const images: Record<string, ImageBitmap> = {};
      for (const region of REGIONS) {
        map.jumpTo({ center: region.center, zoom });
        await idle(map);
        if (generation !== generationRef.current) return;
        images[region.id] = await createImageBitmap(map.getCanvas());
      }
      snapshotsRef.current = { zoom, images };
    })();
  }, [zoom, themeUrl, labels]);

  // Screenshots are decoded once at card size; at full size all of them would not fit in memory
  useEffect(() => {
    let cancelled = false;
    const images: (ImageBitmap | undefined)[] = [];
    screenshotsRef.current = images;
    const ready = Promise.all(
      timeline.items.map(async (item, i) => {
        const response = await fetch(screenshotSrc(item.frame));
        if (!response.ok) throw new Error(`Missing screenshot for frame ${item.frame}.`);
        const full = await createImageBitmap(await response.blob());
        const scaled = await createImageBitmap(full, {
          resizeWidth: Math.max(1, Math.round(full.width * SCREENSHOT_SCALE)),
          resizeHeight: Math.max(1, Math.round(full.height * SCREENSHOT_SCALE)),
          resizeQuality: "high",
        });
        full.close();
        if (cancelled) scaled.close();
        else images[i] = scaled;
      }),
    ).then(() => {});
    // The preview just leaves the card empty; export awaits this and reports the error
    ready.catch(() => {});
    screenshotsReadyRef.current = ready;
    return () => {
      cancelled = true;
      for (const image of images) image?.close();
    };
  }, [timeline]);

  const setVideosRunning = useCallback((running: boolean) => {
    videosRunningRef.current = running;
    const video = appleRef.current;
    if (!video) return;
    if (running) video.play().catch(() => {});
    else video.pause();
  }, []);

  const seek = useCallback(
    (n: number) => {
      frameRef.current = n;
      setFrame(n);
      introClockRef.current = { frame: n, time: performance.now() };
      const t = n < 0 ? 0 : (n + 0.5) / VIDEO_FPS;
      if (appleRef.current) appleRef.current.currentTime = t;
      if (playingRef.current) setVideosRunning(n >= 0);
    },
    [setVideosRunning],
  );

  const togglePlaying = useCallback(() => {
    if (exportingRef.current) return;
    if (!playingRef.current && frameRef.current >= VIDEO_TOTAL_FRAMES - 1) seek(-INTRO_FRAMES);
    setPlaying((p) => !p);
  }, [seek]);

  useEffect(() => {
    introClockRef.current = { frame: frameRef.current, time: performance.now() };
    setVideosRunning(playing && frameRef.current >= 0);
  }, [playing, setVideosRunning]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      e.preventDefault();
      togglePlaying();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlaying]);

  // Preview: the Bad Apple video is the clock. Export does not use this loop.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (exportingRef.current) return;
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;
      const apple = appleRef.current;
      if (playingRef.current && apple) {
        let n: number;
        if (videosRunningRef.current) {
          n = Math.min(VIDEO_TOTAL_FRAMES - 1, Math.floor(apple.currentTime * VIDEO_FPS));
          if (apple.ended) setPlaying(false);
        } else {
          const clock = introClockRef.current;
          n = Math.min(0, clock.frame + Math.floor(((performance.now() - clock.time) / 1000) * VIDEO_FPS));
          if (n >= 0) setVideosRunning(true);
        }
        if (n !== frameRef.current) {
          frameRef.current = n;
          setFrame(n);
        }
      }
      renderFrame(ctx, frameRef.current, scene(), videoDrawer(apple));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [scene, setVideosRunning]);

  // Renders every frame from decoded video frames in order, so the result does not depend on playback speed
  const exportVideo = useCallback(async () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || exportingRef.current) return;

    setPlaying(false);
    setError(null);
    setExportProgress(0);
    exportingRef.current = true;
    cancelRef.current = false;

    const appleInput = new Input({ source: new UrlSource(APPLE_SRC), formats: ALL_FORMATS });
    try {
      await snapshotsReadyRef.current;
      await screenshotsReadyRef.current;

      const appleTrack = await appleInput.getPrimaryVideoTrack();
      const audioTrack = await appleInput.getPrimaryAudioTrack();
      if (!appleTrack) throw new Error("Could not read the source video.");

      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: "in-memory" }),
        target: new BufferTarget(),
      });
      const videoSource = new CanvasSource(canvas, { codec: "avc", bitrate: BITRATE });
      output.addVideoTrack(videoSource, { frameRate: VIDEO_FPS });
      const audioSource = audioTrack ? new AudioSampleSource({ codec: "aac", bitrate: AUDIO_BITRATE }) : null;
      if (audioSource) output.addAudioTrack(audioSource);
      await output.start();

      // The audio is re-encoded with real silence in front, so nothing depends on players honouring a start offset
      const writeAudio = async () => {
        if (!audioTrack || !audioSource) return;
        let intro = INTRO_FRAMES / VIDEO_FPS;
        let first = true;
        for await (const sample of new AudioSampleSink(audioTrack).samples()) {
          try {
            if (cancelRef.current) break;
            if (first) {
              first = false;
              intro -= AAC_PRIMING_SAMPLES / sample.sampleRate;
              const frames = Math.round((intro + sample.timestamp) * sample.sampleRate);
              if (frames > 0) {
                const silence = new AudioSample({
                  data: new Float32Array(frames * sample.numberOfChannels),
                  format: "f32-planar",
                  numberOfChannels: sample.numberOfChannels,
                  sampleRate: sample.sampleRate,
                  timestamp: 0,
                });
                await audioSource.add(silence);
                silence.close();
              }
            }
            sample.setTimestamp(sample.timestamp + intro);
            await audioSource.add(sample);
          } finally {
            sample.close();
          }
        }
        audioSource.close();
      };

      const renderVideo = async () => {
        const appleFrames = new VideoSampleSink(appleTrack).samples();
        let apple: VideoSample | null = null;
        try {
          for (let n = -INTRO_FRAMES; n < VIDEO_TOTAL_FRAMES && !cancelRef.current; n++) {
            // Source frame 0 is held through the intro, then the source advances one frame per output frame
            if (!apple || n > 0) {
              const nextApple = await appleFrames.next();
              apple?.close();
              apple = nextApple.done ? null : nextApple.value;
              if (!apple) throw new Error(`Source video ended early at frame ${Math.max(0, n)}.`);
            }
            const appleFrame = apple;
            renderFrame(ctx, n, scene(), (c, x, y, w, h) => appleFrame.draw(c, x, y, w, h));
            const out = n + INTRO_FRAMES;
            await videoSource.add(out / VIDEO_FPS, 1 / VIDEO_FPS);
            if (out % 15 === 0) {
              frameRef.current = n;
              setFrame(n);
              setExportProgress(out / OUTPUT_FRAMES);
            }
          }
        } finally {
          apple?.close();
          await appleFrames.return();
        }
        videoSource.close();
      };

      await Promise.all([renderVideo(), writeAudio()]);
      if (cancelRef.current) {
        await output.cancel();
      } else {
        await output.finalize();
        const url = URL.createObjectURL(new Blob([output.target.buffer!], { type: "video/mp4" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = OUTPUT_NAME;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (e) {
      // Stops whichever of the video and audio writers is still running
      cancelRef.current = true;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      appleInput.dispose();
      exportingRef.current = false;
      setExportProgress(null);
      seek(frameRef.current);
    }
  }, [scene, seek]);

  const exporting = exportProgress !== null;

  return (
    <>
      <div className="flex-1 min-w-0 relative bg-black">
        <canvas ref={canvasRef} width={W} height={H} className="absolute inset-0 w-full h-full object-contain" />
        <div
          ref={mapDivRef}
          className="fixed top-0 left-0 -z-10 opacity-0 pointer-events-none"
          style={{ width: MAP_W, height: H }}
        />
        <video ref={appleRef} src={APPLE_SRC} preload="auto" playsInline className="hidden" />
      </div>

      {sidebar &&
        createPortal(
          <>
            <Section>
              <SliderRow
                label="Frame"
                display={String(frame)}
                min={-INTRO_FRAMES}
                max={VIDEO_TOTAL_FRAMES - 1}
                step={1}
                value={frame}
                onChange={(n) => {
                  if (!exporting) seek(n);
                }}
              />
              <div className="flex gap-1.5 py-1">
                <IconButton
                  icon={playing ? "pause" : "play"}
                  label={playing ? "Pause" : "Play"}
                  primary
                  onClick={togglePlaying}
                />
                <IconButton
                  icon="start"
                  label="Restart"
                  onClick={() => {
                    if (exporting) return;
                    setPlaying(false);
                    seek(-INTRO_FRAMES);
                  }}
                />
              </div>
            </Section>

            <Section title="Map">
              <SliderRow
                label="Zoom"
                display={zoom.toFixed(2)}
                min={16}
                max={20}
                step={0.01}
                value={zoom}
                onChange={setZoom}
              />
              <SelectRow
                label="Theme"
                value={theme}
                onChange={setTheme}
                options={MAP_THEMES.map((t) => ({ value: t.id, label: t.label }))}
              />
              <ToggleRow label="Labels" checked={labels} onChange={setLabels} />
            </Section>

            <Section title="Video">
              <SliderRow
                label="Opacity"
                display={opacity.toFixed(2)}
                min={0}
                max={1}
                step={0.01}
                value={opacity}
                onChange={setOpacity}
              />
              <SegRow label="Blend" value={blend} onChange={setBlend} options={BLEND_OPTIONS} />
            </Section>

            <Section title="Totals">
              <SegRow label="Metric" value={metric} onChange={setMetric} options={METRIC_OPTIONS} />
            </Section>

            <Section title="Export">
              {exporting ? (
                <>
                  <ProgressRow label="Rendering" display={`${Math.round(exportProgress * 100)}%`} fraction={exportProgress} />
                  <div className="flex min-h-[26px] items-center">
                    <TextButton onClick={() => (cancelRef.current = true)}>Cancel</TextButton>
                  </div>
                </>
              ) : (
                <button
                  onClick={exportVideo}
                  className="mt-1 py-1.5 rounded bg-s-accent text-white font-medium"
                >
                  Export MP4
                </button>
              )}
              {error ? <div className="mt-1 text-[11px] text-red-400">{error}</div> : null}
            </Section>
          </>,
          sidebar,
        )}
    </>
  );
}
