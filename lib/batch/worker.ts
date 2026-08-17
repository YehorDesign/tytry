// Конвейер батч-режима: zip → распаковка → монтаж+ендкард → «чистый» дубль →
// Deepgram → рендер субтитров с музыкой и дисклеймером → ужатие → папка вывода.
//
// Принципы:
//  • каждый архив обрабатывается независимо — ошибка одного не трогает остальные;
//  • каждая стадия оставляет артефакт на диске (чекпоинт): после выключения
//    света обработка продолжается с места, где остановилась;
//  • batch.json пишется атомарно (tmp+rename) после каждого перехода стадии.
import fs from "node:fs";
import path from "node:path";
import { extractZip } from "../unzip";
import { getSettings } from "../settings";
import {
  extractAudio,
  extractThumbnail,
  extractTimelineAudio,
  flattenTimeline,
  mixMusic,
  probeMedia,
  type FlattenClip,
} from "../ffmpeg";
import { transcribeAudio } from "../deepgram";
import { renderProjectNative } from "../render-native/render";
import { compressToSize } from "../compress";
import { numericNameCompare } from "../montage";
import { rmFileSync, rmrf } from "../rmrf";
import { sanitizeFileName } from "../filename";
import {
  computeClipTrims,
  shiftWordsByTrims,
  totalTrimMs,
  type SilenceTrim,
} from "../silence";
import {
  MUSIC_DIR,
  THUMBS_DIR,
  UPLOADS_DIR,
  ensureWorkspace,
  listMusic,
  saveProject,
} from "../store";
import type { Project, TimelineClip, Word } from "../types";
import {
  BATCHES_DIR,
  ENDCARDS_DIR,
  itemWorkDir,
  listEndcards,
  loadBatch,
  saveBatch,
} from "./store";
import type { Batch, BatchItem } from "./types";

const VIDEO_EXT = /\.(mp4|mov|m4v|avi|mkv|webm|mpg|mpeg|wmv)$/i;

type WorkerState = {
  /** batchId → множество обрабатываемых сейчас itemId */
  running: Map<string, Set<string>>;
  /** батчи, которым нужен pump после освобождения слота */
  lastProgressSave: Map<string, number>;
};

// globalThis — чтобы состояние переживало hot-reload в next dev
const g = globalThis as unknown as { __tytryBatchWorker?: WorkerState };
const state: WorkerState =
  g.__tytryBatchWorker ??
  (g.__tytryBatchWorker = { running: new Map(), lastProgressSave: new Map() });

function runningSet(batchId: string): Set<string> {
  let set = state.running.get(batchId);
  if (!set) state.running.set(batchId, (set = new Set()));
  return set;
}

export function isItemRunning(batchId: string, itemId: string): boolean {
  return runningSet(batchId).has(itemId);
}

function maxParallel(): number {
  const n = getSettings().parallelRenders ?? 3;
  return Math.min(Math.max(Math.round(n), 1), 4);
}

/** Синхронная точечная правка элемента — без гонок load-modify-save. */
function updateItem(
  batchId: string,
  itemId: string,
  patch: Partial<BatchItem>
): BatchItem | null {
  const batch = loadBatch(batchId);
  if (!batch) return null;
  const item = batch.items.find((i) => i.id === itemId);
  if (!item) return null;
  Object.assign(item, patch);
  saveBatch(batch);
  return item;
}

/** Прогресс рендера пишем не чаще раза в 1.5с, чтобы не молотить диск. */
function saveProgressThrottled(batchId: string, itemId: string, progress: number) {
  const key = `${batchId}/${itemId}`;
  const now = Date.now();
  if (now - (state.lastProgressSave.get(key) ?? 0) < 1500) return;
  state.lastProgressSave.set(key, now);
  updateItem(batchId, itemId, { progress });
}

function isPaused(batchId: string): boolean {
  return loadBatch(batchId)?.paused ?? true;
}

