// «Прибрати тишу»: тримы тишины по краям КАЖДОГО клипа по таймингам слов.
// Внутри клипа ничего не вырезаем — только его начало и конец. Клипы без
// речи (ендкард, дисклеймер, б-ролл) не трогаем вовсе.
// Только чистые функции — файл импортируется и клиентом, и батч-воркером.
import type { Word } from "./types";

export type SilenceTrim = { lead: number; tail: number };

const PAD = 150; // запас, чтобы речь не начиналась/обрывалась впритык
const MIN_CLIP_LEFT = 200; // от клипа должно остаться хоть что-то
// тайминги Deepgram гуляют на ~100-300мс: слово, чуть «заехавшее» за границу
// клипа, не должно превращать беззвучный клип в «клип с речью»
const EDGE_SLOP = 300;
const MIN_TRIM = 100; // тримы короче не применяем — не стоят возни

/**
 * Тримы тишины для каждого клипа. durations — длительности клипов на
 * таймлайне (по порядку), words — тайминги слов по этому же таймлайну.
 * Слово «принадлежит» клипу, если лежит в нём целиком или пересекает его
 * хотя бы на EDGE_SLOP (защита от слов, заехавших за границу).
 */
export function computeClipTrims(durations: number[], words: Word[]): SilenceTrim[] {
  const trims: SilenceTrim[] = durations.map(() => ({ lead: 0, tail: 0 }));
  if (words.length === 0) return trims;

  let start = 0;
  for (let i = 0; i < durations.length; i++) {
    const dur = durations[i];
    const end = start + dur;
    let first = Infinity;
    let last = -Infinity;
    for (const w of words) {
      const overlap = Math.min(w.endMs, end) - Math.max(w.startMs, start);
      const need = Math.min(EDGE_SLOP, Math.max(w.endMs - w.startMs, 1));
      if (overlap >= need) {
        if (w.startMs < first) first = w.startMs;
        if (w.endMs > last) last = w.endMs;
      }
    }
    if (first !== Infinity && dur > MIN_CLIP_LEFT) {
      let lead = Math.max(Math.min(first - PAD - start, dur - MIN_CLIP_LEFT), 0);
      let tail = Math.max(Math.min(end - (last + PAD), dur - MIN_CLIP_LEFT - lead), 0);
      if (lead < MIN_TRIM) lead = 0;
      if (tail < MIN_TRIM) tail = 0;
      trims[i] = { lead: Math.round(lead), tail: Math.round(tail) };
    }
    start = end;
  }
  return trims;
}

export function totalTrimMs(trims: SilenceTrim[]): number {
  return trims.reduce((s, t) => s + t.lead + t.tail, 0);
}

/** Сколько клипов реально подрезано. */
export function trimmedClipCount(trims: SilenceTrim[]): number {
  return trims.filter((t) => t.lead + t.tail > 0).length;
}

const MIN_SHIFTED_MS = 40; // защита от нулевой длительности после сдвига

/**
 * Сдвигает слова так, чтобы после применения тримов они остались на своей
 * речи: из тайминга слова вычитается суммарная длина вырезок ДО него.
 */
export function shiftWordsByTrims(
  words: Word[],
  durations: number[],
  trims: SilenceTrim[]
): Word[] {
  // точки вырезки на исходном таймлайне: лид — в начале клипа, хвост — в конце
  const cuts: { at: number; amount: number }[] = [];
  let start = 0;
  for (let i = 0; i < durations.length; i++) {
    const t = trims[i];
    if (t?.lead) cuts.push({ at: start, amount: t.lead });
    if (t?.tail) cuts.push({ at: start + durations[i] - t.tail, amount: t.tail });
    start += durations[i];
  }
  if (cuts.length === 0) return words;

  const shiftAt = (ms: number) => {
    let shift = 0;
    for (const c of cuts) if (c.at <= ms) shift += c.amount;
    return shift;
  };
  return words.map((w) => {
    const shift = shiftAt(w.startMs);
    const startMs = Math.max(w.startMs - shift, 0);
    return {
      ...w,
      startMs,
      endMs: Math.max(w.endMs - shift, startMs + MIN_SHIFTED_MS),
    };
  });
}
