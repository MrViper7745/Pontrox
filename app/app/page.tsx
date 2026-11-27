"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { CadClient, validateParams, type Built } from "@/lib/cadClient";
import { DEFAULT_PRINTER, PRINTERS, type Bed } from "@/lib/printers";
import { saveBuffer, saveZip } from "@/lib/download";
import { clearSession, loadSession, saveSession, type Msg, type Part, type Version } from "@/lib/session";
import { BedPicker, ChecksList, ParamSliders, PartsList, Stepper, type Stage } from "@/components/ui";

const StlViewer = dynamic(() => import("@/components/StlViewer"), { ssr: false });

type Parsed = ReturnType<typeof parseReply>;

const MAX_ATTEMPTS = 4;
const EXAMPLES = [
  "Box with a snap-on lid, 80 x 50 x 30 mm",
  "Wall bracket for a 25 mm pipe, holds 2 kg",
  "Cable clip for a 6 mm cable",
  "Gear with 20 teeth",
  "Wall hook that holds 2 kg",
  "Phone stand with adjustable angle",
];
const QUICK_CHANGES = ["Make it 20% smaller", "Make the walls thicker", "Round the corners", "Add two screw holes"];

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

function abortError() {
  const e = new Error("Cancelled");
  e.name = "AbortError";
  return e;
}

