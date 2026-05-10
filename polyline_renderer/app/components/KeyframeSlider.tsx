"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Keyframe {
  time: number; // 0..1
  value: number; // raw slider value
}

interface KeyframeSliderProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  formatValue?: (value: number) => string;
  progress: number; // 0..1
  onProgressChange?: (progress: number) => void;
  onKeyframeValueChange?: (value: number | null) => void;
}

const VB_W = 200;
const VB_H = 100;
const PAD = 10;
const KF_RY = 3.5;
const KF_RX = 3.5;
const HIT_R = 10;

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function timeToVbX(t: number) {
  return PAD + t * (VB_W - PAD * 2);
}

function vbXToTime(x: number) {
  return clamp((x - PAD) / (VB_W - PAD * 2), 0, 1);
}

function valueToVbY(v: number, min: number, max: number) {
  const frac = (v - min) / (max - min || 1);
  return VB_H - PAD - frac * (VB_H - PAD * 2);
}

function vbYToValue(y: number, min: number, max: number) {
  const frac = clamp((VB_H - PAD - y) / (VB_H - PAD * 2), 0, 1);
  return min + frac * (max - min);
}

function getViewBoxCoords(
  e: React.MouseEvent<SVGSVGElement>,
  svg: SVGSVGElement,
) {
  const rect = svg.getBoundingClientRect();
  const vbAspect = VB_W / VB_H;
  const svgAspect = rect.width / rect.height;
  let scale: number, offsetX: number, offsetY: number;

  if (svgAspect > vbAspect) {
    scale = rect.width / VB_W;
    offsetX = 0;
    offsetY = (rect.height - VB_H * scale) / 2;
  } else {
    scale = rect.height / VB_H;
    offsetX = (rect.width - VB_W * scale) / 2;
    offsetY = 0;
  }

  const x = (e.clientX - rect.left - offsetX) / scale;
  const y = (e.clientY - rect.top - offsetY) / scale;
  return { x, y };
}

