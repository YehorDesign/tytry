/**
 * Свои шрифты юзера: разбор имени из файла, каталог в воркспейсе и реальная
 * отрисовка нативным движком (skia рисует «плашки», если шрифт не подхватился —
 * поэтому сравниваем картинку с эталоном).
 *
 * Запуск (PowerShell): npx tsx scripts/test-custom-fonts.mts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tytry-fonts-"));
process.env.TYTRY_WORKSPACE = ws;

const store = await import("../lib/store");
const custom = await import("../lib/fonts-custom");
const nativeFonts = await import("../lib/render-native/fonts");

store.ensureWorkspace();

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
};

// ── имя семейства читается из файла, а не из имени файла ──
const bundled = path.join(process.cwd(), "fonts");
const cases: [file: string, expect: RegExp][] = [
  ["Caveat-700.ttf", /^Caveat( Bold)?$/],
  ["Oswald-600.ttf", /^Oswald/],
  ["Gilroy-500.otf", /^Gilroy/],
  ["PlayfairDisplay-700i.ttf", /^Playfair Display/],
];
for (const [file, expect] of cases) {
  const buf = fs.readFileSync(path.join(bundled, file));
  const name = custom.readFontFamilyName(buf);
  check(`имя из ${file}`, !!name && expect.test(name), String(name));
}
check(
  "mp4 не шрифт",
  !custom.isFontFile(Buffer.from("00000020667479706d70343200000000", "hex"))
);

// ── добавление / список / удаление ──
const added = custom.addCustomFont(
  fs.readFileSync(path.join(bundled, "Caveat-700.ttf")),
  "МійШрифт-Bold.ttf"
);
if ("error" in added) {
  check("шрифт добавлен", false, added.error);
  process.exit(1);
}
const family = added.font.family;
check("шрифт добавлен", custom.listCustomFonts().length === 1, family);
check("файл лежит в воркспейсе", fs.existsSync(custom.fontPath(added.font)));
check("семейство в списке для рендера", custom.customFontFamilies().includes(family));

const badExt = custom.addCustomFont(Buffer.alloc(100), "notafont.woff2");
check("woff2 отклонён", "error" in badExt, "error" in badExt ? badExt.error : "");
const badBody = custom.addCustomFont(Buffer.alloc(100), "broken.ttf");
check("битый файл отклонён", "error" in badBody);

// дубль имени не затирает первый шрифт
const dup = custom.addCustomFont(
  fs.readFileSync(path.join(bundled, "Caveat-700.ttf")),
  "Caveat-copy.ttf"
);
check(
  "дубль получает своё имя",
  !("error" in dup) && dup.font.family !== family,
  !("error" in dup) ? dup.font.family : ""
);

// ── нативный рендер действительно берёт этот шрифт ──
nativeFonts.ensureFontsRegistered();
check("isCustomFamily", nativeFonts.isCustomFamily(family));
check("глифы на месте (латиница)", nativeFonts.fontCovers(family, "Hello"));
check("глифы на месте (кириллиця)", nativeFonts.fontCovers(family, "Привіт"));
check(
  "шрифт не подменяется на латинице",
  nativeFonts.familyForText(family, "Hello world") === family,
  nativeFonts.familyForText(family, "Hello world")
);
check(
  "вес в ctx.font не запрашивается",
  !/[0-9]+ +[0-9]+px/.test(nativeFonts.fontString(family, 800, 64, false)),
  nativeFonts.fontString(family, 800, 64, false)
);

/** Отрисовка слова: сколько закрашенных пикселей и как выглядит маска. */
function stamp(fontFamily: string): { ink: number; mask: string } {
  const canvas = createCanvas(420, 120);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 420, 120);
  ctx.fillStyle = "#fff";
  ctx.font = nativeFonts.fontString(fontFamily, 700, 72, false);
  ctx.textBaseline = "alphabetic";
  ctx.fillText("Привіт", 10, 90);
  const data = ctx.getImageData(0, 0, 420, 120).data;
  let ink = 0;
  let mask = "";
  for (let i = 0; i < data.length; i += 4) {
    const on = data[i] > 100;
    if (on) ink++;
    mask += on ? "1" : "0";
  }
  return { ink, mask };
}

const mine = stamp(family);
const montserrat = stamp("Montserrat");
check("свой шрифт рисуется", mine.ink > 200, `${mine.ink} px`);
check(
  "картинка отличается от Montserrat (т.е. взят именно свой файл)",
  mine.mask !== montserrat.mask
);
// Caveat — рукописный, он заметно легче Montserrat Bold
check("плотность пикселей как у Caveat", mine.ink < montserrat.ink, `${mine.ink} < ${montserrat.ink}`);

// ── удаление ──
custom.deleteCustomFont(added.font.id);
check("шрифт удалён из списка", !custom.customFontFamilies().includes(family));
check("файл удалён", !fs.existsSync(custom.fontPath(added.font)));

fs.rmSync(ws, { recursive: true, force: true });
console.log(failed === 0 ? "\nALL OK" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
