# Run from /workspaces/Pontrox:
#   .venv/bin/python tests/cq_gen.py
#   ONLY=2,5 .venv/bin/python tests/cq_gen.py          (only those prompts)
#   GEMINI_MODEL=gemini-3.1-flash-lite-preview .venv/bin/python tests/cq_gen.py
# WARNING: runs AI-written Python with exec(), which is NOT a sandbox.
# Fine for a local experiment on your own machine; never expose this to other users.
import builtins
import json
import math
import os
import re
import shutil
import signal
import time
import urllib.error
import urllib.request

import cadquery as cq

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tests", "out", "cadquery")
GAP = 10
BED = (220, 220, 250)


def load_env():
    path = os.path.join(ROOT, "app", ".env.local")
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-lite")
ONLY = [int(x) for x in os.environ["ONLY"].split(",")] if os.environ.get("ONLY") else None

PROMPTS = [
    "Box with a snap-on lid, 80 x 50 x 30 mm",
    "Wall bracket for a 25 mm pipe, holds 2 kg",
    "Cable clip for a 6 mm cable",
    "Gear with 20 teeth",
    "Wall hook that holds 2 kg",
    "Enclosure for an Arduino Uno with port cutouts",
    "Plant pot with drainage holes and a saucer",
    "Phone stand with adjustable angle",
]

SYSTEM = """You write CadQuery (Python) code for 3D-printable, editable CAD parts.

Return ONLY a JSON object, no markdown:
{
  "name": "short_snake_case_name",
  "notes": "assumptions, one or two sentences",
  "params": [ { "key": "wall", "label": "Wall thickness", "min": 1, "max": 6, "step": 0.5, "default": 2 } ],
  "code": "Python code as a string"
}

How "code" works:
- It is a Python script body. cq (cadquery) and math are already imported: do not write import statements, and do not use open, os, sys, eval or exec.
- The numbers from params are in the dict p, for example p["wall"].
- It must end by assigning a dict named result with one entry per separate printable part, for example result = {"box": box_wp, "lid": lid_wp} (1 entry for a gear, 2 for a box and its lid). Each value is a cq.Workplane. Each part must be ONE connected solid.
- The software places the parts flat on the build plate itself, so do not position parts for the plate. Positions only matter inside one part.

CadQuery quick reference (millimetres):
- Boxes: cq.Workplane("XY").box(length, width, height, centered=(True, True, False)) puts the base at z = 0.
- 2D shapes then extrude (+z): cq.Workplane("XY").rect(w, h).extrude(height); .circle(r).extrude(height); .polyline([(x, y), ...]).close().extrude(height).
- Several shapes at once: .pushPoints([(x, y), ...]).circle(r); a ring of shapes: .polarArray(radius, 0, 360, count).rect(w, h).
- Holes and cuts: .faces(">Z").workplane().hole(diameter); or build a tool solid and use a.cut(tool).
- Boolean: a.union(b), a.cut(b), a.intersect(b).
- Move: .translate((x, y, z)), .rotate((0, 0, 0), (0, 0, 1), angle_degrees), .mirror("YZ").
- Edges (optional, can fail on complex shapes): .edges("|Z").fillet(r), .edges(">Z").chamfer(c), .faces(">Z").shell(-thickness).
- Round parts: cq.Workplane("XZ").polyline(points).close().revolve(360, (0, 0, 0), (0, 1, 0)).

Rules:
- Every param needs min, max, step and a default inside the range. Use at least 4 params (overall length, width, height, hole sizes, wall thickness). Never hardcode a dimension a user might want to change.
- The part must stay valid at every value from min to max.
- Minimum wall 1.2 mm. Add 0.2 mm clearance where printed parts fit together.
- Build each part in the orientation it should be printed, largest flat face down.
- Union overlapping shapes by at least 1 mm so each part is one solid, even when the wall thickness is at its minimum.
- Never drop a feature the user asked for (snap lip, pipe cradle, adjustment mechanism, hook shape, ...).
- Set each parameter's max so the finished design is still under 200 mm in every direction at maximum values (all parts laid out side by side).
- If a previous attempt failed, fix the problem and return the full JSON again."""


