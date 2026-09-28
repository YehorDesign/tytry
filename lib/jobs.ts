import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CaptionInputProps, Iteration, Project, TextOverlay } from "./types";
import { listCustomFonts } from "./fonts-custom";
import {
  AUDIO_DIR,
  MUSIC_DIR,
  RENDERS_DIR,
  THUMBS_DIR,
  UPLOADS_DIR,
  loadProject,
  saveProject,
  updateIteration,
  updateProject,
} from "./store";
import { getSettings, getWavespeedKey } from "./settings";
import { renderProjectNative } from "./render-native/render";
import { extractAudio, extractThumbnail, flattenTimeline, mixMusic, probeMedia, probeVideo } from "./ffmpeg";
import { transcribeAudio } from "./deepgram";
import type { TranslateLanguage } from "./languages";
import { getClips, needsFlatten } from "./montage";
import { buildIterationProject } from "./iterations";
import { compressToSize, enforceSizeLimit } from "./compress";
import { TRANSLATE_COMPRESS_TARGET_MB, TRANSLATE_INPUT_LIMIT_MB } from "./wavespeed";
import { translateLongVideo, TRANSLATE_MAX_CHUNK_MS } from "./translate";
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

// ── итерация-перевод: WaveSpeed (HeyGen), видео БЕЗ вжжённых субтитров ──
// Пайплайн: чистая склейка без музыки → перевод (длинное видео — частями,
// см. lib/translate.ts) → музыка обратно (без перекодирования видео) → файл
// в папку видоса → отдельный проект с распознанной речью на языке перевода.
// Субтитры не вжигаются: их почти всегда хочется поправить, поэтому они
// приезжают редактируемыми в новый проект (createTranslatedProject).

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

    // лимит HeyGen на входное видео: ужимаем с запасом (оригинал не трогаем).
    // длинное видео пойдёт частями — там каждая часть ужимается сама
    const limitBytes = TRANSLATE_INPUT_LIMIT_MB * 1024 * 1024;
    // длительность берём у РЕАЛЬНОГО файла: у монтажного проекта
    // project.video.durationMs — это исходник, а не длина таймлайна
    const sourceMs = (await probeVideo(sourceForTranslate)).durationMs;
    const goesInOneRequest = sourceMs <= TRANSLATE_MAX_CHUNK_MS;
    if (goesInOneRequest && fs.statSync(sourceForTranslate).size > limitBytes) {
      if (sourceForTranslate !== cleanPath) {
        fs.copyFileSync(sourceForTranslate, cleanPath);
        sourceForTranslate = cleanPath;
      }
      await compressToSize(cleanPath, TRANSLATE_COMPRESS_TARGET_MB);
    }
    setP(0.05);

    // ── 2. перевод (кэш: не переводим повторно при пере-рендере) ──
    job.status = "rendering";
    const cached =
      fs.existsSync(translatedPath) && fs.statSync(translatedPath).size > 0;
    if (!cached) {
      await translateLongVideo({
        inputPath: sourceForTranslate,
        outPath: translatedPath,
        language: lang.code,
        // паузы между словами исходника = места, где можно резать на части
        words: (project.words ?? []).filter((w) => !w.fromMusic),
        partsDir: UPLOADS_DIR,
        partsPrefix: `${projectId}_${iteration.id}_${lang.code}`,
        tmpDir: RENDERS_DIR,
        parallel: getSettings().translateParallel,
        onProgress: (p) => setP(0.05 + p * 0.6),
        onParts: (done, total) =>
          updateIteration(projectId, iteration.id, {
            parts: total > 1 ? { done, total } : undefined,
          }),
      });
    }
    updateIteration(projectId, iteration.id, { parts: undefined });
    setP(0.65);

    // ── 3. музыка обратно (видео копируется без перекодирования) ──
    let resultPath = translatedPath;
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
      resultPath = mixedPath;
    }
    setP(0.9);

    // ── 4. кладём переведённое видео в папку видоса БЕЗ СУБТИТРОВ ──
    // это готовый файл на случай, если сабы не нужны вовсе; редактируемые
    // сабы приезжают следующим шагом, отдельным проектом
    const outputLocation = path.join(
      resolveVideoDir(project),
      `${safeProjectName(project)}_${lang.code}.mp4`
    );
    fs.copyFileSync(resultPath, outputLocation);
    setP(0.98);

    const maxMb = project.batchRef?.maxSizeMb ?? getSettings().maxSizeMb ?? 0;
    await compressToSize(outputLocation, maxMb);

    // ── 5. отдельный проект с РЕДАКТИРУЕМЫМИ субтитрами перевода ──
    // берём resultPath, а не outputLocation: последний мог быть ужат под
    // лимит размера, а базой для пере-рендера лучше файл получше
    const translatedProjectId = await createTranslatedProject(
      project,
      iteration,
      lang,
      resultPath
    );

    updateIteration(projectId, iteration.id, {
      status: "done",
      progress: 1,
      file: outputLocation,
      translatedProjectId,
    });
  } finally {
    rmFileSync(cleanPath);
    rmFileSync(mixedPath);
  }
}

