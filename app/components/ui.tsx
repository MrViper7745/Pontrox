"use client";

import { useState } from "react";
import { PRINTERS, type Bed } from "@/lib/printers";
import type { BuiltPart, Check, Spec } from "@/lib/cadClient";

export type Stage = "idle" | "design" | "check" | "done";

const STEPS: [Stage, string][] = [
  ["design", "Designing"],
  ["check", "Checking every slider position"],
  ["done", "Ready"],
];

export function Stepper({ stage }: { stage: Stage }) {
  if (stage === "idle") return null;
  const at = STEPS.findIndex(([s]) => s === stage);
  return (
    <ol className="flex flex-col gap-1 text-sm">
      {STEPS.map(([s, label], i) => {
        const done = i < at || stage === "done";
        return (
          <li key={s} className={done ? "text-green-500" : i === at ? "font-medium" : "text-gray-500"}>
            {done ? "✓" : i === at ? "●" : "○"} {label}
          </li>
        );
      })}
    </ol>
  );
}

// A number box that lets you type freely and applies the value (kept inside the range) when you leave it
function NumberField({
  value,
  min,
  max,
  step,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    if (draft.trim() !== "" && Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, n)));
    setDraft(null);
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="w-20 rounded border bg-transparent px-1 text-right text-sm"
    />
  );
}

export function ParamSliders({
  specs,
  values,
  onChange,
  onReset,
}: {
  specs: Spec[];
  values: Record<string, number>;
  onChange: (key: string, value: number) => void;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Dimensions (mm)</h3>
        <button onClick={onReset} className="text-xs text-gray-500 underline">
          Reset
        </button>
      </div>
      {specs.map((s) => (
        <div key={s.key} className="text-sm">
          <div className="flex items-center justify-between gap-2">
            <span>{s.label}</span>
            <NumberField
              value={values[s.key] ?? s.default}
              min={s.min}
              max={s.max}
              step={s.step}
              onCommit={(n) => onChange(s.key, n)}
            />
          </div>
          <input
            type="range"
            className="w-full"
            aria-label={s.label}
            min={s.min}
            max={s.max}
            step={s.step}
            value={values[s.key] ?? s.default}
            onChange={(e) => onChange(s.key, Number(e.target.value))}
          />
        </div>
      ))}
    </div>
  );
}

export function PartsList({
  parts,
  baseName,
  onSave,
  onAll,
}: {
  parts: BuiltPart[];
  baseName: string;
  onSave: (buf: ArrayBuffer, filename: string) => void;
  onAll: () => void;
}) {
  const totalCm3 = parts.reduce((s, p) => s + (p.volume ?? 0), 0);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Parts</h3>
      {parts.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-2 rounded border p-2 text-sm">
          <span>
            {p.name}{" "}
            <span className="text-gray-500">
              ({p.size.map((n) => n.toFixed(0)).join(" x ")} mm, {(p.volume ?? 0).toFixed(1)} cm³)
            </span>
          </span>
          <span className="flex gap-1">
            <button onClick={() => onSave(p.step, `${baseName}-${p.name}.step`)} className="rounded border px-2 py-1 text-xs">
              STEP
            </button>
            <button onClick={() => onSave(p.stl, `${baseName}-${p.name}.stl`)} className="rounded border px-2 py-1 text-xs">
              STL
            </button>
          </span>
        </div>
      ))}
      <button onClick={onAll} className="rounded bg-blue-600 px-3 py-2 text-sm text-white">
        Download all (zip)
      </button>
      {parts.length > 0 && (
        <p className="text-xs text-gray-500">
          Rough material estimate: {totalCm3.toFixed(1)} cm³ in total, about {(totalCm3 * 1.24).toFixed(0)} g if printed
          completely solid in PLA. Real prints usually use around a third to a half of that.
        </p>
      )}
      <p className="text-xs text-gray-500">
        STEP opens as an editable solid in SolidWorks and other CAD programs (without the feature history). STL is for slicers.
      </p>
    </div>
  );
}

export function ChecksList({ checks }: { checks: Check[] }) {
  const warns = checks.filter((c) => c.status === "warn").length;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">
        Print checks{" "}
        {checks.length > 0 && (
          <span className={warns ? "text-amber-500" : "text-green-500"}>
            {warns ? `(${warns} warning${warns > 1 ? "s" : ""})` : "(all passed)"}
          </span>
        )}
      </h3>
      {checks.map((c, i) => (
        <p key={i} className={`text-sm ${c.status === "warn" ? "text-amber-500" : ""}`}>
          {c.status === "warn" ? "⚠" : "✓"} {c.label}
        </p>
      ))}
      <p className="text-xs text-gray-500">
        These checks look at overall shape and size. They don&apos;t measure real wall thickness or overhangs yet.
      </p>
    </div>
  );
}

export function BedPicker({
  printerId,
  custom,
  showBed,
  showEdges,
  onPrinter,
  onCustom,
  onShowBed,
  onShowEdges,
}: {
  printerId: string;
  custom: Bed;
  showBed: boolean;
  showEdges: boolean;
  onPrinter: (id: string) => void;
  onCustom: (b: Bed) => void;
  onShowBed: (v: boolean) => void;
  onShowEdges: (v: boolean) => void;
}) {
  const setDim = (i: number, v: string) => {
    const next: Bed = [...custom];
    next[i] = Number(v);
    onCustom(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-3 border-b p-2 text-sm">
      <label className="flex items-center gap-2">
        <span className="text-gray-500">Printer</span>
        <select
          value={printerId}
          onChange={(e) => onPrinter(e.target.value)}
          className="max-w-[18rem] rounded border bg-transparent px-1 py-1"
        >
          {PRINTERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {printerId === "custom" &&
        (["W", "D", "H"] as const).map((l, i) => (
          <label key={l} className="flex items-center gap-1">
            <span className="text-gray-500">{l}</span>
            <input
              type="number"
              min={20}
              max={2000}
              value={custom[i]}
              onChange={(e) => setDim(i, e.target.value)}
              className="w-16 rounded border bg-transparent px-1 py-1"
            />
          </label>
        ))}
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={showBed} onChange={(e) => onShowBed(e.target.checked)} />
        <span>Show print bed</span>
      </label>
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={showEdges} onChange={(e) => onShowEdges(e.target.checked)} />
        <span>Show edges</span>
      </label>
    </div>
  );
}