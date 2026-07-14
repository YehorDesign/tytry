import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { enqueueIteration } from "@/lib/jobs";
import { getClips } from "@/lib/montage";
import { loadProject, updateProject } from "@/lib/store";
import type { HookClip, Iteration } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Создаёт итерацию (хук из выбранных клипов) и сразу ставит её в рендер. */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const project = loadProject(id);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json()) as {
    clipIds?: string[];
    clips?: HookClip[];
    /** снимок сдвига музыки для этой итерации, мс */
    musicOffsetMs?: number;
    /** false = создать черновик без запуска рендера */
    render?: boolean;
    /** запустить рендер УЖЕ существующей итерации (черновика) */
    renderIterationId?: string;
  };

  // ── запуск рендера существующего черновика ──
  if (body.renderIterationId) {
    const it = project.iterations?.find((i) => i.id === body.renderIterationId);
    if (!it) return NextResponse.json({ error: "Iteration not found" }, { status: 404 });
    const host = req.headers.get("host") ?? "127.0.0.1:3000";
    enqueueIteration(id, it.id, `http://${host}`);
    return NextResponse.json({ project: loadProject(id), iteration: it });
  }

  // новый формат {clips: [{id, move}]}; legacy {clipIds} = все дубли
  const hookClips: HookClip[] = (
    body.clips ?? (body.clipIds ?? []).map((id) => ({ id }))
  ).filter((h) => h && typeof h.id === "string");
  if (hookClips.length === 0) {
    return NextResponse.json({ error: "No clips selected" }, { status: 400 });
  }
  const known = new Set(getClips(project).map((c) => c.id));
  if (hookClips.some((h) => !known.has(h.id))) {
    return NextResponse.json({ error: "Unknown clip id" }, { status: 400 });
  }

  // по умолчанию рендер стартует сразу (пресеты вариаций, старые клиенты);
  // render:false = черновик, рендерится позже кнопкой
  const render = body.render !== false;
  const existing = project.iterations ?? [];
  const iteration: Iteration = {
    id: crypto.randomBytes(5).toString("hex"),
    num: existing.reduce((m, i) => Math.max(m, i.num), 0) + 1,
    clipIds: hookClips.map((h) => h.id),
    hookClips,
    musicOffsetMs:
      typeof body.musicOffsetMs === "number" ? Math.round(body.musicOffsetMs) : undefined,
    status: render ? "queued" : "draft",
    progress: 0,
    createdAt: new Date().toISOString(),
  };
  const updated = updateProject(id, { iterations: [...existing, iteration] });

  if (render) {
    const host = req.headers.get("host") ?? "127.0.0.1:3000";
    enqueueIteration(id, iteration.id, `http://${host}`);
  }
  return NextResponse.json({ project: updated, iteration });
}

/** Отдаёт готовый файл итерации для предпросмотра (с Range для перемотки). */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const project = loadProject(id);
  if (!project) return new Response("Not found", { status: 404 });
  const iterationId = req.nextUrl.searchParams.get("file");
  const iteration = project.iterations?.find((i) => i.id === iterationId);
  if (!iteration?.file || !fs.existsSync(iteration.file)) {
    return new Response("File not ready", { status: 404 });
  }

  const filePath = iteration.file;
  const stat = fs.statSync(filePath);
  const range = req.headers.get("range");
  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
  };

  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m?.[1] ? parseInt(m[1], 10) : 0;
    const end = m?.[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${stat.size}` },
      });
    }
    const stream = fs.createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers: { ...headers, "Content-Length": String(stat.size) },
  });
}

/** Удаляет итерацию из списка (готовый файл в папке видоса не трогаем). */
export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const project = loadProject(id);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { iterationId } = (await req.json()) as { iterationId?: string };
  const next = (project.iterations ?? []).filter((i) => i.id !== iterationId);
  const updated = updateProject(id, { iterations: next });
  return NextResponse.json({ project: updated });
}
