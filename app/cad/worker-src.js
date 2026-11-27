import opencascade from "../node_modules/replicad-opencascadejs/dist/replicad_single.js";
import * as replicad from "replicad";
import { makeSafe } from "./safe.js";

const GAP = 10;
const DEFAULT_BED = [220, 220, 250];
let ready = null;

function normBed(bed) {
  if (Array.isArray(bed) && bed.length === 3 && bed.every((n) => Number.isFinite(n) && n >= 20 && n <= 2000)) {
    return bed;
  }
  return DEFAULT_BED;
}

async function init() {
  const OC = await opencascade({ locateFile: () => "/cad/replicad_single.wasm" });
  replicad.setOC(OC);
  makeSafe();
}

function errText(e) {
  if (e && typeof e.message === "string" && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return "a geometry operation failed (the shape is invalid at these values)";
}

function safeDelete(s) {
  try {
    if (s && typeof s.delete === "function") s.delete();
  } catch {
    /* already deleted */
  }
}

// Basic protection only, NOT real isolation. Real isolation is needed before strangers use this.
const FORBIDDEN =
  /\b(require|import|process|globalThis|global|eval|Function|constructor|__proto__|fetch|XMLHttpRequest|WebAssembly|Buffer|setTimeout|setInterval)\b/;
const HIDDEN = ["fetch", "XMLHttpRequest", "WebSocket", "importScripts", "self", "globalThis", "postMessage", "indexedDB", "caches"];

function runCode(code, values) {
  if (!code.trim()) throw new Error("The code is empty");
  if (FORBIDDEN.test(code)) {
    throw new Error("Forbidden word in code (require/import/process/eval/...). Use only replicad functions.");
  }
  let result;
  try {
    const names = Object.keys(replicad);
    const fn = new Function(...names, "p", ...HIDDEN, `"use strict";\n${code}`);
    result = fn(...names.map((n) => replicad[n]), values, ...HIDDEN.map(() => undefined));
  } catch (e) {
    throw new Error(`Code error: ${errText(e)}`);
  }
  const names = result && typeof result === "object" ? Object.keys(result) : [];
  if (names.length < 1 || names.length > 6) {
    throw new Error("The code must return an object like { partName: shape } with 1 to 6 parts");
  }
  const parts = {};
  for (const n of names) {
    const s = result[n];
    if (!s || typeof s.blobSTEP !== "function") {
      throw new Error(`Part "${n}" is not a replicad solid (a sketch must be extruded first)`);
    }
    parts[n.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 30) || "part"] = s;
  }
  return parts;
}

// Triangulates a shape: number of separate pieces plus bounding box
function analyze(shape) {
  const m = shape.mesh({ tolerance: 0.1, angularTolerance: 0.3 });
  if (!m || !m.vertices || !m.triangles) throw new Error("Could not read the shape's geometry");
  const v = m.vertices;
  const t = m.triangles;
  const ids = new Map();
  const parent = [];
  const pos = [];
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const q = (x) => (Math.round(x * 1000) / 1000 + 0).toFixed(3);
  const idOf = (i) => {
    const x = v[3 * i], y = v[3 * i + 1], z = v[3 * i + 2];
    const k = `${q(x)},${q(y)},${q(z)}`;
    let id = ids.get(k);
    if (id === undefined) {
      id = parent.length;
      ids.set(k, id);
      parent.push(id);
      pos.push([x, y, z]);
    }
    return id;
  };
  for (let i = 0; i < t.length; i += 3) {
    const a = idOf(t[i]), b = idOf(t[i + 1]), c = idOf(t[i + 2]);
    parent[find(a)] = find(b);
    parent[find(b)] = find(c);
  }
  const roots = new Set(pos.map((_, id) => find(id)));
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of pos) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
    let vol = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    vol +=
      v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
      v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
      v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return { pieces: roots.size, min, max, size: max.map((x, k) => x - min[k]), volume: Math.abs(vol) / 6000 };
}

function layoutSize(info) {
  const sizes = Object.values(info).map((a) => a.size);
  return {
    width: sizes.reduce((s, z) => s + z[0], 0) + GAP * (sizes.length - 1),
    depth: Math.max(...sizes.map((z) => z[1])),
    tall: Math.max(...sizes.map((z) => z[2])),
  };
}

// Returns a message for the AI, or null when the design is fine
function checkParts(info, bed) {
  for (const [name, a] of Object.entries(info)) {
    if (a.pieces !== 1) {
      return `Part "${name}" builds as ${a.pieces} separate pieces. Each part must be ONE connected solid: overlap fused shapes by at least 0.5 mm.`;
    }
    const [w, d, h] = a.size;
    const thin = Math.min(w, d, h);
    if (thin < 0.8) {
      return `Part "${name}" is only ${thin.toFixed(2)} mm thick in one direction. Make every part at least 1.2 mm thick.`;
    }
    if (h > 3 * Math.min(w, d) && h > 20) {
      return `Part "${name}" would print standing on a thin edge (${w.toFixed(0)} x ${d.toFixed(0)} mm footprint, ${h.toFixed(0)} mm tall). Model it in its printing orientation, largest flat face down.`;
    }
  }
  const { width, depth, tall } = layoutSize(info);
  if (width > bed[0] || depth > bed[1] || tall > bed[2]) {
    return `The layout is ${width.toFixed(0)} x ${depth.toFixed(0)} x ${tall.toFixed(0)} mm, bigger than the user's ${bed.join(" x ")} mm print bed. Use smaller default sizes.`;
  }
  return null;
}

