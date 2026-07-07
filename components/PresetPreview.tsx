"use client";

// Живое превью пресета: настоящий рендер субтитров (та же композиция, что и в
// редакторе/финале) поверх нейтрального фона-заглушки. Субтитры можно
// перетащить мышкой — это меняет positionY пресета.
import React, { useMemo, useRef } from "react";
import { Player } from "@remotion/player";
import { CaptionedVideo } from "@/remotion/CaptionedVideo";
import { resolveStyle } from "@/lib/styles";
import type { CaptionInputProps, Disclaimer, StyleOverrides, Word } from "@/lib/types";

const FPS = 30;
const W = 720;
const H = 1280;
const WORD_MS = 340;
const WORD_STEP = 400;

// фон-заглушка вместо видео: тёмный градиент с мягкими пятнами
const BG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#1b2333"/><stop offset="1" stop-color="#0d1017"/>
</linearGradient>
<radialGradient id="b1" cx="0.25" cy="0.22" r="0.5">
<stop offset="0" stop-color="#31527d" stop-opacity="0.55"/><stop offset="1" stop-color="#31527d" stop-opacity="0"/>
</radialGradient>
<radialGradient id="b2" cx="0.8" cy="0.75" r="0.6">
<stop offset="0" stop-color="#4b3a6b" stop-opacity="0.5"/><stop offset="1" stop-color="#4b3a6b" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<rect width="100%" height="100%" fill="url(#b1)"/>
<rect width="100%" height="100%" fill="url(#b2)"/>
</svg>`;
const BG_SRC = `data:image/svg+xml;utf8,${encodeURIComponent(BG_SVG)}`;

const POS_MIN = 0.08;
const POS_MAX = 0.92;

export const PresetPreview: React.FC<{
  styleId: string;
  overrides: StyleOverrides;
  disclaimer: Disclaimer | null;
  /** фраза для субтитров (слова получают тайминги автоматически) */
  sampleWords: string;
  hint: string;
  onPositionYChange: (y: number) => void;
}> = ({ styleId, overrides, disclaimer, sampleWords, hint, onPositionYChange }) => {
  const frameRef = useRef<HTMLDivElement | null>(null);

  const words = useMemo<Word[]>(
    () =>
      sampleWords
        .split(/\s+/)
        .filter(Boolean)
        .map((text, i) => ({
          id: `pw${i}`,
          text,
          startMs: i * WORD_STEP,
          endMs: i * WORD_STEP + WORD_MS,
        })),
    [sampleWords]
  );
  // короткий хвост: субтитры почти всё время на экране, цикл незаметнее
  const durationMs = words.length * WORD_STEP + 400;

  const inputProps = useMemo<CaptionInputProps>(
    () => ({
      videoSrc: "",
      words,
      styleId,
      overrides,
      width: W,
      height: H,
      durationMs,
      clips: [{ src: BG_SRC, kind: "image", inMs: 0, outMs: durationMs }],
      disclaimer,
    }),
    [words, styleId, overrides, durationMs, disclaimer]
  );

  // перетаскивание субтитров: позиция = положение курсора по вертикали
  const startDrag = (e: React.PointerEvent) => {
    const frame = frameRef.current;
    if (!frame) return;
    e.preventDefault();
    const rect = frame.getBoundingClientRect();
    const apply = (clientY: number) => {
      const y = (clientY - rect.top) / rect.height;
      onPositionYChange(Math.min(Math.max(Math.round(y * 100) / 100, POS_MIN), POS_MAX));
    };
    apply(e.clientY);
    const onMove = (ev: PointerEvent) => apply(ev.clientY);
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      apply(ev.clientY);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const positionY = resolveStyle(styleId, overrides).positionY;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <div
        ref={frameRef}
        style={{
          position: "relative",
          aspectRatio: `${W} / ${H}`,
          width: "100%",
          borderRadius: 10,
          overflow: "hidden",
          border: "1px solid var(--border, #333)",
          cursor: "ns-resize",
          userSelect: "none",
        }}
        onPointerDown={startDrag}
      >
        <Player
          component={CaptionedVideo}
          inputProps={inputProps}
          durationInFrames={Math.max(Math.ceil((durationMs / 1000) * FPS), 1)}
          compositionWidth={W}
          compositionHeight={H}
          fps={FPS}
          autoPlay
          loop
          controls={false}
          clickToPlay={false}
          style={{ width: "100%", height: "100%", pointerEvents: "none" }}
          acknowledgeRemotionLicense
        />
        {/* направляющая текущей позиции — видно, за что «держишься» */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: `${positionY * 100}%`,
            borderTop: "1px dashed rgba(255,255,255,0.22)",
            pointerEvents: "none",
          }}
        />
      </div>
      <p className="hint" style={{ margin: 0, whiteSpace: "normal" }}>
        {hint}
      </p>
    </div>
  );
};
