export type PieceInfo = { min: number[]; max: number[]; size: number[] };

const GAP = 10; // mm between parts on the build plate
const BED = [220, 220, 250]; // typical hobby printer, mm

type Tri = { normal: string; verts: number[][] };

function parseTriangles(text: string): Tri[] {
  const re =
    /facet normal\s+(\S+\s+\S+\s+\S+)\s+outer loop\s+vertex\s+(\S+)\s+(\S+)\s+(\S+)\s+vertex\s+(\S+)\s+(\S+)\s+(\S+)\s+vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  const tris: Tri[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    tris.push({
      normal: m[1],
      verts: [
        [+m[2], +m[3], +m[4]],
        [+m[5], +m[6], +m[7]],
        [+m[8], +m[9], +m[10]],
      ],
    });
  }
  return tris;
}

// Splits the model into separate connected pieces, drops each onto the
// build plate (lowest point at z = 0) and lines them up along X with a gap.
export function layoutForPrint(buf: Buffer): { stl: Buffer; pieces: PieceInfo[] } {
  const tris = parseTriangles(buf.toString("utf8"));
  if (tris.length === 0) throw new Error("The model is empty");

  const parent: number[] = [];
  const ids = new Map<string, number>();
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const idOf = (v: number[]) => {
    const k = `${v[0].toFixed(4)},${v[1].toFixed(4)},${v[2].toFixed(4)}`;
    let id = ids.get(k);
    if (id === undefined) {
      id = parent.length;
      ids.set(k, id);
      parent.push(id);
    }
    return id;
  };

  const triIds = tris.map((t) => t.verts.map(idOf));
  for (const [a, b, c] of triIds) {
    union(a, b);
    union(b, c);
  }

  const groups = new Map<number, number[]>();
  triIds.forEach((v, i) => {
    const r = find(v[0]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  });

  const items = [...groups.values()].map((idxs) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const i of idxs) {
      for (const v of tris[i].verts) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], v[k]);
          max[k] = Math.max(max[k], v[k]);
        }
      }
    }
    return { idxs, min, max };
  });
  // Keep the order stable while sliders change
  items.sort((a, b) => a.min[0] - b.min[0] || a.min[1] - b.min[1]);

  const out: string[] = ["solid pontrox"];
  const pieces: PieceInfo[] = [];
  let cursor = 0;

  for (const it of items) {
    const dx = cursor - it.min[0];
    const dy = -it.min[1];
    const dz = -it.min[2];
    const size = it.max.map((v, k) => v - it.min[k]);

    for (const i of it.idxs) {
      const t = tris[i];
      out.push(`facet normal ${t.normal}`, " outer loop");
      for (const v of t.verts) {
        out.push(
          `  vertex ${(v[0] + dx).toFixed(5)} ${(v[1] + dy).toFixed(5)} ${(v[2] + dz).toFixed(5)}`
        );
      }
      out.push(" endloop", "endfacet");
    }

    pieces.push({ min: [cursor, 0, 0], max: [cursor + size[0], size[1], size[2]], size });
    cursor += size[0] + GAP;
  }
  out.push("endsolid pontrox");

  return { stl: Buffer.from(out.join("\n")), pieces };
}

// Returns a message for the AI describing the problem, or null if the result is fine.
export function checkParts(pieces: PieceInfo[], expected: number): string | null {
    if (pieces.length !== expected) {
    const sizeOf = (p: PieceInfo) => p.size.map((s) => s.toFixed(0)).join("x");
    const biggest = [...pieces]
      .sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1])
      .slice(0, 3)
      .map(sizeOf)
      .join(", ");
    return `The design should be ${expected} separate printable part(s) but it builds as ${pieces.length} separate pieces (largest, in mm: ${biggest}). Pieces that only touch do not fuse. Build the outline in 2D instead: union() circles, squares and polygons that overlap by at least 1 mm, then linear_extrude() the result so it becomes one solid.`;
  }

  for (let i = 0; i < pieces.length; i++) {
    const [w, d, h] = pieces[i].size;
    if (h > 3 * Math.min(w, d) && h > 20) {
      return `Part ${i + 1} would print standing on a thin edge (${w.toFixed(0)} x ${d.toFixed(0)} mm footprint, ${h.toFixed(0)} mm tall). Model it in its printing orientation, with its largest flat face down.`;
    }
  }

  const width = pieces[pieces.length - 1].max[0];
  const depth = Math.max(...pieces.map((p) => p.size[1]));
  const tall = Math.max(...pieces.map((p) => p.size[2]));
  if (width > BED[0] || depth > BED[1] || tall > BED[2]) {
    return `The layout is ${width.toFixed(0)} x ${depth.toFixed(0)} x ${tall.toFixed(0)} mm, bigger than a typical ${BED.join(" x ")} mm print bed. Use smaller default sizes.`;
  }
  return null;
}