/**
 * Переведённое видео → отдельный проект в ленте: речь распознаётся на языке
 * перевода, оформление наследуется от исходника. Субтитры к переводу почти
 * всегда хочется поправить, поэтому вжигать их сразу нельзя — но и гонять
 * файл обратно в ТИТРИ руками незачем.
 *
 * Ошибки не пробрасываем: перевод уже оплачен, и упавшее распознавание не
 * должно ронять итерацию. Проект тогда остаётся с видео, но без слов —
 * распознавание повторяется обычной кнопкой.
 */
/**
 * Тайминги текст-плашек под длительность перевода.
 *
 * Переведённое видео почти всегда ДЛИННЕЕ исходника (замеры: испанский даёт
 * +8%, HeyGen растягивает речь), поэтому унаследованные как есть плашки
 * уехали бы на несколько секунд. Тянем их пропорционально — попадание
 * приблизительное, но плашку легко поправить мышкой, а вот потерять её
 * молча хуже.
 */
function stretchOverlays(source: Project, durationMs: number): TextOverlay[] | null {
  const overlays = source.overlays;
  if (!overlays || overlays.length === 0) return null;
  const from = source.video.durationMs;
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
    return overlays.map((o) => ({ ...o }));
  }
  const k = durationMs / from;
  return overlays.map((o) => ({
    ...o,
    startMs: Math.round(Math.min(o.startMs * k, durationMs)),
    endMs: Math.round(Math.min(o.endMs * k, durationMs)),
  }));
}

async function createTranslatedProject(
  source: Project,
  iteration: Iteration,
  lang: TranslateLanguage,
  videoPath: string
): Promise<string | undefined> {
  // повторный рендер итерации не должен плодить копии проекта
  if (iteration.translatedProjectId && loadProject(iteration.translatedProjectId)) {
    return iteration.translatedProjectId;
  }

  const id = crypto.randomBytes(6).toString("hex");
  const fileName = `${id}.mp4`;
  const filePath = path.join(UPLOADS_DIR, fileName);
  try {
    fs.copyFileSync(videoPath, filePath);
    const meta = await probeMedia(filePath);
    await extractThumbnail(filePath, path.join(THUMBS_DIR, `${id}.jpg`)).catch(() => {});

    const project: Project = {
      id,
      name: `${source.name} [${lang.code.toUpperCase()}]`,
      createdAt: new Date().toISOString(),
      status: "uploaded",
      language: lang.code,
      video: {
        fileName,
        originalName: `${safeProjectName(source)}_${lang.code}.mp4`,
        width: meta.width,
        height: meta.height,
        durationMs: meta.durationMs,
        fps: meta.fps,
      },
      words: null,
      // монтаж уже склеен, а музыка вмикширована в сам файл: останься они
      // здесь — рендер положил бы музыку вторым слоем поверх неё же
      clips: null,
      music: null,
      styleId: source.styleId,
      overrides: { ...source.overrides },
      // дисклеймер висит на всём видео, тайминга у него нет — берём как есть
      disclaimer: source.disclaimer ?? null,
      overlays: stretchOverlays(source, meta.durationMs),
      folder: source.folder ?? null,
      outputRoot: source.outputRoot,
      batchRef: source.batchRef ?? null,
    };
    saveProject(project);

    // code из lib/languages.ts — это и есть код языка Deepgram
    updateProject(id, { status: "transcribing" });
    const audioPath = path.join(AUDIO_DIR, `${id}.wav`);
    await extractAudio(filePath, audioPath);
    const words = await transcribeAudio(audioPath, lang.code);
    updateProject(id, {
      status: words.length > 0 ? "ready" : "error",
      words,
      error: words.length > 0 ? undefined : "Deepgram found no speech in this video",
    });
    return id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[translate] editable ${lang.code} project failed: ${message}`);
    if (loadProject(id)) {
      updateProject(id, { status: "error", error: message });
      return id;
    }
    rmFileSync(filePath);
    return undefined;
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
    // свои шрифты юзера: Chrome тянет их с локального сервера по ссылке
    customFonts: listCustomFonts().map((f) => ({
      family: f.family,
      url: `${origin}/api/fonts/file/${f.id}`,
    })),
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
