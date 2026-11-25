import { makeCylinder, drawCircle } from "replicad";

// Finds the class prototype that actually defines a method
function owner(obj, name) {
  let p = Object.getPrototypeOf(obj);
  while (p && !Object.prototype.hasOwnProperty.call(p, name)) {
    p = Object.getPrototypeOf(p);
  }
  return p;
}

// Makes each listed method work on a copy of the object (and, for names in copyArgs,
// on copies of its arguments), so the originals are never destroyed.
function protect(sample, names, label, report, copyArgs = []) {
  for (const name of names) {
    const proto = owner(sample, name);
    if (!proto) continue;
    const orig = proto[name];
    if (typeof orig !== "function" || orig.__safe) continue;
    const copy = copyArgs.includes(name);
    const safe = function (...args) {
      const target = typeof this.clone === "function" ? this.clone() : this;
      const a = copy
        ? args.map((x) => (x && typeof x.clone === "function" ? x.clone() : x))
        : args;
      return orig.apply(target, a);
    };
    safe.__safe = true;
    proto[name] = safe;
    report.push(label + "." + name + (typeof sample.clone === "function" ? "" : " (NO CLONE)"));
  }
}

export function makeSafe() {
  const report = [];
  const solid = makeCylinder(1, 1);
  const drawing = drawCircle(1);
  const sketch = drawing.sketchOnPlane("XY");
  protect(solid, ["translate", "translateX", "translateY", "translateZ", "rotate", "mirror", "scale", "fillet", "chamfer", "shell"], "Shape", report);
  protect(drawing, ["translate", "rotate", "scale", "mirror", "stretch", "fillet", "chamfer", "offset", "cut", "fuse", "intersect"], "Drawing", report, ["cut", "fuse", "intersect"]);
  protect(sketch, ["extrude", "revolve"], "Sketch", report);
  return report;
}