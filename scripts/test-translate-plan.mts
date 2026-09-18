// Юнит-тест разбивки видео на части под лимит перевода (без ffmpeg и сети):
//   npx tsx scripts/test-translate-plan.mts
import {
  planTranslateChunks,
  TRANSLATE_MAX_CHUNK_MS,
  TRANSLATE_HARD_LIMIT_MS,
} from "../lib/translate";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}`, extra ?? "");
  }
}

/** Слова по 400 мс с паузой 500 мс каждые 5 слов (имитация речи). */
function speech(durationMs: number) {
  const words: { startMs: number; endMs: number }[] = [];
  let t = 0;
  let i = 0;
  while (t < durationMs) {
    words.push({ startMs: t, endMs: Math.min(t + 400, durationMs) });
    t += 450;
    if (++i % 5 === 0) t += 500; // пауза между фразами
  }
  return words;
}

function invariants(name: string, chunks: { startMs: number; endMs: number }[], durationMs: number) {
  check(`${name}: части покрывают всё видео`, chunks[0].startMs === 0 && chunks[chunks.length - 1].endMs === durationMs, chunks);
  check(
    `${name}: части встык, без дыр и наложений`,
    chunks.every((c, i) => i === 0 || c.startMs === chunks[i - 1].endMs),
    chunks
  );
  check(
    `${name}: каждая часть в пределах лимита HeyGen`,
    chunks.every((c) => c.endMs - c.startMs <= TRANSLATE_HARD_LIMIT_MS),
    chunks.map((c) => c.endMs - c.startMs)
  );
  check(`${name}: пустых частей нет`, chunks.every((c) => c.endMs > c.startMs), chunks);
}

console.log("\n— короткое видео идёт одним запросом —");
{
  const chunks = planTranslateChunks(45_000, speech(45_000));
  check("45 с = одна часть", chunks.length === 1, chunks);
  const edge = planTranslateChunks(TRANSLATE_MAX_CHUNK_MS, speech(TRANSLATE_MAX_CHUNK_MS));
  check("ровно лимит = одна часть", edge.length === 1, edge);
}

console.log("\n— 2 минуты (типичный случай юзера) —");
{
  const dur = 125_000;
  const chunks = planTranslateChunks(dur, speech(dur));
  invariants("125 с", chunks, dur);
  check("125 с = 2 части", chunks.length === 2, chunks);
  check(
    "части примерно равны",
    Math.abs((chunks[0].endMs - chunks[0].startMs) - (chunks[1].endMs - chunks[1].startMs)) < 8_000,
    chunks
  );
}

console.log("\n— 3 минуты —");
{
  const dur = 185_000;
  const chunks = planTranslateChunks(dur, speech(dur));
  invariants("185 с", chunks, dur);
  check("185 с = 2 части", chunks.length === 2, chunks);
}

console.log("\n— 10 минут —");
{
  const dur = 600_000;
  const chunks = planTranslateChunks(dur, speech(dur));
  invariants("600 с", chunks, dur);
  check("600 с = 7 частей", chunks.length === 7, chunks.length);
}

console.log("\n— разрез попадает в паузу, а не в слово —");
{
  const dur = 150_000;
  const words = speech(dur);
  const chunks = planTranslateChunks(dur, words);
  const cuts = chunks.slice(1).map((c) => c.startMs);
  const insideWord = cuts.filter((cut) =>
    words.some((w) => cut > w.startMs && cut < w.endMs)
  );
  check("ни один шов не режет слово", insideWord.length === 0, insideWord);
}

console.log("\n— без слов (нет транскрипции) режем по времени —");
{
  const dur = 300_000;
  const chunks = planTranslateChunks(dur, []);
  invariants("300 с без слов", chunks, dur);
  check("без слов части всё равно в лимите", chunks.length >= 3, chunks.length);
}

console.log("\n— непрерывная речь без пауз —");
{
  const dur = 260_000;
  const words = Array.from({ length: 650 }, (_, i) => ({ startMs: i * 400, endMs: i * 400 + 395 }));
  const chunks = planTranslateChunks(dur, words);
  invariants("260 с без пауз", chunks, dur);
}

console.log("\n— огрызки не создаются —");
{
  const dur = TRANSLATE_MAX_CHUNK_MS + 1_500; // чуть за лимит
  const chunks = planTranslateChunks(dur, speech(dur));
  invariants("лимит+1.5 с", chunks, dur);
  check(
    "минимальная часть не короче 5 с",
    chunks.every((c) => c.endMs - c.startMs >= 5_000),
    chunks.map((c) => c.endMs - c.startMs)
  );
}

console.log(
  failed === 0 ? "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" : `\n${failed} ПРОВЕРОК УПАЛО`
);
process.exit(failed === 0 ? 0 : 1);
