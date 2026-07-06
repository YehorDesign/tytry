// Ручной e2e-тест батч-конвейера в изолированном workspace.
// Запуск: TYTRY_WORKSPACE=<tmp> npx tsx scripts/test-batch.mts
// Проверяет: успешный элемент (монтаж+титры+музыка+ендкард+дубль),
// битый архив, архив без видео — ошибки не мешают остальным.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const FFMPEG = ffmpegPath as unknown as string;
const ws = process.env.TYTRY_WORKSPACE!;
if (!ws) throw new Error("TYTRY_WORKSPACE required");
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });

// ключ Deepgram берём из реального workspace приложения
const realSettings = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "workspace", "settings.json"), "utf8")
);
fs.writeFileSync(
  path.join(ws, "settings.json"),
  JSON.stringify({ deepgramApiKey: realSettings.deepgramApiKey, encoder: "auto" })
);

const tmp = path.join(ws, "_gen");
fs.mkdirSync(tmp, { recursive: true });

// ── озвучка через Windows TTS ──
const speechWav = path.join(tmp, "speech.wav");
execFileSync("powershell", [
  "-NoProfile", "-Command",
  `Add-Type -AssemblyName System.Speech; ` +
    `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
    `$s.SetOutputToWaveFile('${speechWav.replace(/'/g, "''")}'); ` +
    `$s.Speak('Hello there. This is the first test clip for batch processing. It should get captions automatically.'); ` +
    `$s.Dispose()`,
]);

function makeClip(out: string, label: string, dur: number, withSpeech: boolean) {
  const args = ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=720x1280:rate=30:duration=${dur}`];
  if (withSpeech) args.push("-i", speechWav);
  else args.push("-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${dur}`);
  args.push(
    "-filter_complex", `[0:v]drawtext=text='${label}':fontsize=72:fontcolor=white:x=(w-tw)/2:y=100[v]`,
    "-map", "[v]", "-map", "1:a",
    "-t", String(dur),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-pix_fmt", "yuv420p", out
  );
  execFileSync(FFMPEG, args);
}

console.log("Генерируем клипы и архивы…");
const zipsDir = path.join(tmp, "zips");
fs.mkdirSync(zipsDir, { recursive: true });

// архив 1: нормальный — 2 клипа, первый с речью
const z1src = path.join(tmp, "z1");
fs.mkdirSync(z1src);
makeClip(path.join(z1src, "clip_1.mp4"), "CLIP 1", 6, true);
makeClip(path.join(z1src, "clip_2.mp4"), "CLIP 2", 3, false);
execFileSync("powershell", ["-NoProfile", "-Command",
  `Compress-Archive -Path '${z1src}\\*' -DestinationPath '${path.join(zipsDir, "Промо_видео_01.zip")}'`]);

// архив 4: тишина по краям (2с до речи и ~2с после) — для проверки трима
const z4src = path.join(tmp, "z4");
fs.mkdirSync(z4src);
const paddedWav = path.join(tmp, "speech_padded.wav");
execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error",
  "-i", speechWav,
  "-af", "adelay=2000|2000,apad=pad_dur=2",
  paddedWav]);
const padded = path.join(z4src, "clip_1.mp4");
execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30:duration=60",
  "-i", paddedWav,
  "-map", "0:v", "-map", "1:a", "-shortest",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
  "-c:a", "aac", "-pix_fmt", "yuv420p", padded]);
execFileSync("powershell", ["-NoProfile", "-Command",
  `Compress-Archive -Path '${z4src}\\*' -DestinationPath '${path.join(zipsDir, "trim_04.zip")}'`]);

// архив 2: битый zip
fs.writeFileSync(path.join(zipsDir, "broken_02.zip"), Buffer.from("this is not a zip at all"));

// архив 3: без видео
const z3src = path.join(tmp, "z3");
fs.mkdirSync(z3src);
fs.writeFileSync(path.join(z3src, "readme.txt"), "no videos here");
execFileSync("powershell", ["-NoProfile", "-Command",
  `Compress-Archive -Path '${z3src}\\*' -DestinationPath '${path.join(zipsDir, "empty_03.zip")}'`]);

// ── музыка и ендкард ──
const { MUSIC_DIR, addMusicTrack } = await import("../lib/store");
const { addEndcard, ensureBatchDirs, ENDCARDS_DIR, saveBatch, loadBatch } = await import("../lib/batch/store");
const { savePreset } = await import("../lib/batch/store");
const { startBatch } = await import("../lib/batch/worker");
const { defaultPreset } = await import("../lib/batch/types");

ensureBatchDirs();
fs.mkdirSync(MUSIC_DIR, { recursive: true });
const musicFile = path.join(MUSIC_DIR, "test_music.m4a");
execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "sine=frequency=220:duration=20",
  "-c:a", "aac", musicFile]);
