"use client";

import React from "react";

const ICONS = {
  play: "M4 2.5v11l9-5.5z",
  pause: "M4 2.5h3v11H4zM9 2.5h3v11H9z",
  start: "M3 2.5h2v11H3zM14 2.5v11L6 8z",
  end: "M11 2.5h2v11h-2zM2 2.5v11L10 8z",
  prev: "M10.5 2.5v11L4 8z",
  next: "M5.5 2.5v11L12 8z",
};

const ROW = "min-h-[26px] items-center";
const VALUE = "font-mono text-[11px] tabular-nums text-s-dim text-right";

export function Section({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-0.5 px-3 pt-2.5 pb-3 border-b border-s-line last:border-b-0">
      {title && (
        <h3 className="pb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-s-dim">
          {title}
        </h3>
      )}
      {children}
    </section>
  );
}

export function SliderRow({
  label,
  display,
  value,
  min,
  max,
  step,
  onChange,
  fill,
  extra,
  arrows,
}: {
  label: string;
  display: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  fill?: string;
  extra?: React.ReactNode;
  // Show ‹ › buttons either side of the slider that move it by one step
  arrows?: boolean;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const nudge = (direction: number) =>
    onChange(Math.min(max, Math.max(min, value + direction * step)));
  const input = (
    <input
      type="range"
      aria-label={label}
      className="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      style={
        { "--p": `${pct}%`, ...(fill ? { "--fill": fill } : {}) } as React.CSSProperties
      }
    />
  );
  return (
    <div className={`grid grid-cols-[84px_minmax(0,1fr)_46px] gap-x-2 ${ROW}`}>
      <div className="flex items-center gap-1.5 min-w-0 text-s-dim">
        <span className="truncate">{label}</span>
        {extra}
      </div>
      {arrows ? (
        <div className="flex items-center gap-1 min-w-0">
          <IconButton icon="prev" label={`Previous ${label.toLowerCase()}`} onClick={() => nudge(-1)} small />
          <div className="flex-1 min-w-0 flex items-center">{input}</div>
          <IconButton icon="next" label={`Next ${label.toLowerCase()}`} onClick={() => nudge(1)} small />
        </div>
      ) : (
        input
      )}
      <span className={VALUE}>{display}</span>
    </div>
  );
}

export function ProgressRow({
  label,
  display,
  fraction,
}: {
  label: string;
  display: string;
  fraction: number;
}) {
  return (
    <div className={`grid grid-cols-[84px_minmax(0,1fr)_46px] gap-x-2 ${ROW}`}>
      <span className="text-s-dim">{label}</span>
      <div className="h-0.5 bg-s-track">
        <div className="h-full bg-s-accent" style={{ width: `${fraction * 100}%` }} />
      </div>
      <span className={VALUE}>{display}</span>
    </div>
  );
}

export function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`flex justify-between gap-3 ${ROW}`}>
      <span className="text-s-dim">{label}</span>
      <input
        type="checkbox"
        className="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

export function SegRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className={`flex justify-between gap-3 ${ROW}`}>
      <span className="text-s-dim">{label}</span>
      <div className="flex bg-s-panel rounded">
        {options.map((o) => (
          <button
            key={o.value}
            title={o.title}
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
            className={`px-2 py-1 text-[11px] rounded transition-colors ${
              o.value === value
                ? "bg-s-track text-s-text"
                : "text-s-dim hover:text-s-text"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className={`flex justify-between gap-3 ${ROW}`}>
      <span className="text-s-dim">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-[160px] bg-transparent border border-s-line rounded px-1 py-[3px] text-[11px] text-s-text"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  primary,
  small,
}: {
  icon: keyof typeof ICONS;
  label: string;
  onClick: () => void;
  primary?: boolean;
  small?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`${small ? "w-4 h-[26px] shrink-0" : "w-[26px] h-[26px]"} grid place-items-center rounded transition-colors ${
        primary ? "bg-s-accent text-white" : "text-s-dim hover:text-s-text"
      }`}
    >
      <svg viewBox="0 0 16 16" className={`${small ? "w-2.5 h-2.5" : "w-3 h-3"} fill-current`}>
        <path d={ICONS[icon]} />
      </svg>
    </button>
  );
}

export function TextButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] text-s-dim hover:text-s-text transition-colors"
    >
      {children}
    </button>
  );
}
