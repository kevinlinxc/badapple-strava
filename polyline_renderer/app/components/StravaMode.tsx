"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output } from "mediabunny";
import { type FrameActivity, usePersistedState, VIDEO_FPS, VIDEO_TOTAL_FRAMES } from "../lib/shared";
import {
  buildTimeline,
  CHART_ANCHOR,
  CHART_DAYS,
  DAY_MS,
  DIM,
  INTRO_FRAMES,
  LINE,
  MONTHS,
  ORANGE,
  PANEL,
  stateAt,
  TEXT,
  type Timeline,
} from "./FinalMode";
import { IconButton, ProgressRow, Section, SegRow, SliderRow, TextButton, ToggleRow } from "./controls";

// Full frame weekly distance chart from final mode, with the share of Bad Apple done
const W = 1920;
const H = 1080;
const OUTPUT_NAME = "badapple-strava-chart.mp4";
const BITRATE = 12_000_000;
// Frames the last moment is held at the end of the paced timelines
const HOLD_FRAMES = 60;

type Layout = "scrolling" | "journey";
const LAYOUT_OPTIONS: { value: Layout; label: string }[] = [
  { value: "scrolling", label: "Scrolling" },
  { value: "journey", label: "Whole journey" },
];

// "apple" follows Bad Apple's timing as in final mode. "equal" gives every week the same frames; "min" keeps a
// week's Bad Apple time but stretches it to at least the minimum. Both move through a week at a steady pace.
type Pacing = "apple" | "equal" | "min";
const PACING_OPTIONS: { value: Pacing; label: string }[] = [
  { value: "apple", label: "Bad Apple" },
  { value: "equal", label: "Equal" },
  { value: "min", label: "Minimum" },
];

// Walks the completion percent is out of: every 15th frame of Bad Apple as planned, or the 286 actually walked
type Goal = "438" | "286";
const GOAL_OPTIONS: { value: Goal; label: string; title: string }[] = [
  { value: "438", label: "438", title: "6570 / 15" },
  { value: "286", label: "286", title: "Walks in the final video" },
];

const SPEED_OPTIONS = [
  { value: "1", label: "1×" },
  { value: "4", label: "4×" },
  { value: "16", label: "16×" },
];

type State = {
  // Weekly distance so far, meters
  totals: Float64Array;
  // Chart date, days since 1970
  now: number;
  distance: number;
  // Walks done, fractional while one draws
  walks: number;
};

type Pace = {
  first: number;
  last: number;
  // Output frame where each week starts; null when following Bad Apple
  weekStarts: number[] | null;
  stateAt: (frame: number) => State;
};

// Which totals are drawn over the chart
type Stats = { activities: boolean; km: boolean; percent: boolean; days: boolean };

type Scene = { timeline: Timeline; layout: Layout; goal: number; stats: Stats; sans: string; mono: string };

// Same as final mode, from a Bad Apple frame
function appleState(timeline: Timeline, n: number): State {
  const { items, weeks } = timeline;
  const { i, progress } = stateAt(items, n);
  const totals = new Float64Array(weeks);
  for (let k = 0; k < i; k++) totals[items[k].week] += items[k].distance;
  totals[items[i].week] += progress * items[i].distance;
  return {
    totals,
    now: timeline.cursor[Math.max(0, Math.min(n, timeline.cursor.length - 1))],
    distance: items[i].distanceBefore + progress * items[i].distance,
    walks: i + progress,
  };
}

// From a chart date alone. Each walk grows in over its own day.
function dayState(timeline: Timeline, now: number): State {
  const { items, weeks } = timeline;
  const totals = new Float64Array(weeks);
  let distance = 0;
  let walks = 0;
  for (const item of items) {
    const f = Math.max(0, Math.min(1, now - item.day));
    if (f <= 0) break;
    totals[item.week] += f * item.distance;
    distance += f * item.distance;
    walks += f;
  }
  return { totals, now, distance, walks };
}

