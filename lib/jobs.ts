import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CaptionInputProps, Project } from "./types";
import { MUSIC_DIR, RENDERS_DIR, UPLOADS_DIR, loadProject, updateProject } from "./store";
import { getSettings } from "./settings";
import { renderProjectNative } from "./render-native/render";
import { flattenTimeline } from "./ffmpeg";
import { getClips, needsFlatten } from "./montage";
import { enforceSizeLimit } from "./compress";

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

function pump(origin: string) {
  while (state.queue.length > 0 && state.active < maxParallel()) {
    const projectId = state.queue.shift()!;
    const job = state.jobs.get(projectId);
    if (!job) continue;
    state.active++;
    void runJob(projectId, job, origin).finally(() => {
      state.active--;
      pump(origin);
    });
  }
}

async function runJob(projectId: string, job: RenderJob, origin: string) {
  try {
    if (getSettings().renderEngine === "chrome") {
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
    updateProject(projectId, { status: "error", error: message });
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
    })),
    width: project.video.width,
    height: project.video.height,
    fps,
    musicPath: project.music ? path.join(MUSIC_DIR, project.music.fileName) : null,
    musicVolume: project.music?.volume,
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

  await enforceSizeLimit(outputLocation);

  updateProject(projectId, {
    status: "done",
    renderFile: outputLocation,
    renderProgress: 1,
  });
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

  await enforceSizeLimit(outputLocation);

  updateProject(projectId, {
    status: "done",
    renderFile: outputLocation,
    renderProgress: 1,
  });
}

/** Папка из настроек (если задана и доступна), иначе workspace/renders. */
function resolveOutputPath(project: Project): string {
  let dir = RENDERS_DIR;
  const custom = getSettings().outputDir?.trim();
  if (custom) {
    try {
      fs.mkdirSync(custom, { recursive: true });
      dir = custom;
    } catch {
      dir = RENDERS_DIR;
    }
  }
  const safeName =
    project.name.replace(/[<>:"/\\|?* -]/g, "_").trim().slice(0, 60) ||
    project.id;
  let out = path.join(dir, `${safeName}_subtitled.mp4`);
  if (fs.existsSync(out)) {
    out = path.join(dir, `${safeName}_${project.id}.mp4`);
  }
  return out;
}

export function videoSourcePath(project: Project): string {
  return path.join(UPLOADS_DIR, project.video.fileName);
}
