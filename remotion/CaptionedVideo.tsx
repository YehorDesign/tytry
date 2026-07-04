import React, { useMemo } from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type {
  CaptionInputProps,
  CaptionPage,
  CaptionStyle,
  DesignWordAnim,
  DesignWordVariant,
  Word,
} from "../lib/types";
import { findActivePage, findActiveWordIndex, groupWordsIntoPages } from "../lib/captions";
import { resolveStyle } from "../lib/styles";
import { FONT_FAMILIES } from "./fonts";

export const CaptionedVideo: React.FC<CaptionInputProps> = ({
  videoSrc,
  words,
  styleId,
  overrides,
  width,
  clips,
  musicSrc,
  musicVolume,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (frame / fps) * 1000;

  const style = useMemo(() => resolveStyle(styleId, overrides), [styleId, overrides]);
  const pages = useMemo(
    () => groupWordsIntoPages(words, style.maxWordsPerPage),
    [words, style.maxWordsPerPage]
  );
  const page = findActivePage(pages, ms);
  // страница со своим стилем отрезка рисуется им, остальные — стилем проекта
  const pageStyle = useMemo(
    () => (page?.style ? resolveStyle(page.style.styleId, page.style.overrides ?? {}) : style),
    [page, style]
  );

  // монтаж: клипы встык; иначе — один исходник
  const clipSequences = useMemo(() => {
    if (!clips || clips.length === 0) return null;
    let fromFrame = 0;
    return clips.map((c, i) => {
      const durFrames = Math.max(Math.round(((c.outMs - c.inMs) / 1000) * fps), 1);
      const seq = { ...c, key: i, fromFrame, durFrames };
      fromFrame += durFrames;
      return seq;
    });
  }, [clips, fps]);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {clipSequences ? (
        clipSequences.map((c) => {
          // зум/сдвиг кадра — та же математика, что в ffmpeg-склейке:
          // translate в долях канваса, затем scale вокруг центра
          const clipStyle: React.CSSProperties = {
            width: "100%",
            height: "100%",
            objectFit: "contain",
            transform:
              (c.zoom ?? 1) !== 1 || c.panX || c.panY
                ? `translate(${(c.panX ?? 0) * 100}%, ${(c.panY ?? 0) * 100}%) scale(${c.zoom ?? 1})`
                : undefined,
          };
          return (
            <Sequence key={c.key} from={c.fromFrame} durationInFrames={c.durFrames}>
              {c.kind === "image" ? (
                <Img src={c.src} style={clipStyle} />
              ) : (
                <OffthreadVideo
                  src={c.src}
                  startFrom={Math.round((c.inMs / 1000) * fps)}
                  endAt={Math.round((c.outMs / 1000) * fps)}
                  style={clipStyle}
                />
              )}
            </Sequence>
          );
        })
      ) : (
        <OffthreadVideo
          src={videoSrc}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      )}
      {musicSrc ? <Audio src={musicSrc} volume={musicVolume ?? 0.3} loop /> : null}
      {page ? (
        <CaptionOverlay page={page} ms={ms} style={pageStyle} frameWidth={width} fps={fps} />
      ) : null}
    </AbsoluteFill>
  );
};

