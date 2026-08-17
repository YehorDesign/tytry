/**
 * E2E: куда и под каким именем ложится готовый рендер.
 * Проверяет, что имя проекта НЕ калечится и что всё падает в одну папку
 * из настроек (без подпапки на каждое видео).
 *
 * Запуск (PowerShell): npx tsx scripts/test-output-path.mts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tytry-out-"));
process.env.TYTRY_WORKSPACE = ws;
const outDir = path.join(ws, "готове");

const store = await import("../lib/store");
const jobs = await import("../lib/jobs");
const ffmpegPath = (await import("ffmpeg-static")).default as unknown as string;

store.ensureWorkspace();
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(ws, "settings.json"),
  JSON.stringify({ outputDir: outDir, encoder: "auto", renderEngine: "native", maxSizeMb: 0 }),
  "utf8"
);

// исходник: 3 секунды цветного видео с тишиной
const srcName = "src.mp4";
execFileSync(ffmpegPath, [
  "-y", "-f", "lavfi", "-i", "color=c=teal:s=540x960:r=30:d=3",
  "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
  "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
  path.join(ws, "uploads", srcName),
], { stdio: "ignore" });

// имя с пробелами, дефисами, кириллицей и длиной >60 символов (раньше резалось)
const NAME = "608_N1_FF_AD_Check Brain-Sens_AIUGC_R_Ani_A_Lost_197_max_KB_EK_Meta_9x16";
const id = "outpathtest1";
const project = {
  id,
  name: NAME,
  createdAt: new Date().toISOString(),
  status: "ready",
  language: "uk",
  video: { fileName: srcName, originalName: srcName, width: 540, height: 960, durationMs: 3000, fps: 30 },
  words: [
    { id: "w1", text: "привіт", startMs: 200, endMs: 800 },
    { id: "w2", text: "світ", startMs: 900, endMs: 1500 },
  ],
  styleId: "hormozi",
  overrides: {},
};
store.saveProject(project as never);

async function render() {
  jobs.enqueueRender(id, "http://localhost:3000");
  for (let i = 0; i < 600; i++) {
    const job = jobs.getJob(id);
    if (job && (job.status === "done" || job.status === "error")) {
      if (job.status === "error") throw new Error(`render failed: ${job.error}`);
      return store.loadProject(id)!.renderFile!;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("render timeout");
}

let failed = 0;
const eq = (a: unknown, b: unknown, label: string) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     ${JSON.stringify(a)}\n   ≠ ${JSON.stringify(b)}`}`);
};

const first = await render();
eq(first, path.join(outDir, `${NAME}.mp4`), "рендер лёг прямо в папку из настроек под своим именем");
eq(fs.existsSync(first), true, "файл на месте");
eq(fs.readdirSync(outDir), [`${NAME}.mp4`], "в папке нет подпапок — только сам файл");

// повторный рендер того же проекта перезаписывает свой файл, а не плодит копии
const second = await render();
eq(second, first, "повторный рендер перезаписывает тот же файл");
eq(fs.readdirSync(outDir).length, 1, "копий не появилось");

// чужой файл с таким же именем не затирается
const other = { ...project, id: "outpathtest2", renderFile: undefined };
store.saveProject(other as never);
jobs.enqueueRender(other.id, "http://localhost:3000");
for (let i = 0; i < 600; i++) {
  const job = jobs.getJob(other.id);
  if (job && (job.status === "done" || job.status === "error")) break;
  await new Promise((r) => setTimeout(r, 200));
}
eq(
  store.loadProject(other.id)!.renderFile,
  path.join(outDir, `${NAME}_2.mp4`),
  "второй проект с тем же именем получает суффикс _2"
);

// fs.rmSync молча не работает на кириллических путях (Node 24) — только rmrf
await (await import("../lib/rmrf")).rmrf(ws);
console.log(failed === 0 ? "\nВСЁ ОК" : `\nПРОВАЛЕНО: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
