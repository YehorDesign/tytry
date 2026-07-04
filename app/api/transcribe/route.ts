import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { AUDIO_DIR, UPLOADS_DIR, loadProject, updateProject } from "@/lib/store";
import { extractAudio, extractTimelineAudio } from "@/lib/ffmpeg";
import { transcribeAudio } from "@/lib/deepgram";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(req: NextRequest) {
  const { id, language } = (await req.json()) as { id: string; language?: string };
  const project = loadProject(id);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const lang = language ?? project.language ?? "auto";
  updateProject(id, { status: "transcribing", language: lang, error: undefined });

  try {
    const audioPath = path.join(AUDIO_DIR, `${id}.wav`);
    if (project.clips && project.clips.length > 0) {
      // монтаж: аудио склейки клипов (трим учтён, музыка не попадает в распознавание)
      await extractTimelineAudio(
        project.clips.map((c) => ({
          path: path.join(UPLOADS_DIR, c.fileName),
          kind: c.kind,
          inMs: c.inMs,
          outMs: c.outMs,
          hasAudio: c.hasAudio,
        })),
        audioPath
      );
    } else {
      await extractAudio(path.join(UPLOADS_DIR, project.video.fileName), audioPath);
    }
    const words = await transcribeAudio(audioPath, lang);
    if (words.length === 0) {
      throw new Error("Deepgram found no speech in this video");
    }
    const updated = updateProject(id, { status: "ready", words });
    return NextResponse.json({ project: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateProject(id, { status: "error", error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