// The same checks, written for the user's checks panel
function describeChecks(info, bed) {
  const checks = [];
  for (const [n, a] of Object.entries(info)) {
    checks.push(
      a.pieces === 1
        ? { status: "pass", label: `${n}: one connected solid` }
        : { status: "warn", label: `${n}: ${a.pieces} separate pieces` }
    );
    const [w, d, h] = a.size;
    const thin = Math.min(w, d, h);
    checks.push(
      thin >= 1.2
        ? { status: "pass", label: `${n}: smallest dimension ${thin.toFixed(1)} mm` }
        : { status: "warn", label: `${n}: very thin (${thin.toFixed(1)} mm)` }
    );
    checks.push(
      h > 3 * Math.min(w, d) && h > 20
        ? { status: "warn", label: `${n}: tall and narrow, may be hard to print upright` }
        : { status: "pass", label: `${n}: stable footprint` }
    );
  }
  const { width, depth, tall } = layoutSize(info);
  const size = `${width.toFixed(0)} x ${depth.toFixed(0)} x ${tall.toFixed(0)} mm`;
  checks.push(
    width <= bed[0] && depth <= bed[1] && tall <= bed[2]
      ? { status: "pass", label: `Fits your printer (${size} of ${bed.join(" x ")})` }
      : { status: "warn", label: `Too big for your printer: ${size} against ${bed.join(" x ")}` }
  );
  return checks;
}

// Builds the design, measures every part, then frees the shapes
function buildAndAnalyze(code, values) {
  const parts = runCode(code, values);
  try {
    const info = {};
    for (const [n, s] of Object.entries(parts)) info[n] = analyze(s);
    return info;
  } finally {
    for (const s of Object.values(parts)) safeDelete(s);
  }
}

function sliderProblems(code, params, bed) {
  const defaults = Object.fromEntries(params.map((p) => [p.key, p.default]));
  const cases = [
    ["all-min", Object.fromEntries(params.map((p) => [p.key, p.min]))],
    ["all-max", Object.fromEntries(params.map((p) => [p.key, p.max]))],
  ];
  for (const p of params) {
    cases.push([`${p.key}=min`, { ...defaults, [p.key]: p.min }]);
    cases.push([`${p.key}=max`, { ...defaults, [p.key]: p.max }]);
  }
  const bad = [];
  for (const [label, values] of cases) {
    try {
      const problem = checkParts(buildAndAnalyze(code, values), bed);
      // A layout bigger than the bed is a warning for users, not a build failure
      if (problem && !problem.startsWith("The layout is")) throw new Error(problem);
    } catch (err) {
      bad.push(`${label}: ${errText(err).slice(0, 160)}`);
    }
  }
  return { cases: cases.length, bad };
}

function validateDesign(code, params, bed) {
  const defaults = Object.fromEntries(params.map((p) => [p.key, p.default]));
  const problem = checkParts(buildAndAnalyze(code, defaults), bed);
  if (problem) throw new Error(problem);
  const sp = sliderProblems(code, params, bed);
  if (sp.bad.length) {
    throw new Error(
      `The sliders break at their limits (${sp.bad.length} of ${sp.cases} tests failed), for example: ${sp.bad.slice(0, 3).join(" | ")}. Make the design stay valid across the whole range, or narrow the range.`
    );
  }
}

// Builds for display and download: each part is placed flat on the plate, side by side
async function buildForDisplay(code, values, bed) {
  const parts = runCode(code, values);
  try {
    const info = {};
    for (const [n, s] of Object.entries(parts)) info[n] = analyze(s);
    const checks = describeChecks(info, bed);
    const out = [];
    const transfer = [];
    let cursor = 0;
    for (const [n, shape] of Object.entries(parts)) {
      const a = info[n];
      const placed = shape.translateX(cursor - a.min[0]).translateY(-a.min[1]).translateZ(-a.min[2]);
      cursor += a.size[0] + GAP;
      const stl = await placed.blobSTL().arrayBuffer();
      const step = await placed.blobSTEP().arrayBuffer();
        out.push({ name: n, stl, step, size: a.size, volume: a.volume });
      transfer.push(stl, step);
      safeDelete(placed);
    }
    return { out, transfer, checks };
  } finally {
    for (const s of Object.values(parts)) safeDelete(s);
  }
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    const t0 = performance.now();
    ready =
      ready ??
      init().catch((err) => {
        ready = null;
        throw err;
      });
    await ready;
    const initMs = Math.round(performance.now() - t0);
    const bed = normBed(e.data.bed);

    if (type === "init") {
      self.postMessage({ id, ok: true, initMs });
    } else if (type === "validate") {
      validateDesign(e.data.code, e.data.params, bed);
      self.postMessage({ id, ok: true });
    } else if (type === "build") {
      const r = await buildForDisplay(e.data.code, e.data.values, bed);
      self.postMessage({ id, ok: true, parts: r.out, checks: r.checks }, r.transfer);
    } else {
      throw new Error("Unknown request");
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: errText(err) });
  }
};