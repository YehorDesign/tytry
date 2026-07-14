// Типы батч-режима: пресеты, ендкарды, батчи и их элементы.
import type { Disclaimer, StyleOverrides } from "../types";

/** Переиспользуемый пресет обработки: применяется ко всему батчу при создании. */
export type BatchPreset = {
  id: string;
  name: string;
  createdAt: string;
  /** язык распознавания: 'auto' | 'uk' | 'ru' | 'en' | … */
  language: string;
  /** делать ли субтитры (выкл = только монтаж/музыка/ендкард) */
  captions: boolean;
  /** субтитры из ТЕКСТА МУЗЫКИ (lyrics трека), а не из речи в клипах */
  captionsFromMusic?: boolean;
  /** обрезать тишину в начале и конце по таймингам слов (нужен Deepgram) */
  trimSilence: boolean;
  styleId: string;
  overrides: StyleOverrides;
  disclaimer: Disclaimer | null;
  /** трек из библиотеки музыки */
  musicTrackId: string | null;
  musicVolume: number; // 0..1
  /** ендкард из библиотеки (картинка или видео), добавляется в конец монтажа */
  endcardId: string | null;
  /** длительность ендкарда-картинки, мс */
  endcardDurationMs: number;
  /** дубль без субтитров/музыки/сжатия в отдельную папку */
  cleanCopy: boolean;
  /** лимит размера готового файла в МБ (0 = без лимита) */
  maxSizeMb: number;
};

/** Ендкард в библиотеке (workspace/endcards/library.json) */
export type Endcard = {
  id: string;
  name: string;
  fileName: string;
  kind: "video" | "image";
  width: number;
  height: number;
  durationMs: number;
  hasAudio: boolean;
  addedAt: string;
};

export type BatchItemStatus =
  | "queued" // ждёт очереди (или прервано — продолжится с чекпоинта)
  | "extract" // распаковка архива
  | "montage" // склейка клипов + ендкард
  | "transcribe" // распознавание речи
  | "render" // субтитры + музыка + дисклеймер
  | "compress" // ужатие под лимит размера
  | "done"
  | "error";

/** Один архив = одно готовое видео. */
export type BatchItem = {
  id: string;
  /** имя архива без расширения — база для имени результата */
  name: string;
  /** абсолютный путь к zip (из папки пользователя или из workspace) */
  zipPath: string;
  /** zip загружен в workspace (можно удалить после успеха) или лежит у пользователя */
  zipOwned: boolean;
  status: BatchItemStatus;
  /** прогресс текущей стадии 0..1 (осмыслен для render) */
  progress: number;
  error?: string;
  /** рендер завершён (final.mp4 в рабочей папке валиден) */
  rendered?: boolean;
  /** абсолютные пути готовых файлов */
  outputFile?: string;
  cleanFile?: string;
  /** id проекта редактора, созданного из готового видео (итерации) */
  projectId?: string;
  /** сегменты склейки по порядку (после тримов, с ендкардом) — границы клипов */
  segments?: { name: string; durMs: number }[];
  clipCount?: number;
  /** длительность монтажа БЕЗ ендкарда (для отсечки аудио перед Deepgram) */
  clipsDurationMs?: number;
  /** полная длительность с ендкардом */
  durationMs?: number;
};

export type Batch = {
  id: string;
  name: string;
  createdAt: string;
  /** снапшот пресета на момент создания — правки пресета не влияют на батч */
  preset: BatchPreset;
  outputDir: string;
  /** legacy: раньше «чистые» дубли лежали в общей папке; теперь всё в папке видоса */
  cleanDir?: string;
  paused: boolean;
  items: BatchItem[];
};

export function defaultPreset(): Omit<BatchPreset, "id" | "name" | "createdAt"> {
  return {
    language: "auto",
    captions: true,
    captionsFromMusic: false,
    trimSilence: false,
    styleId: "hormozi",
    overrides: { fontFamily: "Gilroy" },
    disclaimer: null,
    musicTrackId: null,
    musicVolume: 0.3,
    endcardId: null,
    endcardDurationMs: 3000,
    cleanCopy: true,
    maxSizeMb: 30,
  };
}
