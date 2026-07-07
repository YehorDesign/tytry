import { NextRequest, NextResponse } from "next/server";
import { rmFileSync } from "@/lib/rmrf";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ENDCARDS_DIR, addEndcard, deleteEndcard, listEndcards, ensureBatchDirs } from "@/lib/batch/store";
import { probeMedia } from "@/lib/ffmpeg";
import type { Endcard } from "@/lib/batch/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ endcards: listEndcards() });
}

/** Загрузка ендкарда (картинка или видео) в библиотеку. */
export async function POST(req: NextRequest) {
  ensureBatchDirs();
  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  const id = crypto.randomBytes(6).toString("hex");
  const ext = path.extname(file.name) || ".mp4";
  const fileName = `${id}${ext}`;
  const filePath = path.join(ENDCARDS_DIR, fileName);
  try {
    fs.writeFileSync(filePath, Buffer.from(await file.arrayBuffer()));
    const meta = await probeMedia(filePath);
    const card: Endcard = {
      id,
      name: path.basename(file.name, ext),
      fileName,
      kind: meta.isImage ? "image" : "video",
      width: meta.width,
      height: meta.height,
      durationMs: meta.durationMs,
      hasAudio: meta.hasAudio,
      addedAt: new Date().toISOString(),
    };
    addEndcard(card);
    return NextResponse.json({ endcard: card, endcards: listEndcards() });
  } catch (err) {
    rmFileSync(filePath);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  deleteEndcard(id);
  return NextResponse.json({ endcards: listEndcards() });
}
