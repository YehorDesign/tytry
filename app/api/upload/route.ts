import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { THUMBS_DIR, UPLOADS_DIR, ensureWorkspace, saveProject } from "@/lib/store";
import { extractThumbnail, probeVideo } from "@/lib/ffmpeg";
import type { Project } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  ensureWorkspace();
  const formData = await req.formData();
  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const created: Project[] = [];
  const errors: { name: string; error: string }[] = [];

  for (const file of files) {
    const id = crypto.randomBytes(6).toString("hex");
    const ext = path.extname(file.name) || ".mp4";
    const fileName = `${id}${ext}`;
    const filePath = path.join(UPLOADS_DIR, fileName);
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      fs.writeFileSync(filePath, buffer);

      const meta = await probeVideo(filePath);
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
          ...meta,
        },
        words: null,
        styleId: "hormozi",
        overrides: {},
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
