/**
 * E2E итерации-перевода в временном воркспейсе, БЕЗ WaveSpeed и без денег
 * (перевод подменён копией файла через TYTRY_FAKE_TRANSLATE=1).
 *
 * Проверяет главное поведение: итерация отдаёт переведённое видео
 * БЕЗ вжатых субтитров, но С музыкой проекта.
 *
 * Запуск: npx tsx scripts/test-translate-iteration.mts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

/** ffmpeg пишет статистику в stderr — забираем именно его. */
function ffmpegStderr(args: string[], bin: string): string {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  return `${r.stderr ?? ""}${r.stdout ?? ""}`;
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tytry-tri-"));
process.env.TYTRY_WORKSPACE = ws;
process.env.TYTRY_FAKE_TRANSLATE = "1";
process.env.WAVESPEED_API_KEY = "test-key-not-used";

const store = await import("../lib/store");
const jobs = await import("../lib/jobs");
const ffmpegPath = (await import("ffmpeg-static")).default as unknown as string;
const ffprobe = (await import("@ffprobe-installer/ffprobe")).default.path;

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}`, extra ?? "");
  }
}

store.ensureWorkspace();
const outDir = path.join(ws, "готове");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(ws, "settings.json"),
  JSON.stringify({ outputDir: outDir, encoder: "auto", renderEngine: "native", maxSizeMb: 0 }),
  "utf8"
);

// исходник: 6 с ровного цвета + тишина (на ровном фоне видно любой саб)
const srcName = "src.mp4";
execFileSync(ffmpegPath, [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "color=c=0x1E5AA8:s=540x960:r=30:d=6",
  "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
  "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
  path.join(ws, "uploads", srcName),
], { stdio: "ignore" });

// музыка проекта: тон 220 Гц
const musicName = "track.mp3";
fs.mkdirSync(path.join(ws, "music"), { recursive: true });
execFileSync(ffmpegPath, [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "sine=frequency=220:duration=6",
  path.join(ws, "music", musicName),
], { stdio: "ignore" });

const NAME = "705_V_N1_FF_NC_Test_Translate_EK_Meta_9x16";
const id = "tritest00001";
store.saveProject({
  id,
  name: NAME,
  createdAt: new Date().toISOString(),
  status: "ready",
  language: "uk",
  video: {
    fileName: srcName,
    originalName: srcName,
    width: 540,
    height: 960,
    durationMs: 6000,
    fps: 30,
  },
  words: [
    { id: "w1", text: "привіт", startMs: 300, endMs: 1200 },
    { id: "w2", text: "світ", startMs: 1400, endMs: 2200 },
    { id: "w3", text: "тут", startMs: 3600, endMs: 4300 },
  ],
  styleId: "whitepad",
  overrides: {},
  music: { trackId: "t1", fileName: musicName, name: "track", volume: 0.4, offsetMs: 0 },
  iterations: [
    {
      id: "iter1",
      num: 1,
      kind: "translate",
      language: "de",
      clipIds: [],
      status: "draft",
      progress: 0,
      createdAt: new Date().toISOString(),
    },
  ],
} as never);

console.log("\n— гоним итерацию-перевод —");
jobs.enqueueIteration(id, "iter1", "http://localhost:3000");
let job = jobs.getJob(`${id}#iter1`);
for (let i = 0; i < 900; i++) {
  job = jobs.getJob(`${id}#iter1`);
  if (job && (job.status === "done" || job.status === "error")) break;
  await new Promise((r) => setTimeout(r, 200));
}
check("итерация завершилась без ошибки", job?.status === "done", job?.error);

const it = store.loadProject(id)?.iterations?.[0];
const expected = path.join(outDir, `${NAME}_de.mp4`);
check("статус итерации done", it?.status === "done", it);
check(`файл лежит как ${path.basename(expected)}`, it?.file === expected && fs.existsSync(expected), it?.file);

if (fs.existsSync(expected)) {
  // ── субтитров в кадре быть НЕ должно: фон ровный, любой саб = разброс цвета ──
  const framesDir = path.join(ws, "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  // кадр из середины слова «світ» (1.6 с) — там саб точно был бы виден
  execFileSync(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", "1.6", "-i", expected, "-frames:v", "1",
    path.join(framesDir, "f.png"),
  ], { stdio: "ignore" });
  const stats = ffmpegStderr([
    "-hide_banner", "-i", path.join(framesDir, "f.png"),
    "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YMAX",
    "-f", "null", "-",
  ], ffmpegPath);
  const ymaxMatch = /YMAX=(\d+)/.exec(stats);
  const ymax = ymaxMatch ? Number(ymaxMatch[1]) : -1;
  // белая плашка сабов дала бы YMAX ≈ 235; ровный синий фон — около 80
  check(`в кадре нет белой плашки субтитров (YMAX=${ymax})`, ymax > 0 && ymax < 160, stats.slice(-200));

  // ── музыка должна быть подмешана: тишина стала звуком ──
  const vol = ffmpegStderr([
    "-hide_banner", "-i", expected, "-af", "volumedetect", "-f", "null", "-",
  ], ffmpegPath);
  const meanMatch = /mean_volume: (-?[\d.]+) dB/.exec(vol);
  const mean = meanMatch ? Number(meanMatch[1]) : -999;
  check(`музыка на месте (mean_volume=${mean} dB)`, mean > -60, vol.slice(-200));

  // ── длительность и размер кадра совпадают с исходником ──
  const probe = JSON.parse(
    execFileSync(ffprobe, [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-show_entries", "format=duration",
      "-of", "json", expected,
    ], { encoding: "utf8" }).toString()
  );
  check("размер кадра 540x960", probe.streams[0].width === 540 && probe.streams[0].height === 960, probe.streams[0]);
  check(
    `длительность ≈ 6 с (${Number(probe.format.duration).toFixed(2)})`,
    Math.abs(Number(probe.format.duration) - 6) < 0.6,
    probe.format
  );
}

// ── промежуточные файлы подчищены, платный кэш перевода остался ──
const renders = fs.readdirSync(path.join(ws, "renders"));
check("временные склейки удалены", renders.length === 0, renders);
const uploads = fs.readdirSync(path.join(ws, "uploads"));
check(
  "переведённое видео закэшировано в uploads (повтор бесплатный)",
  uploads.some((f) => f === `${id}_iter1_de.mp4`),
  uploads
);

await fs.promises.rm(ws, { recursive: true, force: true });
console.log(failed === 0 ? "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" : `\n${failed} ПРОВЕРОК УПАЛО`);
process.exit(failed === 0 ? 0 : 1);