addMusicTrack({ id: "m1", name: "Test music", fileName: "test_music.m4a", durationMs: 20000, addedAt: new Date().toISOString() });

const endcardFile = path.join(ENDCARDS_DIR, "endcard.png");
execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "color=c=0x222266:size=720x1280:duration=0.1",
  "-vf", "drawtext=text='THE END':fontsize=96:fontcolor=white:x=(w-tw)/2:y=(h-th)/2",
  "-frames:v", "1", endcardFile]);
addEndcard({ id: "e1", name: "endcard", fileName: "endcard.png", kind: "image",
  width: 720, height: 1280, durationMs: 3000, hasAudio: false, addedAt: new Date().toISOString() });

// ── пресет и батч ──
const preset = {
  id: "p1", name: "Test preset", createdAt: new Date().toISOString(),
  ...defaultPreset(),
  disclaimer: { text: "Test disclaimer — results not typical", sizeRatio: 0.02, positionY: 0.04 },
  musicTrackId: "m1",
  endcardId: "e1",
  maxSizeMb: 30,
  trimSilence: true,
};
savePreset(preset);

const outDir = path.join(ws, "out");
const batch = {
  id: "b1", name: "Test batch", createdAt: new Date().toISOString(),
  preset, outputDir: outDir, cleanDir: path.join(outDir, "clean"),
  paused: false,
  items: fs.readdirSync(zipsDir).map((zip, i) => ({
    id: `item${i}`,
    name: path.basename(zip, ".zip"),
    zipPath: path.join(zipsDir, zip),
    zipOwned: false,
    status: "queued" as const,
    progress: 0,
  })),
};
saveBatch(batch);

console.log(`Стартуем батч: ${batch.items.map((i) => i.name).join(", ")}`);
const t0 = Date.now();
startBatch("b1");

// поллим до завершения
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  const b = loadBatch("b1")!;
  const line = b.items.map((i) => `${i.name}=${i.status}${i.status === "render" ? ` ${Math.round(i.progress * 100)}%` : ""}`).join(" | ");
  console.log(line);
  if (b.items.every((i) => i.status === "done" || i.status === "error")) break;
  if (Date.now() - t0 > 10 * 60 * 1000) throw new Error("timeout");
}

const b = loadBatch("b1")!;
console.log(`\n— Итоги за ${((Date.now() - t0) / 1000).toFixed(0)}с —`);
for (const i of b.items) {
  console.log(`${i.name}: ${i.status}${i.error ? ` (${i.error})` : ""}`);
  if (i.outputFile) console.log(`  final: ${i.outputFile} ${(fs.statSync(i.outputFile).size / 1024 / 1024).toFixed(1)} МБ`);
  if (i.cleanFile) console.log(`  clean: ${i.cleanFile} ${(fs.statSync(i.cleanFile).size / 1024 / 1024).toFixed(1)} МБ`);
}

// проверки
const ok = b.items.find((i) => i.name.includes("Промо"))!;
const broken = b.items.find((i) => i.name.includes("broken"))!;
const empty = b.items.find((i) => i.name.includes("empty"))!;
const assert = (cond: boolean, msg: string) => {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`OK: ${msg}`);
};
assert(ok.status === "done" && !!ok.outputFile && fs.existsSync(ok.outputFile), "нормальный архив обработан");
assert(!!ok.cleanFile && fs.existsSync(ok.cleanFile), "чистый дубль на месте");
assert(broken.status === "error" && !!broken.error, "битый zip дал ошибку, не уронив батч");
assert(empty.status === "error" && !!empty.error, "архив без видео дал понятную ошибку");
assert(!fs.existsSync(path.join(ws, "batches", "b1", "work", ok.id)), "рабочая папка успешного элемента убрана");

// трим тишины: клип с 2с тишины в начале и ~2с в конце должен ужаться
const trimmed = b.items.find((i) => i.name.includes("trim"))!;
assert(trimmed.status === "done", "архив с тишиной обработан");
if (trimmed.outputFile) {
  const ffprobe = (await import("ffprobe-static")).default.path;
  const dur = Number(
    execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", trimmed.outputFile]).toString()
  );
  const srcDur = Number(
    execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", padded]).toString()
  );
  const expectedMax = srcDur + 3 /* ендкард */ - 3 /* минимум сколько должны срезать */;
  console.log(`  срез тишины: исходник ${srcDur.toFixed(1)}с → финал ${dur.toFixed(1)}с (макс. допустимо ${expectedMax.toFixed(1)}с)`);
  assert(dur < expectedMax, "тишина по краям срезана");
}
