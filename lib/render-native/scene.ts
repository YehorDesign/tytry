// Нативная отрисовка кадра субтитров — порт remotion/CaptionedVideo.tsx на
// skia-canvas (@napi-rs/canvas). Раскладка и анимации повторяют DOM-версию,
// чтобы рендер совпадал с превью в плеере.
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { easeOutCubic, interpolate, spring } from "../anim";
import { findActivePage, findActiveWordIndex, groupWordsIntoPages } from "../captions";
import { resolveStyle } from "../styles";
import type {
  CaptionPage,
  CaptionStyle,
  DesignWordAnim,
  DesignWordVariant,
  StyleOverrides,
  Word,
} from "../types";
import { parseLinearGradient, parseTextShadow, type ParsedShadow } from "./cssparse";
import { fontString } from "./fonts";

export type SceneOptions = {
  words: Word[];
  styleId: string;
  overrides: StyleOverrides;
  width: number;
  height: number;
  fps: number;
};

export type Scene = {
  /** Ключ визуального состояния кадра: одинаковый ключ ⇒ одинаковая картинка. */
  frameKey(frame: number): string;
  /** Рисует кадр (канвас уже очищен). offsetY — сдвиг вверх при рендере полосой. */
  drawFrame(ctx: SKRSContext2D, frame: number, offsetY?: number): boolean;
  /**
   * Вертикальная полоса кадра, где могут появиться субтитры (с запасом на
   * анимации/тени). Рендерим и гоним в ffmpeg только её — меньше байтов в пайп.
   */
  verticalBand(): { top: number; height: number };
};

// ── метрики шрифтов ──

type FontMetrics = { ascent: number; descent: number };
const metricsCache = new Map<string, FontMetrics>();

function fontMetrics(ctx: SKRSContext2D, font: string, sizePx: number): FontMetrics {
  const cached = metricsCache.get(font);
  if (cached) return cached;
  ctx.font = font;
  const m = ctx.measureText("Mgй");
  const ascent = m.fontBoundingBoxAscent || sizePx * 0.8;
  const descent = m.fontBoundingBoxDescent || sizePx * 0.25;
  const out = { ascent, descent };
  metricsCache.set(font, out);
  return out;
}

// ── помощники отрисовки ──

