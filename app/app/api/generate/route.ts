import { validateScad, validateParams, renderScad } from "@/lib/openscad";
import { layoutForPrint, checkParts } from "@/lib/stl";

type Msg = { role: "user" | "model"; text: string };

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const SYSTEM = `You are a CAD assistant that writes OpenSCAD (version 2021.01 syntax, no experimental features) for 3D-printable parts.

Return ONLY a JSON object, no markdown, in this exact shape:
{
  "name": "short_snake_case_name",
  "notes": "one or two sentences: assumptions you made",
  "pieces": 2,
  "scad": "the complete OpenSCAD code as a string",
  "params": [
    { "key": "wall", "label": "Wall thickness", "min": 1, "max": 6, "step": 0.5, "default": 2 }
  ]
}

Rules:
- Units are millimetres.
- Every entry in "params" must be a plain numeric variable assigned at the TOP of the scad code with the same default, e.g. "wall = 2;".
- Make every main dimension its own parameter (overall length, width, height, diameter, hole sizes, wall thickness). If the user gave a size, use it as the default; otherwise choose a typical size. Never hardcode a dimension the user might want to change.
- Use at least 4 parameters for any functional part, unless it is truly trivial.
- Set each range from about half to about double the default, and make sure the part stays valid at both ends.
- Minimum wall thickness 1.2 mm. Add 0.2 mm clearance where printed parts fit together.
- Design for printing: avoid needing supports where possible. Model each part in the orientation it should be printed, with its largest flat face down.
- Use $fn = 64 for round shapes (never above 96).
- Do NOT use import, include, use, or surface.
- Prefer building a part's outline in 2D: union() overlapping circle(), square() and polygon() shapes, then linear_extrude() or rotate_extrude() the result. This guarantees one connected solid. If you must join separate 3D shapes, overlap them by at least 1 mm.
- Gears: build the 2D outline, for example  linear_extrude(thickness) difference() { union() { circle(r = root_radius); for (i = [0 : teeth - 1]) rotate(i * 360 / teeth) translate([root_radius - 1, -tooth_width / 2]) square([tooth_height + 1, tooth_width]); } circle(r = bore / 2); }  where the teeth start 1 mm inside the root circle so they fuse with it. Derive root_radius, tooth_height and tooth_width from the number of teeth and the module.
- "pieces" is the number of separate printable parts the design produces (1 for a gear, 2 for a box plus its lid).
- Each printable part must be ONE connected solid. Overlap joined shapes by at least 0.5 mm inside union() so they fuse (for example, gear teeth must overlap the gear body).
- Separate printable parts must not touch or overlap each other. You do not need to arrange them on the build plate: the software places each part flat on the plate and spaces them automatically.
- Never drop a feature the user asked for just to satisfy these rules. An adjustable stand must keep a real adjustment mechanism, a snap-on lid must have a snap lip, a pipe bracket must actually wrap the pipe, a hook must have a hook shape. Keep every part a sensible, printable thickness (at least 2 mm for structural parts).
- If the description is vague, make reasonable assumptions and state them in "notes".
- If a previous attempt failed, fix the problem and return the full JSON again.`;

