export type Word = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  /** стиль отрезка: если задан, слова с этим стилем рисуются им вместо стиля проекта */
  style?: WordStyle | null;
};

/** Пер-сегментный стиль: пресет + правки, привязанные к конкретным словам */
export type WordStyle = {
  styleId: string;
  overrides: StyleOverrides;
};

export type CaptionPage = {
  words: Word[];
  startMs: number;
  endMs: number;
  /** стиль отрезка (общий для всех слов страницы) или null = стиль проекта */
  style?: WordStyle | null;
};

export type CaptionMode =
  | "plain" // вся страница видна, без выделения активного слова
  | "highlight-color" // активное слово меняет цвет
  | "highlight-box" // активное слово в цветной плашке
  | "karaoke" // произнесённые слова яркие, будущие приглушены
  | "appear" // слова появляются по мере произнесения и остаются
  | "one-word" // по одному слову за раз
  | "design"; // журнальная вёрстка: слова в столбик, разные шрифты и размеры

export type CaptionAnimation = "none" | "pop" | "fade" | "slide-up";

/** Анимация появления слова в режиме design (момент = startMs слова) */
export type DesignWordAnim =
  | "pop" // пружинное увеличение
  | "stamp" // «штамп»: влетает большим и припечатывается
  | "whip" // вылет слева с раскруткой
  | "slide-left" // въезд слева
  | "slide-right" // въезд справа
  | "rise" // подъём снизу
  | "blur" // проявление из расфокуса
  | "tracking" // буквы съезжаются из разрядки
  | "flip"; // 3D-переворот по горизонтальной оси

/** Вариант оформления слова в режиме design (назначается по индексу по кругу) */
export type DesignWordVariant = {
  sizeMult: number;
  font?: string;
  weight?: number;
  color?: string;
  italic?: boolean;
  caps?: boolean;
  rotate?: number;
  /** плашка за словом */
  bg?: string;
  /** межбуквенный интервал в em */
  ls?: number;
  /** анимация появления слова */
  anim?: DesignWordAnim;
};

export type CaptionStyle = {
  id: string;
  name: string;
  /** ключ встроенного шрифта (см. remotion/fonts.ts) или имя системного */
  fontFamily: string;
  fontWeight: number;
  /** размер шрифта как доля ширины кадра */
  fontSizeRatio: number;
  uppercase: boolean;
  textColor: string;
  highlightColor: string;
  mode: CaptionMode;
  /** плашка за всей строкой */
  lineBackground: string | null;
  strokeRatio: number; // обводка как доля размера шрифта (0 = нет)
  strokeColor: string;
  shadow: string | null;
  maxWordsPerPage: number;
  animation: CaptionAnimation;
  /** вертикальная позиция центра строки, 0 = верх, 1 = низ */
  positionY: number;
  /** градиентная заливка текста (CSS-градиент); отключает textColor и обводку */
  gradient?: string | null;
  /** цвета слов по кругу (стиль MrBeast) */
  colorCycle?: string[] | null;
  /** масштаб активного слова, 1 = без эффекта */
  activeScale?: number;
  /** наклон плашки активного слова в градусах (стиль «маркер») */
  boxRotate?: number;
  /** межбуквенный интервал в em */
  letterSpacingEm?: number;
  /** варианты оформления слов для режима design */
  designWords?: DesignWordVariant[];
};

export type StyleOverrides = Partial<
  Pick<
    CaptionStyle,
    | "fontFamily"
    | "fontSizeRatio"
    | "uppercase"
    | "textColor"
    | "highlightColor"
    | "maxWordsPerPage"
    | "positionY"
  >
>;

export type ProjectStatus =
  | "uploaded"
  | "transcribing"
  | "ready"
  | "rendering"
  | "done"
  | "error";

export type VideoMeta = {
  fileName: string; // имя файла в workspace/uploads
  originalName: string;
  width: number;
  height: number;
  durationMs: number;
  fps: number;
};

/** Клип на таймлайне монтажа. Позиция не хранится: клипы идут встык по порядку массива. */
export type TimelineClip = {
  id: string;
  kind: "video" | "image";
  fileName: string; // имя файла в workspace/uploads
  originalName: string;
  /** длительность исходника; для image — условная (trim out можно тянуть дальше) */
  sourceDurationMs: number;
  inMs: number; // трим от начала исходника
  outMs: number; // трим-конец (по исходнику)
  width: number;
  height: number;
  /** есть ли аудиодорожка в исходнике */
  hasAudio: boolean;
  /** масштаб кадра: 1 = вписан в канвас, >1 = приближение (края обрезаются) */
  zoom?: number;
  /** сдвиг кадра по горизонтали, доля ширины канваса (-0.5..0.5) */
  panX?: number;
  /** сдвиг кадра по вертикали, доля высоты канваса */
  panY?: number;
};

