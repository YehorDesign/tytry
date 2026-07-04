import { NextRequest, NextResponse } from "next/server";
import { deleteProject, loadProject, updateProject } from "@/lib/store";
import { totalClipsDurationMs, type Project } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const project = loadProject(id);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ project });
}

const EDITABLE_FIELDS: (keyof Project)[] = [
  "name",
  "language",
  "words",
  "styleId",
  "overrides",
  "clips",
  "music",
  "disclaimer",
];

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = (await req.json()) as Partial<Project>;
  const patch: Partial<Project> = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in body) {
      (patch as Record<string, unknown>)[field] = body[field];
    }
  }
  // длительность таймлайна следует за клипами
  if (patch.clips && patch.clips.length > 0) {
    const current = loadProject(id);
    if (current) {
      patch.video = {
        ...current.video,
        durationMs: totalClipsDurationMs(patch.clips),
      };
    }
  }
  const project = updateProject(id, patch);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ project });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  deleteProject(id);
  return NextResponse.json({ ok: true });
}