def ask(history):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY missing (expected in app/.env.local)")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    contents = []
    for i, m in enumerate(history):
        text = f"{SYSTEM}\n\nUser request:\n{m['text']}" if i == 0 else m["text"]
        contents.append({"role": m["role"], "parts": [{"text": text}]})
    body = json.dumps(
        {
            "contents": contents,
            "generationConfig": {"maxOutputTokens": 16384, "responseMimeType": "application/json"},
        }
    ).encode()
    for t in range(6):
        req = urllib.request.Request(
            url, data=body, headers={"Content-Type": "application/json", "x-goog-api-key": key}
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (503, 429):
                time.sleep(5 * (t + 1))
                continue
            raise RuntimeError(f"AI error {e.code}: {e.read()[:200]!r}")
        except (urllib.error.URLError, TimeoutError):
            time.sleep(5 * (t + 1))
            continue
        parts = (((j.get("candidates") or [{}])[0].get("content") or {}).get("parts")) or []
        text = "".join(p.get("text", "") for p in parts)
        if not text.strip():
            raise RuntimeError("AI returned an empty reply")
        return text
    raise RuntimeError("AI busy (503/429)")


def validate_params(lst):
    if not isinstance(lst, list) or not 1 <= len(lst) <= 12:
        raise ValueError("params must be a list of 1 to 12 items")
    seen, out = set(), []
    for raw in lst:
        raw = raw if isinstance(raw, dict) else {}
        key = str(raw.get("key", ""))
        if not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]{0,31}$", key) or key in seen:
            raise ValueError(f"Bad parameter name: {key}")
        seen.add(key)
        try:
            lo, hi = float(raw["min"]), float(raw["max"])
            step, dflt = float(raw["step"]), float(raw["default"])
        except (KeyError, TypeError, ValueError):
            raise ValueError(f"Bad range for parameter {key}")
        if lo >= hi or step <= 0 or dflt < lo or dflt > hi:
            raise ValueError(f"Bad range for parameter {key}")
        out.append({"key": key, "label": str(raw.get("label", key)), "min": lo, "max": hi, "step": step, "default": dflt})
    return out


FORBIDDEN = re.compile(
    r"\b(import|exec|eval|compile|open|globals|locals|getattr|setattr|delattr|subprocess|os|sys|input|breakpoint)\b|__"
)
_ALLOWED = [
    "abs", "all", "any", "bool", "dict", "divmod", "enumerate", "filter", "float", "int", "isinstance",
    "len", "list", "map", "max", "min", "pow", "print", "range", "reversed", "round", "set", "sorted",
    "str", "sum", "tuple", "zip", "Exception", "ValueError", "ZeroDivisionError",
]
SAFE_BUILTINS = {n: getattr(builtins, n) for n in _ALLOWED}


class Timeout(Exception):
    pass


def _on_alarm(signum, frame):
    raise Timeout()


def to_shape(w, name):
    if isinstance(w, cq.Workplane):
        shapes = [v for v in w.vals() if isinstance(v, cq.Shape)]
        if not shapes:
            raise ValueError(f'Part "{name}" has no solid (finish with extrude, box, union, ...)')
        shape = shapes[0] if len(shapes) == 1 else cq.Compound.makeCompound(shapes)
    elif isinstance(w, cq.Shape):
        shape = w
    else:
        raise ValueError(f'Part "{name}" is not a cq.Workplane')
    if shape.Volume() < 0.001:
        raise ValueError(f'Part "{name}" is not a solid (extrude or revolve flat shapes first)')
    return shape


