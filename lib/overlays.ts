// Текст-плашка в стиле TikTok: чёрный текст на белом скруглённом прямоугольнике.
// Геометрия описана здесь один раз (в долях от размера шрифта), чтобы превью
// (DOM в плеере), Chrome-рендер и нативный skia-рендер рисовали одинаково.
import type { TextOverlay } from "./types";

export const OVERLAY_FONT_FAMILY = "Montserrat";
export const OVERLAY_FONT_WEIGHT = 600;
export const OVERLAY_LINE_HEIGHT = 1.35;
export const OVERLAY_PAD_X_EM = 0.55;
export const OVERLAY_PAD_Y_EM = 0.35;
export const OVERLAY_RADIUS_EM = 0.4;
/** максимальная ширина плашки как доля ширины кадра */
export const OVERLAY_MAX_W_RATIO = 0.82;
export const OVERLAY_MIN_SIZE_RATIO = 0.015;
export const OVERLAY_MAX_SIZE_RATIO = 0.12;
/** минимальная длительность плашки при триме на таймлайне */
export const OVERLAY_MIN_MS = 200;

export function overlayFontSize(o: TextOverlay, frameWidth: number): number {
  return Math.max(Math.round(frameWidth * o.sizeRatio), 8);
}

export function overlayActiveAt(o: TextOverlay, ms: number): boolean {
  return !!o.text.trim() && ms >= o.startMs && ms < o.endMs;
}

export function newOverlayId(): string {
  return `ov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
