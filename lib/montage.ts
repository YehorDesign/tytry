// Хелперы монтажа. Только чистые функции — файл импортируется и клиентом.
import type { Project, TimelineClip, Word } from "./types";
import { clipDurationMs, totalClipsDurationMs } from "./types";

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
    // трим ИЛИ «продление кадра» (outMs дальше конца исходника)
    c.outMs !== c.sourceDurationMs ||
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

const MIN_WORD_MS = 40; // защита от нулевой длительности слова после сдвига

/**
 * Пересчитывает тайминги слов после правок клипов (перестановка, трим краёв,
 * удаление): слово «прикреплено» к моменту исходника своего клипа и едет
 * вместе с ним. Слова, чей кусок вырезан тримом или удалён вместе с клипом,
 * пропадают. Клипы сопоставляются по id. Возвращает тот же массив, если
 * тайминги не изменились (зум/пан и т.п.).
 */
export function remapWordsToClips(
  words: Word[],
  oldClips: TimelineClip[],
  newClips: TimelineClip[]
): Word[] {
  if (words.length === 0) return words;

  type Pos = { start: number; clip: TimelineClip };
  const oldPos: Pos[] = [];
  let acc = 0;
  for (const c of oldClips) {
    oldPos.push({ start: acc, clip: c });
    acc += clipDurationMs(c);
  }
  const oldTotal = acc;

  const newPos = new Map<string, Pos>();
  acc = 0;
  for (const c of newClips) {
    newPos.set(c.id, { start: acc, clip: c });
    acc += clipDurationMs(c);
  }
  const newTotal = acc;

  let changed = false;
  const out: Word[] = [];
  for (const w of words) {
    const mid = (w.startMs + w.endMs) / 2;

    // слово за концом таймлайна (растянутый вручную субтитр) — двигаем
    // на изменение общей длины
    if (mid >= oldTotal) {
      const delta = newTotal - oldTotal;
      if (delta === 0) {
        out.push(w);
      } else {
        changed = true;
        const startMs = Math.max(w.startMs + delta, 0);
        out.push({ ...w, startMs, endMs: Math.max(w.endMs + delta, startMs + MIN_WORD_MS) });
      }
      continue;
    }

    // старый клип слова — по середине слова
    let o: Pos | null = null;
    for (const p of oldPos) {
      if (mid < p.start + clipDurationMs(p.clip)) {
        o = p;
        break;
      }
    }
    if (!o) {
      out.push(w);
      continue;
    }
    const n = newPos.get(o.clip.id);
    if (!n) {
      changed = true; // клип удалён — его слова тоже
      continue;
    }
    // позиция слова в исходнике клипа: вырезана тримом → слово пропадает
    const srcMid = o.clip.inMs + (mid - o.start);
    if (srcMid < n.clip.inMs || srcMid >= n.clip.outMs) {
      changed = true;
      continue;
    }
    const delta = n.start - o.start + (o.clip.inMs - n.clip.inMs);
    if (delta === 0) {
      out.push(w);
      continue;
    }
    changed = true;
    const startMs = Math.max(w.startMs + delta, 0);
    out.push({ ...w, startMs, endMs: Math.max(w.endMs + delta, startMs + MIN_WORD_MS) });
  }
  if (!changed) return words;
  return out.sort((a, b) => a.startMs - b.startMs);
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
