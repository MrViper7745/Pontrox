"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const StlViewer = dynamic(() => import("@/components/StlViewer"), {
  ssr: false,
});

type Spec = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
};
type Part = { name: string; notes?: string; scad: string; params: Spec[] };

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [part, setPart] = useState<Part | null>(null);
  const [values, setValues] = useState<Record<string, number>>({});
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [generating, setGenerating] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState("");

  async function generate() {
    if (!prompt.trim()) return;
    setGenerating(true);
    setError("");
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const raw = await res.text();
let j;
try {
  j = JSON.parse(raw);
} catch {
  throw new Error(
    "The connection dropped before the answer arrived (probably too slow). Check the terminal and try again."
  );
}
      if (!res.ok) throw new Error(j.error ?? "Generation failed");
      setPart(j);
      setValues(Object.fromEntries(j.params.map((p: Spec) => [p.key, p.default])));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  // Rebuild the model shortly after a slider stops moving
  useEffect(() => {
    if (!part) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setRebuilding(true);
      try {
        const res = await fetch("/api/render", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scad: part.scad, params: part.params, values }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? "Render failed");
        }
        setData(await res.arrayBuffer());
        setError("");
        setRebuilding(false);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError((e as Error).message);
        setRebuilding(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [part, values]);

  return (
    <main className="flex h-screen flex-col md:flex-row">
      <aside className="flex w-full flex-col gap-3 overflow-y-auto border-b p-4 md:w-96 md:border-b-0 md:border-r">
        <h1 className="text-2xl font-bold">Pontrox</h1>
        <p className="text-sm text-gray-500">
          Describe a part. Get a printable 3D model.
        </p>

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
          {generating ? "Generating..." : "Generate"}
        </button>

        {part && (
          <>
            <hr />
            <h2 className="font-semibold">{part.name.replace(/_/g, " ")}</h2>
            {part.notes && (
              <p className="text-sm text-gray-500">{part.notes}</p>
            )}
            {part.params.map((s) => (
              <label key={s.key} className="text-sm">
                <div className="flex justify-between">
                  <span>{s.label}</span>
                  <span>{values[s.key]}</span>
                </div>
                <input
                  type="range"
                  className="w-full"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={values[s.key] ?? s.default}
                  onChange={(e) =>
                    setValues({ ...values, [s.key]: Number(e.target.value) })
                  }
                />
              </label>
            ))}
            <button
              onClick={() =>
                data && save(new Blob([data]), `${part.name}.stl`)
              }
              disabled={!data}
              className="rounded border px-3 py-2 disabled:opacity-40"
            >
              Download STL
            </button>
            <button
              onClick={() =>
                save(new Blob([part.scad]), `${part.name}.scad`)
              }
              className="rounded border px-3 py-2"
            >
              Download OpenSCAD code
            </button>
          </>
        )}

        <p className="min-h-5 text-sm">
          {rebuilding && "Rebuilding..."}
          {error && <span className="text-red-500">{error}</span>}
        </p>
      </aside>

      <section className="flex-1 bg-gray-100">
        <StlViewer data={data} />
      </section>
    </main>
  );
}