// Свои шрифты пользователя: файлы .ttf/.otf лежат в workspace/fonts,
// список — в workspace/fonts/index.json. Одна и та же папка кормит и превью
// (браузер получает файл через /api/fonts/file/<id> и грузит FontFace), и
// нативный рендер (GlobalFonts.registerFromPath под тем же именем семейства),
// поэтому картинка совпадает. Внутри воркспейса — значит переустановка
// приложения шрифты не сносит.
import fs from "node:fs";
import path from "node:path";
import { WORKSPACE } from "./store";
import { rmFileSync } from "./rmrf";

export const CUSTOM_FONTS_DIR = path.join(WORKSPACE, "fonts");
const INDEX_FILE = path.join(CUSTOM_FONTS_DIR, "index.json");

export type CustomFont = {
  id: string;
  /** имя семейства — то, что лежит в overrides.fontFamily */
  family: string;
  /** имя файла внутри CUSTOM_FONTS_DIR */
  fileName: string;
  /** исходное имя файла — показываем в списке */
  originalName: string;
  addedAt: string;
};

/** Форматы, которые умеет и skia (нативный рендер), и браузер. */
export const FONT_EXTS = [".ttf", ".otf", ".ttc"];

export function listCustomFonts(): CustomFont[] {
  try {
    const list = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")) as CustomFont[];
    if (!Array.isArray(list)) return [];
    // битые записи (файл удалили руками) не отдаём
    return list
      .filter((f) => f?.family && f?.fileName && fs.existsSync(fontPath(f)))
      .sort((a, b) => a.family.localeCompare(b.family));
  } catch {
    return [];
  }
}

export function fontPath(font: Pick<CustomFont, "fileName">): string {
  return path.join(CUSTOM_FONTS_DIR, font.fileName);
}

export function getCustomFont(id: string): CustomFont | undefined {
  return listCustomFonts().find((f) => f.id === id);
}

/** Только имена семейств — этого достаточно нативному рендеру и UI-списку. */
export function customFontFamilies(): string[] {
  return listCustomFonts().map((f) => f.family);
}

function saveIndex(list: CustomFont[]) {
  fs.mkdirSync(CUSTOM_FONTS_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(list, null, 2), "utf8");
}

