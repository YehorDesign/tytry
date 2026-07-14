import { NextRequest, NextResponse } from "next/server";
import { rmFileSync, rmrf } from "@/lib/rmrf";
import { extractZip } from "@/lib/unzip";
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
    rmFileSync(filePath);
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

// ── ZIP-архив → клипы монтажа ──
const ZIP_EXT = /\.zip$/i;
const MEDIA_EXT = /\.(mp4|mov|m4v|avi|mkv|webm|mpg|mpeg|wmv|png|jpe?g|webp|bmp)$/i;

function listMediaRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__MACOSX" || entry.name.startsWith("._") || entry.name.startsWith("."))
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMediaRecursive(full));
    else if (MEDIA_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Распаковывает архив во временную папку и переносит его медиафайлы в uploads
 * как клипы, отсортированные по числу в имени (как AE-скрипт). Битые файлы
 * пропускаются; совсем пустой архив — ошибка.
 */
async function zipToClips(file: File): Promise<TimelineClip[]> {
  const tmpId = crypto.randomBytes(6).toString("hex");
  const tmpZip = path.join(UPLOADS_DIR, `ziptmp-${tmpId}.zip`);
  const tmpDir = path.join(UPLOADS_DIR, `ziptmp-${tmpId}`);
  const clips: TimelineClip[] = [];
  try {
    fs.writeFileSync(tmpZip, Buffer.from(await file.arrayBuffer()));
    fs.mkdirSync(tmpDir, { recursive: true });
    await extractZip(tmpZip, tmpDir);
    const media = listMediaRecursive(tmpDir).sort((a, b) =>
      numericNameCompare(path.basename(a), path.basename(b))
    );
    for (const src of media) {
      const clipId = crypto.randomBytes(6).toString("hex");
      const fileName = `${clipId}${path.extname(src)}`;
      const dest = path.join(UPLOADS_DIR, fileName);
      try {
        fs.renameSync(src, dest);
        const meta = await probeMedia(dest);
        clips.push({
          id: clipId,
          kind: meta.isImage ? "image" : "video",
          fileName,
          originalName: path.basename(src),
          sourceDurationMs: meta.durationMs,
          inMs: 0,
          outMs: meta.durationMs,
          width: meta.width,
          height: meta.height,
          hasAudio: meta.hasAudio,
        });
      } catch {
        rmFileSync(dest); // битый файл внутри архива — пропускаем
      }
    }
    if (clips.length === 0) {
      throw new Error("No videos or images inside the archive");
    }
    return clips;
  } finally {
    await rmrf(tmpDir);
    rmFileSync(tmpZip);
  }
}

/** Монтаж-проект из готовых клипов (канвас — по первому видеоклипу). */
function montageProject(id: string, name: string, clips: TimelineClip[]): Project {
  const base = clips.find((c) => c.kind === "video") ?? clips[0];
  return {
    id,
    name,
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
        if (ZIP_EXT.test(file.name)) clips.push(...(await zipToClips(file)));
        else clips.push(await saveAsClip(file));
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
        if (ZIP_EXT.test(file.name)) clips.push(...(await zipToClips(file)));
        else clips.push(await saveAsClip(file));
      } catch (err) {
        errors.push({ name: file.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (clips.length === 0) {
      return NextResponse.json({ error: "No usable files", errors }, { status: 400 });
    }
    const project = montageProject(
      id,
      files[0] ? path.basename(files[0].name, path.extname(files[0].name)) : id,
      clips
    );
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
    // архив → монтаж-проект с именем архива
    if (ZIP_EXT.test(file.name)) {
      const id = crypto.randomBytes(6).toString("hex");
      try {
        const clips = await zipToClips(file);
        const project = montageProject(
          id,
          path.basename(file.name, path.extname(file.name)),
          clips
        );
        saveProject(project);
        await makeThumb(id, clips[0]);
        created.push(project);
      } catch (err) {
        errors.push({
          name: file.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
      rmFileSync(filePath);
      errors.push({
        name: file.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ created, errors });
}
