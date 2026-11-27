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
- "notes" is shown to the end user. Briefly describe the design and your assumptions (sizes, fit, features). Never mention checks, retries or fixes.
- For parts that fit together (a lid on a box, a pin in a hole), compute the mating sizes from shared parameters and leave 0.2 to 0.4 mm clearance. A lid that slips over a box must have an inside size at least the box's outside size plus that clearance.
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

// ---- Stopgap protection. In memory only: resets on restart and is not shared between server
// instances. Real limits need accounts and a database. ----
const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const max = Number(process.env.RATE_LIMIT_PER_10_MIN ?? 40);
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  }
  return false;
}

let capDay = new Date().toISOString().slice(0, 10);
let capCalls = 0;
function overDailyCap(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== capDay) {
    capDay = today;
    capCalls = 0;
  }
  if (capCalls >= Number(process.env.AI_DAILY_CAP ?? 400)) return true;
  capCalls++;
  return false;
}

// ---- Token accounting for working out real costs ----
const totals = { calls: 0, input: 0, output: 0 };

async function callModel(model: string, history: Msg[], timeoutMs: number, outer: AbortSignal): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new HttpError(500, "GEMINI_API_KEY is not set");
  const t0 = Date.now();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  outer.addEventListener("abort", onAbort);
  try {
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
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error(`Gemini ${model} error ${res.status}:`, (await res.text()).slice(0, 300));
      throw new HttpError(res.status, `AI service error (${res.status})`);
    }
    const json = await res.json();
    const parts: { text?: string }[] = json?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("");

    const u = json?.usageMetadata ?? {};
    const tin = Number(u.promptTokenCount ?? 0);
    const tout = Number(u.candidatesTokenCount ?? 0) + Number(u.thoughtsTokenCount ?? 0);
    totals.calls++;
    totals.input += tin;
    totals.output += tout;
    console.log(
      `Gemini ${model}: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${tin} in, ${tout} out | ` +
        `totals since start: ${totals.calls} calls, ${totals.input} in, ${totals.output} out`
    );

    if (!text.trim()) throw new HttpError(502, "The AI returned an empty reply");
    return text;
  } finally {
    clearTimeout(timer);
    outer.removeEventListener("abort", onAbort);
  }
}

async function design(history: Msg[], tier: "fast" | "strong", outer: AbortSignal) {
  const model =
    tier === "strong"
      ? process.env.GEMINI_STRONG_MODEL ?? "gemini-3.6-flash"
      : process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite-preview";
  const deadline = Date.now() + (tier === "strong" ? 115000 : 55000);
  let lastStatus = 0;
  for (let t = 0; t < 4; t++) {
    if (outer.aborted) return { error: "Cancelled" };
    const remaining = deadline - Date.now();
    if (remaining < 4000) break;
    try {
      const text = await callModel(model, history, remaining, outer);
      return { text, model };
    } catch (e) {
      lastStatus = e instanceof HttpError ? e.status : 0;
      if (outer.aborted) return { error: "Cancelled" };
      if (lastStatus >= 400 && lastStatus < 500 && lastStatus !== 429) return { error: (e as Error).message };
      await sleep(Math.min(3000 * (t + 1), deadline - Date.now() - 4000));
    }
  }
  return {
    error:
      lastStatus === 0
        ? "The AI took too long. Try again."
        : `The AI service is busy or over its limit (code ${lastStatus}). Wait a minute and try again.`,
  };
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const history = body?.history as Msg[] | undefined;
  const tier: "fast" | "strong" = body?.tier === "strong" ? "strong" : "fast";

  const valid =
    Array.isArray(history) &&
    history.length >= 1 &&
    history.length <= 10 &&
    history.every(
      (m, i) => m?.role === (i % 2 === 0 ? "user" : "model") && typeof m.text === "string" && m.text.length <= 20000
    ) &&
    history[history.length - 1].role === "user" &&
    history[0].text.trim().length > 0 &&
    history[0].text.length <= 1000;
  if (!valid) return Response.json({ error: "Bad request" }, { status: 400 });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (limited(ip)) {
    return Response.json({ error: "Too many requests. Please wait a few minutes." }, { status: 429 });
  }
  if (overDailyCap()) {
    return Response.json({ error: "The daily AI limit has been reached. Try again tomorrow." }, { status: 429 });
  }

  const hist = history as Msg[];
  const enc = new TextEncoder();
  // The response starts at once and sends a blank heartbeat every 8 s, so proxies don't drop a
  // slow AI call. The client reads the whole body and parses the JSON that follows the blanks.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const beat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(" "));
        } catch {
          /* client is gone */
        }
      }, 8000);
      try {
        const result = await design(hist, tier, req.signal);
        controller.enqueue(enc.encode(JSON.stringify(result)));
      } catch (e) {
        console.error(e);
        try {
          controller.enqueue(enc.encode(JSON.stringify({ error: "Unexpected server error" })));
        } catch {
          /* client is gone */
        }
      } finally {
        clearInterval(beat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}