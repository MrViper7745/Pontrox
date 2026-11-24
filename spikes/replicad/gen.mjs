// Run from /workspaces/Pontrox/spikes/replicad:
//   node --env-file=../../app/.env.local gen.mjs
//   ONLY=1,4 node --env-file=../../app/.env.local gen.mjs
// WARNING: runs AI-written JavaScript with node:vm, which is NOT a real sandbox.
// Fine for a local experiment on your own machine; never expose this to other users.
import { writeFile, mkdir, rm } from "node:fs/promises";
import vm from "node:vm";
import * as replicad from "replicad";
import opencascade from "./node_modules/replicad-opencascadejs/dist/replicad_single.js";

replicad.setOC(await opencascade());

const OUT = "../../tests/out/replicad";
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";
const ONLY = process.env.ONLY?.split(",").map(Number);
const GAP = 10;
const BED = [220, 220, 250];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPTS = [
  "Box with a snap-on lid, 80 x 50 x 30 mm",
  "Wall bracket for a 25 mm pipe, holds 2 kg",
  "Cable clip for a 6 mm cable",
  "Gear with 20 teeth",
  "Wall hook that holds 2 kg",
  "Enclosure for an Arduino Uno with port cutouts",
  "Plant pot with drainage holes and a saucer",
  "Phone stand with adjustable angle",
];

const SYSTEM = `You write replicad (JavaScript on OpenCascade) code for 3D-printable, editable CAD parts.

Return ONLY a JSON object, no markdown:
{
  "name": "short_snake_case_name",
  "notes": "assumptions, one or two sentences",
  "params": [ { "key": "wall", "label": "Wall thickness", "min": 1, "max": 6, "step": 0.5, "default": 2 } ],
  "code": "JavaScript function BODY as a string"
}

How "code" works:
- It is the body of a function. The numbers from params are available as p.<key> (for example p.wall).
- Every replicad export is already in scope (drawRectangle, drawRoundedRectangle, drawCircle, draw, makeCylinder, makeSphere, compoundShapes, ...). Do not use import, require, or any other globals.
- It must end with: return { partName: shape, ... } with one entry per separate printable part (1 for a gear, 2 for a box and its lid). Each part must be ONE connected solid.
- The software places the parts flat on the build plate itself, so do not position parts for the plate. Positions only matter inside one part.

replicad quick reference (millimetres):
- 2D, centred on the origin: drawRectangle(w, h), drawRoundedRectangle(w, h, radius), drawCircle(r). Polygons: draw([x, y]).lineTo([x, y]).lineTo([x, y]).close().
- Sketch to solid: sketch.sketchOnPlane("XY", zOffset).extrude(height). It extrudes upward (+z) from the plane. Round parts: .revolve().
- Solids: makeCylinder(radius, height, [x, y, z] base position, [0, 0, 1] direction), makeSphere(radius).
- Boolean: a.fuse(b), a.cut(b), a.intersect(b).
- Move: shape.translate([x, y, z]), shape.translateX(d), shape.translateY(d), shape.translateZ(d), shape.rotate(angleDegrees, [px, py, pz], [dx, dy, dz]).
- Edges (optional, can fail on complex shapes): shape.fillet(radius, (e) => e.inDirection("Z")).
- A sketch (the result of .sketchOnPlane(...)) can be extruded or revolved only ONCE; it is consumed. To make a second solid from the same outline, call the draw function again to get a new drawing and sketch it again. Likewise, build a fresh shape each time you need one instead of reusing a variable that has already been used in fuse(), cut() or intersect().
- 2D drawings (drawRectangle, drawCircle, ...) are moved with .translate(x, y) and rotated with .rotate(angleDegrees). translateX, translateY and translateZ exist only on 3D solids.

Rules:
- Every param needs min, max, step and a default inside the range. Use at least 4 params (overall length, width, height, hole sizes, wall thickness). Never hardcode a dimension a user might want to change.
- The part must stay valid at every value from min to max.
- Minimum wall 1.2 mm. Add 0.2 mm clearance where printed parts fit together.
- Build each part in the orientation it should be printed, largest flat face down.
- Fuse overlapping shapes by at least 0.5 mm so each part is one solid.
- Never drop a feature the user asked for (snap lip, pipe cradle, adjustment mechanism, hook shape, ...).
- Set each parameter's max so the finished design is still under 200 mm in every direction at maximum values (for all parts laid out side by side).
- Every part must stay ONE connected solid at the minimum AND maximum of every parameter. Overlap fused shapes by at least 1 mm even when the wall thickness is at its minimum.
- If a previous attempt failed, fix the problem and return the full JSON again.`;

