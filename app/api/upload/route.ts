import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  THUMBS_DIR,
  UPLOADS_DIR,
  ensureWorkspace,
  loadProject,
  saveProject,
  updateProject,
} from "@/lib/store";
import { IMAGE_EXT, extractThumbnail, probeMedia } from "@/lib/ffmpeg";
import { getDefaultStyle } from "@/lib/settings";
import { numericNameCompare, getClips } from "@/lib/montage";
import { totalClipsDurationMs, type Project, type TimelineClip } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Сохраняет файл в uploads и возвращает клип с метаданными. */
async function saveAsClip(file: File): Promise<TimelineClip> {
  const clipId = crypto.randomBytes(6).toString("hex");
  const ext = path.extname(file.name) || ".mp4";
  const fileName = `${clipId}${ext}`;
  const filePath = path.join(UPLOADS_DIR, fileName);
  try {
    fs.writeFileSync(filePath, Buffer.from(await file.arrayBuffer()));
    const meta = await probeMedia(filePath);
    return {
      id: clipId,
      kind: meta.isImage ? "image" : "video",
      fileName,
      originalName: file.name,
      sourceDurationMs: meta.durationMs,
      inMs: 0,
      outMs: meta.durationMs,
      width: meta.width,
      height: meta.height,
      hasAudio: meta.hasAudio,
    };
  } catch (err) {
    fs.rmSync(filePath, { force: true });
    throw err;
  }
}

async function makeThumb(projectId: string, clip: TimelineClip) {
  await extractThumbnail(
    path.join(UPLOADS_DIR, clip.fileName),
    path.join(THUMBS_DIR, `${projectId}.jpg`),
    clip.kind === "image" ? 0 : 0.3
  ).catch(() => {});
}

export async function POST(req: NextRequest) {
  ensureWorkspace();
  const mode = req.nextUrl.searchParams.get("mode"); // null | "montage"
  const appendTo = req.nextUrl.searchParams.get("projectId"); // добавить клипы в проект

  const formData = await req.formData();
  const files = formData
    .getAll("files")
    .filter((f): f is File => f instanceof File)
    // как AE-скрипт: раскладываем по числу в имени файла
    .sort((a, b) => numericNameCompare(a.name, b.name));
  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const errors: { name: string; error: string }[] = [];

  // ── добавление клипов в существующий проект ──
  if (appendTo) {
    const project = loadProject(appendTo);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const clips = getClips(project);
    for (const file of files) {
      try {
        clips.push(await saveAsClip(file));
      } catch (err) {
        errors.push({ name: file.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const updated = updateProject(appendTo, {
      clips,
      video: { ...project.video, durationMs: totalClipsDurationMs(clips) },
    });
    return NextResponse.json({ project: updated, errors });
  }

  // ── новый монтаж: все файлы в один проект, встык по порядку имён ──
  if (mode === "montage") {
    const id = crypto.randomBytes(6).toString("hex");
    const clips: TimelineClip[] = [];
    for (const file of files) {
      try {
        clips.push(await saveAsClip(file));
      } catch (err) {
        errors.push({ name: file.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (clips.length === 0) {
      return NextResponse.json({ error: "No usable files", errors }, { status: 400 });
    }
    // канвас проекта — по первому видеоклипу (или первому клипу вообще)
    const base = clips.find((c) => c.kind === "video") ?? clips[0];
    const project: Project = {
      id,
      name: files[0] ? path.basename(files[0].name, path.extname(files[0].name)) : id,
      createdAt: new Date().toISOString(),
      status: "uploaded",
      language: "auto",
      video: {
        fileName: base.fileName,
        originalName: base.originalName,
        width: base.width,
        height: base.height,
        durationMs: totalClipsDurationMs(clips),
        fps: 30,
      },
      words: null,
      clips,
      ...getDefaultStyle(),
    };
    saveProject(project);
    await makeThumb(id, clips[0]);
    return NextResponse.json({ created: [project], errors });
  }

  // ── классический режим: каждый файл — отдельный проект ──
  const created: Project[] = [];
  for (const file of files) {
    if (IMAGE_EXT.test(file.name)) {
      errors.push({ name: file.name, error: "Images can only be added to a montage" });
      continue;
    }
    const id = crypto.randomBytes(6).toString("hex");
    const ext = path.extname(file.name) || ".mp4";
    const fileName = `${id}${ext}`;
    const filePath = path.join(UPLOADS_DIR, fileName);
    try {
      fs.writeFileSync(filePath, Buffer.from(await file.arrayBuffer()));
      const meta = await probeMedia(filePath);
      await extractThumbnail(filePath, path.join(THUMBS_DIR, `${id}.jpg`)).catch(() => {});

      const project: Project = {
        id,
        name: path.basename(file.name, ext),
        createdAt: new Date().toISOString(),
        status: "uploaded",
        language: "auto",
        video: {
          fileName,
          originalName: file.name,
          width: meta.width,
          height: meta.height,
          durationMs: meta.durationMs,
          fps: meta.fps,
        },
        words: null,
        ...getDefaultStyle(),
      };
      saveProject(project);
      created.push(project);
    } catch (err) {
      fs.rmSync(filePath, { force: true });
      errors.push({
        name: file.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ created, errors });
}
