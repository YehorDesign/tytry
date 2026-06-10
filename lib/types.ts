export type Word = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
};

export type CaptionPage = {
  words: Word[];
  startMs: number;
  endMs: number;
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
  renderFile?: string; // имя файла в workspace/renders
  renderProgress?: number;
};

export type CaptionInputProps = {
  videoSrc: string;
  words: Word[];
  styleId: string;
  overrides: StyleOverrides;
  width: number;
  height: number;
  durationMs: number;
};