function buildPace(timeline: Timeline, pacing: Pacing, perWeek: number): Pace {
  if (pacing === "apple" || timeline.items.length === 0) {
    return {
      first: -INTRO_FRAMES,
      last: VIDEO_TOTAL_FRAMES - 1,
      weekStarts: null,
      stateAt: (n) => appleState(timeline, n),
    };
  }
  const { weeks, weekBase, items } = timeline;
  const natural = new Float64Array(weeks);
  for (const day of timeline.cursor) natural[Math.max(0, Math.min(weeks - 1, Math.floor((day - weekBase) / 7)))]++;
  const durations = Array.from(natural, (n) => (pacing === "equal" ? perWeek : Math.max(perWeek, n)));
  const weekStarts = [0];
  for (const d of durations) weekStarts.push(weekStarts[weekStarts.length - 1] + d);
  // Ends the day after the last walk, partway through the last week
  const endDay = items[items.length - 1].day + 1;
  const endWeek = Math.min(weeks - 1, Math.floor((endDay - weekBase) / 7));
  const length = weekStarts[endWeek] + ((endDay - weekBase) / 7 - endWeek) * durations[endWeek];
  const dayAt = (k: number) => {
    if (k >= length) return endDay;
    let w = 0;
    while (weekStarts[w + 1] <= k) w++;
    return weekBase + 7 * (w + (k - weekStarts[w]) / durations[w]);
  };
  return {
    first: 0,
    last: Math.ceil(length) + HOLD_FRAMES - 1,
    weekStarts: weekStarts.map(Math.round),
    stateAt: (k) => dayState(timeline, dayAt(k)),
  };
}

type ChartOptions = {
  left: number;
  top: number;
  width: number;
  height: number;
  from: number;
  span: number;
  // Scale of every mark relative to final mode's chart
  s: number;
  dot: number;
  // Fade what scrolls off the left
  fade?: boolean;
  // Room right of the plot for the last month label
  overflow?: number;
};

