// Итерации-хуки: выбранные клипы идут в НАЧАЛО видео вместе со своими
// субтитрами. Два режима на клип:
//  • дубль (ЛКМ) — клип копируется в хук, дальше видео без изменений;
//  • перенос (ПКМ) — клип уезжает в хук и ПРОПАДАЕТ со своего места,
//    остальное видео смыкается (слова смыкаются вместе с ним).
// Музыка и дисклеймер покрывают всё видео сами по себе.
import { getClips, remapWordsToClips } from "./montage";
import {
  clipDurationMs,
  totalClipsDurationMs,
  type HookClip,
  type Iteration,
  type Project,
  type TimelineClip,
  type Word,
} from "./types";

const MIN_WORD_MS = 40;

/** Состав хука итерации: новый формат или legacy-список дублей. */
export function iterationHookClips(iteration: Iteration): HookClip[] {
  if (iteration.hookClips && iteration.hookClips.length > 0) return iteration.hookClips;
  return iteration.clipIds.map((id) => ({ id }));
}

/**
 * Собирает проект-вариант с хуком в начале. Вариант нигде не сохраняется —
 * он существует только на время рендера. id варианта уникален, чтобы
 * параллельные рендеры не дрались за общий _flat.mp4.
 */
export function buildIterationProject(project: Project, iteration: Iteration): Project {
  const base = getClips(project);
  const byId = new Map(base.map((c) => [c.id, c]));
  const sel = iterationHookClips(iteration).filter((h) => byId.has(h.id));
  if (sel.length === 0) throw new Error("Iteration clips not found in project");

  // границы клипов на исходном таймлайне — чтобы забрать слова каждого хук-клипа
  const starts = new Map<string, number>();
  let acc = 0;
  for (const c of base) {
    starts.set(c.id, acc);
    acc += clipDurationMs(c);
  }

  // слова из музыки якорятся к треку, а не к клипам — хук/ремап их не трогает
  const allWords = project.words ?? [];
  const words = allWords.filter((w) => !w.fromMusic);
  const baseMusicOffset = project.music?.offsetMs ?? 0;
  const iterMusicOffset = iteration.musicOffsetMs ?? baseMusicOffset;
  const musicWords = allWords
    .filter((w) => w.fromMusic)
    .map((w) => ({
      ...w,
      startMs: w.startMs - baseMusicOffset + iterMusicOffset,
      endMs: w.endMs - baseMusicOffset + iterMusicOffset,
    }));

  const hookClips: TimelineClip[] = [];
  const hookWords: Word[] = [];
  let offset = 0;
  for (const h of sel) {
    const src = byId.get(h.id)!;
    hookClips.push({ ...src, id: `${iteration.id}-${hookClips.length}-${src.id}` });
    const cStart = starts.get(src.id)!;
    const cEnd = cStart + clipDurationMs(src);
    for (const w of words) {
      const mid = (w.startMs + w.endMs) / 2;
      if (mid >= cStart && mid < cEnd) {
        const startMs = Math.max(offset + (w.startMs - cStart), 0);
        hookWords.push({
          ...w,
          id: `${iteration.id}-h${hookWords.length}-${w.id}`,
          startMs,
          endMs: Math.max(offset + (w.endMs - cStart), startMs + MIN_WORD_MS),
        });
      }
    }
    offset += clipDurationMs(src);
  }
  const hookMs = offset;

  // базовая часть: перенесённые клипы выпадают, дубли остаются;
  // слова смыкаются вместе с клипами (remap) и сдвигаются на длину хука
  const movedIds = new Set(sel.filter((h) => h.move).map((h) => h.id));
  const newBase = base.filter((c) => !movedIds.has(c.id));
  const baseWords = remapWordsToClips(words, base, newBase).map((w) => ({
    ...w,
    startMs: w.startMs + hookMs,
    endMs: w.endMs + hookMs,
  }));

  // плашки: время «схлопывается» на перенесённых клипах + сдвиг на хук
  const cuts: { at: number; len: number }[] = [];
  for (const c of base) {
    if (movedIds.has(c.id)) cuts.push({ at: starts.get(c.id)!, len: clipDurationMs(c) });
  }
  const collapse = (ms: number) => {
    let out = ms;
    for (const cut of cuts) {
      if (ms >= cut.at + cut.len) out -= cut.len;
      else if (ms > cut.at) out -= ms - cut.at; // внутри выреза — прижимаем к шву
    }
    return out;
  };
  const overlays = project.overlays
    ? project.overlays.map((o) => {
        const dur = o.endMs - o.startMs;
        const startMs = hookMs + collapse(o.startMs);
        return { ...o, startMs, endMs: startMs + dur };
      })
    : null;

  const clips = [...hookClips, ...newBase];
  return {
    ...project,
    id: `${project.id}-${iteration.id}`,
    name: `${project.name}_it${iteration.num}`,
    clips,
    words: [...hookWords, ...baseWords, ...musicWords].sort(
      (a, b) => a.startMs - b.startMs
    ),
    overlays,
    music: project.music ? { ...project.music, offsetMs: iterMusicOffset } : project.music,
    video: { ...project.video, durationMs: totalClipsDurationMs(clips) },
  };
}
