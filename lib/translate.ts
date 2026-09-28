// Перевод видео целиком или частями.
//
// HeyGen video-translate (через WaveSpeed) берёт максимум 120 секунд на
// запрос — ролик длиннее просто падает с ошибкой. Поэтому длинное видео
// режется на части ПО ПАУЗАМ МЕЖДУ СЛОВАМИ (чтобы шов не попал на середину
// слова), части переводятся ПАРАЛЛЕЛЬНО и склеиваются обратно.
//
// Каждая переведённая часть кэшируется файлом: упавший или прерванный
// перевод дожимается со второй попытки, не платя за уже готовые части.
import fs from "node:fs";
import path from "node:path";
import { flattenTimeline, probeMedia } from "./ffmpeg";
import { compressToSize } from "./compress";
import { translateVideoFile, TRANSLATE_COMPRESS_TARGET_MB } from "./wavespeed";
import { rmFileSync } from "./rmrf";

/** Жёсткий лимит HeyGen video-translate — 120 с на запрос. */
export const TRANSLATE_HARD_LIMIT_MS = 120_000;
/** Максимум, который отправляем: запас на округление длительности у них. */
export const TRANSLATE_MAX_CHUNK_MS = 112_000;
/** Целевая длина части — на неё ориентируется разбивка. */
export const TRANSLATE_TARGET_CHUNK_MS = 95_000;
/** Пауза короче этой под разрез не годится. */
const MIN_CUT_GAP_MS = 120;
/** Огрызки короче этого не создаём — HeyGen на них выдаёт мусор. */
const MIN_CHUNK_MS = 5_000;
/** Сколько частей переводим одновременно по умолчанию. */
const DEFAULT_PARALLEL = 3;

export type TranslateChunk = { startMs: number; endMs: number };

type TimeSpan = { startMs: number; endMs: number };

/** Паузы между словами: точка разреза = середина паузы. */
function speechGaps(words: TimeSpan[]): { atMs: number; gapMs: number }[] {
  const sorted = [...words]
    .filter((w) => Number.isFinite(w.startMs) && Number.isFinite(w.endMs))
    .sort((a, b) => a.startMs - b.startMs);
  const gaps: { atMs: number; gapMs: number }[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const gapMs = sorted[i + 1].startMs - sorted[i].endMs;
    if (gapMs < MIN_CUT_GAP_MS) continue;
    gaps.push({ atMs: Math.round(sorted[i].endMs + gapMs / 2), gapMs });
  }
  return gaps;
}

/**
 * Разбивка видео на части под лимит перевода. Чистая функция — тестируется
 * без ffmpeg и без сети (scripts/test-translate-plan.mts).
 *
 * Разрез ищется в окне вокруг «идеальной» точки и выбирается по паузе:
 * ближе к идеалу лучше, длинная пауза — плюс. Если пауз в окне нет
 * (музыка, непрерывная речь) — режем ровно по времени.
 */
export function planTranslateChunks(
  durationMs: number,
  words: TimeSpan[] = [],
  opts: { maxMs?: number; targetMs?: number } = {}
): TranslateChunk[] {
  const dur = Math.max(Math.round(durationMs), 0);
  const maxMs = Math.max(Math.round(opts.maxMs ?? TRANSLATE_MAX_CHUNK_MS), MIN_CHUNK_MS * 2);
  const targetMs = Math.min(
    Math.max(Math.round(opts.targetMs ?? TRANSLATE_TARGET_CHUNK_MS), MIN_CHUNK_MS),
    maxMs
  );
  if (dur <= maxMs) return [{ startMs: 0, endMs: dur }];

  const gaps = speechGaps(words);
  const out: TranslateChunk[] = [];
  let cursor = 0;

  while (dur - cursor > maxMs) {
    // сколько частей осталось нарезать — чтобы они вышли примерно равными
    const restParts = Math.max(Math.ceil((dur - cursor) / targetMs), 2);
    const want = cursor + (dur - cursor) / restParts;
    const lo = Math.max(cursor + MIN_CHUNK_MS, want - targetMs * 0.45);
    const hi = Math.min(cursor + maxMs, want + targetMs * 0.45, dur - MIN_CHUNK_MS);

    let cut = Math.round(Math.min(want, hi));
    let best = -Infinity;
    for (const g of gaps) {
      if (g.atMs < lo || g.atMs > hi) continue;
      // пауза свыше 1.5 с уже «достаточно длинная», дальше решает близость
      const score = Math.min(g.gapMs, 1500) - Math.abs(g.atMs - want) * 0.25;
      if (score > best) {
        best = score;
        cut = g.atMs;
      }
    }
    out.push({ startMs: cursor, endMs: cut });
    cursor = cut;
  }

  const tail = dur - cursor;
  if (tail < MIN_CHUNK_MS && out.length > 0 && tail + (out[out.length - 1].endMs - out[out.length - 1].startMs) <= maxMs) {
    // совсем короткий хвост приклеиваем к последней части
    out[out.length - 1].endMs = dur;
  } else {
    out.push({ startMs: cursor, endMs: dur });
  }
  return out;
}

