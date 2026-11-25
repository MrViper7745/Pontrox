// Run from spikes/replicad:  node makeapi.mjs   (writes api.txt)
import { readFileSync, writeFileSync } from "node:fs";

const dts = readFileSync("node_modules/replicad/dist/replicad.d.ts", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "")
  .replace(/\s+/g, " ");

const CLASSES = [
  "DrawingPen", "BaseSketcher2d", "Drawing", "Sketch", "Transformable", "Shape",
  "Shape3D", "Solid", "Face", "Plane", "EdgeFinder", "FaceFinder",
];

function classBody(name) {
  const m = new RegExp(`declare (?:abstract )?class ${name}\\b[^{]*\\{`).exec(dts);
  if (!m) return null;
  let i = m.index + m[0].length;
  const start = i;
  let depth = 1;
  while (i < dts.length && depth > 0) {
    if (dts[i] === "{") depth++;
    else if (dts[i] === "}") depth--;
    i++;
  }
  return { head: m[0].replace(/\s*\{$/, ""), body: dts.slice(start, i - 1) };
}

function members(body) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of body) {
    if ("({[".includes(ch)) depth++;
    if (")}]".includes(ch)) depth--;
    if (ch === ";" && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  return out;
}

const lines = [];
const missing = [];

lines.push("## Functions");
const fre = /declare function ((?:draw|make|sketch)\w*)(<[^(]*>)?\(([^)]*)\)\s*:\s*([^;{]+);/g;
let fm;
while ((fm = fre.exec(dts))) {
  lines.push(`${fm[1]}(${fm[3].slice(0, 100)}): ${fm[4].trim().slice(0, 40)}`);
}

for (const name of CLASSES) {
  const c = classBody(name);
  if (!c) {
    missing.push(name);
    continue;
  }
  lines.push("", `## ${c.head.slice(0, 100)}`);
  for (const mem of members(c.body)) {
    if (/^(private|protected|#|constructor)/.test(mem)) continue;
    if (!/^(static )?\w+(<[^(]*>)?\(/.test(mem)) continue;
    lines.push(mem.slice(0, 150));
  }
}

writeFileSync("api.txt", lines.join("\n"));
console.log(`api.txt written: ${lines.length} lines. Classes not found: ${missing.join(", ") || "none"}`);