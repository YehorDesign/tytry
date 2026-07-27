// Письменности вне латиницы/кириллицы: иврит (справа налево), японский,
// корейский. Проверяем языки/модель Deepgram, подмену шрифта и порядок слов.
import fs from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import { asrModelFor, translateLanguage, TRANSLATE_LANGUAGES } from "../lib/languages";
import { hasRtl, isRtlWords, resolveFamily, scriptOf } from "../lib/scripts";
import { ensureFontsRegistered, familyForText, fontCovers } from "../lib/render-native/fonts";
import { createScene } from "../lib/render-native/scene";

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
};

// ── языки ──
for (const code of ["de", "fr", "es", "it", "pl", "pt", "he", "ja", "ko", "cs", "ro"]) {
  check(`language ${code}`, !!translateLanguage(code));
}
check("he → nova-3", asrModelFor("he") === "nova-3", asrModelFor("he"));
check("pl → nova-2", asrModelFor("pl") === "nova-2", asrModelFor("pl"));
check("auto → nova-2", asrModelFor("auto") === "nova-2");
check("all languages have flag+label", TRANSLATE_LANGUAGES.every((l) => l.flag && l.label));

// ── детект письменности ──
check("scriptOf hebrew", scriptOf("שלום") === "rtl");
check("scriptOf japanese", scriptOf("こんにちは") === "cjk");
check("scriptOf kanji", scriptOf("日本語") === "cjk");
check("scriptOf korean", scriptOf("안녕하세요") === "hangul");
check("scriptOf latin", scriptOf("hello") === "default");
check("scriptOf cyrillic", scriptOf("привіт") === "default");
check("hasRtl", hasRtl("שלום") && !hasRtl("hello") && !hasRtl("привіт"));

// ── подмена шрифта: решает наличие глифов, а не только письменность ──
ensureFontsRegistered();
const fam = (f: string, t: string) => familyForText(f, t);
check("latin keeps font", fam("Gilroy", "hello") === "Gilroy");
check("cyrillic keeps font", fam("Gilroy", "привіт") === "Gilroy");
// диакритика приоритетных локалей должна оставаться в брендовом шрифте
for (const [lang, text] of [
  ["pl", "zażółć gęślą jaźń"],
  ["cs", "příšerně žluťoučký kůň"],
  ["ro", "șarpe țară âîă"],
  ["tr", "İstanbul çğşıöü"],
  ["de/fr/es/pt", "äöüß àéèêçœ ñáíóú ãõ"],
] as const) {
  check(`${lang} остаётся в Gilroy`, fam("Gilroy", text) === "Gilroy", fam("Gilroy", text));
}
check("hebrew → Rubik", fam("Gilroy", "שלום") === "Rubik", fam("Gilroy", "שלום"));
check("japanese → системный", fam("Gilroy", "こんにちは") !== "Gilroy", fam("Gilroy", "こんにちは"));
check("korean → системный", fam("Gilroy", "안녕하세요") !== "Gilroy", fam("Gilroy", "안녕하세요"));
check("hindi → системный", fam("Gilroy", "नमस्ते") !== "Gilroy", fam("Gilroy", "नमस्ते"));
// у DynaPuff нет кириллицы — украинские субтитры этим пресетом были плашками
check("DynaPuff + кириллица → Montserrat", fam("DynaPuff", "привіт") === "Montserrat", fam("DynaPuff", "привіт"));
check("DynaPuff + латиница остаётся", fam("DynaPuff", "hello") === "DynaPuff");
check("fontCovers: Gilroy латиница", fontCovers("Gilroy", "hello"));
check("fontCovers: Gilroy без иврита", !fontCovers("Gilroy", "שלום"));
// один шрифт на всё видео: смешанный текст целиком уходит в общий шрифт
check(
  "иврит + латиница → один Rubik",
  fam("Gilroy", "Deeply שלום") === "Rubik",
  fam("Gilroy", "Deeply שלום")
);
check(
  "японский + латиница → один системный",
  fam("Gilroy", "Deeply こんにちは") === "Yu Gothic",
  fam("Gilroy", "Deeply こんにちは")
);
check(
  "чистая таблица и рендер решают одинаково",
  resolveFamily("Gilroy", "שלום") === fam("Gilroy", "שלום") &&
    resolveFamily("DynaPuff", "привіт") === fam("DynaPuff", "привіт"),
  `${resolveFamily("Gilroy", "שלום")} / ${resolveFamily("DynaPuff", "привіт")}`
);

