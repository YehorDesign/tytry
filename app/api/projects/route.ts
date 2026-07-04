import { NextRequest, NextResponse } from "next/server";
import { deleteProject, listProjects } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ projects: listProjects() });
}

/** Массовое удаление: { ids: string[] } или { all: true } */
export async function DELETE(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { ids?: string[]; all?: boolean };
  const ids = body.all ? listProjects().map((p) => p.id) : body.ids ?? [];
  for (const id of ids) deleteProject(id);
  return NextResponse.json({ ok: true, deleted: ids.length });
}
