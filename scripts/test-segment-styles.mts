// Смоук-тест сегментных стилей в нативном рендере:
// npx tsx scripts/test-segment-styles.mts
// Синтетические слова: первая фраза — стиль проекта, вторая — gold,
// третья — glitch с правками. Дампит по кадру на фразу в PNG.
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { ensureFontsRegistered } from "../lib/render-native/fonts";
import { createScene } from "../lib/render-native/scene";
import type { Word } from "../lib/types";

ensureFontsRegistered();

const words: Word[] = [
  { id: "w1", text: "Звичайний", startMs: 100, endMs: 500 },
  { id: "w2", text: "стиль", startMs: 500, endMs: 900 },
  { id: "w3", text: "проєкту", startMs: 900, endMs: 1300 },
  {
    id: "w4", text: "Золота", startMs: 2500, endMs: 2900,
    style: { styleId: "gold", overrides: {} },
  },
  {
    id: "w5", text: "фраза", startMs: 2900, endMs: 3300,
    style: { styleId: "gold", overrides: {} },
  },
  {
    id: "w6", text: "Глітч", startMs: 4500, endMs: 4900,
    style: { styleId: "glitch", overrides: { fontSizeRatio: 0.07, positionY: 0.4 } },
  },
  {
    id: "w7", text: "зверху", startMs: 4900, endMs: 5300,
    style: { styleId: "glitch", overrides: { fontSizeRatio: 0.07, positionY: 0.4 } },
  },
  {
    id: "w8", text: "Стікер!", startMs: 6500, endMs: 7000,
    style: { styleId: "sticker", overrides: {} },
  },
];

const width = 1080;
const height = 1920;
const fps = 30;

const scene = createScene({
  words,
  styleId: "hormozi",
  overrides: { fontFamily: "Gilroy" },
  width,
  height,
  fps,
});

const outDir = path.join(process.cwd(), "workspace", "test-segment");
fs.mkdirSync(outDir, { recursive: true });

const band = scene.verticalBand();
console.log("verticalBand:", band);

const dumpAtMs = [700, 3000, 5000, 6800];
const canvas = createCanvas(width, height);
const ctx = canvas.getContext("2d");
const keys = new Set<string>();
for (const ms of dumpAtMs) {
  const frame = Math.round((ms / 1000) * fps);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#333";
  ctx.fillRect(0, 0, width, height);
  const drew = scene.drawFrame(ctx, frame);
  const key = scene.frameKey(frame);
  keys.add(key);
  console.log(`ms=${ms} frame=${frame} drew=${drew} key=${key}`);
  fs.writeFileSync(
    path.join(outDir, `seg_${ms}.png`),
    canvas.toBuffer("image/png")
  );
}
if (keys.size !== dumpAtMs.length) {
  console.error("FAIL: frame keys collide across different styles");
  process.exit(1);
}
console.log("OK, PNGs in", outDir);
