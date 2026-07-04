import { resolveStyle } from "./styles";
import type { CaptionPage, Word, WordStyle } from "./types";

const MAX_GAP_MS = 900; // пауза, после которой начинается новая страница
const MAX_PAGE_DURATION_MS = 5000;
const LINGER_MS = 250; // страница держится чуть дольше последнего слова

/** Ключ сегментного стиля слова: одинаковый ключ ⇒ слова могут жить на одной странице */
export function wordStyleKey(w: Word): string {
  if (!w.style) return "";
  return `${w.style.styleId}|${JSON.stringify(w.style.overrides ?? {})}`;
}

/**
 * Группирует слова в страницы субтитров. Используется одинаково
 * в редакторе, превью-плеере и при финальном рендере.
 * Слова с сегментным стилем не смешиваются на странице со словами
 * другого стиля; лимит слов берётся из стиля сегмента.
 */
export function groupWordsIntoPages(
  words: Word[],
  maxWordsPerPage: number
): CaptionPage[] {
  const pages: CaptionPage[] = [];
  let current: Word[] = [];
  // после перетаскивания на таймлайне порядок в массиве может разойтись со временем
  const sorted = [...words].sort((a, b) => a.startMs - b.startMs);

  const maxWordsFor = (style: WordStyle | null | undefined): number =>
    style ? resolveStyle(style.styleId, style.overrides ?? {}).maxWordsPerPage : maxWordsPerPage;

  const flush = () => {
    if (current.length === 0) return;
    pages.push({
      words: current,
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
      style: current[0].style ?? null,
    });
    current = [];
  };

  for (const word of sorted) {
    if (!word.text.trim()) continue;
    if (current.length > 0) {
      const prev = current[current.length - 1];
      const gap = word.startMs - prev.endMs;
      const pageDuration = word.endMs - current[0].startMs;
      const endsSentence = /[.!?…]$/.test(prev.text.trim());
      if (
        current.length >= maxWordsFor(current[0].style) ||
        gap > MAX_GAP_MS ||
        pageDuration > MAX_PAGE_DURATION_MS ||
        endsSentence ||
        wordStyleKey(word) !== wordStyleKey(current[0])
      ) {
        flush();
      }
    }
    current.push(word);
  }
  flush();

  // Растягиваем конец страницы до начала следующей (если пауза короткая),
  // чтобы субтитры не мигали между страницами.
  for (let i = 0; i < pages.length; i++) {
    const next = pages[i + 1];
    if (next && next.startMs - pages[i].endMs < MAX_GAP_MS) {
      pages[i].endMs = next.startMs;
    } else {
      pages[i].endMs += LINGER_MS;
    }
  }

  return pages;
}

export function findActivePage(
  pages: CaptionPage[],
  ms: number
): CaptionPage | null {
  for (const page of pages) {
    if (ms >= page.startMs && ms < page.endMs) return page;
  }
  return null;
}

/** Индекс активного слова на странице (последнее начавшееся). */
export function findActiveWordIndex(page: CaptionPage, ms: number): number {
  let active = -1;
  for (let i = 0; i < page.words.length; i++) {
    if (ms >= page.words[i].startMs) active = i;
  }
  return Math.max(active, 0);
}

export function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const d = Math.floor((ms % 1000) / 100);
  return `${m}:${String(s).padStart(2, "0")}.${d}`;
}
