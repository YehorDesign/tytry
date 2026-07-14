import { NextRequest, NextResponse } from "next/server";
import { deleteProject, listProjects, saveProject } from "@/lib/store";
import { hasActiveJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // очередь рендера живёт в памяти: после перезапуска приложения статусы
  // «в черзі/рендер» на диске сиротеют — возвращаем их в рабочее состояние
  // (проект → ready, итерация → чернетка), чтобы можно было запустить заново
  const projects = listProjects();
  for (const p of projects) {
    let changed = false;
    if (p.status === "rendering" && !hasActiveJob(p.id)) {
      p.status = p.words && p.words.length > 0 ? "ready" : "uploaded";
      p.renderProgress = undefined;
      changed = true;
    }
    for (const it of p.iterations ?? []) {
      if (
        (it.status === "queued" || it.status === "rendering") &&
        !hasActiveJob(`${p.id}#${it.id}`)
      ) {
        it.status = "draft";
        it.progress = 0;
        changed = true;
      }
    }
    if (changed) saveProject(p);
  }
  return NextResponse.json({ projects });
}

/** Массовое удаление: { ids: string[] } или { all: true } */
export async function DELETE(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { ids?: string[]; all?: boolean };
  const ids = body.all ? listProjects().map((p) => p.id) : body.ids ?? [];
  for (const id of ids) deleteProject(id);
  return NextResponse.json({ ok: true, deleted: ids.length });
}
