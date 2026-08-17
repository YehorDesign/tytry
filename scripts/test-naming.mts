/**
 * Имена файлов рендера + «∞ слов на экране».
 * Запуск: npx tsx scripts/test-naming.mts
 */
import { sanitizeFileName } from "../lib/filename";
import { groupWordsIntoPages } from "../lib/captions";
import { WORDS_SLIDER_MAX, WORDS_UNLIMITED, sanitizeOverrides } from "../lib/styles";
import type { Word } from "../lib/types";

let failed = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` → ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`}`);
}

// ── имена не переименовываются ──
eq(sanitizeFileName("CR-29880 hook 3"), "CR-29880 hook 3", "пробелы и дефисы сохраняются");
eq(sanitizeFileName("Тест відео (1).final"), "Тест відео (1).final", "кириллица, скобки, точка внутри");
eq(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j'), "a_b_c_d_e_f_g_h_i_j", "запрещённые символы → _");
eq(sanitizeFileName("  двойные   пробелы  "), "двойные пробелы", "схлопывание и обрезка пробелов");
eq(sanitizeFileName("имя."), "имя", "точка в конце убирается (Windows)");
eq(sanitizeFileName("CON"), "_CON", "зарезервированное имя устройства");
eq(sanitizeFileName("x".repeat(200)).length, 120, "обрезка по длине");
eq(
  sanitizeFileName("608_N1_FF_AD_Check_Brain_Sens_AIUGC_R_Ani_A_Lost_197_max_KB_EK_Meta_9x16"),
  "608_N1_FF_AD_Check_Brain_Sens_AIUGC_R_Ani_A_Lost_197_max_KB_EK_Meta_9x16",
  "реальное имя креатива не обрезается (было 60 символов)"
);

// ── ∞ слов на экране ──
eq(sanitizeOverrides({ maxWordsPerPage: 999 }).maxWordsPerPage, 999, "999 проходит sanitize (было 12)");
eq(sanitizeOverrides({ maxWordsPerPage: 5000 }).maxWordsPerPage, WORDS_UNLIMITED, "клампится до ∞");

// 24 слова подряд по 400 мс без пауз, с точками в середине
const words: Word[] = Array.from({ length: 24 }, (_, i) => ({
  id: `w${i}`,
  text: i % 6 === 5 ? `сл${i}.` : `сл${i}`,
  startMs: i * 400,
  endMs: i * 400 + 350,
}));

const p8 = groupWordsIntoPages(words, 8);
eq(p8.every((p) => p.words.length <= 8), true, "лимит 8 соблюдается");
eq(p8.length > 3, true, `при 8 страниц много (${p8.length})`);

const pInf = groupWordsIntoPages(words, WORDS_UNLIMITED);
eq(pInf.length, 1, `при ∞ все 24 слова на одной странице (страниц: ${pInf.length})`);
eq(pInf[0].words.length, 24, "все слова попали на страницу");

// пауза всё ещё режет страницу даже при ∞
const withGap: Word[] = [
  ...words.slice(0, 5),
  ...words.slice(5).map((w) => ({ ...w, startMs: w.startMs + 2000, endMs: w.endMs + 2000 })),
];
eq(groupWordsIntoPages(withGap, WORDS_UNLIMITED).length, 2, "пауза >900мс режет страницу и при ∞");

// точка в конце фразы всё ещё режет страницу (не ∞): по 6 слов
eq(
  groupWordsIntoPages(words, WORDS_SLIDER_MAX).map((p) => p.words.length),
  [6, 6, 6, 6],
  "конец предложения режет страницу при конечном лимите"
);

// промежуточные значения: 5-секундный лимит страницы больше не рубит раньше лимита слов
const plain: Word[] = words.map((w) => ({ ...w, text: w.text.replace(".", "") }));
eq(groupWordsIntoPages(plain, 8).map((p) => p.words.length), [8, 8, 8], "8 слов — как раньше");
eq(
  groupWordsIntoPages(plain, WORDS_SLIDER_MAX).map((p) => p.words.length),
  [20, 4],
  "20 слов — страница живёт дольше 5с"
);

console.log(failed === 0 ? "\nВСЁ ОК" : `\nПРОВАЛЕНО: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
