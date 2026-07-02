// Ручной прогон нативного движка: npx tsx scripts/test-native.mts <projectId> [styleId]
// Дампит несколько кадров в PNG и делает полный рендер с замером времени.
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { loadProject } from "../lib/store";
import { videoSourcePath } from "../lib/jobs";
import { renderProjectNative } from "../lib/render-native/render";
import { ensureFontsRegistered } from "../lib/render-native/fonts";
import { createScene } from "../lib/render-native/scene";
import { detectEncoder } from "../lib/render-native/encoder";

const projectId = process.argv[2];
const styleOverride = process.argv[3];
if (!projectId) {
  console.error("usage: tsx scripts/test-native.mts <projectId> [styleId]");
  process.exit(1);
}
const project = loadProject(projectId);
if (!project || !project.words) {
  console.error("project not found or has no words");
  process.exit(1);
}
if (styleOverride) project.styleId = styleOverride;

const outDir = path.join(process.cwd(), "workspace", "test-native");
fs.mkdirSync(outDir, { recursive: true });

ensureFontsRegistered();
const { width, height } = project.video;
const fps = project.video.fps || 30;
const scene = createScene({
  words: project.words,
  styleId: project.styleId,
  overrides: project.overrides ?? {},
  width,
  height,
  fps,
});

// дамп кадров: старт первой страницы + середина + во время анимации слова
const firstWordFrame = Math.round((project.words[0].startMs / 1000) * fps);
const dumpFrames = [
  firstWordFrame + 2,
  firstWordFrame + 30,
  Math.round(((project.video.durationMs / 2) / 1000) * fps),
];
const canvas = createCanvas(width, height);
const ctx = canvas.getContext("2d");
for (const f of dumpFrames) {
  ctx.clearRect(0, 0, width, height);
  // тёмно-серый фон, чтобы PNG было видно
  ctx.fillStyle = "#333";
  ctx.fillRect(0, 0, width, height);
  scene.drawFrame(ctx, f);
  fs.writeFileSync(
    path.join(outDir, `${project.styleId}_f${f}.png`),
    canvas.toBuffer("image/png")
  );
  console.log(`dumped frame ${f} key=${scene.frameKey(f)}`);
}

// полный рендер с таймингом
const encoder = await detectEncoder();
console.log("encoder:", encoder);
const outPath = path.join(outDir, `${project.styleId}_${projectId}.mp4`);
const t0 = Date.now();
let lastPct = -1;
await renderProjectNative(project, {
  inputPath: videoSourcePath(project),
  outputPath: outPath,
  encoder: "auto",
  onProgress: (p) => {
    const pct = Math.round(p * 100);
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      process.stdout.write(` ${pct}%`);
    }
  },
});
const sec = (Date.now() - t0) / 1000;
console.log(
  `\nrendered ${(project.video.durationMs / 1000).toFixed(0)}s video in ${sec.toFixed(1)}s ` +
    `(${(project.video.durationMs / 1000 / sec).toFixed(1)}x realtime) → ${outPath}`
);