// Primary model first, then fallbacks if Google reports it is overloaded.
const MODELS = [
  ...new Set([
    process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite",
    ...(
      process.env.GEMINI_FALLBACK_MODELS ??
      "gemini-3.1-flash-lite-preview,gemini-3.6-flash"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ]),
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callModel(
  model: string,
  history: Msg[],
  timeoutMs: number
): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new ApiError(500, "GEMINI_API_KEY is not set");
  const t0 = Date.now();

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: history.map((m, i) => ({
          role: m.role,
          parts: [
            { text: i === 0 ? `${SYSTEM}\n\nUser request:\n${m.text}` : m.text },
          ],
        })),
        generationConfig: {
          maxOutputTokens: 16384,
          responseMimeType: "application/json",
          // Bigger models "think" by default, which is slow. Lite models don't.
          ...(/lite/i.test(model)
            ? {}
            : { thinkingConfig: { thinkingLevel: "low" } }),
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    console.error(`Gemini ${model} error ${res.status}:`, body.slice(0, 300));
    throw new ApiError(res.status, `AI service error (${res.status})`);
  }

  const json = await res.json();
  const candidate = json?.candidates?.[0];
  const parts: { text?: string }[] = candidate?.content?.parts ?? [];
  const out = parts.map((p) => p.text ?? "").join("");

  console.log(
    `Gemini ${model}: ${((Date.now() - t0) / 1000).toFixed(1)}s, ` +
      `${json?.usageMetadata?.candidatesTokenCount ?? "?"} output tokens, ` +
      `${json?.usageMetadata?.thoughtsTokenCount ?? 0} thinking tokens`
  );

  if (!out.trim()) {
    console.error("Empty AI reply:", candidate?.finishReason);
    throw new ApiError(502, "The AI returned an empty reply");
  }
  return out;
}

// Tries each model twice. Gives up at once on errors retrying can't fix (bad key, bad model name).
async function askGemini(history: Msg[]): Promise<string> {
  const deadline = Date.now() + 60000;
  let last: Error = new Error("AI service unavailable");

  for (const model of MODELS) {
    for (let t = 0; t < 2; t++) {
      const remaining = deadline - Date.now();
      if (remaining < 3000) throw last;
      try {
        return await callModel(model, history, Math.min(45000, remaining));
      } catch (e) {
        last = e as Error;
        const status = e instanceof ApiError ? e.status : 0;
        if (status >= 400 && status < 500 && status !== 429) throw e;
        console.log(
          `${model} unavailable (${status || "timeout/network"}), ${t === 0 ? "retrying" : "trying next model"}`
        );
        if (t === 0) await sleep(1500);
      }
    }
  }
  throw last;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > 1000) {
    return Response.json(
      { error: "Describe your part in 1 to 1000 characters" },
      { status: 400 }
    );
  }

  const history: Msg[] = [{ role: "user", text: prompt }];
  const failures: string[] = [];
  let lastCode = "";
  const started = Date.now();

  // Up to 3 attempts: if the part fails a check, feed the problem back to the AI.
  for (let attempt = 0; attempt < 3 && Date.now() - started < 70000; attempt++) {
    let text: string;
    try {
      text = await askGemini(history);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      const busy = status === 503 || status === 429 || status === 0;
      return Response.json(
        {
          error: busy
            ? "The AI service is busy right now. Wait a minute and try again."
            : (e as Error).message,
        },
        { status: 502 }
      );
    }

    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end <= start) throw new Error("Reply was not valid JSON");
      const parsed = JSON.parse(text.slice(start, end + 1));

            let code = String(parsed.scad ?? "");
      code = code.replace(/^\s*```[a-z]*\s*\n?/i, "").replace(/\n?\s*```\s*$/, "");
      if (!code.includes("\n") && code.includes("\\n")) {
        code = code.replace(/\\n/g, "\n");
      }
      lastCode = code;
      const scad = validateScad(code);

      const params = validateParams(parsed.params);
      const expected = Math.round(Number(parsed.pieces));
      if (!Number.isInteger(expected) || expected < 1 || expected > 6) {
        throw new Error('"pieces" must be a whole number from 1 to 6');
      }

      // Build it, lay the parts out on the bed, then check the result
      const stl = await renderScad(scad, params, {});
      const problem = checkParts(layoutForPrint(stl).pieces, expected);
      if (problem) throw new Error(problem);

      return Response.json({
        name:
          String(parsed.name ?? "part")
            .replace(/[^a-zA-Z0-9_-]/g, "")
            .slice(0, 40) || "part",
        notes: String(parsed.notes ?? "").slice(0, 400),
        scad,
        params,
        attempts: attempt + 1,
      });
       } catch (e) {
      console.log(`Attempt ${attempt + 1} failed:`, (e as Error).message);
      if ((e as Error).message.includes("Parser error")) {
        console.log("Code started with:", JSON.stringify(lastCode.slice(0, 150)));
      }
      failures.push((e as Error).message);
      history.push(
        { role: "model", text },
        {
          role: "user",
          text: `That attempt failed: ${(e as Error).message}\nFix it and return the full JSON again.`,
        }
      );
    }
  }

  return Response.json(
    {
      error: "Could not build that part. Try describing it more simply.",
      detail: failures,
    },
    { status: 422 }
  );
}