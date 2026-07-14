import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { enqueueIteration, enqueueRender, getJob } from "@/lib/jobs";
import { loadProject, updateIteration, updateProject } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { id, outputRoot, withIterations } = (await req.json()) as {
    id: string;
    /** корневая папка «Рендер всех»: видео + итерации → <root>/<имя>/ */
    outputRoot?: string;
    /** перерендерить и все итерации проекта */
    withIterations?: boolean;
  };
  const project = loadProject(id);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (!project.words || project.words.length === 0) {
    return NextResponse.json(
      { error: "Transcribe first" },
      { status: 400 }
    );
  }
  if (typeof outputRoot === "string" && outputRoot.trim()) {
    const root = outputRoot.trim();
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch {
      return NextResponse.json({ error: `Cannot create folder: ${root}` }, { status: 400 });
    }
    updateProject(id, { outputRoot: root });
  }
  // nextUrl.origin за кастомным сервером (Electron) врёт — берём реальный Host
  const host = req.headers.get("host") ?? "127.0.0.1:3000";
  const origin = `http://${host}`;
  const job = enqueueRender(id, origin);
  if (withIterations) {
    for (const it of loadProject(id)?.iterations ?? []) {
      updateIteration(id, it.id, { status: "queued", progress: 0, error: undefined });
      enqueueIteration(id, it.id, origin);
    }
  }
  return NextResponse.json({ job });
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const job = getJob(id);
  const project = loadProject(id);
  return NextResponse.json({ job, project });
}