async function ask(history) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing (run with --env-file=../../app/.env.local)");
    for (let t = 0; t < 6; t++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: history.map((m, i) => ({
            role: m.role,
            parts: [{ text: i === 0 ? `${SYSTEM}\n\nUser request:\n${m.text}` : m.text }],
          })),
          generationConfig: { maxOutputTokens: 16384, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(60000),
      }
    );
    if (res.status === 503 || res.status === 429) {
        await sleep(5000 * (t + 1));
      continue;
    }
    if (!res.ok) throw new Error(`AI error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    if (!text.trim()) throw new Error("AI returned an empty reply");
    return text;
  }
  throw new Error("AI busy (503/429)");
}

function validateParams(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 12) {
    throw new Error("params must be a list of 1 to 12 items");
  }
  const seen = new Set();
  return list.map((raw) => {
    const key = String(raw?.key ?? "");
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/.test(key) || seen.has(key)) {
      throw new Error(`Bad parameter name: ${key}`);
    }
    seen.add(key);
    const min = Number(raw.min), max = Number(raw.max);
    const step = Number(raw.step), def = Number(raw.default);
    if (![min, max, step, def].every(Number.isFinite) || min >= max || step <= 0 || def < min || def > max) {
      throw new Error(`Bad range for parameter ${key}`);
    }
    return { key, label: String(raw.label ?? key), min, max, step, default: def };
  });
}

const FORBIDDEN =
  /\b(require|import|process|globalThis|global|eval|Function|constructor|__proto__|fetch|XMLHttpRequest|WebAssembly|Buffer|setTimeout|setInterval)\b/;

function runCode(code, values) {
  if (!code.trim()) throw new Error("The code is empty");
  if (FORBIDDEN.test(code)) {
    throw new Error("Forbidden word in code (require/import/process/eval/...). Use only replicad functions.");
  }
  const ctx = vm.createContext({ ...replicad, p: values });
  let result;
  try {
    result = vm.runInContext(`(function () {\n${code}\n})()`, ctx, { timeout: 20000 });
  } catch (e) {
    throw new Error(`Code error: ${e.message}`);
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

// Triangulates a shape and reports how many separate pieces it has, plus its bounding box
function analyze(shape) {
  const m = shape.mesh({ tolerance: 0.1, angularTolerance: 0.3 });
  if (!m?.vertices || !m?.triangles) {
    throw new Error("HARNESS: unexpected mesh() result, keys: " + Object.keys(m ?? {}).join(","));
  }
  const v = m.vertices, t = m.triangles;
  const ids = new Map(), parent = [], pos = [];
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
  return { pieces: roots.size, min, max, size: max.map((x, k) => x - min[k]) };
}

function checkParts(info) {
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
  const sizes = Object.values(info).map((a) => a.size);
  const width = sizes.reduce((s, z) => s + z[0], 0) + GAP * (sizes.length - 1);
  const depth = Math.max(...sizes.map((z) => z[1]));
  const tall = Math.max(...sizes.map((z) => z[2]));
  if (width > BED[0] || depth > BED[1] || tall > BED[2]) {
    return `The layout is ${width.toFixed(0)} x ${depth.toFixed(0)} x ${tall.toFixed(0)} mm, bigger than a typical ${BED.join(" x ")} mm print bed. Use smaller default sizes.`;
  }
  return null;
}

function build(code, values) {
  const parts = runCode(code, values);
  const info = Object.fromEntries(Object.entries(parts).map(([n, s]) => [n, analyze(s)]));
  return { parts, info };
}

async function generate(prompt) {
  const history = [{ role: "user", text: prompt }];
  const failures = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const text = await ask(history);
      let lastCode = "";
    try {
      const s = text.indexOf("{"), e = text.lastIndexOf("}");
      if (s < 0 || e <= s) throw new Error("Reply was not valid JSON");
      const parsed = JSON.parse(text.slice(s, e + 1));
      const params = validateParams(parsed.params);
      const code = String(parsed.code ?? "");
        lastCode = code;
      const defaults = Object.fromEntries(params.map((p) => [p.key, p.default]));
      const { parts, info } = build(code, defaults);
      const problem = checkParts(info);
      if (problem) throw new Error(problem);
      const name = String(parsed.name ?? "part").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "part";
      return { ok: true, attempts: attempt, name, params, code, parts, info };
    } catch (err) {
      if (String(err.message).startsWith("HARNESS")) throw err;
         await writeFile(`${OUT}/failed-${Date.now()}.js`, `// ${err.message}\n${lastCode}`);
      failures.push(err.message);
      history.push(
        { role: "model", text },
        { role: "user", text: `That attempt failed: ${err.message}\nFix it and return the full JSON again.` }
      );
    }
  }
  return { ok: false, failures };
}

