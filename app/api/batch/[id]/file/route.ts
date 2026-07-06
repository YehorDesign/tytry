import { NextRequest } from "next/server";
import fs from "node:fs";
import { Readable } from "node:stream";
import { loadBatch } from "@/lib/batch/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Отдаёт готовое видео элемента батча для предпросмотра.
 * Range поддержан, чтобы в <video> работала перемотка.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const batch = loadBatch(id);
  if (!batch) return new Response("Batch not found", { status: 404 });

  const itemId = req.nextUrl.searchParams.get("item");
  const kind = req.nextUrl.searchParams.get("kind") ?? "final";
  const item = batch.items.find((i) => i.id === itemId);
  if (!item) return new Response("Item not found", { status: 404 });

  const filePath = kind === "clean" ? item.cleanFile : item.outputFile;
  if (!filePath || !fs.existsSync(filePath)) {
    return new Response("File not ready", { status: 404 });
  }

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
