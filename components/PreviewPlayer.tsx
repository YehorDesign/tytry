"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { CaptionedVideo } from "@/remotion/CaptionedVideo";
import {
  OVERLAY_FONT_FAMILY,
  OVERLAY_FONT_WEIGHT,
  OVERLAY_LINE_HEIGHT,
  OVERLAY_MAX_SIZE_RATIO,
  OVERLAY_MAX_W_RATIO,
  OVERLAY_MIN_SIZE_RATIO,
  OVERLAY_PAD_X_EM,
  OVERLAY_PAD_Y_EM,
  OVERLAY_RADIUS_EM,
} from "@/lib/overlays";
import { clipDurationMs, type Disclaimer, type Project, type ProjectMusic, type StyleOverrides, type TextOverlay, type TimelineClip, type Word } from "@/lib/types";

const FPS = 30;

export const PreviewPlayer: React.FC<{
  project: Project;
  words: Word[];
  styleId: string;
  overrides: StyleOverrides;
  clips: TimelineClip[] | null; // null = классический проект без монтажа
  music: ProjectMusic | null;
  disclaimer: Disclaimer | null;
  overlays: TextOverlay[] | null;
  selectedOverlayId: string | null;
  currentMs: number;
  onOverlaysChange: (next: TextOverlay[]) => void;
  onOverlaySelect: (id: string | null) => void;
  playerRef: React.RefObject<PlayerRef | null>;
}> = ({
  project,
  words,
  styleId,
  overrides,
  clips,
  music,
  disclaimer,
  overlays,
  selectedOverlayId,
  currentMs,
  onOverlaysChange,
  onOverlaySelect,
  playerRef,
}) => {
  const { width, height, fileName } = project.video;

  const durationMs =
    clips && clips.length > 0
      ? clips.reduce((sum, c) => sum + clipDurationMs(c), 0)
      : project.video.durationMs;

  const inputProps = useMemo(
    () => ({
      videoSrc: `/api/file/uploads/${encodeURIComponent(fileName)}`,
      words,
      styleId,
      overrides,
      width,
      height,
      durationMs,
      clips:
        clips && clips.length > 0
          ? clips.map((c) => ({
              src: `/api/file/uploads/${encodeURIComponent(c.fileName)}`,
              kind: c.kind,
              inMs: c.inMs,
              outMs: c.outMs,
              sourceDurationMs: c.sourceDurationMs,
              zoom: c.zoom,
              panX: c.panX,
              panY: c.panY,
              speed: c.speed,
            }))
          : undefined,
      musicSrc: music ? `/api/file/music/${encodeURIComponent(music.fileName)}` : null,
      musicVolume: music?.volume,
      musicOffsetMs: music?.offsetMs ?? 0,
      disclaimer,
      overlays,
    }),
    [fileName, words, styleId, overrides, width, height, durationMs, clips, music, disclaimer, overlays]
  );

  // ── интерактивный слой плашек: двигаем/масштабируем прямо на превью ──
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [previewW, setPreviewW] = useState(0);

  useEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPreviewW(el.clientWidth));
    ro.observe(el);
    setPreviewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const startOverlayDrag = (
    e: React.PointerEvent,
    id: string,
    mode: "move" | "resize"
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const layer = layerRef.current;
    if (!layer || !overlays) return;
    const o = overlays.find((x) => x.id === id);
    if (!o) return;
    onOverlaySelect(id);
    const rect = layer.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const start = { y: o.y, sizeRatio: o.sizeRatio };
    // resize: масштаб = отношение расстояний от центра плашки до курсора
    // (по горизонтали плашка всегда в центре кадра)
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + o.y * rect.height;
    const startDist = Math.max(Math.hypot(startX - cx, startY - cy), 8);
    const snapshot = overlays;

    const apply = (ev: PointerEvent) => {
      if (mode === "move") {
        const ny = Math.min(Math.max(start.y + (ev.clientY - startY) / rect.height, 0.02), 0.98);
        onOverlaysChange(snapshot.map((x) => (x.id === id ? { ...x, y: ny } : x)));
      } else {
        const scale = Math.hypot(ev.clientX - cx, ev.clientY - cy) / startDist;
        const sizeRatio = Math.min(
          Math.max(start.sizeRatio * scale, OVERLAY_MIN_SIZE_RATIO),
          OVERLAY_MAX_SIZE_RATIO
        );
        onOverlaysChange(snapshot.map((x) => (x.id === id ? { ...x, sizeRatio } : x)));
      }
    };
    const onMove = (ev: PointerEvent) => apply(ev);
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      apply(ev);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const activeOverlays = (overlays ?? []).filter(
    (o) => currentMs >= o.startMs && currentMs < o.endMs
  );

  // вписываем видео в доступную область, сохраняя пропорции
  const aspect = width / height;
  const maxH = "calc(100vh - 200px)";

  return (
    <div
      className="player-frame"
      style={{
        aspectRatio: `${width} / ${height}`,
        height: aspect < 1 ? maxH : undefined,
        width: aspect >= 1 ? "min(100%, 960px)" : undefined,
        maxHeight: maxH,
      }}
    >
      <Player
        ref={playerRef}
        component={CaptionedVideo}
        inputProps={inputProps}
        durationInFrames={Math.max(Math.ceil((durationMs / 1000) * FPS), 1)}
        compositionWidth={width}
        compositionHeight={height}
        fps={FPS}
        controls
        style={{ width: "100%", height: "100%" }}
        acknowledgeRemotionLicense
      />
      {/* невидимые «рамки» плашек: та же геометрия, что у плашки в плеере */}
      <div className="ov-layer" ref={layerRef}>
        {previewW > 0 &&
          activeOverlays.map((o) => {
            const fs = Math.max(o.sizeRatio * previewW, 6);
            return (
              // полноширинная flex-обёртка: как в композиции, чтобы ширина
              // плашки не резалась (abs+left:50% ограничивает до полукадра)
              <div
                key={o.id}
                className="ov-row"
                style={{ top: `${o.y * 100}%` }}
              >
                <div
                  className={`ov-box ${o.id === selectedOverlayId ? "selected" : ""}`}
                  style={{
                    maxWidth: `${OVERLAY_MAX_W_RATIO * 100}%`,
                    borderRadius: fs * OVERLAY_RADIUS_EM,
                    padding: `${fs * OVERLAY_PAD_Y_EM}px ${fs * OVERLAY_PAD_X_EM}px`,
                    fontFamily: `${OVERLAY_FONT_FAMILY}, sans-serif`,
                    fontWeight: OVERLAY_FONT_WEIGHT,
                    fontSize: fs,
                    lineHeight: OVERLAY_LINE_HEIGHT,
                  }}
                  onPointerDown={(e) => startOverlayDrag(e, o.id, "move")}
                  onClick={(e) => e.stopPropagation()}
                >
                  {o.text}
                  {o.id === selectedOverlayId && (
                    <div
                      className="ov-resize"
                      onPointerDown={(e) => startOverlayDrag(e, o.id, "resize")}
                    />
                  )}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
};
