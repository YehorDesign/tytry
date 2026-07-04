// Хелперы монтажа. Только чистые функции — файл импортируется и клиентом.
import type { Project, TimelineClip } from "./types";
import { totalClipsDurationMs } from "./types";

/**
 * Клипы проекта. У классического проекта из одного файла клипы не хранятся —
 * синтезируем один клип на весь исходник, чтобы весь код работал одинаково.
 */
export function getClips(project: Project): TimelineClip[] {
  if (project.clips && project.clips.length > 0) return project.clips;
  return [
    {
      id: "main",
      kind: "video",
      fileName: project.video.fileName,
      originalName: project.video.originalName,
      sourceDurationMs: project.video.durationMs,
      inMs: 0,
      outMs: project.video.durationMs,
      width: project.video.width,
      height: project.video.height,
      hasAudio: true,
    },
  ];
}

/** Есть ли у клипа трансформация кадра (зум/сдвиг) */
export function hasTransform(c: TimelineClip): boolean {
  return (c.zoom ?? 1) !== 1 || (c.panX ?? 0) !== 0 || (c.panY ?? 0) !== 0;
}

/** Нужна ли предварительная склейка (иначе рендерим исходник напрямую). */
export function needsFlatten(project: Project): boolean {
  if (project.music) return true;
  const clips = project.clips;
  if (!clips || clips.length === 0) return false;
  if (clips.length > 1) return true;
  const c = clips[0];
  return (
    c.kind === "image" ||
    c.inMs > 0 ||
    c.outMs < c.sourceDurationMs ||
    c.fileName !== project.video.fileName ||
    hasTransform(c)
  );
}

/** Суммарная длительность таймлайна проекта. */
export function projectDurationMs(project: Project): number {
  if (project.clips && project.clips.length > 0) {
    return totalClipsDurationMs(project.clips);
  }
  return project.video.durationMs;
}

/**
 * Сортировка файлов «как в After Effects»: по первому числу в имени
 * (1, 2, 10 — по значению, не по алфавиту), без числа — в конец.
 */
export function numericNameCompare(a: string, b: string): number {
  const na = a.match(/\d+/);
  const nb = b.match(/\d+/);
  const va = na ? parseInt(na[0], 10) : Infinity;
  const vb = nb ? parseInt(nb[0], 10) : Infinity;
  if (va !== vb) return va - vb;
  return a.localeCompare(b);
}
