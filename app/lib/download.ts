import JSZip from "jszip";

function trigger(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function saveBuffer(buf: ArrayBuffer, filename: string) {
  trigger(new Blob([buf]), filename);
}

export async function saveZip(files: Record<string, ArrayBuffer | string>, filename: string) {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  trigger(await zip.generateAsync({ type: "blob" }), filename);
}