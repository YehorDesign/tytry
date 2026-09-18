import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { fontPath, getCustomFont } from "@/lib/fonts-custom";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ttc": "font/collection",
};

type Params = { params: Promise<{ id: string }> };

/** Файл своего шрифта — превью грузит его через FontFace. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const font = getCustomFont(id);
  if (!font) return NextResponse.json({ error: "Font not found" }, { status: 404 });
  const file = fontPath(font);
  try {
    const body = fs.readFileSync(file);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": String(body.length),
        // файл иммутабельный: id новый на каждую загрузку
        "Cache-Control": "public, max-age=31536000, immutable",
        // chrome-движок рендера открывает бандл с другого origin, а шрифты
        // браузер грузит по правилам CORS — без этого будет тихий фолбэк
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return NextResponse.json({ error: "Font file missing" }, { status: 404 });
  }
}
