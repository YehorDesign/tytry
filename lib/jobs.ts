import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CaptionInputProps, Iteration, Project } from "./types";
import {
  AUDIO_DIR,
  MUSIC_DIR,
  RENDERS_DIR,
  UPLOADS_DIR,
  loadProject,
  updateIteration,
  updateProject,
} from "./store";
import { getSettings, getWavespeedKey } from "./settings";
import { renderProjectNative } from "./render-native/render";
import { extractAudio, flattenTimeline, mixMusic, probeVideo } from "./ffmpeg";
import { getClips, needsFlatten } from "./montage";
import { buildIterationProject } from "./iterations";
import { compressToSize, enforceSizeLimit } from "./compress";
import { transcribeAudio } from "./deepgram";
import { translateVideoFile, WAVESPEED_UPLOAD_LIMIT_MB } from "./wavespeed";
import { translateLanguage } from "./languages";
import { rmFileSync } from "./rmrf";
import { sanitizeFileName } from "./filename";

// корень приложения (в упакованном Electron задаётся через env)
const APP_ROOT = process.env.TYTRY_APP_DIR || process.cwd();

export type RenderJob = {
  projectId: string;
  status: "queued" | "bundling" | "rendering" | "done" | "error";
  progress: number; // 0..1
  error?: string;
};

type JobState = {
  jobs: Map<string, RenderJob>;
  queue: string[];
  active: number;
  bundlePromise: Promise<string> | null;
};

// globalThis — чтобы состояние переживало hot-reload в next dev
const g = globalThis as unknown as { __tytryJobs?: JobState };
const state: JobState =
  g.__tytryJobs ??
  (g.__tytryJobs = { jobs: new Map(), queue: [], active: 0, bundlePromise: null });

export function getJob(projectId: string): RenderJob | null {
  return state.jobs.get(projectId) ?? null;
}

/** Есть ли живой джоб (в очереди/в работе) для проекта или итерации. */
export function hasActiveJob(key: string): boolean {
  const job = state.jobs.get(key);
  return (
    !!job &&
    (job.status === "queued" || job.status === "bundling" || job.status === "rendering")
  );
}

/** Сколько видео рендерим одновременно. Chrome-движок всегда по одному. */
function maxParallel(): number {
  const s = getSettings();
  if (s.renderEngine === "chrome") return 1;
  const n = s.parallelRenders ?? 3;
  return Math.min(Math.max(Math.round(n), 1), 4);
}

export function enqueueRender(projectId: string, origin: string): RenderJob {
  const existing = state.jobs.get(projectId);
  if (existing && (existing.status === "queued" || existing.status === "bundling" || existing.status === "rendering")) {
    return existing;
  }
  const job: RenderJob = { projectId, status: "queued", progress: 0 };
  state.jobs.set(projectId, job);
  state.queue.push(projectId);
  updateProject(projectId, { status: "rendering", renderProgress: 0, error: undefined });
  pump(origin);
  return job;
}

/**
 * Ставит рендер итерации в общую очередь. Ключ джоба — `projectId#iterationId`,
 * чтобы итерации и обычный рендер проекта не мешали друг другу.
 */
export function enqueueIteration(
  projectId: string,
  iterationId: string,
  origin: string
): RenderJob {
  const key = `${projectId}#${iterationId}`;
  const existing = state.jobs.get(key);
  if (existing && (existing.status === "queued" || existing.status === "bundling" || existing.status === "rendering")) {
    return existing;
  }
  const job: RenderJob = { projectId: key, status: "queued", progress: 0 };
  state.jobs.set(key, job);
  state.queue.push(key);
  updateIteration(projectId, iterationId, {
    status: "queued",
    progress: 0,
    error: undefined,
  });
  pump(origin);
  return job;
}

function pump(origin: string) {
  while (state.queue.length > 0 && state.active < maxParallel()) {
    const key = state.queue.shift()!;
    const job = state.jobs.get(key);
    if (!job) continue;
    state.active++;
    void runJob(key, job, origin).finally(() => {
      state.active--;
      pump(origin);
    });
  }
}

