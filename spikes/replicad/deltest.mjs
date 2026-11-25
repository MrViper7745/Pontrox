import opencascade from "./node_modules/replicad-opencascadejs/dist/replicad_single.js";
import { setOC, drawRoundedRectangle, drawCircle } from "replicad";
setOC(await opencascade());

const box = () => drawRoundedRectangle(20, 20, 1).sketchOnPlane("XY").extrude(5);
const cyl = () => drawCircle(5).sketchOnPlane("XY").extrude(10);

const tests = {
  "sketch extruded twice": () => { const s = drawCircle(5).sketchOnPlane("XY"); s.extrude(5); s.extrude(8); },
  "drawing sketched twice": () => { const d = drawCircle(5); d.sketchOnPlane("XY").extrude(5); d.sketchOnPlane("XY").extrude(5); },
  "fuse operand reused": () => { const a = box(), b = cyl(); a.fuse(b); a.fuse(b); },
  "cut tool reused": () => { const a = box(), b = box(), t = cyl(); a.cut(t); b.cut(t); },
  "translate then reuse original": () => { const a = box(); a.translate([1, 0, 0]); a.translate([2, 0, 0]); },
  "rotate then reuse original": () => { const a = box(); a.rotate(45); a.rotate(90); },
};

for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log("OK    ", name); }
  catch (e) { console.log("FAILS ", name, "-", e?.message ?? e); }
}