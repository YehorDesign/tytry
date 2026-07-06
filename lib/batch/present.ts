// Представление батча для клиента + общие хелперы API-роутов.
import { isItemRunning } from "./worker";
import type { Batch, BatchItem } from "./types";

/** Статусы «в работе», которые после перезапуска сервера означают «прервано». */
const ACTIVE = new Set(["extract", "montage", "transcribe", "render", "compress"]);

/** Элемент для клиента: зависшие после перезапуска статусы показываем как очередь. */
export function presentItem(batch: Batch, item: BatchItem) {
  const live = isItemRunning(batch.id, item.id);
  return {
    ...item,
    zipPath: undefined, // клиенту пути к архивам не нужны
    status: ACTIVE.has(item.status) && !live ? ("queued" as const) : item.status,
    live,
  };
}

export function presentBatch(batch: Batch) {
  return { ...batch, items: batch.items.map((i) => presentItem(batch, i)) };
}

export function summarizeBatch(batch: Batch) {
  const counts = { done: 0, error: 0, active: 0, queued: 0 };
  for (const item of batch.items) {
    if (item.status === "done") counts.done++;
    else if (item.status === "error") counts.error++;
    else if (isItemRunning(batch.id, item.id)) counts.active++;
    else counts.queued++;
  }
  return {
    id: batch.id,
    name: batch.name,
    createdAt: batch.createdAt,
    presetName: batch.preset.name,
    outputDir: batch.outputDir,
    paused: batch.paused,
    total: batch.items.length,
    ...counts,
  };
}

/** Уникальное имя внутри батча (одинаковые имена архивов не затирают друг друга). */
export function uniqueItemName(existing: BatchItem[], base: string): string {
  const names = new Set(existing.map((i) => i.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}
