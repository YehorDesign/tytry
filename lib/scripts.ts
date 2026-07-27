// Письменности и выбор шрифта под них. Чистые данные/функции — файл
// импортируется и клиентом (превью), и нативным рендером, чтобы оба движка
// выбирали ОДИН И ТОТ ЖЕ шрифт. Нативный skia фолбэк не делает: если в шрифте
// нет буквы, рисуется «плашка» (.notdef), поэтому шрифт подменяем сами.
//
// Решение принимается ОДИН РАЗ НА ВИДЕО (по всем словам сразу), а не по слову:
// иначе внутри одного ролика шрифт прыгал бы от строки к строке.
import type { Word } from "./types";

/** блок иврита + алфавитные презентационные формы */
const RTL_RE = new RegExp("[\u0590-\u05FF\uFB1D-\uFB4F]");
/** хирагана, катакана, кандзи (CJK Unified) */
const CJK_RE = new RegExp("[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]");
/** хангыль: слоги + чамо */
const HANGUL_RE = new RegExp("[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]");
/** деванагари (хинди) */
const DEVANAGARI_RE = new RegExp("[\u0900-\u097F]");

export type ScriptKind = "default" | "rtl" | "cjk" | "hangul" | "devanagari";

/** Группы символов, по которым проверяется покрытие шрифта. */
export type ScriptBucket =
  | "latin"
  | "latinExt" // диакритика: pl/cs/ro/tr/de/fr/es/pt
  | "cyrillic"
  | "hebrew"
  | "cjk"
  | "hangul"
  | "devanagari";

const BUCKET_RE: Array<[ScriptBucket, RegExp]> = [
  ["hebrew", RTL_RE],
  ["cjk", CJK_RE],
  ["hangul", HANGUL_RE],
  ["devanagari", DEVANAGARI_RE],
  ["cyrillic", new RegExp("[\u0400-\u04FF]")],
  ["latinExt", new RegExp("[\u00C0-\u024F\u1E00-\u1EFF]")],
  ["latin", /[A-Za-z]/],
];

/**
 * Кандидаты шрифтов на письменность: первый подходящий и берётся.
 * Rubik лежит в fonts/ (свой, кроссплатформенный), CJK/хангыль/деванагари —
 * системные: тащить Noto CJK в установщик (десятки мегабайт) ради редких
 * локалей дорого, а рендер и превью всё равно идут на одной машине.
 */
export const SCRIPT_FONTS: Record<Exclude<ScriptKind, "default">, string[]> = {
  rtl: ["Rubik"],
  cjk: [
    "Yu Gothic", // Windows 10/11
    "Meiryo",
    "Hiragino Sans", // macOS
    "Hiragino Kaku Gothic ProN",
    "MS Gothic",
    "Arial Unicode MS",
  ],
  hangul: [
    "Malgun Gothic", // Windows
    "Apple SD Gothic Neo", // macOS
    "Noto Sans KR",
    "Arial Unicode MS",
  ],
  devanagari: [
    "Nirmala UI", // Windows 8+
    "Kohinoor Devanagari", // macOS
    "Devanagari Sangam MN",
    "Noto Sans Devanagari",
    "Mangal",
    "Arial Unicode MS",
  ],
};

/**
 * Общие запаски, когда в выбранном шрифте не хватает букв (у DynaPuff нет
 * кириллицы, у брендовых — иврита). Montserrat: латиница с диакритикой +
 * кириллица; Rubik: ещё и иврит; Arial Unicode MS — последняя надежда.
 */
export const BROAD_FONTS = ["Montserrat", "Rubik", "Arial Unicode MS"];

const ALL: ScriptBucket[] = [
  "latin",
  "latinExt",
  "cyrillic",
  "hebrew",
  "cjk",
  "hangul",
  "devanagari",
];

/**
 * Что реально покрывает каждый шрифт. Встроенные и системные шрифты Windows
 * измерены `npx tsx scripts/check-coverage.mts` (сравнение с .notdef);
 * шрифты macOS заявлены по их назначению — нативный рендер всё равно
 * проверяет глифы сам и уходит дальше по цепочке, если данные врут.
 */