/** Запускает/продолжает обработку батча. Безопасно звать сколько угодно раз. */
export function startBatch(batchId: string) {
  const batch = loadBatch(batchId);
  if (!batch || batch.paused) return;
  const running = runningSet(batchId);
  for (const item of batch.items) {
    if (running.size >= maxParallel()) break;
    if (running.has(item.id)) continue;
    if (item.status === "done" || item.status === "error") continue;
    running.add(item.id);
    void runItem(batchId, item.id).finally(() => {
      running.delete(item.id);
      startBatch(batchId);
    });
  }
}

export function pauseBatch(batchId: string) {
  const batch = loadBatch(batchId);
  if (!batch) return;
  batch.paused = true;
  saveBatch(batch);
}

export function resumeBatch(batchId: string) {
  const batch = loadBatch(batchId);
  if (!batch) return;
  batch.paused = false;
  saveBatch(batch);
  startBatch(batchId);
}

/** Сбрасывает ошибку элемента: продолжит с последнего чекпоинта. */
export function retryItem(batchId: string, itemId: string) {
  updateItem(batchId, itemId, { status: "queued", error: undefined, progress: 0 });
  startBatch(batchId);
}

// ── субтитры из музыки ──
// Текст трека распознаётся ОДИН раз на весь батч (трек общий) и кешируется
// в batches/<id>/musicwords.json. Слова якорятся к треку: музыка в батче
// всегда начинается с 0:00 готового видео, сдвиги не нужны.
const musicWordsInflight = new Map<string, Promise<Word[]>>();

async function musicWordsForBatch(batch: Batch): Promise<Word[]> {
  const file = path.join(BATCHES_DIR, batch.id, "musicwords.json");
  if (fs.existsSync(file)) {
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { words: Word[] }).words;
  }
  let p = musicWordsInflight.get(batch.id);
  if (!p) {
    p = (async () => {
      const track = listMusic().find((t) => t.id === batch.preset.musicTrackId);
      if (!track) throw new Error("Музыка из пресета не найдена в библиотеке");
      const musicPath = path.join(MUSIC_DIR, track.fileName);
      if (!fs.existsSync(musicPath)) throw new Error("Файл музыки удалён с диска");
      const wav = path.join(BATCHES_DIR, batch.id, "music.wav");
      let lyrics: Word[];
      try {
        await extractAudio(musicPath, wav);
        lyrics = await transcribeAudio(wav, batch.preset.language);
      } finally {
        rmFileSync(wav);
      }
      if (lyrics.length === 0) {
        throw new Error("Deepgram не нашёл текст в музыке");
      }
      const words = lyrics.map((w) => ({ ...w, id: `m-${w.id}`, fromMusic: true }));
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ words }), "utf8");
      fs.renameSync(tmp, file);
      return words;
    })();
    musicWordsInflight.set(batch.id, p);
    void p.finally(() => musicWordsInflight.delete(batch.id)).catch(() => {});
  }
  return p;
}

// ── сам конвейер ──

function listVideosRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__MACOSX" || entry.name.startsWith("._") || entry.name.startsWith("."))
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listVideosRecursive(full));
    else if (VIDEO_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

/** Чекпоинт транскрибации: слова уже сдвинуты, тримы — для повтора склейки. */
type WordsFile = {
  words: Word[];
  /** v2: тримы тишины по краям каждого клипа */
  trims?: SilenceTrim[];
  /** v1 — старые чекпоинты: трим только первого/последнего клипа */
  leadTrimMs?: number;
  tailTrimMs?: number;
};

/** Тримы из чекпоинта (v2) или конвертация из старого формата (v1). */
function readTrims(wf: WordsFile, clipCount: number): SilenceTrim[] | null {
  if (wf.trims && wf.trims.length > 0) return wf.trims;
  if (!wf.leadTrimMs && !wf.tailTrimMs) return null;
  const trims: SilenceTrim[] = Array.from({ length: clipCount }, () => ({
    lead: 0,
    tail: 0,
  }));
  if (wf.leadTrimMs) trims[0].lead = wf.leadTrimMs;
  if (wf.tailTrimMs) trims[clipCount - 1].tail += wf.tailTrimMs;
  return trims;
}

function safeFileName(name: string): string {
  return sanitizeFileName(name) || "video";
}

/** Папка видоса: всё про один архив лежит вместе (финал, clean, итерации). */
export function itemOutDir(batch: Batch, item: BatchItem): string {
  return path.join(batch.outputDir, safeFileName(item.name));
}

/** Целевой путь готового файла — детерминированный (важно для чекпоинтов). */
function finalTarget(batch: Batch, item: BatchItem): string {
  return path.join(itemOutDir(batch, item), `${safeFileName(item.name)}.mp4`);
}

function cleanTarget(batch: Batch, item: BatchItem): string {
  return path.join(itemOutDir(batch, item), `${safeFileName(item.name)}_clean.mp4`);
}

/** Переносит файл, работая и между дисками. */
function moveFile(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
    rmFileSync(from);
  }
}