export default function Home() {
  const cadRef = useRef<CadClient | null>(null);
  const buildSeq = useRef(0);
  const versionSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const [hydrated, setHydrated] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [status, setStatus] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");

  const [part, setPart] = useState<Part | null>(null);
  const [base, setBase] = useState<Msg[] | null>(null);
  const [values, setValues] = useState<Record<string, number>>({});
  const [built, setBuilt] = useState<Built | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);

  const [printerId, setPrinterId] = useState(DEFAULT_PRINTER);
  const [custom, setCustom] = useState<Bed>([220, 220, 250]);
  const [showBed, setShowBed] = useState(false);
  const [showEdges, setShowEdges] = useState(true);

  const bed: Bed = useMemo(() => {
    if (printerId === "custom") return custom;
    return (PRINTERS.find((p) => p.id === printerId) ?? PRINTERS[0]).bed;
  }, [printerId, custom]);
  const bedKey = bed.join("x");
  const refining = part !== null && base !== null;

  function cad() {
    if (!cadRef.current) cadRef.current = new CadClient();
    return cadRef.current;
  }

  // Restore the printer choice and the last design from this browser
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("pontrox-printer") ?? "null");
      if (saved?.id && PRINTERS.some((p) => p.id === saved.id)) setPrinterId(saved.id);
      if (Array.isArray(saved?.custom) && saved.custom.length === 3) setCustom(saved.custom);
    } catch {
      /* ignore */
    }
    const s = loadSession();
    if (s) {
      versionSeq.current = s.versionSeq;
      setPart(s.part);
      setValues(s.values);
      setBase(s.base);
      setVersions(s.versions);
      setActiveId(s.activeId);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("pontrox-printer", JSON.stringify({ id: printerId, custom }));
    } catch {
      /* ignore */
    }
  }, [printerId, custom]);

  // Autosave the design after every change
  useEffect(() => {
    if (!hydrated) return;
    if (!part || !base) {
      clearSession();
      return;
    }
    saveSession({ part, values, base, versions: versions.slice(-20), activeId, versionSeq: versionSeq.current });
  }, [hydrated, part, values, base, versions, activeId]);

  // Load the CAD engine while the user is still typing
  useEffect(() => {
    cad().warmup().catch(() => {});
    return () => {
      cadRef.current?.dispose();
      cadRef.current = null;
    };
  }, []);

  // Asks the AI, checks the result in the browser, retries with feedback (stronger model from try 3)
  async function runDesign(history: Msg[], signal: AbortSignal, forceStrong: boolean) {
    const addLog = (l: string) => setLog((x) => [...x, l]);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal.aborted) throw abortError();
      const tier = forceStrong || attempt > 2 ? "strong" : "fast";
      setStage("design");
      setStatus(
        `Designing, try ${attempt} of ${MAX_ATTEMPTS}${tier === "strong" ? " (stronger model, this can take a minute)" : ""}...`
      );
      const res = await fetch("/api/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history, tier }),
        signal,
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
        setStage("check");
        setStatus(`Checking every slider position (try ${attempt})...`);
        await cad().validate(parsed.code, parsed.params, bed);
        if (signal.aborted) throw abortError();
        addLog(`Try ${attempt} (${tier} model): passed all checks`);
        return { parsed, reply };
      } catch (err) {
        if (signal.aborted) throw abortError();
        const msg = (err as Error).message;
        addLog(`Try ${attempt} (${tier} model) failed: ${msg.slice(0, 160)}`);
        history.push(
          { role: "model", text: reply },
          { role: "user", text: `That attempt failed: ${msg}\nFix it and return the full JSON again.` }
        );
      }
    }
    throw new Error("Could not build that. Try describing it more simply.");
  }

  function applyDesign(parsed: Parsed, newBase: Msg[], label: string) {
    const p: Part = { name: parsed.name, notes: parsed.notes, code: parsed.code, params: parsed.params };
    const v = Object.fromEntries(parsed.params.map((s) => [s.key, s.default]));
    const id = ++versionSeq.current;
    setBuilt(null);
    setPart(p);
    setValues(v);
    setBase(newBase);
    setVersions((list) => [...list, { id, label, part: p, values: v, base: newBase }]);
    setActiveId(id);
  }

  function refineText(change: string) {
    const current = Object.entries(values)
      .map(([k, v]) => `${k} = ${v}`)
      .join(", ");
    return (
      `Change request for the design above: ${change}\n` +
      `The user's sliders are currently set to: ${current}. Use these as the new defaults unless the change request says otherwise (keep every default inside its range).\n` +
      `Return the complete updated JSON (all params and the full code). Keep everything the user did not mention unchanged.`
    );
  }

  async function submit(forceStrong = false) {
    const text = prompt.trim();
    if (!text || generating) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setGenerating(true);
    setError("");
    setLog([]);
    try {
      const first = refining && base ? base[0].text : text;
      const history: Msg[] =
        refining && base ? [...base, { role: "user", text: refineText(text) }] : [{ role: "user", text }];
      const { parsed, reply } = await runDesign(history, ctrl.signal, forceStrong);
      applyDesign(
        parsed,
        [
          { role: "user", text: first },
          { role: "model", text: reply },
        ],
        text
      );
      setStage("done");
      setPrompt("");
    } catch (e) {
      const err = e as Error;
      setError(err.name === "AbortError" ? "Cancelled." : err.message);
      setStage("idle");
    } finally {
      abortRef.current = null;
      setGenerating(false);
      setStatus("");
    }
  }

  function newDesign() {
    setPart(null);
    setBase(null);
    setBuilt(null);
    setVersions([]);
    setActiveId(null);
    setLog([]);
    setError("");
    setStage("idle");
    setPrompt("");
  }

  function restore(v: Version) {
    setBuilt(null);
    setPart(v.part);
    setValues(v.values);
    setBase(v.base);
    setActiveId(v.id);
  }

  // Rebuild shortly after a slider (or the printer) changes
  useEffect(() => {
    if (!part) return;
    const mine = ++buildSeq.current;
    const timer = setTimeout(async () => {
      setRebuilding(true);
      try {
        const r = await cad().build(part.code, values, bed);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part, values, bedKey]);

  async function downloadAll() {
    if (!part || !built) return;
    const files: Record<string, ArrayBuffer | string> = {};
    for (const p of built.parts) {
      files[`${part.name}-${p.name}.step`] = p.step;
      files[`${part.name}-${p.name}.stl`] = p.stl;
    }
    files[`${part.name}-recipe.json`] = JSON.stringify(
      { name: part.name, notes: part.notes, params: part.params, values, code: part.code },
      null,
      2
    );
    await saveZip(files, `${part.name}.zip`);
  }

  const allPass = !!built && built.checks.length > 0 && built.checks.every((c) => c.status === "pass");

  return (
    <main className="flex h-screen flex-col md:flex-row">
      <aside className="flex w-full flex-col gap-3 overflow-y-auto border-b p-4 md:w-[26rem] md:shrink-0 md:border-b-0 md:border-r [&>*]:shrink-0">
        <div>
          <h1 className="text-2xl font-bold">Pontrox</h1>
          <p className="text-sm text-gray-500">Describe a part. Get an editable 3D model.</p>
        </div>

        <label className="text-sm font-medium" htmlFor="prompt">
          {refining ? "Describe a change" : "What do you want to make?"}
        </label>
        <textarea
          id="prompt"
          className="h-24 rounded border bg-transparent p-2 text-sm"
          placeholder={
            refining
              ? "e.g. Make the lid fit tighter and add two screw holes"
              : "e.g. A box with a snap-on lid, 80 x 50 x 30 mm"
          }
          maxLength={refining ? 500 : 1000}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
          }}
        />
        <div className="flex gap-2">
          {generating ? (
            <button
              onClick={() => abortRef.current?.abort()}
              className="flex-1 rounded border border-red-500 px-3 py-2 text-red-500"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={() => submit()}
              disabled={!prompt.trim()}
              className="flex-1 rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50"
            >
              {refining ? "Apply change" : "Generate"}
            </button>
          )}
          {refining && (
            <button onClick={newDesign} disabled={generating} className="rounded border px-3 py-2 text-sm disabled:opacity-50">
              New design
            </button>
          )}
        </div>
        <p className="text-xs text-gray-500">Tip: press Ctrl+Enter to send.</p>

        {!part && !generating && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-gray-500">Try an example:</p>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => setPrompt(ex)} className="rounded-full border px-3 py-1 text-xs">
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        {part && !generating && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-gray-500">Quick changes (then press Apply):</p>
            <div className="flex flex-wrap gap-2">
              {QUICK_CHANGES.map((q) => (
                <button key={q} onClick={() => setPrompt(q)} className="rounded-full border px-3 py-1 text-xs">
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        <Stepper stage={stage} />
        {status && <p className="text-sm">{status}</p>}
        {log.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-gray-500">What happened ({log.length})</summary>
            <ul className="mt-1 space-y-1 text-xs text-gray-500">
              {log.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </details>
        )}
        {error && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-red-500">{error}</p>
            {!generating && prompt.trim() && error !== "Cancelled." && (
              <button onClick={() => submit(true)} className="rounded border px-3 py-1 text-sm">
                Try again with the stronger model
              </button>
            )}
          </div>
        )}

        {part && (
          <>
            <hr />
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold">{part.name.replace(/_/g, " ")}</h2>
              {allPass && (
                <span className="rounded-full bg-green-600/20 px-2 py-0.5 text-xs text-green-500">Passed print checks</span>
              )}
            </div>
            {part.notes && <p className="text-sm text-gray-500">{part.notes}</p>}
            <ParamSliders
              specs={part.params}
              values={values}
              onChange={(k, v) => setValues((x) => ({ ...x, [k]: v }))}
              onReset={() => setValues(Object.fromEntries(part.params.map((s) => [s.key, s.default])))}
            />
            <p className="min-h-5 text-sm text-gray-500">{rebuilding ? "Rebuilding..." : ""}</p>

            {versions.length > 1 && (
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-medium">Versions</h3>
                {versions.map((v, i) => (
                  <button
                    key={v.id}
                    onClick={() => restore(v)}
                    className={`rounded border px-2 py-1 text-left text-xs ${v.id === activeId ? "border-blue-500" : ""}`}
                  >
                    {i + 1}. {v.label.slice(0, 60)}
                  </button>
                ))}
              </div>
            )}

            <details>
              <summary className="cursor-pointer text-xs text-gray-500">Show the design code</summary>
              <pre className="mt-1 max-h-64 overflow-auto rounded border p-2 text-xs">{part.code}</pre>
            </details>
          </>
        )}
      </aside>

      <section className="flex min-h-0 flex-1 flex-col">
        <BedPicker
          printerId={printerId}
          custom={custom}
          showBed={showBed}
          showEdges={showEdges}
          onPrinter={setPrinterId}
          onCustom={setCustom}
          onShowBed={setShowBed}
          onShowEdges={setShowEdges}
        />
        <div className="relative min-h-[280px] flex-1 bg-gray-100">
          <div className="absolute inset-0">
            <StlViewer
              data={built ? built.parts.map((p) => p.stl) : null}
              bed={showBed ? { w: bed[0], d: bed[1] } : null}
              edges={showEdges}
            />
          </div>
        </div>
        {part && (
          <div className="grid max-h-72 shrink-0 gap-4 overflow-y-auto border-t p-3 md:grid-cols-2">
            <PartsList parts={built?.parts ?? []} baseName={part.name} onSave={saveBuffer} onAll={downloadAll} />
            <ChecksList checks={built?.checks ?? []} />
          </div>
        )}
      </section>
    </main>
  );
}