// Final mode's drawChart, with its size and date range as parameters
function drawWeekly(ctx: CanvasRenderingContext2D, scene: Scene, state: State, o: ChartOptions) {
  const { weekBase, weeks, yMax } = scene.timeline;
  const { left, top, width, height, from, span, s } = o;
  const { totals, now } = state;
  const bottom = top + height;
  const hairline = Math.max(1, Math.round(s / 1.5));
  const xOf = (day: number) => left + ((day - from) / span) * width;
  const yOf = (meters: number) => bottom - Math.min(1, meters / 1000 / yMax) * height;
  const total = (w: number) => (w >= 0 && w < weeks ? totals[w] : 0);
  const weekCenter = (w: number) => weekBase + w * 7 + 3.5;
  const xNow = xOf(now);

  ctx.font = `400 ${13 * s}px ${scene.mono}`;
  ctx.letterSpacing = "0px";
  ctx.textAlign = "right";
  for (const fraction of [0, 1 / 3, 2 / 3, 1]) {
    const y = Math.round(bottom - fraction * height);
    ctx.fillStyle = LINE;
    ctx.fillRect(left, y, width, hairline);
    if (fraction > 0) {
      ctx.fillStyle = DIM;
      ctx.fillText(String(Math.round(yMax * fraction)), left + width, y - 6 * s);
    }
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top - 14 * s, width + (o.overflow ?? 0), height + 60 * s);
  ctx.clip();

  // Months
  ctx.font = `500 ${15 * s}px ${scene.sans}`;
  ctx.letterSpacing = `${1.6 * s}px`;
  ctx.textAlign = "left";
  const month = new Date((Math.floor(from) - 31) * DAY_MS);
  month.setUTCDate(1);
  for (; month.getTime() / DAY_MS < from + span; month.setUTCMonth(month.getUTCMonth() + 1)) {
    const x = Math.round(xOf(month.getTime() / DAY_MS));
    const january = month.getUTCMonth() === 0;
    ctx.fillStyle = LINE;
    ctx.fillRect(x, top, hairline, height + 8 * s);
    ctx.fillStyle = january ? TEXT : DIM;
    ctx.fillText(january ? String(month.getUTCFullYear()) : MONTHS[month.getUTCMonth()], x + 7 * s, bottom + 30 * s);
  }

  // Line and fill, revealed up to now
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top - 12 * s, Math.max(0, xNow - left), height + 24 * s);
  ctx.clip();
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(xOf(weekCenter(-1)), bottom);
    for (let w = 0; w < weeks; w++) ctx.lineTo(xOf(weekCenter(w)), yOf(total(w)));
  };
  const fill = ctx.createLinearGradient(0, top, 0, bottom);
  fill.addColorStop(0, "rgba(252, 82, 0, 0.38)");
  fill.addColorStop(1, "rgba(252, 82, 0, 0)");
  trace();
  ctx.lineTo(xOf(weekCenter(weeks - 1)), bottom);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  trace();
  ctx.lineWidth = 3 * s;
  ctx.lineJoin = "round";
  ctx.strokeStyle = ORANGE;
  ctx.stroke();
  ctx.restore();

  // One dot per week, growing in as now passes it
  ctx.lineWidth = 2 * s;
  for (let w = 0; w < weeks; w++) {
    const grow = Math.min(1, (now - weekCenter(w)) / 2);
    if (grow <= 0) break;
    ctx.beginPath();
    ctx.arc(xOf(weekCenter(w)), yOf(total(w)), o.dot * s * grow, 0, Math.PI * 2);
    ctx.fillStyle = PANEL;
    ctx.fill();
    ctx.strokeStyle = ORANGE;
    ctx.stroke();
  }

  // Now, which stays on the last week's dot once it is passed
  const position = Math.min(weeks - 1, (now - weekCenter(0)) / 7);
  const week = Math.floor(position);
  const yNow = yOf(total(week) + (total(week + 1) - total(week)) * (position - week));
  const xMark = Math.min(xNow, xOf(weekCenter(weeks - 1)));
  ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
  ctx.fillRect(Math.round(xMark), yNow, hairline, bottom - yNow);
  ctx.beginPath();
  ctx.arc(xMark, yNow, 13 * s, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(252, 82, 0, 0.25)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(xMark, yNow, 6 * s, 0, Math.PI * 2);
  ctx.fillStyle = ORANGE;
  ctx.fill();
  ctx.lineWidth = 2 * s;
  ctx.strokeStyle = "#fff";
  ctx.stroke();

  if (o.fade) {
    const fade = ctx.createLinearGradient(left, 0, left + 40 * s, 0);
    fade.addColorStop(0, PANEL);
    fade.addColorStop(1, "rgba(11, 11, 13, 0)");
    ctx.fillStyle = fade;
    ctx.fillRect(left, top - 14 * s, 40 * s, height + 60 * s);
  }
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, scene: Scene, text: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "left") {
  ctx.font = `500 ${size}px ${scene.sans}`;
  ctx.letterSpacing = `${size * 0.12}px`;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  return ctx.measureText(text).width;
}

// Days from the first activity to the chart's date
const daysElapsed = (scene: Scene, state: State) =>
  String(Math.max(0, Math.floor(state.now - (scene.timeline.items[0]?.day ?? state.now))));

// Returns the width drawn
function figure(ctx: CanvasRenderingContext2D, scene: Scene, text: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "left", weight = 600) {
  ctx.font = `${weight} ${size}px ${scene.mono}`;
  ctx.letterSpacing = `${-size * 0.02}px`;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  return ctx.measureText(text).width;
}

// A unit after a big figure, like "%" or "KM"
function unit(ctx: CanvasRenderingContext2D, scene: Scene, text: string, x: number, y: number, size: number, color: string) {
  ctx.font = `600 ${size}px ${scene.sans}`;
  ctx.letterSpacing = "1px";
  ctx.textAlign = "left";
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  return ctx.measureText(text).width;
}

