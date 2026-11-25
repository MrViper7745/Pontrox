export type Spec = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
};

export type BuiltPart = { name: string; stl: ArrayBuffer; step: ArrayBuffer; size: number[] };
export type Built = { parts: BuiltPart[]; warning: string | null };

type Reply = { id: number; ok: boolean; error?: string; [k: string]: unknown };

export function validateParams(list: unknown): Spec[] {
  if (!Array.isArray(list) || list.length < 1 || list.length > 12) {
    throw new Error("params must be a list of 1 to 12 items");
  }
  const seen = new Set<string>();
  return list.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const key = String(r.key ?? "");
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/.test(key) || seen.has(key)) {
      throw new Error(`Bad parameter name: ${key}`);
    }
    seen.add(key);
    const min = Number(r.min), max = Number(r.max), step = Number(r.step), def = Number(r.default);
    if (![min, max, step, def].every(Number.isFinite) || min >= max || step <= 0 || def < min || def > max) {
      throw new Error(`Bad range for parameter ${key}`);
    }
    return { key, label: String(r.label ?? key).slice(0, 40), min, max, step, default: def };
  });
}

export class CadClient {
  private worker: Worker | null = null;
  private pending = new Map<
    number,
    { resolve: (m: Reply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private counter = 0;
  private uses = 0;

  private start() {
    const w = new Worker("/cad/worker.js", { type: "module" });
    w.onmessage = (e: MessageEvent<Reply>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(e.data.id);
      p.resolve(e.data);
    };
    w.onerror = (e) => this.reset(new Error("CAD engine error: " + (e.message || "failed to start")));
    this.worker = w;
  }

  private reset(reason: Error) {
    this.worker?.terminate();
    this.worker = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(reason);
      this.pending.delete(id);
    }
  }

  private call(msg: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    // Shapes in the CAD kernel are not garbage collected, so restart the engine now and then
    if (this.worker && this.pending.size === 0 && this.uses > 60) {
      this.reset(new Error("restart"));
      this.uses = 0;
    }
    if (!this.worker) this.start();
    const id = ++this.counter;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(
        () => this.reset(new Error("The CAD engine took too long and was restarted")),
        timeoutMs
      );
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ id, ...msg });
    });
  }

  async warmup() {
    const r = await this.call({ type: "init" }, 120000);
    if (!r.ok) throw new Error(String(r.error));
  }

  async validate(code: string, params: Spec[]) {
    this.uses++;
    const r = await this.call({ type: "validate", code, params }, 90000);
    if (!r.ok) throw new Error(String(r.error));
  }

  async build(code: string, values: Record<string, number>): Promise<Built> {
    this.uses++;
    const r = await this.call({ type: "build", code, values }, 60000);
    if (!r.ok) throw new Error(String(r.error));
    return { parts: r.parts as BuiltPart[], warning: (r.warning as string | null) ?? null };
  }

  dispose() {
    this.reset(new Error("disposed"));
  }
}