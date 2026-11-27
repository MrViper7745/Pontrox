import { validateParams, type Spec } from "./cadClient";

export type Msg = { role: "user" | "model"; text: string };
export type Part = { name: string; notes: string; code: string; params: Spec[] };
export type Version = { id: number; label: string; part: Part; values: Record<string, number>; base: Msg[] };
export type Saved = {
  part: Part;
  values: Record<string, number>;
  base: Msg[];
  versions: Version[];
  activeId: number | null;
  versionSeq: number;
};

export const SESSION_KEY = "pontrox-session-v1";

function cleanPart(p: unknown): Part | null {
  try {
    const r = p as Part;
    if (typeof r?.code !== "string" || !r.code.trim()) return null;
    return {
      name: String(r.name ?? "part").slice(0, 40),
      notes: String(r.notes ?? "").slice(0, 400),
      code: r.code,
      params: validateParams(r.params),
    };
  } catch {
    return null;
  }
}

function cleanBase(b: unknown): Msg[] | null {
  if (!Array.isArray(b) || b.length !== 2) return null;
  const ok = b.every((m, i) => m && m.role === (i === 0 ? "user" : "model") && typeof m.text === "string");
  return ok ? (b as Msg[]) : null;
}

function cleanValues(v: unknown, part: Part): Record<string, number> {
  const src = (v ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    part.params.map((s) => {
      const n = Number(src[s.key]);
      return [s.key, Number.isFinite(n) ? Math.min(s.max, Math.max(s.min, n)) : s.default];
    })
  );
}

export function loadSession(): Saved | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    const part = cleanPart(s?.part);
    const base = cleanBase(s?.base);
    if (!part || !base) return null;
    const versions: Version[] = [];
    for (const v of Array.isArray(s.versions) ? s.versions : []) {
      const vp = cleanPart(v?.part);
      const vb = cleanBase(v?.base);
      if (!vp || !vb || !Number.isFinite(Number(v.id))) continue;
      versions.push({ id: Number(v.id), label: String(v.label ?? "").slice(0, 120), part: vp, values: cleanValues(v.values, vp), base: vb });
    }
    return {
      part,
      base,
      values: cleanValues(s.values, part),
      versions,
      activeId: Number.isFinite(Number(s.activeId)) ? Number(s.activeId) : null,
      versionSeq: Number.isFinite(Number(s.versionSeq)) ? Number(s.versionSeq) : versions.length,
    };
  } catch {
    return null;
  }
}

export function saveSession(s: Saved) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked: ignore */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}