async function runJob(key: string, job: RenderJob, origin: string) {
  const [projectId, iterationId] = key.split("#");
  try {
    if (iterationId) {
      await renderIteration(projectId, iterationId, job);
    } else if (getSettings().renderEngine === "chrome") {
      await renderProjectChrome(projectId, job, origin);
    } else {
      await renderNative(projectId, job);
    }
    job.status = "done";
    job.progress = 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.status = "error";
    job.error = message;
    if (iterationId) {
      updateIteration(projectId, iterationId, { status: "error", error: message });
    } else {
      updateProject(projectId, { status: "error", error: message });
    }
  }
}

/**
 * Монтаж (клипы/трим/музыка) сначала склеивается ffmpeg-ом в промежуточный
 * mp4, по которому уже идёт обычный рендер субтитров. Классический проект
 * без правок рендерится прямо с исходника.
 */
async function prepareInput(project: Project): Promise<string> {
  if (!needsFlatten(project)) return videoSourcePath(project);
  const flatPath = path.join(RENDERS_DIR, `${project.id}_flat.mp4`);
  let fps = project.video.fps;
  if (!Number.isFinite(fps) || fps < 5 || fps > 120) fps = 30;
  await flattenTimeline({
    clips: getClips(project).map((c) => ({
      path: path.join(UPLOADS_DIR, c.fileName),
      kind: c.kind,
      inMs: c.inMs,
      outMs: c.outMs,
      hasAudio: c.hasAudio,
      width: c.width,
      height: c.height,
      sourceDurationMs: c.sourceDurationMs,
      zoom: c.zoom,
      panX: c.panX,
      panY: c.panY,
      speed: c.speed,
    })),
    width: project.video.width,
    height: project.video.height,
    fps,
    musicPath: project.music ? path.join(MUSIC_DIR, project.music.fileName) : null,
    musicVolume: project.music?.volume,
    musicOffsetMs: project.music?.offsetMs ?? 0,
    outPath: flatPath,
  });
  return flatPath;
}

// ── нативный движок: skia-canvas + ffmpeg (NVENC/CPU), без Chrome ──

async function renderNative(projectId: string, job: RenderJob) {
  const project = loadProject(projectId);
  if (!project) throw new Error("Project not found");

  job.status = "bundling"; // склейка монтажа (если нужна)
  const inputPath = await prepareInput(project);

  job.status = "rendering";
  const outputLocation = resolveOutputPath(project);
  let lastSaved = -1;

  await renderProjectNative(project, {
    inputPath,
    outputPath: outputLocation,
    encoder: getSettings().encoder ?? "auto",
    onProgress: (progress) => {
      job.progress = progress;
      const pct = Math.round(progress * 100);
      if (pct !== lastSaved && pct % 4 === 0) {
        lastSaved = pct;
        updateProject(projectId, { renderProgress: progress });
      }
    },
  });

  await applySizeLimit(project, outputLocation);

  updateProject(projectId, {
    status: "done",
    renderFile: outputLocation,
    renderProgress: 1,
  });
}

/** Лимит размера: у батч-проекта — свой (из пресета), иначе глобальный. */
async function applySizeLimit(project: Project, outputLocation: string) {
  if (project.batchRef) {
    await compressToSize(outputLocation, project.batchRef.maxSizeMb);
  } else {
    await enforceSizeLimit(outputLocation);
  }
}

// ── итерация: хук из выбранных клипов + обычный рендер в папку видоса ──
// всегда нативный движок: хук в любом случае требует склейки монтажа

