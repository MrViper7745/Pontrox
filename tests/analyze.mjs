// Usage (from /workspaces/Pontrox):  node tests/analyze.mjs
// Checks the STL files that run-phase0.mjs saved in tests/out/
import { readdir, readFile } from "node:fs/promises";

const BED = [220, 220, 250]; // typical hobby printer, mm
const MIN_THICK = 1.2;       // thinnest piece dimension we accept, mm

function parse(text) {
  const tris = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let m, cur = [];
  while ((m = re.exec(text))) {
    cur.push([+m[1], +m[2], +m[3]]);
    if (cur.length === 3) { tris.push(cur); cur = []; }
  }
  return tris;
}

// Split the mesh into separate connected pieces
function pieces(tris) {
  const ids = new Map();
  const parent = [];
  const find = (a) => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  const union = (a, b) => { parent[find(a)] = find(b); };
  const idOf = (v) => {
    const k = v.map((n) => n.toFixed(4)).join(",");
    if (!ids.has(k)) { ids.set(k, parent.length); parent.push(parent.length); }
    return ids.get(k);
  };

  const triIds = tris.map((t) => t.map(idOf));
  for (const [a, b, c] of triIds) { union(a, b); union(b, c); }

  const groups = new Map();
  tris.forEach((t, i) => {
    const r = find(triIds[i][0]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  });

  return [...groups.values()].map((ts) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let vol = 0;
    for (const [a, b, c] of ts) {
      for (const v of [a, b, c]) {
        for (let i = 0; i < 3; i++) {
          min[i] = Math.min(min[i], v[i]);
          max[i] = Math.max(max[i], v[i]);
        }
      }
      vol +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    return { min, max, size: max.map((x, i) => x - min[i]), volume: Math.abs(vol) };
  });
}

const files = (await readdir("tests/out"))
  .filter((f) => f.endsWith(".stl"))
  .sort((a, b) => parseInt(a) - parseInt(b));

const rows = [];
for (const f of files) {
  const tris = parse(await readFile(`tests/out/${f}`, "utf8"));
  const ps = pieces(tris);
  const flags = [];

  const all = ps.reduce(
    (acc, p) => ({
      min: acc.min.map((v, i) => Math.min(v, p.min[i])),
      max: acc.max.map((v, i) => Math.max(v, p.max[i])),
    }),
    { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
  );
  const size = all.max.map((v, i) => v - all.min[i]);

  if (size.some((s, i) => s > BED[i])) flags.push("TOO BIG FOR BED");

  ps.forEach((p, i) => {
    if (Math.min(...p.size) < MIN_THICK) flags.push(`piece ${i + 1} very thin`);
  });

  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      const dx = Math.max(a.min[0] - b.max[0], b.min[0] - a.max[0]);
      const dy = Math.max(a.min[1] - b.max[1], b.min[1] - a.max[1]);
      if (dx < 0 && dy < 0) flags.push(`pieces ${i + 1}&${j + 1} overlap on the bed`);
      else if (Math.max(dx, dy) < 2) flags.push(`pieces ${i + 1}&${j + 1} < 2mm apart`);
    }
  }

  rows.push({
    file: f.slice(0, 32),
    size_mm: size.map((s) => s.toFixed(0)).join(" x "),
    pieces: ps.length,
    piece_sizes: ps.map((p) => p.size.map((s) => s.toFixed(0)).join("x")).join(" | "),
    volume_cm3: (ps.reduce((s, p) => s + p.volume, 0) / 1000).toFixed(1),
    flags: flags.join("; ") || "-",
  });
}
console.table(rows);