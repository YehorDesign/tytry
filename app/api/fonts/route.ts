import { NextRequest, NextResponse } from "next/server";
import {
  FONT_EXTS,
  addCustomFont,
  deleteCustomFont,
  listCustomFonts,
} from "@/lib/fonts-custom";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// кешируем список системных шрифтов на время жизни процесса
const g = globalThis as unknown as { __tytryFonts?: string[] };

async function systemFonts(): Promise<string[]> {
  if (!g.__tytryFonts) {
    try {
      const { getFonts } = await import("font-list");
      const fonts = await getFonts({ disableQuoting: true });
      g.__tytryFonts = fonts.sort((a, b) => a.localeCompare(b));
    } catch {
      g.__tytryFonts = [];
    }
  }
  return g.__tytryFonts;
}

/** То, что нужно клиенту: имя семейства для overrides + ссылка на файл для FontFace. */
function presentCustom() {
  return listCustomFonts().map((f) => ({
    id: f.id,
    family: f.family,
    originalName: f.originalName,
    url: `/api/fonts/file/${f.id}`,
  }));
}

export async function GET() {
  return NextResponse.json({
    fonts: await systemFonts(),
    custom: presentCustom(),
  });
}

/** Загрузка своих шрифтов (multipart, поле files) */
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }
  const added: string[] = [];
  const errors: { name: string; error: string }[] = [];
  for (const file of files) {
    try {
      const res = addCustomFont(Buffer.from(await file.arrayBuffer()), file.name);
      if ("error" in res) errors.push({ name: file.name, error: res.error });
      else added.push(res.font.family);
    } catch (err) {
      errors.push({
        name: file.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return NextResponse.json({
    added,
    errors,
    accepts: FONT_EXTS,
    custom: presentCustom(),
  });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const ok = deleteCustomFont(id);
  if (!ok) return NextResponse.json({ error: "Font not found" }, { status: 404 });
  return NextResponse.json({
    custom: presentCustom(),
  });
}
