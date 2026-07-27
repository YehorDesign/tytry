// Кэш приложения = workspace (загрузки, склейки, рендеры, превью, аудио).
// Считаем занятое место и умеем чистить файлы-сироты, не привязанные
// ни к одному проекту. Библиотеки (музыка, эндкарды, пресеты) не трогаем.
import fs from "node:fs";
import path from "node:path";
import {
  AUDIO_DIR,
  RENDERS_DIR,
  THUMBS_DIR,
  UPLOADS_DIR,
  WORKSPACE,
  listProjects,
} from "./store";
import { getCacheLimitBytes } from "./settings";
import { rmFileSync } from "./rmrf";

export type CacheUsage = {
  bytes: number;
  limitBytes: number;
};

function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else {
      try {
        total += fs.statSync(full).size;
      } catch {}
    }
  }
  return total;
}

export function cacheUsage(): CacheUsage {
  return { bytes: dirSize(WORKSPACE), limitBytes: getCacheLimitBytes() };
}

/** Файлы моложе этого возраста не трогаем — их может писать текущий рендер. */
const MIN_AGE_MS = 15 * 60 * 1000;

/**
 * Чистка кэша: удаляет из uploads/audio/renders/thumbs файлы, на которые
 * не ссылается ни один проект. Возвращает освобождённые байты.
 */
export function cleanCache(): { freedBytes: number; removed: number } {
  const projects = listProjects();

  // всё, на что ссылаются проекты (по имени файла)
  const keepUploads = new Set<string>();
  const keepRenders = new Set<string>();
  const keepAbsolute = new Set<string>();
  const keepIds = new Set<string>();
  for (const p of projects) {
    keepIds.add(p.id);
    keepUploads.add(p.video.fileName);
    for (const c of p.clips ?? []) keepUploads.add(c.fileName);
    if (p.renderFile) {
      if (path.isAbsolute(p.renderFile)) keepAbsolute.add(path.resolve(p.renderFile));
      else keepRenders.add(p.renderFile);
    }
    for (const it of p.iterations ?? []) {
      if (it.file) keepAbsolute.add(path.resolve(it.file));
    }
  }

  // файл принадлежит живому проекту, если начинается с его id
  // (склейки id_flat.mp4, переводы id_iter_lang.mp4, аудио id.wav, превью id.jpg)
  const ownedByProject = (name: string) =>
    [...keepIds].some((id) => name === `${id}` || name.startsWith(`${id}_`) || name.startsWith(`${id}.`) || name.startsWith(`${id}-`));

  let freed = 0;
  let removed = 0;
  const now = Date.now();

  // трогаем только расширения, которые пишет само приложение: рядом могут
  // лежать чужие файлы (проекты AE и т.п.) — их не касаемся
  const sweep = (
    dir: string,
    ext: RegExp,
    keep: (name: string, full: string) => boolean
  ) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile() || !ext.test(e.name)) continue;
      const full = path.join(dir, e.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs < MIN_AGE_MS) continue; // возможно, пишется сейчас
      if (keep(e.name, full)) continue;
      rmFileSync(full);
      freed += stat.size;
      removed++;
    }
  };

  const MEDIA = /\.(mp4|mov|webm|mkv|avi|m4v|png|jpe?g|webp)$/i;
  sweep(UPLOADS_DIR, MEDIA, (name) => keepUploads.has(name) || ownedByProject(name));
  sweep(AUDIO_DIR, /\.wav$/i, (name) => ownedByProject(name));
  sweep(THUMBS_DIR, /\.jpe?g$/i, (name) => ownedByProject(name));
  sweep(
    RENDERS_DIR,
    /\.mp4$/i,
    (name, full) =>
      keepRenders.has(name) ||
      keepAbsolute.has(path.resolve(full)) ||
      ownedByProject(name)
  );

  return { freedBytes: freed, removed };
}
