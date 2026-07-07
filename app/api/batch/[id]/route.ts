import { NextRequest, NextResponse } from "next/server";
import { deleteBatch, loadBatch, saveBatch } from "@/lib/batch/store";
import { pauseBatch, resumeBatch, retryItem, startBatch } from "@/lib/batch/worker";
import { presentBatch } from "@/lib/batch/present";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const batch = loadBatch(id);
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  return NextResponse.json({ batch: presentBatch(batch) });
}

/** Действия: pause | resume | retry (itemId) | retry-failed | rename */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const batch = loadBatch(id);
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  const body = (await req.json()) as { action: string; itemId?: string; name?: string };
  switch (body.action) {
    case "pause":
      pauseBatch(id);
      break;
    case "resume":
      resumeBatch(id);
      break;
    case "retry":
      if (!body.itemId) {
        return NextResponse.json({ error: "itemId required" }, { status: 400 });
      }
      retryItem(id, body.itemId);
      break;
    case "retry-failed":
      for (const item of batch.items) {
        if (item.status === "error") retryItem(id, item.id);
      }
      startBatch(id);
      break;
    case "rename":
      if (body.name?.trim()) {
        batch.name = body.name.trim().slice(0, 80);
        saveBatch(batch);
      }
      break;
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  const fresh = loadBatch(id);
  return NextResponse.json({ batch: fresh ? presentBatch(fresh) : null });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  await deleteBatch(id);
  return NextResponse.json({ ok: true });
}
