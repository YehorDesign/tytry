import { NextResponse } from "next/server";
import { cacheUsage, cleanCache } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(cacheUsage());
}

/** Чистка кэша: удаляет файлы-сироты, возвращает свежие цифры. */
export async function POST() {
  const result = cleanCache();
  return NextResponse.json({ ...result, ...cacheUsage() });
}
