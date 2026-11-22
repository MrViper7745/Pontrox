import { validateScad, validateParams, renderScad } from "@/lib/openscad";

type Msg = { role: "user" | "model"; text: string };

const SYSTEM = `You are a CAD assistant that writes OpenSCAD (version 2021.01 syntax, no experimental features) for 3D-printable parts.

Return ONLY a JSON object, no markdown, in this exact shape:
{
  "name": "short_snake_case_name",
  "notes": "one or two sentences: assumptions you made",
  "scad": "the complete OpenSCAD code as a string",
  "params": [
    { "key": "wall", "label": "Wall thickness", "min": 1, "max": 6, "step": 0.5, "default": 2 }
  ]
}

Rules:
- Units are millimetres.
- Every entry in "params" must be a plain numeric variable assigned at the TOP of the scad code with the same default, e.g. "wall = 2;". Use 3 to 10 params for the dimensions a user would want to adjust.
- Choose sensible min/max ranges; default must lie inside them. The part must stay valid at every value in the range.
- Minimum wall thickness 1.2 mm. Add 0.2 mm clearance where printed parts fit together.
- Design for printing: the part sits flat on the build plate, avoid needing supports where possible.
- Use $fn = 64 for round shapes (never above 96).
- Do NOT use import, include, use, or surface.
- If the description is vague, make reasonable assumptions and state them in "notes".
- If a previous attempt failed, fix the problem and return the full JSON again.`;

async function askGemini(history: Msg[]): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        // Instructions go inside the first message, which works on every model
        contents: history.map((m, i) => ({
          role: m.role,
          parts: [
            {
              text:
                i === 0
                  ? `${SYSTEM}\n\nUser request:\n${m.text}`
                  : m.text,
            },
          ],
        })),
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
      }),
    }
  );

  if (!res.ok) {
    console.error("Gemini error", res.status, await res.text());
    throw new Error(`AI service error (${res.status}). Check the terminal.`);
  }
   const json = await res.json();
  const candidate = json?.candidates?.[0];
  const parts: { text?: string }[] = candidate?.content?.parts ?? [];
  const out = parts.map((p) => p.text ?? "").join("");

  if (!out.trim()) {
    console.error(
      "Empty AI reply:",
      JSON.stringify(
        {
          finishReason: candidate?.finishReason,
          promptFeedback: json?.promptFeedback,
          usage: json?.usageMetadata,
        },
        null,
        2
      )
    );
    throw new Error("The AI returned an empty reply. Check the terminal.");
  }
  return out;
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

  // Up to 3 attempts: if the code doesn't build, feed the error back to the AI.
  for (let attempt = 0; attempt < 3; attempt++) {
    let text: string;
    try {
      text = await askGemini(history);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 502 });
    }

    try {
      const start = text.indexOf("{");
const end = text.lastIndexOf("}");
if (start < 0 || end <= start) throw new Error("Reply was not valid JSON");
const parsed = JSON.parse(text.slice(start, end + 1));
      const scad = validateScad(parsed.scad);
      const params = validateParams(parsed.params);

      // Prove it builds at the default values before showing it to the user
      await renderScad(scad, params, {});

      return Response.json({
        name: String(parsed.name ?? "part").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "part",
        notes: String(parsed.notes ?? "").slice(0, 400),
        scad,
        params,
      });
    } catch (e) {
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
    { error: "Could not build that part. Try describing it more simply." },
    { status: 422 }
  );
}