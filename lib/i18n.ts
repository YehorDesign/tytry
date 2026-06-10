export type Locale = "uk" | "en";

const en = {
  // topbar
  addVideos: "+ Add videos",
  uploading: "Uploading…",
  renderAll: "⚡ Render all",
  settingsTitle: "Settings",
  speechLanguage: "Speech language",
  langAuto: "Auto-detect",
  langUk: "Українська",
  langEn: "English",

  // rail
  videos: "Videos",
  railEmpty: "Nothing here yet. Drop videos into the window or click “Add videos”.",
  deleteProjectTitle: "Delete project",

  // statuses
  statusUploaded: "Uploaded",
  statusTranscribing: "Transcribing…",
  statusReady: "Ready to render",
  statusRendering: "Rendering…",
  statusDone: "Rendered",
  statusError: "Error",
  renderPct: (pct: number) => `Rendering ${pct}%`,

  // stage
  dropTitle: "Drop videos here",
  dropHint: "Batch upload supported: mp4, mov, webm, mkv.\nSpeech is transcribed automatically after upload.",
  chooseFiles: "Choose files",

  // tabs
  tabStyle: "Style",
  tabText: "Text",

  // style panel
  presets: "Presets",
  adjustments: "Adjustments",
  font: "Font",
  builtinFonts: "Built-in",
  systemFonts: "System",
  size: "Size",
  position: "Position",
  wordsPerPage: "Words on screen",
  textColor: "Text color",
  accentColor: "Accent color",
  uppercase: "UPPERCASE",
  resetAdjustments: "↺ Reset adjustments",
  sampleText: "Sample text",

  // editor
  editorHint: "Click a word to fix it. An emptied word gets deleted. Click a timestamp to jump there.",
  noCaptions: "No captions yet. Click “Transcribe speech” to extract text from the audio.",
  transcribingHint: "⏳ Transcribing speech with Deepgram…",

  // timeline
  timelineHint: "Drag a block to move it · drag its edges to stretch",

  // actions
  renderVideo: "🎬 Render video",
  rendering: "Rendering…",
  downloadResult: "⬇ Download result",
  showInFolder: "📂 Show in folder",
  transcribe: "🎙 Transcribe speech",
  retranscribe: "↻ Transcribe again",
  deleteProject: "Delete project",
  confirmDelete: "Delete this project and all its files?",

  // right panel empty
  howItWorks: "How it works",
  howItWorksText:
    "1. Upload one or more videos.\n2. Deepgram transcribes speech with per-word timings.\n3. Pick a caption style and fix the text.\n4. Hit “Render” — Remotion burns the captions into the video.",

  // settings modal
  deepgramKey: "Deepgram API key",
  keySet: "Key is set:",
  keyMissing: "No key — speech recognition will not work.",
  keyPlaceholder: "Paste your Deepgram key",
  keyReplacePlaceholder: "Paste a new key to replace",
  keyHintPrefix: "Free key:",
  keyHintSuffix: "→ Create API Key. Stored locally on this computer.",
  outputFolder: "Output folder",
  outputFolderPlaceholder: "Default: workspace/renders inside the app",
  browse: "Browse…",
  close: "Close",
  save: "Save",
  saving: "Saving…",
  uiLanguage: "Interface language",

  // style names
  styleNames: {} as Record<string, string>,
};

export type Dict = typeof en;

const uk: Dict = {
  addVideos: "+ Додати відео",
  uploading: "Завантаження…",
  renderAll: "⚡ Рендер усіх",
  settingsTitle: "Налаштування",
  speechLanguage: "Мова мовлення",
  langAuto: "Авто",
  langUk: "Українська",
  langEn: "English",

  videos: "Відео",
  railEmpty: "Поки порожньо. Перетягни відео у вікно або натисни «Додати відео».",
  deleteProjectTitle: "Видалити проєкт",

  statusUploaded: "Завантажено",
  statusTranscribing: "Розпізнаємо…",
  statusReady: "Готово до рендеру",
  statusRendering: "Рендер…",
  statusDone: "Відрендерено",
  statusError: "Помилка",
  renderPct: (pct: number) => `Рендер ${pct}%`,

  dropTitle: "Перетягни відео сюди",
  dropHint: "Можна пачкою: mp4, mov, webm, mkv.\nПісля завантаження мова розпізнається автоматично.",
  chooseFiles: "Обрати файли",

  tabStyle: "Стиль",
  tabText: "Текст",

  presets: "Пресети",
  adjustments: "Налаштування",
  font: "Шрифт",
  builtinFonts: "Вбудовані",
  systemFonts: "Системні",
  size: "Розмір",
  position: "Позиція",
  wordsPerPage: "Слів на екрані",
  textColor: "Колір тексту",
  accentColor: "Колір акценту",
  uppercase: "ВЕЛИКИМИ",
  resetAdjustments: "↺ Скинути налаштування",
  sampleText: "Приклад тексту",

  editorHint: "Клацни слово, щоб виправити. Порожнє слово видаляється. Клік по таймкоду — перехід у плеєрі.",
  noCaptions: "Субтитрів поки немає. Натисни «Розпізнати мову», щоб отримати текст з аудіо.",
  transcribingHint: "⏳ Розпізнаємо мову через Deepgram…",

  timelineHint: "Тягни блок, щоб посунути · тягни за край, щоб розтягнути",

  renderVideo: "🎬 Рендер відео",
  rendering: "Рендеримо…",
  downloadResult: "⬇ Завантажити результат",
  showInFolder: "📂 Показати в папці",
  transcribe: "🎙 Розпізнати мову",
  retranscribe: "↻ Розпізнати заново",
  deleteProject: "Видалити проєкт",
  confirmDelete: "Видалити цей проєкт і всі його файли?",

  howItWorks: "Як це працює",
  howItWorksText:
    "1. Завантаж одне або кілька відео.\n2. Deepgram розпізнає мову з таймінгами по словах.\n3. Обери стиль субтитрів і поправ текст.\n4. Натисни «Рендер» — Remotion вшиє субтитри у відео.",

  deepgramKey: "Deepgram API key",
  keySet: "Ключ встановлено:",
  keyMissing: "Ключ не задано — розпізнавання мови не працюватиме.",
  keyPlaceholder: "Встав ключ Deepgram",
  keyReplacePlaceholder: "Встав новий ключ, щоб замінити",
  keyHintPrefix: "Безкоштовний ключ:",
  keyHintSuffix: "→ Create API Key. Зберігається локально на цьому компʼютері.",
  outputFolder: "Папка збереження",
  outputFolderPlaceholder: "За замовчуванням: workspace/renders усередині застосунку",
  browse: "Огляд…",
  close: "Закрити",
  save: "Зберегти",
  saving: "Зберігаємо…",
  uiLanguage: "Мова інтерфейсу",

  styleNames: {
    classic: "Класика",
    hormozi: "Підсвітка",
    wordbox: "Плашка-слово",
    boxed: "Підкладка",
    oneword: "По слову",
    karaoke: "Караоке",
    beast: "Біст",
    neon: "Неон",
    marker: "Маркер",
    gradient: "Градієнт",
    bubble: "Комікс",
    retro3d: "Ретро 3D",
    typewriter: "Друк",
    opus: "Опус",
    minimal: "Мінімал",
  },
};

export const STRINGS: Record<Locale, Dict> = { en, uk };

export function getLocale(): Locale {
  if (typeof window === "undefined") return "uk";
  const saved = window.localStorage.getItem("tytry-locale");
  return saved === "en" ? "en" : "uk";
}

export function setLocale(locale: Locale) {
  window.localStorage.setItem("tytry-locale", locale);
}