/** Дисклеймер: мелкий текст поверх всего видео на всю длительность */
export type Disclaimer = {
  text: string;
  /** размер шрифта как доля ширины кадра */
  sizeRatio: number;
  /** вертикальная позиция центра текста, 0 = верх, 1 = низ */
  positionY: number;
};

/**
 * Текст-плашка (стиль TikTok): чёрный текст на белом скруглённом
 * прямоугольнике. По горизонтали всегда центрирована.
 */
export type TextOverlay = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  /** центр плашки по вертикали, доля высоты кадра (0..1) */
  y: number;
  /** размер шрифта как доля ширины кадра */
  sizeRatio: number;
};

/** Музыка проекта: ссылка на трек из библиотеки */
export type ProjectMusic = {
  trackId: string;
  fileName: string; // имя файла в workspace/music
  name: string;
  volume: number; // 0..1
};

/** Трек в библиотеке музыки (workspace/music/library.json) */
export type MusicTrack = {
  id: string;
  name: string;
  fileName: string;
  durationMs: number;
  addedAt: string;
};

/** Привязка проекта к батчу: куда класть итерации и какой лимит размера */
export type ProjectBatchRef = {
  /** папка видоса (outputDir батча / имя архива) */
  outputDir: string;
  /** лимит размера готового файла в МБ (0 = без лимита) */
  maxSizeMb: number;
};

/**
 * Итерация: выбранные клипы дублируются в НАЧАЛО видео как хук (вместе с
 * их субтитрами), дальше видео идёт своим чередом. Каждая итерация — свой
 * рендер в папку видоса: <назва>_it<num>.mp4.
 */
export type Iteration = {
  id: string;
  /** порядковый номер → имя файла */
  num: number;
  /** id клипов проекта в порядке выбора */
  clipIds: string[];
  status: "queued" | "rendering" | "done" | "error";
  progress: number; // 0..1
  /** абсолютный путь готового файла */
  file?: string;
  error?: string;
  createdAt: string;
};

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  status: ProjectStatus;
  error?: string;
  language: string; // 'auto' | 'uk' | 'ru' | 'en' | ...
  video: VideoMeta;
  words: Word[] | null;
  styleId: string;
  overrides: StyleOverrides;
  /**
   * Клипы монтажа. Если нет — классический проект из одного файла (video).
   * Если есть — таймлайн собирается из них встык, video хранит канвас (w/h/fps)
   * и суммарную длительность.
   */
  clips?: TimelineClip[] | null;
  music?: ProjectMusic | null;
  disclaimer?: Disclaimer | null;
  /** текст-плашки в стиле TikTok */
  overlays?: TextOverlay[] | null;
  renderFile?: string; // имя файла в workspace/renders
  renderProgress?: number;
  /** проект создан из батча: итерации кладём в его папку с его лимитом */
  batchRef?: ProjectBatchRef | null;
  /** итерации-хуки (управляются сервером, не через PATCH) */
  iterations?: Iteration[] | null;
};

/** Длительность клипа на таймлайне */
export function clipDurationMs(c: TimelineClip): number {
  return Math.max(c.outMs - c.inMs, 0);
}

/** Суммарная длительность монтажа */
export function totalClipsDurationMs(clips: TimelineClip[]): number {
  return clips.reduce((sum, c) => sum + clipDurationMs(c), 0);
}

export type CaptionInputProps = {
  videoSrc: string;
  words: Word[];
  styleId: string;
  overrides: StyleOverrides;
  width: number;
  height: number;
  durationMs: number;
  /** превью монтажа: клипы встык вместо videoSrc (финальный рендер получает склейку) */
  clips?: {
    src: string;
    kind: "video" | "image";
    inMs: number;
    outMs: number;
    /** для «продления кадра»: где кончается реальное видео */
    sourceDurationMs?: number;
    zoom?: number;
    panX?: number;
    panY?: number;
  }[];
  /** превью музыки */
  musicSrc?: string | null;
  musicVolume?: number;
  disclaimer?: Disclaimer | null;
  overlays?: TextOverlay[] | null;
};
