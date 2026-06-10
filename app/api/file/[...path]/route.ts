import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { WORKSPACE } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".wav": "audio/wav",
};

type Params = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { path: parts } = await params;
  const relative = parts.map(decodeURIComponent).join(path.sep);
  const filePath = path.resolve(WORKSPACE, relative);
  // запрещаем выход за пределы workspace
  if (!filePath.startsWith(path.resolve(WORKSPACE) + path.sep)) {
    return new Response("Forbidden", { status: 403 });
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return new Response("Not found", { status: 404 });
  }

  const stat = fs.statSync(filePath);
  const contentType = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.get("range");

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match?.[1] ? parseInt(match[1], 10) : 0;
    let end = match?.[2] ? parseInt(match[2], 10) : stat.size - 1;
    start = Math.max(0, Math.min(start, stat.size - 1));
    end = Math.max(start, Math.min(end, stat.size - 1));

    const stream = fs.createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
      "Accept-Ranges": "bytes",
    },
  });
}
