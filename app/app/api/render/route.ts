import { validateScad, validateParams, renderScad } from "@/lib/openscad";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  try {
    const scad = validateScad(body?.scad);
    const specs = validateParams(body?.params);
    const stl = await renderScad(scad, specs, body?.values ?? {});
    return new Response(new Uint8Array(stl), {
      headers: { "Content-Type": "model/stl" },
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}