function roundRectPath(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/**
 * Тени канваса живут в экранных координатах (не проходят через transform),
 * поэтому смещения/размытие приводим через текущую матрицу.
 */
function setShadowDeviceSpace(ctx: SKRSContext2D, sh: ParsedShadow) {
  const m = ctx.getTransform();
  ctx.shadowOffsetX = m.a * sh.offsetX + m.c * sh.offsetY;
  ctx.shadowOffsetY = m.b * sh.offsetX + m.d * sh.offsetY;
  const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  ctx.shadowBlur = sh.blur * scale;
  ctx.shadowColor = sh.color;
}

function clearShadow(ctx: SKRSContext2D) {
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

type TextPaint = {
  text: string;
  x: number; // левый край
  baseline: number;
  font: string;
  letterSpacingPx: number;
  fill: string | CanvasGradient;
  shadows: ParsedShadow[];
  strokeWidth: number;
  strokeColor: string;
};

function paintText(ctx: SKRSContext2D, p: TextPaint) {
  ctx.font = p.font;
  ctx.letterSpacing = `${p.letterSpacingPx}px`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // тени: CSS рисует их за текстом, первая в списке — сверху
  for (let i = p.shadows.length - 1; i >= 0; i--) {
    ctx.save();
    setShadowDeviceSpace(ctx, p.shadows[i]);
    ctx.fillStyle = typeof p.fill === "string" ? p.fill : "#000";
    ctx.fillText(p.text, p.x, p.baseline);
    ctx.restore();
  }
  clearShadow(ctx);

  if (p.strokeWidth > 0) {
    ctx.lineWidth = p.strokeWidth;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeStyle = p.strokeColor;
    ctx.strokeText(p.text, p.x, p.baseline);
  }
  ctx.fillStyle = p.fill;
  ctx.fillText(p.text, p.x, p.baseline);
  ctx.letterSpacing = "0px";
}

// ── входные анимации design-слов (порт designEnter) ──

type DesignEnter = {
  tx: number;
  ty: number;
  scaleX: number;
  scaleY: number;
  rotDeg: number;
  opacity: number;
  blurPx: number;
  lsExtraEm: number;
};

const DESIGN_SETTLE_FRAMES = 16; // после этого кадра все анимации закончены

function designEnter(
  anim: DesignWordAnim,
  f: number,
  fps: number,
  sizePx: number
): DesignEnter {
  const none: DesignEnter = {
    tx: 0, ty: 0, scaleX: 1, scaleY: 1, rotDeg: 0, opacity: 1, blurPx: 0, lsExtraEm: 0,
  };
  if (f < 0) return { ...none, opacity: 0 };

  const fadeIn = (frames: number) =>
    interpolate(f, [0, frames], [0, 1], { clampRight: true });
  const sp = (config: { damping: number; stiffness: number; mass?: number }, dur = 12) =>
    spring({ frame: f, fps, config, durationInFrames: dur });

  switch (anim) {
    case "stamp": {
      const t = sp({ damping: 16, stiffness: 380, mass: 0.7 }, 8);
      const s = 2.4 - 1.4 * t;
      return { ...none, scaleX: s, scaleY: s, opacity: fadeIn(2) };
    }
    case "whip": {
      const t = sp({ damping: 12, stiffness: 170 }, 14);
      return {
        ...none,
        tx: -1.1 * sizePx * (1 - t),
        rotDeg: -14 * (1 - t),
        opacity: fadeIn(3),
      };
    }
    case "slide-left":
    case "slide-right": {
      const t = sp({ damping: 14, stiffness: 190 }, 12);
      const dir = anim === "slide-left" ? -1 : 1;
      return { ...none, tx: dir * 1.4 * sizePx * (1 - t), opacity: fadeIn(4) };
    }
    case "rise": {
      const t = sp({ damping: 13, stiffness: 180 }, 12);
      return { ...none, ty: 0.7 * sizePx * (1 - t), opacity: fadeIn(4) };
    }
    case "blur": {
      const t = interpolate(f, [0, 12], [0, 1], { clampRight: true, easing: easeOutCubic });
      const s = 1.05 - 0.05 * t;
      return {
        ...none,
        scaleX: s,
        scaleY: s,
        opacity: t,
        blurPx: t < 1 ? 0.25 * sizePx * (1 - t) : 0,
      };
    }
    case "tracking": {
      const t = interpolate(f, [0, 16], [0, 1], { clampRight: true, easing: easeOutCubic });
      return { ...none, opacity: t, lsExtraEm: 0.45 * (1 - t) };
    }
    case "flip": {
      const t = sp({ damping: 13, stiffness: 170 }, 12);
      // perspective+rotateX аппроксимируем сжатием по вертикали
      const angle = (85 * (1 - t) * Math.PI) / 180;
      return { ...none, scaleY: Math.max(Math.cos(angle), 0.02), opacity: fadeIn(3) };
    }
    case "pop":
    default: {
      const t = sp({ damping: 11, stiffness: 210, mass: 0.6 }, 12);
      const s = 0.3 + 0.7 * t;
      return { ...none, scaleX: s, scaleY: s, opacity: fadeIn(3) };
    }
  }
}

// ── раскладка ──

type LaidWord = {
  word: Word;
  index: number; // индекс на странице (для colorCycle/designWords)
  text: string;
  width: number;
  x: number; // левый край относительно центра строки (строка центрируется отдельно)
  row: number;
};

type RowInfo = { width: number };

type PageLayout = {
  laid: LaidWord[];
  rows: RowInfo[];
  contentW: number;
  contentH: number;
  lineH: number;
  ascent: number;
  descent: number;
};

type DesignLaidWord = {
  word: Word;
  index: number;
  text: string;
  size: number;
  boxH: number;
  variant: DesignWordVariant;
  font: string;
  ascent: number;
  descent: number;
  /** верх бокса слова относительно верха стека */
  top: number;
};

type DesignLayout = { laid: DesignLaidWord[]; totalH: number };

export function createScene(opts: SceneOptions): Scene {
  const { width, height, fps } = opts;
  const style = resolveStyle(opts.styleId, opts.overrides);
  const pages = groupWordsIntoPages(opts.words, style.maxWordsPerPage);
  const pageIndex = new Map<CaptionPage, number>(pages.map((p, i) => [p, i]));

  const fontSize = Math.round(width * style.fontSizeRatio);
  const strokeWidth = style.strokeRatio > 0 ? Math.max(fontSize * style.strokeRatio, 1) : 0;
  const letterSpacingPx = (style.letterSpacingEm ?? 0) * fontSize;
  const baseFont = fontString(style.fontFamily, style.fontWeight, fontSize, false);
  const gradient = style.gradient ? parseLinearGradient(style.gradient) : null;

  const msOf = (frame: number) => (frame / fps) * 1000;
  const frameOf = (ms: number) => Math.round((ms / 1000) * fps);

  const display = (text: string) => (style.uppercase ? text.toUpperCase() : text);

  // ── ключ состояния кадра ──
  function frameKey(frame: number): string {
    const page = findActivePage(pages, msOf(frame));
    if (!page) return "b";
    const idx = pageIndex.get(page) ?? 0;
    if (style.mode === "design") {
      const parts = page.words.map((w) => {
        const f = frame - frameOf(w.startMs);
        return f < 0 ? -1 : Math.min(f, DESIGN_SETTLE_FRAMES);
      });
      return `d${idx}:${parts.join(",")}`;
    }
    const ms = msOf(frame);
    // тайминги анимаций попадают в ключ только если реально влияют на картинку
    const sincePage =
      style.animation === "none" ? 0 : Math.min(frame - frameOf(page.startMs), 13);
    const active = findActiveWordIndex(page, ms);
    const started = ms >= page.words[active].startMs;
    const animatesActive = !!style.activeScale && style.activeScale !== 1;
    const sinceWord = !animatesActive
      ? 0
      : started
        ? Math.min(Math.max(frame - frameOf(page.words[active].startMs), 0), 12)
        : -1;
    // в режимах без выделения активного слова его индекс не важен
    const needsActive =
      animatesActive ||
      style.mode === "highlight-color" ||
      style.mode === "highlight-box" ||
      style.mode === "karaoke" ||
      style.mode === "appear";
    return `p${idx}:${sincePage}:${needsActive ? active : 0}:${sinceWord}:${needsActive && !started ? 0 : 1}`;
  }

  // ── раскладка обычных страниц ──
  const layoutCache = new Map<number, PageLayout>();

  function layoutPage(ctx: SKRSContext2D, page: CaptionPage, idx: number): PageLayout {
    const cached = layoutCache.get(idx);
    if (cached) return cached;

    const { ascent, descent } = fontMetrics(ctx, baseFont, fontSize);
    const lineH = fontSize * 1.25;
    const columnGap =
      fontSize * (0.28 + (style.activeScale ? (style.activeScale - 1) * 1.6 : 0));
    const rowGap = fontSize * 0.12;
    const maxW = width * 0.82;

    ctx.font = baseFont;
    ctx.letterSpacing = `${letterSpacingPx}px`;

    const laid: LaidWord[] = [];
    const rows: RowInfo[] = [];
    let rowWords: LaidWord[] = [];
    let rowW = 0;

    const flushRow = () => {
      if (rowWords.length === 0) return;
      // центрируем строку: координаты относительно её центра
      let x = -rowW / 2;
      for (const lw of rowWords) {
        lw.x = x;
        x += lw.width + columnGap;
      }
      rows.push({ width: rowW });
      rowWords = [];
      rowW = 0;
    };

    page.words.forEach((word, index) => {
      const text = display(word.text);
      const w = ctx.measureText(text).width;
      if (rowWords.length > 0 && rowW + columnGap + w > maxW) flushRow();
      const lw: LaidWord = { word, index, text, width: w, x: 0, row: rows.length };
      rowWords.push(lw);
      rowW += (rowWords.length > 1 ? columnGap : 0) + w;
      laid.push(lw);
    });
    flushRow();
    ctx.letterSpacing = "0px";

    const contentW = Math.max(...rows.map((r) => r.width), 0);
    const contentH = rows.length * lineH + Math.max(rows.length - 1, 0) * rowGap;
    const layout: PageLayout = { laid, rows, contentW, contentH, lineH, ascent, descent };
    layoutCache.set(idx, layout);
    return layout;
  }

  // ── раскладка design-страниц ──
  const designLayoutCache = new Map<number, DesignLayout>();

  function layoutDesignPage(ctx: SKRSContext2D, page: CaptionPage, idx: number): DesignLayout {
    const cached = designLayoutCache.get(idx);
    if (cached) return cached;

    const gap = fontSize * 0.08;
    const laid: DesignLaidWord[] = [];
    let top = 0;

    page.words.forEach((word, index) => {
      const variant =
        style.designWords?.[index % (style.designWords.length || 1)] ?? { sizeMult: 1 };
      const text = (variant.caps ?? style.uppercase)
        ? word.text.replace(/[.,!?;:…]+$/u, "").toUpperCase()
        : word.text.replace(/[.,!?;:…]+$/u, "");
      if (!text) return;
      const charBudget = (width * 0.9) / Math.max(text.length, 1) / 0.6;
      const size = Math.min(fontSize * variant.sizeMult, charBudget);
      const font = fontString(
        variant.font ?? style.fontFamily,
        variant.weight ?? style.fontWeight,
        size,
        variant.italic ?? false
      );
      const { ascent, descent } = fontMetrics(ctx, font, size);
      const padV = variant.bg ? size * 0.02 : 0;
      const boxH = size * 1.08 + 2 * padV;
      if (laid.length > 0) top += gap;
      laid.push({ word, index, text, size, boxH, variant, font, ascent, descent, top });
      top += boxH;
    });

    const layout: DesignLayout = { laid, totalH: top };
    designLayoutCache.set(idx, layout);
    return layout;
  }

  // ── отрисовка обычной страницы ──
  function drawRegularPage(ctx: SKRSContext2D, page: CaptionPage, idx: number, frame: number) {
    const ms = msOf(frame);
    const layout = layoutPage(ctx, page, idx);
    const activeIndex = findActiveWordIndex(page, ms);
    const sincePage = Math.max(frame - frameOf(page.startMs), 0);

    // анимация появления страницы
    let pageScale = 1;
    let pageShiftY = 0;
    let pageOpacity = 1;
    if (style.animation === "pop") {
      const t = spring({
        frame: sincePage,
        fps,
        config: { damping: 14, mass: 0.6, stiffness: 180 },
        durationInFrames: 12,
      });
      pageScale = 0.82 + 0.18 * t;
    } else if (style.animation === "fade") {
      pageOpacity = interpolate(sincePage, [0, 5], [0, 1], { clampRight: true });
    } else if (style.animation === "slide-up") {
      pageShiftY = interpolate(sincePage, [0, 6], [fontSize * 0.5, 0], { clampRight: true });
      pageOpacity = interpolate(sincePage, [0, 5], [0, 1], { clampRight: true });
    }

    const padV = style.lineBackground ? fontSize * 0.22 : 0;
    const padH = style.lineBackground ? fontSize * 0.45 : 0;
    const totalH = layout.contentH + 2 * padV;

    ctx.save();
    // центр блока: горизонталь — середина кадра, вертикаль — positionY
    ctx.translate(width / 2, style.positionY * height);
    if (pageShiftY) ctx.translate(0, pageShiftY);
    if (pageScale !== 1) ctx.scale(pageScale, pageScale);
    ctx.globalAlpha = pageOpacity;

    // подложка всей строки
    if (style.lineBackground) {
      ctx.fillStyle = style.lineBackground;
      roundRectPath(
        ctx,
        -(layout.contentW / 2 + padH),
        -totalH / 2,
        layout.contentW + 2 * padH,
        totalH,
        fontSize * 0.25
      );
      ctx.fill();
    }

    const contentTop = -totalH / 2 + padV;
    const halfLeading = (layout.lineH - (layout.ascent + layout.descent)) / 2;

    for (const lw of layout.laid) {
      const rowTop = contentTop + lw.row * (layout.lineH + fontSize * 0.12);
      const baseline = rowTop + halfLeading + layout.ascent;
      drawWordSpan(ctx, lw, baseline, activeIndex, ms, frame, pageOpacity);
    }
    ctx.restore();
  }

  function drawWordSpan(
    ctx: SKRSContext2D,
    lw: LaidWord,
    baseline: number,
    activeIndex: number,
    ms: number,
    frame: number,
    pageOpacity: number
  ) {
    const { word, index, text } = lw;
    const isActive = index === activeIndex && ms >= word.startMs;
    const isSpoken = ms >= word.startMs;

    let color = style.colorCycle?.length
      ? style.colorCycle[index % style.colorCycle.length]
      : style.textColor;
    let boxColor: string | null = null;
    let opacity = 1;

    if (style.mode === "highlight-color" && isActive) {
      color = style.highlightColor;
    } else if (style.mode === "highlight-box" && isActive) {
      boxColor = style.highlightColor;
    } else if (style.mode === "karaoke" && !isSpoken) {
      opacity = 0.35;
    } else if (style.mode === "appear" && !isSpoken) {
      return; // opacity 0
    }

    ctx.save();
    ctx.globalAlpha = pageOpacity * opacity;

    // центр бокса слова — как transform-origin у inline-block
    const boxTop = baseline - fontMetrics(ctx, baseFont, fontSize).ascent;
    const boxH = fontMetrics(ctx, baseFont, fontSize).ascent + fontMetrics(ctx, baseFont, fontSize).descent;
    const cx = lw.x + lw.width / 2;
    const cy = boxTop + boxH / 2;

    let scale = 1;
    if (style.activeScale && style.activeScale !== 1 && isActive) {
      const t = spring({
        frame: Math.max(frame - frameOf(word.startMs), 0),
        fps,
        config: { damping: 12, mass: 0.5, stiffness: 200 },
        durationInFrames: 10,
      });
      scale = 1 + (style.activeScale - 1) * t;
    }
    const rotate = boxColor && style.boxRotate ? (style.boxRotate * Math.PI) / 180 : 0;

    if (scale !== 1 || rotate !== 0) {
      ctx.translate(cx, cy);
      if (scale !== 1) ctx.scale(scale, scale);
      if (rotate !== 0) ctx.rotate(rotate);
      ctx.translate(-cx, -cy);
    }

    // плашка активного слова
    if (boxColor) {
      const padX = fontSize * 0.18;
      const padY = fontSize * 0.04;
      ctx.fillStyle = boxColor;
      roundRectPath(
        ctx,
        lw.x - padX,
        boxTop - padY,
        lw.width + 2 * padX,
        boxH + 2 * padY,
        fontSize * 0.18
      );
      ctx.fill();
    }

    let fill: string | CanvasGradient = color;
    let shadows = style.shadow ? parseTextShadow(style.shadow, fontSize) : [];
    let stroke = strokeWidth;
    if (gradient) {
      // background-clip:text — градиент в границах бокса слова
      fill = makeGradient(ctx, gradient, lw.x, boxTop, lw.width, boxH);
      shadows = [];
      stroke = 0;
    }

    paintText(ctx, {
      text,
      x: lw.x,
      baseline,
      font: baseFont,
      letterSpacingPx,
      fill,
      shadows,
      strokeWidth: stroke,
      strokeColor: style.strokeColor,
    });
    ctx.restore();
  }

  function makeGradient(
    ctx: SKRSContext2D,
    g: NonNullable<ReturnType<typeof parseLinearGradient>>,
    x: number,
    y: number,
    w: number,
    h: number
  ): CanvasGradient {
    const a = (g.angleDeg * Math.PI) / 180;
    const dx = Math.sin(a);
    const dy = -Math.cos(a);
    const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const grad = ctx.createLinearGradient(
      cx - dx * half,
      cy - dy * half,
      cx + dx * half,
      cy + dy * half
    );
    for (const s of g.stops) grad.addColorStop(Math.min(Math.max(s.offset, 0), 1), s.color);
    return grad;
  }

  // ── отрисовка design-страницы ──
  function drawDesignPage(ctx: SKRSContext2D, page: CaptionPage, idx: number, frame: number) {
    const layout = layoutDesignPage(ctx, page, idx);
    const stackTop = style.positionY * height - layout.totalH / 2;

    for (const dw of layout.laid) {
      const enter = designEnter(
        dw.variant.anim ?? "pop",
        frame - frameOf(dw.word.startMs),
        fps,
        dw.size
      );
      if (enter.opacity <= 0) continue;

      const ls = ((dw.variant.ls ?? 0) + enter.lsExtraEm) * dw.size;
      ctx.font = dw.font;
      ctx.letterSpacing = `${ls}px`;
      const textW = ctx.measureText(dw.text).width;
      ctx.letterSpacing = "0px";

      const padV = dw.variant.bg ? dw.size * 0.02 : 0;
      const padH = dw.variant.bg ? dw.size * 0.3 : 0;
      const boxW = textW + 2 * padH;
      const boxCx = 0; // колонка по центру кадра
      const boxCy = stackTop + dw.top + dw.boxH / 2;

      ctx.save();
      ctx.globalAlpha = enter.opacity;
      if (enter.blurPx > 0.1) ctx.filter = `blur(${enter.blurPx}px)`;

      // transform-origin: центр бокса; порядок как в CSS: enter → rotate
      ctx.translate(width / 2 + boxCx, boxCy);
      if (enter.tx || enter.ty) ctx.translate(enter.tx, enter.ty);
      if (enter.scaleX !== 1 || enter.scaleY !== 1) ctx.scale(enter.scaleX, enter.scaleY);
      if (enter.rotDeg) ctx.rotate((enter.rotDeg * Math.PI) / 180);
      if (dw.variant.rotate) ctx.rotate((dw.variant.rotate * Math.PI) / 180);

      // фон-плашка
      if (dw.variant.bg) {
        ctx.fillStyle = dw.variant.bg;
        ctx.fillRect(-boxW / 2, -dw.boxH / 2, boxW, dw.boxH);
      }

      // базовая линия внутри бокса (line-height 1.08)
      const halfLeading = (dw.size * 1.08 - (dw.ascent + dw.descent)) / 2;
      const baseline = -dw.boxH / 2 + padV + halfLeading + dw.ascent;

      const shadows =
        !dw.variant.bg && style.shadow ? parseTextShadow(style.shadow, dw.size) : [];

      paintText(ctx, {
        text: dw.text,
        x: -textW / 2,
        baseline,
        font: dw.font,
        letterSpacingPx: ls,
        fill: dw.variant.color ?? style.textColor,
        shadows,
        strokeWidth: 0,
        strokeColor: "#000",
      });

      ctx.filter = "none";
      ctx.restore();
    }
  }

  function drawFrame(ctx: SKRSContext2D, frame: number, offsetY = 0): boolean {
    const page = findActivePage(pages, msOf(frame));
    if (!page) return false;
    const idx = pageIndex.get(page) ?? 0;
    ctx.save();
    if (offsetY) ctx.translate(0, -offsetY);
    if (style.mode === "design") drawDesignPage(ctx, page, idx, frame);
    else drawRegularPage(ctx, page, idx, frame);
    ctx.restore();
    return true;
  }

  function verticalBand(): { top: number; height: number } {
    const mctx = createCanvas(8, 8).getContext("2d");
    let min = Infinity;
    let max = -Infinity;
    // запас на тени/размытие/сдвиги анимаций
    const margin = fontSize * 2.5;

    pages.forEach((page, idx) => {
      if (style.mode === "design") {
        const layout = layoutDesignPage(mctx, page, idx);
        const stackTop = style.positionY * height - layout.totalH / 2;
        for (const dw of layout.laid) {
          const cy = stackTop + dw.top + dw.boxH / 2;
          // худшие случаи: stamp scale 2.4, rise ty 0.7·size, наклон широкого слова
          let half = (dw.boxH / 2) * 2.4 + dw.size * 0.7;
          const rot =
            Math.abs(dw.variant.rotate ?? 0) +
            ((dw.variant.anim ?? "pop") === "whip" ? 14 : 0);
          if (rot > 0) half += Math.sin((rot * Math.PI) / 180) * (width * 0.45);
          min = Math.min(min, cy - half);
          max = Math.max(max, cy + half);
        }
      } else {
        const layout = layoutPage(mctx, page, idx);
        const padV = style.lineBackground ? fontSize * 0.22 : 0;
        const totalH = layout.contentH + 2 * padV;
        const center = style.positionY * height;
        const grow = Math.max(style.activeScale ?? 1, 1.06); // + перелёт pop-пружины
        const half = (totalH / 2) * grow + fontSize * 0.5; // + slide-up сдвиг
        min = Math.min(min, center - half);
        max = Math.max(max, center + half);
      }
    });

    if (!Number.isFinite(min)) return { top: 0, height };
    let top = Math.floor(Math.max(min - margin, 0) / 2) * 2;
    let bottom = Math.ceil(Math.min(max + margin, height) / 2) * 2;
    if (bottom <= top) return { top: 0, height };
    // полоса почти во весь кадр — экономии нет, рендерим целиком
    if (bottom - top > height * 0.85) return { top: 0, height };
    return { top, height: bottom - top };
  }

  return { frameKey, drawFrame, verticalBand };
}