function interpolateKeyframes(
  keyframes: Keyframe[],
  progress: number,
): number | null {
  if (keyframes.length === 0) return null;
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  if (sorted.length === 1) return sorted[0].value;
  if (progress <= sorted[0].time) return sorted[0].value;
  if (progress >= sorted[sorted.length - 1].time)
    return sorted[sorted.length - 1].value;

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

export default function KeyframeSlider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  formatValue,
  progress,
  onProgressChange,
  onKeyframeValueChange,
}: KeyframeSliderProps) {
  const [keyframes, setKeyframes] = useState<Keyframe[]>([]);
  const [showGraph, setShowGraph] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const hasKeyframes = keyframes.length > 0;

  const keyframeValue = useMemo(
    () => interpolateKeyframes(keyframes, progress),
    [keyframes, progress],
  );

  // Notify parent when keyframe value changes
  const prevKV = useRef<number | null>(null);
  useEffect(() => {
    if (keyframeValue !== prevKV.current) {
      prevKV.current = keyframeValue;
      onKeyframeValueChange?.(keyframeValue);
    }
  }, [keyframeValue, onKeyframeValueChange]);

  const displayValue = hasKeyframes ? (keyframeValue ?? value) : value;
  const displayLabel = formatValue
    ? formatValue(displayValue)
    : step >= 1
      ? displayValue.toFixed(0)
      : displayValue.toFixed(1);

  const sliderColor = hasKeyframes
    ? "accent-red-500"
    : "accent-blue-500";

  const addKeyframe = useCallback(
    (time: number) => {
      const exists = keyframes.some(
        (kf) => Math.abs(kf.time - time) < 0.005,
      );
      if (exists) return;
      setKeyframes((prev) => [...prev, { time, value: displayValue }]);
    },
    [keyframes, displayValue],
  );

  const deleteKeyframe = useCallback((index: number) => {
    setKeyframes((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSvgMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const vb = getViewBoxCoords(e, svg);

      // Check if near existing keyframe (priority over playhead)
      for (let i = 0; i < keyframes.length; i++) {
        const kf = keyframes[i];
        const kx = timeToVbX(kf.time);
        const ky = valueToVbY(kf.value, min, max);
        if (Math.abs(vb.x - kx) <= HIT_R && Math.abs(vb.y - ky) <= HIT_R) {
          setSelected(i);
          setDragging(i);
          return;
        }
      }

      // Check if near the playhead line
      const playheadX = timeToVbX(progress);
      if (
        Math.abs(vb.x - playheadX) <= HIT_R &&
        vb.y >= PAD &&
        vb.y <= VB_H - PAD
      ) {
        setScrubbing(true);
        return;
      }

      // Clicked empty space: just deselect
      setSelected(null);
      setScrubbing(true);
    },
    [keyframes, min, max, progress],
  );

  const handleSvgMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;

      if (scrubbing) {
        const vb = getViewBoxCoords(e, svg);
        const t = vbXToTime(vb.x);
        onProgressChange?.(t);
        return;
      }

      if (dragging === null) return;
      const vb = getViewBoxCoords(e, svg);
      const t = vbXToTime(vb.x);
      const v = vbYToValue(vb.y, min, max);
      setKeyframes((prev) => {
        const next = [...prev];
        next[dragging] = { time: t, value: v };
        return next;
      });
    },
    [scrubbing, dragging, min, max, onProgressChange],
  );

  const handleSvgMouseUp = useCallback(() => {
    setDragging(null);
    setScrubbing(false);
  }, []);

  const handleSvgKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.key === "Backspace" || e.key === "Delete") && selected !== null) {
        e.preventDefault();
        deleteKeyframe(selected);
        setSelected(null);
      }
    },
    [selected, deleteKeyframe],
  );

  const handleDoubleClick = useCallback(
    (index: number, e: React.MouseEvent) => {
      e.stopPropagation();
      deleteKeyframe(index);
      setSelected(null);
      setDragging(null);
    },
    [deleteKeyframe],
  );

  const sortedKeyframes = useMemo(
    () => [...keyframes].sort((a, b) => a.time - b.time),
    [keyframes],
  );

  return (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm text-zinc-300">
          {label}: {displayLabel}
        </label>
        <div className="flex items-center gap-1">
          {showGraph && (
            <button
              onClick={() => addKeyframe(progress)}
              className="text-xs text-zinc-500 hover:text-yellow-400 transition-colors select-none leading-none"
              title="Add keyframe at current time"
            >
              ◆+
            </button>
          )}
          <button
            onClick={() => setShowGraph((p) => !p)}
            className={`text-sm leading-none transition-colors select-none ${
              hasKeyframes
                ? "text-red-400 hover:text-red-300"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
            title={showGraph ? "Hide keyframe editor" : "Show keyframe editor"}
          >
            {hasKeyframes ? "◆" : "◇"}
          </button>
        </div>
      </div>

      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={hasKeyframes ? displayValue : value}
        onChange={(e) => {
          if (hasKeyframes) {
            setKeyframes([]);
            setSelected(null);
            onKeyframeValueChange?.(null);
          }
          onChange(Number(e.target.value));
        }}
        className={`w-full ${sliderColor}`}
      />

      {showGraph && (
        <div className="mt-2 bg-zinc-800 rounded-lg p-2 border border-zinc-700">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            className="w-full h-36 cursor-crosshair select-none outline-none overflow-visible"
            tabIndex={0}
            onKeyDown={handleSvgKeyDown}
            onMouseDown={handleSvgMouseDown}
            onMouseMove={handleSvgMouseMove}
            onMouseUp={handleSvgMouseUp}
            onMouseLeave={handleSvgMouseUp}
          >
            {/* Axes */}
            <line
              x1={PAD}
              y1={PAD}
              x2={PAD}
              y2={VB_H - PAD}
              stroke="#52525b"
              strokeWidth={0.5}
            />
            <line
              x1={PAD}
              y1={VB_H - PAD}
              x2={VB_W - PAD}
              y2={VB_H - PAD}
              stroke="#52525b"
              strokeWidth={0.5}
            />

            {/* Keyframe connecting polyline with horizontal extensions */}
            {sortedKeyframes.length > 0 && (
              <polyline
                points={(() => {
                  const pts: string[] = [];
                  const first = sortedKeyframes[0];
                  const last = sortedKeyframes[sortedKeyframes.length - 1];
                  pts.push(
                    `${PAD},${valueToVbY(first.value, min, max)}`,
                  );
                  sortedKeyframes.forEach((kf) => {
                    pts.push(
                      `${timeToVbX(kf.time)},${valueToVbY(kf.value, min, max)}`,
                    );
                  });
                  pts.push(
                    `${VB_W - PAD},${valueToVbY(last.value, min, max)}`,
                  );
                  return pts.join(" ");
                })()}
                fill="none"
                stroke="#f87171"
                strokeWidth={1}
                opacity={0.7}
              />
            )}

            {/* Keyframe diamonds */}
            {keyframes.map((kf, i) => {
              const kx = timeToVbX(kf.time);
              const ky = valueToVbY(kf.value, min, max);
              const isSelected = selected === i;
              return (
                <g
                  key={i}
                  style={{ cursor: "grab" }}
                  onDoubleClick={(e) => handleDoubleClick(i, e)}
                >
                  {isSelected && (
                    <>
                      <line
                        x1={PAD}
                        y1={ky}
                        x2={kx}
                        y2={ky}
                        stroke="#60a5fa"
                        strokeWidth={0.8}
                        strokeDasharray="3 2"
                        opacity={0.7}
                      />
                      <foreignObject
                        x={-20}
                        y={ky - 6}
                        width={PAD + 19}
                        height={12}
                      >
                        <div className="flex items-center justify-end h-full pr-0.5">
                          <span className="text-[7px] leading-none text-blue-400 whitespace-nowrap">
                            {formatValue
                              ? formatValue(kf.value)
                              : step >= 1
                                ? kf.value.toFixed(0)
                                : kf.value.toFixed(1)}
                          </span>
                        </div>
                      </foreignObject>
                    </>
                  )}
                  <rect
                    x={kx - HIT_R}
                    y={ky - HIT_R}
                    width={HIT_R * 2}
                    height={HIT_R * 2}
                    fill="transparent"
                  />
                  <polygon
                    points={[
                      `${kx},${ky - KF_RY}`,
                      `${kx + KF_RX},${ky}`,
                      `${kx},${ky + KF_RY}`,
                      `${kx - KF_RX},${ky}`,
                    ].join(" ")}
                    fill={dragging === i ? "#fca5a5" : "#f87171"}
                    stroke={isSelected ? "#ffffff" : "#7f1d1d"}
                    strokeWidth={isSelected ? 1.2 : 0.6}
                  />
                </g>
              );
            })}

            {/* Playhead indicator */}
            <line
              x1={timeToVbX(progress)}
              y1={PAD}
              x2={timeToVbX(progress)}
              y2={VB_H - PAD}
              stroke="transparent"
              strokeWidth={HIT_R * 2}
              style={{ cursor: "ew-resize" }}
            />
            <line
              x1={timeToVbX(progress)}
              y1={PAD}
              x2={timeToVbX(progress)}
              y2={VB_H - PAD}
              stroke="#fbbf24"
              strokeWidth={scrubbing ? 1.6 : 0.8}
              opacity={scrubbing ? 0.9 : 0.6}
              pointerEvents="none"
            />
          </svg>

          <div className="flex justify-between text-[10px] text-zinc-500 px-[10px]">
            <span>0%</span>
            <span>100%</span>
          </div>
        </div>
      )}
    </div>
  );
}
