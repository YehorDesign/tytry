import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { RENDERS_DIR, loadProject } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return new Response("id required", { status: 400 });
  const project = loadProject(id);
  if (!project?.renderFile) return new Response("Not rendered", { status: 404 });

  const filePath = path.isAbsolute(project.renderFile)
    ? project.renderFile
    : path.join(RENDERS_DIR, project.renderFile);
  if (!fs.existsSync(filePath)) return new Response("File not found", { status: 404 });

  const stat = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);
  const fileName = path.basename(filePath);
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    },
  });
}
