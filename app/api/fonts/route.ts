import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// кешируем список системных шрифтов на время жизни процесса
const g = globalThis as unknown as { __tytryFonts?: string[] };

export async function GET() {
  if (!g.__tytryFonts) {
    try {
      const { getFonts } = await import("font-list");
      const fonts = await getFonts({ disableQuoting: true });
      g.__tytryFonts = fonts.sort((a, b) => a.localeCompare(b));
    } catch {
      g.__tytryFonts = [];
    }
  }
  return NextResponse.json({ fonts: g.__tytryFonts });
}
