// Ручной тест enforceSizeLimit: генерим видео >30 МБ и ужимаем.
// Запуск: TYTRY_WORKSPACE=<tmp> npx tsx scripts/test-compress.mts
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { enforceSizeLimit } from "../lib/compress";
import { probeMedia } from "../lib/ffmpeg";

const ws = process.env.TYTRY_WORKSPACE!;
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, "settings.json"), JSON.stringify({ maxSizeMb: 30, encoder: "auto" }));

const dur = Number(process.env.TEST_DURATION || 45);
const testFile = path.join(ws, "big_test.mp4");
console.log(`Генерируем тестовое видео ${dur}с 1080x1920…`);
execFileSync(ffmpegPath as unknown as string, [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", `testsrc2=size=1080x1920:rate=30:duration=${dur}`,
  "-f", "lavfi", "-i", `sine=frequency=440:duration=${dur}`,
  "-c:v", "libx264", "-preset", "veryfast", "-b:v", "10M",
  "-c:a", "aac", "-b:a", "192k",
  "-pix_fmt", "yuv420p",
  testFile,
]);

const before = fs.statSync(testFile).size;
console.log(`Исходник: ${(before / 1024 / 1024).toFixed(1)} МБ`);

const t0 = Date.now();
await enforceSizeLimit(testFile);
const elapsed = (Date.now() - t0) / 1000;

const after = fs.statSync(testFile).size;
const probe = await probeMedia(testFile);
console.log(`Результат: ${(after / 1024 / 1024).toFixed(2)} МБ за ${elapsed.toFixed(1)}с`);
console.log(`Разрешение: ${probe.width}x${probe.height}, ${probe.durationMs / 1000}с, аудио: ${probe.hasAudio}`);
console.log(after <= 30 * 1024 * 1024 ? "OK: влезли в 30 МБ" : "FAIL: превышение лимита");
