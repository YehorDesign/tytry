// Диагностика покрытия: какие письменности реально есть в каждом шрифте —
// встроенном (fonts/) и в системных запасках. По этой таблице живёт
// FONT_SCRIPTS в lib/scripts.ts: запусти, если добавляешь шрифт или язык.
// Метод: рисуем символ и заведомо отсутствующий глиф (U+E000, private use)
// одним шрифтом и сравниваем картинки — совпало, значит .notdef («плашка»).
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { ensureFontsRegistered } from "../lib/render-native/fonts";
import { BROAD_FONTS, SCRIPT_FONTS } from "../lib/scripts";

ensureFontsRegistered();

const SIZE = 48;
const BOX = SIZE * 2;
const canvas = createCanvas(BOX, BOX);
const ctx = canvas.getContext("2d");
/** private use area: этого глифа нет ни в одном шрифте — эталон «плашки» */
const NOTDEF = String.fromCodePoint(0xe000);

function bitmap(font: string, ch: string): string {
  ctx.clearRect(0, 0, BOX, BOX);
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#fff";
  ctx.fillText(ch, 2, SIZE * 1.2);
  const d = ctx.getImageData(0, 0, BOX, BOX).data;
  let s = "";
  for (let i = 3; i < d.length; i += 4) s += d[i] > 40 ? "1" : "0";
  return s;
}

function covers(font: string, text: string): { ok: boolean; missing: string } {
  const missing = [...new Set([...text.replace(/\s/g, "")])].filter((ch) => {
    const img = bitmap(font, ch);
    return !/1/.test(img) || img === bitmap(font, NOTDEF);
  });
  return { ok: missing.length === 0, missing: missing.join("") };
}

/** письменности и пробы на них (диакритику проверяем целыми фразами) */
const BUCKETS: Array<[string, string]> = [
  ["latin", "abcXYZ0123"],
  ["latinExt", "zażółć gęślą jaźń příšerně kůň șțâî İğşı äöüß àéèêçœ ñáíóú ãõ"],
  ["cyrillic", "привіт їєґі щьяюё"],
  ["hebrew", "שלום עולם"],
  ["cjk", "こんにちは世界カタカナ"],
  ["hangul", "안녕하세요 세계"],
  ["devanagari", "नमस्ते दुनिया"],
];

const BUILTIN_PROBE: Array<[string, string]> = [
  ["Gilroy", '48px "Gilroy-500"'],
  ["DynaPuff", '48px "DynaPuff-400"'],
  ["Montserrat", '48px "Montserrat-800"'],
  ["Rubik", '48px "Rubik-800"'],
  ["Unbounded", '48px "Unbounded-700"'],
  ["Oswald", '48px "Oswald-700"'],
  ["JetBrainsMono", '48px "JetBrainsMono-700"'],
  ["PlayfairDisplay", '48px "PlayfairDisplay-700"'],
  ["Caveat", '48px "Caveat-700"'],
];

function report(name: string, font: string) {
  const has: string[] = [];
  const no: string[] = [];
  for (const [bucket, text] of BUCKETS) {
    const r = covers(font, text);
    if (r.ok) has.push(bucket);
    else no.push(`${bucket}(${r.missing.slice(0, 12)})`);
  }
  console.log(`${name.padEnd(16)} есть: ${has.join(", ") || "—"}`);
  if (no.length) console.log(`${" ".repeat(16)} нет: ${no.join(", ")}`);
}

const installed = new Set(GlobalFonts.families.map((f) => f.family));
const fallbacks = [...BROAD_FONTS, ...Object.values(SCRIPT_FONTS).flat()].filter(
  (f, i, all) => all.indexOf(f) === i
);

console.log("=== встроенные (fonts/) ===");
for (const [name, font] of BUILTIN_PROBE) report(name, font);

console.log("\n=== системные запаски, доступные на этой машине ===");
for (const f of fallbacks) {
  if (BUILTIN_PROBE.some(([b]) => b === f) || !installed.has(f)) continue;
  report(f, `48px "${f}"`);
}

const absent = fallbacks.filter(
  (f) => !installed.has(f) && !BUILTIN_PROBE.some(([b]) => b === f)
);
if (absent.length) {
  console.log("\nнет на этой машине (запаски для macOS — это норма):", absent.join(", "));
}