/** Вырезает кусок исходника в отдельный файл (перекодированием — точный шов). */
async function cutChunk(opts: {
  inputPath: string;
  chunk: TranslateChunk;
  width: number;
  height: number;
  fps: number;
  sourceDurationMs: number;
  hasAudio: boolean;
  outPath: string;
}) {
  await flattenTimeline({
    clips: [
      {
        path: opts.inputPath,
        kind: "video",
        inMs: opts.chunk.startMs,
        outMs: opts.chunk.endMs,
        hasAudio: opts.hasAudio,
        width: opts.width,
        height: opts.height,
        sourceDurationMs: opts.sourceDurationMs,
      },
    ],
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    musicPath: null,
    outPath: opts.outPath,
  });
}

/** Склеивает переведённые части встык (размер/fps берём у первой части). */
async function concatParts(parts: string[], outPath: string) {
  const probes = await Promise.all(parts.map((p) => probeMedia(p)));
  const width = Math.max(Math.round(probes[0].width / 2) * 2, 2);
  const height = Math.max(Math.round(probes[0].height / 2) * 2, 2);
  let fps = probes[0].fps;
  if (!Number.isFinite(fps) || fps < 5 || fps > 120) fps = 30;
  await flattenTimeline({
    clips: parts.map((p, i) => ({
      path: p,
      kind: "video" as const,
      inMs: 0,
      outMs: probes[i].durationMs,
      hasAudio: probes[i].hasAudio,
      width: probes[i].width,
      height: probes[i].height,
      sourceDurationMs: probes[i].durationMs,
    })),
    width,
    height,
    fps,
    musicPath: null,
    outPath,
  });
}

/**
 * Обычно переводим через WaveSpeed. `TYTRY_FAKE_TRANSLATE=1` подменяет
 * перевод копированием файла — это режим для e2e-тестов пайплайна,
 * чтобы прогонять итерации, не платя за HeyGen.
 */
function defaultTranslator(): typeof translateVideoFile {
  if (process.env.TYTRY_FAKE_TRANSLATE !== "1") return translateVideoFile;
  console.warn("[translate] TYTRY_FAKE_TRANSLATE=1 — перевод подменён копией файла");
  return async (o) => {
    o.onProgress?.(0.5);
    fs.copyFileSync(o.inputPath, o.outPath);
    o.onProgress?.(1);
  };
}

export type TranslateLongOptions = {
  inputPath: string;
  /** куда положить переведённое видео целиком */
  outPath: string;
  /** код языка из lib/languages.ts */
  language: string;
  /** слова исходника — по их паузам ищутся точки разреза */
  words?: TimeSpan[];
  /** папка кэша переведённых частей (переводы платные — не удаляем зря) */
  partsDir: string;
  /** префикс имён частей, уникальный для проекта+итерации+языка */
  partsPrefix: string;
  /** папка промежуточных нарезок (удаляются после склейки) */
  tmpDir: string;
  /** сколько частей переводить одновременно (1..6) */
  parallel?: number;
  onProgress?: (p: number) => void;
  /** сколько частей уже готово (для подписи в интерфейсе) */
  onParts?: (done: number, total: number) => void;
  /** подмена платного перевода — только для тестов (scripts/test-translate-chunks.mts) */
  translator?: typeof translateVideoFile;
};

/**
 * Полный перевод файла: короткое видео уходит одним запросом, длинное
 * режется, переводится параллельно и склеивается.
 */
