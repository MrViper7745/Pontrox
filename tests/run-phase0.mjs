// Usage (from /workspaces/Pontrox, with `npm run dev` running in another terminal):
//   node tests/run-phase0.mjs            run all prompts
//   ONLY=4,6,8 node tests/run-phase0.mjs run only those prompt numbers
import { writeFile, mkdir, rm } from "node:fs/promises";

const BASE = process.env.BASE ?? "http://localhost:3000";
const ONLY = process.env.ONLY?.split(",").map(Number);
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

async function post(path, body) {
  const t = Date.now();
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  return { res, secs: (Date.now() - t) / 1000 };
}

if (!ONLY) await rm("tests/out", { recursive: true, force: true });
await mkdir("tests/out", { recursive: true });
const rows = [];

for (const [i, prompt] of PROMPTS.entries()) {
  if (ONLY && !ONLY.includes(i + 1)) continue;
  const row = {
    "#": i + 1,
    prompt: prompt.slice(0, 38),
    secs: "-",
    attempts: "-",
    params: "-",
    range_fails: "-",
    result: "",
  };
  try {
    const { res, secs } = await post("/api/generate", { prompt });
    row.secs = secs.toFixed(1);
    const part = await res.json();
    if (!res.ok) {
      row.result = "GENERATE FAILED";
      console.log(`\n#${i + 1} ${prompt}`);
      if (Array.isArray(part.detail)) {
        part.detail.forEach((d, n) =>
          console.log(`  attempt ${n + 1}: ${String(d).slice(0, 300)}`)
        );
      } else {
        console.log(`  ${part.error}`);
      }
      rows.push(row);
      continue;
    }
    row.attempts = part.attempts;
    row.params = part.params.length;

    const pick = (f) => Object.fromEntries(part.params.map((p) => [p.key, f(p)]));
    const defaults = pick((p) => p.default);
    const cases = [
      ["all-min", pick((p) => p.min)],
      ["all-max", pick((p) => p.max)],
    ];
    for (const p of part.params) {
      cases.push([`${p.key}=min`, { ...defaults, [p.key]: p.min }]);
      cases.push([`${p.key}=max`, { ...defaults, [p.key]: p.max }]);
    }

    const fails = [];
    let firstErr = "";
    for (const [label, values] of cases) {
      const r = await post("/api/render", {
        scad: part.scad,
        params: part.params,
        values,
      });
      if (!r.res.ok) {
        fails.push(label);
        if (!firstErr) {
          firstErr = (await r.res.json().catch(() => ({}))).error ?? "";
        }
      }
    }
    row.range_fails = fails.length
      ? `${fails.length}/${cases.length}: ${fails.slice(0, 4).join(", ")}`
      : `0/${cases.length}`;
    if (firstErr) {
      console.log(`\n#${i + 1} first slider error: ${firstErr.slice(0, 300)}`);
    }

    const d = await post("/api/render", {
      scad: part.scad,
      params: part.params,
      values: defaults,
    });
    if (d.res.ok) {
      await writeFile(
        `tests/out/${i + 1}-${part.name}.stl`,
        Buffer.from(await d.res.arrayBuffer())
      );
    }
    await writeFile(`tests/out/${i + 1}-${part.name}.scad`, part.scad);
    row.result = "ok: " + part.name;
  } catch (e) {
    row.result = "ERROR: " + e.message;
  }
  rows.push(row);
  await new Promise((r) => setTimeout(r, 2000));
}

console.table(rows);