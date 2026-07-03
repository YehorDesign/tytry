import { NextRequest, NextResponse } from "next/server";
import { listProjects, updateProject } from "@/lib/store";
import { CAPTION_STYLES, sanitizeOverrides } from "@/lib/styles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Применяет пресет + правки стиля ко всем проектам разом. */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { styleId?: string; overrides?: unknown };
  const styleId =
    typeof body.styleId === "string" &&
    CAPTION_STYLES.some((s) => s.id === body.styleId)
      ? body.styleId
      : null;
  if (!styleId) {
    return NextResponse.json({ error: "Unknown styleId" }, { status: 400 });
  }
  const overrides = sanitizeOverrides(body.overrides);
  let updated = 0;
  for (const project of listProjects()) {
    if (updateProject(project.id, { styleId, overrides })) updated++;
  }
  return NextResponse.json({ ok: true, updated });
}
