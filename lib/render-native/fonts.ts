// Шрифты для нативного рендера: встроенные TTF из папки fonts/ + системные.
// Каждый вес регистрируется под своим псевдонимом (Montserrat-800 и т.п.),
// чтобы не зависеть от того, как skia матчит веса внутри одного семейства.
import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { fallbackChain, resolveFamily, scriptOf } from "../scripts";
import { CUSTOM_FONTS_DIR, fontPath, listCustomFonts } from "../fonts-custom";

const APP_ROOT = process.env.TYTRY_APP_DIR || process.cwd();
const FONTS_DIR = path.join(APP_ROOT, "fonts");

// вес → файл; должен совпадать с наборами в remotion/fonts.ts
const BUILTIN: Record<string, { weights: number[]; italicWeights?: number[] }> = {
  Gilroy: { weights: [500] },
  DynaPuff: { weights: [400] },
  Montserrat: { weights: [500, 600, 700, 800, 900] },
  // латиница + кириллица + иврит: им же рисуется RTL-текст (см. lib/scripts.ts)
  Rubik: { weights: [500, 700, 800, 900] },
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
  ensureCustomRegistered();
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

// ── свои шрифты юзера (workspace/fonts) ──
// Файл регистрируется под именем своего семейства — тем же, что стоит в
// overrides.fontFamily и что грузит превью через FontFace. Индекс перечитываем
// по mtime: шрифт, добавленный без перезапуска, подхватится следующим рендером.

const customFamilies = new Set<string>();
let customStamp = "";

function ensureCustomRegistered() {
  let stamp: string;
  try {
    stamp = String(fs.statSync(path.join(CUSTOM_FONTS_DIR, "index.json")).mtimeMs);
  } catch {
    stamp = "none";
  }
  if (stamp === customStamp) return;
  customStamp = stamp;
  for (const font of listCustomFonts()) {
    if (customFamilies.has(font.family)) continue;
    try {
      GlobalFonts.registerFromPath(fontPath(font), font.family);
      customFamilies.add(font.family);
    } catch (err) {
      console.warn(`[fonts] не удалось зарегистрировать «${font.family}»: ${err}`);
    }
  }
}

/** Это загруженный юзером шрифт (а не встроенный/системный)? */
export function isCustomFamily(family: string): boolean {
  ensureCustomRegistered();
  return customFamilies.has(family);
}

// ── подмена шрифта по реальному наличию глифов ──
// skia фолбэк не делает: если в шрифте нет буквы, рисуется «плашка» (.notdef).
// Поэтому проверяем каждую букву сами и при нехватке берём шрифт, где она есть.

const PROBE_PX = 48;
const PROBE_BOX = PROBE_PX * 2;
/** U+E000 — private use, его нет ни в одном шрифте: эталон «плашки» */
const NOTDEF = String.fromCodePoint(0xe000);

let probeCtx: ReturnType<ReturnType<typeof createCanvas>["getContext"]> | null = null;
const glyphCache = new Map<string, boolean>();
const familyCache = new Map<string, string>();
const warned = new Set<string>();

function stamp(family: string, ch: string): string {
  if (!probeCtx) {
    probeCtx = createCanvas(PROBE_BOX, PROBE_BOX).getContext("2d");
  }
  const ctx = probeCtx;
  ctx.clearRect(0, 0, PROBE_BOX, PROBE_BOX);
  ctx.font = fontString(family, 700, PROBE_PX, false);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#fff";
  ctx.fillText(ch, 2, PROBE_PX * 1.2);
  const d = ctx.getImageData(0, 0, PROBE_BOX, PROBE_BOX).data;
  let out = "";
  for (let i = 3; i < d.length; i += 4) out += d[i] > 40 ? "1" : "0";
  return out;
}

/** Есть ли в шрифте глиф этого символа (а не «плашка» и не пустота). */
function hasGlyph(family: string, ch: string): boolean {
  const key = `${family}|${ch}`;
  const cached = glyphCache.get(key);
  if (cached !== undefined) return cached;
  ensureFontsRegistered();
  const img = stamp(family, ch);
  const ok = /1/.test(img) && img !== stamp(family, NOTDEF);
  glyphCache.set(key, ok);
  return ok;
}

/** Все ли буквы текста есть в шрифте (пробелы и переводы строк не считаем). */
export function fontCovers(family: string, text: string): boolean {
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (!hasGlyph(family, ch)) return false;
  }
  return true;
}

function availableFamilies(): Set<string> {
  ensureFontsRegistered();
  return new Set(GlobalFonts.families.map((f) => f.family));
}

/** Шрифт есть на машине и в нём действительно есть все буквы текста. */
function usable(family: string, text: string): boolean {
  if (!BUILTIN[family] && !availableFamilies().has(family)) return false;
  return fontCovers(family, text);
}

/**
 * Семейство, которым рисуется ВЕСЬ переданный текст (в сцене это все слова
 * видео сразу — чтобы шрифт не прыгал между строками). Основное решение
 * принимает общая с превью таблица покрытий (lib/scripts.ts), а глифы тут
 * ещё и перепроверяются: на этой машине системного шрифта может не быть.
 */
export function familyForText(family: string, text: string): string {
  const key = `${family}|${text}`;
  const cached = familyCache.get(key);
  if (cached !== undefined) return cached;

  let out = resolveFamily(family, text);
  if (!usable(out, text)) {
    const found = fallbackChain(text).find((f) => f !== out && usable(f, text));
    if (found) {
      out = found;
    } else if (!warned.has(key)) {
      warned.add(key);
      console.warn(
        `[fonts] нет шрифта с глифами для «${text.slice(0, 40)}» (${scriptOf(text)}) — ` +
          `останется «${family}», часть букв будет плашками`
      );
      out = family;
    }
  }
  familyCache.set(key, out);
  return out;
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
  // свой шрифт юзера — один файл на семейство: вес не запрашиваем, иначе
  // skia может дорисовать искусственный жир, которого нет в превью
  if (isCustomFamily(family)) {
    return `${italic ? "italic " : ""}${sizePx}px "${family}"`;
  }
  const builtin = BUILTIN[family];
  if (builtin) {
    const pool = italic && builtin.italicWeights ? builtin.italicWeights : builtin.weights;
    const alias = `${family}-${closest(pool, weight)}${italic && builtin.italicWeights ? "i" : ""}`;
    // псевдоним уже кодирует вес/начертание
    return `${sizePx}px "${alias}"`;
  }
  return `${italic ? "italic " : ""}${weight} ${sizePx}px "${family}"`;
}