async function runItem(batchId: string, itemId: string) {
  try {
    const batch = loadBatch(batchId);
    if (!batch) return;
    const item = batch.items.find((i) => i.id === itemId);
    if (!item) return;
    const preset = batch.preset;

    const wd = itemWorkDir(batchId, itemId);
    const srcDir = path.join(wd, "src");
    const cleanPath = path.join(wd, "clean.mp4");
    const wordsPath = path.join(wd, "words.json");
    const finalWork = path.join(wd, "final.mp4");
    fs.mkdirSync(wd, { recursive: true });

    // субтитры из текста музыки: речь в клипах нужна только для обрезки тишины
    const useMusicCaptions = !!(
      preset.captions && preset.captionsFromMusic && preset.musicTrackId
    );
    const needWords = (preset.captions && !useMusicCaptions) || preset.trimSilence;
    let words: Word[] | null = null;

    // ── 1-3. распаковка, транскрибация, монтаж (чекпоинты: words.json, clean.mp4) ──
    if (!fs.existsSync(cleanPath)) {
      if (isPaused(batchId)) return;

      let videos = listVideosRecursive(srcDir);
      if (videos.length === 0) {
        updateItem(batchId, itemId, { status: "extract", progress: 0 });
        if (!fs.existsSync(item.zipPath)) {
          throw new Error(`Архив не найден: ${item.zipPath}`);
        }
        // распаковка в .part + rename: недораспакованная папка (обрыв, рестарт)
        // не сойдёт за готовый чекпоинт
        const partDir = `${srcDir}.part`;
        await rmrf(partDir);
        await rmrf(srcDir);
        fs.mkdirSync(partDir, { recursive: true });
        try {
          await extractZip(item.zipPath, partDir);
        } catch (err) {
          await rmrf(partDir);
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Не удалось распаковать архив: ${msg}`);
        }
        fs.renameSync(partDir, srcDir);
        videos = listVideosRecursive(srcDir);
      }
      if (videos.length === 0) {
        throw new Error("В архиве нет видеофайлов");
      }
      videos.sort((a, b) => numericNameCompare(path.basename(a), path.basename(b)));

      const clips: FlattenClip[] = [];
      for (const file of videos) {
        try {
          const meta = await probeMedia(file);
          clips.push({
            path: file,
            kind: "video",
            inMs: 0,
            outMs: meta.durationMs,
            hasAudio: meta.hasAudio,
            width: meta.width,
            height: meta.height,
            sourceDurationMs: meta.durationMs,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Битый видеофайл «${path.basename(file)}»: ${msg}`);
        }
      }

      // транскрибация ДО склейки: аудио собирается прямо из клипов,
      // ендкард в распознавание не попадает, а тримы тишины применяются
      // при склейке — без лишнего перекодирования
      let trims: SilenceTrim[] | null = null;
      if (needWords) {
        if (fs.existsSync(wordsPath)) {
          const wf = JSON.parse(fs.readFileSync(wordsPath, "utf8")) as WordsFile;
          words = wf.words;
          trims = readTrims(wf, clips.length);
        } else {
          if (isPaused(batchId)) return;
          updateItem(batchId, itemId, { status: "transcribe" });
          const wav = path.join(wd, "audio.wav");
          try {
            await extractTimelineAudio(clips, wav);
            words = await transcribeAudio(wav, preset.language);
          } finally {
            rmFileSync(wav);
          }
          if (words.length === 0 && preset.captions && !useMusicCaptions) {
            throw new Error("Deepgram не нашёл речь в видео");
          }
          if (preset.trimSilence && words.length > 0) {
            // тишина режется по краям КАЖДОГО клипа (клипы без речи не трогаем)
            const durations = clips.map((c) => c.outMs - c.inMs);
            trims = computeClipTrims(durations, words);
            if (totalTrimMs(trims) === 0) trims = null;
            // сдвигаем субтитры, чтобы остались на своих словах
            if (trims) words = shiftWordsByTrims(words, durations, trims);
          }
          const tmpWords = `${wordsPath}.tmp`;
          fs.writeFileSync(
            tmpWords,
            JSON.stringify({ words, trims: trims ?? undefined } satisfies WordsFile),
            "utf8"
          );
          fs.renameSync(tmpWords, wordsPath);
        }
        if (trims) {
          for (let i = 0; i < clips.length && i < trims.length; i++) {
            clips[i].inMs += trims[i].lead;
            clips[i].outMs -= trims[i].tail;
          }
        }
      }

      if (isPaused(batchId)) return;
      updateItem(batchId, itemId, { status: "montage" });
      const clipsDurationMs = clips.reduce((s, c) => s + (c.outMs - c.inMs), 0);

      // ендкард в конец
      let endcardMs = 0;
      if (preset.endcardId) {
        const card = listEndcards().find((c) => c.id === preset.endcardId);
        if (!card) throw new Error("Ендкард из пресета не найден в библиотеке");
        const cardPath = path.join(ENDCARDS_DIR, card.fileName);
        if (!fs.existsSync(cardPath)) throw new Error("Файл ендкарда удалён с диска");
        endcardMs = card.kind === "image" ? preset.endcardDurationMs : card.durationMs;
        clips.push({
          path: cardPath,
          kind: card.kind,
          inMs: 0,
          outMs: endcardMs,
          hasAudio: card.hasAudio,
          width: card.width,
          height: card.height,
          sourceDurationMs: card.durationMs,
        });
      }

      // канвас — по первому видеоклипу
      const base = clips[0];
      const part = `${cleanPath}.part.mp4`;
      try {
        await flattenTimeline({
          clips,
          width: base.width,
          height: base.height,
          fps: 30,
          musicPath: null,
          outPath: part,
        });
      } catch (err) {
        rmFileSync(part);
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Ошибка склейки монтажа: ${msg.slice(-600)}`);
      }
      fs.renameSync(part, cleanPath);
      updateItem(batchId, itemId, {
        clipCount: videos.length,
        clipsDurationMs,
        durationMs: clipsDurationMs + endcardMs,
        // границы сегментов склейки — по ним потом собирается таймлайн редактора
        segments: clips.map((c) => ({
          name: path.basename(c.path),
          durMs: c.outMs - c.inMs,
        })),
      });
      // распакованные исходники больше не нужны
      await rmrf(srcDir);
    }

    // ── «чистый» дубль: монтаж + ендкард, без субтитров/музыки/сжатия ──
    {
      const fresh = loadBatch(batchId)!.items.find((i) => i.id === itemId)!;
      if (preset.cleanCopy && (!fresh.cleanFile || !fs.existsSync(fresh.cleanFile))) {
        const target = cleanTarget(batch, item);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(cleanPath, target);
        updateItem(batchId, itemId, { cleanFile: target });
      }
    }

    // ── резюме после обрыва: clean.mp4 уже есть, слова — из чекпоинта ──
    if (needWords && words === null) {
      if (fs.existsSync(wordsPath)) {
        words = (JSON.parse(fs.readFileSync(wordsPath, "utf8")) as WordsFile).words;
      } else if (preset.captions && !useMusicCaptions) {
        // крайний случай (чекпоинт слов удалён вручную): распознаём по склейке,
        // отрезав ендкард по сохранённой длительности монтажа
        if (isPaused(batchId)) return;
        updateItem(batchId, itemId, { status: "transcribe" });
        const fresh = loadBatch(batchId)!.items.find((i) => i.id === itemId)!;
        const wav = path.join(wd, "audio.wav");
        try {
          await extractAudio(cleanPath, wav, fresh.clipsDurationMs);
          words = await transcribeAudio(wav, preset.language);
        } finally {
          rmFileSync(wav);
        }
        if (words.length === 0) {
          throw new Error("Deepgram не нашёл речь в видео");
        }
        const tmp = `${wordsPath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ words } satisfies WordsFile), "utf8");
        fs.renameSync(tmp, wordsPath);
      }
    }

    // слова для субтитров: речь из клипов или текст музыки (кеш на весь батч).
    // Музыка играет один проход (без лупа) — текст тоже; отсекаем только
    // хвост, который вылезает за монтаж (ендкард остаётся чистым).
    let captionWords = words;
    if (useMusicCaptions) {
      const lyrics = await musicWordsForBatch(batch);
      const fresh = loadBatch(batchId)!.items.find((i) => i.id === itemId)!;
      const untilMs = fresh.clipsDurationMs ?? fresh.durationMs ?? 0;
      captionWords =
        untilMs > 0
          ? lyrics
              .filter((w) => w.startMs < untilMs)
              .map((w) => (w.endMs > untilMs ? { ...w, endMs: untilMs } : w))
          : lyrics;
    }

    // ── 4. музыка + рендер субтитров (чекпоинт: rendered + final.mp4) ──
    const freshItem = () => loadBatch(batchId)!.items.find((i) => i.id === itemId)!;
    if (!(freshItem().rendered && fs.existsSync(finalWork))) {
      if (isPaused(batchId)) return;
      updateItem(batchId, itemId, { status: "render", progress: 0, rendered: false });

      let renderInput = cleanPath;
      if (preset.musicTrackId) {
        const track = listMusic().find((t) => t.id === preset.musicTrackId);
        if (!track) throw new Error("Музыка из пресета не найдена в библиотеке");
        const musicPath = path.join(MUSIC_DIR, track.fileName);
        if (!fs.existsSync(musicPath)) throw new Error("Файл музыки удалён с диска");
        const withMusic = path.join(wd, "withmusic.mp4");
        await mixMusic({
          videoPath: cleanPath,
          musicPath,
          volume: preset.musicVolume,
          outPath: withMusic,
        });
        renderInput = withMusic;
      }

      if (preset.captions && captionWords && captionWords.length > 0) {
        const meta = await probeMedia(cleanPath);
        const project: Project = {
          id: `batch-${itemId}`,
          name: item.name,
          createdAt: new Date().toISOString(),
          status: "rendering",
          language: preset.language,
          video: {
            fileName: "",
            originalName: item.name,
            width: meta.width,
            height: meta.height,
            durationMs: meta.durationMs,
            fps: meta.fps,
          },
          words: captionWords,
          styleId: preset.styleId,
          overrides: preset.overrides,
          disclaimer: preset.disclaimer,
        };
        try {
          await renderProjectNative(project, {
            inputPath: renderInput,
            outputPath: finalWork,
            encoder: getSettings().encoder ?? "auto",
            onProgress: (p) => saveProgressThrottled(batchId, itemId, p),
          });
        } catch (err) {
          rmFileSync(finalWork);
          throw err;
        }
      } else {
        // без субтитров: финал = монтаж (+музыка)
        fs.copyFileSync(renderInput, finalWork);
      }
      if (renderInput !== cleanPath) rmFileSync(renderInput);
      updateItem(batchId, itemId, { rendered: true, progress: 1 });
    }

    // ── 5. ужатие под лимит (идемпотентно: уже ужатый файл не трогается) ──
    if (preset.maxSizeMb > 0) {
      if (isPaused(batchId)) return;
      updateItem(batchId, itemId, { status: "compress" });
      await compressToSize(finalWork, preset.maxSizeMb);
    }

    // ── 6. финал: перенос в папку вывода ──
    const target = finalTarget(batch, item);
    moveFile(finalWork, target);

    // ── 7. проект редактора: открываемый таймлайн для итераций-хуков ──
    // склейка (clean.mp4) переезжает в uploads и становится исходником проекта
    try {
      const fresh = loadBatch(batchId)?.items.find((i) => i.id === itemId) ?? item;
      await exportItemProject(
        batch,
        { ...fresh, outputFile: target },
        cleanPath,
        captionWords
      );
    } catch (err) {
      // не критично: видео готово, просто без открываемого таймлайна
      console.warn("batch: project export failed:", err);
    }

    await rmrf(wd);
    if (item.zipOwned) rmFileSync(item.zipPath);
    updateItem(batchId, itemId, {
      status: "done",
      progress: 1,
      outputFile: target,
      error: undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateItem(batchId, itemId, { status: "error", error: message });
  }
}

