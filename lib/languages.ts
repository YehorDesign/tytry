// Языки перевода/субтитров. Только чистые данные — файл импортируется и клиентом.
// code — язык Deepgram, heygen — имя языка для HeyGen video-translate.
export type TranslateLanguage = {
  code: string;
  heygen: string;
  /** запасное имя языка для HeyGen: у части языков в их списке есть регион */
  heygenAlt?: string;
  /** модель Deepgram, если nova-2 этот язык не умеет */
  asrModel?: string;
  /** самоназвание — понятно без перевода интерфейса */
  label: string;
  flag: string;
  /** письмо справа налево */
  rtl?: boolean;
};

export const TRANSLATE_LANGUAGES: TranslateLanguage[] = [
  { code: "en", heygen: "English", label: "English", flag: "🇬🇧" },
  { code: "es", heygen: "Spanish", label: "Español", flag: "🇪🇸" },
  { code: "de", heygen: "German", label: "Deutsch", flag: "🇩🇪" },
  { code: "fr", heygen: "French", label: "Français", flag: "🇫🇷" },
  { code: "it", heygen: "Italian", label: "Italiano", flag: "🇮🇹" },
  { code: "pt", heygen: "Portuguese", label: "Português", flag: "🇵🇹" },
  { code: "pl", heygen: "Polish", label: "Polski", flag: "🇵🇱" },
  { code: "nl", heygen: "Dutch", label: "Nederlands", flag: "🇳🇱" },
  { code: "tr", heygen: "Turkish", label: "Türkçe", flag: "🇹🇷" },
  { code: "ja", heygen: "Japanese", label: "日本語", flag: "🇯🇵" },
  { code: "ko", heygen: "Korean", heygenAlt: "Korean (Korea)", label: "한국어", flag: "🇰🇷" },
  { code: "cs", heygen: "Czech", heygenAlt: "Czech (Czechia)", label: "Čeština", flag: "🇨🇿" },
  {
    code: "ro",
    heygen: "Romanian",
    heygenAlt: "Romanian (Romania)",
    label: "Română",
    flag: "🇷🇴",
  },
  {
    // иврит: nova-2 его не знает — нужна nova-3; текст справа налево
    code: "he",
    heygen: "Hebrew",
    heygenAlt: "Hebrew (Israel)",
    asrModel: "nova-3",
    label: "עברית",
    flag: "🇮🇱",
    rtl: true,
  },
  { code: "hi", heygen: "Hindi", label: "हिन्दी", flag: "🇮🇳" },
  { code: "id", heygen: "Indonesian", label: "Indonesia", flag: "🇮🇩" },
];

export function translateLanguage(code: string): TranslateLanguage | null {
  return TRANSLATE_LANGUAGES.find((l) => l.code === code) ?? null;
}

/** Модель Deepgram для языка распознавания (nova-2 покрывает всё, кроме иврита). */
export function asrModelFor(language: string): string {
  return translateLanguage(language)?.asrModel ?? "nova-2";
}
