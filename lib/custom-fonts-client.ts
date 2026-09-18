"use client";
// Свои шрифты юзера в браузере: файл из workspace/fonts грузится через
// FontFace под тем же именем семейства, под которым его регистрирует нативный
// рендер (lib/render-native/fonts.ts) — поэтому превью и рендер совпадают.
// weight "100 900": один файл обслуживает любой запрошенный вес, иначе
// браузер дорисует искусственный жир, которого в рендере не будет.

export type CustomFontInfo = {
  id: string;
  family: string;
  originalName: string;
  url: string;
};

const loading = new Map<string, Promise<void>>();

export function loadCustomFontFaces(fonts: CustomFontInfo[]): Promise<void[]> {
  if (typeof document === "undefined" || typeof FontFace === "undefined") {
    return Promise.resolve([]);
  }
  return Promise.all(
    fonts.map((font) => {
      const cached = loading.get(font.family);
      if (cached) return cached;
      const task = new FontFace(font.family, `url("${font.url}")`, {
        weight: "100 900",
      })
        .load()
        .then((face) => {
          document.fonts.add(face);
        })
        .catch(() => {
          // битый файл — пусть остаётся системный фолбэк, но дадим повторить
          loading.delete(font.family);
        });
      loading.set(font.family, task);
      return task;
    })
  );
}

/** Список шрифтов для UI; свои попутно грузятся в документ. */
export async function fetchFonts(): Promise<{
  fonts: string[];
  custom: CustomFontInfo[];
}> {
  const res = await fetch("/api/fonts");
  const data = (await res.json()) as { fonts?: string[]; custom?: CustomFontInfo[] };
  const custom = data.custom ?? [];
  void loadCustomFontFaces(custom);
  return { fonts: data.fonts ?? [], custom };
}
