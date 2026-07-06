import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureBatchDirs, listBatches, listPresets, saveBatch } from "@/lib/batch/store";
import { startBatch } from "@/lib/batch/worker";
import { presentBatch, summarizeBatch, uniqueItemName } from "@/lib/batch/present";
import type { Batch } from "@/lib/batch/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ batches: listBatches().map(summarizeBatch) });
}

export async function POST(req: NextRequest) {
  ensureBatchDirs();
  const body = (await req.json()) as {
    name?: string;
    presetId: string;
    outputDir: string;
    /** папка с архивами — сканируем на месте, без загрузки */
    folderPath?: string;
  };
  const preset = listPresets().find((p) => p.id === body.presetId);
  if (!preset) return NextResponse.json({ error: "Preset not found" }, { status: 400 });
  const outputDir = body.outputDir?.trim();
  if (!outputDir) return NextResponse.json({ error: "Output folder required" }, { status: 400 });
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch {
    return NextResponse.json({ error: `Cannot create folder: ${outputDir}` }, { status: 400 });
  }

  const id = crypto.randomBytes(6).toString("hex");
  const batch: Batch = {
    id,
    name: body.name?.trim() || new Date().toISOString().slice(0, 16).replace("T", " "),
    createdAt: new Date().toISOString(),
    preset, // снапшот: правки пресета не влияют на уже созданный батч
    outputDir,
    cleanDir: path.join(outputDir, "clean"),
    paused: false,
    items: [],
  };

  if (body.folderPath?.trim()) {
    const folder = body.folderPath.trim();
    if (!fs.existsSync(folder)) {
      return NextResponse.json({ error: `Folder not found: ${folder}` }, { status: 400 });
    }
    const zips = fs
      .readdirSync(folder)
      .filter((f) => f.toLowerCase().endsWith(".zip"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const zip of zips) {
      batch.items.push({
        id: crypto.randomBytes(6).toString("hex"),
        name: uniqueItemName(batch.items, path.basename(zip, path.extname(zip))),
        zipPath: path.join(folder, zip),
        zipOwned: false,
        status: "queued",
        progress: 0,
      });
    }
  }

  saveBatch(batch);
  startBatch(id);
  return NextResponse.json({ batch: presentBatch(batch) });
}
