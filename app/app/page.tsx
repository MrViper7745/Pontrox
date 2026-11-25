"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { CadClient, validateParams, type Built, type Spec } from "@/lib/cadClient";

const StlViewer = dynamic(() => import("@/components/StlViewer"), { ssr: false });

type Msg = { role: "user" | "model"; text: string };
type Part = { name: string; notes: string; code: string; params: Spec[] };

const MAX_ATTEMPTS = 4;

function save(buf: ArrayBuffer, filename: string) {
  const url = URL.createObjectURL(new Blob([buf]));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function parseReply(text: string) {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("Reply was not valid JSON");
  const parsed = JSON.parse(text.slice(s, e + 1));
  const params = validateParams(parsed.params);
  const code = String(parsed.code ?? "");
  if (!code.trim()) throw new Error("The code is empty");
  const name = String(parsed.name ?? "part").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "part";
  return { name, notes: String(parsed.notes ?? "").slice(0, 400), params, code };
}

export default function Home() {
  const cadRef = useRef<CadClient | null>(null);
  const buildSeq = useRef(0);
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [status, setStatus] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [part, setPart] = useState<Part | null>(null);
  const [values, setValues] = useState<Record<string, number>>({});
  const [built, setBuilt] = useState<Built | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  function cad() {
    if (!cadRef.current) cadRef.current = new CadClient();
    return cadRef.current;
  }

  // Load the CAD engine while the user is still typing
  useEffect(() => {
    cad().warmup().catch(() => {});
    return () => {
      cadRef.current?.dispose();
      cadRef.current = null;
    };
  }, []);

  async function generate() {
    const first = prompt.trim();
    if (!first || generating) return;
    setGenerating(true);
    setError("");
    setLog([]);
    const history: Msg[] = [{ role: "user", text: first }];
    const addLog = (l: string) => setLog((x) => [...x, l]);

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const tier = attempt <= 2 ? "fast" : "strong";
        setStatus(`Designing (attempt ${attempt} of ${MAX_ATTEMPTS}, ${tier} model)...`);
        const res = await fetch("/api/design", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ history, tier }),
        });
        const raw = await res.text();
        let j: { text?: string; error?: string };
        try {
          j = JSON.parse(raw);
        } catch {
          throw new Error("The connection dropped before the answer arrived. Please try again.");
        }
        if (!res.ok || !j.text) throw new Error(j.error ?? "The AI service failed");
        const reply = j.text;

        try {
          const parsed = parseReply(reply);
          setStatus(`Checking the design (attempt ${attempt})...`);
          await cad().validate(parsed.code, parsed.params);
          setBuilt(null);
          setPart({ name: parsed.name, notes: parsed.notes, code: parsed.code, params: parsed.params });
          setValues(Object.fromEntries(parsed.params.map((p) => [p.key, p.default])));
          addLog(`Attempt ${attempt}: passed all checks`);
          return;
        } catch (err) {
          const msg = (err as Error).message;
          addLog(`Attempt ${attempt} failed: ${msg.slice(0, 160)}`);
          history.push(
            { role: "model", text: reply },
            { role: "user", text: `That attempt failed: ${msg}\nFix it and return the full JSON again.` }
          );
        }
      }
      throw new Error("Could not build that part. Try describing it more simply.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
      setStatus("");
    }
  }

  // Rebuild shortly after a slider stops moving
  useEffect(() => {
    if (!part) return;
    const mine = ++buildSeq.current;
    const timer = setTimeout(async () => {
      setRebuilding(true);
      try {
        const r = await cad().build(part.code, values);
        if (mine !== buildSeq.current) return;
        setBuilt(r);
        setError("");
      } catch (e) {
        if (mine === buildSeq.current) setError((e as Error).message);
      } finally {
        if (mine === buildSeq.current) setRebuilding(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [part, values]);

  return (
    <main className="flex h-screen flex-col md:flex-row">
      <aside className="flex w-full flex-col gap-3 overflow-y-auto border-b p-4 md:w-96 md:border-b-0 md:border-r [&>*]:shrink-0">
        <h1 className="text-2xl font-bold">Pontrox</h1>
        <p className="text-sm text-gray-500">Describe a part. Get an editable 3D model.</p>

        <textarea
          className="h-28 rounded border p-2 text-sm"
          placeholder="e.g. A box with a snap-on lid, 80 x 50 x 30 mm"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button
          onClick={generate}
          disabled={generating || !prompt.trim()}
          className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50"
        >
          {generating ? "Working..." : "Generate"}
        </button>

        {status && <p className="text-sm">{status}</p>}
        {log.length > 0 && (
          <ul className="space-y-1 text-xs text-gray-500">
            {log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}

        {part && (
          <>
            <hr />
            <h2 className="font-semibold">{part.name.replace(/_/g, " ")}</h2>
            {part.notes && <p className="text-sm text-gray-500">{part.notes}</p>}
            {part.params.map((s) => (
              <label key={s.key} className="text-sm">
                <div className="flex justify-between">
                  <span>{s.label}</span>
                  <span>{values[s.key] ?? s.default}</span>
                </div>
                <input
                  type="range"
                  className="w-full"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={values[s.key] ?? s.default}
                  onChange={(e) => setValues({ ...values, [s.key]: Number(e.target.value) })}
                />
              </label>
            ))}
            <p className="min-h-5 text-sm text-gray-500">{rebuilding ? "Rebuilding..." : ""}</p>
            {built?.warning && <p className="text-sm text-amber-500">Heads up: {built.warning}</p>}
            {built?.parts.map((p) => (
              <div key={p.name} className="flex flex-col gap-2 rounded border p-2 text-sm">
                <span className="font-medium">
                  {p.name} ({p.size.map((n) => n.toFixed(0)).join(" x ")} mm)
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => save(p.step, `${part.name}-${p.name}.step`)}
                    className="flex-1 rounded border px-2 py-1"
                  >
                    Download STEP
                  </button>
                  <button
                    onClick={() => save(p.stl, `${part.name}-${p.name}.stl`)}
                    className="flex-1 rounded border px-2 py-1"
                  >
                    Download STL
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </aside>

      <section className="flex-1 bg-gray-100">
        <StlViewer data={built ? built.parts.map((p) => p.stl) : null} />
      </section>
    </main>
  );
}