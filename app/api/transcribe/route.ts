import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { AUDIO_DIR, MUSIC_DIR, UPLOADS_DIR, loadProject, updateProject } from "@/lib/store";
import { extractAudio, extractTimelineAudio } from "@/lib/ffmpeg";
import { transcribeAudio } from "@/lib/deepgram";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(req: NextRequest) {
  const { id, language, source } = (await req.json()) as {
    id: string;
    language?: string;
    /** music = распознать текст ИЗ МУЗЫКИ (слова якорятся к треку) */
    source?: "music";
  };
  const project = loadProject(id);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const lang = language ?? project.language ?? "auto";

  // ── субтитры из музыки: добавляются к остальным, помечены fromMusic ──
  if (source === "music") {
    if (!project.music) {
      return NextResponse.json({ error: "No music in this project" }, { status: 400 });
    }
    updateProject(id, { status: "transcribing", error: undefined });
    try {
      const audioPath = path.join(AUDIO_DIR, `${id}_music.wav`);
      await extractAudio(path.join(MUSIC_DIR, project.music.fileName), audioPath);
      const lyrics = await transcribeAudio(audioPath, lang);
      if (lyrics.length === 0) {
        throw new Error("Deepgram found no lyrics in this track");
      }
      const offset = project.music.offsetMs ?? 0;
      const musicWords = lyrics.map((w) => ({
        ...w,
        id: `m-${w.id}`,
        startMs: w.startMs + offset,
        endMs: w.endMs + offset,
        fromMusic: true,
      }));
      // старые музыкальные слова заменяем свежими, остальные не трогаем
      const rest = (project.words ?? []).filter((w) => !w.fromMusic);
      const words = [...rest, ...musicWords].sort((a, b) => a.startMs - b.startMs);
      const updated = updateProject(id, { status: "ready", words });
      return NextResponse.json({ project: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateProject(id, { status: "error", error: message });
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

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
          width: c.width,
          height: c.height,
          sourceDurationMs: c.sourceDurationMs,
        })),
        audioPath
      );
    } else {
      await extractAudio(path.join(UPLOADS_DIR, project.video.fileName), audioPath);
    }
    const speech = await transcribeAudio(audioPath, lang);
    if (speech.length === 0) {
      throw new Error("Deepgram found no speech in this video");
    }
    // слова из музыки живут своей жизнью — перераспознавание речи их не трёт
    const musicWords = (project.words ?? []).filter((w) => w.fromMusic);
    const words = [...speech, ...musicWords].sort((a, b) => a.startMs - b.startMs);
    const updated = updateProject(id, { status: "ready", words });
    return NextResponse.json({ project: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateProject(id, { status: "error", error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
