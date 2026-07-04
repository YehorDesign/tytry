// Смоук-тест склейки монтажа: npx tsx scripts/test-flatten.mts
// Берёт два первых видео из workspace/uploads, тримит и клеит встык,
// затем извлекает аудио склейки. Проверяет длительность результата.
import fs from "node:fs";
import path from "node:path";
import {
  extractTimelineAudio,
  flattenTimeline,
  probeMedia,
  probeVideo,
  type FlattenClip,
} from "../lib/ffmpeg";

const uploads = path.join(process.cwd(), "workspace", "uploads");
const files = fs
  .readdirSync(uploads)
  .filter((f) => /\.(mp4|mov|webm|mkv)$/i.test(f))
  .slice(0, 2)
  .map((f) => path.join(uploads, f));
if (files.length < 2) {
  console.error("need 2 videos in workspace/uploads");
  process.exit(1);
}

const outDir = path.join(process.cwd(), "workspace", "test-segment");
fs.mkdirSync(outDir, { recursive: true });

const metas = await Promise.all(files.map((f) => probeMedia(f)));
console.log(
  "sources:",
  metas.map((m, i) => `${path.basename(files[i])} ${m.durationMs}ms audio=${m.hasAudio}`)
);

// тримим: у первого отрезаем по 500мс с краёв, второй берём первые 2с
const clips: FlattenClip[] = [
  {
    path: files[0],
    kind: "video",
    inMs: 500,
    outMs: Math.min(metas[0].durationMs - 500, 3500),
    hasAudio: metas[0].hasAudio,
  },
  {
    path: files[1],
    kind: "video",
    inMs: 0,
    outMs: Math.min(2000, metas[1].durationMs),
    hasAudio: metas[1].hasAudio,
  },
];
const expectedMs = clips.reduce((s, c) => s + (c.outMs - c.inMs), 0);

const outPath = path.join(outDir, "flat.mp4");
const t0 = Date.now();
await flattenTimeline({
  clips,
  width: 1080,
  height: 1920,
  fps: 30,
  outPath,
});
const flatMeta = await probeVideo(outPath);
console.log(
  `flatten: ${Date.now() - t0}ms → ${flatMeta.durationMs}ms (expected ~${expectedMs}ms), ${flatMeta.width}x${flatMeta.height}`
);
if (Math.abs(flatMeta.durationMs - expectedMs) > 200) {
  console.error("FAIL: duration mismatch");
  process.exit(1);
}

const wavPath = path.join(outDir, "flat.wav");
await extractTimelineAudio(clips, wavPath);
const wavSize = fs.statSync(wavPath).size;
const wavMs = Math.round(((wavSize - 44) / (16000 * 2)) * 1000);
console.log(`timeline audio: ${wavMs}ms wav (expected ~${expectedMs}ms)`);
if (Math.abs(wavMs - expectedMs) > 300) {
  console.error("FAIL: audio duration mismatch");
  process.exit(1);
}
console.log("OK");
