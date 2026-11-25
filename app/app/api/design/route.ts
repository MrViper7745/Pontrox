import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

type Msg = { role: "user" | "model"; text: string };

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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

function loadExtras(): string {
  const dir = path.join(process.cwd(), "cad");
  let extra = "";
  const api = path.join(dir, "api.txt");
  if (existsSync(api)) {
    extra +=
      "\n\nThe REAL replicad API, extracted from the library. Use ONLY these functions and methods; anything not listed does not exist:\n" +
      readFileSync(api, "utf8").slice(0, 30000);
  }
  const exDir = path.join(dir, "examples");
  if (existsSync(exDir)) {
    const ex = readdirSync(exDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readFileSync(path.join(exDir, f), "utf8"))
      .join("\n\n");
    if (ex) extra += "\n\nWORKING EXAMPLES: complete, verified answers to other requests. Copy their patterns:\n" + ex;
  }
  return extra;
}
const EXTRA = loadExtras();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function callModel(model: string, history: Msg[], timeoutMs: number): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new HttpError(500, "GEMINI_API_KEY is not set");
  const t0 = Date.now();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: history.map((m, i) => ({
        role: m.role,
        parts: [{ text: i === 0 ? `${SYSTEM}${EXTRA}\n\nUser request:\n${m.text}` : m.text }],
      })),
      generationConfig: { maxOutputTokens: 16384, responseMimeType: "application/json" },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    console.error(`Gemini ${model} error ${res.status}:`, (await res.text()).slice(0, 300));
    throw new HttpError(res.status, `AI service error (${res.status})`);
  }
  const json = await res.json();
  const parts: { text?: string }[] = json?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("");
  console.log(`Gemini ${model}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!text.trim()) throw new HttpError(502, "The AI returned an empty reply");
  return text;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const history = body?.history as Msg[] | undefined;
  const tier = body?.tier === "strong" ? "strong" : "fast";

  const valid =
    Array.isArray(history) &&
    history.length >= 1 &&
    history.length <= 10 &&
    history.every(
      (m, i) =>
        (m?.role === (i % 2 === 0 ? "user" : "model")) && typeof m.text === "string" && m.text.length <= 20000
    ) &&
    history[history.length - 1].role === "user" &&
    history[0].text.trim().length > 0 &&
    history[0].text.length <= 1000;
  if (!valid) return Response.json({ error: "Bad request" }, { status: 400 });

  const model =
    tier === "strong"
      ? process.env.GEMINI_STRONG_MODEL ?? "gemini-3.6-flash"
      : process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite-preview";

  // Stay under about a minute per call: longer requests tend to be dropped by proxies
  const deadline = Date.now() + 55000;
  let lastStatus = 0;
  for (let t = 0; t < 4; t++) {
    const remaining = deadline - Date.now();
    if (remaining < 4000) break;
    try {
      const text = await callModel(model, history!, remaining);
      return Response.json({ text, model });
    } catch (e) {
      lastStatus = e instanceof HttpError ? e.status : 0;
      if (lastStatus >= 400 && lastStatus < 500 && lastStatus !== 429) {
        return Response.json({ error: (e as Error).message }, { status: 502 });
      }
      await sleep(Math.min(3000 * (t + 1), deadline - Date.now() - 4000));
    }
  }
  return Response.json(
    {
      error:
        lastStatus === 0
          ? "The AI took too long. Try again."
          : "The AI service is busy right now. Wait a minute and try again.",
    },
    { status: 502 }
  );
}