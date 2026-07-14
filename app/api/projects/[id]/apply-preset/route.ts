// Применение батч-пресета к обычному проекту редактора: стиль субтитров,
// дисклеймер, музыка и ендкард — одним нажатием. Применяются только те части,
// которые в пресете заданы (пустые не трогают текущие настройки проекта).
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { ENDCARDS_DIR, listEndcards, listPresets } from "@/lib/batch/store";
import { getClips } from "@/lib/montage";
import { MUSIC_DIR, UPLOADS_DIR, listMusic, loadProject, updateProject } from "@/lib/store";
import type { Project, TimelineClip } from "@/lib/types";
import { totalClipsDurationMs } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const project = loadProject(id);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const { presetId } = (await req.json()) as { presetId?: string };
  const preset = listPresets().find((p) => p.id === presetId);
  if (!preset) return NextResponse.json({ error: "Preset not found" }, { status: 400 });

  const patch: Partial<Project> = {
    styleId: preset.styleId,
    overrides: preset.overrides,
  };

  if (preset.disclaimer?.text?.trim()) patch.disclaimer = preset.disclaimer;

  if (preset.musicTrackId) {
    const track = listMusic().find((t) => t.id === preset.musicTrackId);
    if (!track || !fs.existsSync(path.join(MUSIC_DIR, track.fileName))) {
      return NextResponse.json({ error: "Preset music track is missing" }, { status: 400 });
    }
    patch.music = {
      trackId: track.id,
      fileName: track.fileName,
      name: track.name,
      volume: preset.musicVolume,
      offsetMs: 0,
    };
  }

  if (preset.endcardId) {
    const card = listEndcards().find((c) => c.id === preset.endcardId);
    const cardSrc = card ? path.join(ENDCARDS_DIR, card.fileName) : null;
    if (!card || !cardSrc || !fs.existsSync(cardSrc)) {
      return NextResponse.json({ error: "Preset endcard is missing" }, { status: 400 });
    }
    // ендкард живёт в библиотеке ендкардов — клипы читают только uploads
    const uploadName = `endcard-${card.id}${path.extname(card.fileName)}`;
    const uploadPath = path.join(UPLOADS_DIR, uploadName);
    if (!fs.existsSync(uploadPath)) fs.copyFileSync(cardSrc, uploadPath);

    const durMs = card.kind === "image" ? preset.endcardDurationMs : card.durationMs;
    const endcardClip: TimelineClip = {
      id: `endcard-${card.id}`,
      kind: card.kind,
      fileName: uploadName,
      originalName: card.name,
      sourceDurationMs: card.durationMs || durMs,
      inMs: 0,
      outMs: durMs,
      width: card.width,
      height: card.height,
      hasAudio: card.hasAudio,
    };
    // идемпотентно: старый ендкард (от прошлого применения) заменяется новым
    const base = getClips(project).filter((c) => !c.id.startsWith("endcard-"));
    patch.clips = [...base, endcardClip];
    patch.video = {
      ...project.video,
      durationMs: totalClipsDurationMs(patch.clips),
    };
  }

  const updated = updateProject(id, patch);
  return NextResponse.json({ project: updated });
}
