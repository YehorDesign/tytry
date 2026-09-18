import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { enqueueIteration, enqueueRender, getJob } from "@/lib/jobs";
import { loadProject, updateIteration, updateProject } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { id, outputRoot, withIterations } = (await req.json()) as {
    id: string;
    /** папка из диалога «Рендер всех»: туда лягут видео и их итерации */
    outputRoot?: string;
    /** перерендерить и итерации-хуки проекта (переводы не трогаем) */
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
    // mkdir на существующей папке проходит и без права записи — проверяем пробой
    const probe = path.join(root, `.tytry-write-test-${process.pid}`);
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(probe, "");
      fs.unlinkSync(probe);
    } catch (err) {
      return NextResponse.json(
        { error: `Cannot write to folder: ${root} (${err instanceof Error ? err.message : err})` },
        { status: 400 }
      );
    }
    updateProject(id, { outputRoot: root });
  }
  // nextUrl.origin за кастомным сервером (Electron) врёт — берём реальный Host
  const host = req.headers.get("host") ?? "127.0.0.1:3000";
  const origin = `http://${host}`;
  const job = enqueueRender(id, origin);
  if (withIterations) {
    for (const it of loadProject(id)?.iterations ?? []) {
      // переводы НЕ перерендериваем: файл уже готов, а повторный прогон
      // WaveSpeed стоит денег (и падает, если ключа больше нет)
      if (it.kind === "translate") continue;
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
