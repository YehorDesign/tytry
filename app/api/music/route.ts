import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  MUSIC_DIR,
  addMusicTrack,
  deleteMusicTrack,
  ensureWorkspace,
  listMusic,
} from "@/lib/store";
import { probeAudioDuration } from "@/lib/ffmpeg";
import type { MusicTrack } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ tracks: listMusic() });
}

/** Загрузка треков в библиотеку (multipart, поле files) */
export async function POST(req: NextRequest) {
  ensureWorkspace();
  const formData = await req.formData();
  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const created: MusicTrack[] = [];
  const errors: { name: string; error: string }[] = [];
  for (const file of files) {
    const id = crypto.randomBytes(6).toString("hex");
    const ext = path.extname(file.name) || ".mp3";
    const fileName = `${id}${ext}`;
    const filePath = path.join(MUSIC_DIR, fileName);
    try {
      fs.writeFileSync(filePath, Buffer.from(await file.arrayBuffer()));
      const durationMs = await probeAudioDuration(filePath);
      const track: MusicTrack = {
        id,
        name: path.basename(file.name, ext),
        fileName,
        durationMs,
        addedAt: new Date().toISOString(),
      };
      addMusicTrack(track);
      created.push(track);
    } catch (err) {
      fs.rmSync(filePath, { force: true });
      errors.push({
        name: file.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return NextResponse.json({ created, errors, tracks: listMusic() });
}

/** Удаление трека из библиотеки: { id } */
export async function DELETE(req: NextRequest) {
  const { id } = (await req.json()) as { id: string };
  if (id) deleteMusicTrack(id);
  return NextResponse.json({ ok: true, tracks: listMusic() });
}
