// Тест восстановления после «выключения света»:
//  phase=start  — добавляет элемент, запускает и умирает через N секунд
//  phase=resume — продолжает батч с чекпоинта и ждёт завершения
// Запуск: TYTRY_WORKSPACE=<ws из test-batch> npx tsx scripts/test-batch-resume.mts <phase>
import fs from "node:fs";
import path from "node:path";

const ws = process.env.TYTRY_WORKSPACE!;
const phase = process.argv[2];
const { loadBatch, saveBatch } = await import("../lib/batch/store");
const { startBatch } = await import("../lib/batch/worker");

const batch = loadBatch("b1")!;

if (phase === "start") {
  const zip = path.join(ws, "_gen", "zips", "Промо_видео_01.zip");
  batch.items = batch.items.filter((i) => i.id !== "resume1");
  batch.items.push({
    id: "resume1",
    name: "Resume_test",
    zipPath: zip,
    zipOwned: false,
    status: "queued",
    progress: 0,
  });
  saveBatch(batch);
  startBatch("b1");
  // умираем посреди обработки — как будто выключили свет
  const KILL_AFTER = Number(process.argv[3] ?? 5000);
  setInterval(() => {
    const b = loadBatch("b1")!;
    const it = b.items.find((i) => i.id === "resume1")!;
    console.log(`[start] status=${it.status}`);
  }, 1000);
  setTimeout(() => {
    const it = loadBatch("b1")!.items.find((i) => i.id === "resume1")!;
    console.log(`[start] KILLED at status=${it.status}`);
    process.exit(0);
  }, KILL_AFTER);
} else {
  const before = loadBatch("b1")!.items.find((i) => i.id === "resume1")!;
  console.log(`[resume] стартуем с status=${before.status}`);
  const wd = path.join(ws, "batches", "b1", "work", "resume1");
  console.log(
    `[resume] чекпоинты: clean=${fs.existsSync(path.join(wd, "clean.mp4"))} words=${fs.existsSync(path.join(wd, "words.json"))}`
  );
  startBatch("b1");
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const it = loadBatch("b1")!.items.find((i) => i.id === "resume1")!;
    console.log(`[resume] status=${it.status}`);
    if (it.status === "done" || it.status === "error") {
      if (it.status === "done" && it.outputFile && fs.existsSync(it.outputFile)) {
        console.log(`OK: продолжили после обрыва, файл готов: ${it.outputFile}`);
      } else {
        console.error(`FAIL: ${it.error}`);
        process.exitCode = 1;
      }
      break;
    }
  }
}