// ── рендер ──
const W = 1080;
const H = 1920;

function build(words: { id: string; text: string; startMs: number; endMs: number }[]) {
  return createScene({
    words,
    styleId: "hormozi", // highlight-color: активное слово красное — видно, где оно
    overrides: { highlightColor: "#FF0000", textColor: "#FFFFFF" },
    width: W,
    height: H,
    fps: 30,
  });
}

function stats(scene: ReturnType<typeof createScene>, frame: number) {
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  const drew = scene.drawFrame(ctx, frame, 0);
  const d = ctx.getImageData(0, 0, W, H).data;
  let ink = 0;
  let red = 0;
  let sum = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] < 40) continue;
      ink++;
      if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90) {
        red++;
        sum += x;
      }
    }
  }
  return { drew, ink, red, cx: red ? sum / red : NaN, canvas: c };
}

const trio = (a: string, b: string, c: string) => [
  { id: "w0", text: a, startMs: 0, endMs: 600 },
  { id: "w1", text: b, startMs: 600, endMs: 1200 },
  { id: "w2", text: c, startMs: 1200, endMs: 1800 },
];

const cases = [
  { name: "hebrew", words: trio("אחת", "שתיים", "שלוש"), rtl: true },
  { name: "japanese", words: trio("こんにちは", "世界", "です"), rtl: false },
  { name: "korean", words: trio("안녕하세요", "세계", "입니다"), rtl: false },
  { name: "hindi", words: trio("नमस्ते", "दुनिया", "आज"), rtl: false },
  { name: "polish", words: trio("zażółć", "gęślą", "jaźń"), rtl: false },
  { name: "latin", words: trio("one", "two", "three"), rtl: false },
];

const strips: Array<{ name: string; canvas: ReturnType<typeof createCanvas> }> = [];
for (const c of cases) {
  const scene = build(c.words);
  check(`${c.name}: isRtlWords`, isRtlWords(c.words) === c.rtl);
  const first = stats(scene, 5); // активно слово 0
  const last = stats(scene, 45); // активно слово 2
  check(`${c.name}: кадр нарисован`, first.drew && first.ink > 500, `ink=${first.ink}`);
  check(
    `${c.name}: активное слово подсвечено`,
    first.red > 100 && last.red > 100,
    `${first.red}/${last.red}`
  );
  check(
    c.rtl
      ? `${c.name}: первое слово ПРАВЕЕ последнего`
      : `${c.name}: первое слово ЛЕВЕЕ последнего`,
    c.rtl ? first.cx > last.cx + 50 : first.cx < last.cx - 50,
    `x0=${first.cx.toFixed(0)} x2=${last.cx.toFixed(0)}`
  );
  strips.push({ name: c.name, canvas: first.canvas });
}

// одна картинка на глаз: полосы с субтитрами всех четырёх случаев
const BAND = 260;
const sheet = createCanvas(W, BAND * strips.length);
const sctx = sheet.getContext("2d");
sctx.fillStyle = "#111";
sctx.fillRect(0, 0, W, BAND * strips.length);
strips.forEach((s, i) => {
  // строка субтитров стоит около positionY=0.78 — берём полосу вокруг неё
  sctx.drawImage(
    s.canvas,
    0,
    Math.round(H * 0.78) - BAND / 2,
    W,
    BAND,
    0,
    i * BAND,
    W,
    BAND
  );
});
fs.writeFileSync("scripts/out-scripts.png", sheet.toBuffer("image/png"));
console.log("wrote scripts/out-scripts.png");

console.log(failed === 0 ? "\nALL OK" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
