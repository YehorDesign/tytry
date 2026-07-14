import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { listPresets, savePreset, deletePreset } from "@/lib/batch/store";
import { defaultPreset, type BatchPreset } from "@/lib/batch/types";
import { CAPTION_STYLES, sanitizeOverrides } from "@/lib/styles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ presets: listPresets() });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<BatchPreset> & { name: string };
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "Name required" }, { status: 400 });
  }
  const existing = body.id ? listPresets().find((p) => p.id === body.id) : null;
  const base = existing ?? {
    id: crypto.randomBytes(6).toString("hex"),
    createdAt: new Date().toISOString(),
    ...defaultPreset(),
  };
  const preset: BatchPreset = {
    ...base,
    name: body.name.trim().slice(0, 60),
    language: typeof body.language === "string" ? body.language : base.language,
    captions: typeof body.captions === "boolean" ? body.captions : base.captions,
    captionsFromMusic:
      typeof body.captionsFromMusic === "boolean"
        ? body.captionsFromMusic
        : (base.captionsFromMusic ?? false),
    trimSilence:
      typeof body.trimSilence === "boolean" ? body.trimSilence : base.trimSilence,
    styleId: CAPTION_STYLES.some((s) => s.id === body.styleId)
      ? (body.styleId as string)
      : base.styleId,
    overrides:
      body.overrides !== undefined ? sanitizeOverrides(body.overrides) : base.overrides,
    disclaimer:
      body.disclaimer !== undefined
        ? body.disclaimer && body.disclaimer.text?.trim()
          ? {
              text: String(body.disclaimer.text).slice(0, 500),
              sizeRatio: Number(body.disclaimer.sizeRatio) || 0.02,
              positionY: Number(body.disclaimer.positionY) || 0.04,
            }
          : null
        : base.disclaimer,
    musicTrackId:
      body.musicTrackId !== undefined ? body.musicTrackId || null : base.musicTrackId,
    musicVolume:
      typeof body.musicVolume === "number"
        ? Math.min(Math.max(body.musicVolume, 0), 1)
        : base.musicVolume,
    endcardId: body.endcardId !== undefined ? body.endcardId || null : base.endcardId,
    endcardDurationMs:
      typeof body.endcardDurationMs === "number"
        ? Math.min(Math.max(Math.round(body.endcardDurationMs), 500), 30000)
        : base.endcardDurationMs,
    cleanCopy: typeof body.cleanCopy === "boolean" ? body.cleanCopy : base.cleanCopy,
    maxSizeMb:
      typeof body.maxSizeMb === "number"
        ? body.maxSizeMb <= 0
          ? 0
          : Math.min(Math.max(Math.round(body.maxSizeMb), 5), 2000)
        : base.maxSizeMb,
  };
  savePreset(preset);
  return NextResponse.json({ preset, presets: listPresets() });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  deletePreset(id);
  return NextResponse.json({ presets: listPresets() });
}