const monthLabel = (day: number) => {
  const date = new Date(Math.floor(day) * DAY_MS);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

// The final mode chart's window, stretched across the frame
function renderScrolling(ctx: CanvasRenderingContext2D, scene: Scene, state: State, pct: number) {
  const { start, end } = scene.timeline;
  const left = 96;
  const right = W - 96;
  label(ctx, scene, "KM PER WEEK", left, 108, 26, DIM);
  figure(ctx, scene, monthLabel(state.now), left - 4, 186, 64, TEXT, "left", 500);

  // Totals are laid out from the right edge inwards
  let x = right;
  const gap = 96;
  if (scene.stats.percent) {
    label(ctx, scene, "BAD APPLE COMPLETE", x, 108, 26, DIM, "right");
    ctx.font = `600 56px ${scene.sans}`;
    const percentWidth = ctx.measureText("%").width;
    const width = figure(ctx, scene, (pct * 100).toFixed(1), x - percentWidth - 8, 214, 132, ORANGE, "right");
    unit(ctx, scene, "%", x - percentWidth, 214, 56, ORANGE);
    x -= width + percentWidth + 8 + gap;
  }
  if (scene.stats.km) {
    label(ctx, scene, "DISTANCE", x, 108, 26, DIM, "right");
    ctx.font = `600 24px ${scene.sans}`;
    const unitWidth = ctx.measureText("KM").width;
    const width = figure(ctx, scene, (state.distance / 1000).toFixed(2), x - unitWidth - 10, 186, 64, TEXT, "right", 500);
    unit(ctx, scene, "KM", x - unitWidth, 186, 24, TEXT);
    x -= width + unitWidth + 10 + gap;
  }
  if (scene.stats.activities) {
    const labelWidth = label(ctx, scene, "ACTIVITIES", x, 108, 26, DIM, "right");
    const width = figure(ctx, scene, String(Math.floor(state.walks + 1e-9)), x, 186, 64, TEXT, "right", 500);
    x -= Math.max(labelWidth, width) + gap;
  }
  if (scene.stats.days) {
    label(ctx, scene, "DAYS", x, 108, 26, DIM, "right");
    figure(ctx, scene, daysElapsed(scene, state), x, 186, 64, TEXT, "right", 500);
  }

  const from = Math.max(start, Math.min(end - CHART_DAYS, state.now - CHART_DAYS * CHART_ANCHOR));
  drawWeekly(ctx, scene, state, { left, top: 300, width: right - left, height: 600, from, span: CHART_DAYS, s: 2.4, dot: 3.6, fade: true });

  if (scene.stats.percent) {
    ctx.fillStyle = "#1a1a1f";
    ctx.fillRect(0, H - 10, W, 10);
    ctx.fillStyle = ORANGE;
    ctx.fillRect(0, H - 10, W * pct, 10);
  }
}

// Every week of the project on one axis, under final mode's orange totals block
function renderJourney(ctx: CanvasRenderingContext2D, scene: Scene, state: State, pct: number) {
  const { start, end } = scene.timeline;
  const heroW = 640;
  const pad = 64;
  // Without the percent block, the distance moves to the left edge
  let x = 96;
  if (scene.stats.percent) {
    ctx.fillStyle = ORANGE;
    ctx.fillRect(0, 0, heroW, 270);
    label(ctx, scene, "COMPLETE", pad, 62, 22, "rgba(255, 255, 255, 0.8)");
    const pctWidth = figure(ctx, scene, (pct * 100).toFixed(1), pad - 6, 196, 150, "#fff");
    unit(ctx, scene, "%", pad + pctWidth + 4, 196, 54, "#fff");
    ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
    ctx.fillRect(pad, 222, heroW - pad * 2, 3);
    ctx.fillStyle = "#fff";
    ctx.fillRect(pad, 222, (heroW - pad * 2) * pct, 3);
    x = heroW + 72;
  }
  if (scene.stats.km) {
    label(ctx, scene, "DISTANCE", x, 62, 22, DIM);
    const kmWidth = figure(ctx, scene, (state.distance / 1000).toFixed(2), x - 4, 160, 92, TEXT);
    unit(ctx, scene, "KM", x + kmWidth + 10, 160, 30, TEXT);
  }
  // Counts are laid out from the right edge inwards
  let right = W - 96;
  if (scene.stats.activities) {
    const labelWidth = label(ctx, scene, "ACTIVITIES", right, 62, 22, DIM, "right");
    const width = figure(ctx, scene, String(Math.floor(state.walks + 1e-9)), right, 160, 92, TEXT, "right");
    right -= Math.max(labelWidth, width) + 96;
  }
  if (scene.stats.days) {
    label(ctx, scene, "DAYS", right, 62, 22, DIM, "right");
    figure(ctx, scene, daysElapsed(scene, state), right, 160, 92, TEXT, "right");
  }

  label(ctx, scene, "KM PER WEEK", 96, 378, 24, DIM);
  label(ctx, scene, monthLabel(state.now), W - 96, 378, 24, TEXT, "right");
  drawWeekly(ctx, scene, state, { left: 96, top: 430, width: W - 192, height: 500, from: start, span: end - start, s: 1.7, dot: 2.6, overflow: 96 });
}

function renderFrame(ctx: CanvasRenderingContext2D, scene: Scene, pace: Pace, frame: number) {
  ctx.fillStyle = PANEL;
  ctx.fillRect(0, 0, W, H);
  if (scene.timeline.items.length === 0) return;
  ctx.textBaseline = "alphabetic";
  const state = pace.stateAt(frame);
  const pct = Math.min(1, state.walks / scene.goal);
  if (scene.layout === "scrolling") renderScrolling(ctx, scene, state, pct);
  else renderJourney(ctx, scene, state, pct);
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

const formatLength = (frames: number) => {
  const seconds = Math.round(frames / VIDEO_FPS);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export default function StravaMode({
  frameData,
  sidebar,
}: {
  frameData: FrameActivity[] | null;
  sidebar: HTMLElement | null;
}) {
  const [layout, setLayout] = usePersistedState<Layout>("strava.layout", "scrolling");
  const [pacing, setPacing] = usePersistedState<Pacing>("strava.pacing", "equal");
  const [perWeek, setPerWeek] = usePersistedState("strava.perWeek", 60);
  const [goal, setGoal] = usePersistedState<Goal>("strava.goal", "286");
  const [showActivities, setShowActivities] = usePersistedState("strava.showActivities", true);
  const [showKm, setShowKm] = usePersistedState("strava.showKm", true);
  const [showPercent, setShowPercent] = usePersistedState("strava.showPercent", true);
  const [showDays, setShowDays] = usePersistedState("strava.showDays", true);
  const [speed, setSpeed] = usePersistedState("strava.speed", "1");
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timeline = useMemo(() => buildTimeline(frameData ?? []), [frameData]);
  const pace = useMemo(() => buildPace(timeline, pacing, perWeek), [timeline, pacing, perWeek]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fontsRef = useRef({ sans: "sans-serif", mono: "monospace" });
  // Fractional while playing at speeds that are not whole frames per tick
  const frameRef = useRef(0);
  const playingRef = useRef(false);
  playingRef.current = playing;
  const exportingRef = useRef(false);
  const cancelRef = useRef(false);
  // Updated with the timeline so the preview never pairs a pace with a timeline it was not built from
  const paceRef = useRef(pace);
  paceRef.current = pace;
  const shownPaceRef = useRef(pace);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const stats = { activities: showActivities, km: showKm, percent: showPercent, days: showDays };
  const settingsRef = useRef({ timeline, layout, goal: Number(goal), stats });
  settingsRef.current = { timeline, layout, goal: Number(goal), stats };
  const scene = useCallback((): Scene => ({ ...settingsRef.current, ...fontsRef.current }), []);

  const seek = useCallback((n: number) => {
    const p = paceRef.current;
    const clamped = Math.max(p.first, Math.min(p.last, n));
    frameRef.current = clamped;
    setFrame(Math.round(clamped));
  }, []);

  // Keep the same point of the video on screen when the pacing changes length
  useEffect(() => {
    const previous = shownPaceRef.current;
    shownPaceRef.current = pace;
    if (previous === pace) return;
    const fraction = (frameRef.current - previous.first) / Math.max(1, previous.last - previous.first);
    seek(Math.round(pace.first + fraction * (pace.last - pace.first)));
  }, [pace, seek]);

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

  const togglePlaying = useCallback(() => {
    if (exportingRef.current) return;
    if (!playingRef.current && frameRef.current >= paceRef.current.last) seek(paceRef.current.first);
    setPlaying((p) => !p);
  }, [seek]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlaying();
      }
      if (exportingRef.current || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      // Arrows step a frame; with shift they jump to the start of the previous or next week
      e.preventDefault();
      setPlaying(false);
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const { weekStarts, first, last } = paceRef.current;
      const f = Math.round(frameRef.current);
      if (!e.shiftKey) seek(f + dir);
      else if (!weekStarts) seek(f + dir * VIDEO_FPS);
      else if (dir > 0) seek(weekStarts.find((s) => s > f) ?? last);
      else seek(weekStarts.findLast((s) => s < f) ?? first);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlaying, seek]);

  // Preview, clocked by wall time. Export does not use this loop.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const elapsed = (t - last) / 1000;
      last = t;
      if (exportingRef.current) return;
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;
      if (playingRef.current) {
        const p = paceRef.current;
        const shown = Math.round(frameRef.current);
        const next = frameRef.current + elapsed * VIDEO_FPS * Number(speedRef.current);
        if (next >= p.last) setPlaying(false);
        frameRef.current = Math.min(p.last, next);
        if (Math.round(frameRef.current) !== shown) setFrame(Math.round(frameRef.current));
      }
      renderFrame(ctx, scene(), paceRef.current, Math.round(frameRef.current));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [scene]);

  const exportVideo = useCallback(async () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || exportingRef.current) return;

    setPlaying(false);
    setError(null);
    setExportProgress(0);
    exportingRef.current = true;
    cancelRef.current = false;
    const resumeAt = frameRef.current;

    try {
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: "in-memory" }),
        target: new BufferTarget(),
      });
      const videoSource = new CanvasSource(canvas, { codec: "avc", bitrate: BITRATE });
      output.addVideoTrack(videoSource, { frameRate: VIDEO_FPS });
      await output.start();

      const p = paceRef.current;
      const total = p.last - p.first + 1;
      for (let n = p.first; n <= p.last && !cancelRef.current; n++) {
        renderFrame(ctx, scene(), p, n);
        const out = n - p.first;
        await videoSource.add(out / VIDEO_FPS, 1 / VIDEO_FPS);
        if (out % 15 === 0) {
          setFrame(n);
          setExportProgress(out / total);
        }
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
      exportingRef.current = false;
      setExportProgress(null);
      seek(resumeAt);
    }
  }, [scene, seek]);

  const exporting = exportProgress !== null;

  return (
    <>
      <div className="flex-1 min-w-0 relative bg-black">
        <canvas ref={canvasRef} width={W} height={H} className="absolute inset-0 w-full h-full object-contain" />
      </div>

      {sidebar &&
        createPortal(
          <>
            <Section>
              <SliderRow
                label="Frame"
                display={String(frame)}
                min={pace.first}
                max={pace.last}
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
                    seek(pace.first);
                  }}
                />
              </div>
              <SegRow label="Preview" value={speed} onChange={setSpeed} options={SPEED_OPTIONS} />
            </Section>

            <Section title="Layout">
              <SegRow label="Chart" value={layout} onChange={setLayout} options={LAYOUT_OPTIONS} />
            </Section>

            <Section title="Pacing">
              <SegRow label="Weeks" value={pacing} onChange={setPacing} options={PACING_OPTIONS} />
              {pacing !== "apple" && (
                <SliderRow
                  label={pacing === "equal" ? "Per week" : "Min week"}
                  display={`${(perWeek / VIDEO_FPS).toFixed(1)}s`}
                  min={10}
                  max={180}
                  step={5}
                  value={perWeek}
                  onChange={setPerWeek}
                />
              )}
            </Section>

            <Section title="Stats">
              <ToggleRow label="Activities" checked={showActivities} onChange={setShowActivities} />
              <ToggleRow label="Kilometers" checked={showKm} onChange={setShowKm} />
              <ToggleRow label="Days" checked={showDays} onChange={setShowDays} />
              <ToggleRow label="Completion" checked={showPercent} onChange={setShowPercent} />
              {showPercent && <SegRow label="Out of" value={goal} onChange={setGoal} options={GOAL_OPTIONS} />}
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
                <button onClick={exportVideo} className="mt-1 py-1.5 rounded bg-s-accent text-white font-medium">
                  Export MP4 · {formatLength(pace.last - pace.first + 1)}
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