const CaptionOverlay: React.FC<{
  page: CaptionPage;
  ms: number;
  style: CaptionStyle;
  frameWidth: number;
  fps: number;
}> = ({ page, ms, style, frameWidth, fps }) => {
  const frame = useCurrentFrame();
  const fontSize = Math.round(frameWidth * style.fontSizeRatio);
  const activeIndex = findActiveWordIndex(page, ms);

  const pageStartFrame = Math.round((page.startMs / 1000) * fps);
  const framesSincePageStart = Math.max(frame - pageStartFrame, 0);

  let pageTransform = "none";
  let pageOpacity = 1;
  if (style.animation === "pop") {
    const scale = spring({
      frame: framesSincePageStart,
      fps,
      config: { damping: 14, mass: 0.6, stiffness: 180 },
      durationInFrames: 12,
    });
    pageTransform = `scale(${0.82 + 0.18 * scale})`;
  } else if (style.animation === "fade") {
    pageOpacity = interpolate(framesSincePageStart, [0, 5], [0, 1], {
      extrapolateRight: "clamp",
    });
  } else if (style.animation === "slide-up") {
    const shift = interpolate(framesSincePageStart, [0, 6], [fontSize * 0.5, 0], {
      extrapolateRight: "clamp",
    });
    pageOpacity = interpolate(framesSincePageStart, [0, 5], [0, 1], {
      extrapolateRight: "clamp",
    });
    pageTransform = `translateY(${shift}px)`;
  }

  const strokeWidth = style.strokeRatio > 0 ? Math.max(fontSize * style.strokeRatio, 1) : 0;

  const lineStyle: React.CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "baseline",
    // запас на увеличение активного слова, чтобы соседи не слипались
    columnGap: fontSize * (0.28 + (style.activeScale ? (style.activeScale - 1) * 1.6 : 0)),
    rowGap: fontSize * 0.12,
    maxWidth: "82%",
    fontFamily: FONT_FAMILIES[style.fontFamily] ?? style.fontFamily,
    fontWeight: style.fontWeight,
    fontSize,
    lineHeight: 1.25,
    letterSpacing: style.letterSpacingEm ? `${style.letterSpacingEm}em` : undefined,
    textTransform: style.uppercase ? "uppercase" : "none",
    textAlign: "center",
    transform: pageTransform,
    opacity: pageOpacity,
    padding: style.lineBackground ? `${fontSize * 0.22}px ${fontSize * 0.45}px` : 0,
    backgroundColor: style.lineBackground ?? "transparent",
    borderRadius: style.lineBackground ? fontSize * 0.25 : 0,
  };

  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "center" }}>
      <div
        style={{
          position: "absolute",
          top: `${style.positionY * 100}%`,
          transform: "translateY(-50%)",
          display: "flex",
          justifyContent: "center",
          width: "100%",
        }}
      >
        {style.mode === "design" ? (
          // без pageTransform/pageOpacity: каждое слово анимируется само в свой startMs
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: fontSize * 0.08,
              maxWidth: "92%",
              textAlign: "center",
            }}
          >
            {page.words.map((word, i) => (
              <DesignWord
                key={word.id}
                word={word}
                variant={
                  style.designWords?.[i % (style.designWords.length || 1)] ?? {
                    sizeMult: 1,
                  }
                }
                style={style}
                fontSize={fontSize}
                frameWidth={frameWidth}
              />
            ))}
          </div>
        ) : (
          <div style={lineStyle}>
            {page.words.map((word, i) => (
              <WordSpan
                key={word.id}
                word={word}
                index={i}
                activeIndex={activeIndex}
                ms={ms}
                style={style}
                fontSize={fontSize}
                strokeWidth={strokeWidth}
              />
            ))}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

/** Состояние входной анимации design-слова на текущем кадре */
type DesignEnter = {
  transform: string;
  opacity: number;
  filter?: string;
  /** добавка к letter-spacing в em (для tracking) */
  lsExtraEm: number;
};

function designEnter(
  anim: DesignWordAnim,
  f: number, // кадров с момента startMs слова (может быть < 0)
  fps: number,
  sizePx: number
): DesignEnter {
  // слово ещё не прозвучало: невидимо, но занимает место (стопка не прыгает)
  if (f < 0) return { transform: "none", opacity: 0, lsExtraEm: 0 };

  const fadeIn = (frames: number) =>
    interpolate(f, [0, frames], [0, 1], { extrapolateRight: "clamp" });
  const sp = (config: { damping: number; stiffness: number; mass?: number }, dur = 12) =>
    spring({ frame: f, fps, config, durationInFrames: dur });

  switch (anim) {
    case "stamp": {
      // влетает огромным и припечатывается с лёгким перелётом
      const t = sp({ damping: 16, stiffness: 380, mass: 0.7 }, 8);
      return {
        transform: `scale(${2.4 - 1.4 * t})`,
        opacity: fadeIn(2),
        lsExtraEm: 0,
      };
    }
    case "whip": {
      const t = sp({ damping: 12, stiffness: 170 }, 14);
      return {
        transform: `translateX(${-1.1 * sizePx * (1 - t)}px) rotate(${-14 * (1 - t)}deg)`,
        opacity: fadeIn(3),
        lsExtraEm: 0,
      };
    }
    case "slide-left":
    case "slide-right": {
      const t = sp({ damping: 14, stiffness: 190 }, 12);
      const dir = anim === "slide-left" ? -1 : 1;
      return {
        transform: `translateX(${dir * 1.4 * sizePx * (1 - t)}px)`,
        opacity: fadeIn(4),
        lsExtraEm: 0,
      };
    }
    case "rise": {
      const t = sp({ damping: 13, stiffness: 180 }, 12);
      return {
        transform: `translateY(${0.7 * sizePx * (1 - t)}px)`,
        opacity: fadeIn(4),
        lsExtraEm: 0,
      };
    }
    case "blur": {
      const t = interpolate(f, [0, 12], [0, 1], {
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
      });
      return {
        transform: `scale(${1.05 - 0.05 * t})`,
        opacity: t,
        filter: t < 1 ? `blur(${0.25 * sizePx * (1 - t)}px)` : undefined,
        lsExtraEm: 0,
      };
    }
    case "tracking": {
      const t = interpolate(f, [0, 16], [0, 1], {
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
      });
      return { transform: "none", opacity: t, lsExtraEm: 0.45 * (1 - t) };
    }
    case "flip": {
      const t = sp({ damping: 13, stiffness: 170 }, 12);
      return {
        transform: `perspective(${8 * sizePx}px) rotateX(${85 * (1 - t)}deg)`,
        opacity: fadeIn(3),
        lsExtraEm: 0,
      };
    }
    case "pop":
    default: {
      const t = sp({ damping: 11, stiffness: 210, mass: 0.6 }, 12);
      return {
        transform: `scale(${0.3 + 0.7 * t})`,
        opacity: fadeIn(3),
        lsExtraEm: 0,
      };
    }
  }
}

/** Слово в режиме design: своя гарнитура, размер, цвет, наклон, плашка, анимация */
const DesignWord: React.FC<{
  word: Word;
  variant: DesignWordVariant;
  style: CaptionStyle;
  fontSize: number;
  frameWidth: number;
}> = ({ word, variant, style, fontSize, frameWidth }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const family = variant.font ?? style.fontFamily;
  // у дизайн-слов знаки препинания убираем — это «обложка», не текст
  const text = word.text.replace(/[.,!?;:…]+$/u, "");
  if (!text) return null;
  // длинное слово не должно вылезать за кадр: грубая оценка ~0.6em на символ
  const charBudget = (frameWidth * 0.9) / Math.max(text.length, 1) / 0.6;
  const finalSize = Math.min(fontSize * variant.sizeMult, charBudget);

  const wordStartFrame = Math.round((word.startMs / 1000) * fps);
  const enter = designEnter(
    variant.anim ?? "pop",
    frame - wordStartFrame,
    fps,
    finalSize
  );

  const baseRotate = variant.rotate ? `rotate(${variant.rotate}deg)` : "";
  const transform =
    enter.transform === "none" ? baseRotate || undefined : `${enter.transform} ${baseRotate}`.trim();
  const ls = (variant.ls ?? 0) + enter.lsExtraEm;

  return (
    <span
      style={{
        fontFamily: FONT_FAMILIES[family] ?? family,
        fontWeight: variant.weight ?? style.fontWeight,
        fontSize: finalSize,
        fontStyle: variant.italic ? "italic" : "normal",
        color: variant.color ?? style.textColor,
        textTransform: (variant.caps ?? style.uppercase) ? "uppercase" : "none",
        letterSpacing: ls ? `${ls}em` : undefined,
        transform,
        opacity: enter.opacity,
        filter: enter.filter,
        backgroundColor: variant.bg ?? undefined,
        padding: variant.bg ? "0.02em 0.3em" : undefined,
        lineHeight: 1.08,
        textShadow: variant.bg ? undefined : style.shadow ?? undefined,
        whiteSpace: "pre",
        display: "inline-block",
      }}
    >
      {text}
    </span>
  );
};

const WordSpan: React.FC<{
  word: Word;
  index: number;
  activeIndex: number;
  ms: number;
  style: CaptionStyle;
  fontSize: number;
  strokeWidth: number;
}> = ({ word, index, activeIndex, ms, style, fontSize, strokeWidth }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const isActive = index === activeIndex && ms >= word.startMs;
  const isSpoken = ms >= word.startMs;

  let color = style.colorCycle?.length
    ? style.colorCycle[index % style.colorCycle.length]
    : style.textColor;
  let backgroundColor = "transparent";
  let opacity = 1;

  if (style.mode === "highlight-color" && isActive) {
    color = style.highlightColor;
  } else if (style.mode === "highlight-box" && isActive) {
    backgroundColor = style.highlightColor;
  } else if (style.mode === "karaoke" && !isSpoken) {
    opacity = 0.35;
  } else if (style.mode === "appear" && !isSpoken) {
    opacity = 0;
  }

  // эффект увеличения активного слова (пружина от момента его начала)
  let transform: string | undefined;
  if (style.activeScale && style.activeScale !== 1 && isActive) {
    const wordStartFrame = Math.round((word.startMs / 1000) * fps);
    const progress = spring({
      frame: Math.max(frame - wordStartFrame, 0),
      fps,
      config: { damping: 12, mass: 0.5, stiffness: 200 },
      durationInFrames: 10,
    });
    transform = `scale(${1 + (style.activeScale - 1) * progress})`;
  }
  if (style.boxRotate && backgroundColor !== "transparent") {
    transform = `${transform ?? ""} rotate(${style.boxRotate}deg)`.trim();
  }

  const css: React.CSSProperties = {
    display: "inline-block",
    color,
    opacity,
    backgroundColor,
    borderRadius: backgroundColor !== "transparent" ? fontSize * 0.18 : 0,
    padding:
      style.mode === "highlight-box"
        ? `${fontSize * 0.04}px ${fontSize * 0.18}px`
        : undefined,
    margin:
      style.mode === "highlight-box" ? `0 ${-fontSize * 0.18}px` : undefined,
    textShadow: style.shadow ?? undefined,
    WebkitTextStroke: strokeWidth > 0 ? `${strokeWidth}px ${style.strokeColor}` : undefined,
    paintOrder: "stroke fill",
    transform,
    transition: "none",
    whiteSpace: "pre",
  };

  // градиентная заливка: текст «вырезается» из градиента.
  // Тени тут нельзя: text-shadow просвечивает сквозь прозрачные буквы,
  // а drop-shadow в Chromium рисует тень от необрезанного бокса.
  if (style.gradient) {
    css.backgroundImage = style.gradient;
    css.WebkitBackgroundClip = "text";
    css.backgroundClip = "text";
    css.color = "transparent";
    css.textShadow = undefined;
    css.WebkitTextStroke = undefined;
  }

  return <span style={css}>{word.text}</span>;
};