async function renderIteration(projectId: string, iterationId: string, job: RenderJob) {
  const project = loadProject(projectId);
  if (!project) throw new Error("Project not found");
  const iteration = project.iterations?.find((i) => i.id === iterationId);
  if (!iteration) throw new Error("Iteration not found");

  if (iteration.kind === "translate") {
    return renderTranslateIteration(project, iteration, job);
  }

  updateIteration(projectId, iterationId, { status: "rendering", progress: 0 });
  const variant = buildIterationProject(project, iteration);

  job.status = "bundling"; // склейка хук+монтаж
  const inputPath = await prepareInput(variant);

  job.status = "rendering";
  const outputLocation = iterationOutputPath(project, iteration);
  let lastSaved = -1;
  try {
    await renderProjectNative(variant, {
      inputPath,
      outputPath: outputLocation,
      encoder: getSettings().encoder ?? "auto",
      onProgress: (progress) => {
        job.progress = progress;
        const pct = Math.round(progress * 100);
        if (pct !== lastSaved && pct % 4 === 0) {
          lastSaved = pct;
          updateIteration(projectId, iterationId, { progress });
        }
      },
    });

    // лимит размера: батчевый (папка видоса) или глобальный из настроек
    const maxMb = project.batchRef?.maxSizeMb ?? getSettings().maxSizeMb ?? 0;
    await compressToSize(outputLocation, maxMb);
  } finally {
    // промежуточная склейка варианта больше не нужна
    rmFileSync(path.join(RENDERS_DIR, `${variant.id}_flat.mp4`));
  }

  updateIteration(projectId, iterationId, {
    status: "done",
    progress: 1,
    file: outputLocation,
  });
}

/** Итерации падают в ту же папку видоса, что и основной рендер. */
function iterationOutputPath(project: Project, iteration: Iteration): string {
  return path.join(
    resolveVideoDir(project),
    `${safeProjectName(project)}_it${iteration.num}.mp4`
  );
}

// ── итерация-перевод: WaveSpeed (HeyGen) + новые субтитры на языке перевода ──
// Пайплайн: чистая склейка без музыки → перевод → Deepgram на языке перевода →
// музыка обратно (без перекодирования видео) → обычный рендер субтитров.

