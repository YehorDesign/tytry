import { NextRequest, NextResponse } from "next/server";
import { enqueueRender, getJob } from "@/lib/jobs";
import { loadProject } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { id } = (await req.json()) as { id: string };
  const project = loadProject(id);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (!project.words || project.words.length === 0) {
    return NextResponse.json(
      { error: "Transcribe first" },
      { status: 400 }
    );
  }
  // nextUrl.origin за кастомным сервером (Electron) врёт — берём реальный Host
  const host = req.headers.get("host") ?? "127.0.0.1:3000";
  const origin = `http://${host}`;
  const job = enqueueRender(id, origin);
  return NextResponse.json({ job });
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const job = getJob(id);
  const project = loadProject(id);
  return NextResponse.json({ job, project });
}
