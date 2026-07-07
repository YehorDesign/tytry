// Юнит-тесты чистой логики: тримы тишины по клипам, сдвиг/ремап слов,
// сборка итерации-хука. Запуск: npx tsx scripts/test-silence.mts
import { computeClipTrims, shiftWordsByTrims, totalTrimMs } from "../lib/silence";
import { remapWordsToClips } from "../lib/montage";
import { buildIterationProject } from "../lib/iterations";
import type { Iteration, Project, TimelineClip, Word } from "../lib/types";

let failed = 0;
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else console.log(`OK: ${msg}`);
};
const eq = (a: number, b: number, msg: string, tol = 1) =>
  assert(Math.abs(a - b) <= tol, `${msg} (${a} ≈ ${b})`);

const w = (id: string, startMs: number, endMs: number): Word => ({
  id,
  text: id,
  startMs,
  endMs,
});

// ── computeClipTrims: тишина по краям каждого клипа ──
{
  // клип0: речь 2000–2500 (тишина в начале и конце)
  // клип1: речь 5200–8800 (почти без тишины — тримы < 100мс не применяются)
  // клип2: без речи (ендкард) — не трогаем
  const durations = [5000, 4000, 3000];
  const words = [w("a", 2000, 2500), w("b", 5200, 6000), w("c", 8000, 8800)];
  const trims = computeClipTrims(durations, words);
  eq(trims[0].lead, 1850, "клип0: лид = 2000-150");
  eq(trims[0].tail, 2350, "клип0: хвост = 5000-(2500+150)");
  eq(trims[1].lead, 0, "клип1: лид меньше порога — не режем");
  eq(trims[1].tail, 0, "клип1: хвост меньше порога — не режем");
  assert(trims[2].lead === 0 && trims[2].tail === 0, "клип2 без речи не тронут");

  // сдвиг слов: после тримов слово должно остаться на своей речи
  const shifted = shiftWordsByTrims(words, durations, trims);
  eq(shifted[0].startMs, 150, "слово a: 2000 - 1850");
  eq(shifted[1].startMs, 5200 - totalTrimMs([trims[0]]), "слово b сдвинуто на тримы клипа0");
  eq(shifted[2].endMs - shifted[2].startMs, 800, "длительность слова c сохранена");
}

// ── computeClipTrims: слово, заехавшее за границу, не «оживляет» пустой клип ──
{
  const durations = [5000, 3000];
  // речь только в клипе0, последнее слово заехало на 200мс в клип1
  const words = [w("a", 300, 4900), w("b", 4900, 5200)];
  const trims = computeClipTrims(durations, words);
  assert(trims[1].lead === 0 && trims[1].tail === 0, "клип1 с заехавшим словом не порезан");
  eq(trims[0].lead, 150, "клип0: лид = 300-150");
}

// ── remapWordsToClips: слова едут вместе с клипами ──
const clip = (id: string, durMs: number, inMs = 0): TimelineClip => ({
  id,
  kind: "video",
  fileName: "f.mp4",
  originalName: id,
  sourceDurationMs: 60000,
  inMs,
  outMs: inMs + durMs,
  width: 720,
  height: 1280,
  hasAudio: true,
});
{
  const a = clip("a", 4000);
  const b = clip("b", 3000);
  const words = [w("wa", 1000, 1500), w("wb", 4500, 5000)]; // wa в a, wb в b
  // перестановка: b теперь первый
  const swapped = remapWordsToClips(words, [a, b], [b, a]);
  eq(swapped[0].startMs, 500, "слово из b поехало в начало (4500-4000)");
  eq(swapped[1].startMs, 4000, "слово из a поехало за b (1000+3000)");

  // трим левого края клипа a на 2000: wa (на 1000мс исходника) вырезано
  const aTrimmed = { ...a, inMs: 2000 };
  const afterTrim = remapWordsToClips(words, [a, b], [aTrimmed, b]);
  assert(afterTrim.length === 1 && afterTrim[0].id === "wb", "слово в вырезанном куске пропало");
  eq(afterTrim[0].startMs, 2500, "слово из b сдвинулось влево на трим (4500-2000)");

  // удаление клипа a: его слова пропали, слова b поехали в начало
  const afterDelete = remapWordsToClips(words, [a, b], [b]);
  assert(afterDelete.length === 1 && afterDelete[0].id === "wb", "слова удалённого клипа пропали");
  eq(afterDelete[0].startMs, 500, "слово из b на новом месте (4500-4000)");

  // зум/пан без изменения таймингов — тот же массив (не дёргаем сохранение слов)
  const zoomed = remapWordsToClips(words, [a, b], [{ ...a, zoom: 1.4 }, b]);
  assert(zoomed === words, "правки без таймингов не трогают слова");
}

// ── buildIterationProject: хук в начало, слова/оверлеи не съезжают ──
{
  const a = clip("a", 4000);
  const b = clip("b", 3000, 1000); // inMs=1000
  const c = clip("c", 3000);
  const project: Project = {
    id: "p1",
    name: "video",
    createdAt: "",
    status: "done",
    language: "auto",
    video: {
      fileName: "f.mp4",
      originalName: "video",
      width: 720,
      height: 1280,
      durationMs: 10000,
      fps: 30,
    },
    words: [w("w1", 500, 900), w("w2", 4500, 5000), w("w3", 7500, 8000)],
    styleId: "hormozi",
    overrides: {},
    clips: [a, b, c],
    overlays: [{ id: "o1", text: "hi", startMs: 2000, endMs: 3000, y: 0.4, sizeRatio: 0.04 }],
  };
  const iteration: Iteration = {
    id: "it1x",
    num: 1,
    clipIds: ["b", "a"], // порядок выбора: сначала b, потом a
    status: "queued",
    progress: 0,
    createdAt: "",
  };
  const variant = buildIterationProject(project, iteration);
  const clips = variant.clips!;
  assert(clips.length === 5, "хук из 2 клипов + 3 исходных");
  assert(
    clips[0].originalName === "b" && clips[1].originalName === "a" && clips[2].id === "a",
    "порядок: хук (b, a), затем исходный монтаж"
  );
  eq(variant.video.durationMs, 17000, "длительность выросла на хук (7000)");

  const words = variant.words!;
  assert(words.length === 5, "слова хука продублированы (w2 из b, w1 из a)");
  // хук: b (3000мс, слово w2 на 4500-4000=500), затем a (слово w1 на 3000+500)
  eq(words[0].startMs, 500, "слово из b в начале хука");
  eq(words[1].startMs, 3500, "слово из a во второй части хука");
  // исходные слова сдвинуты на 7000
  eq(words[2].startMs, 7500, "w1 исходный сдвинут на длину хука");
  eq(variant.overlays![0].startMs, 9000, "оверлей сдвинут на длину хука");
  assert(variant.id !== project.id, "id варианта уникален (свой _flat.mp4)");
}

if (failed > 0) {
  console.error(`\n${failed} проверок упало`);
  process.exit(1);
}
console.log("\nВсе проверки прошли ✓");
