// Смоук-тест скорости клипов: npx tsx scripts/test-speed.mts
// 1) flattenTimeline с speed 2 и 0.5 → длительность выхода
// 2) remapWordsToClips: слова масштабируются вместе с клипом
import fs from "node:fs";
import path from "node:path";
import { flattenTimeline, probeMedia } from "../lib/ffmpeg";
import { remapWordsToClips } from "../lib/montage";
import { clipDurationMs } from "../lib/types";
import type { TimelineClip, Word } from "../lib/types";

const SRC = "C:\\Users\\Пользователь\\Downloads\\New folder (4)\\v1_CR-29880_videos\\1.mp4";
const SRC_MS = 4042;

const clip = (id: string, speed?: number): TimelineClip => ({
  id,
  kind: "video",
  fileName: "x",
  originalName: "x",
  sourceDurationMs: SRC_MS,
  inMs: 0,
  outMs: SRC_MS,
  width: 720,
  height: 1280,
  hasAudio: false,
  speed,
});

const fails: string[] = [];

// ── remap: клип #1 ускорили ×2 — его слова ужались, слова клипа #2 подъехали ──
const oldClips = [clip("a"), clip("b")];
const newClips = [clip("a", 2), clip("b")];
const words: Word[] = [
  { id: "w1", text: "у", startMs: 1000, endMs: 2000 }, // внутри клипа a
  { id: "w2", text: "б", startMs: 5000, endMs: 5500 }, // внутри клипа b (start 4042)
];
const remapped = remapWordsToClips(words, oldClips, newClips);
console.log("remapped:", JSON.stringify(remapped));
const w1 = remapped.find((w) => w.id === "w1")!;
const w2 = remapped.find((w) => w.id === "w2")!;
if (Math.abs(w1.startMs - 500) > 2 || Math.abs(w1.endMs - 1000) > 2)
  fails.push(`w1 не ужался вдвое: ${w1.startMs}-${w1.endMs} (ждали 500-1000)`);
// клип a теперь 2021мс → слова клипа b сдвинулись на -2021
if (Math.abs(w2.startMs - (5000 - 2021)) > 3)
  fails.push(`w2 не сдвинулся: ${w2.startMs} (ждали ~2979)`);
if (clipDurationMs(newClips[0]) !== 2021)
  fails.push(`clipDurationMs со speed=2: ${clipDurationMs(newClips[0])} (ждали 2021)`);

// ── ffmpeg: ×2 + ×0.5 → 2.021 + 8.084 ≈ 10.105 c ──
const out = path.join(process.cwd(), "workspace", "test-speed.mp4");
await flattenTimeline({
  clips: [
    { path: SRC, kind: "video", inMs: 0, outMs: SRC_MS, hasAudio: false, width: 720, height: 1280, sourceDurationMs: SRC_MS, speed: 2 },
    { path: SRC, kind: "video", inMs: 0, outMs: SRC_MS, hasAudio: false, width: 720, height: 1280, sourceDurationMs: SRC_MS, speed: 0.5 },
  ],
  width: 720,
  height: 1280,
  fps: 30,
  musicPath: null,
  outPath: out,
});
const meta = await probeMedia(out);
console.log(`flatten duration: ${meta.durationMs}ms (ждали ~10105)`);
if (Math.abs(meta.durationMs - 10105) > 250)
  fails.push(`длительность склейки: ${meta.durationMs}, ждали ~10105`);
fs.unlinkSync(out);

if (fails.length) {
  console.error("FAIL:\n - " + fails.join("\n - "));
  process.exit(1);
}
console.log("SPEED OK");
