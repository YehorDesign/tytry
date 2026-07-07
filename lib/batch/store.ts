// Хранилище батч-режима: пресеты, ендкарды, батчи.
// Всё — JSON-файлы в workspace; запись через tmp+rename, чтобы
// внезапное выключение не оставило битый файл.
import fs from "node:fs";
import path from "node:path";
import { rmFileSync, rmrf } from "../rmrf";
import { WORKSPACE } from "../store";
import type { Batch, BatchPreset, Endcard } from "./types";

export const BATCHES_DIR = path.join(WORKSPACE, "batches");
export const ENDCARDS_DIR = path.join(WORKSPACE, "endcards");
const PRESETS_FILE = path.join(WORKSPACE, "presets.json");
const ENDCARDS_INDEX = path.join(ENDCARDS_DIR, "library.json");

export function ensureBatchDirs() {
  for (const dir of [BATCHES_DIR, ENDCARDS_DIR]) fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// ── пресеты ──

export function listPresets(): BatchPreset[] {
  try {
    const presets = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8")) as BatchPreset[];
    return presets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export function savePreset(preset: BatchPreset) {
  ensureBatchDirs();
  const presets = listPresets().filter((p) => p.id !== preset.id);
  presets.push(preset);
  writeJsonAtomic(PRESETS_FILE, presets);
}

export function deletePreset(id: string) {
  writeJsonAtomic(PRESETS_FILE, listPresets().filter((p) => p.id !== id));
}

// ── ендкарды ──

export function listEndcards(): Endcard[] {
  try {
    const cards = JSON.parse(fs.readFileSync(ENDCARDS_INDEX, "utf8")) as Endcard[];
    return cards.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  } catch {
    return [];
  }
}

export function addEndcard(card: Endcard) {
  ensureBatchDirs();
  const cards = listEndcards().filter((c) => c.id !== card.id);
  cards.push(card);
  writeJsonAtomic(ENDCARDS_INDEX, cards);
}

export function deleteEndcard(id: string) {
  const cards = listEndcards();
  const card = cards.find((c) => c.id === id);
  if (card) rmFileSync(path.join(ENDCARDS_DIR, card.fileName));
  writeJsonAtomic(ENDCARDS_INDEX, cards.filter((c) => c.id !== id));
}

// ── батчи ──

function batchFile(id: string) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("Bad batch id");
  return path.join(BATCHES_DIR, id, "batch.json");
}

export function batchDir(id: string) {
  return path.join(BATCHES_DIR, id);
}

/** Рабочая папка элемента: распакованные клипы и промежуточные файлы. */
export function itemWorkDir(batchId: string, itemId: string) {
  return path.join(BATCHES_DIR, batchId, "work", itemId);
}

/** Папка для загруженных через браузер архивов. */
export function batchZipsDir(batchId: string) {
  return path.join(BATCHES_DIR, batchId, "zips");
}

export function saveBatch(batch: Batch) {
  fs.mkdirSync(batchDir(batch.id), { recursive: true });
  writeJsonAtomic(batchFile(batch.id), batch);
}

export function loadBatch(id: string): Batch | null {
  try {
    return JSON.parse(fs.readFileSync(batchFile(id), "utf8")) as Batch;
  } catch {
    return null;
  }
}

export function listBatches(): Batch[] {
  ensureBatchDirs();
  return fs
    .readdirSync(BATCHES_DIR)
    .map((id) => loadBatch(id))
    .filter((b): b is Batch => b !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Удаляет запись батча и рабочие файлы. Готовые видео в папке пользователя не трогает. */
export async function deleteBatch(id: string) {
  await rmrf(batchDir(id));
}