async function exportParts(prefix, parts, info) {
  let cursor = 0;
  for (const [name, shape] of Object.entries(parts)) {
    const a = info[name];
    const placed = shape
      .translateX(cursor - a.min[0])
      .translateY(-a.min[1])
      .translateZ(-a.min[2]);
    cursor += a.size[0] + GAP;
    await writeFile(`${OUT}/${prefix}-${name}.step`, Buffer.from(await placed.blobSTEP().arrayBuffer()));
    await writeFile(`${OUT}/${prefix}-${name}.stl`, Buffer.from(await placed.blobSTL().arrayBuffer()));
  }
}

if (!ONLY) await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const rows = [];

for (const [i, prompt] of PROMPTS.entries()) {
  if (ONLY && !ONLY.includes(i + 1)) continue;
  const row = { "#": i + 1, prompt: prompt.slice(0, 34), secs: "-", attempts: "-", params: "-", parts: "-", range_fails: "-", result: "" };
  const t0 = Date.now();
  try {
    const g = await generate(prompt);
    row.secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!g.ok) {
      row.result = "GENERATE FAILED";
      console.log(`\n#${i + 1} ${prompt}`);
      g.failures.forEach((f, n) => console.log(`  attempt ${n + 1}: ${f.slice(0, 300)}`));
      rows.push(row);
      continue;
    }
    row.attempts = g.attempts;
    row.params = g.params.length;
    row.parts = Object.keys(g.parts).length;

    // Slider-extreme test: all-min, all-max, and each parameter alone at min and max
    const defaults = Object.fromEntries(g.params.map((p) => [p.key, p.default]));
    const cases = [
      ["all-min", Object.fromEntries(g.params.map((p) => [p.key, p.min]))],
      ["all-max", Object.fromEntries(g.params.map((p) => [p.key, p.max]))],
    ];
    for (const p of g.params) {
      cases.push([`${p.key}=min`, { ...defaults, [p.key]: p.min }]);
      cases.push([`${p.key}=max`, { ...defaults, [p.key]: p.max }]);
    }
    const fails = [];
    let firstErr = "";
    for (const [label, values] of cases) {
      try {
        const r = build(g.code, values);
        const problem = checkParts(r.info);
           if (problem && !problem.startsWith("The layout is")) throw new Error(problem);
      } catch (err) {
        if (String(err.message).startsWith("HARNESS")) throw err;
        fails.push(label);
        if (!firstErr) firstErr = `${label}: ${err.message}`;
      }
    }
    row.range_fails = fails.length ? `${fails.length}/${cases.length}: ${fails.slice(0, 3).join(", ")}` : `0/${cases.length}`;
    if (firstErr) console.log(`\n#${i + 1} first slider problem: ${firstErr.slice(0, 250)}`);

    await exportParts(String(i + 1), g.parts, g.info);
    await writeFile(`${OUT}/${i + 1}-${g.name}.js`, g.code);
    row.result = "ok: " + g.name;
  } catch (err) {
    row.result = "ERROR: " + String(err.message).slice(0, 80);
  }
  rows.push(row);
  await sleep(2000);
}

console.table(rows);