export async function translateLongVideo(opts: TranslateLongOptions): Promise<void> {
  const translate = opts.translator ?? defaultTranslator();
  const probe = await probeMedia(opts.inputPath);
  const chunks = planTranslateChunks(probe.durationMs, opts.words ?? []);
  // прогресс не должен дёргаться назад: части считаются вместе с нарезкой
  let reported = 0;
  const report = (p: number) => {
    const v = Math.min(Math.max(p, 0), 1);
    if (v <= reported) return;
    reported = v;
    opts.onProgress?.(v);
  };

  // короткое видео: как раньше, одним запросом прямо в целевой файл
  if (chunks.length === 1) {
    opts.onParts?.(0, 1);
    await translate({
      inputPath: opts.inputPath,
      outPath: opts.outPath,
      language: opts.language,
      durationMs: probe.durationMs,
      onProgress: report,
    });
    opts.onParts?.(1, 1);
    return;
  }

  const total = chunks.length;
  const partPath = (i: number) =>
    path.join(opts.partsDir, `${opts.partsPrefix}_p${i + 1}of${total}.mp4`);
  const cutPath = (i: number) =>
    path.join(opts.tmpDir, `${opts.partsPrefix}_cut${i + 1}of${total}.mp4`);
  const ready = (i: number) => {
    try {
      return fs.statSync(partPath(i)).size > 0;
    } catch {
      return false;
    }
  };

  const CUT_SHARE = 0.08; // нарезка — небольшая доля времени, дальше сеть
  const CONCAT_SHARE = 0.06;
  const progress = new Array(total).fill(0) as number[];
  let cutProgress = 0; // 0..1 внутри этапа нарезки
  chunks.forEach((_, i) => {
    if (ready(i)) progress[i] = 1;
  });
  const doneCount = () => progress.filter((p) => p >= 1).length;
  const pushProgress = () => {
    const avg = progress.reduce((a, b) => a + b, 0) / total;
    report(CUT_SHARE * cutProgress + avg * (1 - CUT_SHARE - CONCAT_SHARE));
  };
  opts.onParts?.(doneCount(), total);
  pushProgress();

  try {
    // ── 1. нарезка (только тех частей, перевода которых ещё нет) ──
    // последовательно: ffmpeg и так грузит GPU/CPU целиком
    const todo = chunks.map((_, i) => i).filter((i) => !ready(i));
    if (todo.length === 0) cutProgress = 1;
    for (let k = 0; k < todo.length; k++) {
      const i = todo[k];
      await cutChunk({
        inputPath: opts.inputPath,
        chunk: chunks[i],
        width: probe.width,
        height: probe.height,
        fps: Number.isFinite(probe.fps) && probe.fps >= 5 && probe.fps <= 120 ? probe.fps : 30,
        sourceDurationMs: probe.durationMs,
        hasAudio: probe.hasAudio,
        outPath: cutPath(i),
      });
      // лимит перевода действует на каждую часть отдельно
      await compressToSize(cutPath(i), TRANSLATE_COMPRESS_TARGET_MB);
      cutProgress = (k + 1) / todo.length;
      pushProgress();
    }

    // ── 2. перевод частей параллельно ──
    const limit = Math.min(
      Math.max(Math.round(opts.parallel ?? DEFAULT_PARALLEL), 1),
      6,
      todo.length || 1
    );
    let next = 0;
    const errors: Error[] = [];

    const worker = async () => {
      for (;;) {
        const k = next++;
        if (k >= todo.length) return;
        const i = todo[k];
        const tmpOut = `${partPath(i)}.part`;
        try {
          await translate({
            inputPath: cutPath(i),
            outPath: tmpOut,
            language: opts.language,
            durationMs: chunks[i].endMs - chunks[i].startMs,
            onProgress: (p) => {
              progress[i] = Math.min(p, 0.999);
              pushProgress();
            },
          });
          // готовое имя появляется только целиком — недокачанный файл
          // не должен сойти за кэш при повторной попытке
          fs.renameSync(tmpOut, partPath(i));
          progress[i] = 1;
          opts.onParts?.(doneCount(), total);
          pushProgress();
        } catch (err) {
          rmFileSync(tmpOut);
          errors.push(err instanceof Error ? err : new Error(String(err)));
          return; // этот воркер выходит, остальные дожимают свои части
        }
      }
    };

    await Promise.all(Array.from({ length: limit }, worker));
    if (errors.length > 0) {
      const failed = total - doneCount();
      throw new Error(
        `Translation failed on ${failed} of ${total} parts: ${errors[0].message}` +
          ` — retry (🔄) skips the parts that are already paid for`
      );
    }

    // ── 3. склейка переведённых частей ──
    // сначала в промежуточный файл: недосклеенный обрубок не должен занять
    // место кэша перевода (иначе повтор отдаст битое видео)
    pushProgress();
    const joined = path.join(opts.tmpDir, `${opts.partsPrefix}_join.mp4`);
    try {
      await concatParts(
        chunks.map((_, i) => partPath(i)),
        joined
      );
      fs.renameSync(joined, opts.outPath);
    } finally {
      rmFileSync(joined);
    }
    // склейка удалась — платные части больше не нужны
    chunks.forEach((_, i) => rmFileSync(partPath(i)));
    report(1);
  } finally {
    // нарезки исходника не нужны ни при удаче, ни при сбое
    chunks.forEach((_, i) => rmFileSync(cutPath(i)));
  }
}
