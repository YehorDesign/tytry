import fs from "node:fs";
import path from "node:path";
import { WORKSPACE, ensureWorkspace } from "./store";
import type { StyleOverrides } from "./types";

const SETTINGS_FILE = path.join(WORKSPACE, "settings.json");

export type Settings = {
  deepgramApiKey?: string;
  /** ключ WaveSpeed AI — перевод видео (HeyGen video-translate) */
  wavespeedApiKey?: string;
  /** лимит кэша (workspace) в ГБ; по умолчанию 10 */
  cacheLimitGb?: number;
  /** папка для готовых рендеров; пусто = workspace/renders */
  outputDir?: string;
  /** сколько видео рендерить одновременно (1–4, по умолчанию 3) */
  parallelRenders?: number;
  /** видеокодек: auto = NVENC если доступен, иначе CPU */
  encoder?: "auto" | "nvenc" | "cpu";
  /** native = быстрый движок без Chrome; chrome = старый Remotion-рендер */
  renderEngine?: "native" | "chrome";
  /** лимит размера готового файла в МБ (0 или пусто = без лимита) */
  maxSizeMb?: number;
  /** пресет субтитров для новых проектов */
  defaultStyleId?: string;
  /** правки стиля (шрифт, размер, позиция…) для новых проектов */
  defaultOverrides?: StyleOverrides;
};

/** Стиль для новых проектов: сохранённый пользователем или Gilroy поверх «Підсвітки». */
export function getDefaultStyle(): { styleId: string; overrides: StyleOverrides } {
  const s = getSettings();
  return {
    styleId: s.defaultStyleId ?? "hormozi",
    overrides: s.defaultOverrides ?? { fontFamily: "Gilroy" },
  };
}

export function getSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Settings;
  } catch {
    return {};
  }
}

export function saveSettings(patch: Partial<Settings>) {
  ensureWorkspace();
  const next = { ...getSettings(), ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
}

/** Ключ из настроек UI имеет приоритет, .env.local — запасной вариант. */
export function getDeepgramKey(): string | undefined {
  const fromSettings = getSettings().deepgramApiKey?.trim();
  return fromSettings || process.env.DEEPGRAM_API_KEY || undefined;
}

export function getWavespeedKey(): string | undefined {
  const fromSettings = getSettings().wavespeedApiKey?.trim();
  return fromSettings || process.env.WAVESPEED_API_KEY || undefined;
}

/** Лимит кэша в байтах (по умолчанию 10 ГБ). */
export function getCacheLimitBytes(): number {
  const gb = getSettings().cacheLimitGb;
  const safe = typeof gb === "number" && gb >= 1 && gb <= 500 ? gb : 10;
  return safe * 1024 * 1024 * 1024;
}
