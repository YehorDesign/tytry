import { NextRequest, NextResponse } from "next/server";
import { getDeepgramKey, getSettings, saveSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mask(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function payload() {
  const key = getDeepgramKey();
  const s = getSettings();
  return {
    hasDeepgramKey: Boolean(key),
    maskedKey: mask(key),
    outputDir: s.outputDir ?? "",
    parallelRenders: s.parallelRenders ?? 3,
    encoder: s.encoder ?? "auto",
    renderEngine: s.renderEngine ?? "native",
  };
}

export async function GET() {
  return NextResponse.json(payload());
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    deepgramApiKey?: string;
    outputDir?: string;
    parallelRenders?: number;
    encoder?: string;
    renderEngine?: string;
  };
  const patch: Partial<import("@/lib/settings").Settings> = {};
  if (typeof body.deepgramApiKey === "string") {
    patch.deepgramApiKey = body.deepgramApiKey.trim();
  }
  if (typeof body.outputDir === "string") {
    patch.outputDir = body.outputDir.trim();
  }
  if (typeof body.parallelRenders === "number") {
    patch.parallelRenders = Math.min(Math.max(Math.round(body.parallelRenders), 1), 4);
  }
  if (body.encoder === "auto" || body.encoder === "nvenc" || body.encoder === "cpu") {
    patch.encoder = body.encoder;
  }
  if (body.renderEngine === "native" || body.renderEngine === "chrome") {
    patch.renderEngine = body.renderEngine;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to save" }, { status: 400 });
  }
  saveSettings(patch);
  return NextResponse.json(payload());
}