/** Имя семейства → безопасное для CSS/JSON: кавычки и запятые ломают font-family. */
function sanitizeFamily(name: string): string {
  return name
    .replace(/["',;{}()\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function uniqueFamily(name: string, taken: string[]): string {
  if (!taken.includes(name)) return name;
  for (let i = 2; i < 100; i++) {
    const alt = `${name} ${i}`;
    if (!taken.includes(alt)) return alt;
  }
  return `${name} ${Date.now()}`;
}

/**
 * Добавляет шрифт. Имя семейства берём из самого файла (таблица name), а не из
 * имени файла: юзер выбирает шрифт по знакомому названию («Gilroy SemiBold»),
 * а не по «GilroySemiBold-webfont».
 */
export function addCustomFont(
  buffer: Buffer,
  originalName: string
): { font: CustomFont } | { error: string } {
  const ext = path.extname(originalName).toLowerCase();
  if (!FONT_EXTS.includes(ext)) {
    return { error: `Unsupported font format ${ext || "?"} — use .ttf or .otf` };
  }
  if (!isFontFile(buffer)) {
    return { error: `${originalName} is not a valid TTF/OTF font file` };
  }
  const existing = listCustomFonts();
  const parsed = readFontFamilyName(buffer);
  const base = sanitizeFamily(parsed || path.basename(originalName, ext)) || "Custom Font";
  const family = uniqueFamily(base, existing.map((f) => f.family));

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const fileName = `${id}${ext}`;
  fs.mkdirSync(CUSTOM_FONTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(CUSTOM_FONTS_DIR, fileName), buffer);

  const font: CustomFont = {
    id,
    family,
    fileName,
    originalName,
    addedAt: new Date().toISOString(),
  };
  saveIndex([...existing, font]);
  return { font };
}

export function deleteCustomFont(id: string): boolean {
  const list = listCustomFonts();
  const font = list.find((f) => f.id === id);
  if (!font) return false;
  rmFileSync(fontPath(font));
  saveIndex(list.filter((f) => f.id !== id));
  return true;
}

// ── разбор таблицы name ──
// Достаточно минимального парсера sfnt: заголовок → запись таблицы "name" →
// строки с nameID 16/1 (семейство) и 17/2 (начертание).

const SFNT_TAGS = new Set([0x00010000, 0x74727565 /* true */, 0x4f54544f /* OTTO */]);
const TTC_TAG = 0x74746366; // ttcf — коллекция, шрифты внутри со смещениями

export function isFontFile(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const tag = buf.readUInt32BE(0);
  return SFNT_TAGS.has(tag) || tag === TTC_TAG;
}

function sfntOffset(buf: Buffer): number {
  // в коллекции берём первый шрифт
  return buf.readUInt32BE(0) === TTC_TAG ? buf.readUInt32BE(12) : 0;
}

function decodeNameString(buf: Buffer, platformId: number): string {
  // platform 3 (Windows) и 0 (Unicode) — UTF-16BE, platform 1 (Mac) — ASCII.
  // ГОЧА: swap16 меняет буфер НА МЕСТЕ, а тут subarray исходника — копируем.
  const utf16 = platformId !== 1 && buf.length % 2 === 0;
  const text = utf16
    ? Buffer.from(buf).swap16().toString("utf16le")
    : buf.toString("latin1");
  return text.replace(new RegExp("\\u0000", "g"), "").trim();
}

/**
 * Имя семейства из файла: «типографское» (nameID 16) в приоритете, иначе
 * обычное (1); начертание (17/2) дописываем, если это не Regular — так
 * Gilroy-Bold.otf станет «Gilroy Bold», а не «Gilroy» вторым дублем.
 */
export function readFontFamilyName(buf: Buffer): string | null {
  try {
    if (!isFontFile(buf)) return null;
    const base = sfntOffset(buf);
    const numTables = buf.readUInt16BE(base + 4);
    let nameOffset = 0;
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      if (buf.toString("latin1", rec, rec + 4) === "name") {
        nameOffset = buf.readUInt32BE(rec + 8);
        break;
      }
    }
    if (!nameOffset || nameOffset + 6 > buf.length) return null;

    const count = buf.readUInt16BE(nameOffset + 2);
    const stringBase = nameOffset + buf.readUInt16BE(nameOffset + 4);
    // лучшее совпадение по nameID: platform 3 (Windows) предпочтительнее
    const best = new Map<number, { score: number; value: string }>();
    for (let i = 0; i < count; i++) {
      const rec = nameOffset + 6 + i * 12;
      if (rec + 12 > buf.length) break;
      const platformId = buf.readUInt16BE(rec);
      const languageId = buf.readUInt16BE(rec + 4);
      const nameId = buf.readUInt16BE(rec + 6);
      if (![1, 2, 16, 17].includes(nameId)) continue;
      const length = buf.readUInt16BE(rec + 8);
      const offset = stringBase + buf.readUInt16BE(rec + 10);
      if (offset + length > buf.length) continue;
      const value = decodeNameString(buf.subarray(offset, offset + length), platformId);
      if (!value) continue;
      // англоязычная запись (0x409 у Windows, 0 у Mac) — самая надёжная
      const score =
        (platformId === 3 ? 2 : 1) + (languageId === 0x409 || languageId === 0 ? 1 : 0);
      const prev = best.get(nameId);
      if (!prev || score > prev.score) best.set(nameId, { score, value });
    }

    const family = best.get(16)?.value ?? best.get(1)?.value;
    if (!family) return null;
    const style = best.get(17)?.value ?? best.get(2)?.value ?? "";
    return /^(regular|book|normal)?$/i.test(style.trim())
      ? family
      : `${family} ${style}`.trim();
  } catch {
    return null;
  }
}