async function renderTranslateIteration(
  project: Project,
  iteration: Iteration,
  job: RenderJob
) {
  const projectId = project.id;
  const lang = translateLanguage(iteration.language ?? "");
  if (!lang) throw new Error(`Unknown translate language: ${iteration.language}`);
  // ключ проверяем до склейки, чтобы не жечь минуту ради очевидной ошибки
  if (!getWavespeedKey()) {
    throw new Error("WaveSpeed key is not set — add it in Settings (⚙ button)");
  }

  updateIteration(projectId, iteration.id, { status: "rendering", progress: 0 });
  let lastSaved = -1;
  const setP = (p: number) => {
    job.progress = p;
    const pct = Math.round(p * 100);
    if (pct !== lastSaved && pct % 2 === 0) {
      lastSaved = pct;
      updateIteration(projectId, iteration.id, { progress: p });
    }
  };

  const cleanPath = path.join(RENDERS_DIR, `${projectId}_${iteration.id}_clean.mp4`);
  const mixedPath = path.join(RENDERS_DIR, `${projectId}_${iteration.id}_mix.mp4`);
  const wavPath = path.join(AUDIO_DIR, `${projectId}_${iteration.id}.wav`);
  // переведённое видео живёт в uploads: повторный рендер итерации не платит
  // за перевод ещё раз (перевод — единственный платный шаг)
  const translatedName = `${projectId}_${iteration.id}_${lang.code}.mp4`;
  const translatedPath = path.join(UPLOADS_DIR, translatedName);

  try {
    // ── 1. чистый исходник: склейка монтажа БЕЗ музыки и субтитров ──
    job.status = "bundling";
    let sourceForTranslate = videoSourcePath(project);
    const noMusicProject = { ...project, music: null };
    if (needsFlatten(noMusicProject)) {
      let fps = project.video.fps;
      if (!Number.isFinite(fps) || fps < 5 || fps > 120) fps = 30;
      await flattenTimeline({
        clips: getClips(project).map((c) => ({
          path: path.join(UPLOADS_DIR, c.fileName),
          kind: c.kind,
          inMs: c.inMs,
          outMs: c.outMs,
          hasAudio: c.hasAudio,
          width: c.width,
          height: c.height,
          sourceDurationMs: c.sourceDurationMs,
          zoom: c.zoom,
          panX: c.panX,
          panY: c.panY,
          speed: c.speed,
        })),
        width: project.video.width,
        height: project.video.height,
        fps,
        musicPath: null,
        outPath: cleanPath,
      });
      sourceForTranslate = cleanPath;
    }
    setP(0.04);

    // лимит загрузки WaveSpeed: ужимаем с запасом (оригинал не трогаем)
    const limitBytes = (WAVESPEED_UPLOAD_LIMIT_MB - 5) * 1024 * 1024;
    if (fs.statSync(sourceForTranslate).size > limitBytes) {
      if (sourceForTranslate !== cleanPath) {
        fs.copyFileSync(sourceForTranslate, cleanPath);
        sourceForTranslate = cleanPath;
      }
      await compressToSize(cleanPath, WAVESPEED_UPLOAD_LIMIT_MB - 10);
    }
    setP(0.05);

    // ── 2. перевод (кэш: не переводим повторно при пере-рендере) ──
    job.status = "rendering";
    const cached =
      fs.existsSync(translatedPath) && fs.statSync(translatedPath).size > 0;
    if (!cached) {
      await translateVideoFile({
        inputPath: sourceForTranslate,
        outPath: translatedPath,
        language: lang.code,
        durationMs: project.video.durationMs,
        onProgress: (p) => setP(0.05 + p * 0.6),
      });
    }
    setP(0.65);

    // ── 3. новые субтитры: Deepgram на языке перевода ──
    await extractAudio(translatedPath, wavPath);
    const words = await transcribeAudio(wavPath, lang.code);
    setP(0.72);

    // ── 4. музыка обратно (видео копируется без перекодирования) ──
    let renderInput = translatedPath;
    const baseMusicOffset = project.music?.offsetMs ?? 0;
    const iterMusicOffset = iteration.musicOffsetMs ?? baseMusicOffset;
    if (project.music) {
      await mixMusic({
        videoPath: translatedPath,
        musicPath: path.join(MUSIC_DIR, project.music.fileName),
        volume: project.music.volume,
        offsetMs: iterMusicOffset,
        outPath: mixedPath,
      });
      renderInput = mixedPath;
    }
    // слова из музыки остаются: трек тот же, только сдвиг итерации
    const musicWords = (project.words ?? [])
      .filter((w) => w.fromMusic)
      .map((w) => ({
        ...w,
        startMs: w.startMs - baseMusicOffset + iterMusicOffset,
        endMs: w.endMs - baseMusicOffset + iterMusicOffset,
      }));
    setP(0.75);

    // ── 5. рендер субтитров по переведённому видео стилем проекта ──
    // HeyGen может слегка изменить длительность/размер — берём реальные
    const probe = await probeVideo(renderInput);
    const variant: Project = {
      ...project,
      id: `${projectId}-${iteration.id}`,
      name: `${project.name}_${lang.code}`,
      clips: null,
      music: null,
      words: [...words, ...musicWords].sort((a, b) => a.startMs - b.startMs),
      video: {
        ...project.video,
        fileName: translatedName,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        durationMs: probe.durationMs,
      },
    };
    if (!variant.words || variant.words.length === 0) {
      throw new Error("Deepgram found no speech in the translated video");
    }

    const outputLocation = path.join(
      resolveVideoDir(project),
      `${safeProjectName(project)}_${lang.code}.mp4`
    );
    await renderProjectNative(variant, {
      inputPath: renderInput,
      outputPath: outputLocation,
      encoder: getSettings().encoder ?? "auto",
      onProgress: (p) => setP(0.75 + p * 0.25),
    });

    const maxMb = project.batchRef?.maxSizeMb ?? getSettings().maxSizeMb ?? 0;
    await compressToSize(outputLocation, maxMb);

    updateIteration(projectId, iteration.id, {
      status: "done",
      progress: 1,
      file: outputLocation,
    });
  } finally {
    rmFileSync(cleanPath);
    rmFileSync(mixedPath);
    rmFileSync(wavPath);
  }
}

// ── запасной движок: Remotion + headless Chrome (как было раньше) ──

