import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { batchZipsDir, loadBatch, saveBatch } from "@/lib/batch/store";
import { startBatch } from "@/lib/batch/worker";
import { presentBatch, uniqueItemName } from "@/lib/batch/present";

export const runtime = "nodejs";
export const maxDuration = 600;
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Загрузка zip-архивов в батч. Можно звать много раз по ходу обработки —
 * новые элементы встают в очередь, конвейер подхватывает их сразу.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const batch = loadBatch(id);
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  const formData = await req.formData();
  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const zipsDir = batchZipsDir(id);
  fs.mkdirSync(zipsDir, { recursive: true });
  const errors: { name: string; error: string }[] = [];

  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      errors.push({ name: file.name, error: "Not a .zip archive" });
      continue;
    }
    const itemId = crypto.randomBytes(6).toString("hex");
    const zipPath = path.join(zipsDir, `${itemId}.zip`);
    try {
      fs.writeFileSync(zipPath, Buffer.from(await file.arrayBuffer()));
      // batch.json перечитываем на каждый файл: воркер параллельно двигает статусы
      const fresh = loadBatch(id);
      if (!fresh) break;
      fresh.items.push({
        id: itemId,
        name: uniqueItemName(fresh.items, path.basename(file.name, path.extname(file.name))),
        zipPath,
        zipOwned: true,
        status: "queued",
        progress: 0,
      });
      saveBatch(fresh);
      startBatch(id);
    } catch (err) {
      fs.rmSync(zipPath, { force: true });
      errors.push({ name: file.name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const result = loadBatch(id);
  return NextResponse.json({
    batch: result ? presentBatch(result) : null,
    errors,
  });
}
