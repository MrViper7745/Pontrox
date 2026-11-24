import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import { setOC, drawRoundedRectangle, drawCircle } from "replicad";
import { writeFile, mkdir } from "node:fs/promises";

const OC = await opencascade();
setOC(OC);

// 60 x 40 x 20 plate with rounded corners and a 10 mm hole through the middle
const body = drawRoundedRectangle(60, 40, 3).sketchOnPlane().extrude(20);
const hole = drawCircle(5).sketchOnPlane().extrude(30).translateZ(-5);
const part = body.cut(hole);

await mkdir("../../tests/out", { recursive: true });
for (const [name, blob] of [
  ["rp_test.step", part.blobSTEP()],
  ["rp_test.stl", part.blobSTL()],
]) {
  await writeFile(`../../tests/out/${name}`, Buffer.from(await blob.arrayBuffer()));
}
console.log("ok");