def run_code(code, values):
    if not code.strip():
        raise ValueError("The code is empty")
    if FORBIDDEN.search(code):
        raise ValueError("Forbidden word in code (import/open/os/sys/exec/eval/__...). cq and math are already available.")
    g = {"__builtins__": SAFE_BUILTINS, "cq": cq, "math": math, "p": values}
    signal.signal(signal.SIGALRM, _on_alarm)
    signal.alarm(25)
    try:
        exec(compile(code, "<ai>", "exec"), g)
    except Timeout:
        raise ValueError("Code error: took longer than 25 seconds")
    except Exception as e:
        raise ValueError(f"Code error: {type(e).__name__}: {e}"[:400])
    finally:
        signal.alarm(0)
    res = g.get("result")
    if not isinstance(res, dict) or not 1 <= len(res) <= 6:
        raise ValueError('The code must set result = {"partName": workplane, ...} with 1 to 6 parts')
    parts = {}
    for n, w in res.items():
        parts[re.sub(r"[^a-zA-Z0-9_-]", "", str(n))[:30] or "part"] = to_shape(w, n)
    return parts


def analyze(shape):
    verts, tris = shape.tessellate(0.1, 0.3)
    ids, parent, pos = {}, [], []

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def idof(v):
        k = (round(v.x, 3), round(v.y, 3), round(v.z, 3))
        if k not in ids:
            ids[k] = len(parent)
            parent.append(len(parent))
            pos.append((v.x, v.y, v.z))
        return ids[k]

    for (i, j, k) in tris:
        a, b, c = idof(verts[i]), idof(verts[j]), idof(verts[k])
        parent[find(a)] = find(b)
        parent[find(b)] = find(c)
    roots = {find(i) for i in range(len(parent))}
    mn = [min(p[k] for p in pos) for k in range(3)]
    mx = [max(p[k] for p in pos) for k in range(3)]
    return {"pieces": len(roots), "min": mn, "max": mx, "size": [mx[k] - mn[k] for k in range(3)]}


def check_parts(info):
    for name, a in info.items():
        if a["pieces"] != 1:
            return f'Part "{name}" builds as {a["pieces"]} separate pieces. Each part must be ONE connected solid: overlap unioned shapes by at least 1 mm.'
        w, d, h = a["size"]
        thin = min(w, d, h)
        if thin < 0.8:
            return f'Part "{name}" is only {thin:.2f} mm thick in one direction. Make every part at least 1.2 mm thick.'
        if h > 3 * min(w, d) and h > 20:
            return f'Part "{name}" would print standing on a thin edge ({w:.0f} x {d:.0f} mm footprint, {h:.0f} mm tall). Model it in its printing orientation, largest flat face down.'
    sizes = [a["size"] for a in info.values()]
    width = sum(s[0] for s in sizes) + GAP * (len(sizes) - 1)
    depth = max(s[1] for s in sizes)
    tall = max(s[2] for s in sizes)
    if width > BED[0] or depth > BED[1] or tall > BED[2]:
        return f"The layout is {width:.0f} x {depth:.0f} x {tall:.0f} mm, bigger than a typical {BED[0]} x {BED[1]} x {BED[2]} mm print bed. Use smaller default sizes."
    return None


def build(code, values):
    parts = run_code(code, values)
    return parts, {n: analyze(s) for n, s in parts.items()}


def slider_problems(code, params):
    defaults = {p["key"]: p["default"] for p in params}
    cases = [("all-min", {p["key"]: p["min"] for p in params}), ("all-max", {p["key"]: p["max"] for p in params})]
    for p in params:
        cases.append((f'{p["key"]}=min', {**defaults, p["key"]: p["min"]}))
        cases.append((f'{p["key"]}=max', {**defaults, p["key"]: p["max"]}))
    bad = []
    for label, values in cases:
        try:
            _, info = build(code, values)
            problem = check_parts(info)
            # A layout bigger than the bed is a warning for users, not a build failure
            if problem and not problem.startswith("The layout is"):
                raise ValueError(problem)
        except Exception as e:
            bad.append(f"{label}: {str(e)[:160]}")
    return {"cases": len(cases), "bad": bad}