export const FONT_SCRIPTS: Record<string, ScriptBucket[]> = {
  // встроенные (fonts/)
  Gilroy: ["latin", "latinExt", "cyrillic"],
  DynaPuff: ["latin", "latinExt"], // кириллицы НЕТ
  Montserrat: ["latin", "latinExt", "cyrillic"],
  Rubik: ["latin", "latinExt", "cyrillic", "hebrew"],
  Unbounded: ["latin", "latinExt", "cyrillic"],
  Oswald: ["latin", "latinExt", "cyrillic"],
  JetBrainsMono: ["latin", "latinExt", "cyrillic"],
  PlayfairDisplay: ["latin", "latinExt", "cyrillic"],
  Caveat: ["latin", "latinExt", "cyrillic"],
  // системные: Windows (измерено)
  "Arial Unicode MS": ALL,
  "Yu Gothic": ["latin", "latinExt", "cjk"],
  "MS Gothic": ["latin", "cyrillic", "cjk"],
  "Malgun Gothic": ["latin", "cjk", "hangul"],
  "Nirmala UI": ["latin", "devanagari"],
  Mangal: ["latin", "devanagari"],
  // системные: macOS (заявлено)
  Meiryo: ["latin", "latinExt", "cjk"],
  "Hiragino Sans": ["latin", "latinExt", "cyrillic", "cjk"],
  "Hiragino Kaku Gothic ProN": ["latin", "latinExt", "cyrillic", "cjk"],
  "Apple SD Gothic Neo": ["latin", "latinExt", "cyrillic", "hangul"],
  "Noto Sans KR": ["latin", "latinExt", "hangul"],
  "Kohinoor Devanagari": ["latin", "devanagari"],
  "Devanagari Sangam MN": ["latin", "devanagari"],
  "Noto Sans Devanagari": ["latin", "latinExt", "devanagari"],
};

/** Незнакомый (системный, выбранный юзером) шрифт: считаем его обычным. */
const UNKNOWN_FONT_SCRIPTS: ScriptBucket[] = ["latin", "latinExt", "cyrillic"];

/** Письменность текста (первая найденная — смешанные слова редки). */
export function scriptOf(text: string): ScriptKind {
  if (RTL_RE.test(text)) return "rtl";
  if (HANGUL_RE.test(text)) return "hangul";
  if (CJK_RE.test(text)) return "cjk";
  if (DEVANAGARI_RE.test(text)) return "devanagari";
  return "default";
}

/** Какие группы символов встречаются в тексте. */
export function bucketsOf(text: string): ScriptBucket[] {
  return BUCKET_RE.filter(([, re]) => re.test(text)).map(([b]) => b);
}

export function fontHasBuckets(family: string, need: ScriptBucket[]): boolean {
  const has = FONT_SCRIPTS[family] ?? UNKNOWN_FONT_SCRIPTS;
  return need.every((b) => has.includes(b));
}

/** Порядок перебора запасок: сначала под письменность текста, потом общие. */
export function fallbackChain(text: string): string[] {
  const kind = scriptOf(text);
  return [
    ...(kind === "default" ? [] : SCRIPT_FONTS[kind]),
    ...BROAD_FONTS,
    ...Object.values(SCRIPT_FONTS).flat(),
  ].filter((f, i, all) => all.indexOf(f) === i);
}

/**
 * Шрифт, которым можно нарисовать ВЕСЬ этот текст: выбранный юзером, если
 * букв хватает, иначе первая подходящая запаска. Одна функция для превью и
 * рендера — поэтому картинка совпадает.
 */
export function resolveFamily(family: string, text: string): string {
  const need = bucketsOf(text);
  if (!need.length || fontHasBuckets(family, need)) return family;
  return fallbackChain(text).find((f) => f !== family && fontHasBuckets(f, need)) ?? family;
}

/** Шрифт с ивритом — встроенный, поэтому его имя нужно и напрямую. */
export const RTL_FONT = SCRIPT_FONTS.rtl[0];

/** Есть ли в тексте буквы RTL-письма. */
export function hasRtl(text: string): boolean {
  return RTL_RE.test(text);
}

/** RTL-субтитры: хотя бы одно слово написано справа налево. */
export function isRtlWords(words: Pick<Word, "text">[]): boolean {
  return words.some((w) => RTL_RE.test(w.text));
}

/** Весь текст субтитров одной строкой — по нему выбирается шрифт на видео. */
export function allWordsText(words: Pick<Word, "text">[]): string {
  return words.map((w) => w.text).join(" ");
}

/**
 * Хвост запасок для CSS font-family в превью: страховка на случай, если
 * таблица покрытий разошлась с реальностью — лучше чужой глиф, чем «плашка».
 */
export const FALLBACK_FAMILIES: string[] = [
  ...BROAD_FONTS,
  ...Object.values(SCRIPT_FONTS).flat(),
].filter((f, i, all) => all.indexOf(f) === i);
