// Смоук-тест дисклеймера (native) и «продления кадра» (ffmpeg):
// npx tsx scripts/test-disclaimer.mts
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { ensureFontsRegistered } from "../lib/render-native/fonts";
import { createScene } from "../lib/render-native/scene";
import { flattenTimeline, probeMedia, probeVideo } from "../lib/ffmpeg";
import type { Word } from "../lib/types";

ensureFontsRegistered();
const outDir = path.join(process.cwd(), "workspace", "test-disc");
fs.mkdirSync(outDir, { recursive: true });

// ── 1. дисклеймер в нативной сцене ──
const words: Word[] = [
  { id: "w1", text: "Основні", startMs: 500, endMs: 900 },
  { id: "w2", text: "субтитри", startMs: 900, endMs: 1400 },
];
const width = 1080;
const height = 1920;
const scene = createScene({
  words,
  styleId: "hormozi",
  overrides: {},
  width,
  height,
  fps: 30,
  disclaimer: {
    text: "AI generated content. Not medical advice. Individual results may vary.",
    sizeRatio: 0.018,
    positionY: 0.96,
  },
});
const band = scene.verticalBand();
console.log("band:", band, "(должен доставать до низа ~1920)");

const canvas = createCanvas(width, height);
const ctx = canvas.getContext("2d");
for (const [name, ms] of [["with-captions", 1000], ["empty", 3000]] as const) {
  const frame = Math.round((ms / 1000) * 30);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#333";
  ctx.fillRect(0, 0, width, height);
  const drew = scene.drawFrame(ctx, frame);
  console.log(`${name}: frame=${frame} drew=${drew} key=${scene.frameKey(frame)}`);
  fs.writeFileSync(path.join(outDir, `${name}.png`), canvas.toBuffer("image/png"));
}

// ── 2. «продление кадра»: 2с видео + 1.5с заморозки ──
const uploads = path.join(process.cwd(), "workspace", "uploads");
const f = fs.readdirSync(uploads).filter((x) => /\.mp4$/i.test(x))[0];
const src = path.join(uploads, f);
const meta = await probeMedia(src);
const outPath = path.join(outDir, "freeze.mp4");
await flattenTimeline({
  clips: [
    {
      path: src, kind: "video", inMs: 0, outMs: 3500, hasAudio: meta.hasAudio,
      width: meta.width, height: meta.height,
      sourceDurationMs: 2000, // притворяемся, что исходник 2с → 1.5с freeze
    },
  ],
  width: 1080, height: 1920, fps: 30, outPath,
});
const out = await probeVideo(outPath);
console.log(`freeze mp4: ${out.durationMs}ms (expected ~3500ms)`);
if (Math.abs(out.durationMs - 3500) > 200) {
  console.error("FAIL: freeze duration mismatch");
  process.exit(1);
}
console.log("OK");
