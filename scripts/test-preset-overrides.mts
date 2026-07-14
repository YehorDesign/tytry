// Смоук-тест оверрайдов батч-пресета в нативном рендере:
// npx tsx scripts/test-preset-overrides.mts
// Путь как в батче: overrides → sanitizeOverrides (API пресетов) →
// createScene(styleId, overrides) (worker → renderProjectNative).
// Меряем реальные пиксели: позиция, размер, цвет, капс.
import fs from "node:fs";
import path from "node:path";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { ensureFontsRegistered } from "../lib/render-native/fonts";
import { createScene } from "../lib/render-native/scene";
import { sanitizeOverrides } from "../lib/styles";
import type { StyleOverrides, Word } from "../lib/types";

ensureFontsRegistered();

const width = 1080;
const height = 1920;
const fps = 30;

const words: Word[] = [
  { id: "w1", text: "перевірка", startMs: 100, endMs: 600 },
  { id: "w2", text: "пресета", startMs: 600, endMs: 1100 },
];

const outDir = path.join(process.cwd(), "workspace", "test-preset-overrides");
fs.mkdirSync(outDir, { recursive: true });

type Ink = { top: number; bottom: number; count: number; red: number };

/** Рисует кадр 500мс и возвращает границы нарисованных пикселей. */
function inkFor(name: string, raw: StyleOverrides): Ink {
  const overrides = sanitizeOverrides(raw); // ровно как /api/presets
  const scene = createScene({ words, styleId: "hormozi", overrides, width, height, fps });
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d") as SKRSContext2D;
  ctx.clearRect(0, 0, width, height);
  scene.drawFrame(ctx, Math.round((500 / 1000) * fps));
  fs.writeFileSync(path.join(outDir, `${name}.png`), canvas.toBuffer("image/png"));
  const img = ctx.getImageData(0, 0, width, height).data;
  let top = height, bottom = 0, count = 0, red = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (img[i + 3] > 30) {
        count++;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (img[i] > 180 && img[i + 1] < 90 && img[i + 2] < 90) red++;
      }
    }
  }
  return { top, bottom, count, red };
}

const base = inkFor("base", {});
const up = inkFor("up", { positionY: 0.15 });
const down = inkFor("down", { positionY: 0.85 });
const big = inkFor("big", { fontSizeRatio: 0.1 });
const small = inkFor("small", { fontSizeRatio: 0.03 });
const red = inkFor("red", { textColor: "#FF2020", highlightColor: "#FF2020" });

console.log({ base, up, down, big, small, red });

const fails: string[] = [];
if (!(up.bottom < height * 0.4)) fails.push("positionY=0.15 не поднял субтитры вверх");
if (!(down.top > height * 0.6)) fails.push("positionY=0.85 не опустил субтитры вниз");
if (!(up.top < down.top - height * 0.3)) fails.push("позиции 0.15 и 0.85 не различаются");
const hBig = big.bottom - big.top;
const hSmall = small.bottom - small.top;
if (!(hBig > hSmall * 2)) fails.push(`размер шрифта не влияет: big=${hBig}px small=${hSmall}px`);
if (!(red.red > red.count * 0.3)) fails.push("textColor не применился (нет красных пикселей)");
if (base.count === 0) fails.push("базовый кадр пустой — тест не валиден");

if (fails.length) {
  console.error("FAIL:\n - " + fails.join("\n - "));
  process.exit(1);
}
console.log("OK: позиция, размер и цвет из overrides реально применяются. PNG в", outDir);
