// E2E нарезки + параллели + склейки перевода БЕЗ WaveSpeed (перевод подменён
// на копирование файла), т.е. без денег и сети:
//   npx tsx scripts/test-translate-chunks.mts
//
// Проверяем: части реально ≤ лимита HeyGen, переводы идут параллельно,
// склейка даёт видео исходной длины, кэш частей выживает после сбоя
// и повторная попытка не «переводит» уже готовые части.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import { probeMedia } from "../lib/ffmpeg";
import { planTranslateChunks, translateLongVideo, TRANSLATE_HARD_LIMIT_MS } from "../lib/translate";

const exec = promisify(execFile);
const FFMPEG = ffmpegPath as unknown as string;

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}`, extra ?? "");
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tytry-tr-"));
const partsDir = path.join(root, "uploads");
const tmpDir = path.join(root, "renders");
fs.mkdirSync(partsDir);
fs.mkdirSync(tmpDir);

const DURATION_S = 150; // 2.5 минуты — как у юзера
const src = path.join(root, "src.mp4");

async function makeSource() {
  await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=540x960:rate=30:duration=${DURATION_S}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${DURATION_S}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "34",
    "-c:a", "aac", "-b:a", "64k",
    "-pix_fmt", "yuv420p",
    src,
  ]);
}

/** «Речь»: слова по 400 мс с паузой 600 мс каждые 5 слов. */
function speech(durationMs: number) {
  const words: { startMs: number; endMs: number }[] = [];
  let t = 0;
  let i = 0;
  while (t < durationMs) {
    words.push({ startMs: t, endMs: Math.min(t + 400, durationMs) });
    t += 450;
    if (++i % 5 === 0) t += 600;
  }
  return words;
}

const words = speech(DURATION_S * 1000);

type Call = { durationMs: number; inputMs: number };

/** Подмена перевода: копирует вход в выход, отмечая параллельность. */
function fakeTranslator(opts: {
  calls: Call[];
  failOn?: number; // индекс вызова, который должен упасть
  onConcurrency?: (n: number) => void;
}) {
  let active = 0;
  let seen = 0;
  return async (o: {
    inputPath: string;
    outPath: string;
    language: string;
    durationMs: number;
    onProgress?: (p: number) => void;
  }) => {
    const n = seen++;
    active++;
    opts.onConcurrency?.(active);
    try {
      const probe = await probeMedia(o.inputPath);
      opts.calls.push({ durationMs: o.durationMs, inputMs: probe.durationMs });
      o.onProgress?.(0.5);
      await new Promise((r) => setTimeout(r, 300)); // имитация сетевой задержки
      if (opts.failOn === n) throw new Error("fake API failure");
      fs.copyFileSync(o.inputPath, o.outPath);
      o.onProgress?.(1);
    } finally {
      active--;
    }
  };
}

async function main() {
  console.log("\n— готовим исходник 150 с —");
  await makeSource();
  const srcProbe = await probeMedia(src);
  check("исходник собран", Math.abs(srcProbe.durationMs - DURATION_S * 1000) < 1500, srcProbe);

  const plan = planTranslateChunks(srcProbe.durationMs, words);
  console.log(
    `  план: ${plan.length} части ${plan
      .map((c) => `${((c.endMs - c.startMs) / 1000).toFixed(1)}с`)
      .join(" + ")}`
  );

  console.log("\n— сбой одной части: кэш остальных остаётся —");
  const out = path.join(root, "translated.mp4");
  const failCalls: Call[] = [];
  let failedAsExpected = false;
  try {
    await translateLongVideo({
      inputPath: src,
      outPath: out,
      language: "en",
      words,
      partsDir,
      partsPrefix: "proj_iter_en",
      tmpDir,
      parallel: 3,
      translator: fakeTranslator({ calls: failCalls, failOn: 0 }),
    });
  } catch (e) {
    failedAsExpected = /fake API failure/.test((e as Error).message);
  }
  check("итерация упала с текстом провайдера", failedAsExpected);
  check("готового файла нет", !fs.existsSync(out));
  const cachedParts = fs.readdirSync(partsDir).filter((f) => /_p\d+of\d+\.mp4$/.test(f));
  check(
    `успешные части закэшированы (${cachedParts.length} из ${plan.length})`,
    cachedParts.length === plan.length - 1,
    cachedParts
  );
  check(
    "недокачанных .part не осталось",
    fs.readdirSync(partsDir).every((f) => !f.endsWith(".part")),
    fs.readdirSync(partsDir)
  );

  console.log("\n— повтор: платим только за упавшую часть —");
  const retryCalls: Call[] = [];
  let maxConcurrent = 0;
  const progress: number[] = [];
  let lastParts = { done: 0, total: 0 };
  await translateLongVideo({
    inputPath: src,
    outPath: out,
    language: "en",
    words,
    partsDir,
    partsPrefix: "proj_iter_en",
    tmpDir,
    parallel: 3,
    onProgress: (p) => progress.push(p),
    onParts: (done, total) => (lastParts = { done, total }),
    translator: fakeTranslator({
      calls: retryCalls,
      onConcurrency: (n) => (maxConcurrent = Math.max(maxConcurrent, n)),
    }),
  });
  check(
    `повтор перевёл только 1 часть (было ${retryCalls.length})`,
    retryCalls.length === 1,
    retryCalls
  );
  check("готовый файл появился", fs.existsSync(out));
  const outProbe = await probeMedia(out);
  check(
    `длительность склейки ≈ исходник (${(outProbe.durationMs / 1000).toFixed(1)} с)`,
    Math.abs(outProbe.durationMs - srcProbe.durationMs) < 2000,
    outProbe
  );
  check("размер кадра сохранён", outProbe.width === 540 && outProbe.height === 960, outProbe);
  check("звук на месте", outProbe.hasAudio);
  check(`счётчик частей дошёл до ${plan.length}/${plan.length}`, lastParts.done === plan.length && lastParts.total === plan.length, lastParts);
  check("прогресс монотонный и доходит до 1", progress[progress.length - 1] === 1 && progress.every((p, i) => i === 0 || p >= progress[i - 1] - 1e-9), progress.slice(-3));
  check(
    "части удалены после успешной склейки",
    fs.readdirSync(partsDir).filter((f) => /_p\d+of\d+\.mp4$/.test(f)).length === 0,
    fs.readdirSync(partsDir)
  );
  check(
    "нарезки исходника подчищены",
    fs.readdirSync(tmpDir).length === 0,
    fs.readdirSync(tmpDir)
  );

  console.log("\n— части реально влезают в лимит HeyGen —");
  const all = [...failCalls, ...retryCalls];
  check(
    "каждая отправленная часть ≤ 120 с",
    all.every((c) => c.inputMs <= TRANSLATE_HARD_LIMIT_MS),
    all.map((c) => c.inputMs)
  );
  check(
    "заявленная длительность совпадает с файлом (±0.5 с)",
    all.every((c) => Math.abs(c.inputMs - c.durationMs) < 500),
    all
  );

  console.log("\n— параллельность —");
  const parCalls: Call[] = [];
  let parMax = 0;
  const out2 = path.join(root, "translated2.mp4");
  await translateLongVideo({
    inputPath: src,
    outPath: out2,
    language: "de",
    words,
    partsDir,
    partsPrefix: "proj_iter_de",
    tmpDir,
    parallel: 3,
    translator: fakeTranslator({
      calls: parCalls,
      onConcurrency: (n) => (parMax = Math.max(parMax, n)),
    }),
  });
  check(
    `части переводились одновременно (максимум ${parMax})`,
    parMax >= Math.min(2, plan.length),
    parMax
  );
  check("перевод с нуля прошёл целиком", fs.existsSync(out2));

  console.log("\n— parallel: 1 = строго по одной —");
  const seqCalls: Call[] = [];
  let seqMax = 0;
  const out3 = path.join(root, "translated3.mp4");
  await translateLongVideo({
    inputPath: src,
    outPath: out3,
    language: "pl",
    words,
    partsDir,
    partsPrefix: "proj_iter_pl",
    tmpDir,
    parallel: 1,
    translator: fakeTranslator({
      calls: seqCalls,
      onConcurrency: (n) => (seqMax = Math.max(seqMax, n)),
    }),
  });
  check("parallel:1 не запускает второй запрос", seqMax === 1, seqMax);
}

main()
  .then(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
    console.log(failed === 0 ? "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" : `\n${failed} ПРОВЕРОК УПАЛО`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error(e);
    console.log(`\nтестовые файлы остались в ${root}`);
    process.exit(1);
  });