async function getBundle(): Promise<string> {
  // в упакованном приложении бандл собран заранее (scripts/prebundle.mjs)
  const prebundled = path.join(APP_ROOT, "remotion-bundle");
  if (fs.existsSync(path.join(prebundled, "index.html"))) {
    return prebundled;
  }
  if (!state.bundlePromise) {
    state.bundlePromise = (async () => {
      const { bundle } = await import("@remotion/bundler");
      return bundle({
        entryPoint: path.join(APP_ROOT, "remotion", "index.ts"),
        // локальные шрифты (Gilroy) лежат в public/ и нужны внутри бандла
        publicDir: path.join(APP_ROOT, "public"),
        onProgress: () => {},
      });
    })();
    state.bundlePromise.catch(() => {
      state.bundlePromise = null;
    });
  }
  return state.bundlePromise;
}

async function renderProjectChrome(projectId: string, job: RenderJob, origin: string) {
  const project = loadProject(projectId);
  if (!project) throw new Error("Project not found");
  if (!project.words || project.words.length === 0) {
    throw new Error("No captions yet — transcribe first");
  }

  job.status = "bundling";
  const inputPath = await prepareInput(project);
  const serveUrl = await getBundle();

  const { renderMedia, selectComposition } = await import("@remotion/renderer");

  // склейка лежит в workspace/renders, исходник — в uploads; отдаём через /api/file
  const videoSrc = inputPath.startsWith(RENDERS_DIR)
    ? `${origin}/api/file/renders/${encodeURIComponent(path.basename(inputPath))}`
    : `${origin}/api/file/uploads/${encodeURIComponent(project.video.fileName)}`;

  const inputProps: CaptionInputProps = {
    videoSrc,
    words: project.words,
    styleId: project.styleId,
    overrides: project.overrides,
    width: project.video.width,
    height: project.video.height,
    durationMs: project.video.durationMs,
    disclaimer: project.disclaimer,
    overlays: project.overlays,
  };

  const composition = await selectComposition({
    serveUrl,
    id: "CaptionedVideo",
    inputProps,
  });

  job.status = "rendering";
  const outputLocation = resolveOutputPath(project);
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    audioCodec: "aac",
    outputLocation,
    inputProps,
    // по умолчанию Remotion берёт половину ядер — задействуем почти все
    concurrency: Math.max(1, os.cpus().length - 1),
    onProgress: ({ progress }) => {
      job.progress = progress;
      if (Math.round(progress * 100) % 5 === 0) {
        updateProject(projectId, { renderProgress: progress });
      }
    },
  });

  await applySizeLimit(project, outputLocation);

  updateProject(projectId, {
    status: "done",
    renderFile: outputLocation,
    renderProgress: 1,
  });
}

function safeProjectName(project: Project): string {
  return sanitizeFileName(project.name) || project.id;
}

/**
 * Папка видоса — ровно та, что выбрана юзером: подпапок на каждое видео
 * НЕ делаем, всё (рендеры и итерации) падает в одну папку вывода.
 * У батч-проектов папка уже задана в batchRef. Без папки вывода —
 * workspace/renders.
 */
function resolveVideoDir(project: Project): string {
  const root = project.outputRoot?.trim();
  const custom =
    // корень из «Рендер всех» — приоритетнее всего
    root || project.batchRef?.outputDir || getSettings().outputDir?.trim() || "";
  if (custom) {
    try {
      fs.mkdirSync(custom, { recursive: true });
      return custom;
    } catch {
      // папка недоступна — падаем во внутреннюю
    }
  }
  return RENDERS_DIR;
}

function resolveOutputPath(project: Project): string {
  const dir = resolveVideoDir(project);
  const base = safeProjectName(project);
  // повторный рендер того же проекта перезаписывает СВОЙ файл;
  // занятое чужим файлом имя не трогаем — берём следующее свободное
  const mine = project.renderFile ? path.resolve(project.renderFile) : "";
  const free = (p: string) => !fs.existsSync(p) || path.resolve(p) === mine;
  const first = path.join(dir, `${base}.mp4`);
  if (free(first)) return first;
  for (let i = 2; i < 100; i++) {
    const alt = path.join(dir, `${base}_${i}.mp4`);
    if (free(alt)) return alt;
  }
  return path.join(dir, `${base}_${project.id}.mp4`);
}

export function videoSourcePath(project: Project): string {
  return path.join(UPLOADS_DIR, project.video.fileName);
}