/**
 * Готовый батч-элемент → проект редактора. Клипы проекта — сегменты
 * склейки (clean.mp4 переезжает в uploads как исходник): таймлайн можно
 * открыть, увидеть расставленные ассеты и делать итерации-хуки.
 */
async function exportItemProject(
  batch: Batch,
  item: BatchItem,
  cleanPath: string,
  words: Word[] | null
) {
  if (!item.segments || item.segments.length === 0) return;
  if (!fs.existsSync(cleanPath)) return;
  ensureWorkspace();
  const preset = batch.preset;
  const projectId = `batch-${item.id}`;
  const flatName = `${projectId}.mp4`;
  moveFile(cleanPath, path.join(UPLOADS_DIR, flatName));
  const flatPath = path.join(UPLOADS_DIR, flatName);
  const meta = await probeMedia(flatPath);
  await extractThumbnail(flatPath, path.join(THUMBS_DIR, `${projectId}.jpg`)).catch(
    () => {}
  );

  // сегменты идут в склейке встык — клипы указывают в неё через inMs/outMs
  const clips: TimelineClip[] = [];
  let acc = 0;
  for (let i = 0; i < item.segments.length; i++) {
    const seg = item.segments[i];
    clips.push({
      id: `seg${i}`,
      kind: "video",
      fileName: flatName,
      originalName: seg.name,
      sourceDurationMs: meta.durationMs,
      inMs: Math.min(acc, meta.durationMs),
      outMs: Math.min(acc + seg.durMs, meta.durationMs),
      width: meta.width,
      height: meta.height,
      hasAudio: true,
    });
    acc += seg.durMs;
  }

  const track = preset.musicTrackId
    ? listMusic().find((t) => t.id === preset.musicTrackId)
    : null;
  const project: Project = {
    id: projectId,
    name: item.name,
    createdAt: new Date().toISOString(),
    status: "done",
    language: preset.language,
    video: {
      fileName: flatName,
      originalName: item.name,
      width: meta.width,
      height: meta.height,
      durationMs: meta.durationMs,
      fps: meta.fps,
    },
    words: words ?? [],
    styleId: preset.styleId,
    overrides: preset.overrides,
    clips,
    music: track
      ? {
          trackId: track.id,
          fileName: track.fileName,
          name: track.name,
          volume: preset.musicVolume,
        }
      : null,
    disclaimer: preset.disclaimer,
    renderFile: item.outputFile,
    batchRef: {
      outputDir: itemOutDir(batch, item),
      maxSizeMb: preset.maxSizeMb,
    },
  };
  saveProject(project);
  updateItem(batch.id, item.id, { projectId });
}
