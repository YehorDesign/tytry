// Перевод видео через WaveSpeed AI (HeyGen video-translate):
// загрузка файла → сабмит задачи → поллинг → скачивание результата.
// Ключ — в настройках (⚙) или env WAVESPEED_API_KEY.
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getWavespeedKey } from "./settings";
import { translateLanguage } from "./languages";

const API = "https://api.wavespeed.ai/api/v3";
/** WaveSpeed принимает файлы до 200 МБ */
export const WAVESPEED_UPLOAD_LIMIT_MB = 200;

function authHeaders(): Record<string, string> {
  const key = getWavespeedKey();
  if (!key) {
    throw new Error("WaveSpeed key is not set — add it in Settings (⚙ button)");
  }
  return { Authorization: `Bearer ${key}` };
}

type WsEnvelope<T> = { code: number; message: string; data: T };

async function wsJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`WaveSpeed ${what}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as WsEnvelope<T>;
  if (body.code !== 200 || !body.data) {
    throw new Error(`WaveSpeed ${what}: ${body.message || `code ${body.code}`}`);
  }
  return body.data;
}

/** Загружает локальный файл в хранилище WaveSpeed (живёт 7 дней) → URL. */
async function uploadFile(filePath: string): Promise<string> {
  const sizeMb = fs.statSync(filePath).size / 1024 / 1024;
  if (sizeMb > WAVESPEED_UPLOAD_LIMIT_MB) {
    throw new Error(
      `Video is too big for translation: ${Math.round(sizeMb)} MB (limit ${WAVESPEED_UPLOAD_LIMIT_MB} MB)`
    );
  }
  // openAsBlob (Node ≥19.8) не грузит файл в память целиком
  const openAsBlob = (
    fs as unknown as {
      openAsBlob?: (p: string, o: { type: string }) => Promise<Blob>;
    }
  ).openAsBlob;
  const blob = openAsBlob
    ? await openAsBlob(filePath, { type: "video/mp4" })
    : new Blob([fs.readFileSync(filePath)], { type: "video/mp4" });
  const form = new FormData();
  form.append("file", blob, "video.mp4");
  const res = await fetch(`${API}/media/upload/binary`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  const data = await wsJson<{ download_url: string }>(res, "upload");
  if (!data.download_url) throw new Error("WaveSpeed upload: no download_url");
  return data.download_url;
}

/** Ставит задачу перевода → id задачи. */
async function submitTranslate(videoUrl: string, langCode: string): Promise<string> {
  const lang = translateLanguage(langCode);
  if (!lang) throw new Error(`Unknown translate language: ${langCode}`);

  const send = async (name: string) => {
    const res = await fetch(`${API}/heygen/video-translate`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ video: videoUrl, output_language: name }),
    });
    const data = await wsJson<{ id: string }>(res, "video-translate");
    if (!data.id) throw new Error("WaveSpeed video-translate: no task id");
    return data.id;
  };

  try {
    return await send(lang.heygen);
  } catch (e) {
    // у части языков HeyGen ждёт имя с регионом («Hebrew (Israel)») — пробуем его
    if (!lang.heygenAlt) throw e;
    console.warn(
      `[translate] ${lang.heygen} rejected (${(e as Error).message}) — retrying as ${lang.heygenAlt}`
    );
    return await send(lang.heygenAlt);
  }
}

const POLL_TIMEOUT_MS = 45 * 60 * 1000; // HeyGen переводит долго: минуты, не секунды

/** Ждёт завершения задачи → URL готового видео. onTick — пульс для прогресса. */
async function pollResult(taskId: string, onTick?: (elapsedMs: number) => void): Promise<string> {
  const started = Date.now();
  let interval = 3000;
  for (;;) {
    const elapsed = Date.now() - started;
    if (elapsed > POLL_TIMEOUT_MS) {
      throw new Error("WaveSpeed translation timed out (45 min)");
    }
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(interval + 1000, 10000);
    onTick?.(elapsed);

    const res = await fetch(`${API}/predictions/${taskId}/result`, {
      headers: authHeaders(),
    });
    const data = await wsJson<{
      status: string;
      outputs?: string[];
      error?: string;
    }>(res, "result");
    if (data.status === "completed") {
      const url = data.outputs?.[0];
      if (!url) throw new Error("WaveSpeed: task completed but no output");
      return url;
    }
    if (data.status === "failed" || data.status === "cancelled" || data.status === "timeout") {
      throw new Error(`WaveSpeed translation ${data.status}: ${data.error ?? "no details"}`);
    }
  }
}

/** Скачивает готовый файл потоком (без буферизации в память). */
async function download(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`WaveSpeed download failed: HTTP ${res.status}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
    fs.createWriteStream(outPath)
  );
}

export type TranslateProgress = {
  /** 0..1 внутри этапа перевода (загрузка→перевод→скачивание) */
  progress: number;
};

/**
 * Полный цикл перевода: локальный файл → переведённый локальный файл.
 * durationMs — длительность видео, по ней оценивается прогресс перевода.
 */
export async function translateVideoFile(opts: {
  inputPath: string;
  outPath: string;
  language: string; // код из lib/languages.ts
  durationMs: number;
  onProgress?: (p: number) => void;
}): Promise<void> {
  const report = (p: number) => opts.onProgress?.(Math.min(Math.max(p, 0), 1));

  report(0.02);
  const url = await uploadFile(opts.inputPath);
  report(0.12);

  const taskId = await submitTranslate(url, opts.language);
  // HeyGen обычно переводит ~1–3 длительности ролика; асимптотически ползём к 0.92
  const expectedMs = Math.max(opts.durationMs * 2, 120_000);
  const outputUrl = await pollResult(taskId, (elapsed) => {
    report(0.12 + 0.8 * (1 - Math.exp(-elapsed / expectedMs)));
  });

  report(0.94);
  await download(outputUrl, opts.outPath);
  report(1);
}
