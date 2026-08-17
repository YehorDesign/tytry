// Визуальная проверка «∞ слов на экране»: npx tsx scripts/shot-words-inf.mts
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { ensureFontsRegistered } from "../lib/render-native/fonts";
import { createScene } from "../lib/render-native/scene";
import type { Word } from "../lib/types";

const TEXT =
  "цей рядок має багато слів щоб перевірити як виглядає сторінка коли ліміт слів знято повністю і все влазить";
const words: Word[] = TEXT.split(" ").map((t, i) => ({
  id: `w${i}`,
  text: t,
  startMs: i * 300,
  endMs: i * 300 + 260,
}));

ensureFontsRegistered();
const outDir = path.join(process.cwd(), "workspace", "test-words-inf");
fs.mkdirSync(outDir, { recursive: true });

for (const max of [8, 20, 999]) {
  const scene = createScene({
    words,
    styleId: "hormozi",
    overrides: { maxWordsPerPage: max, fontFamily: "Gilroy" },
    width: 1080,
    height: 1920,
    fps: 30,
  });
  const canvas = createCanvas(1080, 1920);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#333";
  ctx.fillRect(0, 0, 1080, 1920);
  // кадр в конце первой страницы, когда видно максимум слов
  const frame = Math.round(((words.length * 300) / 1000) * 30) - 5;
  scene.drawFrame(ctx, Math.min(frame, 60));
  fs.writeFileSync(path.join(outDir, `words-${max}.png`), canvas.toBuffer("image/png"));
  const band = scene.verticalBand();
  console.log(`max=${max} band top=${Math.round(band.top)} h=${Math.round(band.height)}`);
}
console.log(outDir);
