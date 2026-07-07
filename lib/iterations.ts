// Итерации-хуки: выбранные клипы дублируются в НАЧАЛО видео вместе со
// своими субтитрами, всё остальное (слова, плашки) сдвигается на длину хука.
// Музыка и дисклеймер покрывают всё видео сами по себе.
import { getClips } from "./montage";
import {
  clipDurationMs,
  totalClipsDurationMs,
  type Iteration,
  type Project,
  type TimelineClip,
  type Word,
} from "./types";

const MIN_WORD_MS = 40;

/**
 * Собирает проект-вариант с хуком в начале. Вариант нигде не сохраняется —
 * он существует только на время рендера. id варианта уникален, чтобы
 * параллельные рендеры не дрались за общий _flat.mp4.
 */
export function buildIterationProject(project: Project, iteration: Iteration): Project {
  const base = getClips(project);
  const byId = new Map(base.map((c) => [c.id, c]));
  const hookSrc = iteration.clipIds
    .map((id) => byId.get(id))
    .filter((c): c is TimelineClip => !!c);
  if (hookSrc.length === 0) throw new Error("Iteration clips not found in project");

  // границы клипов на таймлайне — чтобы забрать слова каждого хук-клипа
  const starts = new Map<string, number>();
  let acc = 0;
  for (const c of base) {
    starts.set(c.id, acc);
    acc += clipDurationMs(c);
  }

  const words = project.words ?? [];
  const hookClips: TimelineClip[] = [];
  const hookWords: Word[] = [];
  let offset = 0;
  for (const src of hookSrc) {
    hookClips.push({ ...src, id: `${iteration.id}-${hookClips.length}-${src.id}` });
    const cStart = starts.get(src.id)!;
    const cEnd = cStart + clipDurationMs(src);
    for (const w of words) {
      const mid = (w.startMs + w.endMs) / 2;
      if (mid >= cStart && mid < cEnd) {
        const startMs = Math.max(offset + (w.startMs - cStart), 0);
        hookWords.push({
          ...w,
          id: `${iteration.id}-${w.id}`,
          startMs,
          endMs: Math.max(offset + (w.endMs - cStart), startMs + MIN_WORD_MS),
        });
      }
    }
    offset += clipDurationMs(src);
  }
  const hookMs = offset;

  const shiftedWords = words.map((w) => ({
    ...w,
    startMs: w.startMs + hookMs,
    endMs: w.endMs + hookMs,
  }));
  const overlays = project.overlays
    ? project.overlays.map((o) => ({
        ...o,
        startMs: o.startMs + hookMs,
        endMs: o.endMs + hookMs,
      }))
    : null;

  const clips = [...hookClips, ...base];
  return {
    ...project,
    id: `${project.id}-${iteration.id}`,
    name: `${project.name}_it${iteration.num}`,
    clips,
    words: [...hookWords, ...shiftedWords].sort((a, b) => a.startMs - b.startMs),
    overlays,
    video: { ...project.video, durationMs: totalClipsDurationMs(clips) },
  };
}
