// Шрифты для нативного рендера: встроенные TTF из папки fonts/ + системные.
// Каждый вес регистрируется под своим псевдонимом (Montserrat-800 и т.п.),
// чтобы не зависеть от того, как skia матчит веса внутри одного семейства.
import fs from "node:fs";
import path from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";

const APP_ROOT = process.env.TYTRY_APP_DIR || process.cwd();
const FONTS_DIR = path.join(APP_ROOT, "fonts");

// вес → файл; должен совпадать с наборами в remotion/fonts.ts
const BUILTIN: Record<string, { weights: number[]; italicWeights?: number[] }> = {
  Gilroy: { weights: [500] },
  Montserrat: { weights: [500, 600, 700, 800, 900] },
  Unbounded: { weights: [700, 900] },
  Oswald: { weights: [600, 700] },
  JetBrainsMono: { weights: [700, 800] },
  PlayfairDisplay: { weights: [700, 900], italicWeights: [700, 900] },
  Caveat: { weights: [700] },
};

let registered = false;

function registerFirst(baseName: string, alias: string) {
  for (const ext of [".ttf", ".otf"]) {
    const file = path.join(FONTS_DIR, `${baseName}${ext}`);
    if (fs.existsSync(file)) {
      GlobalFonts.registerFromPath(file, alias);
      return;
    }
  }
}

export function ensureFontsRegistered() {
  if (registered) return;
  registered = true;
  for (const [family, { weights, italicWeights }] of Object.entries(BUILTIN)) {
    for (const w of weights) {
      registerFirst(`${family}-${w}`, `${family}-${w}`);
    }
    for (const w of italicWeights ?? []) {
      registerFirst(`${family}-${w}i`, `${family}-${w}i`);
    }
  }
}

function closest(list: number[], weight: number): number {
  return list.reduce((best, w) =>
    Math.abs(w - weight) < Math.abs(best - weight) ? w : best
  );
}

/**
 * Собирает строку ctx.font. Для встроенных семейств подставляет псевдоним
 * ближайшего веса; для системных — обычный CSS-синтаксис.
 */
export function fontString(
  family: string,
  weight: number,
  sizePx: number,
  italic: boolean
): string {
  const builtin = BUILTIN[family];
  if (builtin) {
    const pool = italic && builtin.italicWeights ? builtin.italicWeights : builtin.weights;
    const alias = `${family}-${closest(pool, weight)}${italic && builtin.italicWeights ? "i" : ""}`;
    // псевдоним уже кодирует вес/начертание
    return `${sizePx}px "${alias}"`;
  }
  return `${italic ? "italic " : ""}${weight} ${sizePx}px "${family}"`;
}
