// Мини-парсеры CSS-значений, которые встречаются в пресетах lib/styles.ts:
// text-shadow ("0 0.08em 0.25em rgba(0,0,0,0.75), ...") и linear-gradient.

export type ParsedShadow = {
  offsetX: number; // px при заданном fontSize
  offsetY: number;
  blur: number;
  color: string;
};

/** Делит строку по запятым, игнорируя запятые внутри скобок (rgba, hsl). */
function splitTop(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim());
}

function parseLength(token: string, fontSize: number): number | null {
  const m = token.match(/^(-?\d*\.?\d+)(em|px)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === "em" ? n * fontSize : n;
}

const shadowCache = new Map<string, ParsedShadow[]>();

export function parseTextShadow(value: string, fontSize: number): ParsedShadow[] {
  const key = `${value}@${fontSize}`;
  const cached = shadowCache.get(key);
  if (cached) return cached;

  const shadows: ParsedShadow[] = [];
  for (const part of splitTop(value)) {
    // токены: длины и цвет (цвет может содержать скобки без пробелов внутри)
    const tokens = part.match(/[a-zA-Z]+\([^)]*\)|#[0-9a-fA-F]+|-?\d*\.?\d+(?:em|px)?|[a-zA-Z]+/g);
    if (!tokens) continue;
    const lengths: number[] = [];
    let color = "rgba(0,0,0,1)";
    for (const t of tokens) {
      const len = parseLength(t, fontSize);
      if (len !== null && lengths.length < 3) lengths.push(len);
      else color = t;
    }
    if (lengths.length < 2) continue;
    shadows.push({
      offsetX: lengths[0],
      offsetY: lengths[1],
      blur: lengths[2] ?? 0,
      color,
    });
  }
  shadowCache.set(key, shadows);
  return shadows;
}

export type ParsedGradient = {
  angleDeg: number; // CSS: 0 = вверх, 180 = вниз, 90 = вправо
  stops: { offset: number; color: string }[];
};

const gradientCache = new Map<string, ParsedGradient | null>();

export function parseLinearGradient(value: string): ParsedGradient | null {
  const cached = gradientCache.get(value);
  if (cached !== undefined) return cached;

  const m = value.match(/^linear-gradient\((.*)\)$/s);
  if (!m) {
    gradientCache.set(value, null);
    return null;
  }
  const parts = splitTop(m[1]);
  let angleDeg = 180; // CSS-дефолт: to bottom
  let start = 0;
  const angleMatch = parts[0]?.match(/^(-?\d*\.?\d+)deg$/);
  if (angleMatch) {
    angleDeg = parseFloat(angleMatch[1]);
    start = 1;
  }
  const stops: { offset: number; color: string }[] = [];
  const stopParts = parts.slice(start);
  stopParts.forEach((p, i) => {
    const sm = p.match(/^(.*?)\s+(-?\d*\.?\d+)%$/);
    if (sm) {
      stops.push({ color: sm[1].trim(), offset: parseFloat(sm[2]) / 100 });
    } else {
      stops.push({
        color: p.trim(),
        offset: stopParts.length === 1 ? 0 : i / (stopParts.length - 1),
      });
    }
  });
  const parsed = stops.length >= 2 ? { angleDeg, stops } : null;
  gradientCache.set(value, parsed);
  return parsed;
}
