// Дамп кадров всех «сложных» пресетов: npx tsx scripts/dump-styles.mts <projectId>
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { loadProject } from "../lib/store";
import { ensureFontsRegistered } from "../lib/render-native/fonts";
import { createScene } from "../lib/render-native/scene";
import { groupWordsIntoPages } from "../lib/captions";
import { resolveStyle } from "../lib/styles";

const project = loadProject(process.argv[2] ?? "");
if (!project?.words) {
  console.error("project not found");
  process.exit(1);
}
const outDir = path.join(process.cwd(), "workspace", "test-native");
fs.mkdirSync(outDir, { recursive: true });
ensureFontsRegistered();

const { width, height } = project.video;
const fps = project.video.fps || 30;
const canvas = createCanvas(width, height);
const ctx = canvas.getContext("2d");

const styles = process.argv[3]
  ? [process.argv[3]]
  : ["gradient", "beast", "opus", "karaoke", "boxed", "typewriter", "neon", "retro3d", "vogue", "zine", "journal", "sketch", "poster"];

for (const styleId of styles) {
  const scene = createScene({
    words: project.words,
    styleId,
    overrides: {},
    width,
    height,
    fps,
  });
  const style = resolveStyle(styleId, {});
  const pages = groupWordsIntoPages(project.words, style.maxWordsPerPage);
  // страница с 3+ словами, кадры: анимация (+3) и статика (+25)
  const page = pages.find((p) => p.words.length >= 3) ?? pages[0];
  const base = Math.round((page.startMs / 1000) * fps);
  for (const off of [3, 25]) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#333";
    ctx.fillRect(0, 0, width, height);
    scene.drawFrame(ctx, base + off);
    fs.writeFileSync(path.join(outDir, `s_${styleId}_${off}.png`), canvas.toBuffer("image/png"));
  }
  console.log(styleId, "ok");
}
