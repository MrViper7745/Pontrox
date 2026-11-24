import { layoutForPrint } from "./stl";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);

export type ParamSpec = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
};

const MAX_SCAD_CHARS = 20000;
const MAX_PARAMS = 12;

// Rejects code that could read files or run unreasonably heavy geometry.
export function validateScad(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Missing OpenSCAD code");
  }
  if (input.length > MAX_SCAD_CHARS) throw new Error("Code is too long");

  const code = input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  if (/\b(import|include|use|surface)\b/.test(code)) {
    throw new Error("File access is not allowed (import/include/use/surface)");
  }
  const tooFine = [...code.matchAll(/\$fn\s*=\s*(\d+)/g)].some(
    (m) => Number(m[1]) > 128
  );
  if (tooFine) throw new Error("$fn is too high (max 128)");

  return input;
}

export function validateParams(input: unknown): ParamSpec[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_PARAMS) {
    throw new Error("params must be a list of 1 to 12 items");
  }
  const seen = new Set<string>();
  return input.map((raw) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const key = String(p.key ?? "");
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/.test(key) || seen.has(key)) {
      throw new Error(`Bad parameter name: ${key}`);
    }
    seen.add(key);
    const min = Number(p.min);
    const max = Number(p.max);
    const step = Number(p.step);
    const def = Number(p.default);
    if (
      ![min, max, step, def].every(Number.isFinite) ||
      min >= max ||
      step <= 0 ||
      def < min ||
      def > max
    ) {
      throw new Error(`Bad range for parameter ${key}`);
    }
    return {
      key,
      label: String(p.label ?? key).slice(0, 40),
      min,
      max,
      step,
      default: def,
    };
  });
}

export async function renderScad(
  scad: string,
  specs: ParamSpec[],
  values: Record<string, unknown>
): Promise<Buffer> {
  const args: string[] = [];
  for (const s of specs) {
    const v = Number(values?.[s.key] ?? s.default);
    if (!Number.isFinite(v) || v < s.min || v > s.max) {
      throw new Error(`${s.label} must be between ${s.min} and ${s.max}`);
    }
    args.push("-D", `${s.key}=${v}`);
  }

  const id = randomUUID();
  const input = path.join(tmpdir(), `${id}.scad`);
  const output = path.join(tmpdir(), `${id}.stl`);

  try {
    await writeFile(input, scad);
    // execFile (no shell) + timeout
    await run("openscad", [...args, "-o", output, input], { timeout: 20000 });
    const stl = await readFile(output);
    if (stl.length < 100) throw new Error("The model is empty");
    return layoutForPrint(stl).stl;
  } catch (e) {
    const err = e as Error & { stderr?: string; killed?: boolean; code?: string };
    if (err.killed) throw new Error("Render took too long");
    if (err.code === "ENOENT") throw new Error("The model is empty or failed to build");
    const detail = String(err.stderr ?? err.message)
      .trim()
      .split("\n")
      .slice(-6)
      .join("\n");
    throw new Error(detail || "Render failed");
  } finally {
    unlink(input).catch(() => {});
    unlink(output).catch(() => {});
  }
}