import fs from "node:fs";
import { createClient } from "@deepgram/sdk";
import { getDeepgramKey } from "./settings";
import type { Word } from "./types";

/**
 * Транскрибация аудиофайла через Deepgram с word-level таймингами.
 * nova-2 поддерживает украинский, русский, английский и ещё ~30 языков,
 * а также автоопределение языка (detect_language).
 */
export async function transcribeAudio(
  audioPath: string,
  language: string
): Promise<Word[]> {
  const apiKey = getDeepgramKey();
  if (!apiKey) {
    throw new Error("Deepgram key is not set — add it in Settings (⚙ button)");
  }

  const deepgram = createClient(apiKey);
  const buffer = fs.readFileSync(audioPath);

  const options: Record<string, unknown> = {
    model: "nova-2",
    smart_format: true,
    punctuate: true,
  };
  if (language === "auto") {
    options.detect_language = true;
  } else {
    options.language = language;
  }

  const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
    buffer,
    options
  );
  if (error) throw new Error(`Deepgram: ${error.message}`);

  const words = result?.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
  return words.map((w, i) => ({
    id: `w${i}-${Math.round(w.start * 1000)}`,
    text: (w.punctuated_word ?? w.word ?? "").trim(),
    startMs: Math.round(w.start * 1000),
    endMs: Math.round(w.end * 1000),
  }));
}