def generate(prompt):
    history = [{"role": "user", "text": prompt}]
    failures = []
    for attempt in range(1, 5):
        text = ask(history)
        last_code = ""
        try:
            s, e = text.find("{"), text.rfind("}")
            if s < 0 or e <= s:
                raise ValueError("Reply was not valid JSON")
            parsed = json.loads(text[s : e + 1])
            params = validate_params(parsed.get("params"))
            code = str(parsed.get("code") or "")
            last_code = code
            defaults = {p["key"]: p["default"] for p in params}
            parts, info = build(code, defaults)
            problem = check_parts(info)
            if problem:
                raise ValueError(problem)
            sp = slider_problems(code, params)
            if sp["bad"]:
                raise ValueError(
                    f'The sliders break at their limits ({len(sp["bad"])} of {sp["cases"]} tests failed), for example: '
                    + " | ".join(sp["bad"][:3])
                    + ". Make the design stay valid across the whole range, or narrow the range."
                )
            name = re.sub(r"[^a-zA-Z0-9_-]", "", str(parsed.get("name") or "part"))[:40] or "part"
            return {"ok": True, "attempts": attempt, "name": name, "params": params, "code": code, "parts": parts, "info": info}
        except Exception as err:
            with open(os.path.join(OUT, f"failed-{int(time.time() * 1000)}.py"), "w") as f:
                f.write(f"# {err}\n{last_code}")
            failures.append(str(err))
            history.append({"role": "model", "text": text})
            history.append({"role": "user", "text": f"That attempt failed: {err}\nFix it and return the full JSON again."})
    return {"ok": False, "failures": failures}


def export_parts(prefix, parts, info):
    cursor = 0.0
    for name, shape in parts.items():
        a = info[name]
        placed = shape.translate(cq.Vector(cursor - a["min"][0], -a["min"][1], -a["min"][2]))
        cursor += a["size"][0] + GAP
        cq.exporters.export(placed, os.path.join(OUT, f"{prefix}-{name}.step"))
        cq.exporters.export(placed, os.path.join(OUT, f"{prefix}-{name}.stl"))


def print_table(rows):
    cols = ["#", "prompt", "secs", "attempts", "params", "parts", "range_fails", "result"]
    data = [cols] + [[str(r[c]) for c in cols] for r in rows]
    widths = [max(len(row[i]) for row in data) for i in range(len(cols))]
    for n, row in enumerate(data):
        print(" | ".join(v.ljust(widths[i]) for i, v in enumerate(row)))
        if n == 0:
            print("-+-".join("-" * w for w in widths))


def main():
    if not ONLY:
        shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT, exist_ok=True)
    print(f"Model: {MODEL}. Engine: CadQuery {getattr(cq, '__version__', '?')}")
    rows = []
    for i, prompt in enumerate(PROMPTS, start=1):
        if ONLY and i not in ONLY:
            continue
        row = {"#": i, "prompt": prompt[:34], "secs": "-", "attempts": "-", "params": "-", "parts": "-", "range_fails": "-", "result": ""}
        t0 = time.time()
        try:
            g = generate(prompt)
            row["secs"] = f"{time.time() - t0:.1f}"
            if not g["ok"]:
                row["result"] = "GENERATE FAILED"
                print(f"\n#{i} {prompt}")
                for n, f in enumerate(g["failures"], start=1):
                    print(f"  attempt {n}: {f[:300]}")
                rows.append(row)
                continue
            row["attempts"] = g["attempts"]
            row["params"] = len(g["params"])
            row["parts"] = len(g["parts"])
            sp = slider_problems(g["code"], g["params"])
            row["range_fails"] = f'{len(sp["bad"])}/{sp["cases"]}' if sp["bad"] else f'0/{sp["cases"]}'
            export_parts(str(i), g["parts"], g["info"])
            with open(os.path.join(OUT, f'{i}-{g["name"]}.py'), "w") as f:
                f.write(g["code"])
            row["result"] = "ok: " + g["name"]
        except Exception as err:
            row["result"] = ("ERROR: " + str(err))[:80]
        rows.append(row)
        time.sleep(2)
    print()
    print_table(rows)
    print(f'\nPASSED {sum(1 for r in rows if r["result"].startswith("ok"))}/{len(rows)}')


main()